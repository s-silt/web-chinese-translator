import { attachBilingualNode, isBilingualElement, removeBilingualNode } from './bilingual'
import type { TranslationDisplayMode } from './preferences-extra'
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
  readonly translateText: (text: string) => Promise<string | undefined>
}

export interface HoverTranslator {
  restoreAll(): void
  dispose(): void
}

interface HoverRecord {
  readonly element: HTMLElement
  readonly mode: TranslationDisplayMode
  readonly originalText?: string
  readonly bilingualEl?: HTMLElement
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
  const inFlight = new Set<HTMLElement>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastTarget: HTMLElement | undefined
  let disposed = false

  function restoreElement(el: HTMLElement): void {
    const rec = translated.get(el)
    if (!rec) return
    translated.delete(el)
    if (rec.mode === 'bilingual') {
      removeBilingualNode(rec.bilingualEl)
    } else if (rec.originalText !== undefined && el.isConnected) {
      el.textContent = rec.originalText
    }
    el.removeAttribute('data-wt-hover-translated')
  }

  async function translateBlock(el: HTMLElement): Promise<void> {
    if (disposed || !el.isConnected || translated.has(el) || inFlight.has(el)) return
    const text = (el.textContent ?? '').trim()
    if (text.length < MIN_HOVER_TEXT_LENGTH || text.length > MAX_HOVER_TEXT_LENGTH) return
    ensureHoverStyle()
    inFlight.add(el)
    el.removeAttribute('data-wt-hover-preview')
    el.setAttribute('data-wt-hover-loading', '1')
    try {
      const result = await options.translateText(text)
      if (disposed || !el.isConnected || result === undefined || result.trim() === '' || result.trim() === text) return
      const mode = options.displayMode()
      if (mode === 'bilingual') {
        const bilingualEl = attachBilingualNode(el, result)
        if (!bilingualEl) return
        translated.set(el, { element: el, mode, bilingualEl })
      } else {
        const originalText = el.textContent ?? ''
        el.textContent = result
        translated.set(el, { element: el, mode, originalText })
      }
      el.setAttribute('data-wt-hover-translated', '1')
    } finally {
      inFlight.delete(el)
      el.removeAttribute('data-wt-hover-loading')
    }
  }

  function onMouseMove(event: MouseEvent): void {
    if (disposed || !event.altKey || !options.isEnabled()) {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      lastTarget?.removeAttribute('data-wt-hover-preview')
      lastTarget = undefined
      return
    }
    const block = findHoverBlock(event.target)
    if (!block || block === lastTarget) return
    lastTarget?.removeAttribute('data-wt-hover-preview')
    lastTarget = block
    ensureHoverStyle()
    block.setAttribute('data-wt-hover-preview', '1')
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void translateBlock(block)
    }, HOVER_DELAY_MS)
  }

  function onClick(event: MouseEvent): void {
    if (disposed || !event.altKey || !options.isEnabled()) return
    const block = findHoverBlock(event.target)
    if (!block || !translated.has(block)) return
    event.preventDefault()
    event.stopPropagation()
    restoreElement(block)
  }

  function restoreAll(): void {
    for (const el of [...translated.keys()]) {
      restoreElement(el)
    }
  }

  function dispose(): void {
    disposed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    lastTarget?.removeAttribute('data-wt-hover-preview')
    lastTarget = undefined
    restoreAll()
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('click', onClick, true)
  }

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('click', onClick, true)

  return { restoreAll, dispose }
}
