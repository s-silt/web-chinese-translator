import type { UiStyle } from '../shared/settings'
import { createFloatingEntry, type FloatingCallbacks, type FloatingEntry, type FloatingLabels, type FloatingView } from './floating'
import type { AssistResult } from './intent'
import type { SelectionAnchor } from './selection'

export type ToolbarAction = 'translate' | 'define' | 'explain' | 'copy'

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
}

export const DEFAULT_LABELS: PanelLabels = {
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
}

export interface TranslationPanel {
  /** 内容脚本卡片的界面风格；classic 移除 data-style */
  setStyle(style: 'classic' | 'cyber' | 'glass'): void
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
  showPauseStatus(reason: string, resumable: boolean, actionLabel?: string): void
  hidePauseStatus(): void
  setAnchor(anchor: SelectionAnchor | undefined): void
  containsEvent(event: Event): boolean
  /** 关闭卡片、提示与工具栏；默认一并收起悬浮菜单。页面动作（恢复/继续）由菜单触发时保留菜单，让结果与错误仍可见 */
  close(options?: { keepFloatingMenu?: boolean }): void
  dispose(): void
  setOnClose(handler: () => void): void
  setOnResume(handler: () => void): void
  setOnLiteral(handler: () => void): void
  setOnDismissProactive(handler: () => void): void
  setOnCopyResult(handler: (text: string) => void): void
  setCopyResultFeedback(copied: boolean): void
  setFloating(view: FloatingView, labels: FloatingLabels, callbacks: FloatingCallbacks): void
}

type PanelState = 'hidden' | 'hint' | 'panel' | 'toolbar'

