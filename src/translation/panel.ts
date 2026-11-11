import type { UiStyle } from '../shared/settings'
import { createFloatingEntry, type FloatingCallbacks, type FloatingEntry, type FloatingLabels, type FloatingView } from './floating'
import type { AssistResult } from './intent'
import { deepActiveElement } from './input-translation'
import type { SelectionAnchor } from './selection'
import {
  applySurfacePreferences,
  createProgressIndicator,
  createSurfaceExit,
  DEFAULT_SURFACE_PREFERENCES,
  SURFACE_CSS,
  syncSurfaceVisibility,
  type SurfacePreferences,
} from './ui-surface'

export type ToolbarAction = 'translate' | 'define' | 'explain' | 'copy'
export type PauseKind = 'error' | 'paused' | 'limit'

export interface PanelLabels {
  readonly translate: string
  readonly define: string
  readonly explain: string
  readonly none: string
  readonly result: string
  readonly close: string
  readonly literal: string
  readonly dismiss: string
  readonly hint: string
  readonly source: string
  readonly loading: string
  readonly resume: string
  readonly toolbar: string
  readonly toolbarTranslate: string
  readonly toolbarDefine: string
  readonly toolbarExplain: string
  readonly copy: string
  readonly copied: string
  readonly copyFailed: string
  readonly configureHint: string
  readonly failed?: string
  readonly retry?: string
  readonly paused?: string
  readonly limit?: string
  readonly more?: string
  readonly details?: string
}

export const DEFAULT_LABELS: Required<PanelLabels> = {
  translate: '译文',
  define: '释义',
  explain: '解释',
  none: '翻译',
  result: '翻译结果',
  close: '关闭',
  literal: '只翻译',
  dismiss: '本页不再主动提示',
  hint: '需要解释这段吗？',
  source: '原文',
  loading: '翻译中',
  resume: '继续翻译',
  toolbar: '选择工具栏',
  toolbarTranslate: '翻译',
  toolbarDefine: '释义',
  toolbarExplain: '解释',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败',
  configureHint: '请先配置模型',
  failed: '翻译失败',
  retry: '点击重试',
  paused: '翻译已暂停',
  limit: '已达本页翻译上限',
  more: '更多操作',
  details: '查看原因',
}

export interface TranslationPanel {
  /** 内容脚本卡片的界面风格；classic 移除 data-style */
  setStyle(style: 'classic' | 'cyber' | 'glass'): void
  setPreferences(preferences: SurfacePreferences): void
  setLabels(labels: PanelLabels): void
  showToolbar(anchor: SelectionAnchor, configured: boolean, onAction: (action: ToolbarAction) => void): void
  setToolbarCopyResult(copied: boolean): void
  focusToolbar(): boolean
  isOpen(): boolean
  showSelection(source: string): void
  showSelectionResult(source: string, translations: readonly string[]): void
  showAssist(source: string, result: AssistResult): void
  showHint(anchor: SelectionAnchor, onOpen: () => void): void
  showError(message: string): void
  showNotice(message: string): void
  showPauseStatus(reason: string, resumable: boolean, actionLabel?: string, kind?: PauseKind): void
  hidePauseStatus(): void
  setAnchor(anchor: SelectionAnchor | undefined): void
  containsEvent(event: Event): boolean
  /** 关闭卡片、提示与工具栏；默认一并收起悬浮菜单。页面动作（恢复/继续）由菜单触发时保留菜单，让结果与错误仍可见 */
  close(options?: { keepFloatingMenu?: boolean }): void
  dispose(): void
  setOnClose(handler: () => void): void
  setOnResume(handler: () => void): void
  setOnLiteral(handler: () => void): void
  setOnRetry(handler: () => void): void
  setOnDismissProactive(handler: () => void): void
  setOnCopyResult(handler: (text: string) => void): void
  setCopyResultFeedback(copied: boolean): void
  setFloating(view: FloatingView, labels: FloatingLabels, callbacks: FloatingCallbacks): void
}

type PanelState = 'hidden' | 'hint' | 'panel' | 'toolbar'

