import { createId } from './id'
import { copySelectionText } from './clipboard'
import {
  deepActiveElement,
  inputTranslationTitle,
  isHiddenOrDisabled,
  isSensitiveField,
  INPUT_POPOVER_CSS,
  type InputTranslationOptions,
} from './input-translation'
import type { LiveTranslationOptions } from './live-translation'
import type { DocumentEditorRequest, DocumentEditorResult } from './document-editor'
import {
  applySurfacePreferences,
  createProgressIndicator,
  createSurfaceExit,
  DEFAULT_SURFACE_PREFERENCES,
  syncSurfaceVisibility,
} from './ui-surface'

export interface DocumentInputOptions extends LiveTranslationOptions, Pick<InputTranslationOptions, 'sourceLanguage' | 'targetLanguage'> {
  readonly enabled: () => boolean
  readonly editor: (request: DocumentEditorRequest) => Promise<DocumentEditorResult>
}

export interface DocumentInputWatcher {
  translate(): Promise<boolean>
  dispose(): void
}

const EDITOR_ROOT_SELECTOR = '.cm-editor,.CodeMirror,.ck-editor__editable,.mce-content-body'
const TOKEN_ATTRIBUTE = 'data-wt-document-input'
const COPY_FEEDBACK_MS = 1400
const EDIT_VERIFY_DELAY_MS = 60
const NAVIGATION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

