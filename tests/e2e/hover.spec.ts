import { expect, test, waitForSiteContentReady, waitForSiteScriptRegistration } from './fixtures'

test.use({ headless: false })

test('双语外观覆盖嵌套开放组件，封顶后可用现有译文重绘可见文字与原生弹层', async ({ context, extension }) => {
  const origin = 'https://app.devin.ai'
  const endpoint = 'https://fixture-metrics.devin.ai'
  const calls: string[][] = []
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url())
    if (url.href === endpoint + '/v1/chat/completions') {
      const data = route.request().postDataJSON() as { messages: { content: string }[] }
      const body = JSON.parse(data.messages[1]!.content) as { texts: string[] }
      calls.push(body.texts)
      const translations = body.texts.map(text => text.includes('<1>') ? '阅读<1>指南</1>。' : '实测译文')
      return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(translations) } }] } })
    }
    if (url.origin !== origin) return route.abort()
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
      <style>@media (max-width: 1000px) { #contents { display: contents } #none { display: none } }</style>
      <p id="rich-line">Read <span id="contents">the guide</span> today.</p>
      <p><span id="none">Read this hidden sentence.</span></p>
      <div id="panel" popover="manual"><p id="inside">Read this native popover.</p></div>
      <div id="outer"></div><span id="site-mark" data-wt-bilingual="1" data-wt-bilingual-variant="site">网站标记</span>
      <div id="quota" style="font:2px/4px monospace"></div><script>
        document.querySelector('#panel').showPopover()
        const inner = document.createElement('div')
        document.querySelector('#outer').attachShadow({mode:'open'}).append(inner)
        inner.attachShadow({mode:'open'}).innerHTML = '<p id="nested">Read this nested paragraph.</p>'
      </script>` })
  })
  const config = { baseUrl: endpoint + '/v1', model: 'fixture', autoOrigins: [origin], pageCharLimit: 20_000 }
  await extension.setTranslationConfig({ ...config, displayMode: 'bilingual', bilingualStyle: 'highlight' })
  const url = origin + '/native-layout'
  await waitForSiteScriptRegistration(extension.page, { url })
  const page = await context.newPage()
  await page.goto(url)
  const id = await waitForSiteContentReady(extension.page, page, { auto: true })
  const status = () => extension.page.evaluate(async id => {
    const { chrome } = globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
    const reply = await chrome.tabs.sendMessage(id, { type: 'wt:status' }) as { status: { budgetCapped: boolean; progress: { spent: number } } }
    return reply.status
  }, id)
  await expect(page.locator('#inside [data-wt-bilingual]')).toHaveText('实测译文')
  await expect(page.locator('#rich-line [data-wt-bilingual]')).toHaveText('阅读指南。')
  await expect(page.locator('#none [data-wt-bilingual]')).toHaveText('实测译文')
  const lines = ['#inside', '#rich-line', '#nested'].map(id => page.locator(id).locator('[data-wt-bilingual]'))
  for (const line of lines) {
    await expect(line).toHaveAttribute('data-wt-bilingual-variant', 'highlight')
    await expect(line).toHaveCSS('border-left-width', '3px')
  }
  const callsBeforeStyleChange = calls.length
  await extension.setTranslationConfig({ ...config, displayMode: 'bilingual', bilingualStyle: 'underline' })
  for (const line of lines) {
    await expect(line).toHaveAttribute('data-wt-bilingual-variant', 'underline')
    await expect(line).toHaveCSS('border-bottom-style', 'dashed')
  }
  await expect(page.locator('#site-mark')).toHaveAttribute('data-wt-bilingual-variant', 'site')
  await expect(page.locator('#site-mark')).toHaveCSS('display', 'inline')
  expect(calls).toHaveLength(callsBeforeStyleChange)
  await page.locator('#nested').evaluate(el => {
    const row = document.createElement('p')
    row.id = 'added'
    row.textContent = 'Read another paragraph inside the component.'
    el.after(row)
  })
  await expect(page.locator('#added [data-wt-bilingual]')).toHaveAttribute('data-wt-bilingual-variant', 'underline')
  await page.locator('#quota').evaluate(el => {
    for (let i = 0; i < 16; i++) {
      const row = document.createElement('p')
      row.textContent = `Quota fixture paragraph number ${i} for a local layout test. `.repeat(30).slice(0, 1390)
      el.append(row)
    }
  })
  await expect.poll(async () => (await status()).budgetCapped, { timeout: 30_000 }).toBe(true)
  const spent = (await status()).progress.spent
  const sent = calls.length
  await page.locator('#panel').evaluate(el => (el as HTMLElement).hidePopover())
  await page.setViewportSize({ width: 900, height: 900 })
  const bounds = await page.evaluate(() => {
    const contents = document.querySelector<HTMLElement>('#contents')!
    const none = document.querySelector<HTMLElement>('#none')!
    const panel = document.querySelector<HTMLElement>('#panel')!
    const textWidth = (element: Element) => {
      const range = document.createRange()
      range.selectNodeContents(element.firstChild!)
      return range.getBoundingClientRect().width
    }
    return { contents: textWidth(contents), parentBoxes: contents.getClientRects().length, none: textWidth(none), panel: textWidth(panel.querySelector('p')!) }
  })
  expect(bounds.contents).toBeGreaterThan(0)
  expect(bounds).toMatchObject({ parentBoxes: 0, none: 0, panel: 0 })
  await extension.setTranslationConfig({ ...config, displayMode: 'replace' })
  await expect.soft(page.locator('#contents')).toHaveText('指南', { timeout: 3500 })
  await expect(page.locator('#none')).toHaveText('Read this hidden sentence.')
  await expect(page.locator('#inside')).toHaveText('Read this native popover.')
  await page.locator('#panel').evaluate(el => (el as HTMLElement).showPopover())
  await expect(page.locator('#inside')).toHaveText('实测译文')
  await expect(page.locator('#none')).toHaveText('Read this hidden sentence.')
  const final = await status()
  expect(final).toMatchObject({ budgetCapped: true, progress: { spent } })
  expect(calls).toHaveLength(sent)
  await test.info().attach('native-layout.json', {
    contentType: 'application/json',
    body: JSON.stringify({ bounds, spentBefore: spent, spentAfter: final.progress.spent, callsBefore: sent, callsAfter: calls.length }),
  })
})

test('Alt 悬停保留链接及监听器，忽略隐藏正文、敏感路由、过期响应与已松开的手势', async ({ context, extension, extensionId }) => {
  const origin = 'https://app.devin.ai'
  const endpoint = 'https://fixture-hover.devin.ai'
  const requests: string[] = []
  const payloads: unknown[] = []
  let completeSlow!: () => void
  const slow = new Promise<void>(resolve => { completeSlow = resolve })
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url())
    if (url.href === endpoint + '/v1/chat/completions') {
      const body = route.request().postDataJSON() as { messages: { content: string }[] }
      const input = JSON.parse(body.messages[1]!.content) as string[] | { texts: string[] }
      payloads.push(input)
      const texts = Array.isArray(input) ? input : input.texts
      requests.push(...texts)
      if (texts.includes('Slow paragraph.')) await slow
      return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(texts.map(text =>
        text.replace('Read ', '阅读').replace('the guide', '指南').replace(' today.', '。').replace('Slow paragraph.', '慢译文'),
      )) } }] } })
    }
    if (url.origin === origin) return route.fulfill({ contentType: 'text/html', body:
      '<main><p id="rich">Read <a href="#guide">the guide</a> today.<span hidden>HIDDEN_FIXTURE</span><code>CODE_FIXTURE</code></p>' +
      '<p id="cancel">Release the modifier.</p><p id="slow">Slow paragraph.</p></main>',
    })
    return route.abort()
  })
  // 用已有站点授权和持久化的偏好模拟二次启动；不申请宽泛的站点权限。
  await extension.setTranslationConfig({
    baseUrl: endpoint + '/v1', model: 'fixture', hoverTranslateEnabled: true, floatingButtonEnabled: false,
    selectionPopupEnabled: true, proactiveAssistEnabled: true,
  })
  await waitForSiteScriptRegistration(extension.page, { url: origin + '/hover-article' })
  const page = await context.newPage()
  await page.goto(origin + '/hover-article')
  await waitForSiteContentReady(extension.page, page)
  await extension.page.evaluate(async () => {
    const { chrome } = globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
    await chrome.storage.session.set({ wtReadingContext: { entries: [{
      page: { site: 'previous.fixture.test', title: 'OTHER_TAB_TITLE', heading: 'OTHER_TAB_HEADING' },
      at: Date.now(), tabId: 741852, pageId: crypto.randomUUID(),
    }] } })
  })
  const rich = page.locator('#rich')
  const link = rich.locator('a')
  await link.evaluate(el => el.addEventListener('click', e => { e.preventDefault(); el.dataset.clicked = 'yes' }))
  await page.keyboard.down('Alt')
  try {
    await rich.hover({ position: { x: 3, y: 3 } })
    await expect(rich).toHaveAttribute('data-wt-hover-translated', '1')
    await expect(link).toHaveText('指南')
    expect(requests.length).toBe(1)
    expect(payloads[0]).toEqual({
      texts: [requests[0]], currentPage: { site: 'app.devin.ai', title: '', heading: '' }, recentPages: [],
    })
    expect(requests[0]).not.toMatch(/HIDDEN_FIXTURE|CODE_FIXTURE/)
    await rich.click({ modifiers: ['Alt'], position: { x: 3, y: 3 } })
    await expect(link).toHaveText('the guide')
    await link.click({ modifiers: [] })
    await expect(link).toHaveAttribute('data-clicked', 'yes')
    await page.locator('#cancel').hover()
    await page.keyboard.up('Alt')
    await page.waitForTimeout(230)
    expect(requests).toHaveLength(1)
    await page.keyboard.down('Alt')
    const changing = page.locator('#slow')
    await changing.hover()
    await expect.poll(() => requests).toContain('Slow paragraph.')
    await changing.evaluate(el => { el.textContent = 'Updated by the page.' })
    completeSlow()
    await expect(changing).not.toHaveAttribute('data-wt-hover-loading', '1')
    await expect(changing).toHaveText('Updated by the page.')
    await page.evaluate(() => history.pushState({}, '', '/settings/tokens'))
    await page.locator('#cancel').hover()
    await page.waitForTimeout(300)
    expect(requests).toHaveLength(2)
    await expect(page.locator('[data-wt-hover-translated]')).toHaveCount(0)
    await page.keyboard.up('Alt')
    const hoverConfig = { baseUrl: endpoint + '/v1', model: 'fixture', hoverTranslateEnabled: true, displayMode: 'bilingual' }
    await extension.setTranslationConfig({ ...hoverConfig, bilingualStyle: 'highlight' })
    await page.goto(origin + '/hover-style')
    await waitForSiteContentReady(extension.page, page)
    await page.keyboard.down('Alt')
    await rich.hover({ position: { x: 3, y: 3 } })
    const hoverLine = rich.locator('[data-wt-bilingual]')
    await expect(hoverLine).toHaveAttribute('data-wt-bilingual-variant', 'highlight')
    await page.keyboard.up('Alt')
    await expect(hoverLine).toHaveText('阅读指南。')
    const hoverRequests = payloads.length
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html#wt-tools-title`)
    const appearance = options.locator('#wt-bilingual-style')
    const underline = options.getByRole('option', { name: /底部虚线下划线|Dashed underline/ })
    await appearance.click()
    await underline.click()
    await appearance.click()
    await expect(underline).toHaveAttribute('aria-selected', 'true')
    await options.close()
    await page.bringToFront()
    await expect(hoverLine).toHaveAttribute('data-wt-bilingual-variant', 'underline')
    await expect(rich).toHaveAttribute('data-wt-hover-translated', '1')
    await expect(link).toHaveText('the guide')
    await rich.click({ modifiers: ['Alt'], position: { x: 3, y: 3 } })
    await expect(hoverLine).toHaveCount(0)
    expect(payloads).toHaveLength(hoverRequests)
    const config = { ...hoverConfig, autoOrigins: [origin] }
    await extension.setTranslationConfig({ ...config, displayMode: 'bilingual' })
    await page.goto(origin + '/bilingual-article')
    const id = await waitForSiteContentReady(extension.page, page, { auto: true })
    const line = rich.locator('[data-wt-bilingual]')
    await expect(line).toHaveText('阅读指南。')
    await expect(link).toHaveText('the guide')
    const beforeRestore = requests.length
    await page.keyboard.down('Alt')
    await rich.hover({ position: { x: 5, y: 4 } })
    await page.waitForTimeout(300)
    await page.keyboard.up('Alt')
    await expect(line).toHaveCount(1)
    await expect(rich).not.toHaveAttribute('data-wt-hover-translated', '1')
    expect(requests).toHaveLength(beforeRestore)
    await extension.setTranslationConfig({ ...config, displayMode: 'replace' })
    await expect(line).toHaveCount(0)
    await expect(link).toHaveText('指南')
    await extension.setTranslationConfig({ ...config, displayMode: 'bilingual' })
    await expect(line).toHaveText('阅读指南。')
    await expect(link).toHaveText('the guide')
    expect(requests).toHaveLength(beforeRestore)
    const restored = await extension.page.evaluate(async ({ id, url }) => {
      const { chrome } = globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
      return chrome.runtime.sendMessage({ type: 'wt:page-action', action: 'restore', tabId: id, url })
    }, { id, url: page.url() })
    expect(restored).toMatchObject({ ok: true })
    await expect(line).toHaveCount(0)
    await expect(link).toHaveAttribute('href', '#guide')
    expect(requests).toHaveLength(beforeRestore)
  } finally {
    completeSlow()
    await page.keyboard.up('Alt')
  }
})
