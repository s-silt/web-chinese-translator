import {
  isChatEditorCandidate,
  isChatPlainEditor,
  readChatDraft,
  type ChatReplacementRequest,
  type ChatReplacementStatus,
} from './chat-input'
import { copySelectionText } from './clipboard'
import {
  INPUT_AUTO_REPLACE_DELAY_DEFAULT,
  isInputAutoReplaceDelay,
  isInputReplaceMode,
  type InputReplaceMode,
} from './config'
import {
  isDiscordPlainEditor,
  readDiscordDraft,
  type DiscordReplacementRequest,
  type DiscordReplacementStatus,
} from './discord-input'
import { createId } from './id'
import type { LiveTranslationOptions, LiveTranslationWatcher } from './live-translation'
import {
  isNativeVideoChatEditor,
  nativeVideoChatKind,
  planNativeVideoChatDraft,
  readNativeVideoChatDraft,
} from './video-chat-input'
import { DEFAULT_INPUT_REPLACE_KEY, formatHotkey, matchesHotkey, normalizeHotkey } from './input-hotkey'
import type { TranslationReply } from './messages'
import { closestComposed } from './sites'
import {
  isCandidateDraft,
  TARGET_LANGUAGE_NATIVE_LABEL,
  type SourceLanguage,
  type TargetLanguage,
} from './target-language'

export { isCandidateDraft } from './target-language'

export interface InputTranslationWatcher extends LiveTranslationWatcher {
  translateAndReplace(): boolean
}

export interface InputTranslationOptions extends Omit<LiveTranslationOptions, 'translate'> {
  readonly translate: (
    texts: string[],
    requestId: string,
    manualInput?: boolean,
  ) => Promise<TranslationReply<'wt:translate'>>
  readonly autoPreview?: () => boolean
  readonly sourceLanguage?: () => SourceLanguage
  readonly targetLanguage?: () => TargetLanguage
  readonly replaceKey?: () => string
  readonly replaceMode?: () => InputReplaceMode
  readonly autoReplaceDelayMs?: () => number
  replaceDiscordInput?: (request: DiscordReplacementRequest) => Promise<DiscordReplacementStatus>
  replaceChatInput?: (request: ChatReplacementRequest) => Promise<ChatReplacementStatus>
}

const DEBOUNCE_MS = 600

const RICH_EDITOR_SELECTOR =
  '.ProseMirror,[data-lexical-editor],[data-slate-editor],.DraftEditor-root,.ql-editor,.ck-editor,.monaco-editor,.cm-editor,.CodeMirror'

const SENSITIVE_AUTOCOMPLETE = /^(?:username|current-password|new-password|one-time-code|cc-[a-z-]+)$/i
const SENSITIVE_METADATA_PATTERN =
  /(?:pass(?:word|code|phrase)?|pwd|token|secret|api[-_\s]?key|private[-_\s]?key|access[-_\s]?key|auth(?:entication)?[-_\s]?(?:code|key|token)?|otp|totp|2fa|mfa|verif(?:y|ication)[-_\s]?code|security[-_\s]?code|card[-_\s]?(?:number|no|num)|credit[-_\s]?card|debit[-_\s]?card|cvv|cvc|csc|pin(?:\b|[-_\s]?code)|ssn|tax[-_\s]?id|bank[-_\s]?account|routing[-_\s]?number|iban|swift|mnemonic|seed[-_\s]?phrase|密码|口令|密钥|秘钥|私钥|令牌|验证码|动态码|安全码|校验码|银行卡|信用卡|卡号|身份证|社保|支付密码|助记词|パスワード|暗証番号|トークン|シークレット|秘密鍵|APIキー|認証コード|確認コード|ワンタイム|セキュリティコード|カード番号|クレジットカード|口座番号)/i

const PLAIN_EDITABLE_CHILD_TAGS = new Set(['BR', 'DIV', 'P'])

const INPUT_POPOVER_CSS = `
.popover {
  box-sizing: border-box;
  position: fixed;
  z-index: 2147483647;
  max-width: min(360px, calc(100vw - 24px));
  min-width: 200px;
  padding: 10px 12px;
  font: 13px/1.5 -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #24374a;
  background: #f8fafc;
  border: 1px solid #d4dee8;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(6, 16, 30, 0.16);
  pointer-events: auto;
}
@media (prefers-color-scheme: dark) {
  .popover {
    color: #dce7ef;
    background: #182534;
    border-color: #3a4c5d;
  }
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.title {
  font-size: 11px;
  font-weight: 600;
  color: #63778a;
}
@media (prefers-color-scheme: dark) {
  .title { color: #a6b6c4; }
}
.close {
  flex: none;
  padding: 0 4px;
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 4px;
}
.status {
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.status.is-error {
  color: #cf222e;
  font-size: 12px;
}
@media (prefers-color-scheme: dark) {
  .status.is-error { color: #f85149; }
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.actions:empty {
  display: none;
}
.actions button {
  padding: 2px 10px;
  font: inherit;
  font-size: 12px;
  color: #24374a;
  cursor: pointer;
  background: transparent;
  border: 1px solid #d4dee8;
  border-radius: 6px;
}
.actions button[data-action='replace'] {
  color: #ffffff;
  background: #1f6feb;
  border-color: #1f6feb;
  font-weight: 500;
}
@media (prefers-color-scheme: dark) {
  .actions button {
    color: #dce7ef;
    border-color: #3a4c5d;
  }
  .actions button[data-action='replace'] {
    color: #ffffff;
    background: #1f6feb;
    border-color: #1f6feb;
  }
}
.popover button:focus-visible {
  outline: 2px solid #1f6feb;
  outline-offset: 2px;
}
.auto-hint {
  font-size: 11px;
  color: #63778a;
}
@media (prefers-color-scheme: dark) {
  .auto-hint { color: #a6b6c4; }
}
`

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement

function isTextControl(node: Element): node is HTMLInputElement | HTMLTextAreaElement {
  if (node instanceof HTMLTextAreaElement) return true
  if (node instanceof HTMLInputElement) {
    // 网页里的搜索框按普通文本处理；网址、邮箱、数字等格式化字段译了反而不能用
    const rawAttr = (node.getAttribute('type') ?? '').trim().toLowerCase()
    if (rawAttr !== '' && rawAttr !== 'text' && rawAttr !== 'search') return false
    return node.type === 'text' || node.type === 'search' || node.type === ''
  }
  return false
}