const PANEL_CSS = `${SURFACE_CSS}
.panel, .hint, .pause-status, .selection-toolbar {
  box-sizing: border-box; font: 13px/1.5 var(--gcn-font); color: var(--wt-ink);
}
.panel, .hint, .selection-toolbar {
  background: var(--wt-surface); border: 1px solid var(--wt-border);
  border-radius: var(--gcn-radius-overlay); box-shadow: var(--gcn-shadow-overlay);
  position: fixed; z-index: 2147483647; pointer-events: auto;
}
:host([data-style='glass']) .panel, :host([data-style='glass']) .hint, :host([data-style='glass']) .selection-toolbar {
  backdrop-filter: blur(var(--gcn-surface-blur)); -webkit-backdrop-filter: blur(var(--gcn-surface-blur));
}
.panel { max-height: min(480px, calc(100vh - 24px)); display: flex; flex-direction: column; overflow: auto; }
.hint { padding: 4px 10px; min-height: var(--gcn-control-sm); cursor: pointer; font-size: 12px; }
.hint:hover { background: var(--gcn-btn-hover-bg); }
.selection-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px 8px; }
.toolbar-configure-hint { flex-basis: 100%; margin: 0; color: var(--wt-muted); font-size: 12px; line-height: 18px; }
.selection-toolbar button {
  box-sizing: border-box; flex: 0 1 auto; min-width: 0; max-width: 100%; min-height: var(--gcn-control-sm);
  padding: 2px 8px; font: inherit; font-size: 12px; color: var(--gcn-btn-fg); background: var(--gcn-btn-bg);
  border: 1px solid var(--gcn-btn-border); border-radius: var(--gcn-radius); cursor: pointer; overflow-wrap: anywhere;
}
.selection-toolbar button:hover:not(:disabled) { background: var(--gcn-btn-hover-bg); }
.selection-toolbar button[data-action='translate'] { color: var(--gcn-primary-fg); background: var(--gcn-primary-bg); border-color: var(--gcn-primary-border); }
.selection-toolbar button[data-action='translate']:hover:not(:disabled) { background: var(--gcn-primary-hover-bg); }
.selection-toolbar button:disabled { color: var(--gcn-fg-disabled); background: var(--gcn-bg-disabled); cursor: default; }
/* 未配置模型时主按钮不能再带主色填充，否则看起来比真正可用的「复制」更像可点 */
.selection-toolbar button[data-action='translate']:disabled { color: var(--gcn-fg-disabled); background: var(--gcn-bg-disabled); border-color: var(--gcn-border); }
.selection-toolbar .toolbar-close { padding: 0 6px; background: transparent; border: 0; }
.toolbar-announcement, .panel-announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px 0; font-weight: 600; }
.panel-title { min-width: 0; overflow-wrap: anywhere; color: var(--wt-muted); font-size: 12px; line-height: 18px; }
.panel-close { flex: none; min-width: var(--gcn-control-sm); min-height: var(--gcn-control-sm); padding: 2px 6px; font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; border-radius: var(--gcn-radius); }
.panel-close:hover { background: var(--gcn-invisible-hover-bg); }
.panel-body { padding: 10px 14px; overflow-wrap: anywhere; }
.panel-body:empty, .panel-actions:empty { display: none; }
.panel-source { color: var(--wt-muted); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.panel-source + .panel-target { margin-top: 8px; }
.panel-target { color: inherit; font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; text-wrap: pretty; }
.panel-note { margin-top: 8px; font-size: 12.5px; line-height: 1.6; color: var(--wt-muted); white-space: pre-wrap; }
details.panel-source { margin-top: 10px; padding: 0; border: 0; background: transparent; font-size: 12px; }
.panel-source summary { cursor: pointer; font-weight: 500; user-select: none; min-height: var(--gcn-control-sm); }
details.panel-source > div { margin-top: 6px; }
.panel-source details { font-size: 12px; }
.panel-status { padding: 10px 14px; color: var(--wt-muted); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.panel-status-error { color: var(--gcn-danger-fg); }
.panel-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 0 14px 10px; }
.panel-actions button { min-height: var(--gcn-control-sm); padding: 2px 0; font: inherit; font-size: 12px; color: var(--wt-accent); cursor: pointer; background: transparent; border: 1px solid transparent; border-radius: var(--gcn-radius); font-weight: 500; }
.panel-actions button:hover { background: var(--gcn-invisible-hover-bg); }
.panel-more { margin-left: auto; color: var(--wt-muted); font-size: 12px; }
.panel-more summary { cursor: pointer; list-style: none; min-width: var(--gcn-control-sm); min-height: var(--gcn-control-sm); text-align: center; }
.panel-more summary::-webkit-details-marker { display: none; }
.panel-more > div { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 6px; }
.panel-mascot { width: 24px; height: 24px; border-radius: 6px; flex: none; }
.panel.is-feedback .panel-actions { padding-top: 5px; padding-left: 46px; }
.error-details { min-width: 0; font-size: 12px; line-height: 1.5; color: var(--wt-muted); }
.error-details > summary { cursor: pointer; width: fit-content; min-height: var(--gcn-control-sm); }
.error-reason { margin-top: 4px; max-height: 6em; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; user-select: text; }
.panel-error-details { margin: 0 0 8px; }
.notice-error-details { margin: 0 calc(11px / var(--wt-notice-scale)) calc(8px / var(--wt-notice-scale)); font-size: calc(11px / var(--wt-notice-scale)); }
.pause-status { --wt-notice-scale: 1; position: fixed; left: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: flex-end; gap: calc(8px / var(--wt-notice-scale)); max-width: min(360px, calc(100vw - 32px)); padding: 0; border: 0; background: transparent; box-shadow: none; overflow-wrap: anywhere; pointer-events: auto; }
.notice-mascot { width: calc(40px / var(--wt-notice-scale)); height: calc(40px / var(--wt-notice-scale)); flex: none; border-radius: calc(10px / var(--wt-notice-scale)); }
.notice-speech { position: relative; flex: 0 1 auto; min-width: 0; box-sizing: border-box; width: calc(176px / var(--wt-notice-scale)); color: var(--wt-ink); background: var(--wt-surface); border: 1px solid var(--wt-border); border-radius: calc(12px / var(--wt-notice-scale)); box-shadow: var(--gcn-shadow-overlay); }
.notice-speech::before { content: ''; position: absolute; left: calc(-4px / var(--wt-notice-scale)); top: 60%; width: calc(7px / var(--wt-notice-scale)); height: calc(7px / var(--wt-notice-scale)); transform: rotate(45deg); background: var(--wt-surface); border-left: 1px solid var(--wt-border); border-bottom: 1px solid var(--wt-border); }
.pause-status[data-side='right'] .notice-speech::before { left: auto; right: calc(-4px / var(--wt-notice-scale)); transform: rotate(225deg); }
.pause-status .pause-resume { box-sizing: border-box; width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: calc(10px / var(--wt-notice-scale)) calc(28px / var(--wt-notice-scale)) calc(10px / var(--wt-notice-scale)) calc(10px / var(--wt-notice-scale)); font: inherit; font-size: calc(12px / var(--wt-notice-scale)); line-height: 1.5; color: var(--wt-ink); background: transparent; border: 0; text-align: start; cursor: pointer; }
.pause-status .pause-resume:disabled { cursor: default; }
.pause-reason { color: inherit; }
.notice-link { color: var(--wt-accent); font-size: calc(11px / var(--wt-notice-scale)); }
.notice-close { position: absolute; right: calc(3px / var(--wt-notice-scale)); top: calc(3px / var(--wt-notice-scale)); width: calc(24px / var(--wt-notice-scale)); height: calc(24px / var(--wt-notice-scale)); padding: 0; color: var(--wt-muted); font: inherit; background: transparent; border: 0; border-radius: 5px; cursor: pointer; }
@media (forced-colors: active) { .notice-speech::before { display: none; } }
`

const GAP = 8
const MARGIN = 12

