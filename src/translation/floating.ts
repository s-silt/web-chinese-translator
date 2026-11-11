import type { UiStyle } from '../shared/settings'
import { applySurfacePreferences, SURFACE_CSS, syncSurfaceVisibility } from './ui-surface'

export interface FloatingPosition {
  readonly side: 'left' | 'right'
  readonly ratio: number
  readonly collapsed: boolean
}

export interface FloatingView {
  readonly visible: boolean
  readonly hostname: string
  readonly fixedOn: boolean
  readonly autoEnabled: boolean
  readonly pageOn?: boolean
  readonly configured: boolean
  readonly restored: boolean
  readonly canRestore: boolean
  readonly resumable: boolean
  readonly busy: boolean
  readonly checking: boolean
  readonly error: string
}

export type FloatingAction = 'translate-page' | 'toggle-auto' | 'restore' | 'resume' | 'settings' | 'text-window'

export interface FloatingLabels {
  readonly title: string
  readonly open: string
  readonly expand: string
  readonly close: string
  readonly move: string
  readonly translatePage: string
  readonly enable: string
  readonly disable: string
  readonly autoTranslate?: string
  readonly fold: string
  readonly disclosure: string
  readonly consent: string
  readonly confirm: string
  readonly cancel: string
  readonly restore: string
  readonly resume: string
  readonly settings: string
  readonly textTranslate: string
  readonly configure: string
  readonly fixedOn: string
  readonly modelOn: string
  readonly modelOff: string
  readonly pageOn: string
  readonly restored: string
  readonly paused: string
  readonly loading: string
  readonly positionFailed: string
}

export interface FloatingCallbacks {
  readonly imageUrl: string
  readonly readPosition: () => Promise<unknown>
  readonly writePosition: (position: FloatingPosition) => Promise<void>
  readonly onOpen: () => void
  readonly onAction: (action: FloatingAction) => void
}

export interface FloatingEntry {
  update(view: FloatingView, labels: FloatingLabels, callbacks: FloatingCallbacks): void
  setStyle(style: UiStyle): void
  closeMenu(returnFocus?: boolean): void
  isMenuOpen(): boolean
  reposition(): void
  getAnchor(): FloatingAnchor | undefined
  setNoticeVisible(visible: boolean): void
  dispose(): void
}