const PANEL_CSS = `
.panel, .hint, .pause-status, .selection-toolbar {
  box-sizing: border-box;
  font: 13px/1.5 -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.panel[data-style='cyber'], .hint[data-style='cyber'], .pause-status[data-style='cyber'], .selection-toolbar[data-style='cyber'] {
  color: #e7f4ff; background: #0a1424; border: 1px solid #264561; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(6, 16, 30, 0.42), 0 0 18px #1aa6d914;
}
.panel[data-style='cyber'], .hint[data-style='cyber'] {
  background-image:
    linear-gradient(#55e5ff, #55e5ff), linear-gradient(#55e5ff, #55e5ff),
    linear-gradient(#55e5ff, #55e5ff), linear-gradient(#55e5ff, #55e5ff),
    linear-gradient(#55e5ff, #55e5ff), linear-gradient(#55e5ff, #55e5ff),
    linear-gradient(#55e5ff, #55e5ff), linear-gradient(#55e5ff, #55e5ff);
  background-size: 10px 1px, 1px 10px, 10px 1px, 1px 10px, 10px 1px, 1px 10px, 10px 1px, 1px 10px;
  background-position: 0 0, 0 0, 100% 0, 100% 0, 0 100%, 0 100%, 100% 100%, 100% 100%;
  background-repeat: no-repeat;
  opacity: 1;
}
.panel[data-style='cyber'] .panel-title, .hint[data-style='cyber'] {
  color: #55e5ff; font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
}
.panel[data-style='glass'], .hint[data-style='glass'], .pause-status[data-style='glass'], .selection-toolbar[data-style='glass'] {
  color: #1d2b43; background: rgba(255,255,255,.84); backdrop-filter: blur(24px) saturate(1.2);
  border: 1px solid rgba(255,255,255,.88); border-radius: 14px;
  box-shadow: 0 12px 32px rgba(36,56,92,.16), 0 2px 6px rgba(36,56,92,.06);
}
@media (prefers-color-scheme: dark) {
  .panel[data-style='glass'], .hint[data-style='glass'], .pause-status[data-style='glass'], .selection-toolbar[data-style='glass'] {
    color: #e6edf7; background: rgba(26,36,55,.84); border-color: rgba(255,255,255,.22);
    box-shadow: 0 12px 32px rgba(0,0,0,.36);
  }
}
@media (prefers-reduced-transparency: reduce) {
  .panel[data-style='glass'], .hint[data-style='glass'], .pause-status[data-style='glass'], .selection-toolbar[data-style='glass'] {
    background: #ffffff; backdrop-filter: none; border-color: #d0d7de;
  }
}
@media (prefers-color-scheme: dark) and (prefers-reduced-transparency: reduce) {
  .panel[data-style='glass'], .hint[data-style='glass'], .pause-status[data-style='glass'], .selection-toolbar[data-style='glass'] {
    background: #1c2536; backdrop-filter: none; border-color: #3d444d;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .panel, .hint, .selection-toolbar { transition: opacity 120ms ease; }
}
@media (prefers-color-scheme: dark) {
  .panel, .hint, .pause-status, .selection-toolbar { color: #e6edf3; background: #1c2128; border-color: #3d444d; }
}
.panel {
  position: fixed;
  z-index: 2147483647;
  max-height: min(480px, calc(100vh - 24px));
  display: flex;
  flex-direction: column;
  overflow: auto;
  pointer-events: auto;
}
.hint {
  position: fixed;
  z-index: 2147483647;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  pointer-events: auto;
}
.hint:hover { background: #f6f8fa; }
@media (prefers-color-scheme: dark) {
  .hint:hover { background: #2d333b; }
}
.hint[data-style='cyber']:hover { background-color: #102038; }
.hint[data-style='glass']:hover { background: rgba(255,255,255,.94); }
@media (prefers-color-scheme: dark) {
  .hint[data-style='glass']:hover { background: rgba(34,47,70,.9); }
}
.selection-toolbar {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  pointer-events: auto;
}
.toolbar-configure-hint {
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
}
.selection-toolbar button {
  flex: none;
  padding: 2px 8px;
  font: inherit;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}
.selection-toolbar button[data-action='translate'] {
  color: #fff;
  background: #1f6feb;
  border-color: #1f6feb;
}
.selection-toolbar[data-style='cyber'] button {
  border-color: #264561;
}
.selection-toolbar[data-style='cyber'] button[data-action='translate'] {
  color: #0b1526;
  background: #55e5ff;
  border-color: #55e5ff;
}
.selection-toolbar[data-style='glass'] button {
  border-color: rgba(255,255,255,.8);
  background: rgba(255,255,255,.35);
}
.selection-toolbar[data-style='glass'] button[data-action='translate'] {
  color: #fff;
  background: #1f6feb;
  border-color: #1f6feb;
}
@media (prefers-color-scheme: dark) {
  .selection-toolbar button { border-color: #3d444d; }
  .selection-toolbar[data-style='glass'] button {
    border-color: rgba(255,255,255,.2);
    background: rgba(255,255,255,.08);
  }
}
.selection-toolbar button:disabled {
  opacity: 0.45;
  cursor: default;
}
/* 未配置模型时主按钮不能再带主色填充，否则看起来比真正可用的「复制」更像可点 */
.selection-toolbar button[data-action='translate']:disabled,
.selection-toolbar[data-style] button[data-action='translate']:disabled {
  color: inherit;
  background: transparent;
  border-color: currentColor;
}
.panel button:focus-visible, .panel summary:focus-visible, .hint:focus-visible, .pause-resume:focus-visible, .selection-toolbar button:focus-visible {
  outline: 2px solid #1f6feb;
  outline-offset: 2px;
}
.selection-toolbar[data-style='cyber'] { background:#101c2e; border-radius:8px; }
.selection-toolbar[data-style='glass'] { border-color:#c1cddd; border-radius:18px; }
.panel[data-style='cyber'] button:focus-visible, .panel[data-style='cyber'] summary:focus-visible, .hint[data-style='cyber']:focus-visible, .pause-status[data-style='cyber'] .pause-resume:focus-visible, .selection-toolbar[data-style='cyber'] button:focus-visible {
  outline-color: #55e5ff;
}
@media (prefers-color-scheme: dark) {
  .selection-toolbar[data-style='glass'] { border-color: rgba(255,255,255,.2); }
}
.toolbar-close {
  padding: 0 6px;
  background: transparent;
  border: 0;
}
.toolbar-announcement, .panel-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px;
  font-weight: 600;
  border-bottom: 1px solid #d0d7de;
}
@media (prefers-color-scheme: dark) {
  .panel-header { border-color: #3d444d; }
}
.panel[data-style='cyber'] .panel-header { border-color: #1f3b54; }
.panel[data-style='glass'] .panel-header { border-color: rgba(29,43,67,.1); }
@media (prefers-color-scheme: dark) {
  .panel[data-style='glass'] .panel-header { border-color: rgba(255,255,255,.14); }
}
.panel-title { font-size: 12px; letter-spacing: .02em; }
.panel[data-style='glass'] .panel-title { color: #344865; }
@media (prefers-color-scheme: dark) {
  .panel[data-style='glass'] .panel-title { color: #c8d7ec; }
}
.panel-close {
  flex: none;
  padding: 2px 6px;
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 4px;
}
.panel-close:hover { background: rgba(128, 128, 128, 0.2); }
.panel-body { padding: 12px 16px; overflow-wrap: anywhere; }
.panel-source {
  color: #57606a;
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
}
@media (prefers-color-scheme: dark) {
  .panel-source { color: #8b949e; }
}
.panel[data-style='cyber'] .panel-source { color: #9fb8d0; }
.panel[data-style='glass'] .panel-source { color: #4f627d; }
@media (prefers-color-scheme: dark) {
  .panel[data-style='glass'] .panel-source { color: #a5b6cf; }
}
.panel-source + .panel-target { margin-top: 8px; }
.panel-target {
  color: inherit;
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.panel-note {
  margin-top: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: #57606a;
  white-space: pre-wrap;
}
@media (prefers-color-scheme: dark) {
  .panel-note { color: #8b949e; }
}
.panel[data-style='cyber'] .panel-note { color: #9fb8d0; }
.panel[data-style='glass'] .panel-note { color: #4a5d79; }
@media (prefers-color-scheme: dark) {
  .panel[data-style='glass'] .panel-note { color: #a9bbd4; }
}
details.panel-source {
  margin-top: 10px;
  padding: 6px 10px;
  font-size: 12px;
  background: rgba(128, 128, 128, 0.06);
  border: 1px solid rgba(128, 128, 128, 0.16);
  border-radius: 6px;
}
.panel[data-style='cyber'] details.panel-source {
  background: rgba(16, 31, 53, 0.72);
  border-color: #213e59;
}
.panel[data-style='glass'] details.panel-source {
  background: rgba(255, 255, 255, 0.45);
  border-color: rgba(255, 255, 255, 0.72);
}
@media (prefers-color-scheme: dark) {
  .panel[data-style='glass'] details.panel-source {
    background: rgba(15, 23, 38, 0.42);
    border-color: rgba(255, 255, 255, 0.14);
  }
}
.panel-source summary {
  cursor: pointer;
  font-weight: 500;
  user-select: none;
}
.panel[data-style='cyber'] .panel-source summary { color: #7dd8f0; }
details.panel-source > div { margin-top: 6px; }
.panel-status { padding: 10px 16px; color: #57606a; font-size: 12px; line-height: 1.55; }
@media (prefers-color-scheme: dark) {
  .panel-status { color: #8b949e; }
}
.panel[data-style='cyber'] .panel-status { color: #9fb8d0; }
.panel-status-error { color: #cf222e; }
@media (prefers-color-scheme: dark) {
  .panel-status-error { color: #f85149; }
}
.panel[data-style='cyber'] .panel-status-error { color: #ff7b72; }
.panel-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 16px 12px;
}
.panel-actions button {
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  color: #1f6feb;
  cursor: pointer;
  background: transparent;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}
.panel-actions button.panel-copy {
  color: #ffffff;
  background: #1f6feb;
  border-color: #1f6feb;
  font-weight: 500;
}
@media (prefers-color-scheme: dark) {
  .panel-actions button { color: #539bf5; border-color: #3d444d; }
  .panel-actions button.panel-copy { color: #ffffff; background: #1f6feb; border-color: #1f6feb; }
}
.panel[data-style='cyber'] .panel-actions button {
  color: #9feaff;
  background: rgba(85, 229, 255, 0.08);
  border-color: #2b5274;
}
.panel[data-style='cyber'] .panel-actions button.panel-copy {
  color: #081221;
  background: #55e5ff;
  border-color: #55e5ff;
  font-weight: 600;
}
.panel[data-style='glass'] .panel-actions button {
  color: #1d2b43;
  background: rgba(255, 255, 255, 0.52);
  border-color: rgba(255, 255, 255, 0.8);
}
.panel[data-style='glass'] .panel-actions button.panel-copy {
  color: #ffffff;
  background: #1f6feb;
  border-color: #1f6feb;
}
@media (prefers-color-scheme: dark) {
  .panel[data-style='glass'] .panel-actions button {
    color: #e6edf7;
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .panel[data-style='glass'] .panel-actions button.panel-copy {
    color: #ffffff;
    background: #1f6feb;
    border-color: #1f6feb;
  }
}
.pause-status {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100vw - 32px));
  padding: 6px 10px;
  font-size: 12px;
  overflow-wrap: anywhere;
  pointer-events: auto;
}
.pause-reason { color: #cf222e; }
@media (prefers-color-scheme: dark) {
  .pause-reason { color: #f85149; }
}
.pause-resume {
  flex: none;
  padding: 2px 8px;
  font: inherit;
  color: #fff;
  cursor: pointer;
  background: #1f6feb;
  border: 1px solid #1f6feb;
  border-radius: 6px;
}
.panel-source details { font-size: 12px; }
`

