import type { BilingualStyle } from './preferences-extra'

export const BILINGUAL_ATTR = 'data-wt-bilingual'
export const BILINGUAL_STYLE_ATTR = 'data-wt-bilingual-style'
export const BILINGUAL_VARIANT_ATTR = 'data-wt-bilingual-variant'

const styledRoots = new WeakSet<Document | ShadowRoot>()
const LINE_SELECTOR = `.wt-bilingual-line[${BILINGUAL_ATTR}="1"]`

const BILINGUAL_CSS = `
${LINE_SELECTOR} {
  display: block;
  margin-top: 0.28em;
  padding-left: 0.55em;
  border-left: 2px solid color-mix(in srgb, currentColor 32%, transparent);
  opacity: 0.88;
  font-size: 0.94em;
  line-height: 1.55;
  font-weight: 400;
  white-space: pre-wrap;
  cursor: pointer;
  transition: opacity 120ms ease;
}
${LINE_SELECTOR}[${BILINGUAL_VARIANT_ATTR}="highlight"] {
  padding: 0.3em 0.6em;
  border-left: 3px solid color-mix(in srgb, #3b82f6 60%, currentColor);
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 7%, transparent);
  opacity: 0.96;
}
${LINE_SELECTOR}[${BILINGUAL_VARIANT_ATTR}="underline"] {
  padding-left: 0;
  padding-bottom: 0.12em;
  border-left: none;
  border-bottom: 1px dashed color-mix(in srgb, currentColor 38%, transparent);
  opacity: 0.92;
}
${LINE_SELECTOR}[data-wt-bilingual-collapsed="1"] {
  opacity: 0.22;
}
${LINE_SELECTOR}:focus-visible { outline: 2px solid currentColor; }
@media (prefers-reduced-motion: reduce) {
  ${LINE_SELECTOR} { transition: none; }
}
`

export function isBilingualElement(node: Node | null): boolean {
  if (!node) return false
  if (node instanceof Element) return node.hasAttribute(BILINGUAL_ATTR) || node.closest(`[${BILINGUAL_ATTR}="1"]`) !== null
  return node.parentElement?.closest(`[${BILINGUAL_ATTR}="1"]`) !== null
}

export function ensureBilingualStyle(target: Node): void {
  const root = target.getRootNode()
  if (!(root instanceof Document || root instanceof ShadowRoot)) return
  if (styledRoots.has(root)) return
  styledRoots.add(root)
  const doc = root instanceof Document ? root : root.ownerDocument
  if (!doc) return
  if (root instanceof Document && root.head?.querySelector(`[${BILINGUAL_STYLE_ATTR}="1"]`)) return
  const style = doc.createElement('style')
  style.setAttribute(BILINGUAL_STYLE_ATTR, '1')
  style.textContent = BILINGUAL_CSS
  if (root instanceof Document) {
    ;(root.head ?? root.documentElement)?.appendChild(style)
  } else {
    root.appendChild(style)
  }
}

function createBilingualSpan(doc: Document, translatedText: string, variant: BilingualStyle = 'subtle'): HTMLElement {
  const el = doc.createElement('span')
  el.setAttribute(BILINGUAL_ATTR, '1')
  updateBilingualVariant(el, variant)
  el.className = 'wt-bilingual-line'
  el.textContent = translatedText
  el.tabIndex = 0
  el.setAttribute('role', 'button')
  el.setAttribute('aria-pressed', 'false')
  el.addEventListener('click', (event) => {
    event.stopPropagation()
    event.preventDefault()
    const collapsed = el.getAttribute('data-wt-bilingual-collapsed') === '1'
    if (collapsed) el.removeAttribute('data-wt-bilingual-collapsed')
    else el.setAttribute('data-wt-bilingual-collapsed', '1')
    el.setAttribute('aria-pressed', String(!collapsed))
  })
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    el.click()
  })
  return el
}

/** 更新引擎持有的译文节点，不扫描宿主页面。 */
export function updateBilingualVariant(line: HTMLElement, variant: BilingualStyle): void {
  if (variant === 'subtle') line.removeAttribute(BILINGUAL_VARIANT_ATTR)
  else line.setAttribute(BILINGUAL_VARIANT_ATTR, variant)
}

/** 在原文节点后插入双语对照译文节点，不破坏原文内容，返回插入的元素以便恢复时彻底清除。 */
export function attachBilingualNode(
  anchor: Node,
  translatedText: string,
  variant: BilingualStyle = 'subtle',
): HTMLElement | undefined {
  const insertionPoint = anchor.parentElement?.closest('a,button,label') ?? anchor
  const parent = insertionPoint.parentNode
  const doc = anchor.ownerDocument
  if (!parent || !doc) return undefined
  ensureBilingualStyle(anchor)
  const el = createBilingualSpan(doc, translatedText, variant)
  parent.insertBefore(el, insertionPoint.nextSibling)
  return el
}

/** 在包含链接/粗体等行内富文本的块级容器末尾附加对照译文，完整保留原文行内结构。 */
export function attachBilingualBlock(
  block: Element,
  translatedText: string,
  variant: BilingualStyle = 'subtle',
): HTMLElement | undefined {
  const doc = block.ownerDocument
  if (!doc || !block.isConnected) return undefined
  ensureBilingualStyle(block)
  const el = createBilingualSpan(doc, translatedText, variant)
  block.appendChild(el)
  return el
}

export function removeBilingualNode(el: HTMLElement | undefined): void {
  el?.remove()
}

/** Only remove validated inline placeholders. Preserve the model's spacing and escaped literal text. */
export function inlineTranslationText(translated: string): string {
  return translated.replace(/<\/?\d+\/?>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').trim()
}