export interface FloatingAnchor {
  readonly side: 'left' | 'right'
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

const BUTTON = 40
const MARGIN = 12
const AVOID = 6
const VISIBLE_COLLAPSED = 20
const DRAG_PX = 5
const NUDGE_PX = 20
const MENU_MAX = 232
const AUTO_DOCK_MS = 900

const DEFAULT_POSITION: FloatingPosition = { side: 'right', ratio: 0.5, collapsed: true }

const FLOATING_CSS = `${SURFACE_CSS}
.floating-entry, .floating-menu { --wt-floating-scale: 1; box-sizing: border-box; font: calc(13px / var(--wt-floating-scale))/1.5 var(--gcn-font); color: var(--gcn-fg); background: var(--gcn-surface); border: 1px solid var(--gcn-surface-border); box-shadow: var(--gcn-shadow-overlay); }
.floating-entry { position: fixed; z-index: 2147483647; display: flex; align-items: center; justify-content: center; width: calc(${BUTTON}px / var(--wt-floating-scale)); height: calc(${BUTTON}px / var(--wt-floating-scale)); padding: 0; border-radius: calc(14px / var(--wt-floating-scale)); cursor: pointer; pointer-events: auto; touch-action: none; }
.floating-entry:hover { background: var(--gcn-btn-hover-bg); border-color: var(--gcn-border-emphasis); }
.floating-entry img { width: calc(38px / var(--wt-floating-scale)); height: calc(38px / var(--wt-floating-scale)); border-radius: calc(9px / var(--wt-floating-scale)); pointer-events: none; }
.floating-entry.is-dragging { transition: none; }
.floating-menu { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; gap: calc(8px / var(--wt-floating-scale)); width: calc(${MENU_MAX}px / var(--wt-floating-scale)); padding: calc(12px / var(--wt-floating-scale)); border-radius: calc(12px / var(--wt-floating-scale)); pointer-events: auto; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; overflow-wrap: anywhere; }
:host([data-style='glass']) .floating-menu, :host([data-style='glass']) .floating-entry { backdrop-filter: blur(var(--gcn-surface-blur)); -webkit-backdrop-filter: blur(var(--gcn-surface-blur)); }
/* 类选择器的 display 会盖过浏览器默认的 [hidden]{display:none}：hidden 时必须显式不渲染，否则会挡住页面点击 */
.floating-menu[hidden], .floating-consent[hidden], .floating-menu [hidden] { display: none !important; }
.floating-head { display: grid; grid-template-columns: calc(24px / var(--wt-floating-scale)) minmax(0,1fr) calc(28px / var(--wt-floating-scale)); align-items: center; gap: calc(8px / var(--wt-floating-scale)); }
.floating-brand { grid-column: 1; grid-row: 1; width: calc(24px / var(--wt-floating-scale)); height: calc(24px / var(--wt-floating-scale)); border-radius: calc(6px / var(--wt-floating-scale)); }
.floating-title { grid-column: 2; grid-row: 1; min-width: 0; font-size: calc(13px / var(--wt-floating-scale)); font-weight: 600; line-height: 1.5; text-wrap: balance; }
.floating-host { grid-column: 1 / -1; }
/* 深色底上的辅助说明不能沿用浅色主题的灰字（对比度不足） */
.floating-host, .floating-disclosure, .floating-fixed, .floating-reason { margin: 0; color: var(--gcn-fg-muted); font-size: calc(12px / var(--wt-floating-scale)); line-height: 1.5; }
.floating-error { color: var(--gcn-danger-fg); font-size: calc(12px / var(--wt-floating-scale)); line-height: 1.5; }
.floating-actions-main, .floating-actions-sub { display: grid; gap: calc(6px / var(--wt-floating-scale)); }
.floating-menu button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-height: calc(var(--gcn-control-md) / var(--wt-floating-scale)); min-width: 0; padding: calc(6px / var(--wt-floating-scale)) calc(10px / var(--wt-floating-scale)); font: inherit; font-size: calc(12px / var(--wt-floating-scale)); font-weight: 500; line-height: 1.5; text-align: center; white-space: normal; overflow-wrap: anywhere; color: var(--gcn-btn-fg); background: var(--gcn-btn-bg); border: 1px solid var(--gcn-btn-border); border-radius: calc(var(--gcn-radius) / var(--wt-floating-scale)); cursor: pointer; }
.floating-menu button:hover:not(:disabled,[aria-disabled='true']) { background: var(--gcn-btn-hover-bg); border-color: var(--gcn-border-emphasis); }
.floating-menu .floating-primary, .floating-menu[data-style] .floating-primary { color: var(--gcn-primary-fg); background: var(--gcn-primary-bg); border-color: var(--gcn-primary-border); font-weight: 600; }
.floating-menu .floating-primary:hover:not(:disabled,[aria-disabled='true']) { background: var(--gcn-primary-hover-bg); }
.floating-menu .floating-close { grid-column: 3; grid-row: 1; min-height: calc(28px / var(--wt-floating-scale)); width: calc(28px / var(--wt-floating-scale)); padding: 0; color: var(--gcn-fg-muted); background: transparent; border-color: var(--gcn-border); }
.floating-menu .floating-auto { justify-content: space-between; gap: calc(8px / var(--wt-floating-scale)); padding-left: 0; padding-right: 0; text-align: start; background: transparent; border-color: transparent; }
.floating-auto::after { content: ''; flex: none; box-sizing: border-box; width: calc(32px / var(--wt-floating-scale)); height: calc(18px / var(--wt-floating-scale)); border: 1px solid var(--gcn-border); border-radius: calc(12px / var(--wt-floating-scale)); background: radial-gradient(circle at calc(8px / var(--wt-floating-scale)) 50%, var(--gcn-knob) 0 calc(6px / var(--wt-floating-scale)), transparent calc(6.5px / var(--wt-floating-scale))), var(--gcn-switch-off); }
.floating-auto[aria-checked='true']::after { background: radial-gradient(circle at calc(22px / var(--wt-floating-scale)) 50%, var(--gcn-knob) 0 calc(6px / var(--wt-floating-scale)), transparent calc(6.5px / var(--wt-floating-scale))), var(--gcn-switch-on); }
@media (forced-colors: active) {
  .floating-auto::after { forced-color-adjust: none; --gcn-knob: ButtonText; --gcn-switch-off: Canvas; border-color: ButtonText; }
  .floating-auto[aria-checked='true']::after { --gcn-knob: HighlightText; --gcn-switch-on: Highlight; border-color: Highlight; }
  .floating-auto:disabled::after { --gcn-knob: GrayText; border-color: GrayText; }
  .floating-auto[aria-checked='true']:disabled::after { --gcn-knob: Canvas; --gcn-switch-on: GrayText; }
}
/* 主题的主按钮配色比通用禁用规则更具体：禁用态要单独压回灰色，否则未配置模型时仍像可点 */
.floating-menu button:disabled, .floating-menu button[aria-disabled='true'], .floating-menu .floating-primary:disabled, .floating-menu .floating-primary[aria-disabled='true'] { color: var(--gcn-fg-disabled); background: var(--gcn-bg-disabled); border-color: var(--gcn-border); cursor: default; }
/* 空间不够时菜单会压在入口上：此时入口让位（仍可聚焦，Escape 能把焦点还回来） */
.floating-entry.is-covered { opacity: 0; pointer-events: none; }
.floating-move { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
`

interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface Viewport {
  readonly width: number
  readonly height: number
  readonly scale: number
}

interface Drag {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly originLeft: number
  readonly originTop: number
  readonly origin: FloatingPosition
  moved: boolean
  readonly onMove: (event: PointerEvent) => void
  readonly onUp: (event: PointerEvent) => void
  readonly onCancel: (event: PointerEvent) => void
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function readPosition(value: unknown): FloatingPosition {
  if (!isPlainObject(value)) return DEFAULT_POSITION
  const side = value.side
  const ratio = value.ratio
  const collapsed = value.collapsed
  if (
    (side !== 'left' && side !== 'right') ||
    typeof ratio !== 'number' ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1 ||
    typeof collapsed !== 'boolean'
  ) {
    return DEFAULT_POSITION
  }
  return { side, ratio, collapsed: true }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

export function createFloatingEntry(
  shadow: ShadowRoot,
  geometry: {
    viewport(): Viewport
    avoidRects(): readonly Rect[]
    onPosition?(): void
  },
): FloatingEntry {
  const style = document.createElement('style')
  style.textContent = FLOATING_CSS
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.className = 'floating-entry'
  entry.setAttribute('aria-expanded', 'false')
  const image = document.createElement('img')
  image.alt = ''
  image.draggable = false
  entry.append(image)
  const menu = document.createElement('div')
  menu.className = 'floating-menu'
  menu.id = 'wt-floating-menu'
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-modal', 'false')
  menu.hidden = true
  const head = document.createElement('div')
  head.className = 'floating-head'
  const brand = document.createElement('img')
  brand.className = 'floating-brand'
  brand.alt = ''
  brand.width = 24
  brand.height = 24
  const title = document.createElement('div')
  title.className = 'floating-title'
  title.id = 'wt-floating-title'
  menu.setAttribute('aria-labelledby', title.id)
  const hostname = document.createElement('div')
  hostname.className = 'floating-host'
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'floating-close'
  closeButton.textContent = '×'
  head.append(brand, title, hostname, closeButton)
  const statusFixed = document.createElement('div')
  statusFixed.className = 'floating-fixed'
  const disclosure = document.createElement('p')
  disclosure.className = 'floating-disclosure'
  const mainActions = document.createElement('div')
  mainActions.className = 'floating-actions-main'
  const translateButton = document.createElement('button')
  translateButton.type = 'button'
  translateButton.className = 'floating-translate floating-primary'
  const primary = document.createElement('button')
  primary.type = 'button'
  primary.className = 'floating-auto'
  primary.setAttribute('role', 'switch')
  const pageButton = document.createElement('button')
  pageButton.type = 'button'
  pageButton.className = 'floating-page'
  const resumeButton = document.createElement('button')
  resumeButton.type = 'button'
  resumeButton.className = 'floating-resume'
  mainActions.append(translateButton, pageButton, resumeButton, primary)
  const subActions = document.createElement('div')
  subActions.className = 'floating-actions-sub'
  const settingsButton = document.createElement('button')
  settingsButton.type = 'button'
  settingsButton.className = 'floating-settings'
  subActions.append(settingsButton, statusFixed)
  const textButton = document.createElement('button')
  textButton.type = 'button'
  textButton.className = 'floating-text'
  const error = document.createElement('div')
  const disabledReason = document.createElement('p')
  disabledReason.id = 'wt-floating-disabled-reason'
  disabledReason.className = 'floating-reason'
  disabledReason.hidden = true
  error.className = 'floating-error'
  error.setAttribute('role', 'status')
  menu.append(head, mainActions, disclosure, textButton, subActions, error, disabledReason)
  const move = document.createElement('p')
  move.className = 'floating-move'
  move.id = 'wt-floating-move'
  entry.setAttribute('aria-controls', menu.id)
  entry.setAttribute('aria-describedby', move.id)
  shadow.append(style, entry, menu, move)

  let position = DEFAULT_POSITION
  let view: FloatingView | undefined
  let labels: FloatingLabels | undefined
  let callbacks: FloatingCallbacks | undefined
  let imageUrl = ''
  let disposed = false
  let dirty = false
  let readStarted = false
  let readEpoch = 0
  let menuOpen = false
  let hovered = false
  let noticeVisible = false
  let dockTimer: ReturnType<typeof setTimeout> | undefined
  let positionFailed = false
  let suppressClick = false
  let drag: Drag | undefined
  let raf = 0
  let writing = false
  let pendingWrite: FloatingPosition | undefined
  let focusReturn: HTMLButtonElement | undefined
  let viewport: Viewport = { width: 1, height: 1, scale: 1 }
  const menuObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reposition()) : undefined

  function clearDockTimer(): void {
    if (dockTimer !== undefined) clearTimeout(dockTimer)
    dockTimer = undefined
  }

  function keepExpanded(): boolean {
    return menuOpen || hovered || noticeVisible || drag !== undefined || entry.matches(':focus-visible')
  }

  function expandEntry(): void {
    clearDockTimer()
    if (!position.collapsed) return
    position = { ...position, collapsed: false }
    place()
    render()
  }

  function scheduleDock(): void {
    clearDockTimer()
    if (disposed || document.hidden || position.collapsed || keepExpanded()) return
    dockTimer = setTimeout(() => {
      dockTimer = undefined
      if (disposed || document.hidden || keepExpanded()) return
      position = { ...position, collapsed: true }
      place()
      render()
    }, AUTO_DOCK_MS)
  }

  function onPointerEnter(event: PointerEvent): void {
    if (!trusted(event) || event.pointerType === 'touch') return
    hovered = true
    expandEntry()
  }

  function onPointerLeave(event: PointerEvent): void {
    if (!event.isTrusted) return
    hovered = false
    scheduleDock()
  }

  function onFocusIn(): void {
    if (!disposed) expandEntry()
  }

  function onFocusOut(): void {
    // focus-visible still refers to the old target during focusout.
    queueMicrotask(() => {
      if (!disposed) scheduleDock()
    })
  }

  function scaleOf(next: Viewport): number {
    return next.scale > 0 && Number.isFinite(next.scale) ? next.scale : 1
  }

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text
  }

