import { browser } from 'wxt/browser'
import { storage } from 'wxt/utils/storage'
import { createId } from './id'
import { translateMessage, type MessageKey, type MessageParams } from '../i18n'
import { languageEnvironment } from '../shared/language-env'
import { resolveUiLanguage, type UiLanguage } from '../shared/locale'
import { getSettings, watchSettings } from '../shared/settings'
import {
  DEFAULT_PAGE_CHAR_LIMIT,
  DEFAULT_TRANSLATION_CONFIG,
  getTranslationConfig,
  INPUT_AUTO_REPLACE_DELAY_DEFAULT,
  normalizeOrigin,
  watchTranslationConfig,
  type TranslationConfig,
} from './config'
import { translationOutputChanged } from './config-impact'
import { createAssistance } from './assistance'
import { createDomEngine, type AutoBatchOutcome, type DomEngine } from './dom'
import { closePageSession, sendTranslationMessage } from './client'
import {
  isContentTranslationMessage,
  NO_SELECTION_ERROR,
  NOTHING_TO_TOGGLE_ERROR,
  SENSITIVE_FRAME_ERROR,
  type ContentTranslationReply,
  type PageAction,
  type PageModes,
  type PageTranslationStatus,
  type TranslationMessage,
  type TranslationReply,
} from './messages'
import { pageIdentity, watchPageLifecycle } from './page-lifecycle'
import { createPageContextTracker } from './page-context-tracker'
import { copySelectionText } from './clipboard'
import type { FloatingAction, FloatingCallbacks, FloatingLabels, FloatingPosition, FloatingView } from './floating'
import { createTranslationPanel, type TranslationPanel } from './panel'
import { collectPageContext } from './reading-context'
import { watchReadingSignals, type ReadingCandidate } from './reading-signals'
import {
  isAssistanceCandidateText,
  readSelectionText,
  watchSelection,
  type SelectionAnchor,
  type SelectionWatcher,
} from './selection'
import { parseGitHubUrl } from '../shared/github'
import { fixedTranslationWith } from './dictionaries/index'
import { isExcludedSite, isSensitivePage } from './page-policy'
import { isSiteScopeAllowed, SITE_SCOPE_BLOCKED_ERROR } from './site-scope'
import type { LiveTranslationWatcher } from './live-translation'
import { createSubtitleTranslation } from './subtitles'
import { DEFAULT_INPUT_REPLACE_KEY } from './input-hotkey'
import { createInputTranslation, type InputTranslationWatcher } from './input-translation'
import { createDocumentInputTranslation, type DocumentInputWatcher } from './document-input'
import type { DocumentEditorRequest, DocumentEditorResult } from './document-editor'
import { currentInputFrameTopUrl, inputFrameUrl } from './input-frame'
import { DEFAULT_SURFACE_PREFERENCES, type SurfacePreferences } from './ui-surface'

const SINGLETON_KEY = Symbol.for('webTranslate.instance')
const MODES_RETRY_MS = 1000
const MAX_MODES_RETRIES = 5
const INVALIDATION_CHECK_MS = 3000
const floatingPositionItem = storage.defineItem<FloatingPosition>('local:translationFloatingPosition', {
  fallback: { side: 'right', ratio: 0.5, collapsed: false },
})

function isExtensionContextValid(): boolean {
  try {
    return browser.runtime.id !== undefined
  } catch {
    return false
  }
}

export interface Instance {
  dispose(): void
  refresh(): void
  healthy(): boolean
}

export interface StartPageTranslationOptions {
  readonly inputOnly?: boolean
}

