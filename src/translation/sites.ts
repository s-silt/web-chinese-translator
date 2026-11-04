import { joinsWithoutSpaces, looksLikeTargetLanguage, type SourceLanguage, type TargetLanguage } from './target-language'


const FIXED_CONTROL_SELECTOR = 'button,a,label,h1,h2,h3,h4,h5,h6,th,summary,legend,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"],[role="option"],[role="heading"],[role="checkbox"],[role="radio"],[role="switch"]'
const FIXED_NAVIGATION_SELECTOR = 'nav,header,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],[role="tree"],[role="listbox"],[role="toolbar"]'
const FIXED_OTHER_REGION_SELECTOR = 'aside,[role="dialog"]'
export const FIXED_UI_SELECTOR = `${FIXED_CONTROL_SELECTOR},${FIXED_NAVIGATION_SELECTOR},${FIXED_OTHER_REGION_SELECTOR}`

export const FIXED_EXCLUDE_SELECTOR =
  '.prose,.markdown,.markdown-body,[data-message-id],[data-message-author-role]'

const PROTECTED_CONTENT_SELECTOR = 'script,style,noscript,code,pre,select,option,svg,math,canvas,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],.monaco-editor,.cm-editor,.CodeMirror,[translate="no"],.notranslate,[data-sensitive],[data-wt-root]'
export const GENERAL_EXCLUDE_SELECTOR = `input,textarea,${PROTECTED_CONTENT_SELECTOR}`
export const FIXED_ATTRIBUTES: readonly string[] = ['title', 'aria-label', 'placeholder']


/** 单条发给模型的文本上限；更长的文本节点按 splitLongText 分段。 */
export const MAX_MODEL_TEXT = 1500

const SENTENCE_END = /[.!?;:…。！？；：][)\]"'”’）】》」』]*$/

export interface LongTextChunks {
  readonly chunks: readonly string[]
  /** chunks[i] 与 chunks[i + 1] 之间的原始空白，长度比 chunks 少 1。 */
  readonly separators: readonly string[]
}

function findCut(text: string, limit: number): { end: number; next: number } {
  let sentence = -1
  let space = -1
  for (const match of text.slice(0, limit + 1).matchAll(/\s+/g)) {
    const start = match.index
    if (start === 0) continue
    space = start
    if (start >= limit / 2 && (match[0].includes('\n') || SENTENCE_END.test(text.slice(Math.max(0, start - 8), start)))) {
      sentence = start
    }
  }
  const cut = sentence >= 0 ? sentence : space
  if (cut >= 0) {
    const rest = text.slice(cut)
    return { end: cut, next: cut + (rest.length - rest.trimStart().length) }
  }
  // 没有空白：硬切，但不拆开代理对
  const code = text.charCodeAt(limit - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
  return { end, next: end }
}

/** 按句子、其次按空白把长文本切成不超过 limit 的分段；相同原文总得到相同分段，重试可命中缓存。 */
export function splitLongText(text: string, limit = MAX_MODEL_TEXT): LongTextChunks {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('分段上限必须是至少 2 的安全整数')
  const chunks: string[] = []
  const separators: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const { end, next } = findCut(rest, limit)
    chunks.push(rest.slice(0, end))
    separators.push(rest.slice(end, next))
    rest = rest.slice(next)
  }
  chunks.push(rest)
  return { chunks, separators }
}

/** 拼接分段译文：换行照旧保留；中文相邻处不留原文的单词间空格。 */
const CJK_OR_FULLWIDTH = /[、-〿㐀-鿿가-힯！-￮]/

export function joinTranslatedChunks(parts: readonly string[], separators: readonly string[], language: TargetLanguage): string {
  const tight = joinsWithoutSpaces(language)
  return parts.reduce((joined, part, index) => {
    const separator = separators[index - 1] ?? ''
    if (separator.includes('\n')) return joined + separator + part
    const adjacent = CJK_OR_FULLWIDTH.test(joined.slice(-1)) || CJK_OR_FULLWIDTH.test(part.slice(0, 1))
    return joined + (tight && adjacent ? '' : separator) + part
  }, '')
}