  function setHidden(node: HTMLElement, hidden: boolean): void {
    if (node.hidden !== hidden) node.hidden = hidden
  }

  function sameView(next: FloatingView): boolean {
    const current = view
    return (
      current !== undefined &&
      current.visible === next.visible &&
      current.hostname === next.hostname &&
      current.fixedOn === next.fixedOn &&
      current.autoEnabled === next.autoEnabled &&
      current.pageOn === next.pageOn &&
      current.configured === next.configured &&
      current.restored === next.restored &&
      current.canRestore === next.canRestore &&
      current.resumable === next.resumable &&
      current.busy === next.busy &&
      current.checking === next.checking &&
      current.error === next.error
    )
  }

  function sameLabels(next: FloatingLabels): boolean {
    const current = labels
    if (current === undefined) return false
    const keys = Object.keys(next) as (keyof FloatingLabels)[]
    return keys.every((key) => current[key] === next[key])
  }

  function setActionDisabled(button: HTMLButtonElement, disabled: boolean): void {
    if (disabled && menuOpen && shadow.activeElement === button) {
      focusReturn = button
      closeButton.focus({ preventScroll: true })
    }
    button.disabled = disabled
  }

  function setActionHidden(button: HTMLButtonElement, hidden: boolean): void {
    if (hidden && menuOpen && shadow.activeElement === button) closeButton.focus({ preventScroll: true })
    setHidden(button, hidden)
  }

