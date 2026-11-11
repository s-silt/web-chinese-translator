import { browser } from 'wxt/browser'

export async function openTextTranslationWindow(): Promise<void> {
  const url = browser.runtime.getURL('/translate.html')
  try {
    await browser.windows.create({ url, type: 'popup', width: 1000, height: 760 })
    return
  } catch {
    void 0
  }
  await browser.tabs.create({ url })
}
