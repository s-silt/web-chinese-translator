import { writeFile } from 'node:fs/promises'
import { expect, test } from './fixtures'

type ExtensionApi = typeof import('wxt/browser').browser
interface EngineProbe {
  observers: number
  reads: number
  records: number
  deliveries: number
  callbackMs: number
  maxCallbackMs: number
  measuring: boolean
}
declare global {
  interface Window {
    __shadowReviewProbe: EngineProbe
    __closedReviewText: Text
  }
}

test('已连接宿主仅改自定义属性时发现延迟的开放 Shadow DOM，属性风暴不重扫普通后代', async ({ context, extensionId }, info) => {
  const origin = 'https://shadow-fixture.devin.ai'
  const endpoint = 'https://mock-shadow.devin.ai'
  const ungranted = 'https://shadow-fixture.test'
  const requests: Array<{ texts: string[]; body: string }> = []
  const body = `<!doctype html><meta charset="utf-8"><div id="first"></div><div id="other"></div><div id="closed"></div>
    <nav id="noise" style="display:grid;grid-template-columns:repeat(16,1fr)">${'<p style="margin:0">已有中文。</p>'.repeat(64)}</nav>
    <p id="signal">Initial scan complete.</p>`
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url())
    if (url.href === endpoint + '/v1/chat/completions') {
      const payload = route.request().postDataJSON() as { messages: Array<{ content: string }> }
      const input = JSON.parse(payload.messages[1]!.content) as string[] | { texts: string[] }
      const texts = Array.isArray(input) ? input : input.texts
      requests.push({ texts, body: route.request().postData()! })
      return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(texts.map(() => '测试译文')) } }] } })
    }
    if (url.origin === origin || url.origin === ungranted) {
      const html = url.pathname === '/boundary-control' ? body.replace('Initial scan complete.', 'Boundary control initialized.') : body
      return route.fulfill({ contentType: 'text/html', body: html })
    }
    return route.abort()
  })

  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  const saved = await options.evaluate(async baseUrl => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    return chrome.runtime.sendMessage({
      type: 'wt:save-config', patch: { baseUrl, model: 'fixture', disabledDictionaries: ['devin'], floatingButtonEnabled: false },
      apiKey: 'synthetic-fixture-key',
    })
  }, endpoint + '/v1')
  expect(saved).toMatchObject({ ok: true })
  const page = await context.newPage()
  await page.goto(origin + '/article')
  const worker = context.serviceWorkers()[0]!
  const tabId = await worker.evaluate(async url => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    const [tab] = await chrome.tabs.query({ url })
    if (tab?.id === undefined) throw new Error('Fixture tab unavailable')
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED',
      func: () => {
        const probe = { observers: 0, reads: 0, deliveries: 0, records: 0, callbackMs: 0, maxCallbackMs: 0, measuring: false }
        window.__shadowReviewProbe = probe
        const leaves = new Set(Array.from(document.querySelectorAll('#noise p'), element => element.firstChild))
        const value = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeValue')!
        Object.defineProperty(Node.prototype, 'nodeValue', {
          ...value,
          get(this: Node) {
            if (leaves.has(this as ChildNode)) probe.reads++
            return value.get!.call(this)
          },
        })
        const engines = new WeakSet<MutationObserver>()
        window.MutationObserver = class extends MutationObserver {
          constructor(callback: MutationCallback) {
            super((records, observer) => {
              if (!probe.measuring || !engines.has(observer)) return callback(records, observer)
              const start = performance.now()
              try { callback(records, observer) } finally {
                const duration = performance.now() - start
                probe.callbackMs += duration
                probe.maxCallbackMs = Math.max(probe.maxCallbackMs, duration)
                probe.deliveries++
                probe.records += records.length
              }
            })
          }
          override observe(target: Node, config?: MutationObserverInit): void {
            if (target === document.documentElement && config?.childList && config.characterData && config.attributes) {
              if (!engines.has(this)) probe.observers++
              engines.add(this)
            }
            super.observe(target, config)
          }
        }
      },
    })
    return tab.id
  }, page.url())
  const setAuto = (site: string) => options.evaluate(async origin => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin, enabled: true })
  }, site)
  expect(await setAuto(origin)).toMatchObject({ ok: true })
  await expect(page.locator('#signal')).toHaveText('测试译文')

  const controlStart = requests.length
  await worker.evaluate(async tabId => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED',
      func: () => {
        window.__shadowReviewProbe.reads = 0
        const first = document.querySelector('#noise p')!.firstChild as Text
        first.data = 'Positive read and request control.'
      },
    })
  }, tabId)
  await expect(page.locator('#noise p').first()).toHaveText('测试译文')
  const controlRequests = requests.slice(controlStart).map(r => r.texts)
  const measureNoise = async (mode: 'batched' | 'synchronous') => {
    const start = requests.length
    const result = await worker.evaluate(async ({ tabId, mode }) => {
      const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
      const [measured] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: 'ISOLATED', args: [mode],
        func: async mode => {
          const probe = window.__shadowReviewProbe
          const nav = document.querySelector('#noise')!
          const leaves = Array.from(nav.children)
          const first = leaves[0]!.firstChild as Text
          const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
          const control = { translated: first.data === '测试译文', reads: probe.reads, observers: probe.observers }
          let observedWrites = 0
          const meter = new MutationObserver(items => { observedWrites += items.length })
          meter.observe(nav, { attributes: true, subtree: true, attributeFilter: ['data-count', 'vendor-phase'] })
          probe.reads = 0
          probe.deliveries = 0
          probe.records = 0
          probe.callbackMs = 0
          probe.maxCallbackMs = 0
          probe.measuring = true
          const started = performance.now()
          for (let batch = 0; batch < 30; batch++) {
            for (const element of leaves) {
              element.setAttribute('data-count', String(batch))
              nav.setAttribute('vendor-phase', String(batch))
            }
            if (mode === 'batched') await wait(4)
          }
          const elapsedMs = performance.now() - started
          await wait(300)
          probe.measuring = false
          meter.disconnect()
          return { control, observedWrites, elapsedMs, reads: probe.reads, deliveries: probe.deliveries, records: probe.records, callbackMs: probe.callbackMs, maxCallbackMs: probe.maxCallbackMs }
        },
      })
      return measured?.result
    }, { tabId, mode })
    if (!result) throw new Error('Missing isolated-world measurements')
    return { ...result, noiseRequests: requests.slice(start).map(r => r.texts) }
  }
  const perf = await measureNoise('batched')
  const syncPerf = await measureNoise('synchronous')
  const privatePages = new Map<string, typeof page>()
  for (const [label, url] of [['sensitive', origin + '/account'], ['noGrant', ungranted + '/article'], ['positive', origin + '/boundary-control']] as const) {
    if (label === 'noGrant') {
      expect(await options.evaluate(async site => {
        const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
        return chrome.permissions.contains({ origins: [site + '/*'] })
      }, ungranted)).toBe(false)
      expect(await setAuto(ungranted)).toMatchObject({ ok: false })
    }
    const boundaryPage = await context.newPage()
    await boundaryPage.goto(url)
    if (label === 'positive') await expect(boundaryPage.locator('#signal')).toHaveText('测试译文')
    await boundaryPage.evaluate(text => {
      const host = document.querySelector('#first')!
      const leaf = document.createElement('p')
      leaf.textContent = text
      host.attachShadow({ mode: 'open' }).append(leaf)
      host.setAttribute('data-state', 'ready')
    }, label === 'positive' ? 'Boundary control shadow text.' : 'Private marker ' + label)
    if (label === 'positive') {
      await expect(boundaryPage.locator('#first p')).toHaveText('测试译文')
      expect(requests.flatMap(r => r.texts)).toEqual(expect.arrayContaining(['Boundary control initialized.', 'Boundary control shadow text.']))
    } else {
      privatePages.set(label, boundaryPage)
    }
  }
  await page.bringToFront()
  await page.evaluate(() => {
    const add = (id: string, attribute: string, text: string) => {
      const host = document.getElementById(id)!
      const leaf = document.createElement('p')
      leaf.textContent = text
      host.attachShadow({ mode: 'open' }).append(leaf)
      host.setAttribute(attribute, 'ready')
      return host.shadowRoot!
    }
    const outer = add('first', 'data-state', 'Delayed outer text.')
    outer.append(document.createElement('section'))
    add('other', 'vendor-phase', 'Other custom attribute text.')
    const host = document.querySelector('#closed')!
    const paragraph = document.createElement('p')
    window.__closedReviewText = document.createTextNode('Private marker closed')
    paragraph.append(window.__closedReviewText)
    host.attachShadow({ mode: 'closed' }).append(paragraph)
    host.setAttribute('data-state', 'ready')
  })
  const waitTranslated = async (selector: string) => {
    await expect(page.locator(selector)).toHaveText('测试译文')
    return page.locator(selector).textContent()
  }
  const outer = await waitTranslated('#first p')
  const other = await waitTranslated('#other p')
  await page.evaluate(() => {
    const host = document.querySelector('#first')!.shadowRoot!.querySelector('section')!
    const leaf = document.createElement('p')
    leaf.textContent = 'Nested delayed text.'
    host.attachShadow({ mode: 'open' }).append(leaf)
    host.setAttribute('widget-step', 'expanded')
  })
  const nested = await waitTranslated('#first section p')
  await page.locator('#first section p').evaluate(el => { (el.firstChild as Text).data = 'New character data.' })
  const updated = await waitTranslated('#first section p')
  const closed = await page.evaluate(() => ({
    text: window.__closedReviewText.data,
    hidden: document.querySelector('#closed')!.shadowRoot === null,
  }))
  const boundaries: Record<string, string | null> = {}
  for (const [label, privatePage] of privatePages) boundaries[label] = await privatePage.locator('#first p').textContent()
  const measured = { outer, other, nested, updated, closed, boundaries, perf, syncPerf, controlRequests, noiseRequests: perf.noiseRequests, requests }
  await writeFile(info.outputPath('shadow-review.json'), JSON.stringify(measured, null, 2))
  expect(measured).toMatchObject({
    outer: '测试译文', other: '测试译文', nested: '测试译文', updated: '测试译文', closed: { text: 'Private marker closed', hidden: true },
    boundaries: { sensitive: 'Private marker sensitive', noGrant: 'Private marker noGrant' },
    perf: { observedWrites: 3840, records: 3840, reads: 0, control: { translated: true } },
    syncPerf: { observedWrites: 3840, records: 3840, deliveries: 1, reads: 0, noiseRequests: [] },
    controlRequests: [['Positive read and request control.']], noiseRequests: [],
  })
  expect(perf.control.reads).toBeGreaterThan(0)
  expect(perf.control.observers).toBeGreaterThan(0)
  // 后续阳性页面与嵌套根均已完成翻译，此时一并核对防抖后才送达的模型输入。
  expect(requests.flatMap(request => request.texts).sort()).toEqual([
    'Initial scan complete.', 'Positive read and request control.',
    'Boundary control initialized.', 'Boundary control shadow text.',
    'Delayed outer text.', 'Other custom attribute text.',
    'Nested delayed text.', 'New character data.',
  ].sort())
  for (const request of requests) expect(request.body).not.toContain('Private marker')
})