function isPlainContentEditable(node: Element): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false
  const attr = node.getAttribute('contenteditable')
  if (attr === null) {
    if (!node.isContentEditable) return false
  } else {
    const normalized = attr.trim().toLowerCase()
    if (normalized !== '' && normalized !== 'true' && normalized !== 'plaintext-only') return false
  }
  if (closestComposed(node, RICH_EDITOR_SELECTOR) !== null) return false
  const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT)
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    if (!(current instanceof Element)) continue
    if (!PLAIN_EDITABLE_CHILD_TAGS.has(current.tagName)) return false
    if (current.attributes.length > 0) return false
  }
  return true
}

function collectLabelsText(element: HTMLElement): string {
  const parts: string[] = []
  const push = (val: string | null | undefined): void => {
    if (typeof val === 'string' && val.trim() !== '') parts.push(val.trim())
  }
  push(element.getAttribute('name'))
  push(element.getAttribute('id'))
  push(element.getAttribute('placeholder'))
  push(element.getAttribute('aria-label'))
  push(element.getAttribute('title'))
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null && labelledBy.trim() !== '') {
    const root = element.getRootNode()
    const scope: Document | ShadowRoot | null =
      root instanceof Document || root instanceof ShadowRoot ? root : null
    for (const id of labelledBy.trim().split(/\s+/)) {
      const labelEl = scope?.getElementById(id) ?? element.ownerDocument.getElementById(id)
      push(labelEl?.textContent)
    }
  }
  if ('labels' in element) {
    const labels = (element as HTMLInputElement | HTMLTextAreaElement).labels
    if (labels !== null && labels !== undefined) {
      for (let i = 0; i < labels.length; i += 1) {
        push(labels[i]?.textContent)
      }
    }
  }
  const parentLabel = closestComposed(element, 'label')
  if (parentLabel !== null) push(parentLabel.textContent)
  const id = element.id
  if (id !== '') {
    try {
      const root = element.getRootNode()
      const scope: Document | ShadowRoot =
        root instanceof Document || root instanceof ShadowRoot ? root : element.ownerDocument
      const selector = `label[for="${CSS.escape(id)}"]`
      const explicitLabel = scope.querySelector(selector) ?? element.ownerDocument.querySelector(selector)
      push(explicitLabel?.textContent)
    } catch {
      void 0
    }
  }
  return parts.join(' ')
}

function isSensitiveField(element: HTMLElement): boolean {
  if (closestComposed(element, '[data-sensitive],[data-wt-root]') !== null) return true
  const autoComplete = (element.getAttribute('autocomplete') ?? '').trim().toLowerCase()
  if (autoComplete !== '') {
    const tokens = autoComplete.split(/\s+/)
    if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE.test(token))) return true
  }
  const metadata = collectLabelsText(element)
  if (metadata !== '' && SENSITIVE_METADATA_PATTERN.test(metadata)) return true
  const form = closestComposed(element, 'form')
  if (form !== null && form instanceof HTMLElement) {
    if (form.querySelector('input[type="password" i]') !== null) return true
    const formMeta = [form.getAttribute('name'), form.getAttribute('id'), form.getAttribute('action'), form.getAttribute('aria-label')]
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .join(' ')
    if (formMeta !== '' && SENSITIVE_METADATA_PATTERN.test(formMeta)) return true
  }
  return false
}

function isHiddenOrDisabled(element: HTMLElement): boolean {
  if (!element.isConnected) return true
  if (element.hidden || closestComposed(element, '[hidden],[inert],[aria-hidden="true"]') !== null) return true
  if ((element as HTMLElement & { inert?: boolean }).inert === true) return true
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly) return true
  }
  if (element.getAttribute('aria-disabled') === 'true' || closestComposed(element, '[aria-disabled="true"],[aria-readonly="true"]') !== null) {
    return true
  }
  const style = element.style
  if (style.display === 'none' || style.visibility === 'hidden') return true
  return false
}

function resolveEditableField(target: EventTarget | null): EditableElement | undefined {
  let node: Node | null = target instanceof Node ? target : null
  while (node !== null && !(node instanceof Element)) {
    node = node.parentNode
  }
  if (!(node instanceof Element)) return undefined
  if (closestComposed(node, '[data-wt-root]') !== null) return undefined
  if (isTextControl(node)) {
    if (isHiddenOrDisabled(node) || isSensitiveField(node)) return undefined
    if (closestComposed(node, RICH_EDITOR_SELECTOR) !== null) return undefined
    return node
  }
  let current: Element | null = node
  while (current !== null) {
    if (current instanceof HTMLElement && current.hasAttribute('contenteditable')) {
      break
    }
    if (current.parentElement !== null) {
      current = current.parentElement
    } else {
      break
    }
  }
  const editableCandidate =
    current instanceof HTMLElement && current.hasAttribute('contenteditable')
      ? current
      : node instanceof HTMLElement && node.isContentEditable
        ? node
        : undefined
  if (editableCandidate === undefined) return undefined
  if (isHiddenOrDisabled(editableCandidate) || isSensitiveField(editableCandidate)) return undefined
  if (isDiscordPlainEditor(editableCandidate)) return editableCandidate
  if (isChatPlainEditor(editableCandidate)) return editableCandidate
  if (isNativeVideoChatEditor(editableCandidate)) return editableCandidate
  if (nativeVideoChatKind(editableCandidate) !== undefined) return undefined
  if (!isPlainContentEditable(editableCandidate)) return undefined
  return editableCandidate
}

function isCurrentEditable(field: EditableElement): boolean {
  return resolveEditableField(field) === field
}

function readPlainEditable(element: HTMLElement): string {
  let result = ''
  for (const node of element.childNodes) {
    if (node instanceof Text) {
      result += node.data
    } else if (node instanceof HTMLElement && node.tagName === 'BR') {
      result += '\n'
    } else if (node instanceof HTMLElement) {
      if (result !== '' && !result.endsWith('\n')) result += '\n'
      result += readPlainEditable(node)
      if (node.nextSibling !== null && !result.endsWith('\n')) result += '\n'
    }
  }
  return result
}

function readFieldValue(field: EditableElement): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value
  }
  if (isDiscordPlainEditor(field)) return readDiscordDraft(field)
  if (isChatPlainEditor(field)) return readChatDraft(field)
  if (isNativeVideoChatEditor(field)) return readNativeVideoChatDraft(field)
  return readPlainEditable(field)
}