  function restoreActionFocus(): void {
    const target = focusReturn
    if (target === undefined) return
    if (!menuOpen || shadow.activeElement !== closeButton) {
      focusReturn = undefined
      return
    }
    if (target.disabled) return
    focusReturn = undefined
    if (!target.hidden) target.focus({ preventScroll: true })
  }

  function render(): void {
    if (view === undefined || labels === undefined) return
    setText(title, labels.title)
    setText(hostname, view.hostname)
    setText(move, labels.move)
    setText(disclosure, labels.disclosure)
    setText(statusFixed, view.fixedOn ? labels.fixedOn : '')
    setHidden(statusFixed, !view.fixedOn || view.checking)
    setText(translateButton, view.configured ? labels.translatePage : labels.configure)
    setActionDisabled(translateButton, view.busy || view.checking)
    if (view.busy) translateButton.setAttribute('aria-disabled', 'true')
    else translateButton.removeAttribute('aria-disabled')
    setText(primary, labels.autoTranslate ?? labels.enable)
    primary.setAttribute('aria-checked', String(view.autoEnabled))
    setActionDisabled(primary, (!view.configured && !view.autoEnabled) || view.checking || view.busy)
    if (view.busy) primary.setAttribute('aria-disabled', 'true')
    else primary.removeAttribute('aria-disabled')
    setText(pageButton, labels.restore)
    setActionDisabled(pageButton, !view.canRestore || view.checking || view.busy)
    setActionHidden(pageButton, !view.canRestore || view.restored)
    if (view.busy) pageButton.setAttribute('aria-disabled', 'true')
    else pageButton.removeAttribute('aria-disabled')
    setText(resumeButton, labels.resume)
    setActionDisabled(resumeButton, !view.resumable || view.checking || view.busy)
    setActionHidden(resumeButton, !view.resumable)
    if (view.busy) resumeButton.setAttribute('aria-disabled', 'true')
    else resumeButton.removeAttribute('aria-disabled')
    setText(textButton, labels.textTranslate)
    setText(settingsButton, labels.settings)
    const busyTitle = view.busy ? labels.loading : ''
    for (const button of [textButton, settingsButton]) {
      setActionDisabled(button, view.busy)
      if (view.busy) button.setAttribute('aria-disabled', 'true')
      else button.removeAttribute('aria-disabled')
      button.title = busyTitle
    }
    setText(disabledReason, view.busy || view.checking ? labels.loading : labels.configure)
    setHidden(disabledReason, !view.busy && !view.checking)
    for (const button of [translateButton, primary, pageButton, resumeButton, textButton, settingsButton]) {
      if (button.disabled && !button.hidden) button.setAttribute('aria-describedby', disabledReason.id)
      else button.removeAttribute('aria-describedby')
    }
    menu.setAttribute('aria-busy', String(view.busy || view.checking))
    closeButton.setAttribute('aria-label', labels.close)
    const errorText = [positionFailed ? labels.positionFailed : '', view.error].filter((item) => item !== '').join('\n')
    setText(error, errorText)
    setHidden(error, errorText === '')
    restoreActionFocus()
    const entryLabel = position.collapsed ? labels.expand : menuOpen ? labels.close : labels.open
    if (entry.getAttribute('aria-label') !== entryLabel) entry.setAttribute('aria-label', entryLabel)
    entry.setAttribute('aria-expanded', menuOpen ? 'true' : 'false')
    if (!view.visible) {
      entry.style.visibility = 'hidden'
      entry.tabIndex = -1
      closeMenu(false)
    }
  }

