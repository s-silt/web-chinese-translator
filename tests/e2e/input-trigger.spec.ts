import { expect, test, waitForSiteContentReady, waitForSiteScriptRegistration } from './fixtures'

test.use({ headless: false })

test('手动输入翻译保留原稿，浮层可按次改语言，Alt+Z 无请求还原', async ({ context, extension, extensionId }, testInfo) => {
  const url = 'https://app.devin.ai/input-draft'
  const endpoint = 'https://fixture-metrics.devin.ai/v1'
  const original = '请核对这份草稿。'
  const calls: { texts: string[]; language: string }[] = []
  await context.route('https://**/*', async route => {
    if (route.request().url() === url) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN">
        <meta charset="utf-8"><title>输入翻译</title>
        <style>body{max-width:640px;margin:64px auto;font:16px system-ui;color:#1f2328}textarea{box-sizing:border-box;width:100%;height:100px;padding:12px;font:inherit}</style>
        <label for="draft">消息草稿</label><textarea id="draft"></textarea></html>` })
    }
    if (route.request().url() !== endpoint + '/chat/completions') return route.abort()
    const { messages } = route.request().postDataJSON() as { messages: { content: string }[] }
    const content = JSON.parse(messages[1]!.content)
    const texts: string[] = Array.isArray(content) ? content : content.texts
    const language = messages[0]!.content.includes('Japanese') ? 'ja' : 'en'
    calls.push({ texts, language })
    return route.fulfill({ json: { choices: [{ message: {
      content: JSON.stringify(texts.map(() => language === 'ja' ? '下書きを確認してください。' : 'Please check this draft.')),
    } }] } })
  })
  await extension.setSettings({ uiLanguage: 'zh-CN' })
  await extension.setTranslationConfig({
    baseUrl: endpoint, model: 'fixture', inputTranslationEnabled: true, inputReplaceMode: 'auto',
    inputAutoReplaceDelayMs: 500, inputTargetLanguage: 'en', floatingButtonEnabled: false,
  })
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html#wt-general-title`)
  const mode = options.locator('[data-test="wt-input-trigger-mode"]')
  await mode.click()
  await options.getByRole('option', { name: /仅按快捷键/ }).click()
  const hotkey = options.locator('[data-test="wt-input-trigger-hotkey"]')
  await expect(hotkey).toBeVisible()
  await options.reload()
  await hotkey.click()
  await expect(options.getByRole('option', { name: 'Alt+Enter', exact: true })).toHaveAttribute('aria-selected', 'true')
  await options.keyboard.press('Escape')
  const settings = options.locator('[data-test="wt-input-subpanel"]')
  await settings.screenshot({ path: testInfo.outputPath('input-manual-settings.png') })

  await waitForSiteScriptRegistration(extension.page, { url })
  const page = await context.newPage()
  await page.goto(url)
  await waitForSiteContentReady(extension.page, page, { supported: true })
  const draft = page.getByRole('textbox', { name: '消息草稿' })
  await draft.fill(original)
  await page.waitForTimeout(900)
  await expect(draft).toHaveValue(original)
  expect(calls).toHaveLength(0)
  await draft.press('Alt+Enter')
  await expect(draft).toHaveValue('Please check this draft.')
  const language = page.locator('[data-wt-root] select[data-action="target-lang"]')
  await expect(language).toHaveValue('en')
  await page.screenshot({ path: testInfo.outputPath('input-language-panel.png') })
  await language.press('ArrowDown')
  await expect(draft).toHaveValue('下書きを確認してください。')
  await draft.press('Alt+z')
  await expect(draft).toHaveValue(original)
  await expect(language).toBeHidden()
  expect(calls).toEqual([{ texts: [original], language: 'en' }, { texts: [original], language: 'ja' }])
})