export function createDocumentInputTranslation(options: DocumentInputOptions): DocumentInputWatcher {
  let disposed = false
  let sessionEpoch = 0
  let requestId: string | undefined
  let token: { root: Element; id: string } | undefined
  let originalText = ''
  let translationText = ''
  let insertedText: string | undefined
  let canReplaceDocument = false
  let busy = false
  let replacing = false
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let verifyTimer: ReturnType<typeof setTimeout> | undefined
  let verifying = false
  let verifyAgain = false
  let editedBeforeSnapshot = false
  let writeCount = 0
  let verifyRun = 0
  let knownText: string | undefined
  let statusFailed = false

  let host: HTMLElement | undefined
  let shadow: ShadowRoot | undefined
  let popover: HTMLElement | undefined
  let statusNode: HTMLElement | undefined
  let titleNode: HTMLElement | undefined
  let closeButtonNode: HTMLButtonElement | undefined
  let replaceButton: HTMLButtonElement | undefined
  let restoreButton: HTMLButtonElement | undefined
  let copyButton: HTMLButtonElement | undefined
  let copyOriginalButton: HTMLButtonElement | undefined
  let hintNode: HTMLElement | undefined
  let keyHintNode: HTMLElement | undefined
  let panelExit: ReturnType<typeof createSurfaceExit> | undefined

  function ensureDom(): void {
    if (host !== undefined) return
    const created = document.createElement('div')
    created.setAttribute('data-wt-root', '')
    created.style.cssText =
      'all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: none !important; contain: style !important;'
    applySurfacePreferences(created, options.appearance?.() ?? DEFAULT_SURFACE_PREFERENCES)
    const closed = created.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = INPUT_POPOVER_CSS
    const panel = document.createElement('div')
    panel.className = 'popover'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'false')
    panel.setAttribute('aria-labelledby', 'wt-document-input-title')
    panel.style.maxHeight = 'calc(100vh - 16px)'
    panel.style.overflowY = 'auto'
    const header = document.createElement('div')
    header.className = 'header'
    const title = document.createElement('span')
    title.className = 'title'
    title.id = 'wt-document-input-title'
    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'close'
    closeButton.dataset.action = 'close'
    closeButton.textContent = '✕'
    closeButton.setAttribute('aria-label', options.t('wtNoticeDismiss'))
    closeButton.addEventListener('click', (event) => {
      if (!event.isTrusted) return
      closeSession(true)
    })
    const iconUrl = options.iconUrl
    const logo =
      iconUrl !== undefined && iconUrl !== '' ? document.createElement('img') : undefined
    if (logo !== undefined && iconUrl !== undefined) {
      logo.className = 'input-logo'
      logo.alt = ''
      logo.width = 24
      logo.height = 24
      logo.src = iconUrl
    }
    header.append(...(logo !== undefined ? [logo] : []), title, closeButton)
    const status = document.createElement('div')
    status.className = 'status'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const actions = document.createElement('div')
    actions.className = 'actions'
    const replace = document.createElement('button')
    replace.type = 'button'
    replace.dataset.action = 'replace'
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.dataset.action = 'restore'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.dataset.action = 'copy'
    const copyOriginal = document.createElement('button')
    copyOriginal.type = 'button'
    copyOriginal.dataset.action = 'copy-original'
    const hint = document.createElement('span')
    hint.className = 'auto-hint'
    hint.dataset.action = 'hint'
    const keyHint = document.createElement('span')
    keyHint.className = 'auto-hint'
    keyHint.id = 'wt-document-input-key-hint'
    keyHint.dataset.action = 'key-hint'
    panel.setAttribute('aria-describedby', keyHint.id)
    actions.append(replace, restore, copy, copyOriginal, hint, keyHint)
    panel.append(header, status, actions, createProgressIndicator())
    closed.append(style, panel)
    panelExit = createSurfaceExit(panel, created)
    panel.addEventListener('pointerdown', (event) => {
      event.preventDefault()
    })
    panel.addEventListener('click', (event) => {
      if (!event.isTrusted) return
      const target = event.target
      if (!(target instanceof Element)) return
      const action = target.closest('button')?.dataset.action
      if (action === 'replace') void onReplace()
      else if (action === 'restore') void onReplace(true)
      else if (action === 'copy') void onCopy(false)
      else if (action === 'copy-original') void onCopy(true)
    })
    host = created
    shadow = closed
    popover = panel
    statusNode = status
    titleNode = title
    closeButtonNode = closeButton
    replaceButton = replace
    restoreButton = restore
    copyButton = copy
    copyOriginalButton = copyOriginal
    hintNode = hint
    keyHintNode = keyHint
  }

  function syncLabels(): void {
    if (host !== undefined) applySurfacePreferences(host, options.appearance?.() ?? DEFAULT_SURFACE_PREFERENCES)
    if (titleNode !== undefined) titleNode.textContent = inputTranslationTitle(options)
    if (closeButtonNode !== undefined) closeButtonNode.setAttribute('aria-label', options.t('wtNoticeDismiss'))
    if (replaceButton !== undefined) {
      replaceButton.textContent = options.t('wtInputReplace')
      replaceButton.setAttribute('aria-label', options.t('wtInputReplace'))
    }
    if (restoreButton !== undefined) {
      restoreButton.textContent = options.t('wtInputRestore')
      restoreButton.setAttribute('aria-label', options.t('wtInputRestore'))
    }
    if (copyButton !== undefined) {
      if (copyTimer === undefined) copyButton.textContent = options.t('wtToolbarCopy')
      copyButton.setAttribute('aria-label', options.t('wtToolbarCopy'))
    }
    if (copyOriginalButton !== undefined) {
      if (copyTimer === undefined) copyOriginalButton.textContent = options.t('wtInputCopyOriginal')
      copyOriginalButton.setAttribute('aria-label', options.t('wtInputCopyOriginal'))
    }
  }

  function showPanel(): void {
    if (disposed || host === undefined) return
    panelExit?.show()
    syncLabels()
    if (!host.isConnected) document.documentElement.append(host)
    host.style.setProperty('display', 'block', 'important')
    if (popover !== undefined) {
      popover.style.right = '8px'
      popover.style.top = '8px'
      popover.style.left = 'auto'
    }
  }

  function hidePanel(): void {
    popover?.setAttribute('aria-busy', 'false')
    const finalize = () => {
      if (host !== undefined) host.style.setProperty('display', 'none', 'important')
      if (statusNode !== undefined) {
        statusNode.textContent = ''
        statusNode.className = 'status'
      }
      syncActions()
    }
    if (disposed || panelExit === undefined) {
      panelExit?.show()
      finalize()
    } else panelExit.hide(finalize)
  }

  function setStatus(text: string, isError = false): void {
    if (statusNode === undefined) return
    statusNode.textContent = text
    statusNode.className = isError ? 'status is-error' : 'status'
    statusFailed = isError
  }

  function syncActions(): void {
    popover?.setAttribute('aria-busy', String(busy))
    if (
      replaceButton === undefined ||
      restoreButton === undefined ||
      copyButton === undefined ||
      copyOriginalButton === undefined
    ) {
      return
    }
    const hasTranslation = translationText !== '' && !busy
    const armed = insertedText !== undefined
    replaceButton.style.display = canReplaceDocument && hasTranslation && !armed ? '' : 'none'
    restoreButton.style.display = canReplaceDocument && hasTranslation && armed ? '' : 'none'
    replaceButton.disabled = busy
    restoreButton.disabled = busy
    copyButton.style.display = hasTranslation ? '' : 'none'
    copyOriginalButton.style.display = originalText !== '' ? '' : 'none'
    if (hintNode !== undefined) {
      hintNode.textContent = armed
        ? options.t('wtInputRestoreHint')
        : translationText === ''
          ? ''
          : !canReplaceDocument
            ? options.t('wtInputEditorUnsupported')
            : options.t('wtInputPreviewHint')
    }
    if (keyHintNode !== undefined) {
      const focusable = hasTranslation && !statusFailed
      keyHintNode.textContent = focusable ? options.t('wtInputPanelKeyHint') : ''
      keyHintNode.style.display = focusable ? '' : 'none'
    }
  }

  function clearCopyTimer(): void {
    if (copyTimer !== undefined) {
      clearTimeout(copyTimer)
      copyTimer = undefined
    }
  }

  function clearVerify(): void {
    if (verifyTimer !== undefined) clearTimeout(verifyTimer)
    verifyTimer = undefined
    verifyAgain = false
    editedBeforeSnapshot = false
    verifyRun += 1
    verifying = false
  }

  function scheduleVerify(): void {
    if (verifying) {
      verifyAgain = true
      return
    }
    if (verifyTimer !== undefined) return
    verifyTimer = setTimeout(() => {
      verifyTimer = undefined
      void verifyEditorText()
    }, EDIT_VERIFY_DELAY_MS)
  }

  async function verifyEditorText(): Promise<void> {
    const current = token
    const expected = knownText
    if (disposed || current === undefined || expected === undefined) return
    if (replacing) {
      scheduleVerify()
      return
    }
    const epoch = sessionEpoch
    const writes = writeCount
    const run = ++verifyRun
    verifying = true
    let snapshot: DocumentEditorResult
    try {
      snapshot = await options.editor({ elementId: current.id, action: 'read' })
    } catch {
      snapshot = { status: 'failed' }
    }
    if (run !== verifyRun) return
    verifying = false
    const again = verifyAgain
    verifyAgain = false
    if (disposed) return
    if (epoch === sessionEpoch && token?.id === current.id && !replacing && writes === writeCount) {
      const unchanged =
        snapshot.status === 'ok' ? snapshot.text === expected : candidateRoot() !== current.root
      if (!unchanged) {
        invalidateSession()
        return
      }
    }
    if (again && token !== undefined) scheduleVerify()
  }

  function releaseToken(): void {
    const current = token
    token = undefined
    if (current === undefined) return
    try {
      if (current.root.getAttribute(TOKEN_ATTRIBUTE) === current.id) {
        current.root.removeAttribute(TOKEN_ATTRIBUTE)
      }
    } catch {
      void 0
    }
  }

  function cancelInFlight(): void {
    const id = requestId
    requestId = undefined
    if (id !== undefined) options.cancel(id)
  }

  function invalidateSession(): void {
    sessionEpoch += 1
    cancelInFlight()
    busy = false
    closeSession()
  }

  function closeSession(restoreFocus = false): void {
    const returnRoot =
      restoreFocus && host !== undefined && document.activeElement === host ? token?.root : undefined
    sessionEpoch += 1
    cancelInFlight()
    busy = false
    replacing = false
    releaseToken()
    originalText = ''
    translationText = ''
    insertedText = undefined
    knownText = undefined
    canReplaceDocument = false
    clearCopyTimer()
    clearVerify()
    hidePanel()
    statusFailed = false
    if (returnRoot?.isConnected === true) focusEditor(returnRoot)
  }

  function composedParent(element: Element): Element | null {
    if (element.parentElement !== null) return element.parentElement
    const root = element.getRootNode()
    return root instanceof ShadowRoot ? (root.host as Element | null) : null
  }

  function composedClosest(element: Element, selector: string): Element | null {
    let current: Element | null = element
    while (current !== null) {
      if (current.matches(selector)) return current
      current = composedParent(current)
    }
    return null
  }

  function candidateRoot(): Element | undefined {
    if (!document.hasFocus()) return undefined
    const active = deepActiveElement()
    if (!(active instanceof Element)) return undefined
    const root = composedClosest(active, EDITOR_ROOT_SELECTOR)
    if (root === null || !root.isConnected) return undefined
    if (!(root instanceof HTMLElement)) return undefined
    if (isHiddenOrDisabled(root) || isSensitiveField(root)) return undefined
    return root
  }

  function isEventInsidePanel(event: Event): boolean {
    if (host === undefined) return false
    const path = event.composedPath()
    if (path.includes(host)) return true
    return event.target instanceof Node && (event.target === host || (shadow?.contains(event.target) ?? false))
  }

  function onTrustedEdit(event: Event): void {
    if (!event.isTrusted || disposed) return
    if (token === undefined && translationText === '' && originalText === '') return
    invalidateSession()
  }

  function onEditorGesture(event: Event): void {
    if (!event.isTrusted || disposed || token === undefined) return
    if (event instanceof KeyboardEvent) {
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return
      if (NAVIGATION_KEYS.has(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) return
    }
    if (!event.composedPath().includes(token.root)) return
    if (originalText === '') {
      editedBeforeSnapshot = true
      return
    }
    scheduleVerify()
  }

  function onFocusChange(event: Event): void {
    if (!event.isTrusted || disposed || token === undefined) return
    if (isEventInsidePanel(event)) return
    const target = event.composedPath()[0] ?? event.target
    if (!(target instanceof Element)) {
      invalidateSession()
      return
    }
    const nextRoot = composedClosest(target, EDITOR_ROOT_SELECTOR)
    if (nextRoot !== token.root) invalidateSession()
  }

  function onPageHide(): void {
    invalidateSession()
  }

  function onEscapeKey(event: KeyboardEvent): void {
    if (!event.isTrusted || disposed) return
    if (event.key !== 'Escape' || event.isComposing) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (token === undefined) return
    const inside = isEventInsidePanel(event)
    closeSession(true)
    if (inside) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function onVisibilityChange(): void {
    if (host !== undefined) syncSurfaceVisibility(host)
    if (document.hidden) closeSession()
  }

  function onWindowBlur(): void {
    if (disposed || token === undefined) return
    invalidateSession()
  }

  document.addEventListener('input', onTrustedEdit, true)
  document.addEventListener('beforeinput', onTrustedEdit, true)
  document.addEventListener('compositionstart', onTrustedEdit, true)
  document.addEventListener('focusin', onFocusChange, true)
  document.addEventListener('keydown', onEscapeKey, true)
  document.addEventListener('keydown', onEditorGesture, true)
  document.addEventListener('paste', onEditorGesture, true)
  document.addEventListener('cut', onEditorGesture, true)
  document.addEventListener('drop', onEditorGesture, true)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('blur', onWindowBlur)

  function flashButton(button: HTMLButtonElement | undefined, text: string): void {
    if (button === undefined) return
    button.textContent = text
    clearCopyTimer()
    copyTimer = setTimeout(() => {
      copyTimer = undefined
      syncLabels()
    }, COPY_FEEDBACK_MS)
  }

  async function onCopy(original: boolean): Promise<void> {
    const text = original ? originalText : translationText
    if (text === '') return
    const epoch = sessionEpoch
    const copied = await copySelectionText(text)
    if (disposed || epoch !== sessionEpoch) return
    if (host === undefined || host.style.display === 'none') return
    if (copied !== true) {
      flashButton(original ? copyOriginalButton : copyButton, options.t('wtToolbarCopyFailed'))
      return
    }
    flashButton(original ? copyOriginalButton : copyButton, options.t('wtToolbarCopied'))
  }

  function focusEditor(root: Element): void {
    try {
      const target =
        (root as HTMLElement).isContentEditable === true
          ? (root as HTMLElement)
          : ((root.querySelector('.cm-content') as HTMLElement | null) ??
            (root.querySelector('textarea') as HTMLElement | null) ??
            (root as HTMLElement))
      target.focus({ preventScroll: true })
    } catch {
      void 0
    }
  }

  function focusPanel(): void {
    const target = [restoreButton, replaceButton, copyButton, copyOriginalButton, closeButtonNode].find(
      (button) => button !== undefined && button.style.display !== 'none' && !button.disabled,
    )
    if (target === undefined) return
    target.classList.add('is-key-focus')
    target.addEventListener('blur', () => target.classList.remove('is-key-focus'), { once: true })
    target.focus({ preventScroll: true })
  }

  async function onReplace(restore = false): Promise<void> {
    if (disposed || !options.enabled()) {
      closeSession()
      return
    }
    const current = token
    if (current === undefined || busy || replacing || !canReplaceDocument || translationText === '') return
    if (restore ? insertedText === undefined : insertedText !== undefined) return
    if (!current.root.isConnected) {
      canReplaceDocument = false
      insertedText = undefined
      knownText = undefined
      setStatus(options.t('wtInputTextChanged'), true)
      syncActions()
      return
    }
    const epoch = sessionEpoch
    const expectedText = restore ? insertedText! : originalText
    const text = restore ? originalText : translationText
    focusEditor(current.root)
    replacing = true
    busy = true
    writeCount += 1
    syncActions()
    let result: DocumentEditorResult
    try {
      result = await options.editor({
        elementId: current.id,
        action: 'replace',
        expectedText,
        text,
      })
    } catch {
      result = { status: 'failed' }
    }
    if (disposed || epoch !== sessionEpoch || token?.id !== current.id) return
    if (!options.enabled() || !current.root.isConnected) {
      closeSession()
      return
    }
    busy = false
    replacing = false
    if (result.status === 'ok') {
      if (restore) {
        closeSession()
        return
      }
      translationText = result.text
      knownText = result.text
      insertedText = result.canReplace ? result.text : undefined
      canReplaceDocument = result.canReplace
      setStatus(result.text)
    } else if (result.status === 'unsupported' && !restore) {
      canReplaceDocument = false
      setStatus(translationText)
    } else {
      insertedText = undefined
      knownText = undefined
      canReplaceDocument = false
      setStatus(options.t(result.status === 'changed' ? 'wtInputTextChanged' : 'wtInputReplacePartial'), true)
    }
    syncActions()
  }

  async function translate(): Promise<boolean> {
    if (disposed || !options.enabled()) return false
    if (replacing) return true
    if (token !== undefined && host !== undefined && document.activeElement === host) return true
    const root = candidateRoot()
    if (root === undefined) return false
    if (token?.root === root && !busy && translationText !== '' && !statusFailed) {
      focusPanel()
      return true
    }
    ensureDom()
    invalidateSession()
    const epoch = sessionEpoch
    const id = createId()
    const request = createId()
    try {
      root.setAttribute(TOKEN_ATTRIBUTE, id)
    } catch {
      return false
    }
    token = { root, id }
    originalText = ''
    translationText = ''
    insertedText = undefined
    canReplaceDocument = false
    busy = true
    requestId = request
    setStatus(options.t('wtPanelLoading'))
    showPanel()
    syncActions()

    let snapshot: DocumentEditorResult
    try {
      snapshot = await options.editor({ elementId: id, action: 'read' })
    } catch {
      snapshot = { status: 'failed' }
    }
    if (disposed || epoch !== sessionEpoch || token?.id !== id) return true
    if (!options.enabled() || !root.isConnected) {
      closeSession()
      return true
    }
    if (snapshot.status !== 'ok') {
      if (snapshot.status === 'unsupported') {
        closeSession()
        hidePanel()
        return false
      }
      busy = false
      requestId = undefined
      setStatus(options.t('wtInputReplaceFailed'), true)
      syncActions()
      return true
    }
    if (snapshot.text.trim() === '' || snapshot.text.length > 6000) {
      busy = false
      requestId = undefined
      setStatus(options.t('wtInputReplaceFailed'), true)
      syncActions()
      return true
    }

    originalText = snapshot.text
    knownText = snapshot.text
    canReplaceDocument = snapshot.canReplace
    if (editedBeforeSnapshot) {
      editedBeforeSnapshot = false
      scheduleVerify()
    }
    let reply: Awaited<ReturnType<DocumentInputOptions['translate']>> | undefined
    try {
      reply = await options.translate([snapshot.text], request)
    } catch {
      reply = undefined
    }
    if (disposed || epoch !== sessionEpoch || token?.id !== id) return true
    requestId = undefined
    if (reply === undefined || !reply.ok || reply.texts === undefined || reply.texts.length !== 1) {
      busy = false
      setStatus(
        reply !== undefined && reply.ok === false ? reply.error : options.t('wtInputReplaceFailed'),
        true,
      )
      syncActions()
      return true
    }
    if (!options.enabled() || !root.isConnected) {
      closeSession()
      return true
    }
    translationText = (reply.texts[0] ?? '').replace(/\r\n?/g, '\n')
    busy = false
    setStatus(translationText)
    syncActions()
    return true
  }

  return {
    translate,
    dispose() {
      if (disposed) return
      disposed = true
      invalidateSession()
      document.removeEventListener('input', onTrustedEdit, true)
      document.removeEventListener('beforeinput', onTrustedEdit, true)
      document.removeEventListener('compositionstart', onTrustedEdit, true)
      document.removeEventListener('focusin', onFocusChange, true)
      document.removeEventListener('keydown', onEscapeKey, true)
      document.removeEventListener('keydown', onEditorGesture, true)
      document.removeEventListener('paste', onEditorGesture, true)
      document.removeEventListener('cut', onEditorGesture, true)
      document.removeEventListener('drop', onEditorGesture, true)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('blur', onWindowBlur)
      host?.remove()
      host = undefined
      shadow = undefined
      popover = undefined
      statusNode = undefined
      titleNode = undefined
      closeButtonNode = undefined
      replaceButton = undefined
      restoreButton = undefined
      copyButton = undefined
      copyOriginalButton = undefined
      hintNode = undefined
      keyHintNode = undefined
      panelExit = undefined
    },
  }
}