  function trusted(event: Event): boolean {
    return event.isTrusted && !disposed && view?.visible === true
  }

  function blocked(button: HTMLButtonElement): boolean {
    return button.disabled || button.getAttribute('aria-disabled') === 'true'
  }

  function openMenu(keyboard: boolean): void {
    if (callbacks === undefined || menuOpen || disposed) return
    callbacks.onOpen()
    if (disposed) return
    menuOpen = true
    expandEntry()
    menu.hidden = false
    entry.setAttribute('aria-expanded', 'true')
    if (labels !== undefined && view !== undefined) {
      const entryLabel = position.collapsed ? labels.expand : labels.close
      entry.setAttribute('aria-label', entryLabel)
    }
    menuObserver?.observe(menu)
    place()
    if (keyboard) {
      const target = [translateButton, primary, pageButton, resumeButton, textButton, settingsButton, closeButton].find((button) => !button.hidden && !blocked(button))
      target?.focus({ preventScroll: true })
    }
  }

  function closeMenu(returnFocus = false): void {
    if (!menuOpen && menu.hidden) {
      if (returnFocus) entry.focus({ preventScroll: true })
      return
    }
    menuOpen = false
    focusReturn = undefined
    menu.hidden = true
    entry.classList.remove('is-covered')
    menuObserver?.unobserve(menu)
    entry.setAttribute('aria-expanded', 'false')
    if (labels !== undefined) entry.setAttribute('aria-label', position.collapsed ? labels.expand : labels.open)
    if (returnFocus) entry.focus({ preventScroll: true })
    scheduleDock()
    geometry.onPosition?.()
  }

  function buttonBox(left: number, top: number, size: number): Rect {
    return { left, top, right: left + size, bottom: top + size }
  }

  function restedY(next: Viewport, size: number, margin: number): number {
    const min = margin
    const max = next.height - size - margin
    if (max < min) return clamp(0, 0, Math.max(0, next.height - size))
    return min + (max - min) * position.ratio
  }

  function dockX(next: Viewport, size: number, collapsed: boolean): number {
    const scale = scaleOf(next)
    if (collapsed) {
      return position.side === 'left' ? -(BUTTON - VISIBLE_COLLAPSED) / scale : next.width - VISIBLE_COLLAPSED / scale
    }
    return position.side === 'left' ? 0 : Math.max(0, next.width - size)
  }

  function avoidY(preferred: number, size: number, next: Viewport, margin: number): number | undefined {
    const scale = scaleOf(next)
    const gap = AVOID / scale
    const obstacles = geometry.avoidRects().map((rect) => ({
      left: rect.left - gap,
      top: rect.top - gap,
      right: rect.right + gap,
      bottom: rect.bottom + gap,
    }))
    const min = Math.min(margin, Math.max(0, next.height - size))
    const max = Math.max(min, next.height - size - (next.height - size >= margin * 2 ? margin : 0))
    const candidates = [preferred]
    for (const rect of obstacles) {
      candidates.push(rect.top - size - gap, rect.bottom + gap)
    }
    let best: number | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const top = clamp(candidate, 0, Math.max(0, next.height - size))
      if (top < min - 0.5 || top > max + 0.5) continue
      const box = buttonBox(dockX(next, size, position.collapsed), top, size)
      if (obstacles.some((rect) => intersects(box, rect))) continue
      const distance = Math.abs(top - preferred)
      if (distance < bestDistance) {
        best = top
        bestDistance = distance
      }
    }
    return best
  }