const GAP = 8
const MARGIN = 12

export function createTranslationPanel(): TranslationPanel {
  const host = document.createElement('div')
  host.setAttribute('data-wt-root', '')
  host.style.cssText =
    'all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: none !important; contain: style !important;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  let labels = DEFAULT_LABELS
  let titleIntent: AssistResult['intent'] = 'translate'
  let loading = false
  let defaultResumeLabel = true
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
  const closeButton = document.createElement('button')
  closeButton.className = 'panel-close'
  closeButton.type = 'button'
  closeButton.textContent = '✕'
  closeButton.setAttribute('aria-label', labels.close)
  header.append(title, closeButton)
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
  const pauseStatus = document.createElement('div')
  pauseStatus.className = 'pause-status'
  pauseStatus.setAttribute('role', 'status')
  pauseStatus.style.display = 'none'
  const pauseReason = document.createElement('span')
  pauseReason.className = 'pause-reason'
  const resumeButton = document.createElement('button')
  resumeButton.className = 'pause-resume'
  resumeButton.type = 'button'
  resumeButton.textContent = labels.resume
  pauseStatus.append(pauseReason, resumeButton)
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
  panel.append(header, body, status, actions, panelAnnouncement)
  shadow.append(style, panel, hint, pauseStatus, toolbar)

  let attached = false
  let modalHost: HTMLDialogElement | undefined
  let state: PanelState = 'hidden'
  let pauseShown = false
  let currentUiStyle: UiStyle = 'classic'
  let floatingEntry: FloatingEntry | undefined
  let modalObserver: MutationObserver | undefined
  let observedModalHost: HTMLDialogElement | undefined
  let anchor: SelectionAnchor | undefined
  let onClose: () => void = () => undefined
  let onResume: () => void = () => undefined
  let onLiteral: () => void = () => undefined
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
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (pendingRaf !== 0 || (state !== 'panel' && state !== 'toolbar')) return
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = 0
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
    const maxWidth = Math.max(1, Math.min(360 / scale, viewW - margin * 2))
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
    const visible = state !== 'hidden' || pauseShown || floatingEntry !== undefined
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
    if (pauseShown) elements.push(pauseStatus)
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
    if (!view.visible) {
      if (floatingEntry !== undefined) {
        floatingEntry.dispose()
        floatingEntry = undefined
        document.removeEventListener('focusin', onDocumentFocusIn, true)
        disconnectModalObserver()
        syncHostAttachment()
      }
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
    syncHostAttachment()
    floatingEntry.reposition()
  }

  function applyState(next: PanelState): void {
    if ((next === 'panel' || next === 'hint' || next === 'toolbar') && floatingEntry?.isMenuOpen() === true) {
      floatingEntry.closeMenu()
    }
    const previousTarget = layoutTarget()
    state = next
    syncHostAttachment()
    panel.style.display = next === 'panel' ? '' : 'none'
    hint.style.display = next === 'hint' ? '' : 'none'
    toolbar.style.display = next === 'toolbar' ? '' : 'none'
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

  /** 暂停状态独立于卡片：滚动、点击页面或关闭卡片都不会让它消失，只有继续或恢复才移除。 */
  function setPauseStatus(reason: string | undefined, resumable: boolean, actionLabel?: string): void {
    pauseShown = reason !== undefined
    pauseReason.textContent = reason ?? ''
    defaultResumeLabel = actionLabel === undefined
    resumeButton.textContent = actionLabel ?? labels.resume
    resumeButton.style.display = resumable ? '' : 'none'
    pauseStatus.style.display = pauseShown ? '' : 'none'
    applyState(state)
    floatingEntry?.reposition()
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
    labels = next
    panel.setAttribute('aria-label', labels.result)
    closeButton.setAttribute('aria-label', labels.close)
    title.textContent = labels[titleIntent]
    if (copyResultTimer === undefined) copyResultButton.textContent = labels.copy
    literalButton.textContent = labels.literal
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
    if (defaultResumeLabel) resumeButton.textContent = labels.resume
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
  }

  function close(options?: { keepFloatingMenu?: boolean }): void {
    clearCopyResultTimer()
    if (options?.keepFloatingMenu !== true) floatingEntry?.closeMenu()
    if (state === 'hidden') return
    onHintOpen = () => undefined
    resetBody()
    setStatus('', false)
    toolbarAction = undefined
    copyFeedback = undefined
    copyButton.textContent = labels.copy
    toolbarAnnouncement.textContent = ''
    applyState('hidden')
    resizeObserver?.unobserve(panel)
    resizeObserver?.unobserve(toolbar)
    onClose()
  }

  function onModalClose(event: Event): void {
    if (modalHost === undefined || event.currentTarget !== modalHost || modalHost.open) return
    if (state !== 'hidden') close()
    else applyState('hidden')
  }

  function onGlobalKeydown(event: KeyboardEvent): void {
    const menu = floatingEntry?.isMenuOpen() === true
    if (event.key === 'Escape' && (state !== 'hidden' || menu)) {
      if (modalHost !== undefined) {
        event.preventDefault()
        event.stopPropagation()
      }
      if (menu) floatingEntry?.closeMenu(true)
      if (state !== 'hidden') close()
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
    if (state === 'panel') positionPanel()
    else if (state === 'hint') positionElement(hint, 6)
    else if (state === 'toolbar') positionElement(toolbar, 6)
    else floatingEntry?.reposition()
  }
  document.addEventListener('keydown', onGlobalKeydown, true)
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  document.addEventListener('scroll', onGlobalScroll, true)
  window.addEventListener('resize', onGlobalResize)
  function removeGlobalListeners(): void {
    document.removeEventListener('keydown', onGlobalKeydown, true)
    document.removeEventListener('pointerdown', onGlobalPointerDown, true)
    document.removeEventListener('scroll', onGlobalScroll, true)
    window.removeEventListener('resize', onGlobalResize)
  }

  closeButton.addEventListener('click', () => close())
  copyResultButton.addEventListener('click', () => {
    copyArmed = true
    onCopyResult(resultText)
  })
  literalButton.addEventListener('click', () => {
    onLiteral()
  })
  resumeButton.addEventListener('click', () => {
    setPauseStatus(undefined, false)
    onResume()
  })
  dismissProactiveButton.addEventListener('click', () => {
    close()
    onDismissProactive()
  })
  hint.addEventListener('click', () => {
    applyState('panel')
    onHintOpen()
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
  toolbarClose.addEventListener('click', () => close())

  return {
    setStyle(style) {
      currentUiStyle = style
      for (const el of [panel, hint, pauseStatus, toolbar]) {
        if (style === 'classic') el.removeAttribute('data-style')
        else el.setAttribute('data-style', style)
      }
      floatingEntry?.setStyle(style)
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
      applyState('panel')
    },
    showSelectionResult(source, translations) {
      titleIntent = 'translate'
      title.textContent = labels.translate
      resetBody()
      const answer = translations.join('\n')
      appendPair(source, answer, false)
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
      actions.append(literalButton)
      if (result.intent !== 'none') actions.append(dismissProactiveButton)
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
      if (message !== '') actions.append(literalButton)
      setStatus(message, true)
      applyState('panel')
    },
    showNotice(message) {
      resetBody()
      setStatus(message, true)
      applyState('panel')
    },
    showPauseStatus(reason, resumable, actionLabel) {
      setPauseStatus(reason, resumable, actionLabel)
    },
    hidePauseStatus() {
      if (pauseShown) setPauseStatus(undefined, false)
    },
    setAnchor(next) {
      anchor = next
    },
    containsEvent(event) {
      return isEventInside(event)
    },
    close,
    dispose() {
      pauseShown = false
      close()
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
    setOnDismissProactive(handler) {
      onDismissProactive = handler
    },
    setOnCopyResult(handler) {
      onCopyResult = handler
    },
    setCopyResultFeedback(copied) {
      if (state !== 'panel' || !actions.contains(copyResultButton) || !copyArmed) return
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