function setNativeControlValue(control: HTMLInputElement | HTMLTextAreaElement, nextValue: string): void {
  const proto =
    control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  if (descriptor?.set !== undefined) {
    descriptor.set.call(control, nextValue)
  } else {
    control.value = nextValue
  }
}

function moveCaretToEnd(field: EditableElement): void {
  try {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      const len = field.value.length
      field.setSelectionRange(len, len)
      return
    }
    const selection = window.getSelection()
    if (selection === null) return
    const range = document.createRange()
    range.selectNodeContents(field)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  } catch {
    void 0
  }
}

function applyFieldReplacement(
  field: EditableElement,
  expectedBefore: string,
  nextValue: string,
): 'ok' | 'changed' | 'canceled' | 'failed' | 'failed-modified' {
  if (!isCurrentEditable(field)) return 'failed'
  if (readFieldValue(field) !== expectedBefore) return 'changed'

  const normalizedNext = nextValue.replace(/\r\n?/g, '\n')
  const nativeVideoField: HTMLElement | undefined =
    field instanceof HTMLElement && isNativeVideoChatEditor(field) ? field : undefined
  const plan =
    nativeVideoField !== undefined && planNativeVideoChatDraft(expectedBefore) !== undefined
      ? planNativeVideoChatDraft(normalizedNext)
      : undefined
  if (nativeVideoField !== undefined && plan === undefined) return 'failed'

  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: 'insertReplacementText',
    data: normalizedNext,
  })
  const allowed = field.dispatchEvent(beforeInput)
  if (!allowed || beforeInput.defaultPrevented) return 'canceled'
  if (!isCurrentEditable(field)) return 'failed'
  if (readFieldValue(field) !== expectedBefore) return 'changed'

  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    setNativeControlValue(field, normalizedNext)
  } else if (nativeVideoField !== undefined && plan !== undefined) {
    const field = nativeVideoField
    let wrote = false
    const getSelectionForField = (): Selection | null => {
      const root = field.getRootNode()
      const shadowSelection =
        root instanceof ShadowRoot
          ? (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
          : undefined
      return shadowSelection ?? field.ownerDocument.getSelection()
    }
    const canEdit = (): boolean => {
      if (!isCurrentEditable(field) || deepActiveElement(field.ownerDocument) !== field) return false
      const currentSelection = getSelectionForField()
      return (
        currentSelection !== null &&
        field.contains(currentSelection.anchorNode) &&
        field.contains(currentSelection.focusNode)
      )
    }
    const edit = (command: string, value?: string): boolean => {
      if (!canEdit()) return false
      const ok = field.ownerDocument.execCommand(command, false, value)
      if (ok) wrote = true
      return ok
    }
    const failure = (): 'failed' | 'failed-modified' => {
      if (readNativeVideoChatDraft(field) === expectedBefore) return 'failed'
      if (wrote && canEdit()) {
        try {
          field.ownerDocument.execCommand('undo', false)
        } catch {
          void 0
        }
      }
      return readNativeVideoChatDraft(field) === expectedBefore ? 'failed' : 'failed-modified'
    }
    try {
      if (
        (plan.lines.length > 1 || plan.trailingBreaks > 0) &&
        typeof field.ownerDocument.queryCommandSupported === 'function' &&
        !field.ownerDocument.queryCommandSupported('insertLineBreak')
      ) {
        return failure()
      }
      field.focus({ preventScroll: true })
      if (!isCurrentEditable(field)) return failure()
      if (readFieldValue(field) !== expectedBefore) return 'changed'
      const selection = getSelectionForField()
      if (selection === null || typeof field.ownerDocument.execCommand !== 'function') return failure()
      const range = field.ownerDocument.createRange()
      range.selectNodeContents(field)
      selection.removeAllRanges()
      selection.addRange(range)
      if (plan.lines.length === 1 && plan.trailingBreaks === 0) {
        if (!edit('insertText', normalizedNext)) return failure()
      } else {
        if (!edit('delete')) return failure()
        const first = plan.lines[0] ?? ''
        if (first !== '' && !edit('insertText', first)) return failure()
        for (const line of plan.lines.slice(1)) {
          if (!edit('insertLineBreak')) return failure()
          if (line !== '' && !edit('insertText', line)) return failure()
        }
        for (let i = 0; i < plan.trailingBreaks; i += 1) {
          if (!edit('insertLineBreak')) return failure()
        }
      }
      if (!isCurrentEditable(field) || readFieldValue(field) !== normalizedNext) return failure()
      return 'ok'
    } catch {
      return failure()
    }
  } else {
    const fragment = field.ownerDocument.createDocumentFragment()
    normalizedNext.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
      if (index > 0) fragment.append(field.ownerDocument.createElement('br'))
      fragment.append(field.ownerDocument.createTextNode(line))
    })
    const range = field.ownerDocument.createRange()
    range.selectNodeContents(field)
    range.deleteContents()
    range.insertNode(fragment)
  }
  const inputEvent = new InputEvent('input', {
    bubbles: true,
    cancelable: false,
    composed: true,
    inputType: 'insertReplacementText',
    data: normalizedNext,
  })
  field.dispatchEvent(inputEvent)
  if (!isCurrentEditable(field) || readFieldValue(field) !== normalizedNext) return 'failed'
  try {
    field.focus({ preventScroll: true })
  } catch {
    void 0
  }
  moveCaretToEnd(field)
  return 'ok'
}

const MANAGED_BRIDGE_MS = 5000
const MANAGED_SETTLE_MS = 250

function deepActiveElement(doc: Document = document): Element | null {
  let active: Element | null = doc.activeElement
  for (
    let depth = 0;
    depth < 32 && active?.shadowRoot?.activeElement !== undefined && active?.shadowRoot?.activeElement !== null;
    depth += 1
  ) {
    active = active.shadowRoot.activeElement
  }
  return active
}

function isSlateEditor(field: EditableElement): boolean {
  return field instanceof HTMLElement && field.hasAttribute('data-slate-editor')
}

function isManagedPlainEditor(field: EditableElement): field is HTMLElement {
  return isDiscordPlainEditor(field) || isChatPlainEditor(field)
}

function isManagedCandidate(field: EditableElement): field is HTMLElement {
  return isSlateEditor(field) || isChatEditorCandidate(field)
}