  function place(): void {
    if (disposed || drag !== undefined) return
    viewport = geometry.viewport()
    const scale = scaleOf(viewport)
    const size = BUTTON / scale
    const margin = MARGIN / scale
    const scaleText = String(scale)
    entry.style.setProperty('--wt-floating-scale', scaleText)
    menu.style.setProperty('--wt-floating-scale', scaleText)
    if (view?.visible === false) {
      entry.style.visibility = 'hidden'
      entry.tabIndex = -1
      geometry.onPosition?.()
      return
    }
    const preferred = restedY(viewport, size, margin)
    const y = avoidY(preferred, size, viewport, margin)
    if (y === undefined) {
      // 入口没有可用位置时一并收起菜单，不让菜单孤零零留在旧坐标
      entry.style.visibility = 'hidden'
      entry.tabIndex = -1
      if (menuOpen) closeMenu(false)
      geometry.onPosition?.()
      return
    }
    entry.style.visibility = 'visible'
    entry.tabIndex = 0
    entry.style.left = `${dockX(viewport, size, position.collapsed)}px`
    entry.style.top = `${y}px`
    placeMenu(scale, size, margin)
    geometry.onPosition?.()
  }

  function placeMenu(scale: number, size: number, margin: number): void {
    if (!menuOpen) return
    const maxWidth = Math.max(1, Math.min(MENU_MAX / scale, viewport.width - margin * 2))
    const maxHeight = Math.max(1, viewport.height - margin * 2)
    menu.style.maxWidth = `${maxWidth}px`
    menu.style.maxHeight = `${maxHeight}px`
    const rect = menu.getBoundingClientRect()
    const width = rect.width / scale || maxWidth
    const height = rect.height / scale || maxHeight
    const left = Number.parseFloat(entry.style.left) || 0
    const top = Number.parseFloat(entry.style.top) || 0
    const gap = AVOID / scale
    const inner = position.side === 'right'
      ? { left: left - width - gap, top }
      : { left: left + size + gap, top }
    const other = position.side === 'right'
      ? { left: left + size + gap, top }
      : { left: left - width - gap, top }
    const candidates = [inner, other, { left, top: top - height - gap }, { left, top: top + size + gap }]
    const obstacles = geometry.avoidRects()
    let chosen = candidates[0]!
    let chosenOverlap = Number.POSITIVE_INFINITY
    let foundClear = false
    for (const candidate of candidates) {
      const box = {
        left: clamp(candidate.left, margin, Math.max(margin, viewport.width - width - margin)),
        top: clamp(candidate.top, margin, Math.max(margin, viewport.height - height - margin)),
        right: 0,
        bottom: 0,
      }
      const placed = { ...box, right: box.left + width, bottom: box.top + height }
      const area = obstacles.reduce((sum, obstacle) => sum + overlapArea(placed, obstacle), 0)
      if (area === 0 && !foundClear) {
        foundClear = true
        chosen = { left: placed.left, top: placed.top }
        chosenOverlap = 0
      } else if (!foundClear && area < chosenOverlap) {
        chosenOverlap = area
        chosen = { left: placed.left, top: placed.top }
      } else if (area === 0 && foundClear && chosenOverlap === 0) {
        continue
      }
    }
    menu.style.left = `${chosen.left}px`
    menu.style.top = `${chosen.top}px`
    const covered = intersects(
      { left: chosen.left, top: chosen.top, right: chosen.left + width, bottom: chosen.top + height },
      buttonBox(left, top, size),
    )
    entry.classList.toggle('is-covered', covered)
  }

  function reposition(): void {
    if (disposed || document.hidden) return
    if (raf !== 0) return
    raf = requestAnimationFrame(() => {
      raf = 0
      if (!disposed && !document.hidden) place()
    })
  }

  function persist(next: FloatingPosition): void {
    pendingWrite = { ...next, collapsed: true }
    if (writing || callbacks === undefined) return
    writing = true
    void flushWrites()
  }

  async function flushWrites(): Promise<void> {
    while (pendingWrite !== undefined && !disposed && callbacks !== undefined) {
      const job = pendingWrite
      pendingWrite = undefined
      try {
        await callbacks.writePosition(job)
        if (pendingWrite === undefined && !disposed) {
          positionFailed = false
          render()
        }
      } catch {
        if (!disposed) {
          positionFailed = true
          render()
        }
      }
    }
    writing = false
    if (pendingWrite !== undefined && !disposed) {
      writing = true
      await flushWrites()
    }
  }

  function currentLeftTop(): { left: number; top: number } {
    return {
      left: Number.parseFloat(entry.style.left) || 0,
      top: Number.parseFloat(entry.style.top) || 0,
    }
  }

