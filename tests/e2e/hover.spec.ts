import { expect, test, waitForSiteContentReady, waitForSiteScriptRegistration } from './fixtures'

test.use({ headless: false })

test('Alt 悬停保留链接及监听器，忽略隐藏正文、敏感路由、过期响应与已松开的手势', async ({ context, extension }) => {
  const origin = 'https://app.devin.ai'
  const endpoint = 'https://fixture-hover.devin.ai'
  const requests: string[] = []
  let completeSlow!: () => void
  const slow = new Promise<void>(resolve => { completeSlow = resolve })
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url())
    if (url.href === endpoint + '/v1/chat/completions') {
      const body = route.request().postDataJSON() as { messages: { content: string }[] }
      const input = JSON.parse(body.messages[1]!.content) as string[] | { texts: string[] }
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
  await extension.setTranslationConfig({ baseUrl: endpoint + '/v1', model: 'fixture', hoverTranslateEnabled: true, floatingButtonEnabled: false })
  await waitForSiteScriptRegistration(extension.page, { url: origin + '/hover-article' })
  const page = await context.newPage()
  await page.goto(origin + '/hover-article')
  await waitForSiteContentReady(extension.page, page)
  const rich = page.locator('#rich')
  const link = rich.locator('a')
  await link.evaluate(el => el.addEventListener('click', e => { e.preventDefault(); el.dataset.clicked = 'yes' }))
  await page.keyboard.down('Alt')
  try {
    await rich.hover({ position: { x: 3, y: 3 } })
    await expect(rich).toHaveAttribute('data-wt-hover-translated', '1')
    await expect(link).toHaveText('指南')
    expect(requests.length).toBe(1)
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
    await extension.setTranslationConfig({
      baseUrl: endpoint + '/v1', model: 'fixture', displayMode: 'bilingual', autoOrigins: [origin],
    })
    await page.goto(origin + '/bilingual-article')
    const id = await waitForSiteContentReady(extension.page, page, { auto: true })
    const line = rich.locator('[data-wt-bilingual]')
    await expect(line).toHaveText('阅读指南。')
    await expect(link).toHaveText('the guide')
    const beforeRestore = requests.length
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
