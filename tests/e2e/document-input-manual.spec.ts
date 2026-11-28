import { expect, test, waitForSiteContentReady, waitForSiteScriptRegistration } from './fixtures'

test.use({ headless: false })

test('专用编辑器手动热键翻译及还原：停输、伪造事件和焦点移出都不会提交草稿', async ({ context, extension }, info) => {
  const origin = 'https://app.devin.ai'
  const endpoint = 'https://fixture-document.devin.ai'
  const draft = '这份本地草稿需要翻译。'
  const translated = 'This local draft needs a translation.'
  const calls: string[][] = []
  await context.route('https://**/*', async route => {
    const url = route.request().url()
    if (url === endpoint + '/v1/chat/completions') {
      const parsed = JSON.parse(route.request().postDataJSON().messages[1].content) as string[] | { texts: string[] }
      const texts = Array.isArray(parsed) ? parsed : parsed.texts
      calls.push(texts)
      return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(texts.map(() => translated)) } }] } })
    }
    if (url !== origin + '/document-manual') return route.abort()
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">
      <h1>文档草稿</h1><div class="CodeMirror"><textarea aria-label="文档正文" cols="60" rows="5"></textarea></div>
      <input aria-label="其他字段"><script>
      const root = document.querySelector('.CodeMirror')
      const field = root.querySelector('textarea')
      root.CodeMirror = {
        getWrapperElement: () => root, getValue: () => field.value, posFromIndex: i => ({ line: 0, ch: i }),
        replaceRange: (text, from, to) => field.setRangeText(text, from.ch, to.ch, 'end')
      }
      </script>` })
  })
  await extension.setTranslationConfig({
    baseUrl: endpoint + '/v1', model: 'fixture', inputTranslationEnabled: true, inputReplaceMode: 'auto',
    inputTriggerMode: 'manual', inputTriggerHotkey: 'Ctrl+Enter', inputAutoReplaceDelayMs: 600, floatingButtonEnabled: false,
  })
  const url = origin + '/document-manual'
  await waitForSiteScriptRegistration(extension.page, { url })
  const page = await context.newPage()
  await page.goto(url)
  await waitForSiteContentReady(extension.page, page, { supported: true })
  await page.bringToFront()
  const field = page.getByRole('textbox', { name: '文档正文' })
  await field.focus()
  await page.keyboard.insertText(draft)
  await field.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })))
  await page.waitForTimeout(800)
  await expect(field).toHaveValue(draft)
  expect(calls).toHaveLength(0)
  await page.keyboard.press('Control+Enter')
  await expect(field).toHaveValue(translated)
  expect(calls).toEqual([[draft]])
  await page.screenshot({ path: info.outputPath('document-manual-translated.png') })
  await page.keyboard.press('Alt+z')
  await expect(field).toHaveValue(draft)
  const outside = page.getByRole('textbox', { name: '其他字段' })
  await outside.fill('本地保留')
  await page.keyboard.press('Alt+z')
  await expect(outside).toHaveValue('本地保留')
  await expect(field).toHaveValue(draft)
  expect(calls).toEqual([[draft]])
})