  function stopDrag(commit: boolean): void {
    const current = drag
    if (current === undefined) return
    drag = undefined
    document.removeEventListener('pointermove', current.onMove)
    document.removeEventListener('pointerup', current.onUp)
    document.removeEventListener('pointercancel', current.onCancel)
    entry.classList.remove('is-dragging')
    try {
      entry.releasePointerCapture(current.pointerId)
    } catch {
      /* Capture may already be gone. */
    }
    if (!commit || !current.moved) {
      position = current.origin
      place()
      scheduleDock()
      return
    }
    suppressClick = true
    const scale = scaleOf(viewport)
    const size = BUTTON / scale
    const point = currentLeftTop()
    const center = point.left + size / 2
    const side = center < viewport.width / 2 ? 'left' : 'right'
    const margin = MARGIN / scale
    const min = margin
    const max = viewport.height - size - margin
    const ratio = max <= min ? 0.5 : clamp((point.top - min) / (max - min), 0, 1)
    position = { side, ratio, collapsed: false }
    hovered = false
    dirty = true
    place()
    persist(position)
    render()
    scheduleDock()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!event.isTrusted || event.isPrimary !== true || event.button !== 0 || disposed || view?.visible !== true) return
    suppressClick = false
    clearDockTimer()
    if (drag !== undefined) stopDrag(false)
    place()
    const point = currentLeftTop()
    const onMove = (move: PointerEvent): void => {
      if (drag === undefined || move.pointerId !== drag.pointerId) return
      const distance = Math.hypot(move.clientX - drag.startX, move.clientY - drag.startY)
      if (!drag.moved && distance < DRAG_PX) return
      if (!drag.moved) {
        drag.moved = true
        closeMenu(false)
        entry.classList.add('is-dragging')
      }
      const scale = scaleOf(viewport)
      const size = BUTTON / scale
      const left = clamp(drag.originLeft + (move.clientX - drag.startX) / scale, 0, Math.max(0, viewport.width - size))
      const top = clamp(drag.originTop + (move.clientY - drag.startY) / scale, 0, Math.max(0, viewport.height - size))
      entry.style.visibility = 'visible'
      entry.tabIndex = 0
      entry.style.left = `${left}px`
      entry.style.top = `${top}px`
      geometry.onPosition?.()
    }
    const onUp = (up: PointerEvent): void => {
      if (drag === undefined || up.pointerId !== drag.pointerId) return
      stopDrag(true)
    }
    const onCancel = (cancel: PointerEvent): void => {
      if (drag === undefined || cancel.pointerId !== drag.pointerId) return
      stopDrag(false)
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: point.left,
      originTop: point.top,
      origin: position,
      moved: false,
      onMove,
      onUp,
      onCancel,
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    try {
      entry.setPointerCapture(event.pointerId)
    } catch {
      /* The pointer may already be inactive. */
    }
  }

  function onLostCapture(event: PointerEvent): void {
    if (drag !== undefined && event.pointerId === drag.pointerId) stopDrag(false)
  }

  function onEntryClick(event: MouseEvent): void {
    if (!trusted(event)) return
    if (event.detail > 0 && suppressClick) {
      suppressClick = false
      return
    }
    expandEntry()
    if (menuOpen) closeMenu(false)
    else openMenu(event.detail === 0)
  }

  function nudge(key: string): void {
    viewport = geometry.viewport()
    const scale = scaleOf(viewport)
    const size = BUTTON / scale
    const margin = MARGIN / scale
    let next: FloatingPosition
    if (key === 'ArrowLeft') next = { ...position, side: 'left' }
    else if (key === 'ArrowRight') next = { ...position, side: 'right' }
    else {
      const min = margin
      const max = viewport.height - size - margin
      const y = restedY(viewport, size, margin) + (key === 'ArrowDown' ? NUDGE_PX / scale : -NUDGE_PX / scale)
      const clamped = clamp(y, max < min ? 0 : min, max < min ? Math.max(0, viewport.height - size) : max)
      const ratio = max <= min ? 0.5 : clamp((clamped - min) / (max - min), 0, 1)
      next = { ...position, ratio }
    }
    position = next
    dirty = true
    place()
    persist(position)
    scheduleDock()
  }

  function onEntryKeyDown(event: KeyboardEvent): void {
    if (!event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      if (event.key === 'Escape' && menuOpen) {
        event.preventDefault()
        closeMenu(true)
      }
      return
    }
    if (!trusted(event)) return
    event.preventDefault()
    nudge(event.key)
  }

