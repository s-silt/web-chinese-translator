import { closestComposed, isExcludedElement } from './sites'
import { isSiteHost } from './intent'

export interface PageContext {
  readonly title: string
  readonly heading: string
  readonly site: string
}

export interface TranslationContext {
  readonly currentPage: PageContext
  readonly recentPages: readonly PageContext[]
}

const TITLE_MAX = 160
const HEADING_MAX = 120
const INSPECT_CAP = 200
const TIME_CAP_MS = 8

export function isReadableElement(element: Element): boolean {
  if (isExcludedElement(element)) return false
  if (element instanceof HTMLElement && element.isContentEditable) return false
  const root = element.getRootNode()
  if (root instanceof ShadowRoot && root.host.closest('[data-wt-root]') !== null) return false
  if (closestComposed(element, '[hidden],[aria-hidden="true"]') !== null) return false
  if (typeof element.checkVisibility === 'function') {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
  } else {
    let ancestor: Element | null = element
    let depth = 0
    while (ancestor !== null && depth++ < 64) {
      const style = getComputedStyle(ancestor)
      if (
        style.opacity === '0' || style.display === 'none' ||
        style.visibility === 'hidden' || style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden'
      ) return false
      const ancestorRoot = ancestor.getRootNode()
      ancestor = ancestor.parentElement ?? (ancestorRoot instanceof ShadowRoot ? ancestorRoot.host : null)
    }
    if (ancestor !== null) return false
  }
  return element.getClientRects().length > 0
}

function parentOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

function boundedText(root: Node, limit: number, textLimit: number, range?: Range): string | undefined {
  const started = performance.now()
  let inspected = 0
  let texts = 0
  let exhausted = false
  let invalid = false
  let output = ''
  const inspect = (node: Node): number => {
    if (++inspected > INSPECT_CAP || performance.now() - started >= TIME_CAP_MS) {
      exhausted = true
      return NodeFilter.FILTER_ACCEPT
    }
    if (range !== undefined) {
      try {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT
      } catch {
        invalid = true
        return NodeFilter.FILTER_ACCEPT
      }
    }
    const parent = parentOf(node)
    if (parent === null || !isReadableElement(parent)) {
      if (range !== undefined) {
        invalid = true
        return NodeFilter.FILTER_ACCEPT
      }
      return NodeFilter.FILTER_REJECT
    }
    return NodeFilter.FILTER_ACCEPT
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, inspect)
  let node: Node | null = root
  const rootState = inspect(root)
  if (rootState === NodeFilter.FILTER_REJECT) return range !== undefined ? undefined : ''
  while (node !== null) {
    if (exhausted || invalid) return range !== undefined ? undefined : output
    if (node instanceof Text) {
      if (++texts > textLimit) return range !== undefined ? undefined : output
      const start = range !== undefined && range.startContainer === node ? range.startOffset : 0
      const end = range !== undefined && range.endContainer === node ? range.endOffset : node.length
      const size = Math.max(0, end - start)
      if (range !== undefined && output.length + size > limit) return undefined
      output += node.data.slice(start, Math.min(end, start + (limit - output.length)))
      if (range === undefined && output.length >= limit) return output
    }
    node = walker.nextNode()
  }
  return output
}

export function readVisibleContext(root: Node, maxChars: number, maxTextNodes = 32): string {
  return boundedText(root, maxChars, maxTextNodes) ?? ''
}

export function readSelectionRange(range: Range, maxChars = 6000): string | undefined {
  if (range.collapsed) return undefined
  const root = range.commonAncestorContainer
  if (!root.isConnected) return undefined
  if (parentOf(range.startContainer) === null || parentOf(range.endContainer) === null) return undefined
  const text = boundedText(root, maxChars, 200, range)
  if (text === undefined) return undefined
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

export function selectionContext(range: Range, maxChars = 1200): string {
  const startParent = parentOf(range.startContainer)
  const endParent = parentOf(range.endContainer)
  if (startParent === null || endParent === null || !isReadableElement(startParent)) return ''
  if (
    range.startContainer === range.endContainer &&
    range.startContainer instanceof Text &&
    range.startContainer.length > maxChars / 2
  ) {
    const node = range.startContainer
    const start = Math.max(0, Math.min(range.startOffset - Math.floor(maxChars / 2), node.length - maxChars))
    return node.data.slice(start, start + maxChars)
  }
  const element = startParent
  const block = element.closest('p,li')
  if (block === null || !isReadableElement(block)) return ''
  return readVisibleContext(block, maxChars, 32)
}

export function collectPageContext(): PageContext {
  const title = document.title.slice(0, TITLE_MAX)
  let heading = ''
  const started = performance.now()
  let inspected = 0
  let h1Count = 0
  const filter = (node: Node): number => {
    if (++inspected > INSPECT_CAP || performance.now() - started >= TIME_CAP_MS) return NodeFilter.FILTER_ACCEPT
    const parent = parentOf(node)
    if (parent === null || !isReadableElement(parent)) return NodeFilter.FILTER_REJECT
    return NodeFilter.FILTER_ACCEPT
  }
  const body = document.body
  if (body !== null && isReadableElement(body)) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, filter)
    let node = walker.nextNode()
    while (node !== null && inspected <= INSPECT_CAP && performance.now() - started < TIME_CAP_MS) {
      if (node instanceof Element && node.tagName === 'H1') {
        h1Count += 1
        const text = readVisibleContext(node, HEADING_MAX).trim()
        if (text !== '') {
          heading = text.slice(0, HEADING_MAX)
          break
        }
        if (h1Count >= 8) break
      }
      node = walker.nextNode()
    }
  }
  return { title, heading, site: location.hostname }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPageContext(value: unknown): value is PageContext {
  if (!isRecord(value)) return false
  if (typeof value.title !== 'string' || value.title.length > TITLE_MAX) return false
  if (typeof value.heading !== 'string' || value.heading.length > HEADING_MAX) return false
  return isSiteHost(value.site)
}

export function isPageId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}
