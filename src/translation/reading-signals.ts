import { isReadableElement, readVisibleContext } from './reading-context'
import type { SelectionAnchor } from './selection'

export interface ReadingCandidate {
  readonly text: string
  readonly anchor: SelectionAnchor
  readonly dwellMs: number
  readonly visits: number
  readonly element: Element
}

interface VisitRecord {
  text: string
  dwellMs: number
  visits: number
  lastEnter: number
  lastLeave: number
}

interface ReadingOptions {
  readonly enabled: () => boolean
  readonly hasActiveSelection: () => boolean
  readonly isInsidePanel?: (event: Event) => boolean
  readonly onCandidate: (candidate: ReadingCandidate) => void
  readonly onInvalidate?: () => void
  readonly now?: () => number
  readonly acceptText?: (text: string) => boolean
}

const TARGET_SELECTOR = 'main p, main li, article p, article li, [role="main"] p, [role="main"] li'
const TEXT_MIN = 30
const TEXT_MAX = 1200
const COMBINED_DWELL_MS = 3500
const AWAY_MIN_MS = 800
const AWAY_MAX_MS = 30000
const MAX_CALLS_PER_PAGE = 3
const COOLDOWN_MS = 60000
const MAX_SEEN = 32
const MAX_VISIT_RECORDS = 64
const MAX_DWELL_MS = 60000

const CJK = /[㐀-鿿가-힯]/

function eligibleText(text: string, acceptText?: (text: string) => boolean): boolean {
  const trimmed = text.trim()
  if (trimmed.length < TEXT_MIN || trimmed.length > TEXT_MAX) return false
  if (acceptText !== undefined) return acceptText(trimmed)
  if (!/[a-zA-Z]/.test(trimmed)) return false
  return !CJK.test(trimmed)
}

export function watchReadingSignals(options: ReadingOptions): { dispose(): void; reset(): void } {
  const now = options.now ?? Date.now
  let visits = new WeakMap<Element, VisitRecord>()
  const visitOrder: WeakRef<Element>[] = []
  let seenTexts = new Set<string>()
  let hover: Element | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let calls = 0
  let lastCall = -Infinity
  let disposed = false

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function isEditableActive(): boolean {
    const el = document.activeElement
    if (el instanceof HTMLElement && el.isContentEditable) return true
    const tag = el?.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  }

  function gates(): boolean {
    return (
      !disposed &&
      options.enabled() &&
      calls < MAX_CALLS_PER_PAGE &&
      now() - lastCall >= COOLDOWN_MS &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      !isEditableActive() &&
      !options.hasActiveSelection()
    )
  }

  function liveText(element: Element): string {
    return readVisibleContext(element, TEXT_MAX + 1).trim()
  }

  function emit(element: Element, record: VisitRecord): void {
    const total = Math.min(MAX_DWELL_MS, record.dwellMs + Math.max(0, now() - record.lastEnter))
    if (!gates() || record.visits < 2 || total < COMBINED_DWELL_MS) return
    if (!element.isConnected || !isReadableElement(element)) return
    const text = liveText(element)
    if (text !== record.text || seenTexts.has(text)) return
    const rect = element.getBoundingClientRect()
    seenTexts.add(text)
    if (seenTexts.size > MAX_SEEN) {
      const first = seenTexts.values().next().value
      if (first !== undefined) seenTexts.delete(first)
    }
    calls += 1
    lastCall = now()
    options.onCandidate({
      text,
      anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      dwellMs: Math.trunc(total),
      visits: Math.min(record.visits, 3),
      element,
    })
  }

  function scheduleEmit(element: Element, record: VisitRecord): void {
    clearTimer()
    if (record.visits < 2 || !gates()) return
    const total = record.dwellMs + Math.max(0, now() - record.lastEnter)
    const remaining = COMBINED_DWELL_MS - total
    if (remaining <= 0) {
      emit(element, record)
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      const fresh = visits.get(element)
      if (fresh === undefined || hover !== element || !element.isConnected) return
      if (fresh.text !== liveText(element)) return
      emit(element, fresh)
    }, remaining)
  }

  function eligibleElement(element: Element): string | undefined {
    if (!element.isConnected || !isReadableElement(element)) return undefined
    const text = liveText(element)
    return eligibleText(text, options.acceptText) ? text : undefined
  }

  function onPointerOver(event: Event): void {
    if (!event.isTrusted || !gates()) return
    if (options.isInsidePanel?.(event) === true) return
    const target = event.target
    if (!(target instanceof Element)) return
    const element = target.closest(TARGET_SELECTOR)
    if (element === null || element === hover) return
    leaveHover()
    const text = eligibleElement(element)
    if (text === undefined) return
    hover = element
    const time = now()
    let record = visits.get(element) ?? { text, dwellMs: 0, visits: 0, lastEnter: time, lastLeave: -Infinity }
    if (record.text !== text || (record.visits > 0 && time - record.lastLeave > AWAY_MAX_MS)) {
      record = { text, dwellMs: 0, visits: 0, lastEnter: time, lastLeave: -Infinity }
    }
    if (record.visits === 0 || time - record.lastLeave >= AWAY_MIN_MS) {
      record.visits = Math.min(record.visits + 1, 3)
    }
    record.lastEnter = time
    if (!visits.has(element)) {
      visitOrder.push(new WeakRef(element))
      if (visitOrder.length > MAX_VISIT_RECORDS) {
        const oldest = visitOrder.shift()?.deref()
        if (oldest !== undefined) visits.delete(oldest)
      }
    }
    visits.set(element, record)
    scheduleEmit(element, record)
  }

  function leaveHover(): void {
    if (hover === undefined) return
    const record = visits.get(hover)
    if (record !== undefined) {
      record.dwellMs = Math.min(MAX_DWELL_MS, record.dwellMs + Math.max(0, now() - record.lastEnter))
      record.lastLeave = now()
    }
    hover = undefined
    clearTimer()
  }

  function onPointerOut(event: Event): void {
    if (!event.isTrusted || hover === undefined) return
    const related = (event as PointerEvent).relatedTarget
    if (related instanceof Node && hover.contains(related)) return
    leaveHover()
  }

  function onInvalidate(event?: Event): void {
    if (event !== undefined && options.isInsidePanel?.(event) === true) return
    leaveHover()
    options.onInvalidate?.()
  }

  const onScroll = (e: Event): void => onInvalidate(e)
  const onBlur = (): void => onInvalidate()
  const onHide = (): void => onInvalidate()
  const onKey = (e: Event): void => {
    if (options.hasActiveSelection()) return
    onInvalidate(e)
  }

  document.addEventListener('pointerover', onPointerOver, true)
  document.addEventListener('pointerout', onPointerOut, true)
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('pagehide', onHide)
  document.addEventListener('visibilitychange', onHide)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      leaveHover()
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    },
    reset() {
      leaveHover()
      visits = new WeakMap()
      visitOrder.length = 0
      seenTexts = new Set()
      calls = 0
      lastCall = -Infinity
    },
  }
}
