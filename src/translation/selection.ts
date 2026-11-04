import { readSelectionRange } from './reading-context'
import type { SourceLanguage } from './target-language'

export interface SelectionAnchor {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface SelectionWatcher {
  dispose(): void
  dismiss(): void
}

interface WatchOptions {
  enabled: () => boolean
  onSelect: (text: string, anchor: SelectionAnchor, method: 'mouse' | 'keyboard', stillValid: () => boolean) => void
  onDismiss: () => void
  isInsidePanel: (event: Event) => boolean
  acceptText?: (text: string) => boolean
  focusToolbar?: () => boolean
}

const DEBOUNCE_MS = 350
const MAX_TEXT = 6000

const CJK = /[㐀-鿿가-힯]/

export function isAssistanceCandidateText(text: string, source: SourceLanguage = 'auto'): boolean {
  return source === 'auto'
    ? /[a-zA-Z]/.test(text) && !/[㐀-鿿가-힯]/.test(text)
    : /\p{L}/u.test(text)
}

export interface ManualSelectionSnapshot {
  readonly url: string
  readonly focused: boolean
  readonly text: string
  readonly frameFocused: boolean
}

export function readManualSelection(requireFocus = true): ManualSelectionSnapshot {
  const url = typeof location?.href === 'string' ? location.href : ''
  const inExtensionRoot = (node: Node | null): boolean => {
    let cur: Node | null = node
    for (let depth = 0; depth < 64 && cur !== null; depth += 1) {
      if (cur instanceof Element && cur.closest('[data-wt-root]') !== null) return true
      const root = cur.getRootNode()
      cur = root instanceof ShadowRoot ? root.host : cur.parentNode
    }
    return false
  }
  let active: Element | null = document.activeElement
  for (let depth = 0; depth < 64 && active !== null; depth += 1) {
    const next = active.shadowRoot?.activeElement ?? null
    if (next === null || next === active) break
    active = next
  }
  const tag = active?.tagName?.toUpperCase() ?? ''
  const frameFocused = tag === 'IFRAME' || tag === 'FRAME'
  const focused = document.hasFocus() && !frameFocused
  if (frameFocused || (requireFocus && !focused) || inExtensionRoot(active)) {
    return { url, focused, text: '', frameFocused }
  }
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active instanceof HTMLInputElement && active.type.toLowerCase() === 'password') {
      return { url, focused, text: '', frameFocused }
    }
    const start = active.selectionStart
    const end = active.selectionEnd
    const raw =
      typeof start === 'number' && typeof end === 'number' && end > start
        ? active.value.slice(start, end).trim()
        : ''
    return { url, focused, text: raw.slice(0, 6001), frameFocused }
  }
  const selection = window.getSelection()
  if (
    selection === null ||
    selection.rangeCount === 0 ||
    inExtensionRoot(selection.anchorNode) ||
    inExtensionRoot(selection.focusNode)
  ) {
    return { url, focused, text: '', frameFocused }
  }
  return { url, focused, text: selection.toString().trim().slice(0, 6001), frameFocused }
}

export function readSelectionText(): string {
  return readManualSelection(false).text
}

function candidateText(text: string, acceptText?: (text: string) => boolean): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_TEXT) return undefined
  if (acceptText !== undefined) return acceptText(trimmed) ? trimmed : undefined
  if (!/[a-zA-Z]/.test(trimmed)) return undefined
  if (CJK.test(trimmed)) return undefined
  return trimmed
}