  function onMenuKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !menuOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
  }

  function onTranslate(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || blocked(translateButton)) return
    callbacks?.onAction('translate-page')
  }

  function onPrimary(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || blocked(primary)) return
    callbacks?.onAction('toggle-auto')
  }

  function onPage(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || blocked(pageButton)) return
    callbacks?.onAction('restore')
  }

  function onResume(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || !view.resumable || blocked(resumeButton)) return
    callbacks?.onAction('resume')
  }

  function onSettings(event: MouseEvent): void {
    if (!trusted(event) || blocked(settingsButton)) return
    callbacks?.onAction('settings')
  }

  function onTextWindow(event: MouseEvent): void {
    if (!trusted(event) || blocked(textButton)) return
    callbacks?.onAction('text-window')
  }

  function onCloseClick(event: MouseEvent): void {
    if (!trusted(event)) return
    closeMenu(true)
  }

  function onBlur(): void {
    if (drag !== undefined) stopDrag(false)
  }

  function onVisibility(): void {
    syncSurfaceVisibility(shadow.host as HTMLElement)
    if (document.visibilityState === 'hidden') {
      if (drag !== undefined) stopDrag(false)
      clearDockTimer()
      if (raf !== 0) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      return
    }
    reposition()
    scheduleDock()
  }

  entry.addEventListener('pointerdown', onPointerDown)
  entry.addEventListener('pointerenter', onPointerEnter)
  entry.addEventListener('pointerleave', onPointerLeave)
  entry.addEventListener('focusin', onFocusIn)
  entry.addEventListener('focusout', onFocusOut)
  entry.addEventListener('lostpointercapture', onLostCapture)
  entry.addEventListener('click', onEntryClick)
  entry.addEventListener('keydown', onEntryKeyDown)
  menu.addEventListener('keydown', onMenuKeyDown)
  translateButton.addEventListener('click', onTranslate)
  primary.addEventListener('click', onPrimary)
  pageButton.addEventListener('click', onPage)
  resumeButton.addEventListener('click', onResume)
  settingsButton.addEventListener('click', onSettings)
  textButton.addEventListener('click', onTextWindow)
  closeButton.addEventListener('click', onCloseClick)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    update(nextView, nextLabels, nextCallbacks) {
      const first = !readStarted
      callbacks = nextCallbacks
      const unchanged = sameView(nextView) && sameLabels(nextLabels) && imageUrl === nextCallbacks.imageUrl
      view = nextView
      labels = nextLabels
      if (imageUrl !== nextCallbacks.imageUrl) {
        imageUrl = nextCallbacks.imageUrl
        image.src = imageUrl
        brand.src = imageUrl
      }
      if (!unchanged) render()
      if (first) {
        readStarted = true
        const token = ++readEpoch
        void Promise.resolve()
          .then(() => callbacks?.readPosition())
          .then((value) => {
            if (disposed || dirty || token !== readEpoch) return
            position = readPosition(value)
            if (keepExpanded()) position = { ...position, collapsed: false }
            place()
            render()
          })
          .catch(() => undefined)
      }
      if (!unchanged || first) reposition()
    },
    setStyle(styleName) {
      applySurfacePreferences(shadow.host as HTMLElement, { uiStyle: styleName })
      for (const node of [entry, menu]) {
        if (styleName === 'classic') node.removeAttribute('data-style')
        else node.setAttribute('data-style', styleName)
      }
    },
    closeMenu,
    isMenuOpen() {
      return menuOpen
    },
    reposition,
    getAnchor() {
      if (disposed || view?.visible !== true || entry.style.visibility !== 'visible') return undefined
      const { left, top } = currentLeftTop()
      const size = BUTTON / scaleOf(viewport)
      return { side: position.side, left, top, right: left + size, bottom: top + size }
    },
    setNoticeVisible(visible) {
      if (disposed || noticeVisible === visible) return
      noticeVisible = visible
      if (visible) expandEntry()
      else scheduleDock()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearDockTimer()
      readEpoch += 1
      if (drag !== undefined) stopDrag(false)
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
      menuObserver?.disconnect()
      entry.removeEventListener('pointerdown', onPointerDown)
      entry.removeEventListener('pointerenter', onPointerEnter)
      entry.removeEventListener('pointerleave', onPointerLeave)
      entry.removeEventListener('focusin', onFocusIn)
      entry.removeEventListener('focusout', onFocusOut)
      entry.removeEventListener('lostpointercapture', onLostCapture)
      entry.removeEventListener('click', onEntryClick)
      entry.removeEventListener('keydown', onEntryKeyDown)
      menu.removeEventListener('keydown', onMenuKeyDown)
      translateButton.removeEventListener('click', onTranslate)
      primary.removeEventListener('click', onPrimary)
      pageButton.removeEventListener('click', onPage)
      resumeButton.removeEventListener('click', onResume)
      settingsButton.removeEventListener('click', onSettings)
      textButton.removeEventListener('click', onTextWindow)
      closeButton.removeEventListener('click', onCloseClick)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      style.remove()
      entry.remove()
      menu.remove()
      move.remove()
    },
  }
}