export function isModelCandidateText(
  text: string,
  language: TargetLanguage,
  sourceLanguage: SourceLanguage = 'auto',
): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (!/\p{L}/u.test(trimmed)) return false
  if (/^https?:\/\/\S+$/i.test(trimmed)) return false
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(trimmed)) return false
  if (sourceLanguage === language) return false
  if (sourceLanguage === 'auto' && looksLikeTargetLanguage(trimmed, language)) return false
  return true
}

export const FIXED_INLINE_WRAP = 'span,b,strong,i,em,small'

const FIXED_LAYOUT_WRAP = `${FIXED_INLINE_WRAP},div,li,ul,ol`
const MAX_FIXED_UI_DEPTH = 16
function isCompactPointerControl(element: Element): boolean {
  if (!element.matches('div,span,li') || element.childElementCount > 8) return false
  const pointer = element.classList.contains('cursor-pointer') ||
    (element instanceof HTMLElement && element.style.cursor === 'pointer') || element.hasAttribute('onclick')
  if (!pointer) return false
  if (closestComposed(element, 'article,blockquote,[role="article"]') !== null) return false
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node instanceof Element && node.matches('svg,kbd') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  let visited = 0
  let characters = 0
  let paragraphs = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (++visited > 32) return false
    if (node instanceof Element) {
      if (!node.matches(`${FIXED_INLINE_WRAP},div,p`)) return false
      if (node.tagName === 'P' && ++paragraphs > 1) return false
    } else if (node instanceof Text) {
      characters += node.data.length
      if (characters > 200) return false
    }
  }
  return characters > 0 || element.hasAttribute('aria-label') || element.hasAttribute('title')
}
export function isFixedUiElement(element: Element): boolean {
  return element.matches(FIXED_UI_SELECTOR) || isCompactPointerControl(element)
}
export function fixedUiContext(element: Element): boolean {
  let current: Element | null = element
  let paragraph = false
  for (let depth = 0; current !== null && depth < MAX_FIXED_UI_DEPTH; depth += 1) {
    if (current.matches(FIXED_CONTROL_SELECTOR) || isCompactPointerControl(current)) return true
    if (current.matches(FIXED_NAVIGATION_SELECTOR)) return true
    if (current.matches(FIXED_OTHER_REGION_SELECTOR)) return !paragraph
    if (current.tagName === 'P') paragraph = true
    else if (!current.matches(FIXED_LAYOUT_WRAP)) return false
    const root = current.getRootNode()
    current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
  }
  return false
}
export function canTranslateFixedFormAttributes(element: Element): boolean {
  if (!element.matches('input:not([type="password" i]):not([type="hidden" i]),textarea')) return false
  if (element instanceof HTMLElement && element.isContentEditable) return false
  return closestComposed(element, `${PROTECTED_CONTENT_SELECTOR},${FIXED_EXCLUDE_SELECTOR}`) === null
}

/** closest() 跨 open ShadowRoot 上溯：host 或更外层祖先命中也算排除（保守：跨层受限时视为命中）。 */
export function closestComposed(element: Element, selector: string): Element | null {
  let current: Element | null = element
  for (let depth = 0; current !== null && depth < 64; depth++) {
    const match = current.closest(selector)
    if (match !== null) return match
    const root = current.getRootNode()
    current = root instanceof ShadowRoot ? root.host : null
  }
  return current
}

export function isExcludedElement(element: Element): boolean {
  if (closestComposed(element, GENERAL_EXCLUDE_SELECTOR) !== null) return true
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return false
}

export function isFixedExcludedElement(element: Element): boolean {
  return isExcludedElement(element) || closestComposed(element, FIXED_EXCLUDE_SELECTOR) !== null
}