export function createTranslationPanel(): TranslationPanel {
  const host = document.createElement('div')
  host.setAttribute('data-wt-root', '')
  host.style.cssText =
    'all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: none !important; contain: style !important;'
  applySurfacePreferences(host, DEFAULT_SURFACE_PREFERENCES)
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  let labels = DEFAULT_LABELS
  let titleIntent: AssistResult['intent'] = 'translate'
  let loading = false
  let defaultResumeLabel = true
  function createErrorDetails(className: string) {
    const element = document.createElement('details')
    element.className = `error-details ${className}`
    element.hidden = true
    const summary = document.createElement('summary')
    summary.textContent = labels.details
    const reason = document.createElement('div')
    reason.className = 'error-reason'
    element.append(summary, reason)
    return { element, summary, reason }
  }
  const panelErrorDetails = createErrorDetails('panel-error-details')
  const noticeErrorDetails = createErrorDetails('notice-error-details')
  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'false')
  panel.setAttribute('aria-label', labels.result)
  // 悬浮入口会让宿主常驻可见：卡片与提示在首次 applyState 之前也必须不渲染
  panel.style.display = 'none'
  const header = document.createElement('div')
  header.className = 'panel-header'
  const title = document.createElement('span')
  title.className = 'panel-title'
  title.textContent = labels.translate
  const feedbackMascot = document.createElement('img')
  feedbackMascot.className = 'panel-mascot'
  feedbackMascot.alt = ''
  feedbackMascot.hidden = true
  const closeButton = document.createElement('button')
  closeButton.className = 'panel-close'
  closeButton.type = 'button'
  closeButton.textContent = '✕'
  closeButton.setAttribute('aria-label', labels.close)
  header.append(feedbackMascot, title, closeButton)
  const body = document.createElement('div')
  body.className = 'panel-body'
  body.setAttribute('aria-live', 'polite')
  const status = document.createElement('div')
  status.className = 'panel-status'
  status.setAttribute('role', 'status')
  const actions = document.createElement('div')
  actions.className = 'panel-actions'
  const copyResultButton = document.createElement('button')
  copyResultButton.className = 'panel-copy'
  copyResultButton.type = 'button'
  copyResultButton.dataset.action = 'copy-result'
  copyResultButton.textContent = labels.copy
  const literalButton = document.createElement('button')
  literalButton.type = 'button'
  literalButton.textContent = labels.literal
  const moreActions = document.createElement('details')
  moreActions.className = 'panel-more'
  const moreSummary = document.createElement('summary')
  moreSummary.textContent = '⋯'
  moreSummary.setAttribute('aria-label', labels.more ?? DEFAULT_LABELS.more)
  const moreBody = document.createElement('div')
  moreActions.append(moreSummary, moreBody)
  const pauseStatus = document.createElement('div')
  pauseStatus.className = 'pause-status'
  pauseStatus.setAttribute('role', 'status')
  pauseStatus.style.display = 'none'
  const pauseReason = document.createElement('span')
  pauseReason.className = 'pause-reason'
  const pauseMascot = document.createElement('img')
  pauseMascot.className = 'notice-mascot'
  pauseMascot.alt = ''
  pauseMascot.hidden = true
  const pauseSpeech = document.createElement('div')
  pauseSpeech.className = 'notice-speech'
  const pauseLink = document.createElement('span')
  pauseLink.className = 'notice-link'
  const resumeButton = document.createElement('button')
  resumeButton.className = 'pause-resume'
  resumeButton.type = 'button'
  resumeButton.append(pauseReason, pauseLink)
  const pauseClose = document.createElement('button')
  pauseClose.className = 'notice-close'
  pauseClose.type = 'button'
  pauseClose.textContent = '×'
  pauseClose.setAttribute('aria-label', labels.close)
  pauseSpeech.append(resumeButton, noticeErrorDetails.element, pauseClose)
  pauseStatus.append(pauseMascot, pauseSpeech)
  const dismissProactiveButton = document.createElement('button')
  dismissProactiveButton.type = 'button'
  dismissProactiveButton.textContent = labels.dismiss
  const hint = document.createElement('button')
  hint.className = 'hint'
  hint.type = 'button'
  hint.textContent = labels.hint
  hint.style.display = 'none'
  const toolbar = document.createElement('div')
  toolbar.className = 'selection-toolbar'
  toolbar.setAttribute('role', 'toolbar')
  toolbar.setAttribute('aria-label', labels.toolbar)
  toolbar.style.display = 'none'
  const translateButton = document.createElement('button')
  const defineButton = document.createElement('button')
  const explainButton = document.createElement('button')
  const copyButton = document.createElement('button')
  const toolbarClose = document.createElement('button')
  const toolbarAnnouncement = document.createElement('span')
  toolbarAnnouncement.className = 'toolbar-announcement'
  toolbarAnnouncement.setAttribute('role', 'status')
  toolbarAnnouncement.setAttribute('aria-live', 'polite')
  const actionButtons: ReadonlyArray<readonly [ToolbarAction, HTMLButtonElement]> = [
    ['translate', translateButton],
    ['define', defineButton],
    ['explain', explainButton],
    ['copy', copyButton],
  ]
  for (const [action, button] of actionButtons) {
    button.type = 'button'
    button.dataset.action = action
    button.textContent =
      action === 'translate' ? labels.toolbarTranslate :
      action === 'define' ? labels.toolbarDefine :
      action === 'explain' ? labels.toolbarExplain :
      labels.copy
  }
  toolbarClose.type = 'button'
  toolbarClose.className = 'toolbar-close'
  toolbarClose.textContent = '✕'
  toolbarClose.setAttribute('aria-label', labels.close)
  const configureHint = document.createElement('p')
  configureHint.className = 'toolbar-configure-hint'
  configureHint.id = 'wt-toolbar-configure-hint'
  configureHint.setAttribute('role', 'status')
  configureHint.textContent = labels.configureHint
  configureHint.hidden = true
  toolbar.append(translateButton, defineButton, explainButton, copyButton, toolbarClose, configureHint, toolbarAnnouncement)
  const panelAnnouncement = document.createElement('span')
  panelAnnouncement.className = 'panel-announcement'
  panelAnnouncement.setAttribute('role', 'status')
  panelAnnouncement.setAttribute('aria-live', 'polite')
  panel.append(header, body, status, panelErrorDetails.element, actions, panelAnnouncement, createProgressIndicator())
  shadow.append(style, panel, hint, pauseStatus, toolbar)
  const surfaceExits = [panel, hint, toolbar].map(element => ({ element, exit: createSurfaceExit(element, host) }))

  let attached = false
  let modalHost: HTMLDialogElement | undefined
  let state: PanelState = 'hidden'
  let pauseShown = false
  let pauseKind: PauseKind | undefined
  let pauseDismissed = false
  let pauseRaf = 0
  let feedbackError = false
  let mascotUrl = ''
  let disposed = false
  let currentUiStyle: UiStyle = 'classic'
  let floatingEntry: FloatingEntry | undefined
  let modalObserver: MutationObserver | undefined
  let observedModalHost: HTMLDialogElement | undefined
  let anchor: SelectionAnchor | undefined
  let onClose: () => void = () => undefined
  let onResume: () => void = () => undefined
  let onLiteral: () => void = () => undefined
  let onRetry: () => void = () => undefined
  let onDismissProactive: () => void = () => undefined
  let onCopyResult: (text: string) => void = () => undefined
  let onHintOpen: () => void = () => undefined
  let toolbarAction: ((action: ToolbarAction) => void) | undefined
  let copyFeedback: boolean | undefined
  let resultText = ''
  /** 本条结果上确实点过复制：换了新结果后，迟到的反馈不能落到新结果上 */
  let copyArmed = false
  let copyResultTimer: ReturnType<typeof setTimeout> | undefined
  let pendingRaf = 0
  let returnFocus: HTMLElement | undefined
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (pendingRaf !== 0 || document.hidden || (state !== 'panel' && state !== 'toolbar')) return
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = 0
            if (document.hidden) return
            if (state === 'panel') positionPanel()
            else if (state === 'toolbar') positionElement(toolbar, 6)
          })
        })
      : undefined

  function zoomScale(): number {
    const rect = document.documentElement.getBoundingClientRect()
    const width = document.documentElement.offsetWidth
    if (width <= 0 || rect.width <= 0) return 1
    // offsetWidth rounds CSS pixels; fractional browser zoom must not become a page transform.
    return Math.abs(rect.width - width) <= 0.5 ? 1 : rect.width / width
  }

  function clampView(anchorRect: { left: number; top: number; right: number; bottom: number }): {
    left: number
    top: number
    right: number
    bottom: number
  } {
    const scale = zoomScale()
    return {
      left: anchorRect.left / scale,
      top: anchorRect.top / scale,
      right: anchorRect.right / scale,
      bottom: anchorRect.bottom / scale,
    }
  }

  function positionPanel(): void {
    positionElement(panel, GAP)
  }

  function positionElement(element: HTMLElement, gap: number): void {
    const scale = zoomScale()
    const viewW = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth) / scale
    const viewH = Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight) / scale
    const margin = MARGIN / scale
    const gapCss = gap / scale
    const maxWidth = Math.max(1, Math.min((feedbackError && element === panel ? 224 : 300) / scale, viewW - margin * 2))
    element.style.maxHeight = `${Math.max(1, Math.min(480 / scale, viewH - margin * 2))}px`
    if (element === panel) element.style.width = `${maxWidth}px`
    else {
      element.style.width = 'max-content'
      element.style.maxWidth = `${maxWidth}px`
    }
    if (anchor === undefined) {
      element.style.left = ''
      element.style.top = ''
      element.style.right = `${16 / scale}px`
      element.style.bottom = `${16 / scale}px`
      floatingEntry?.reposition()
      return
    }
    const a = clampView(anchor)
    let rect = element.getBoundingClientRect()
    const width = rect.width / scale || maxWidth
    let height = rect.height / scale || 200
    const below = Math.max(0, viewH - margin - a.bottom - gapCss)
    const above = Math.max(0, a.top - gapCss - margin)
    const available = Math.max(below, above)
    if (height > available && available >= 80 / scale) {
      element.style.maxHeight = `${available}px`
      rect = element.getBoundingClientRect()
      height = rect.height / scale || available
    }
    let top: number
    const epsilon = 1 / scale
    const fitsBelow = a.bottom + gapCss + height <= viewH - margin + epsilon
    const fitsAbove = a.top - gapCss - height >= margin - epsilon
    if (fitsBelow) top = a.bottom + gapCss
    else if (fitsAbove) top = a.top - gapCss - height
    else top = Math.max(margin, Math.min(a.bottom + gapCss, viewH - height - margin))
    const left = Math.max(margin, Math.min(a.left, viewW - width - margin))
    element.style.left = `${left}px`
    element.style.top = `${top}px`
    element.style.right = ''
    element.style.bottom = ''
    floatingEntry?.reposition()
  }

  function setStatus(message: string, error: boolean): void {
    loading = false
    panel.setAttribute('aria-busy', 'false')
    status.textContent = message
    status.classList.toggle('panel-status-error', error)
    status.style.display = message === '' ? 'none' : ''
  }

  function modalFor(node: Node | null): HTMLDialogElement | undefined {
    let element = node instanceof Element ? node : node?.parentElement ?? null
    for (let depth = 0; element !== null && depth < 64; depth += 1) {
      if (element instanceof HTMLDialogElement && element.open && element.isConnected) {
        try {
          if (element.matches(':modal')) return element
        } catch {
          return undefined
        }
      }
      const root = element.getRootNode()
      element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
    }
    return undefined
  }

  function hideTopLayer(): void {
    if (typeof host.hidePopover !== 'function' || !host.hasAttribute('popover')) return
    try {
      host.hidePopover()
    } catch {
      /* The document may be inactive during pagehide. */
    }
  }

  function releaseModal(): void {
    hideTopLayer()
    modalHost?.removeEventListener('close', onModalClose)
    modalHost = undefined
    host.removeAttribute('popover')
  }

  function attach(): void {
    const selection = window.getSelection()
    const target =
      modalFor(selection?.anchorNode ?? null) ??
      modalFor(shadow.activeElement ?? document.activeElement) ??
      (modalHost?.isConnected && modalHost.open && modalHost.matches(':modal') ? modalHost : undefined)
    const parent = target ?? document.documentElement
    if (host.parentElement !== parent || modalHost !== target) {
      releaseModal()
      parent.append(host)
      modalHost = target
      if (modalHost !== undefined) {
        host.setAttribute('popover', 'manual')
        modalHost.addEventListener('close', onModalClose)
      }
    }
    attached = true
  }

  function openTopLayer(): void {
    if (modalHost === undefined || typeof host.showPopover !== 'function') return
    let already: boolean
    try {
      already = host.matches(':popover-open')
    } catch {
      already = false
    }
    if (already) return
    try {
      host.showPopover()
    } catch {
      /* The document may be inactive; fall back to in-dialog positioning. */
    }
  }

  function layoutTarget(): HTMLElement | undefined {
    if (state === 'panel') return panel
    if (state === 'toolbar') return toolbar
    return undefined
  }

  function disconnectModalObserver(): void {
    modalObserver?.disconnect()
    modalObserver = undefined
    observedModalHost = undefined
  }

  function watchModalHost(): void {
    // syncHostAttachment 调用频繁：同一个 dialog 仍在观察时直接复用，不重建、不重新上溯祖先
    if (modalObserver !== undefined && observedModalHost === modalHost) return
    disconnectModalObserver()
    if (floatingEntry === undefined || modalHost === undefined || typeof MutationObserver !== 'function') return
    const observed = modalHost
    observedModalHost = observed
    const observer = new MutationObserver(() => {
      if (observed.isConnected && observed.open) return
      floatingEntry?.closeMenu()
      if (state !== 'hidden') close()
      else applyState(state)
    })
    modalObserver = observer
    observer.observe(observed, { attributes: true, attributeFilter: ['open'] })
    let current: Node | null = observed
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      const parent: Node | null = current.parentNode
      if (parent !== null && parent.nodeType !== Node.DOCUMENT_NODE) {
        observer.observe(parent, { childList: true })
        current = parent
        continue
      }
      const root = current.getRootNode()
      if (root instanceof ShadowRoot) {
        current = root.host
        continue
      }
      break
    }
  }

  function syncHostAttachment(): void {
    const visible = state !== 'hidden' || pauseShown || floatingEntry !== undefined || surfaceExits.some(({ exit }) => exit.isClosing())
    if (visible) attach()
    else {
      releaseModal()
      if (attached && host.parentElement !== document.documentElement) document.documentElement.append(host)
    }
    host.style.setProperty('display', visible ? 'block' : 'none', 'important')
    if (visible) openTopLayer()
    if (floatingEntry !== undefined && modalHost !== undefined) watchModalHost()
    else disconnectModalObserver()
  }

  function avoidRects(): readonly { left: number; top: number; right: number; bottom: number }[] {
    const scale = zoomScale()
    const elements: HTMLElement[] = []
    if (state === 'panel') elements.push(panel)
    if (state === 'toolbar') elements.push(toolbar)
    if (state === 'hint') elements.push(hint)
    return elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left / scale, top: rect.top / scale, right: rect.right / scale, bottom: rect.bottom / scale }
    })
  }

  function isEventInside(event: Event): boolean {
    const path = event.composedPath()
    if (path.includes(host) || path.includes(shadow)) return true
    return event.target instanceof Node && (event.target === host || shadow.contains(event.target))
  }

  function onDocumentFocusIn(event: FocusEvent): void {
    if (floatingEntry === undefined || isEventInside(event)) return
    syncHostAttachment()
    floatingEntry.reposition()
  }

  function setFloating(view: FloatingView, labelsForFloating: FloatingLabels, callbacks: FloatingCallbacks): void {
    if (mascotUrl !== callbacks.imageUrl) {
      mascotUrl = callbacks.imageUrl
      pauseMascot.src = mascotUrl
      feedbackMascot.src = mascotUrl
    }
    if (!view.visible) {
      if (floatingEntry !== undefined) {
        floatingEntry.dispose()
        floatingEntry = undefined
        document.removeEventListener('focusin', onDocumentFocusIn, true)
        disconnectModalObserver()
        syncHostAttachment()
      }
      schedulePausePosition()
      return
    }
    if (floatingEntry === undefined) {
      floatingEntry = createFloatingEntry(shadow, {
        viewport() {
          const scale = zoomScale()
          const width = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth) / scale
          const height = Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight) / scale
          return { width, height, scale }
        },
        avoidRects,
        onPosition: schedulePausePosition,
      })
      floatingEntry.setStyle(currentUiStyle)
      document.addEventListener('focusin', onDocumentFocusIn, true)
    }
    floatingEntry.update(view, labelsForFloating, {
      ...callbacks,
      onOpen() {
        if (state !== 'hidden') close()
        callbacks.onOpen()
      },
    })
    if (!pauseShown) floatingEntry.setNoticeVisible(false)
    syncHostAttachment()
    floatingEntry.reposition()
  }

  function applyState(next: PanelState, afterHide?: () => void): void {
    if ((next === 'panel' || next === 'hint' || next === 'toolbar') && floatingEntry?.isMenuOpen() === true) {
      floatingEntry.closeMenu()
    }
    const fromHidden = state === 'hidden'
    const previousTarget = layoutTarget()
    state = next
    if (fromHidden && next !== 'hidden') {
      const active = deepActiveElement()
      returnFocus = active instanceof HTMLElement && active !== host ? active : undefined
    } else if (next === 'hidden') {
      returnFocus = undefined
      if (pendingRaf !== 0) {
        cancelAnimationFrame(pendingRaf)
        pendingRaf = 0
      }
    }
    for (const { element, exit } of surfaceExits) {
      const shown = next === 'panel' ? panel : next === 'hint' ? hint : next === 'toolbar' ? toolbar : undefined
      if (element === shown) {
        exit.show()
        element.style.display = ''
      } else if (next === 'hidden' && !disposed && element.style.display !== 'none') {
        exit.hide(() => {
          element.style.display = 'none'
          afterHide?.()
          syncHostAttachment()
        })
      } else {
        exit.show()
        element.style.display = 'none'
      }
    }
    if (disposed) afterHide?.()
    syncHostAttachment()
    const nextTarget = layoutTarget()
    if (previousTarget !== undefined && previousTarget !== nextTarget) resizeObserver?.unobserve(previousTarget)
    if (next === 'panel') {
      resizeObserver?.observe(panel)
      positionPanel()
    } else if (next === 'hint') {
      positionElement(hint, 6)
    } else if (next === 'toolbar') {
      resizeObserver?.observe(toolbar)
      positionElement(toolbar, 6)
    }
    schedulePausePosition()
  }

  function appendPair(source: string, target: string, collapsible: boolean): void {
    if (collapsible && source !== '') {
      const details = document.createElement('details')
      details.className = 'panel-source'
      const summary = document.createElement('summary')
      summary.textContent = labels.source
      const content = document.createElement('div')
      content.textContent = source
      details.append(summary, content)
      body.append(details)
    } else if (source !== '') {
      const from = document.createElement('div')
      from.className = 'panel-source'
      from.textContent = source
      body.append(from)
    }
    if (target !== '') {
      const to = document.createElement('div')
      to.className = 'panel-target'
      to.textContent = target
      body.append(to)
    }
  }

  function schedulePausePosition(): void {
    if (disposed || document.hidden || !pauseShown || pauseRaf !== 0) return
    pauseRaf = requestAnimationFrame(() => {
      pauseRaf = 0
      if (disposed || document.hidden || !pauseShown) return
      if (floatingEntry?.isMenuOpen() === true) {
        pauseStatus.style.display = 'none'
        floatingEntry.setNoticeVisible(false)
        return
      }
      pauseStatus.style.display = ''
      const scale = zoomScale()
      const margin = 12 / scale
      const width = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth) / scale
      const height = Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight) / scale
      pauseStatus.style.setProperty('--wt-notice-scale', String(scale))
      pauseStatus.style.maxWidth = `${Math.max(1, width - margin * 2)}px`
      const anchor = floatingEntry?.getAnchor()
      pauseMascot.hidden = anchor !== undefined || mascotUrl === ''
      pauseStatus.dataset.side = anchor?.side ?? 'left'
      const rect = pauseStatus.getBoundingClientRect()
      const w = rect.width / scale
      const h = rect.height / scale
      let x = margin
      let y = height - h - margin
      if (anchor !== undefined) {
        x = anchor.side === 'left' ? anchor.right + 8 / scale : anchor.left - w - 8 / scale
        y = (anchor.top + anchor.bottom - h) / 2
        if (x < margin || x + w > width - margin) {
          x = anchor.left
          y = anchor.top - h - 8 / scale
          if (y < margin) y = anchor.bottom + 8 / scale
        }
      }
      const clampX = (left: number): number => Math.max(margin, Math.min(left, width - w - margin))
      const clampY = (top: number): number => Math.max(margin, Math.min(top, height - h - margin))
      const candidates = [{ x, y }]
      if (anchor !== undefined) {
        candidates.push({ x: anchor.left, y: anchor.top - h - 8 / scale }, { x: anchor.left, y: anchor.bottom + 8 / scale })
      }
      const obstacles = avoidRects()
      const point = candidates.map(({ x, y }) => ({ x: clampX(x), y: clampY(y) }))
        .find(({ x, y }) => !obstacles.some((rect) => x < rect.right && x + w > rect.left && y < rect.bottom && y + h > rect.top))
      if (point === undefined) {
        pauseStatus.style.display = 'none'
        floatingEntry?.setNoticeVisible(false)
        return
      }
      floatingEntry?.setNoticeVisible(true)
      pauseStatus.style.left = `${point.x}px`
      pauseStatus.style.top = `${point.y}px`
      pauseStatus.style.bottom = 'auto'
    })
  }

  /** 同类失败只提醒一次，关闭提示不会改变暂停或失败状态。 */
  function setPauseStatus(reason: string | undefined, resumable: boolean, actionLabel?: string, kind: PauseKind = 'paused'): void {
    if (reason === undefined || pauseKind !== kind) {
      pauseDismissed = false
      noticeErrorDetails.element.open = false
    }
    noticeErrorDetails.reason.textContent = reason ?? ''
    noticeErrorDetails.element.hidden = reason === undefined || kind !== 'error'
    pauseKind = reason === undefined ? undefined : kind
    pauseShown = reason !== undefined && !pauseDismissed
    const text = reason === undefined ? '' : kind === 'error' ? labels.failed ?? DEFAULT_LABELS.failed
      : kind === 'limit' ? labels.limit ?? DEFAULT_LABELS.limit : labels.paused ?? DEFAULT_LABELS.paused
    if (pauseReason.textContent !== text) pauseReason.textContent = text
    if (pauseSpeech.title !== (reason ?? '')) pauseSpeech.title = reason ?? ''
    defaultResumeLabel = actionLabel === undefined
    const action = kind === 'error' ? labels.retry ?? DEFAULT_LABELS.retry : actionLabel ?? labels.resume
    if (pauseLink.textContent !== action) pauseLink.textContent = action
    pauseLink.hidden = !resumable
    resumeButton.disabled = !resumable
    pauseStatus.style.display = pauseShown ? '' : 'none'
    if (!pauseShown) floatingEntry?.setNoticeVisible(false)
    applyState(state)
    floatingEntry?.reposition()
    schedulePausePosition()
  }

  function toolbarLabel(action: ToolbarAction): string {
    if (action === 'translate') return labels.toolbarTranslate
    if (action === 'define') return labels.toolbarDefine
    if (action === 'explain') return labels.toolbarExplain
    if (copyFeedback === true) return labels.copied
    if (copyFeedback === false) return labels.copyFailed
    return labels.copy
  }

  function enabledToolbarButtons(): HTMLButtonElement[] {
    return [...actionButtons.map(([, button]) => button), toolbarClose].filter((button) => !button.disabled)
  }

  function syncToolbarTabindex(focus?: HTMLButtonElement): void {
    for (const [, button] of actionButtons) button.tabIndex = -1
    toolbarClose.tabIndex = -1
    const controls = enabledToolbarButtons()
    const target = focus !== undefined && controls.includes(focus) ? focus : controls[0]
    if (target !== undefined) target.tabIndex = 0
  }

  function applyToolbarModelLock(configured: boolean): void {
    translateButton.disabled = !configured
    defineButton.disabled = !configured
    explainButton.disabled = !configured
    translateButton.title = configured ? '' : labels.configureHint
    defineButton.title = configured ? '' : labels.configureHint
    explainButton.title = configured ? '' : labels.configureHint
    configureHint.hidden = configured
    configureHint.textContent = configured ? '' : labels.configureHint
    if (configured) {
      toolbar.removeAttribute('aria-describedby')
      copyButton.removeAttribute('aria-describedby')
    } else {
      toolbar.setAttribute('aria-describedby', configureHint.id)
      copyButton.setAttribute('aria-describedby', configureHint.id)
    }
    syncToolbarTabindex()
  }

  function setLabels(next: PanelLabels): void {
    labels = { ...DEFAULT_LABELS, ...next }
    panel.setAttribute('aria-label', labels.result)
    closeButton.setAttribute('aria-label', labels.close)
    title.textContent = feedbackError ? labels.failed ?? DEFAULT_LABELS.failed : labels[titleIntent]
    if (copyResultTimer === undefined) copyResultButton.textContent = labels.copy
    literalButton.textContent = feedbackError ? labels.retry ?? DEFAULT_LABELS.retry : labels.literal
    moreSummary.setAttribute('aria-label', labels.more ?? DEFAULT_LABELS.more)
    panelErrorDetails.summary.textContent = labels.details
    noticeErrorDetails.summary.textContent = labels.details
    pauseClose.setAttribute('aria-label', labels.close)
    dismissProactiveButton.textContent = labels.dismiss
    hint.textContent = labels.hint
    toolbar.setAttribute('aria-label', labels.toolbar)
    translateButton.textContent = labels.toolbarTranslate
    defineButton.textContent = labels.toolbarDefine
    explainButton.textContent = labels.toolbarExplain
    copyButton.textContent = toolbarLabel('copy')
    const modelTitle = translateButton.disabled ? labels.configureHint : ''
    translateButton.title = modelTitle
    defineButton.title = modelTitle
    explainButton.title = modelTitle
    if (!configureHint.hidden) configureHint.textContent = labels.configureHint
    toolbarClose.setAttribute('aria-label', labels.close)
    if (toolbarAnnouncement.textContent !== '') toolbarAnnouncement.textContent = copyButton.textContent
    if (pauseKind === 'error') pauseLink.textContent = labels.retry ?? DEFAULT_LABELS.retry
    else if (defaultResumeLabel) pauseLink.textContent = labels.resume
    if (loading) status.textContent = labels.loading
    for (const summary of shadow.querySelectorAll('.panel-source > summary')) summary.textContent = labels.source
    if (state !== 'hidden' || pauseShown) applyState(state)
  }

  function clearCopyResultTimer(): void {
    if (copyResultTimer !== undefined) {
      clearTimeout(copyResultTimer)
      copyResultTimer = undefined
    }
  }

  function resetBody(): void {
    clearCopyResultTimer()
    resultText = ''
    copyArmed = false
    copyResultButton.textContent = labels.copy
    panelAnnouncement.textContent = ''
    body.textContent = ''
    actions.textContent = ''
    moreActions.open = false
    moreBody.textContent = ''
    panelErrorDetails.element.hidden = true
    panelErrorDetails.element.open = false
    panelErrorDetails.reason.textContent = ''
    feedbackError = false
    feedbackMascot.hidden = true
    panel.classList.remove('is-feedback')
    panel.removeAttribute('aria-description')
    panel.removeAttribute('title')
    literalButton.textContent = labels.literal
  }

  function close(options?: { keepFloatingMenu?: boolean }, restoreFocus = false): void {
    clearCopyResultTimer()
    const owned = host === document.activeElement
    const restoreTarget = returnFocus
    if (options?.keepFloatingMenu !== true) floatingEntry?.closeMenu()
    if (state === 'hidden') return
    onHintOpen = () => undefined
    resultText = ''
    copyArmed = false
    loading = false
    panel.setAttribute('aria-busy', 'false')
    toolbarAction = undefined
    copyFeedback = undefined
    copyButton.textContent = labels.copy
    toolbarAnnouncement.textContent = ''
    applyState('hidden', () => {
      resetBody()
      setStatus('', false)
    })
    resizeObserver?.unobserve(panel)
    resizeObserver?.unobserve(toolbar)
    onClose()
    if (restoreFocus && owned && restoreTarget?.isConnected) {
      restoreTarget.focus({ preventScroll: true })
    }
  }

  function onModalClose(event: Event): void {
    if (modalHost === undefined || event.currentTarget !== modalHost || modalHost.open) return
    if (state !== 'hidden') close()
    else applyState('hidden')
  }

  function onGlobalKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
    const menu = floatingEntry?.isMenuOpen() === true
    if (event.key === 'Escape' && (state !== 'hidden' || menu)) {
      if (modalHost !== undefined || isEventInside(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
      if (menu) floatingEntry?.closeMenu(true)
      if (state !== 'hidden') close(undefined, !menu)
    }
  }
  function dismissOutside(event: Event): void {
    const menu = floatingEntry?.isMenuOpen() === true
    if ((state === 'hidden' && !menu) || isEventInside(event)) return
    if (state !== 'hidden') close()
    else floatingEntry?.closeMenu()
  }
  function onGlobalPointerDown(event: Event): void {
    dismissOutside(event)
  }
  function onGlobalScroll(event: Event): void {
    dismissOutside(event)
  }
  function onGlobalResize(): void {
    if (document.hidden) return
    schedulePausePosition()
    if (state === 'panel') positionPanel()
    else if (state === 'hint') positionElement(hint, 6)
    else if (state === 'toolbar') positionElement(toolbar, 6)
    else floatingEntry?.reposition()
  }
  function onVisibilityChange(): void {
    syncSurfaceVisibility(host)
    if (document.hidden) {
      clearCopyResultTimer()
      copyArmed = false
      copyResultButton.textContent = labels.copy
      panelAnnouncement.textContent = ''
      if (pendingRaf !== 0) {
        cancelAnimationFrame(pendingRaf)
        pendingRaf = 0
      }
      if (pauseRaf !== 0) {
        cancelAnimationFrame(pauseRaf)
        pauseRaf = 0
      }
      return
    }
    onGlobalResize()
  }
  document.addEventListener('keydown', onGlobalKeydown, true)
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  document.addEventListener('scroll', onGlobalScroll, true)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('resize', onGlobalResize)
  function removeGlobalListeners(): void {
    document.removeEventListener('keydown', onGlobalKeydown, true)
    document.removeEventListener('pointerdown', onGlobalPointerDown, true)
    document.removeEventListener('scroll', onGlobalScroll, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('resize', onGlobalResize)
  }

  closeButton.addEventListener('click', () => close(undefined, true))
  copyResultButton.addEventListener('click', () => {
    copyArmed = true
    onCopyResult(resultText)
  })
  function onErrorDetailsToggle(event: Event): void {
    if (disposed) return
    if (event.currentTarget === panelErrorDetails.element && state === 'panel') positionPanel()
    if (event.currentTarget === noticeErrorDetails.element) schedulePausePosition()
  }
  panelErrorDetails.element.addEventListener('toggle', onErrorDetailsToggle)
  noticeErrorDetails.element.addEventListener('toggle', onErrorDetailsToggle)
  literalButton.addEventListener('click', (event) => {
    if (!event.isTrusted) return
    if (feedbackError) onRetry()
    else onLiteral()
  })
  resumeButton.addEventListener('click', (event) => {
    if (!event.isTrusted || resumeButton.disabled || !pauseShown) return
    setPauseStatus(undefined, false)
    onResume()
  })
  pauseClose.addEventListener('click', (event) => {
    if (!event.isTrusted) return
    pauseDismissed = true
    pauseShown = false
    pauseStatus.style.display = 'none'
    floatingEntry?.setNoticeVisible(false)
    if (event.detail === 0) floatingEntry?.closeMenu(true)
    applyState(state)
  })
  dismissProactiveButton.addEventListener('click', () => {
    close(undefined, true)
    onDismissProactive()
  })
  hint.addEventListener('click', (event) => {
    applyState('panel')
    onHintOpen()
    if (event.detail === 0) closeButton.focus({ preventScroll: true })
  })
  toolbar.addEventListener('pointerdown', (event) => {
    event.preventDefault()
  })
  toolbar.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const controls = enabledToolbarButtons()
    if (controls.length === 0) return
    const active =
      shadow.activeElement instanceof HTMLButtonElement && controls.includes(shadow.activeElement)
        ? shadow.activeElement
        : (event.target as HTMLButtonElement)
    const index = controls.indexOf(active)
    if (index < 0) return
    event.preventDefault()
    const next = controls[(index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length]
    if (next === undefined) return
    syncToolbarTabindex(next)
    next.focus({ preventScroll: true })
  })
  for (const [action, button] of actionButtons) {
    button.addEventListener('click', (event) => {
      if (!event.isTrusted || button.disabled || state !== 'toolbar') return
      toolbarAction?.(action)
    })
  }
  toolbarClose.addEventListener('click', () => close(undefined, true))

  function setStyle(style: UiStyle): void {
    currentUiStyle = style
    applySurfacePreferences(host, { uiStyle: style })
    for (const el of [panel, hint, pauseStatus, toolbar]) {
      if (style === 'classic') el.removeAttribute('data-style')
      else el.setAttribute('data-style', style)
    }
    floatingEntry?.setStyle(style)
  }

  return {
    setStyle,
    setPreferences(preferences) {
      applySurfacePreferences(host, preferences)
      setStyle(preferences.uiStyle)
    },
    setLabels,
    showToolbar(nextAnchor, configured, onAction) {
      anchor = nextAnchor
      toolbarAction = onAction
      copyFeedback = undefined
      toolbarAnnouncement.textContent = ''
      copyButton.textContent = labels.copy
      applyToolbarModelLock(configured)
      resetBody()
      setStatus('', false)
      applyState('toolbar')
    },
    setToolbarCopyResult(copied) {
      if (state !== 'toolbar') return
      copyFeedback = copied
      copyButton.textContent = copied ? labels.copied : labels.copyFailed
      toolbarAnnouncement.textContent = copyButton.textContent
    },
    focusToolbar() {
      if (state !== 'toolbar') return false
      const current = enabledToolbarButtons().find((button) => button.tabIndex === 0) ?? enabledToolbarButtons()[0]
      if (current === undefined) return false
      current.focus({ preventScroll: true })
      return shadow.activeElement === current
    },
    isOpen() {
      return state !== 'hidden' || floatingEntry?.isMenuOpen() === true
    },
    showSelection() {
      titleIntent = 'translate'
      title.textContent = labels.translate
      resetBody()
      setStatus(labels.loading, false)
      loading = true
      panel.setAttribute('aria-busy', 'true')
      applyState('panel')
    },
    showSelectionResult(source, translations) {
      titleIntent = 'translate'
      title.textContent = labels.translate
      resetBody()
      const answer = translations.join('\n')
      appendPair('', answer, false)
      appendPair(source, '', true)
      if (answer !== '') {
        resultText = answer
        actions.append(copyResultButton)
      }
      setStatus('', false)
      applyState('panel')
    },
    showAssist(source, result) {
      titleIntent = result.intent
      title.textContent = labels[titleIntent]
      resetBody()
      const answer = result.translation !== '' ? result.translation : result.explanation
      appendPair('', answer, false)
      if (result.translation !== '' && result.explanation !== '') {
        const note = document.createElement('div')
        note.className = 'panel-note'
        note.textContent = result.explanation
        body.append(note)
      }
      appendPair(source, '', true)
      if (answer !== '') {
        resultText = answer
        actions.append(copyResultButton)
      }
      moreBody.append(literalButton)
      if (result.intent !== 'none') moreBody.append(dismissProactiveButton)
      actions.append(moreActions)
      setStatus('', false)
      applyState('panel')
    },
    showHint(nextAnchor, onOpen) {
      anchor = nextAnchor
      onHintOpen = onOpen
      resetBody()
      setStatus('', false)
      applyState('hint')
    },
    showError(message) {
      resetBody()
      feedbackError = true
      panel.classList.add('is-feedback')
      feedbackMascot.hidden = mascotUrl === ''
      title.textContent = labels.failed ?? DEFAULT_LABELS.failed
      literalButton.textContent = labels.retry ?? DEFAULT_LABELS.retry
      panel.title = message
      panel.setAttribute('aria-description', message)
      panelErrorDetails.reason.textContent = message
      panelErrorDetails.element.hidden = message === ''
      if (message !== '') actions.append(literalButton)
      setStatus('', false)
      applyState('panel')
    },
    showNotice(message) {
      resetBody()
      setStatus(message, true)
      applyState('panel')
    },
    showPauseStatus(reason, resumable, actionLabel, kind) {
      setPauseStatus(reason, resumable, actionLabel, kind)
    },
    hidePauseStatus() {
      if (pauseKind !== undefined) setPauseStatus(undefined, false)
    },
    setAnchor(next) {
      anchor = next
    },
    containsEvent(event) {
      return isEventInside(event)
    },
    close,
    dispose() {
      disposed = true
      panelErrorDetails.element.removeEventListener('toggle', onErrorDetailsToggle)
      noticeErrorDetails.element.removeEventListener('toggle', onErrorDetailsToggle)
      pauseShown = false
      if (pauseRaf !== 0) cancelAnimationFrame(pauseRaf)
      pauseRaf = 0
      close()
      for (const { exit } of surfaceExits) exit.finish()
      if (floatingEntry !== undefined) {
        floatingEntry.dispose()
        floatingEntry = undefined
        document.removeEventListener('focusin', onDocumentFocusIn, true)
      }
      disconnectModalObserver()
      releaseModal()
      removeGlobalListeners()
      resizeObserver?.disconnect()
      if (pendingRaf !== 0) cancelAnimationFrame(pendingRaf)
      if (attached) {
        attached = false
        host.remove()
      }
    },
    setOnClose(handler) {
      onClose = handler
    },
    setOnResume(handler) {
      onResume = handler
    },
    setOnLiteral(handler) {
      onLiteral = handler
    },
    setOnRetry(handler) {
      onRetry = handler
    },
    setOnDismissProactive(handler) {
      onDismissProactive = handler
    },
    setOnCopyResult(handler) {
      onCopyResult = handler
    },
    setCopyResultFeedback(copied) {
      if (document.hidden || state !== 'panel' || !actions.contains(copyResultButton) || !copyArmed) return
      clearCopyResultTimer()
      const message = copied ? labels.copied : labels.copyFailed
      // 反馈写在按钮上；读屏通过隐藏的 live 区域得到同一条消息，不在状态区重复显示
      copyResultButton.textContent = message
      panelAnnouncement.textContent = message
      copyResultTimer = setTimeout(() => {
        copyResultTimer = undefined
        copyResultButton.textContent = labels.copy
        panelAnnouncement.textContent = ''
      }, 1500)
    },
    setFloating,
  }
}
