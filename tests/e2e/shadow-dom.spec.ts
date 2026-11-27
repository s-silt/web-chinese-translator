import { writeFile } from 'node:fs/promises'
import { expect, test } from './fixtures'

type ExtensionApi = typeof import('wxt/browser').browser
interface EngineProbe {
  observers: number
  reads: number
  records: number
  deliveries: number
  callbackMs: number
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
  const requests: Array<{ receivedAt: number; texts: string[] }> = []
  const body = `<!doctype html><meta charset="utf-8"><div id="first"></div><div id="other"></div><div id="closed"></div>
    <nav id="noise" style="display:grid;grid-template-columns:repeat(16,1fr)">${'<p style="margin:0">已有中文。</p>'.repeat(64)}</nav>
    <p id="signal">Initial scan complete.</p>`
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url())
    if (url.href === endpoint + '/v1/chat/completions') {
      const payload = route.request().postDataJSON() as { messages: Array<{ content: string }> }
      const input = JSON.parse(payload.messages[1]!.content) as string[] | { texts: string[] }
      const texts = Array.isArray(input) ? input : input.texts
      requests.push({ receivedAt: Date.now(), texts })
      return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(texts.map(() => '测试译文')) } }] } })
    }
    if (url.origin === origin || url.origin === ungranted) {
      return route.fulfill({ contentType: 'text/html', body })
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
        const probe = { observers: 0, reads: 0, deliveries: 0, records: 0, callbackMs: 0, measuring: false }
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
                probe.callbackMs += performance.now() - start
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

  const perfRequestsStart = requests.length
  const perf = await worker.evaluate(async tabId => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    const [measured] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED',
      func: async () => {
        const probe = window.__shadowReviewProbe
        const nav = document.querySelector('#noise')!
        const leaves = Array.from(nav.children)
        const first = leaves[0]!.firstChild as Text
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
        probe.reads = 0
        first.data = 'Positive read and request control.'
        for (let i = 0; i < 120 && first.data !== '测试译文'; i++) await wait(25)
        const control = { translated: first.data === '测试译文', reads: probe.reads, observers: probe.observers }
        await wait(250)
        let observedWrites = 0
        const meter = new MutationObserver(items => { observedWrites += items.length })
        meter.observe(nav, { attributes: true, subtree: true, attributeFilter: ['data-count', 'vendor-phase'] })
        probe.reads = 0
        probe.measuring = true
        const noiseStart = Date.now()
        const started = performance.now()
        for (let batch = 0; batch < 30; batch++) {
          for (const element of leaves) {
            element.setAttribute('data-count', String(batch))
            nav.setAttribute('vendor-phase', String(batch))
          }
          await wait(4)
        }
        const elapsedMs = performance.now() - started
        await wait(300)
        probe.measuring = false
        meter.disconnect()
        return { control, noiseStart, observedWrites, elapsedMs, reads: probe.reads, deliveries: probe.deliveries, records: probe.records, callbackMs: probe.callbackMs }
      },
    })
    return measured?.result
  }, tabId)
  expect(perf).toBeDefined()
  const perfRequests = requests.slice(perfRequestsStart)
  const controlRequests = perfRequests.filter(r => r.receivedAt < perf!.noiseStart).map(r => r.texts)
  const noiseRequests = perfRequests.filter(r => r.receivedAt >= perf!.noiseStart).map(r => r.texts)
  const boundaries: Record<string, string | null> = {}
  for (const [label, url] of [['sensitive', origin + '/account'], ['noGrant', ungranted + '/article']] as const) {
    if (label === 'noGrant') {
      expect(await options.evaluate(async site => {
        const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
        return chrome.permissions.contains({ origins: [site + '/*'] })
      }, ungranted)).toBe(false)
      expect(await setAuto(ungranted)).toMatchObject({ ok: false })
    }
    const excluded = await context.newPage()
    await excluded.goto(url)
    await excluded.evaluate(name => {
      const host = document.querySelector('#first')!
      const leaf = document.createElement('p')
      leaf.textContent = 'Private marker ' + name
      host.attachShadow({ mode: 'open' }).append(leaf)
      host.setAttribute('data-state', 'ready')
    }, label)
    await excluded.waitForTimeout(600)
    boundaries[label] = await excluded.locator('#first p').textContent()
    await excluded.close()
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
    await page.locator(selector).filter({ hasText: /^测试译文$/ }).waitFor({ timeout: 2500 }).catch(() => {})
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
  const measured = { outer, other, nested, updated, closed, boundaries, perf, controlRequests, noiseRequests, requests }
  await writeFile(info.outputPath('shadow-review.json'), JSON.stringify(measured, null, 2))
  expect(measured).toMatchObject({
    outer: '测试译文', other: '测试译文', nested: '测试译文', updated: '测试译文', closed: { text: 'Private marker closed', hidden: true },
    boundaries: { sensitive: 'Private marker sensitive', noGrant: 'Private marker noGrant' },
    perf: { observedWrites: 3840, reads: 0, control: { translated: true } },
    controlRequests: [['Positive read and request control.']], noiseRequests: [],
  })
  expect(perf!.control.reads).toBeGreaterThan(0)
  expect(perf!.control.observers).toBeGreaterThan(0)
  expect(requests.flatMap(r => r.texts)).not.toContainEqual(expect.stringContaining('Private marker'))
})
