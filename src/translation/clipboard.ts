export async function copySelectionText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* HTTP 或站点策略下使用同步复制事件。 */ }
  let copied = false
  const write = (event: ClipboardEvent): void => {
    if (event.clipboardData === null) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    event.stopImmediatePropagation()
    copied = true
  }
  document.addEventListener('copy', write, true)
  try {
    return typeof document.execCommand === 'function' && document.execCommand('copy') && copied
  } catch { return false }
  finally { document.removeEventListener('copy', write, true) }
}