function anchorFromRange(range: Range): SelectionAnchor | undefined {
  const whole = range.getBoundingClientRect()
  const rect =
    whole.width > 0 || whole.height > 0
      ? whole
      : [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0)
  if (rect === undefined || (rect.width === 0 && rect.height === 0)) return undefined
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

interface Snapshot {
  readonly range: Range
  readonly text: string
  readonly anchor: SelectionAnchor
  readonly method: 'mouse' | 'keyboard'
  readonly startNode: Node
  readonly endNode: Node
  readonly startOffset: number
  readonly endOffset: number
}

function isEditableContainer(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement
  if (el === null) return true
  return el.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') !== null
}

export function watchSelection(options: WatchOptions): SelectionWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Snapshot | undefined
  let active: Snapshot | undefined
  let panelInteraction = false
  let disposed = false

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    pending = undefined
  }

  function stillValid(snapshot: Snapshot): () => boolean {
    return () => {
      if (disposed) return false
      if (!snapshot.startNode.isConnected || !snapshot.endNode.isConnected) return false
      return readSelectionRange(snapshot.range, MAX_TEXT) === snapshot.text
    }
  }

  function matchesCurrent(snapshot: Snapshot): boolean {
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    return (
      range.startContainer === snapshot.startNode &&
      range.endContainer === snapshot.endNode &&
      range.startOffset === snapshot.startOffset &&
      range.endOffset === snapshot.endOffset &&
      readSelectionRange(range, MAX_TEXT) === snapshot.text
    )
  }

  function capture(method: 'mouse' | 'keyboard'): void {
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return
    const live = selection.getRangeAt(0)
    const focused = document.activeElement
    if (focused !== null && isEditableContainer(focused)) return
    if (isEditableContainer(live.startContainer) || isEditableContainer(live.endContainer)) return
    const range = live.cloneRange()
    const text = candidateText(readSelectionRange(range, MAX_TEXT) ?? '', options.acceptText)
    if (text === undefined) return
    const anchor = anchorFromRange(range)
    if (anchor === undefined) return
    pending = {
      range,
      text,
      anchor,
      method,
      startNode: live.startContainer,
      endNode: live.endContainer,
      startOffset: live.startOffset,
      endOffset: live.endOffset,
    }
  }

  function evaluate(): void {
    timer = undefined
    const snapshot = pending
    pending = undefined
    if (disposed || !options.enabled() || snapshot === undefined) return
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return
    const focused = document.activeElement
    if (focused !== null && isEditableContainer(focused)) return
    if (!matchesCurrent(snapshot) || !stillValid(snapshot)()) return
    active = snapshot
    options.onSelect(snapshot.text, snapshot.anchor, snapshot.method, stillValid(snapshot))
  }

  function schedule(method: 'mouse' | 'keyboard'): void {
    cancelTimer()
    capture(method)
    if (pending === undefined) return
    timer = setTimeout(evaluate, DEBOUNCE_MS)
  }

  function invalidate(): void {
    cancelTimer()
    if (active !== undefined) {
      active = undefined
      options.onDismiss()
    }
  }

  function onPointerDown(event: Event): void {
    if (options.isInsidePanel(event)) {
      panelInteraction = true
      return
    }
    panelInteraction = false
    invalidate()
  }

  function onPointerUp(event: Event): void {
    if (!event.isTrusted || options.isInsidePanel(event)) return
    panelInteraction = false
    if (event instanceof MouseEvent && event.button !== 0) return
    schedule('mouse')
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (options.isInsidePanel(event)) {
      panelInteraction = true
      if (event.key === 'Escape') invalidate()
      return
    }
    // 卡片不可聚焦：在卡片里选中译文后按 Ctrl/⌘+C，按键落在页面上，但这是在复制卡片内容，不能关掉卡片。
    // 先到的是 Control/Meta 本身的 keydown，同样放过；Shift、Alt 仍按页面按键处理，之后的键盘选区才能触发
    if (
      panelInteraction &&
      (event.key === 'Control' || event.key === 'Meta' ||
        ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c'))
    ) {
      return
    }
    panelInteraction = false
    if (
      event.isTrusted &&
      event.key === 'Tab' &&
      !event.shiftKey &&
      active !== undefined &&
      options.focusToolbar?.()
    ) {
      event.preventDefault()
      panelInteraction = true
      return
    }
    invalidate()
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (!event.isTrusted || panelInteraction) return
    if (event.key === 'Shift' || event.shiftKey || event.key.startsWith('Arrow')) schedule('keyboard')
  }

  function onSelectionChange(): void {
    if (panelInteraction) return
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed) {
      invalidate()
      return
    }
    const snapshot = pending ?? active
    if (snapshot !== undefined && !matchesCurrent(snapshot)) invalidate()
  }

  function onScroll(event: Event): void {
    if (options.isInsidePanel(event)) return
    invalidate()
  }

  function onCopy(event: Event): void {
    if (panelInteraction || options.isInsidePanel(event)) return
    invalidate()
  }

  function onBlur(): void {
    invalidate()
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('keyup', onKeyUp, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('copy', onCopy, true)
  document.addEventListener('cut', onCopy, true)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onBlur)
  window.addEventListener('blur', onBlur)
  window.addEventListener('pagehide', onBlur)
  document.addEventListener('visibilitychange', onBlur)
  document.addEventListener('selectionchange', onSelectionChange)

  const removers = [
    () => document.removeEventListener('pointerdown', onPointerDown, true),
    () => document.removeEventListener('pointerup', onPointerUp, true),
    () => document.removeEventListener('keyup', onKeyUp, true),
    () => document.removeEventListener('keydown', onKeyDown, true),
    () => document.removeEventListener('copy', onCopy, true),
    () => document.removeEventListener('cut', onCopy, true),
    () => document.removeEventListener('scroll', onScroll, true),
    () => window.removeEventListener('resize', onBlur),
    () => window.removeEventListener('blur', onBlur),
    () => window.removeEventListener('pagehide', onBlur),
    () => document.removeEventListener('visibilitychange', onBlur),
    () => document.removeEventListener('selectionchange', onSelectionChange),
  ]

  return {
    dispose() {
      if (disposed) return
      disposed = true
      cancelTimer()
      active = undefined
      panelInteraction = false
      for (const remove of removers) remove()
    },
    dismiss() {
      cancelTimer()
      active = undefined
      panelInteraction = false
    },
  }
}
