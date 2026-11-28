import { attachBilingualBlock, inlineTranslationText, isBilingualElement, removeBilingualNode } from './bilingual'
import { inlineUnitFor, isInlineUnitCurrent, parseInlineResult } from './inline-units'
import type { TranslationDisplayMode } from './preferences-extra'
import { isReadableElement } from './reading-context'
import { isExcludedElement } from './sites'

const HOVER_BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, dd, dt, figcaption'
const HOVER_STYLE_ATTR = 'data-wt-hover-style'
const HOVER_CSS = `
[data-wt-hover-preview="1"] {
  outline: 1.5px dashed color-mix(in srgb, currentColor 45%, transparent);
  outline-offset: 2px;
  border-radius: 3px;
}
[data-wt-hover-loading="1"] {
  outline: 1.5px solid color-mix(in srgb, #3b82f6 65%, transparent);
  outline-offset: 2px;
  cursor: progress !important;
}
`
function ensureHoverStyle(): void {
  if (typeof document === 'undefined' || !document.head) return
  if (document.head.querySelector(`[${HOVER_STYLE_ATTR}="1"]`)) return
  const style = document.createElement('style')
  style.setAttribute(HOVER_STYLE_ATTR, '1')
  style.textContent = HOVER_CSS
  document.head.appendChild(style)
}
const HOVER_DELAY_MS = 160
const MIN_HOVER_TEXT_LENGTH = 4
const MAX_HOVER_TEXT_LENGTH = 2000

export interface HoverTranslatorOptions {
  readonly isEnabled: () => boolean
  readonly displayMode: () => TranslationDisplayMode
  readonly translateText: (text: string, signal: AbortSignal) => Promise<string | undefined>
}

export interface HoverTranslator {
  restoreAll(): void
  dispose(): void
}

interface HoverRecord {
  readonly changes?: readonly { node: Text; original: string; applied: string }[]
  readonly bilingualEl?: HTMLElement
}

const inlineOptions = { isExcluded: (element: Element) => !isReadableElement(element) }

function paragraphSource(block: HTMLElement) {
  if (!isReadableElement(block)) return
  let inspected = 0
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, (node) => {
    if (++inspected > 200) return NodeFilter.FILTER_ACCEPT
    if (node instanceof Element) return isReadableElement(node) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT
    return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
  })
  const first = walker.nextNode()
  if (inspected > 200 || !(first instanceof Text)) return
  const unit = inlineUnitFor(first, inlineOptions)
  if (unit && unit.block !== block) return
  if (!unit && walker.nextNode()) return
  const source = unit?.template ?? first.data
  if (source.trim().length < MIN_HOVER_TEXT_LENGTH || source.length > MAX_HOVER_TEXT_LENGTH) return
  return { first, source, unit }
}

function findHoverBlock(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined
  if (isBilingualElement(target) || isExcludedElement(target)) return undefined
  const block = target.closest(HOVER_BLOCK_SELECTOR)
  if (!(block instanceof HTMLElement)) return undefined
  if (isExcludedElement(block) || block.isContentEditable) return undefined
  return block
}

/**
 * 按住 Alt 并悬停段落时单独翻译该段落；再次 Alt + 点击该段落可立即恢复原文。
 */
export function createHoverTranslator(options: HoverTranslatorOptions): HoverTranslator {
  const translated = new Map<HTMLElement, HoverRecord>()
  let pending: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastTarget: HTMLElement | undefined
  let disposed = false

  function restoreElement(el: HTMLElement): void {
    const rec = translated.get(el)
    if (!rec) return
    translated.delete(el)
    removeBilingualNode(rec.bilingualEl)
    for (const { node, original, applied } of rec.changes ?? []) {
      if (el.contains(node) && node.data === applied) node.data = original
    }
    el.removeAttribute('data-wt-hover-translated')
  }

  async function translateBlock(el: HTMLElement): Promise<void> {
    if (disposed || !options.isEnabled() || !el.isConnected || translated.has(el)) return
    const snapshot = paragraphSource(el)
    if (!snapshot) return
    const { source, first, unit } = snapshot
    ensureHoverStyle()
    pending?.abort()
    const request = new AbortController()
    pending = request
    el.removeAttribute('data-wt-hover-preview')
    el.setAttribute('data-wt-hover-loading', '1')
    try {
      const result = await options.translateText(source.trim(), request.signal)
      if (disposed || request.signal.aborted || !el.isConnected || !options.isEnabled() || !result?.trim() || result.trim() === source.trim()) return
      const current = paragraphSource(el)
      if (!current || current.first !== first || current.source !== source || (unit && !isInlineUnitCurrent(unit, inlineOptions))) return
      const segments = unit ? parseInlineResult(result, unit) : [result.trim()]
      if (!segments) return
      if (options.displayMode() === 'bilingual') {
        const bilingualEl = attachBilingualBlock(el, unit ? inlineTranslationText(result) : result)
        if (!bilingualEl) return
        translated.set(el, { bilingualEl })
      } else {
        const changes = (unit?.nodes ?? [first]).map((node, i) => {
          const original = node.data
          const applied = unit ? segments[i]! : original.replace(/\S[\s\S]*\S|\S/, () => segments[i]!)
          return { node, original, applied }
        })
        for (const { node, applied } of changes) node.data = applied
        translated.set(el, { changes })
      }
      el.setAttribute('data-wt-hover-translated', '1')
    } finally {
      if (pending === request) pending = undefined
      el.removeAttribute('data-wt-hover-loading')
    }
  }

  function clearPreview(): void {
    clearTimeout(timer)
    timer = undefined
    lastTarget?.removeAttribute('data-wt-hover-preview')
    lastTarget = undefined
  }

  function onMouseMove(event: MouseEvent): void {
    if (!event.isTrusted) return
    const block = !disposed && event.altKey && options.isEnabled() ? findHoverBlock(event.composedPath()[0] ?? null) : undefined
    if (block === lastTarget) return
    clearPreview()
    if (!block || translated.has(block)) return
    lastTarget = block
    ensureHoverStyle()
    block.setAttribute('data-wt-hover-preview', '1')
    timer = setTimeout(() => {
      timer = undefined
      void translateBlock(block)
    }, HOVER_DELAY_MS)
  }

  function onClick(event: MouseEvent): void {
    if (disposed || !event.isTrusted || !event.altKey || !options.isEnabled()) return
    const block = findHoverBlock(event.composedPath()[0] ?? null)
    if (!block || !translated.has(block)) return
    event.preventDefault()
    event.stopPropagation()
    restoreElement(block)
  }

  function restoreAll(): void {
    clearPreview()
    pending?.abort()
    for (const el of [...translated.keys()]) {
      restoreElement(el)
    }
  }

  function dispose(): void {
    disposed = true
    restoreAll()
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keyup', onKeyUp, true)
    document.removeEventListener('mouseleave', clearPreview)
    window.removeEventListener('blur', clearPreview)
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Alt') clearPreview()
  }
  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keyup', onKeyUp, true)
  document.addEventListener('mouseleave', clearPreview)
  window.addEventListener('blur', clearPreview)

  return { restoreAll, dispose }
}