export function createInputTranslation(options: InputTranslationOptions): InputTranslationWatcher {
  let disposed = false
  let epoch = 0
  let activeField: EditableElement | undefined
  let composingField: EditableElement | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let beforeInputTimer: ReturnType<typeof setTimeout> | undefined
  let autoReplaceTimer: ReturnType<typeof setTimeout> | undefined
  let lastEditAt = 0
  let inFlightId: string | undefined
  let ownInputWrite: EditableElement | undefined
  let directReplaceRequestId: string | undefined
  let snapshotText = ''
  let previewTranslation = ''
  let recoveryOriginalText: string | undefined
  let suppressedSnapshot: { field: EditableElement; value: string } | undefined
  let backupState:
    | {
        readonly field: EditableElement
        readonly original: string
        readonly inserted: string
      }
    | undefined
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let copyOriginalTimer: ReturnType<typeof setTimeout> | undefined
  let pointerInsidePopover = false
  let replacementBusy = false
  let previewVisible = false
  let pendingManagedToken: { field: HTMLElement; token: string; attribute: 'data-wt-discord-input' | 'data-wt-chat-input' } | undefined

  const host = document.createElement('div')
  host.setAttribute('data-wt-root', '')
  host.style.cssText =
    'all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: none !important; contain: style !important;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = INPUT_POPOVER_CSS

  const popover = document.createElement('div')
  popover.className = 'popover'
  const header = document.createElement('div')
  header.className = 'header'
  const title = document.createElement('span')
  title.className = 'title'
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'close'
  closeButton.dataset.action = 'close'
  closeButton.textContent = '✕'
  header.append(title, closeButton)

  const statusNode = document.createElement('div')
  statusNode.className = 'status'
  statusNode.setAttribute('role', 'status')
  statusNode.setAttribute('aria-live', 'polite')

  const actions = document.createElement('div')
  actions.className = 'actions'

  const replaceButton = document.createElement('button')
  replaceButton.type = 'button'
  replaceButton.dataset.action = 'replace'

  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.dataset.action = 'copy'

  const copyOriginalButton = document.createElement('button')
  copyOriginalButton.type = 'button'
  copyOriginalButton.dataset.action = 'copy-original'

  const restoreButton = document.createElement('button')
  restoreButton.type = 'button'
  restoreButton.dataset.action = 'restore'

  const autoHintNode = document.createElement('span')
  autoHintNode.className = 'auto-hint'
  autoHintNode.dataset.action = 'auto-hint'

  popover.append(header, statusNode, actions)
  shadow.append(style, popover)

  function currentReplaceKey(): string {
    const raw = options.replaceKey === undefined ? DEFAULT_INPUT_REPLACE_KEY : options.replaceKey()
    return normalizeHotkey(raw) ?? DEFAULT_INPUT_REPLACE_KEY
  }

  function currentReplaceMode(): InputReplaceMode {
    const raw = options.replaceMode?.()
    return isInputReplaceMode(raw) ? raw : 'hotkey'
  }

  function currentAutoReplaceDelayMs(): number {
    const raw = options.autoReplaceDelayMs?.()
    return isInputAutoReplaceDelay(raw) ? raw : INPUT_AUTO_REPLACE_DELAY_DEFAULT
  }

  function isDraftCandidate(value: string): boolean {
    const source = options.sourceLanguage?.() ?? 'auto'
    const target = options.targetLanguage?.() ?? 'en'
    return isCandidateDraft(value, source, target)
  }

  function syncLabels(): void {
    const source = options.sourceLanguage?.() ?? 'auto'
    const target = options.targetLanguage?.() ?? 'en'
    const sourceLabel = source === 'auto' ? options.t('wtSourceAuto') : TARGET_LANGUAGE_NATIVE_LABEL[source]
    const targetLabel = TARGET_LANGUAGE_NATIVE_LABEL[target]
    title.textContent = `${options.t('wtInputTranslation')} · ${sourceLabel} → ${targetLabel}`
    closeButton.setAttribute('aria-label', options.t('wtPanelClose'))
    replaceButton.textContent = options.t('wtInputReplace')
    const replaceKey = currentReplaceKey()
    if (replaceKey === '') {
      replaceButton.title = options.t('wtInputReplaceClickHint')
      replaceButton.removeAttribute('aria-keyshortcuts')
    } else {
      const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
      const keyLabel = formatHotkey(replaceKey, isMac)
      // 调用方的 t 未必处理参数，此处兜底替换
      replaceButton.title = options.t('wtInputReplaceHint', { key: keyLabel }).replace('{key}', keyLabel)
      // ARIA 规定修饰键写作 Control
      replaceButton.setAttribute('aria-keyshortcuts', replaceKey.replace(/^Ctrl\+/, 'Control+'))
    }
    if (copyTimer === undefined) copyButton.textContent = options.t('wtToolbarCopy')
    if (copyOriginalTimer === undefined) copyOriginalButton.textContent = options.t('wtInputCopyOriginal')
    restoreButton.textContent = options.t('wtInputRestore')
  }

  function clearDebounce(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }

  function clearBeforeInput(): void {
    if (beforeInputTimer !== undefined) {
      clearTimeout(beforeInputTimer)
      beforeInputTimer = undefined
    }
  }

  function clearAutoReplace(): void {
    if (autoReplaceTimer !== undefined) {
      clearTimeout(autoReplaceTimer)
      autoReplaceTimer = undefined
     }
    autoHintNode.remove()
  }

  function clearCopyTimer(): void {
    if (copyTimer !== undefined) {
      clearTimeout(copyTimer)
      copyTimer = undefined
    }
    if (copyOriginalTimer !== undefined) {
      clearTimeout(copyOriginalTimer)
      copyOriginalTimer = undefined
    }
  }

  function cancelInFlight(): void {
    const id = inFlightId
    inFlightId = undefined
    directReplaceRequestId = undefined
    if (id !== undefined) {
      options.cancel(id)
    }
  }

  function eventTarget(event: Event): EventTarget | null {
    return event.composedPath()[0] ?? event.target
  }

  function focusedField(): EditableElement | undefined {
    if (!document.hasFocus()) return undefined
    return resolveEditableField(deepActiveElement())
  }

  function isEventInsidePopover(event: Event): boolean {
    const path = event.composedPath()
    if (path.includes(host) || path.includes(shadow)) return true
    return event.target instanceof Node && (event.target === host || shadow.contains(event.target))
  }

  function updatePosition(): void {
    if (disposed || activeField === undefined || !activeField.isConnected || host.style.display === 'none') {
      return
    }
    const rect = activeField.getBoundingClientRect()
    const viewW = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth) || 800
    const viewH = Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight) || 600
    const margin = 8
    const popRect = popover.getBoundingClientRect()
    const popW = popRect.width || 260
    const popH = popRect.height || 96
    let top = rect.bottom + 6
    if (top + popH > viewH - margin && rect.top - 6 - popH >= margin) {
      top = rect.top - 6 - popH
    } else {
      top = Math.max(margin, Math.min(top, viewH - popH - margin))
    }
    const left = Math.max(margin, Math.min(rect.left, viewW - popW - margin))
    popover.style.left = `${Math.round(left)}px`
    popover.style.top = `${Math.round(top)}px`
  }

  function showPopover(): void {
    if (disposed || activeField === undefined || !activeField.isConnected) return
    syncLabels()
    if (!host.isConnected) {
      document.documentElement.append(host)
    }
    host.style.setProperty('display', 'block', 'important')
    updatePosition()
  }

  function hidePopover(clearBackup = true): void {
    clearAutoReplace()
    clearCopyTimer()
    previewVisible = false
    previewTranslation = ''
    statusNode.textContent = ''
    statusNode.className = 'status'
    actions.textContent = ''
    if (clearBackup) backupState = undefined
    host.style.setProperty('display', 'none', 'important')
  }

  function releasePendingManagedToken(): void {
    const pending = pendingManagedToken
    if (pending === undefined) return
    if (pending.field.getAttribute(pending.attribute) === pending.token) {
      pending.field.removeAttribute(pending.attribute)
    }
    pendingManagedToken = undefined
  }

  function clearAllState(clearBackup = true): void {
    epoch += 1
    clearDebounce()
    clearBeforeInput()
    clearAutoReplace()
    cancelInFlight()
    releasePendingManagedToken()
    snapshotText = ''
    recoveryOriginalText = undefined
    hidePopover(clearBackup)
  }

  function managedBackupStillLive(): boolean {
    return backupState !== undefined &&
      activeField !== undefined &&
      backupState.field === activeField &&
      isManagedCandidate(activeField) &&
      activeField.isConnected &&
      readFieldValue(activeField) === backupState.inserted
  }

  function leaveFieldForFocus(): void {
    releasePendingManagedToken()
    epoch += 1
    clearDebounce()
    clearBeforeInput()
    clearAutoReplace()
    cancelInFlight()
    composingField = undefined
    if (managedBackupStillLive()) {
      hidePopover(false)
      return
    }
    suppressedSnapshot = undefined
    clearAllState(true)
  }

  function renderLoading(): void {
    previewVisible = false
    statusNode.className = 'status'
    statusNode.textContent = options.t('wtPanelLoading')
    actions.textContent = ''
    showPopover()
  }

  function renderPreview(translation: string, autoHint?: string): void {
    const normalized = translation.replace(/\r\n?/g, '\n')
    previewVisible = true
    previewTranslation = normalized
    statusNode.className = 'status'
    statusNode.textContent = normalized
    actions.textContent = ''
    actions.append(replaceButton, copyButton)
    if (autoHint !== undefined && autoHint !== '') {
      autoHintNode.textContent = autoHint
      actions.append(autoHintNode)
    }
    showPopover()
  }

  function renderReplaced(inserted: string): void {
    const normalized = inserted.replace(/\r\n?/g, '\n')
    previewVisible = false
    previewTranslation = normalized
    statusNode.className = 'status'
    statusNode.textContent = normalized
    actions.textContent = ''
    actions.append(restoreButton, copyButton)
    showPopover()
  }

  function renderError(message: string): void {
    previewVisible = false
    statusNode.className = 'status is-error'
    statusNode.textContent = message
    actions.textContent = ''
    if (previewTranslation !== '') {
      actions.append(copyButton)
    }
    if (recoveryOriginalText !== undefined) {
      actions.append(copyOriginalButton)
    }
    showPopover()
  }

  function canAutoReplace(field: EditableElement, requestEpoch: number): boolean {
    return (
      !disposed &&
      requestEpoch === epoch &&
      activeField === field &&
      focusedField() === field &&
      isCurrentEditable(field) &&
      composingField !== field &&
      readFieldValue(field) === snapshotText &&
      !replacementBusy &&
      previewVisible &&
      previewTranslation !== ''
    )
  }

  function scheduleAutoReplace(field: EditableElement, requestEpoch: number, translation: string): void {
    clearAutoReplace()
    const delay = currentAutoReplaceDelayMs()
    const elapsed = Date.now() - lastEditAt
    const remaining = delay - elapsed
    if (remaining <= 0) {
      renderPreview(translation)
      if (canAutoReplace(field, requestEpoch)) {
        replacePreview()
      }
      return
    }
    const seconds = String(delay / 1000)
    const hint = options.t('wtInputAutoReplaceCountdown', { seconds }).replace('{seconds}', seconds)
    renderPreview(translation, hint)
    autoReplaceTimer = setTimeout(() => {
      autoReplaceTimer = undefined
      autoHintNode.remove()
      if (canAutoReplace(field, requestEpoch)) {
        replacePreview()
      }
    }, remaining)
  }

  function startTranslationForField(field: EditableElement, manualInput = false): void {
    if (disposed || composingField === field) return
    if (!isCurrentEditable(field)) {
      clearAllState(true)
      return
    }
    const liveValue = readFieldValue(field)
    if (suppressedSnapshot !== undefined && suppressedSnapshot.field === field && suppressedSnapshot.value === liveValue) {
      return
    }
    if (backupState !== undefined && backupState.field === field && liveValue === backupState.inserted) {
      return
    }
    if (!isDraftCandidate(liveValue)) {
      clearAllState(true)
      return
    }
    epoch += 1
    const requestEpoch = epoch
    const requestId = createId()
    clearAutoReplace()
    cancelInFlight()
    directReplaceRequestId = manualInput ? requestId : undefined
    activeField = field
    snapshotText = liveValue
    recoveryOriginalText = undefined
    inFlightId = requestId
    renderLoading()

    void options
      .translate([liveValue], requestId, manualInput ? true : undefined)
      .then((reply) => {
        if (disposed || requestEpoch !== epoch || activeField !== field) {
          return
        }
        if (inFlightId === requestId) {
          inFlightId = undefined
        }
        if (!isCurrentEditable(field) || composingField === field || readFieldValue(field) !== snapshotText) {
          if (directReplaceRequestId === requestId) directReplaceRequestId = undefined
          hidePopover(true)
          return
        }
        if (reply.ok && Array.isArray(reply.texts) && typeof reply.texts[0] === 'string' && reply.texts[0].trim() !== '') {
          const shouldReplace = directReplaceRequestId === requestId
          directReplaceRequestId = undefined
          if (shouldReplace) {
            renderPreview(reply.texts[0])
            if (focusedField() === field) replacePreview()
            return
          }
          if (currentReplaceMode() === 'auto') {
            scheduleAutoReplace(field, requestEpoch, reply.texts[0])
            return
          }
          renderPreview(reply.texts[0])
          return
        }
        if (directReplaceRequestId === requestId) directReplaceRequestId = undefined
        if (!reply.ok && reply.code === 'cancelled') {
          hidePopover(true)
          return
        }
        renderError(!reply.ok && reply.error !== '' ? reply.error : options.t('wtRetryBubbleTitle'))
      })
      .catch(() => {
        if (inFlightId === requestId) {
          inFlightId = undefined
        }
        if (directReplaceRequestId === requestId) directReplaceRequestId = undefined
        if (disposed || requestEpoch !== epoch || activeField !== field) return
        if (!isCurrentEditable(field) || composingField === field || readFieldValue(field) !== snapshotText) {
          hidePopover(true)
          return
        }
        renderError(options.t('wtRetryBubbleTitle'))
      })
  }

  function scheduleFieldCheck(field: EditableElement): void {
    if (disposed) return
    const liveValue = readFieldValue(field)
    if (suppressedSnapshot !== undefined) {
      if (suppressedSnapshot.field === field && suppressedSnapshot.value === liveValue) {
        return
      }
      suppressedSnapshot = undefined
    }
    if (backupState !== undefined) {
      if (backupState.field === field && liveValue === backupState.inserted) {
        return
      }
      backupState = undefined
    }
    lastEditAt = Date.now()
    if (activeField !== undefined && activeField !== field) {
      clearAllState(true)
    }
    activeField = field
    epoch += 1
    clearDebounce()
    clearAutoReplace()
    cancelInFlight()
    hidePopover(false)
    if (composingField === field) return
    if (!isDraftCandidate(liveValue)) {
      backupState = undefined
      return
    }
    // 用户选择「停止输入后自动替换」即表示同意自动处理草稿，不应被「自动弹窗」开关阻断
    const autoMode = currentReplaceMode() === 'auto'
    if (!autoMode && options.autoPreview?.() === false) return
    const debounceMs = autoMode ? Math.min(DEBOUNCE_MS, currentAutoReplaceDelayMs()) : DEBOUNCE_MS
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      startTranslationForField(field)
    }, debounceMs)
  }

  function deferManagedFieldCheck(field: HTMLElement): void {
    clearBeforeInput()
    if (activeField !== undefined && activeField !== field) clearAllState(true)
    activeField = field
    const requestEpoch = epoch
    beforeInputTimer = setTimeout(() => {
      beforeInputTimer = undefined
      if (disposed || epoch !== requestEpoch || activeField !== field || composingField === field) return
      if (!isCurrentEditable(field)) {
        clearAllState(true)
        return
      }
      scheduleFieldCheck(field)
    }, 0)
  }

  function onBeforeInput(event: Event): void {
    if (disposed || !event.isTrusted || !(event instanceof InputEvent) || isEventInsidePopover(event)) return
    const field = resolveEditableField(eventTarget(event))
    if (field !== undefined && field === ownInputWrite) return
    if (field === undefined || !isManagedPlainEditor(field)) return
    clearBeforeInput()
    releasePendingManagedToken()
    epoch += 1
    clearDebounce()
    clearAutoReplace()
    cancelInFlight()
    hidePopover(false)
    if (event.isComposing) composingField = field
    if (composingField === field) return
    lastEditAt = Date.now()
    deferManagedFieldCheck(field)
  }

  function onCompositionStart(event: CompositionEvent): void {
    if (disposed || !event.isTrusted) return
    clearBeforeInput()
    releasePendingManagedToken()
    const field = resolveEditableField(eventTarget(event))
    if (field === undefined) return
    composingField = field
    epoch += 1
    clearDebounce()
    clearAutoReplace()
    cancelInFlight()
    hidePopover(false)
  }

  function onCompositionEnd(event: CompositionEvent): void {
    if (disposed) return
    const field = resolveEditableField(eventTarget(event))
    // 多个站点或输入法环境下会出现原生 compositionend 被吞、只剩 isTrusted=false 副本的情况，所以不按站点放行；
    // 不可信事件只能结束由用户可信合成开启、且当前有焦点的同一输入框的合成；之后仍按实时 DOM 取样，不使用事件数据。
    if (!event.isTrusted) {
      if (field === undefined || composingField !== field) return
      const active = deepActiveElement(field.ownerDocument)
      if (active !== field && (active === null || !field.contains(active))) return
    }
    if (composingField !== undefined && (field === undefined || composingField === field)) {
      composingField = undefined
    }
    if (field === undefined) return
    lastEditAt = Date.now()
    if (isManagedPlainEditor(field)) deferManagedFieldCheck(field)
    else scheduleFieldCheck(field)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disposed || !event.isTrusted) return
    const replaceKey = currentReplaceKey()
    if (
      replaceKey !== '' &&
      matchesHotkey(event, replaceKey) &&
      previewVisible &&
      host.style.display !== 'none' &&
      !replacementBusy &&
      previewTranslation !== '' &&
      activeField !== undefined &&
      resolveEditableField(eventTarget(event)) === activeField &&
      composingField !== activeField &&
      readFieldValue(activeField) === snapshotText
    ) {
      event.preventDefault()
      event.stopPropagation()
      replacePreview()
      return
    }
    if (
      event.key === 'Escape' &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.isComposing &&
      composingField === undefined &&
      host.style.display !== 'none'
    ) {
      if (activeField !== undefined && activeField.isConnected) {
        suppressedSnapshot = { field: activeField, value: readFieldValue(activeField) }
      }
      clearAllState(true)
      return
    }
    // 原生 compositionend 被站点吞掉且未重发时的兜底：浏览器给出的可信 keydown 已不处于合成，
    // 且不是输入法开始合成时的 Process 键，就结束同一输入框的合成状态并重新取样。
    if (event.isComposing || composingField === undefined) return
    if (event.key === 'Process' || event.keyCode === 229) return
    if (isEventInsidePopover(event)) return
    const field = resolveEditableField(eventTarget(event))
    if (field === undefined || field !== composingField) return
    composingField = undefined
    lastEditAt = Date.now()
    if (isManagedPlainEditor(field)) deferManagedFieldCheck(field)
    else scheduleFieldCheck(field)
  }

  function onInput(event: Event): void {
    if (disposed || !event.isTrusted) return
    if (isEventInsidePopover(event)) return
    const field = resolveEditableField(eventTarget(event))
    if (field !== undefined && field === ownInputWrite) return
    clearBeforeInput()
    releasePendingManagedToken()
    if (field === undefined) {
      if (activeField !== undefined) clearAllState(true)
      return
    }
    if (event instanceof InputEvent && event.isComposing) {
      composingField = field
      epoch += 1
      clearDebounce()
      clearAutoReplace()
      cancelInFlight()
      hidePopover(false)
      return
    }
    lastEditAt = Date.now()
    scheduleFieldCheck(field)
  }

  function onFocusIn(event: FocusEvent): void {
    if (disposed) return
    if (isEventInsidePopover(event)) return
    const target = eventTarget(event)
    if (!(target instanceof Node) || activeField === undefined) return
    if (target === activeField || activeField.contains(target)) {
      if (host.style.display === 'none' && managedBackupStillLive()) renderReplaced(backupState?.inserted ?? '')
      return
    }
    leaveFieldForFocus()
  }

  function onFocusOut(event: FocusEvent): void {
    if (disposed || activeField === undefined) return
    if (pointerInsidePopover) return
    const next = event.relatedTarget
    if (next instanceof Node && (next === host || shadow.contains(next) || activeField.contains(next))) {
      return
    }
    queueMicrotask(() => {
      if (disposed || activeField === undefined || pointerInsidePopover) return
      const docActive = deepActiveElement()
      if (docActive === host || shadow.activeElement !== null || docActive === activeField || (docActive instanceof Node && activeField.contains(docActive))) {
        return
      }
      clearAutoReplace()
      if (!(docActive instanceof Element) || docActive === document.body || docActive === document.documentElement) return
      leaveFieldForFocus()
    })
  }

  function onViewportChange(): void {
    if (disposed) return
    if (activeField !== undefined && !activeField.isConnected) {
      clearAllState(true)
      return
    }
    updatePosition()
  }

  popover.addEventListener('pointerdown', () => {
    pointerInsidePopover = true
    queueMicrotask(() => {
      pointerInsidePopover = false
    })
  })

  function removeManagedToken(field: HTMLElement, token: string, attribute: 'data-wt-discord-input' | 'data-wt-chat-input'): void {
    if (field.getAttribute(attribute) === token) field.removeAttribute(attribute)
    if (pendingManagedToken?.token === token) pendingManagedToken = undefined
  }

  async function waitForManagedDom(field: HTMLElement, target: string): Promise<boolean> {
    const normalized = target.replace(/\r\n?/g, '\n')
    const matches = (): boolean => field.isConnected && isManagedPlainEditor(field) && readFieldValue(field) === normalized
    if (matches()) return true
    await Promise.resolve()
    if (matches()) return true
    const deadline = Date.now() + MANAGED_SETTLE_MS
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 16)
      })
      if (matches()) return true
    }
    return matches()
  }

  async function performReplacement(field: HTMLElement, expectedText: string, text: string): Promise<DiscordReplacementStatus> {
    const discord = isDiscordPlainEditor(field)
    const replace = discord ? options.replaceDiscordInput : options.replaceChatInput
    const attribute = discord ? 'data-wt-discord-input' : 'data-wt-chat-input'
    if (replace === undefined) return 'unsupported'
    releasePendingManagedToken()
    const token = createId()
    field.setAttribute(attribute, token)
    pendingManagedToken = { field, token, attribute }
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<DiscordReplacementStatus>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        removeManagedToken(field, token, attribute)
        resolve('failed')
      }, MANAGED_BRIDGE_MS)
    })
    try {
      const status = await Promise.race([
        replace({ elementId: token, expectedText, text }),
        timeout,
      ])
      return timedOut ? 'failed' : status
    } catch {
      return 'failed'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      removeManagedToken(field, token, attribute)
    }
  }

  async function commitManagedDraft(
    field: HTMLElement,
    expected: string,
    next: string,
    requestEpoch: number,
    mode: 'replace' | 'restore',
  ): Promise<void> {
    if (!isManagedPlainEditor(field)) {
      renderError(options.t('wtInputEditorUnsupported'))
      return
    }
    replacementBusy = true
    try {
      const status = await performReplacement(field, expected, next)
      if (disposed || requestEpoch !== epoch || activeField !== field || composingField === field || !isCurrentEditable(field)) {
        return
      }
      if (status === 'changed') {
        renderError(options.t('wtInputTextChanged'))
        return
      }
      const originalText = (mode === 'replace' ? expected : next).replace(/\r\n?/g, '\n')
      const failWith = (key: 'wtInputEditorUnsupported' | 'wtInputReplaceFailed'): void => {
        // 桥可能已写入一部分再报错；草稿不再等于写入前的内容时，给出复制原文。
        if (readFieldValue(field) !== expected.replace(/\r\n?/g, '\n')) {
          recoveryOriginalText = originalText
          renderError(options.t('wtInputReplacePartial'))
          return
        }
        renderError(options.t(key))
      }
      if (status === 'unsupported') {
        failWith('wtInputEditorUnsupported')
        return
      }
      if (status !== 'ok') {
        failWith('wtInputReplaceFailed')
        return
      }
      const settled = await waitForManagedDom(field, next)
      if (disposed || requestEpoch !== epoch || activeField !== field || composingField === field || !isCurrentEditable(field)) {
        return
      }
      if (!settled) {
        failWith('wtInputReplaceFailed')
        return
      }
      try {
        field.focus({ preventScroll: true })
      } catch {
        void 0
      }
      const normalizedNext = next.replace(/\r\n?/g, '\n')
      recoveryOriginalText = undefined
      if (mode === 'replace') {
        backupState = { field, original: expected.replace(/\r\n?/g, '\n'), inserted: normalizedNext }
        snapshotText = normalizedNext
        renderReplaced(normalizedNext)
        return
      }
      const translated = expected.replace(/\r\n?/g, '\n')
      backupState = undefined
      suppressedSnapshot = { field, value: normalizedNext }
      snapshotText = normalizedNext
      previewTranslation = translated
      renderPreview(translated)
    } finally {
      replacementBusy = false
    }
  }

  function commitPlainDraft(
    field: EditableElement,
    expected: string,
    next: string,
  ): ReturnType<typeof applyFieldReplacement> {
    ownInputWrite = field
    try {
      return applyFieldReplacement(field, expected, next)
    } finally {
      ownInputWrite = undefined
    }
  }

  function replacePreview(): void {
    clearAutoReplace()
    if (disposed || replacementBusy || activeField === undefined || previewTranslation === '') return
    const field = activeField
    recoveryOriginalText = undefined
    if (isManagedCandidate(field)) {
      if (composingField === field) {
        renderError(options.t('wtInputReplaceFailed'))
        return
      }
      if (!isManagedPlainEditor(field) || !isCurrentEditable(field)) {
        renderError(options.t('wtInputEditorUnsupported'))
        return
      }
      const requestEpoch = epoch
      const expected = snapshotText
      const targetText = previewTranslation.replace(/\r\n?/g, '\n')
      void commitManagedDraft(field, expected, targetText, requestEpoch, 'replace')
      return
    }
    if (composingField === field || !isCurrentEditable(field)) {
      renderError(options.t('wtInputReplaceFailed'))
      return
    }
    const original = snapshotText.replace(/\r\n?/g, '\n')
    const targetText = previewTranslation.replace(/\r\n?/g, '\n')
    const outcome = commitPlainDraft(field, snapshotText, targetText)
    if (outcome === 'ok') {
      backupState = { field, original, inserted: targetText }
      snapshotText = targetText
      renderReplaced(targetText)
      return
    }
    if (outcome === 'changed') {
      renderError(options.t('wtInputTextChanged'))
      return
    }
    if (outcome === 'failed-modified') {
      recoveryOriginalText = original
      renderError(options.t('wtInputReplacePartial'))
      return
    }
    renderError(options.t('wtInputReplaceFailed'))
  }

  replaceButton.addEventListener('click', (event) => {
    if (disposed || !event.isTrusted) return
    replacePreview()
  })

  function translateAndReplace(): boolean {
    if (disposed || replacementBusy) return false
    const field = focusedField()
    if (field === undefined || composingField === field || !isCurrentEditable(field)) return false
    const live = readFieldValue(field)
    if (!isDraftCandidate(live)) return false
    if (backupState !== undefined && backupState.field === field && live === backupState.inserted) return false
    clearBeforeInput()
    clearDebounce()
    clearAutoReplace()
    suppressedSnapshot = undefined
    if (activeField === field && snapshotText === live && inFlightId !== undefined) {
      directReplaceRequestId = inFlightId
      return true
    }
    if (activeField === field && snapshotText === live && previewTranslation !== '') {
      replacePreview()
      return true
    }
    startTranslationForField(field, true)
    return true
  }

  restoreButton.addEventListener('click', (event) => {
    if (disposed || !event.isTrusted || replacementBusy || backupState === undefined) return
    const { field, original, inserted } = backupState
    recoveryOriginalText = undefined
    if (activeField !== field || composingField === field) {
      backupState = undefined
      renderError(options.t('wtInputReplaceFailed'))
      return
    }
    if (isManagedCandidate(field) && !isManagedPlainEditor(field)) {
      renderError(options.t('wtInputEditorUnsupported'))
      return
    }
    if (!isCurrentEditable(field)) {
      backupState = undefined
      renderError(options.t('wtInputReplaceFailed'))
      return
    }
    if (readFieldValue(field) !== inserted) {
      backupState = undefined
      renderError(options.t('wtInputTextChanged'))
      return
    }
    const normalizedOriginal = original.replace(/\r\n?/g, '\n')
    if (isManagedCandidate(field)) {
      if (!isManagedPlainEditor(field)) {
        renderError(options.t('wtInputEditorUnsupported'))
        return
      }
      const requestEpoch = epoch
      void commitManagedDraft(field, inserted, normalizedOriginal, requestEpoch, 'restore')
      return
    }
    const outcome = commitPlainDraft(field, inserted, normalizedOriginal)
    if (outcome === 'ok') {
      backupState = undefined
      suppressedSnapshot = { field, value: normalizedOriginal }
      snapshotText = normalizedOriginal
      previewTranslation = inserted
      renderPreview(inserted)
      return
    }
    backupState = undefined
    if (outcome === 'failed-modified') {
      recoveryOriginalText = original
      renderError(options.t('wtInputReplacePartial'))
      return
    }
    renderError(outcome === 'changed' ? options.t('wtInputTextChanged') : options.t('wtInputReplaceFailed'))
  })

  copyButton.addEventListener('click', (event) => {
    if (disposed || !event.isTrusted || previewTranslation === '') return
    const textToCopy = previewTranslation
    void copySelectionText(textToCopy).then((copied) => {
      if (disposed || host.style.display === 'none') return
      clearCopyTimer()
      copyButton.textContent = options.t(copied ? 'wtToolbarCopied' : 'wtToolbarCopyFailed')
      copyTimer = setTimeout(() => {
        copyTimer = undefined
        copyButton.textContent = options.t('wtToolbarCopy')
      }, 1500)
    })
  })

  copyOriginalButton.addEventListener('click', (event) => {
    if (disposed || !event.isTrusted || recoveryOriginalText === undefined || recoveryOriginalText === '') return
    const textToCopy = recoveryOriginalText
    void copySelectionText(textToCopy).then((copied) => {
      if (disposed || host.style.display === 'none') return
      if (copyOriginalTimer !== undefined) {
        clearTimeout(copyOriginalTimer)
        copyOriginalTimer = undefined
      }
      copyOriginalButton.textContent = options.t(copied ? 'wtToolbarCopied' : 'wtToolbarCopyFailed')
      copyOriginalTimer = setTimeout(() => {
        copyOriginalTimer = undefined
        copyOriginalButton.textContent = options.t('wtInputCopyOriginal')
      }, 1500)
    })
  })

  closeButton.addEventListener('click', (event) => {
    if (disposed || !event.isTrusted) return
    if (activeField !== undefined && activeField.isConnected) {
      suppressedSnapshot = { field: activeField, value: readFieldValue(activeField) }
    }
    clearAllState(true)
  })

  document.addEventListener('beforeinput', onBeforeInput, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  document.addEventListener('input', onInput, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)

  return {
    translateAndReplace,
    dispose() {
      if (disposed) return
      disposed = true
      document.removeEventListener('beforeinput', onBeforeInput, true)
      document.removeEventListener('compositionstart', onCompositionStart, true)
      document.removeEventListener('compositionend', onCompositionEnd, true)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
      composingField = undefined
      suppressedSnapshot = undefined
      activeField = undefined
      clearAutoReplace()
      clearAllState(true)
      host.remove()
    },
  }
}