function createInstance(inputOnly = false): Instance {
  let config: TranslationConfig | undefined
  let modes: PageModes = { enabled: false, fixed: false, auto: false, selection: false, smart: false }
  let engine: DomEngine | undefined
  type ToolbarSelection = {
    readonly text: string
    readonly anchor: SelectionAnchor
    readonly method: 'mouse' | 'keyboard'
    readonly stillValid: () => boolean
  }
  let watcher: SelectionWatcher | undefined
  let toolbarSelection: ToolbarSelection | undefined
  let reading: { dispose(): void; reset(): void } | undefined
  let subtitles: LiveTranslationWatcher | undefined
  let inputTranslation: InputTranslationWatcher | undefined
  let documentInput: DocumentInputWatcher | undefined
  let disposed = false
  let suspended = false
  let pageRestored = false
  let lastError = ''
  let chipAction: PageAction = 'resume'
  let fixedActive = false
  let autoActive = false
  let proactiveSuppressed = false
  let manualFeedback = false
  let domEpoch = 0
  let reloadEpoch = 0
  let pageId = createId()
  let modesRetries = 0
  let modesRetryTimer: ReturnType<typeof setTimeout> | undefined
  let uiLanguage: UiLanguage = resolveUiLanguage('auto', languageEnvironment())
  let surfacePreferences: SurfacePreferences = { ...DEFAULT_SURFACE_PREFERENCES, language: uiLanguage }
  let floatingSuppressed = false
  let floatingEpoch = 0
  let copyResultEpoch = 0
  let floatingBusy = false
  let floatingChecking = false
  let floatingError = ''
  let legacy: { active: boolean; paused: boolean } | undefined
  const autoRequests = new Set<string>()
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const panel: TranslationPanel = createTranslationPanel()

  function disposeIfInvalidated(): boolean {
    if (isExtensionContextValid()) return false
    dispose()
    return true
  }

  async function sendMessage<M extends TranslationMessage>(
    message: M,
  ): Promise<TranslationReply<M['type']>> {
    const reply = await sendTranslationMessage(message)
    if (!reply.ok && reply.code === 'disconnected' && disposeIfInvalidated()) {
      return { ok: false, error: '', code: 'cancelled' }
    }
    return reply
  }

  function modelConfigured(): boolean {
    return config !== undefined && config.baseUrl !== '' && config.model !== ''
  }

  function autoOn(): boolean {
    return modes.enabled && modes.auto && !suspended && !pageRestored
  }

  function sameFixedEntries(
    a: Readonly<Record<string, string>> | undefined,
    b: Readonly<Record<string, string>> | undefined,
  ): boolean {
    if (a === undefined || b === undefined) return a === b
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key])
  }

  function fixedOn(): boolean {
    return modes.enabled && modes.fixed && !suspended && !pageRestored
  }

  function selectionOn(): boolean {
    return modes.enabled && modes.selection && !suspended && config?.autoInteractionEnabled !== false
  }

  function smartOn(): boolean {
    return selectionOn() && modes.smart
  }

  function proactiveOn(): boolean {
    return smartOn() && !proactiveSuppressed
  }

  function subtitlesOn(): boolean {
    return modes.enabled && modes.subtitles === true && !suspended && !pageRestored && config?.autoInteractionEnabled !== false
  }

  function inputFrameLiveAllowed(): boolean {
    if (config === undefined || !config.inputTranslationEnabled) return false
    const topUrl = currentInputFrameTopUrl()
    if (topUrl === undefined) return false
    const frameUrl = inputFrameUrl(topUrl, location.href) ?? location.href
    if (!isSiteScopeAllowed(topUrl, config) || !isSiteScopeAllowed(frameUrl, config)) return false
    if (isExcludedSite(topUrl, config.excludedHosts) || isExcludedSite(frameUrl, config.excludedHosts)) return false
    if (isSensitivePage(topUrl) || isSensitivePage(frameUrl)) return false
    return true
  }

  function inputTranslationOn(): boolean {
    if (!modes.enabled || modes.input !== true || suspended || pageRestored) return false
    return inputOnly ? inputFrameLiveAllowed() : true
  }

  function status(): PageTranslationStatus {
    return {
      supported:
        modes.enabled &&
        (modes.fixed ||
          modes.auto ||
          modes.selection ||
          modes.subtitles === true ||
          (inputOnly ? inputTranslationOn() : modes.input === true)),
      fixed: fixedActive && !pageRestored,
      auto: autoActive && engine !== undefined && !engine.isAutoPaused() && !engine.isCapped() && !pageRestored,
      paused: pageRestored || (modes.auto && (engine?.isAutoPaused() ?? false)),
      capped: engine?.isCapped() ?? false,
      budgetCapped: engine?.isBudgetCapped() ?? false,
      failed: engine?.failedCount() ?? 0,
      error: lastError,
      ...(engine === undefined ? {} : { progress: engine.progress() }),
    }
  }

  function t(key: MessageKey, params?: MessageParams): string {
    return translateMessage(uiLanguage, key, params)
  }

  function floatingEligible(): boolean {
    if (inputOnly || disposed || suspended || floatingSuppressed || config === undefined) return false
    if (!config.floatingButtonEnabled || !modes.enabled || modes.floating !== true) return false
    const url = location.href
    if (!isSiteScopeAllowed(url, config)) return false
    if (isExcludedSite(url, config.excludedHosts) || isSensitivePage(url)) return false
    return true
  }

  function floatingView(): FloatingView {
    const github = parseGitHubUrl(location.href) !== undefined
    const restored = pageRestored && (!github || legacy?.paused === true)
    const fixedOn = (fixedActive && !pageRestored) || legacy?.active === true
    let hostname = ''
    try {
      hostname = new URL(location.href).hostname
    } catch {
      /* 地址无效时主机名留空。 */
    }
    const origin = normalizeOrigin(location.href)
    const currentStatus = status()
    return {
      visible: floatingEligible(),
      hostname,
      fixedOn,
      autoEnabled: origin !== '' && (config?.autoOrigins.includes(origin) ?? false),
      pageOn: status().auto && !(config?.autoOrigins.includes(origin) ?? false),
      configured: Boolean(config?.baseUrl && config?.model),
      restored,
      canRestore: restored || fixedOn || autoOn(),
      resumable: (!currentStatus.capped || currentStatus.budgetCapped === true) &&
        (restored || currentStatus.paused || currentStatus.budgetCapped === true),
      busy: floatingBusy,
      checking: floatingChecking,
      error: floatingError,
    }
  }

  function floatingLabels(): FloatingLabels {
    return {
      title: t('appName'),
      open: t('wtFloatingOpen'),
      expand: t('wtFloatingExpand'),
      close: t('wtPanelClose'),
      move: t('wtFloatingMove'),
      translatePage: t('wtTranslatePage'),
      enable: t('wtFloatingEnable'),
      disable: t('wtFloatingDisable'),
      fold: t('wtFloatingFold'),
      disclosure: t('wtModelInlineHint'),
      autoTranslate: t('wtSiteAuto'),
      consent: t('wtConsent'),
      confirm: t('wtConsentAction'),
      cancel: t('cancel'),
      restore: t('wtRestore'),
      resume: t('wtResume'),
      settings: t('wtOpenSettings'),
      textTranslate: t('textTranslate'),
      configure: t('wtAssistConfigure'),
      fixedOn: t('wtFloatingFixedOn'),
      modelOn: t('wtFloatingModelOn'),
      modelOff: t('wtFloatingModelOff'),
      pageOn: t('wtPageOn'),
      restored: t('wtFloatingRestored'),
      paused: t('wtFloatingPaused'),
      loading: t('wtProcessing'),
      positionFailed: t('wtFloatingPositionFailed'),
    }
  }

  function floatingLive(token: number, page: string, identity: string): boolean {
    return (
      !disposed &&
      !suspended &&
      token === floatingEpoch &&
      page === pageId &&
      identity === pageIdentity(location.href) &&
      floatingEligible()
    )
  }

  function onFloatingOpen(): void {
    floatingError = ''
    floatingBusy = false
    floatingChecking = false
    const token = ++floatingEpoch
    const page = pageId
    const identity = pageIdentity(location.href)
    if (parseGitHubUrl(location.href) === undefined) {
      legacy = { active: false, paused: false }
      syncFloating()
      return
    }
    floatingChecking = true
    syncFloating()
    void sendMessage({ type: 'wt:current-page-controls', action: 'status' })
      .then((reply) => {
        if (!floatingLive(token, page, identity)) return
        if (reply.ok) legacy = reply.legacy
        else floatingError = reply.error || t('wtFloatingActionFailed')
      })
      .catch(() => {
        if (!floatingLive(token, page, identity)) return
        floatingError = t('wtFloatingActionFailed')
      })
      .finally(() => {
        if (token !== floatingEpoch || disposed) return
        floatingChecking = false
        syncFloating()
      })
  }

  function onFloatingAction(action: FloatingAction): void {
    if (floatingBusy || !floatingEligible()) return
    const view = floatingView()
    if (action === 'resume' && !view.resumable) return
    if (action === 'toggle-auto' && !view.configured && !view.autoEnabled) return
    if ((action === 'restore' || action === 'resume') && (!view.canRestore || view.checking)) return
    const token = ++floatingEpoch
    const page = pageId
    const identity = pageIdentity(location.href)
    floatingBusy = true
    floatingChecking = false
    floatingError = ''
    syncFloating()
    const origin = normalizeOrigin(location.href)
    const finish = (): void => {
      if (token !== floatingEpoch || disposed) return
      floatingBusy = false
      syncFloating()
    }
    if (action === 'translate-page') {
      void sendMessage(view.configured
        ? { type: 'wt:translate-page' }
        : { type: 'wt:open-options', section: 'model' })
        .then((reply) => {
          if (!floatingLive(token, page, identity)) return
          if (!reply.ok) floatingError = reply.error || t('wtFloatingActionFailed')
        })
        .catch(() => {
          if (!floatingLive(token, page, identity)) return
          floatingError = t('wtFloatingActionFailed')
        })
        .finally(finish)
      return
    }
    if (action === 'settings' || action === 'text-window') {
      void sendMessage(action === 'settings' ? { type: 'wt:open-options' } : { type: 'wt:open-text-window' })
        .then((reply) => {
          if (!floatingLive(token, page, identity)) return
          if (!reply.ok) floatingError = reply.error || t('wtFloatingActionFailed')
        })
        .catch(() => {
          if (!floatingLive(token, page, identity)) return
          floatingError = t('wtFloatingActionFailed')
        })
        .finally(finish)
      return
    }
    if (action === 'toggle-auto') {
      void sendMessage({
        type: 'wt:current-site-auto',
        enabled: !(config?.autoOrigins.includes(origin) ?? false),
      })
        .then((reply) => {
          if (!floatingLive(token, page, identity)) return
          if (!reply.ok) {
            floatingError = reply.error || t('wtFloatingActionFailed')
            return
          }
          void reloadAndStart()
        })
        .catch(() => {
          if (!floatingLive(token, page, identity)) return
          floatingError = t('wtFloatingActionFailed')
        })
        .finally(finish)
      return
    }
    void sendMessage({
      type: 'wt:current-page-controls',
      action,
    })
      .then((reply) => {
        if (!floatingLive(token, page, identity)) return
        if (reply.ok) legacy = reply.legacy
        else floatingError = reply.error || t('wtFloatingActionFailed')
      })
      .catch(() => {
        if (!floatingLive(token, page, identity)) return
        floatingError = t('wtFloatingActionFailed')
      })
      .finally(finish)
  }

  function floatingCallbacks(): FloatingCallbacks {
    return {
      imageUrl: browser.runtime.getURL('/icon/48.png' as Parameters<typeof browser.runtime.getURL>[0]),
      readPosition: () => floatingPositionItem.getValue(),
      writePosition: (position) => floatingPositionItem.setValue(position),
      onOpen: onFloatingOpen,
      onAction: onFloatingAction,
    }
  }

  function syncFloating(): void {
    if (disposed) return
    panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
  }

  function resetFloating(): void {
    floatingEpoch += 1
    floatingSuppressed = true
    floatingBusy = false
    floatingChecking = false
    floatingError = ''
    legacy = undefined
    syncFloating()
  }

  function syncPauseStatus(): void {
    chipAction = 'resume'
    if (!autoOn() || engine === undefined || (config?.autoInteractionEnabled === false && !manualFeedback)) panel.hidePauseStatus()
    else if (engine.isCapped()) panel.showPauseStatus(t('wtCapNotice'), engine.isBudgetCapped(), t('wtResume'), 'limit')
    else if (engine.isAutoPaused()) panel.showPauseStatus(lastError === '' ? t('wtPausedBubbleTitle') : lastError, true, undefined, lastError === '' ? 'paused' : 'error')
    else if (engine.failedCount() > 0) {
      chipAction = 'retry-failed'
      panel.showPauseStatus(t('wtFailedCount', { count: engine.failedCount() }), true, t('wtRetryFailed'), 'error')
    } else panel.hidePauseStatus()
    syncFloating()
  }

  function cancelAutomatic(): void {
    domEpoch += 1
    for (const id of autoRequests) {
      void sendTranslationMessage({ type: 'wt:cancel-assist', requestId: id })
    }
    autoRequests.clear()
    engine?.invalidate()
  }

  const assist = createAssistance({
    panel,
    enabled: () => modes.enabled && !suspended && !disposed && !disposeIfInvalidated(),
    configured: modelConfigured,
    smart: proactiveOn,
    pageId: () => pageId,
    message: t,
  })

  function cancelAssist(): void {
    assist.cancel()
  }

  function cancelAll(keepFloatingMenu = false): void {
    toolbarSelection = undefined
    cancelAutomatic()
    assist.cancel()
    panel.close(keepFloatingMenu ? { keepFloatingMenu: true } : undefined)
    reading?.reset()
  }

  function literalTranslate(source: string, manualSelectionId?: string): void {
    if (disposeIfInvalidated()) return
    assist.literal(source, undefined, undefined, manualSelectionId)
  }

  function ensureWatcher(): void {
    if (watcher !== undefined) return
    watcher = watchSelection({
      enabled: () => selectionOn() && !disposed,
      isInsidePanel: (event) => panel.containsEvent(event),
      onDismiss: () => {
        cancelAssist()
        panel.close()
      },
      onSelect: (text, anchor, method, stillValid) => {
        if (disposeIfInvalidated()) return
        cancelAssist()
        if (config?.selectionToolbarEnabled === true) {
          const selected: ToolbarSelection = { text, anchor, method, stillValid }
          toolbarSelection = selected
          panel.showToolbar(anchor, modelConfigured(), (action) => {
            if (toolbarSelection !== selected) return
            if (disposeIfInvalidated() || !selectionOn() || disposed || !stillValid()) {
              panel.close()
              return
            }
            if (action === 'copy') {
              void copySelectionText(text).then((copied) => {
                if (toolbarSelection === selected && selectionOn() && !disposed && stillValid()) {
                  panel.setToolbarCopyResult(copied)
                }
              })
              return
            }
            toolbarSelection = undefined
            if (action === 'translate') assist.literal(text, anchor, stillValid)
            else assist.select(text, anchor, method, stillValid, action)
          })
          return
        }
        assist.select(text, anchor, method, stillValid)
      },
      acceptText: (text) =>
        config?.selectionToolbarEnabled === true
          ? /\p{L}/u.test(text)
          : isAssistanceCandidateText(text, config?.sourceLanguage ?? 'auto'),
      focusToolbar: () => panel.focusToolbar(),
    })
  }

  function ensureReading(): void {
    if (reading !== undefined) return
    reading = watchReadingSignals({
      enabled: proactiveOn,
      hasActiveSelection: () => {
        if (panel.isOpen()) return true
        const selection = window.getSelection()
        return selection !== null && !selection.isCollapsed
      },
      isInsidePanel: (event) => panel.containsEvent(event),
      onCandidate: (candidate: ReadingCandidate) => {
        if (disposeIfInvalidated()) return
        assist.revisit(candidate)
      },
      onInvalidate: () => {
        cancelAssist()
      },
      acceptText: (text) => isAssistanceCandidateText(text, config?.sourceLanguage ?? 'auto'),
    })
  }

  function ensureSubtitles(): void {
    if (subtitles !== undefined) return
    subtitles = createSubtitleTranslation({
      translate: (texts, requestId) =>
        sendMessage({
          type: 'wt:translate',
          mode: 'subtitle',
          texts,
          requestId,
        }),
      cancel: (requestId) => {
        void sendTranslationMessage({ type: 'wt:cancel-assist', requestId })
      },
      t: (key) => t(key),
    })
  }

  function ensureInputTranslation(): void {
    if (inputTranslation !== undefined) return
    inputTranslation = createInputTranslation({
      autoPreview: () => config?.autoInteractionEnabled !== false,
      sourceLanguage: () => config?.inputSourceLanguage ?? 'auto',
      targetLanguage: () => config?.inputTargetLanguage ?? 'en',
      replaceKey: () => config?.inputReplaceKey ?? DEFAULT_INPUT_REPLACE_KEY,
      replaceMode: () => config?.inputReplaceMode ?? 'hotkey',
      autoReplaceDelayMs: () => config?.inputAutoReplaceDelayMs ?? INPUT_AUTO_REPLACE_DELAY_DEFAULT,
      translate: async (texts, requestId, manualInput) => {
        if (!inputTranslationOn()) {
          return { ok: false, error: t('wtInputUnavailable') }
        }
        return sendMessage({
          type: 'wt:translate',
          mode: 'input',
          texts,
          requestId,
          ...(manualInput === true ? { manualInput: true } : {}),
        })
      },
      cancel: (requestId) => {
        void sendTranslationMessage({ type: 'wt:cancel-assist', requestId })
      },
      t: (key, params) => t(key, params),
      appearance: () => surfacePreferences,
      iconUrl: browser.runtime.getURL('/icon/48.png' as Parameters<typeof browser.runtime.getURL>[0]),
      ...(inputOnly
        ? {}
        : {
            replaceDiscordInput: async (request) => {
              const reply = await sendMessage({ type: 'wt:replace-discord-input', ...request })
              return reply.ok ? reply.inputReplacement : 'failed'
            },
            replaceChatInput: async (request) => {
              const reply = await sendMessage({ type: 'wt:replace-chat-input', ...request })
              return reply.ok ? reply.inputReplacement : 'failed'
            },
          }),
    })
    if (documentInput === undefined) {
      documentInput = createDocumentInputTranslation({
        enabled: inputTranslationOn,
        translate: (texts, requestId) =>
          sendMessage({ type: 'wt:translate', mode: 'input', texts, requestId, manualInput: true }),
        cancel: (requestId) => {
          void sendTranslationMessage({ type: 'wt:cancel-assist', requestId })
        },
        editor: async (request: DocumentEditorRequest): Promise<DocumentEditorResult> => {
          const message: TranslationMessage =
            request.action === 'read'
              ? { type: 'wt:document-input', elementId: request.elementId, action: 'read' }
              : {
                  type: 'wt:document-input',
                  elementId: request.elementId,
                  action: 'replace',
                  expectedText: request.expectedText ?? '',
                  text: request.text ?? '',
                }
          const reply = await sendMessage(message)
          return reply.ok && reply.editor !== undefined ? reply.editor : { status: 'failed' }
        },
        t: (key, params) => t(key, params),
        appearance: () => surfacePreferences,
        iconUrl: browser.runtime.getURL('/icon/48.png' as Parameters<typeof browser.runtime.getURL>[0]),
        sourceLanguage: () => config?.inputSourceLanguage ?? 'auto',
        targetLanguage: () => config?.inputTargetLanguage ?? 'en',
      })
    }
  }

  function disposeLiveFeatures(): void {
    subtitles?.dispose()
    subtitles = undefined
    inputTranslation?.dispose()
    inputTranslation = undefined
    documentInput?.dispose()
    documentInput = undefined
  }

  function disposeWatchers(): void {
    watcher?.dispose()
    watcher = undefined
    reading?.dispose()
    reading = undefined
    disposeLiveFeatures()
  }

  function syncWatchers(): void {
    if (disposed || suspended) return
    if (selectionOn()) ensureWatcher()
    else if (watcher !== undefined) {
      watcher.dispose()
      watcher = undefined
    }
    if (proactiveOn()) ensureReading()
    else if (reading !== undefined) {
      reading.dispose()
      reading = undefined
    }
    if (subtitlesOn()) ensureSubtitles()
    else if (subtitles !== undefined) {
      subtitles.dispose()
      subtitles = undefined
    }
    if (inputTranslationOn()) ensureInputTranslation()
    else {
      inputTranslation?.dispose()
      inputTranslation = undefined
      documentInput?.dispose()
      documentInput = undefined
    }
    if (!selectionOn() && !proactiveOn()) cancelAssist()
    tracker.refresh()
  }

  function ensureEngine(): DomEngine {
    if (engine !== undefined) return engine
    const created = createDomEngine({
      fixedEnabled: fixedOn,
      autoEnabled: autoOn,
      targetLanguage: () => config?.targetLanguage ?? 'zh-CN',
      autoBudget: () => config?.pageCharLimit ?? DEFAULT_PAGE_CHAR_LIMIT,
      sourceLanguage: () => config?.sourceLanguage ?? 'auto',
      translateFixed: (text) =>
        modes.fixedEntries === undefined ? undefined : fixedTranslationWith(modes.fixedEntries, text),
      onCapped() {
        if (autoOn()) syncPauseStatus()
        else if (!panel.isOpen() && (config?.autoInteractionEnabled !== false || manualFeedback)) {
          panel.showNotice(t('wtCapNotice'))
        }
      },
      onCapReleased: syncPauseStatus,
      onFailedChanged: syncPauseStatus,
      onAutoBatch(texts, apply) {
        const id = createId()
        const epoch = domEpoch
        const doc = pageId
        const href = pageIdentity(location.href)
        autoRequests.add(id)
        void sendMessage({
          type: 'wt:translate',
          mode: 'auto',
          texts,
          requestId: id,
          page: collectPageContext(),
          pageId: doc,
        }).then((reply) => {
          autoRequests.delete(id)
          if (disposed || suspended || epoch !== domEpoch || doc !== pageId || href !== pageIdentity(location.href) || !autoOn()) {
            return
          }
          let outcome: AutoBatchOutcome
          if (reply.ok && reply.texts !== undefined && reply.texts.length === texts.length) {
            outcome = apply(reply.texts, undefined, reply.cachedChars)
          } else {
            void sendTranslationMessage({ type: 'wt:cancel-assist', requestId: id })
            outcome = reply.ok
              ? apply(undefined, { code: 'bad_output' })
              : apply(undefined, {
                  code: reply.code ?? 'unknown',
                  ...(reply.retryAfterMs === undefined ? {} : { retryAfterMs: reply.retryAfterMs }),
                })
          }
          if (outcome !== 'paused') return
          lastError = reply.ok ? '翻译服务返回格式不正确' : reply.error
          syncPauseStatus()
        })
      },
    })
    engine = created
    return created
  }

  function applyModes(force = false): void {
    if (disposed) return
    syncWatchers()
    const nextFixed = fixedOn()
    const nextAuto = autoOn()
    if (!force && nextFixed === fixedActive && nextAuto === autoActive) {
      // 导航会取消待扫任务；最新的刷新即使模式未变也要接续扫描。
      if (nextFixed || nextAuto) engine?.start()
      return
    }
    const startingAuto = nextAuto && !autoActive
    cancelAutomatic()
    engine?.restore()
    if (force) engine?.resetBudget()
    fixedActive = nextFixed
    autoActive = nextAuto
    if (nextFixed || nextAuto) {
      const active = ensureEngine()
      if (startingAuto || force) active.resumeAuto()
      active.start()
    }
  }

  const tracker = createPageContextTracker({
    enabled: () => smartOn() && !disposed && !suspended,
    pageId: () => pageId,
    send: async () => {
      const reply = await sendMessage({ type: 'wt:page-context', page: collectPageContext(), pageId })
      return reply.ok
    },
  })

  function onShowSelection(text: string, error: string | undefined, manualSelectionId?: string): void {
    if (error !== undefined) {
      cancelAssist()
      if (error === SENSITIVE_FRAME_ERROR) {
        panel.showNotice(t('wtSensitiveFrameUnsupported'))
        return
      }
      if (error === NO_SELECTION_ERROR || error === NOTHING_TO_TOGGLE_ERROR) {
        panel.showNotice(t(error === NO_SELECTION_ERROR ? 'wtNoSelection' : 'wtNothingToToggle'))
        return
      }
      panel.showNotice(error === SITE_SCOPE_BLOCKED_ERROR ? t('wtScopeBlocked') : error)
      return
    }
    literalTranslate(text, manualSelectionId)
  }

  function onPageAction(action: PageAction, pageUrl?: string): ContentTranslationReply<'wt:page-action'> {
    if (pageUrl !== undefined && pageIdentity(pageUrl) !== pageIdentity(location.href)) {
      return { ok: false, error: '页面已变化' }
    }
    manualFeedback = action !== 'restore'
    if (action === 'retry-failed') {
      if (engine?.retryFailed() !== true) {
        return { ok: false, error: t(engine?.isCapped() === true ? 'wtAutoCapped' : 'wtAutoPaused') }
      }
      syncPauseStatus()
      return { ok: true }
    }
    if (action === 'restore') {
      // 由悬浮菜单触发时保留菜单：恢复后的状态与可能的错误要在菜单里看到，焦点也不丢
      cancelAll(true)
      pageRestored = true
      engine?.restore()
      lastError = ''
      applyModes()
      syncPauseStatus()
      return { ok: true }
    }
    lastError = ''
    proactiveSuppressed = false
    pageRestored = false
    // 用户明确要求继续：字符上限追加一份额度；记录数上限无法追加。
    if (engine?.isCapped() === true && !engine.extendBudget()) {
      lastError = t('wtAutoCapped')
      applyModes()
      syncPauseStatus()
      return { ok: false, error: lastError }
    }
    engine?.resumeAuto()
    applyModes()
    syncPauseStatus()
    return { ok: true }
  }

  function onNavigate(): void {
    if (disposed) return
    resetFloating()
    pageId = createId()
    proactiveSuppressed = false
    manualFeedback = false
    pageRestored = false
    lastError = ''
    panel.hidePauseStatus()
    cancelAll()
    tracker.reset()
    disposeWatchers()
    reloadAndStart()
  }

  function reloadAndStart(): void {
    void reload().then((applied) => {
      if (applied && !disposed && !suspended && (fixedOn() || autoOn())) engine?.start()
      syncPauseStatus()
    })
  }

  async function reload(): Promise<boolean> {
    const epoch = ++reloadEpoch
    const floatEpoch = floatingEpoch
    clearTimeout(modesRetryTimer)
    const hadEnabled = modes.enabled
    const hadFixed = modes.fixed
    const hadAuto = modes.auto
    const hadSelection = modes.selection
    const hadSmart = modes.smart
    const hadFixedEntries = modes.fixedEntries
    const previousConfig = config ?? DEFAULT_TRANSLATION_CONFIG
    const hadToolbar = config?.selectionToolbarEnabled === true
    try {
      const [nextConfig, nextSettings, modesReply] = await Promise.all([
        getTranslationConfig(),
        getSettings(),
        sendMessage({ type: 'wt:page-modes' }),
      ])
      if (disposed || suspended || epoch !== reloadEpoch) return false
      const previousUiLanguage = uiLanguage
      uiLanguage = resolveUiLanguage(nextSettings.uiLanguage, languageEnvironment())
      surfacePreferences = { uiStyle: nextSettings.uiStyle, theme: nextSettings.theme, language: uiLanguage }
      if (previousUiLanguage !== uiLanguage) {
        disposeLiveFeatures()
      }
      panel.setLabels({
        translate: t('wtPanelTranslate'),
        define: t('wtPanelDefine'),
        explain: t('wtPanelExplain'),
        none: t('wtPanelNone'),
        result: t('wtPanelResult'),
        close: t('wtPanelClose'),
        literal: t('wtPanelLiteral'),
        dismiss: t('wtPanelDismiss'),
        hint: t('wtPanelHint'),
        source: t('wtPanelSource'),
        loading: t('wtPanelLoading'),
        resume: t('wtPanelResume'),
        toolbar: t('wtModeToolbar'),
        toolbarTranslate: t('wtToolbarTranslate'),
        toolbarDefine: t('wtToolbarDefine'),
        toolbarExplain: t('wtToolbarExplain'),
        copy: t('wtToolbarCopy'),
        copied: t('wtToolbarCopied'),
        copyFailed: t('wtToolbarCopyFailed'),
        configureHint: t('wtToolbarConfigureHint'),
        failed: t('wtRetryBubbleTitle'),
        retry: t('wtRetryBubbleAction'),
        paused: t('wtPausedBubbleTitle'),
        limit: t('wtLimitBubbleTitle'),
        more: t('wtMoreActions'),
        details: t('wtErrorDetails'),
      })
      if (!modesReply.ok && modesReply.code === 'disconnected' && modesRetries < MAX_MODES_RETRIES) {
        // 后台正在重启：保持当前模式，不还原页面，稍后重读。
        modesRetries += 1
        modesRetryTimer = setTimeout(reloadAndStart, MODES_RETRY_MS)
        return false
      }
      modesRetries = 0
      const rawModes =
        modesReply.ok && modesReply.modes !== undefined
          ? modesReply.modes
          : { enabled: false, fixed: false, auto: false, selection: false, smart: false }
      const nextModes: PageModes = inputOnly
        ? {
            enabled: rawModes.enabled,
            fixed: false,
            auto: false,
            selection: false,
            smart: false,
            floating: false,
            subtitles: false,
            input: rawModes.input === true,
          }
        : rawModes
      if (
        pageRestored &&
        (nextModes.enabled !== hadEnabled ||
          nextModes.fixed !== hadFixed ||
          nextModes.auto !== hadAuto ||
          nextModes.subtitles !== modes.subtitles ||
          nextModes.input !== modes.input)
      ) {
        pageRestored = false
      }
      const connectionChanged = translationOutputChanged(previousConfig, nextConfig)
      if (
        connectionChanged ||
        nextConfig.videoSubtitlesEnabled !== previousConfig.videoSubtitlesEnabled ||
        nextConfig.inputTranslationEnabled !== previousConfig.inputTranslationEnabled ||
        nextConfig.inputTargetLanguage !== previousConfig.inputTargetLanguage ||
        nextConfig.inputSourceLanguage !== previousConfig.inputSourceLanguage ||
        nextConfig.inputReplaceKey !== previousConfig.inputReplaceKey ||
        nextConfig.inputReplaceMode !== previousConfig.inputReplaceMode ||
        nextConfig.inputAutoReplaceDelayMs !== previousConfig.inputAutoReplaceDelayMs ||
        nextConfig.autoInteractionEnabled !== previousConfig.autoInteractionEnabled ||
        nextModes.subtitles !== modes.subtitles ||
        nextModes.input !== modes.input
      ) {
        disposeLiveFeatures()
      }
      const interactiveChanged =
        nextModes.enabled !== hadEnabled ||
        nextModes.selection !== hadSelection ||
        nextModes.smart !== hadSmart ||
        nextConfig.selectionToolbarEnabled !== hadToolbar ||
        nextConfig.autoInteractionEnabled !== previousConfig?.autoInteractionEnabled
      if (nextConfig.autoInteractionEnabled !== previousConfig?.autoInteractionEnabled) manualFeedback = false
      const manualNotice = nextSettings.enabled && nextModes.enabled
        ? assist.manualCancellationNotice(connectionChanged)
        : undefined
      config = nextConfig
      modes = nextModes
      panel.setPreferences(surfacePreferences)
      // 词条表内容变化（词典开关/自定义词典编辑）后强制重扫：恢复旧替换再用新表写。
      if (nextModes.fixed && hadFixedEntries !== undefined && !sameFixedEntries(nextModes.fixedEntries, hadFixedEntries)) {
        fixedActive = false
      }
      if (connectionChanged || interactiveChanged) {
        assist.cancel()
        if (manualNotice === undefined) panel.close()
        reading?.reset()
      }
      if (floatEpoch === floatingEpoch) floatingSuppressed = false
      applyModes(connectionChanged)
      if (nextConfig.pageCharLimit !== previousConfig.pageCharLimit) engine?.budgetChanged()
      if (manualNotice !== undefined) panel.showNotice(t(manualNotice))
      syncPauseStatus()
      return true
    } catch {
      if (disposed || suspended || epoch !== reloadEpoch || disposeIfInvalidated()) return false
      cancelAll()
      modes = { enabled: false, fixed: false, auto: false, selection: false, smart: false }
      fixedActive = false
      autoActive = false
      engine?.restore()
      disposeWatchers()
      tracker.refresh()
      panel.hidePauseStatus()
      lastError = t('wtSettingsReadFailed')
      resetFloating()
      return false
    } finally {
      resolveReady()
      if (!disposed && epoch === reloadEpoch) syncFloating()
    }
  }

  function stopInstance(): void {
    reloadEpoch += 1
    resetFloating()
    cancelAll()
    modes = { enabled: false, fixed: false, auto: false, selection: false, smart: false }
    fixedActive = false
    autoActive = false
    disposeWatchers()
    engine?.restore()
    tracker.refresh()
    panel.hidePauseStatus()
  }

  const messageListener = (
    message: unknown,
    sender: { id?: string; tab?: unknown },
    sendResponse: (reply?: unknown) => void,
  ): true | undefined => {
    if (!isContentTranslationMessage(message)) return undefined
    if (disposeIfInvalidated() || sender.id !== browser.runtime.id || sender.tab !== undefined) return undefined
    if (message.type === 'wt:refresh-input-frame' || message.type === 'wt:stop-input-frame') {
      if (!inputOnly) return undefined
      if (message.type === 'wt:stop-input-frame') {
        stopInstance()
        sendResponse({ ok: true } satisfies ContentTranslationReply<'wt:stop-input-frame'>)
        return true
      }
      void ready.then(() => {
        void reload().then(() => {
          sendResponse({ ok: true } satisfies ContentTranslationReply<'wt:refresh-input-frame'>)
        })
      })
      return true
    }
    if (
      inputOnly &&
      message.type !== 'wt:refresh' &&
      message.type !== 'wt:stop' &&
      message.type !== 'wt:status' &&
      message.type !== 'wt:translate-input'
    ) {
      return undefined
    }
    if (message.type === 'wt:stop') {
      stopInstance()
      sendResponse({ ok: true } satisfies ContentTranslationReply<'wt:stop'>)
      return true
    }
    void ready.then(() => {
      switch (message.type) {
        case 'wt:show-selection':
          onShowSelection(message.text, message.error, message.manualSelectionId)
          sendResponse({ ok: true } satisfies ContentTranslationReply<'wt:show-selection'>)
          return
        case 'wt:page-action':
          sendResponse(onPageAction(message.action, message.url) satisfies ContentTranslationReply<'wt:page-action'>)
          return
        case 'wt:refresh':
          void reload().then(() => {
            sendResponse({ ok: true } satisfies ContentTranslationReply<'wt:refresh'>)
          })
          return
        case 'wt:status':
          sendResponse({ ok: true, status: status() } satisfies ContentTranslationReply<'wt:status'>)
          return
        case 'wt:read-selection':
          sendResponse({ ok: true, text: readSelectionText() } satisfies ContentTranslationReply<'wt:read-selection'>)
          return
        case 'wt:translate-input': {
          if (inputTranslationOn()) ensureInputTranslation()
          const accepted = inputTranslationOn() && inputTranslation?.translateAndReplace() === true
          if (accepted) {
            sendResponse({ ok: true } satisfies ContentTranslationReply<'wt:translate-input'>)
            return
          }
          if (!inputTranslationOn() || documentInput === undefined) {
            sendResponse(
              { ok: false, error: t('wtInputUnavailable') } satisfies ContentTranslationReply<'wt:translate-input'>,
            )
            return
          }
          void documentInput
            .translate()
            .then((handled) => {
              sendResponse(
                handled
                  ? ({ ok: true } satisfies ContentTranslationReply<'wt:translate-input'>)
                  : ({ ok: false, error: t('wtInputUnavailable') } satisfies ContentTranslationReply<'wt:translate-input'>),
              )
            })
            .catch(() => {
              sendResponse(
                { ok: false, error: t('wtInputUnavailable') } satisfies ContentTranslationReply<'wt:translate-input'>,
              )
            })
        }
      }
    })
    return true
  }

  panel.setOnClose(() => {
    toolbarSelection = undefined
    cancelAssist()
    watcher?.dismiss()
  })
  panel.setOnResume(() => {
    const reply = onPageAction(chipAction)
    if (!reply.ok) {
      lastError = reply.error
      syncPauseStatus()
    }
  })
  panel.setOnLiteral(() => {
    if (disposeIfInvalidated()) return
    assist.repeatLiteral()
  })
  panel.setOnRetry(() => {
    if (disposeIfInvalidated()) return
    assist.repeatRequest()
  })
  panel.setOnDismissProactive(() => {
    proactiveSuppressed = true
    reading?.dispose()
    reading = undefined
    cancelAssist()
  })
  panel.setOnCopyResult((text) => {
    const token = ++copyResultEpoch
    void copySelectionText(text).then((copied) => {
      if (!disposed && token === copyResultEpoch) panel.setCopyResultFeedback(copied)
    })
  })

  const lifecycleDispose = watchPageLifecycle({
    onNavigate,
    onSuspend() {
      reloadEpoch += 1
      suspended = true
      manualFeedback = false
      resetFloating()
      cancelAll()
      // 打开的端口会让部分浏览器放弃往返缓存，恢复后由下一个请求重新连接。
      closePageSession()
      disposeWatchers()
      tracker.refresh()
    },
    onResume() {
      if (disposed) return
      suspended = false
      pageId = createId()
      tracker.reset()
      reloadAndStart()
    },
    onUnload() {
      dispose()
    },
  })

  const unwatchConfig = watchTranslationConfig((next) => {
    const url = location.href
    disposeLiveFeatures()
    if (
      next.floatingButtonEnabled === false ||
      !isSiteScopeAllowed(url, next) ||
      isExcludedSite(url, next.excludedHosts) ||
      isSensitivePage(url)
    ) {
      floatingSuppressed = true
      floatingEpoch += 1
      floatingBusy = false
      floatingChecking = false
      syncFloating()
    }
    void reload()
  })
  const unwatchSettings = watchSettings((next) => {
    surfacePreferences = { ...surfacePreferences, uiStyle: next.uiStyle, theme: next.theme }
    panel.setPreferences(surfacePreferences)
    disposeLiveFeatures()
    if (!next.enabled) {
      pageRestored = false
      floatingSuppressed = true
      floatingEpoch += 1
      floatingBusy = false
      floatingChecking = false
      floatingError = ''
      legacy = undefined
      syncFloating()
    }
    void reload()
  })

  const invalidationTimer = setInterval(() => {
    disposeIfInvalidated()
  }, INVALIDATION_CHECK_MS)

  function dispose(): void {
    if (disposed) return
    disposed = true
    resetFloating()
    cancelAll()
    closePageSession()
    clearTimeout(modesRetryTimer)
    clearInterval(invalidationTimer)
    reloadEpoch += 1
    domEpoch += 1
    try {
      unwatchConfig()
    } catch {
      void 0
    }
    try {
      unwatchSettings()
    } catch {
      void 0
    }
    disposeWatchers()
    tracker.dispose()
    lifecycleDispose()
    try {
      browser.runtime.onMessage.removeListener(messageListener)
    } catch {
      void 0
    }
    engine?.dispose()
    panel.dispose()
    const scope = globalThis as Record<symbol, unknown>
    delete scope[SINGLETON_KEY]
  }

  browser.runtime.onMessage.addListener(messageListener)

  void reload()

  return {
    dispose,
    refresh() {
      if (disposed || disposeIfInvalidated()) return
      void reload()
    },
    healthy() {
      return !disposed && isExtensionContextValid()
    },
  }
}

export async function startPageTranslation(options: StartPageTranslationOptions = {}): Promise<void> {
  const inputOnly = options.inputOnly === true
  if (inputOnly) {
    if (window.top === window || currentInputFrameTopUrl() === undefined) return
  } else if (window.top !== window) {
    return
  }
  const scope = globalThis as Record<symbol, Instance | undefined>
  const existing = scope[SINGLETON_KEY]
  if (existing !== undefined) {
    if (existing.healthy()) return
    existing.dispose()
  }
  scope[SINGLETON_KEY] = createInstance(inputOnly)
}
