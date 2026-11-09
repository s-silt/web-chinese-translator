import { browser, type Browser } from 'wxt/browser'
import {
  clearManualPages,
  expireNavigatedManualPage,
  getManualPageGrant,
  putManualPageGrant,
  revokeManualPageGrant,
  sameManualPage,
  type ManualPageGrant,
} from './manual-page'
import { languageEnvironment } from '../shared/language-env'
import { resolveUiLanguage, type UiLanguage } from '../shared/locale'
import { parseGitHubUrl } from '../shared/github'
import { isGitHubPageReply } from '../shared/messages'
import { getSettings, watchSettings } from '../shared/settings'
import { sendToTabMessage } from '../shared/tab-messages'
import {
  completionUrl,
  hostPermissionPattern,
  getTranslationConfig,
  isInputAutoReplaceDelay,
  isInputReplaceMode,
  normalizeBaseUrl,
  normalizeOrigin,
  sanitizeTranslationConfig,
  translationConfigItem,
  watchTranslationConfig,
  type TranslationConfig,
} from './config'
import type { AssistInput } from './intent'
import { clearAssistCache, getCachedAssistance, inferAssistance } from './intent-provider'
import {
  currentRevision,
  invalidateModelState,
  modelRequestConfig,
  modelSnapshot,
  readConsistentModelState,
  serializeMutation,
  type ModelSnapshot,
} from './model-state'
import { clearPageContexts, installContextExpiry, recentPageContexts, recordPageContext } from './context-memory'
import { normalizeHotkey } from './input-hotkey'
import { isPageId, type PageContext, type TranslationContext } from './reading-context'
import {
  isApiType,
  isTemperature,
  normalizeCustomHeaders,
  normalizeRequestParams,
  requestOptionsKey,
  type JsonObject,
} from './request-options'
import { readManualSelection, type ManualSelectionSnapshot } from './selection'
import {
  isContentTranslationReply,
  isTranslationMessage,
  NO_SELECTION_ERROR,
  NOTHING_TO_TOGGLE_ERROR,
  PAGE_PORT_PREFIX,
  SENSITIVE_FRAME_ERROR,
  TRANSLATION_CONFIG_CHANGED_ERROR,
  TRANSLATION_PERMISSION_REMOVED_ERROR,
  type CustomHeadersState,
  type KeyState,
  type ContentTranslationMessage,
  type TranslationConfigPatch,
  type TranslationFailure,
  type TranslationMessage,
  type TranslationReply,
} from './messages'
import { translateTexts, TranslationError } from './provider'
import {
  clearApiKey,
  credentialOrigin,
  readApiKey,
  readCustomHeaders,
  readStoredApiKey,
  readStoredCustomHeaders,
  validateApiKey,
  writeApiKey,
  writeStoredApiKey,
  writeStoredCustomHeaders,
  type BoundCustomHeaders,
} from './secrets'
import { clearPersistentTranslations } from './persistent-cache'
import { clearTranslationCache, requestTranslation } from './queue'
import {
  cancelModelTasks,
  clearAutomaticPause,
  describeFailure,
  modelSchedulerGeneration,
  restoreAutomaticPause,
  scheduleModelTask,
} from './scheduler'
import { CompletionCancelledError, requestModelList } from './transport'
import {
  installSiteScriptSync,
  SITE_SCRIPT_FILES,
  syncAllSiteScripts,
  syncSiteScript,
  syncSiteTabs,
} from './registration'
import {
  INPUT_FRAME_SCRIPT_FILES,
  isYouTubeInputFramePair,
  isYouTubePageUrl,
  parseInputFrameDocument,
  readInputFrameDocuments,
  readInputFrameSnapshot,
} from './input-frame'
import { EXCLUDED_LIMIT_ERROR, isExcludedSite, isSensitivePage, MAX_EXCLUDED_HOSTS, normalizeExcludedHost, sanitizeExcludedHosts } from './page-policy'
import { isSupportedChatUrl, replaceChatDraftInMainWorld } from './chat-input'
import { isDiscordChatUrl, replaceDiscordDraftInMainWorld, type DiscordReplacementStatus } from './discord-input'
import {
  isSiteScopeAllowed,
  MAX_SITE_SCOPE_HOSTS,
  SITE_SCOPE_BLOCKED_ERROR,
  SITE_SCOPE_INVALID_ERROR,
  SITE_SCOPE_LIMIT_ERROR,
} from './site-scope'
import { dictionariesForHostname, BUILTIN_DICTIONARY_META } from './dictionaries/index'
import { mergeFixedEntries } from './dictionaries/entries'
import { getCustomDictionaries } from './custom-dictionaries'
import {
  translationOutputChanged,
  readingPolicyChanged,
  requestAffected,
  sameList,
  type RequestKind,
  type RequestScope,
} from './config-impact'

type MessageSender = Browser.runtime.MessageSender

const MENU_ID = 'wt-selection'
const PAGE_MENU_ID = 'wt-page'
type MenuClickInfo = Parameters<Parameters<typeof browser.contextMenus.onClicked.addListener>[0]>[0]
const PAGE_MENU_TITLES: Readonly<Record<UiLanguage, string>> = {
  'zh-CN': '翻译本页 / 恢复原文',
  'zh-TW': '翻譯本頁 / 還原原文',
  en: 'Translate this page / restore original',
  ja: 'このページを翻訳 / 原文に戻す',
  ko: '이 페이지 번역 / 원문 복원',
}
const SELECTION_MENU_TITLES: Readonly<Record<UiLanguage, string>> = {
  'zh-CN': '翻译选中文字',
  'zh-TW': '翻譯選中文字',
  en: 'Translate selected text',
  ja: '選択したテキストを翻訳',
  ko: '선택한 텍스트 번역',
}
let menuRevision = 0
const AUTO_MAX_ITEMS = 20
const AUTO_MAX_TOTAL = 4000
const AUTO_MAX_TEXT = 1500

function reportError(_error: unknown): void {
  console.error('[网页汉化助手] 后台任务失败')
}

function fromExtensionPage(sender: MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(browser.runtime.getURL('/'))
  )
}

function fromOurContent(sender: MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.tab?.id === 'number' &&
    sender.frameId === 0 &&
    typeof sender.url === 'string' &&
    /^https?:/.test(sender.url)
  )
}

function fromOurInputFrame(sender: MessageSender): boolean {
  if (
    sender.id !== browser.runtime.id ||
    typeof sender.tab?.id !== 'number' ||
    !Number.isSafeInteger(sender.tab.id) ||
    sender.tab.id < 0 ||
    sender.tab.incognito === true ||
    typeof sender.frameId !== 'number' ||
    !Number.isSafeInteger(sender.frameId) ||
    sender.frameId <= 0 ||
    typeof sender.documentId !== 'string' ||
    sender.documentId === '' ||
    sender.documentId.length > 256 ||
    typeof sender.url !== 'string' ||
    typeof sender.tab.url !== 'string' ||
    typeof sender.origin !== 'string' ||
    !isYouTubeInputFramePair(sender.tab.url, sender.url)
  ) {
    return false
  }
  const expectedOrigin = normalizeOrigin(sender.url)
  return expectedOrigin !== '' && sender.origin === expectedOrigin
}

async function inputFrameAllowed(sender: MessageSender, config: TranslationConfig): Promise<boolean> {
  if (!fromOurInputFrame(sender) || !config.inputTranslationEnabled) return false
  const tabId = sender.tab!.id!
  const frameId = sender.frameId!
  const documentId = sender.documentId!
  const sourceUrl = sender.url!
  const tabs = browser.tabs
  const scripting = browser.scripting
  if (typeof tabs?.get !== 'function' || typeof scripting?.executeScript !== 'function') return false
  try {
    const currentTab = await tabs.get(tabId)
    if (currentTab.incognito === true || typeof currentTab.url !== 'string') return false
    const topUrl = currentTab.url
    if (!isYouTubeInputFramePair(topUrl, sourceUrl)) return false
    if (!isSiteScopeAllowed(topUrl, config) || !isSiteScopeAllowed(sourceUrl, config)) return false
    if (isExcludedSite(topUrl, config.excludedHosts) || isExcludedSite(sourceUrl, config.excludedHosts)) return false
    if (isSensitivePage(topUrl) || isSensitivePage(sourceUrl)) return false
    const origin = normalizeOrigin(sourceUrl)
    if (origin === '' || !(await originAllowed(origin))) return false
    const results: unknown = await scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      func: readInputFrameSnapshot,
    })
    if (!Array.isArray(results) || results.length !== 1) return false
    const parsed = parseInputFrameDocument(results[0])
    if (parsed === undefined) return false
    return (
      parsed.frameId === frameId &&
      parsed.documentId === documentId &&
      parsed.snapshot.url === sourceUrl &&
      parsed.snapshot.topUrl === topUrl
    )
  } catch {
    return false
  }
}

async function keyStateFor(baseUrl: string): Promise<{ keyState: KeyState; hasKey?: boolean }> {
  const origin = credentialOrigin(baseUrl)
  try {
    const stored = await readStoredApiKey()
    if (stored === undefined) return { keyState: 'none', hasKey: false }
    if (typeof stored === 'string') return { keyState: 'legacy', hasKey: true }
    if (origin !== '' && stored.origin === origin) return { keyState: 'ready', hasKey: true }
    return { keyState: 'different-origin', hasKey: true }
  } catch {
    return { keyState: 'unavailable' }
  }
}

async function customHeadersStateFor(baseUrl: string, revision: string): Promise<CustomHeadersState> {
  if (revision === '') return 'none'
  const origin = credentialOrigin(baseUrl)
  try {
    const stored = await readStoredCustomHeaders()
    if (stored === undefined || stored.revision !== revision) return 'unavailable'
    if (origin !== '' && stored.origin === origin) return 'ready'
    return 'different-origin'
  } catch {
    return 'unavailable'
  }
}

async function endpointAllowed(baseUrl: string): Promise<boolean> {
  const url = completionUrl(baseUrl)
  if (url === '') return false
  if (typeof browser.permissions?.contains !== 'function') return false
  try {
    return await browser.permissions.contains({ origins: [hostPermissionPattern(url)] })
  } catch {
    return false
  }
}

function failureReply(error: unknown): TranslationFailure {
  return { ok: false, ...describeFailure(error) }
}

function unavailableReply(snapshot: ModelSnapshot | undefined): TranslationFailure {
  return snapshot === undefined ? { ok: false, error: SNAPSHOT_ERROR } : failureReply(new CompletionCancelledError())
}

async function patternAllowed(pattern: string): Promise<boolean> {
  if (typeof browser.permissions?.contains !== 'function') return false
  try {
    return await browser.permissions.contains({ origins: [pattern] })
  } catch {
    return false
  }
}

async function originAllowed(origin: string): Promise<boolean> {
  return origin !== '' && patternAllowed(hostPermissionPattern(origin))
}

function checkCurrent(snapshot: ModelSnapshot, signal: AbortSignal): void {
  if (signal.aborted || snapshot.revision !== currentRevision()) throw new CompletionCancelledError()
}

interface SelectionDocument {
  readonly frameId: number
  readonly documentId: string
  readonly url: string
}

async function readTopDocument(tabId: number): Promise<SelectionDocument | undefined> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: readDocumentHref,
    })
    const item = results.find((entry) => entry.frameId === 0)
    if (item === undefined || typeof item.documentId !== 'string' || item.documentId === '' ||
      typeof item.result !== 'string' || item.result.length > 8192 || normalizeOrigin(item.result) === '') return undefined
    return { frameId: 0, documentId: item.documentId, url: item.result }
  } catch {
    return undefined
  }
}

async function pageGrantCurrent(grant: ManualPageGrant): Promise<boolean> {
  const top = await readTopDocument(grant.tabId)
  if (top === undefined || top.documentId !== grant.documentId || !sameManualPage(top.url, grant.url)) return false
  return (await getManualPageGrant(grant.tabId, grant.documentId, grant.url))?.id === grant.id
}

async function manualPageAllowed(sender: MessageSender): Promise<boolean> {
  if (!fromOurContent(sender) || typeof sender.documentId !== 'string') return false
  const grant = await getManualPageGrant(sender.tab!.id!, sender.documentId, sender.url!)
  return grant !== undefined && pageGrantCurrent(grant)
}

const PAGE_CHANGED_ERROR = '页面已变化，请重新操作'
const PAGE_START_ERROR = '无法在当前页面启动翻译，请刷新后重试'

type PageTarget = {
  readonly id?: number
  readonly url?: string
  readonly incognito?: boolean
  readonly documentId?: string
}

async function assertPageStart(snapshot: ModelSnapshot, signal: AbortSignal, url: string): Promise<void> {
  checkCurrent(snapshot, signal)
  if (!(await getSettings()).enabled) throw new TranslationError('总开关已关闭')
  checkCurrent(snapshot, signal)
  const { config } = snapshot
  if (!isSiteScopeAllowed(url, config)) throw new TranslationError(SITE_SCOPE_BLOCKED_ERROR)
  if (isExcludedSite(url, config.excludedHosts)) throw new TranslationError('该站点已排除模型处理')
  if (isSensitivePage(url)) throw new TranslationError('该页面仅支持通过右键菜单主动翻译所选文字')
  if (config.baseUrl === '' || config.model === '') throw new TranslationError('请先配置接口地址与模型')
  if (!(await endpointAllowed(config.baseUrl))) throw new TranslationError('未授权访问该接口地址')
  checkCurrent(snapshot, signal)
}

async function startPageTranslation(tab: PageTarget): Promise<TranslationReply<'wt:translate-page'>> {
  if (tab.incognito) return { ok: false, error: '无痕窗口不启用模型功能' }
  if (typeof tab.id !== 'number' || typeof tab.url !== 'string' || normalizeOrigin(tab.url) === '') {
    return { ok: false, error: '当前页面不支持' }
  }
  const tabId = tab.id
  const url = tab.url
  const signal = new AbortController().signal
  const policyGeneration = readingGeneration
  const checkReadingPolicy = (): void => {
    if (policyGeneration !== readingGeneration) throw new TranslationError(TRANSLATION_CONFIG_CHANGED_ERROR)
  }
  let grant: ManualPageGrant | undefined
  let snapshot: ModelSnapshot | undefined
  try {
    const top = await readTopDocument(tabId)
    if (top === undefined) throw new TranslationError('当前页面不支持翻译，或浏览器未授予访问权限')
    if (!sameManualPage(top.url, url) || (tab.documentId !== undefined && tab.documentId !== top.documentId)) {
      throw new TranslationError(PAGE_CHANGED_ERROR)
    }
    const config = await getTranslationConfig()
    if (config.baseUrl === '' || config.model === '') throw new TranslationError('请先配置接口地址与模型')
    snapshot = await modelSnapshot()
    await assertPageStart(snapshot, signal, url)
    checkReadingPolicy()
    grant = { id: crypto.randomUUID(), tabId, documentId: top.documentId, url: top.url }
    await putManualPageGrant(grant)
    const activeGrant = grant
    const activeSnapshot = snapshot
    const recheck = async (): Promise<string | undefined> => {
      checkReadingPolicy()
      await assertPageStart(activeSnapshot, signal, url)
      const current = await pageGrantCurrent(activeGrant)
      checkReadingPolicy()
      return current ? undefined : PAGE_CHANGED_ERROR
    }
    const firstFailure = await recheck()
    if (firstFailure !== undefined) throw new TranslationError(firstFailure)
    await browser.scripting.executeScript({
      target: { tabId, documentIds: [top.documentId] },
      files: SITE_SCRIPT_FILES,
      injectImmediately: true,
    })
    checkCurrent(snapshot, signal)
    checkReadingPolicy()
    const refresh: ContentTranslationMessage = { type: 'wt:refresh' }
    const refreshed = await sendToTabMessage(tabId, refresh, top.documentId)
    if (!isContentTranslationReply(refreshed, refresh) || !refreshed.ok) {
      throw new TranslationError(PAGE_START_ERROR)
    }
    const lastFailure = await recheck()
    if (lastFailure !== undefined) throw new TranslationError(lastFailure)
    const resumed = await forwardPageAction(tabId, top.documentId, url, 'resume', recheck)
    if (!resumed.ok) throw new TranslationError(resumed.error)
    const finalFailure = await recheck()
    if (finalFailure !== undefined) throw new TranslationError(finalFailure)
    return { ok: true }
  } catch (error) {
    if (grant !== undefined) {
      await revokeManualPageGrant(grant.tabId, grant.id).catch(reportError)
      // 同一文档重读授权；旧操作不能撤销后来的nonce，不能向新文档发恢复消息。
      const refresh: ContentTranslationMessage = { type: 'wt:refresh' }
      void sendToTabMessage(grant.tabId, refresh, grant.documentId).catch(reportError)
    }
    if (error instanceof TranslationError || error instanceof CompletionCancelledError) return failureReply(error)
    return { ok: false, error: snapshot === undefined ? SNAPSHOT_ERROR : PAGE_START_ERROR }
  }
}

interface ManualGrant {
  readonly id: string
  readonly top: SelectionDocument
  readonly source: SelectionDocument
  readonly text: string
  readonly expires: number
  claimedBy?: string
}

interface DispatchPolicy {
  origin?: string
  auto?: boolean
  feature?: 'subtitle' | 'input'
  manualInput?: boolean
  assist?: AssistInput
  sensitive?: boolean
  manualGrant?: ManualGrant
  pageSender?: MessageSender
}

async function assertDispatchAllowed(
  snapshot: ModelSnapshot,
  signal: AbortSignal,
  policy: DispatchPolicy = {},
): Promise<void> {
  checkCurrent(snapshot, signal)
  const settings = await getSettings()
  checkCurrent(snapshot, signal)
  if (!settings.enabled) throw new TranslationError('总开关已关闭')
  const { config } = snapshot
  const manualPage = policy.auto === true && policy.pageSender !== undefined &&
    await manualPageAllowed(policy.pageSender)
  checkCurrent(snapshot, signal)
  if (config.baseUrl === '' || config.model === '') throw new TranslationError('请先配置接口地址与模型')
  if (policy.feature !== undefined) {
    if (policy.pageSender?.frameId !== 0) {
      if (
        policy.feature !== 'input' ||
        policy.pageSender === undefined ||
        !(await inputFrameAllowed(policy.pageSender, config))
      ) {
        throw new TranslationError('无权访问')
      }
      checkCurrent(snapshot, signal)
    }
    // 输入翻译设为停止输入后自动替换时，用户已明确同意自动处理草稿，不受「自动弹窗」关闭阻断
    if (
      !config.autoInteractionEnabled &&
      !(policy.feature === 'input' && (policy.manualInput === true || config.inputReplaceMode === 'auto'))
    ) {
      throw new TranslationError('自动弹窗已关闭')
    }
    if (policy.feature === 'subtitle' && !config.videoSubtitlesEnabled) {
      throw new TranslationError('未开启视频字幕翻译')
    }
    if (policy.feature === 'input' && !config.inputTranslationEnabled) {
      throw new TranslationError('未开启输入翻译')
    }
  }
  if (policy.auto === true && !manualPage && (policy.origin === undefined || !config.autoOrigins.includes(policy.origin))) {
    throw new TranslationError('该站点未开启自动翻译')
  }
  if (policy.origin !== undefined && isExcludedSite(policy.origin, config.excludedHosts)) {
    throw new TranslationError('该站点已排除模型处理')
  }
  if (policy.origin !== undefined && !isSiteScopeAllowed(policy.origin, config)) {
    throw new TranslationError(SITE_SCOPE_BLOCKED_ERROR)
  }
  const grant = policy.manualGrant
  let sourceOrigin = ''
  if (grant !== undefined) {
    sourceOrigin = normalizeOrigin(grant.source.url)
    if (sourceOrigin === '') throw new TranslationError('当前页面不支持')
    if (isExcludedSite(grant.source.url, config.excludedHosts)) {
      throw new TranslationError('该站点已排除模型处理')
    }
    if (!isSiteScopeAllowed(grant.source.url, config)) {
      throw new TranslationError(SITE_SCOPE_BLOCKED_ERROR)
    }
    if (grant.source.frameId !== 0 && isSensitivePage(grant.source.url)) {
      throw new TranslationError('该页面仅支持通过右键菜单主动翻译所选文字')
    }
  }
  const manualTopAllowed = grant !== undefined && grant.source.frameId === 0
  if (
    policy.sensitive === true &&
    (policy.auto === true || policy.feature !== undefined || policy.assist !== undefined || !manualTopAllowed)
  ) {
    throw new TranslationError('该页面仅支持通过右键菜单主动翻译所选文字')
  }
  if (policy.assist !== undefined && (
    !config.selectionPopupEnabled ||
    (policy.assist.trigger === 'revisit' && (!config.proactiveAssistEnabled || config.selectionToolbarEnabled)) ||
    (policy.assist.trigger === 'selection' && config.selectionToolbarEnabled && policy.assist.requestedIntent === undefined)
  )) {
    throw new TranslationError('未开启相应阅读辅助')
  }
  if (
    policy.origin !== undefined &&
    !(await originAllowed(policy.origin)) &&
    (policy.feature !== undefined || (grant === undefined && !manualPage))
  ) {
    checkCurrent(snapshot, signal)
    throw new TranslationError('未授权访问该站点')
  }
  checkCurrent(snapshot, signal)
  if (
    grant !== undefined &&
    grant.source.frameId !== 0 &&
    sourceOrigin !== policy.origin &&
    !(await originAllowed(sourceOrigin))
  ) {
    checkCurrent(snapshot, signal)
    throw new TranslationError('未授权访问该站点')
  }
  checkCurrent(snapshot, signal)
  if (!(await endpointAllowed(config.baseUrl))) {
    checkCurrent(snapshot, signal)
    throw new TranslationError('未授权访问该接口地址')
  }
  checkCurrent(snapshot, signal)
}

function invalidateModelWork(hint: 'settings' | 'permissions' = 'settings'): void {
  for (const controller of requests.values()) controller.cancellationHint ??= hint
  clearTranslationCache()
  clearAssistCache()
  cancelModelTasks()
  for (const controller of requests.values()) controller.abort()
  requests.clear()
  interactive.clear()
}

const SNAPSHOT_ERROR = '无法读取接口配置或密钥，请在设置中检查'

const manualGrants = new Map<number, ManualGrant>()
const MANUAL_GRANT_MS = 15000
const MANUAL_GRANT_MAX = 32

function pruneManualGrants(): void {
  const now = Date.now()
  for (const [tabId, grant] of manualGrants) {
    if (grant.claimedBy === undefined && grant.expires <= now) manualGrants.delete(tabId)
  }
}

function clearManualGrants(): void {
  manualGrants.clear()
}

interface RawInjectionSnapshot {
  readonly frameId: number
  readonly documentId: string
  readonly snapshot: ManualSelectionSnapshot
}

function isManualSelectionSnapshot(value: unknown): value is ManualSelectionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.url === 'string' &&
    typeof record.focused === 'boolean' &&
    typeof record.text === 'string' &&
    typeof record.frameFocused === 'boolean'
  )
}

function parseInjectionSnapshots(results: unknown): RawInjectionSnapshot[] {
  if (!Array.isArray(results)) return []
  const parsed: RawInjectionSnapshot[] = []
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { frameId?: unknown; documentId?: unknown; result?: unknown }
    if (
      typeof entry.frameId === 'number' &&
      typeof entry.documentId === 'string' &&
      entry.documentId !== '' &&
      isManualSelectionSnapshot(entry.result)
    ) {
      parsed.push({
        frameId: entry.frameId,
        documentId: entry.documentId,
        snapshot: entry.result,
      })
    }
  }
  return parsed
}

function readDocumentHref(): string {
  return location.href
}

async function verifySelectionDocuments(tabId: number, grant: ManualGrant): Promise<boolean> {
  const scripting = browser.scripting
  if (typeof scripting?.executeScript !== 'function') return false
  const documentIds =
    grant.top.documentId === grant.source.documentId
      ? [grant.top.documentId]
      : [grant.top.documentId, grant.source.documentId]
  try {
    const results = await scripting.executeScript({
      target: { tabId, documentIds },
      func: readDocumentHref,
    })
    if (!Array.isArray(results) || results.length !== documentIds.length) return false
    const matchesDoc = (expected: SelectionDocument): boolean =>
      results.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { frameId?: unknown }).frameId === expected.frameId &&
          (item as { documentId?: unknown }).documentId === expected.documentId &&
          (item as { result?: unknown }).result === expected.url,
      )
    return matchesDoc(grant.top) && matchesDoc(grant.source)
  } catch {
    return false
  }
}

function activeGrantForTicket(
  tabId: number,
  ticketId: string,
  text: string,
  sender?: MessageSender,
  requestKey?: string,
): ManualGrant | undefined {
  pruneManualGrants()
  const grant = manualGrants.get(tabId)
  if (grant === undefined || grant.id !== ticketId || grant.text !== text) return undefined
  if (grant.claimedBy !== undefined && grant.claimedBy !== requestKey) return undefined
  const leased = requestKey !== undefined && grant.claimedBy === requestKey
  if (!leased && Date.now() >= grant.expires) {
    manualGrants.delete(tabId)
    return undefined
  }
  if (sender !== undefined) {
    if (
      sender.tab?.id !== tabId ||
      sender.frameId !== 0 ||
      sender.documentId !== grant.top.documentId ||
      sender.url !== grant.top.url
    ) {
      return undefined
    }
  }
  return grant
}

async function verifyManualTicket(
  sender: MessageSender,
  text: string,
  ticketId: string,
  requestKey?: string,
): Promise<ManualGrant | undefined> {
  const tabId = sender.tab?.id
  if (typeof tabId !== 'number') return undefined
  const grant = activeGrantForTicket(tabId, ticketId, text, sender, requestKey)
  if (grant === undefined) return undefined
  const alive = await verifySelectionDocuments(tabId, grant)
  if (!alive) {
    if (manualGrants.get(tabId)?.id === ticketId) manualGrants.delete(tabId)
    return undefined
  }
  return activeGrantForTicket(tabId, ticketId, text, sender, requestKey)
}

async function translationContext(
  senderUrl: string,
  page: PageContext | undefined,
  pageId: string | undefined,
  smart: boolean,
  senderTabId: number,
  scope: Pick<TranslationConfig, 'excludedHosts' | 'siteScopeMode' | 'siteScopeHosts'>,
): Promise<TranslationContext> {
  const hostname = normalizeOrigin(senderUrl)
  const host = hostname === '' ? '' : new URL(hostname).hostname
  if (page !== undefined && page.site !== host) throw new TranslationError('站点不匹配')
  const sensitive = isSensitivePage(senderUrl)
  const currentPage: PageContext =
    page !== undefined && !sensitive ? page : { title: '', heading: '', site: sensitive ? '' : host }
  const recentPages =
    smart && !sensitive && pageId !== undefined
      ? (await recentPageContexts(pageId, senderTabId)).filter((entry) => {
          const siteUrl = `https://${entry.site}/`
          return !isExcludedSite(siteUrl, scope.excludedHosts) &&
            isSiteScopeAllowed(siteUrl, scope) &&
            !isSensitivePage(siteUrl)
        })
      : []
  return { currentPage, recentPages }
}

/** 在途请求及其适用范围：配置变更时只中止受影响的请求。 */
class TrackedRequest extends AbortController implements RequestScope {
  readonly kind: RequestKind
  readonly url: string
  readonly pageSession: string | undefined
  sourceUrl: string | undefined
  recentSites: readonly string[] = []
  cancellationHint: 'settings' | 'permissions' | undefined

  constructor(kind: RequestKind, url: string, pageSession?: string) {
    super()
    this.kind = kind
    this.url = url
    this.pageSession = pageSession
  }
}

const requests = new Map<string, TrackedRequest>()
const interactive = new Set<string>()
/** 已结束的页面会话：旧文档卸载前发出的消息可能晚于端口断开才到达。 */
const endedPageSessions = new Set<string>()
const ENDED_PAGE_SESSIONS_MAX = 256
/** 划词、主动提示、排除列表或网站运行范围每变更一次递增，让已读取旧策略的阅读线索作废。 */
let readingGeneration = 0
let invalidatedFor: string | undefined

/**
 * 按实际变更作废：接口或模型变化时全部作废；否则只中止受影响的请求，保留缓存与其他标签页的工作。
 * 提示词与目标语言是代码常量，不在配置中，无需比较。被中止的自动请求收到 cancelled，由页面静默重发。
 */
function invalidateForConfig(previous: TranslationConfig, next: TranslationConfig): void {
  if (translationOutputChanged(previous, next)) {
    invalidateModelState(invalidateModelWork)
    return
  }
  if (readingPolicyChanged(previous, next)) readingGeneration += 1
  for (const [key, request] of requests) {
    if (
      !requestAffected(request, previous, next) &&
      (request.sourceUrl === undefined ||
        !requestAffected({ kind: request.kind, url: request.sourceUrl, recentSites: [] }, previous, next))
    ) {
      continue
    }
    request.cancellationHint ??= 'settings'
    request.abort()
    requests.delete(key)
    interactive.delete(key)
  }
}

/** 带上标签页与文档作用域，一个页面或子文档无法影响其他会话。 */
function pageSessionKey(sender: MessageSender, session: string | undefined): string | undefined {
  return session === undefined ? undefined : `${assistScope(sender)}:${session}`
}

function pageSessionEnded(key: string | undefined): boolean {
  return key !== undefined && endedPageSessions.has(key)
}

/**
 * 文档已消失：中止它的排队与在途请求，让出调度槽。中止走 cancelled 路径，不计失败，也不触发 429 暂停。
 * 按会话而不是 assistScope 匹配：Firefox 没有 documentId，同一标签页的新旧文档共用一个 scope。
 */
function endPageSession(key: string): void {
  endedPageSessions.add(key)
  if (endedPageSessions.size > ENDED_PAGE_SESSIONS_MAX) {
    const oldest = endedPageSessions.values().next().value
    if (oldest !== undefined) endedPageSessions.delete(oldest)
  }
  for (const [requestKey, request] of requests) {
    if (request.pageSession !== key) continue
    request.abort()
    requests.delete(requestKey)
    interactive.delete(requestKey)
  }
}

function installPageSessions(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(PAGE_PORT_PREFIX)) return
    const session = port.name.slice(PAGE_PORT_PREFIX.length)
    const sender = port.sender
    if (sender === undefined || (!fromOurContent(sender) && !fromOurInputFrame(sender)) || !isPageId(session)) {
      port.disconnect()
      return
    }
    const key = pageSessionKey(sender, session)!
    port.onDisconnect.addListener(() => {
      endPageSession(key)
    })
  })
}

/** 写入前先作废：之后取快照的请求要等本次变更结束，读到的一定是新配置。监听器不再重复作废同一次写入。 */
async function writeConfig(previous: TranslationConfig, next: TranslationConfig): Promise<void> {
  invalidatedFor = JSON.stringify(sanitizeTranslationConfig(next))
  invalidateForConfig(previous, next)
  try {
    await translationConfigItem.setValue(next)
  } catch (error) {
    invalidatedFor = undefined
    throw error
  }
}

type ConfigMutationMessage = Extract<
  TranslationMessage,
  { type: 'wt:save-config' | 'wt:set-site-excluded' | 'wt:set-site-scope-host' }
>

async function saveConfig(
  message: ConfigMutationMessage,
): Promise<TranslationReply<ConfigMutationMessage['type']>> {
  const patch: TranslationConfigPatch = message.type === 'wt:save-config' ? message.patch : {}
  const apiKey = message.type === 'wt:save-config' ? message.apiKey : undefined
  const rawCustomHeaders = message.type === 'wt:save-config' ? message.customHeaders : undefined
  const expected = message.type === 'wt:save-config' ? message.expectedConnection : undefined
  if (patch.apiType !== undefined && !isApiType(patch.apiType)) {
    return { ok: false, error: '接口类型无效' }
  }
  if (patch.temperature !== undefined && !isTemperature(patch.temperature)) {
    return { ok: false, error: '温度须为空或 0–2 之间的数值' }
  }
  let normalizedRequestParams: JsonObject | undefined
  if (patch.requestParams !== undefined) {
    try {
      normalizedRequestParams = normalizeRequestParams(patch.requestParams)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '附加请求参数无效' }
    }
  }
  let suppliedHeaders: Readonly<Record<string, string>> | undefined
  if (rawCustomHeaders !== undefined) {
    try {
      suppliedHeaders = normalizeCustomHeaders(rawCustomHeaders)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '自定义请求头无效' }
    }
  }
  let reply: TranslationReply<ConfigMutationMessage['type']> = { ok: false, error: '保存失败' }
  await serializeMutation(async () => {
    const previous = await getTranslationConfig()
    if (
      expected !== undefined &&
      (expected.baseUrl !== previous.baseUrl ||
        expected.model !== previous.model ||
        (expected.requestOptionsKey !== undefined &&
          expected.requestOptionsKey !== requestOptionsKey(previous)))
    ) {
      reply = { ok: false, error: '接口配置已在其他窗口更改，请重新加载' }
      return
    }
    const next: TranslationConfig = { ...previous }
    const trimmedBase = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : undefined
    const trimmedModel = typeof patch.model === 'string' ? patch.model.trim() : undefined
    const nextBase = trimmedBase === undefined ? previous.baseUrl : trimmedBase === '' ? '' : normalizeBaseUrl(trimmedBase)
    const nextModel = trimmedModel ?? previous.model
    const suppliedKey = typeof apiKey === 'string' && apiKey !== '' ? apiKey : undefined
    const hasNonEmptySuppliedHeaders = suppliedHeaders !== undefined && Object.keys(suppliedHeaders).length > 0
    const advancedPatch =
      patch.apiType !== undefined ||
      patch.temperature !== undefined ||
      normalizedRequestParams !== undefined ||
      suppliedHeaders !== undefined
    const connectionPatch =
      trimmedBase !== undefined ||
      trimmedModel !== undefined ||
      suppliedKey !== undefined ||
      advancedPatch
    const wantsEndpoint =
      suppliedKey !== undefined ||
      hasNonEmptySuppliedHeaders ||
      (trimmedBase ?? previous.baseUrl) !== '' ||
      (trimmedModel ?? previous.model) !== ''
    if (connectionPatch) {
      if (wantsEndpoint && (nextBase === '' || nextModel === '')) {
        reply = { ok: false, error: nextBase === '' ? '接口地址无效' : '请先配置模型名称' }
        return
      }
      if (nextBase !== '' && !(await endpointAllowed(nextBase))) {
        reply = { ok: false, error: '未授权访问该接口地址' }
        return
      }
    }
    const stored = await readStoredApiKey().catch(() => {
      throw new Error('无法读取已保存的密钥')
    })
    let storedHeaders: BoundCustomHeaders | undefined
    let storedHeadersFailed = false
    try {
      storedHeaders = await readStoredCustomHeaders()
    } catch {
      storedHeadersFailed = true
    }
    const connectionChanged = nextBase !== previous.baseUrl
    const nextOrigin = credentialOrigin(nextBase)
    if (suppliedKey !== undefined) {
      try {
        validateApiKey(suppliedKey)
      } catch (error) {
        reply = { ok: false, error: error instanceof Error ? error.message : 'API Key 格式无效' }
        return
      }
    }
    if (connectionChanged && suppliedKey === undefined && stored !== undefined) {
      const mismatch = typeof stored === 'string' || stored.origin !== nextOrigin
      if (nextOrigin !== '' && mismatch) {
        reply = { ok: false, error: '接口来源已改变，请重新输入或删除旧密钥' }
        return
      }
    }
    let nextRevision = previous.customHeadersRevision
    let nextStoredHeaders: BoundCustomHeaders | undefined
    if (suppliedHeaders === undefined) {
      if (connectionPatch && previous.customHeadersRevision !== '') {
        if (
          storedHeadersFailed ||
          storedHeaders === undefined ||
          storedHeaders.revision !== previous.customHeadersRevision
        ) {
          reply = { ok: false, error: '自定义请求头与当前接口不匹配，请重新填写或清空' }
          return
        }
        if (nextOrigin !== '' && storedHeaders.origin !== nextOrigin) {
          reply = { ok: false, error: '接口来源已改变，请重新填写或清空自定义请求头' }
          return
        }
      }
    } else if (Object.keys(suppliedHeaders).length === 0) {
      nextRevision = ''
      nextStoredHeaders = undefined
    } else {
      if (nextOrigin === '') {
        reply = { ok: false, error: '请先配置接口地址' }
        return
      }
      const sameHeaders =
        !storedHeadersFailed &&
        previous.customHeadersRevision !== '' &&
        storedHeaders !== undefined &&
        storedHeaders.revision === previous.customHeadersRevision &&
        storedHeaders.origin === nextOrigin &&
        JSON.stringify(storedHeaders.headers) === JSON.stringify(suppliedHeaders)
      nextRevision = sameHeaders ? previous.customHeadersRevision : crypto.randomUUID().toLowerCase()
      nextStoredHeaders = {
        headers: suppliedHeaders,
        origin: nextOrigin,
        revision: nextRevision,
      }
    }
    const selectionOn = patch.selectionPopupEnabled ?? previous.selectionPopupEnabled
    const toolbarOn = selectionOn && (patch.selectionToolbarEnabled ?? previous.selectionToolbarEnabled)
    const proactiveOn = selectionOn && !toolbarOn && (patch.proactiveAssistEnabled ?? previous.proactiveAssistEnabled)
    if (
      patch.selectionPopupEnabled === true ||
      patch.videoSubtitlesEnabled === true ||
      patch.inputTranslationEnabled === true
    ) {
      const allowed = await Promise.all(['http://*/*', 'https://*/*'].map(patternAllowed))
      if (!allowed.every(Boolean)) {
        reply = { ok: false, error: '未授权访问站点' }
        return
      }
    }
    if (patch.proactiveAssistEnabled === true && (!selectionOn || toolbarOn || nextBase === '' || nextModel === '')) {
      reply = { ok: false, error: '需先开启划词辅助并配置模型' }
      return
    }
    let nextExcluded = previous.excludedHosts
    if (message.type === 'wt:set-site-excluded') {
      const host = normalizeExcludedHost(message.host)
      if (host === '') {
        reply = { ok: false, error: '排除网站地址无效' }
        return
      }
      nextExcluded = message.excluded
        ? previous.excludedHosts.includes(host) ? previous.excludedHosts : [...previous.excludedHosts, host]
        : previous.excludedHosts.filter((item) => item !== host)
      if (nextExcluded.length > MAX_EXCLUDED_HOSTS) {
        reply = { ok: false, error: EXCLUDED_LIMIT_ERROR }
        return
      }
    } else if (patch.excludedHosts !== undefined) {
      if (patch.excludedHosts.length > MAX_EXCLUDED_HOSTS) {
        reply = { ok: false, error: EXCLUDED_LIMIT_ERROR }
        return
      }
      const normalized: string[] = []
      for (const raw of patch.excludedHosts) {
        const host = normalizeExcludedHost(raw)
        if (host === '') {
          reply = { ok: false, error: '排除网站地址无效' }
          return
        }
        normalized.push(host)
      }
      nextExcluded = sanitizeExcludedHosts(normalized)
    }
    let nextScopeHosts = previous.siteScopeHosts
    if (message.type === 'wt:set-site-scope-host') {
      const host = normalizeExcludedHost(message.host)
      if (host === '') {
        reply = { ok: false, error: SITE_SCOPE_INVALID_ERROR }
        return
      }
      nextScopeHosts = message.listed
        ? previous.siteScopeHosts.includes(host) ? previous.siteScopeHosts : [...previous.siteScopeHosts, host]
        : previous.siteScopeHosts.filter((item) => item !== host)
      if (nextScopeHosts.length > MAX_SITE_SCOPE_HOSTS) {
        reply = { ok: false, error: SITE_SCOPE_LIMIT_ERROR }
        return
      }
    }
    const nextMode = patch.siteScopeMode ?? previous.siteScopeMode
    Object.assign(next, {
      baseUrl: nextBase,
      model: nextModel,
      apiType: patch.apiType ?? previous.apiType,
      temperature: patch.temperature === undefined ? previous.temperature : patch.temperature,
      requestParams: normalizedRequestParams ?? previous.requestParams,
      customHeadersRevision: nextRevision,
      ...(patch.disabledDictionaries !== undefined ? { disabledDictionaries: [...patch.disabledDictionaries] } : {}),
      ...(patch.targetLanguage !== undefined ? { targetLanguage: patch.targetLanguage } : {}),
      ...(patch.sourceLanguage !== undefined ? { sourceLanguage: patch.sourceLanguage } : {}),
      selectionPopupEnabled: selectionOn,
      selectionToolbarEnabled: toolbarOn,
      proactiveAssistEnabled: proactiveOn,
      floatingButtonEnabled: patch.floatingButtonEnabled ?? previous.floatingButtonEnabled,
      autoInteractionEnabled: patch.autoInteractionEnabled ?? previous.autoInteractionEnabled,
      videoSubtitlesEnabled: patch.videoSubtitlesEnabled ?? previous.videoSubtitlesEnabled,
      inputTranslationEnabled: patch.inputTranslationEnabled ?? previous.inputTranslationEnabled,
      inputTargetLanguage: patch.inputTargetLanguage ?? previous.inputTargetLanguage,
      inputSourceLanguage: patch.inputSourceLanguage ?? previous.inputSourceLanguage,
      inputReplaceKey:
        patch.inputReplaceKey !== undefined
          ? normalizeHotkey(patch.inputReplaceKey) ?? previous.inputReplaceKey
          : previous.inputReplaceKey,
      inputReplaceMode:
        patch.inputReplaceMode !== undefined && isInputReplaceMode(patch.inputReplaceMode)
          ? patch.inputReplaceMode
          : previous.inputReplaceMode,
      inputAutoReplaceDelayMs:
        patch.inputAutoReplaceDelayMs !== undefined && isInputAutoReplaceDelay(patch.inputAutoReplaceDelayMs)
          ? patch.inputAutoReplaceDelayMs
          : previous.inputAutoReplaceDelayMs,
      pageCharLimit: patch.pageCharLimit ?? previous.pageCharLimit,
      excludedHosts: nextExcluded,
      siteScopeMode: nextMode,
      siteScopeHosts: nextScopeHosts,
    })
    if (suppliedKey !== undefined) invalidateModelState(invalidateModelWork)
    let wroteKey = false
    let wroteHeaders = false
    try {
      if (suppliedKey !== undefined) {
        await writeApiKey(suppliedKey, nextBase)
        wroteKey = true
      }
      if (suppliedHeaders !== undefined) {
        await writeStoredCustomHeaders(nextStoredHeaders)
        wroteHeaders = true
      }
      await writeConfig(previous, next)
    } catch {
      let rollbackFailed = false
      if (wroteKey) {
        try {
          await writeStoredApiKey(stored)
        } catch {
          rollbackFailed = true
        }
      }
      if (wroteHeaders) {
        try {
          await writeStoredCustomHeaders(storedHeaders)
        } catch {
          rollbackFailed = true
        }
      }
      reply = {
        ok: false,
        error: rollbackFailed ? '保存失败，密钥状态需要重新检查' : '保存失败',
      }
      return
    }
    if (
      connectionChanged ||
      nextModel !== previous.model ||
      next.apiType !== previous.apiType ||
      next.customHeadersRevision !== previous.customHeadersRevision ||
      suppliedKey !== undefined
    ) clearAutomaticPause()
    let warning: string | undefined
    const excludedChanged = !sameList(nextExcluded, previous.excludedHosts)
    const scopeChanged = nextMode !== previous.siteScopeMode || !sameList(nextScopeHosts, previous.siteScopeHosts)
    if (excludedChanged || scopeChanged) {
      try {
        await clearPageContexts()
      } catch {
        warning = scopeChanged
          ? '网站运行范围已保存，但阅读线索清理失败；范围外的线索仍不会发送，请重试清理'
          : '排除网站已保存，但阅读线索清理失败；这些网站的线索仍不会发送，请重试清理'
      }
    }
    const [state, customHeadersState] = await Promise.all([
      keyStateFor(next.baseUrl),
      customHeadersStateFor(next.baseUrl, next.customHeadersRevision),
    ])
    let syncFailed = false
    await syncSiteScript()
      .then(() => syncSiteTabs(previous, next))
      .catch(() => {
        syncFailed = true
      })
    if (syncFailed) {
      const syncWarning = '已保存，但站点脚本更新失败，请重试保存'
      warning = warning === undefined ? syncWarning : `${warning}；${syncWarning}`
    }
    reply = {
      ok: true,
      config: next,
      hasKey: state.hasKey,
      keyState: state.keyState,
      customHeadersState,
      ...(warning === undefined ? {} : { warning }),
    }
  })
  return reply
}

async function floatingFailure(config: TranslationConfig, sender: MessageSender): Promise<string | undefined> {
  if (!fromOurContent(sender)) return '无权访问'
  if (!config.floatingButtonEnabled) return '未开启悬浮入口'
  if (!(await getSettings()).enabled) return '翻译未开启'
  const url = sender.url!
  if (!isSiteScopeAllowed(url, config)) return SITE_SCOPE_BLOCKED_ERROR
  if (isExcludedSite(url, config.excludedHosts) || isSensitivePage(url)) return '当前页面不支持'
  if (!(await originAllowed(normalizeOrigin(url))) && !(await manualPageAllowed(sender))) return '未授权访问该站点'
  return undefined
}

async function setSiteAuto(
  message: Extract<TranslationMessage, { type: 'wt:set-site-auto' }>,
  contentSender?: MessageSender,
): Promise<TranslationReply<'wt:set-site-auto'>> {
  const origin = normalizeOrigin(message.origin)
  if (origin === '') return { ok: false, error: '站点地址无效' }
  if (message.enabled && !(await originAllowed(origin))) return { ok: false, error: '未授权访问该站点' }
  let reply: TranslationReply<'wt:set-site-auto'> = { ok: false, error: '保存失败' }
  await serializeMutation(async () => {
    const previous = await getTranslationConfig()
    if (contentSender !== undefined) {
      const failure = await floatingFailure(previous, contentSender)
      if (failure !== undefined) {
        reply = { ok: false, error: failure }
        return
      }
    }
    if (message.enabled) {
      if (!isSiteScopeAllowed(origin, previous)) {
        reply = { ok: false, error: SITE_SCOPE_BLOCKED_ERROR }
        return
      }
      if (!(await originAllowed(origin))) {
        reply = { ok: false, error: '未授权访问该站点' }
        return
      }
      if (previous.baseUrl === '' || previous.model === '') {
        reply = { ok: false, error: '请先配置接口地址与模型' }
        return
      }
      if (isExcludedSite(origin, previous.excludedHosts)) {
        reply = { ok: false, error: '该站点已排除模型处理' }
        return
      }
    }
    const autoOrigins = message.enabled
      ? [...previous.autoOrigins.filter((item) => item !== origin), origin]
      : previous.autoOrigins.filter((item) => item !== origin)
    if (autoOrigins.length > 50) {
      reply = { ok: false, error: '站点数量已达上限' }
      return
    }
    const next: TranslationConfig = { ...previous, autoOrigins }
    await writeConfig(previous, next)
    const state = await keyStateFor(next.baseUrl)
    let syncFailed = false
    await syncSiteScript()
      .then(() => syncSiteTabs(previous, next))
      .catch(() => {
        syncFailed = true
      })
    reply = syncFailed
      ? { ok: false, error: '已保存，但站点脚本更新失败' }
      : { ok: true, config: next, hasKey: state.hasKey, keyState: state.keyState }
  })
  return reply
}

async function handleTest(sender: MessageSender): Promise<TranslationReply<'wt:test'>> {
  const scope = assistScope(sender)
  const key = `${scope}:${crypto.randomUUID()}`
  const controller = new TrackedRequest('test', '')
  requests.set(key, controller)
  interactive.add(key)
  try {
    const snapshot = await modelSnapshot().catch(() => undefined)
    if (snapshot === undefined || controller.signal.aborted) {
      return unavailableReply(snapshot)
    }
    const { apiKey } = snapshot
    const texts = await scheduleModelTask(
      'interactive',
      async (signal) => {
        await assertDispatchAllowed(snapshot, signal)
        const result = await translateTexts(modelRequestConfig(snapshot), ['Hello'], apiKey, fetch, signal)
        checkCurrent(snapshot, signal)
        return result
      },
      controller.signal,
    )
    return { ok: true, texts }
  } catch (error) {
    return failureReply(error)
  } finally {
    if (requests.get(key) === controller) {
      requests.delete(key)
      interactive.delete(key)
    }
  }
}

function autoTextsValid(texts: readonly string[]): boolean {
  let total = 0
  for (const text of texts) {
    if (text.length > AUTO_MAX_TEXT) return false
    total += text.length
  }
  return texts.length <= AUTO_MAX_ITEMS && total <= AUTO_MAX_TOTAL
}

async function handleTranslate(
  message: Extract<TranslationMessage, { type: 'wt:translate' }>,
  sender: MessageSender,
): Promise<TranslationReply<'wt:translate'>> {
  const pageSession = pageSessionKey(sender, message.pageSession)
  if (pageSessionEnded(pageSession)) return failureReply(new CompletionCancelledError())
  const scope = assistScope(sender)
  const key = `${scope}:${message.requestId ?? crypto.randomUUID()}`
  if (requests.has(key)) return { ok: false, error: '请求 ID 重复' }
  const controller = new TrackedRequest(message.mode, sender.url ?? '', pageSession)
  if (fromOurInputFrame(sender)) controller.sourceUrl = sender.tab?.url
  const failed = (error: unknown): TranslationFailure => {
    const reply = failureReply(error)
    if (message.manualSelectionId === undefined || reply.code !== 'cancelled') return reply
    if (controller.cancellationHint === 'permissions') return { ...reply, error: TRANSLATION_PERMISSION_REMOVED_ERROR }
    if (controller.cancellationHint === 'settings') return { ...reply, error: TRANSLATION_CONFIG_CHANGED_ERROR }
    return reply
  }
  const feature = message.mode === 'subtitle' || message.mode === 'input' ? message.mode : undefined
  const manualInput = feature === 'input' && message.manualInput === true
  const isInteractive = message.mode === 'selection'
  if (feature !== undefined) {
    for (const [other, existing] of requests) {
      if (other !== key && other.startsWith(`${scope}:`) && existing.kind === feature) {
        existing.abort()
        requests.delete(other)
      }
    }
  } else if (isInteractive) {
    for (const other of interactive) {
      if (other !== key && other.startsWith(`${scope}:`)) {
        requests.get(other)?.abort()
        requests.delete(other)
        interactive.delete(other)
      }
    }
  }
  requests.set(key, controller)
  if (isInteractive) interactive.add(key)
  const reading0 = readingGeneration
  let grant: ManualGrant | undefined
  try {
    await restoreAutomaticPause()
    const settings = await getSettings()
    if (!settings.enabled) return { ok: false, error: '总开关已关闭' }
    const origin = normalizeOrigin(sender.url ?? '')
    const snapshot = await modelSnapshot().catch(() => undefined)
    if (controller.signal.aborted) {
      return failed(new CompletionCancelledError())
    }
    if (snapshot === undefined) {
      return unavailableReply(snapshot)
    }
    const config = snapshot.config
    const ticketId = message.manualSelectionId
    if (ticketId !== undefined) {
      grant = await verifyManualTicket(sender, message.texts[0] ?? '', ticketId)
      checkCurrent(snapshot, controller.signal)
      if (grant === undefined) throw new CompletionCancelledError()
      grant.claimedBy = key
      controller.sourceUrl = grant.source.url
    }
    if (message.mode === 'auto' && !autoTextsValid(message.texts)) {
      return { ok: false, error: '内容过长' }
    }
    try {
      await assertDispatchAllowed(snapshot, controller.signal, {
        origin,
        pageSender: sender,
        auto: message.mode === 'auto',
        feature,
        manualInput,
        sensitive: isSensitivePage(sender.url ?? ''),
        manualGrant: grant,
      })
    } catch (error) {
      return failed(error)
    }
    const stillAllowed = async (snap: ModelSnapshot): Promise<boolean> => {
      try {
        let currentGrant: ManualGrant | undefined
        if (ticketId !== undefined) {
          currentGrant = await verifyManualTicket(sender, message.texts[0] ?? '', ticketId, key)
          checkCurrent(snap, controller.signal)
          if (currentGrant === undefined) throw new CompletionCancelledError()
        }
        await assertDispatchAllowed(snap, controller.signal, {
          origin,
          pageSender: sender,
          auto: message.mode === 'auto',
          feature,
          manualInput,
          sensitive: isSensitivePage(sender.url ?? ''),
          manualGrant: currentGrant,
        })
        return true
      } catch (error) {
        if (error instanceof CompletionCancelledError) throw error
        return false
      }
    }
    const context: TranslationContext | undefined =
      feature !== undefined
        ? undefined
        : grant !== undefined && grant.source.frameId !== 0
          ? {
              currentPage: {
                title: '',
                heading: '',
                site: new URL(grant.source.url).hostname,
              },
              recentPages: [],
            }
          : await translationContext(
              sender.url ?? '',
              message.page,
              message.pageId ?? sender.documentId,
              config.proactiveAssistEnabled,
              sender.tab?.id ?? -1,
              config,
            )
    checkCurrent(snapshot, controller.signal)
    if (context !== undefined && context.recentPages.length > 0 && readingGeneration !== reading0) {
      controller.cancellationHint ??= 'settings'
      throw new CompletionCancelledError()
    }
    controller.recentSites = context === undefined ? [] : context.recentPages.map((entry) => entry.site)
    const requestSnapshot: ModelSnapshot =
      feature === undefined
        ? snapshot
        : {
            ...snapshot,
            config: {
              ...snapshot.config,
              sourceLanguage: feature === 'input' ? snapshot.config.inputSourceLanguage : 'auto',
              targetLanguage:
                feature === 'input'
                  ? snapshot.config.inputTargetLanguage
                  : snapshot.config.targetLanguage === 'zh-TW'
                    ? 'zh-TW'
                    : 'zh-CN',
            },
          }
    const queueMode =
      message.mode === 'input'
        ? 'selection'
        : message.mode === 'subtitle'
          ? 'auto'
          : message.mode
    const outcome = await requestTranslation(
      requestSnapshot,
      queueMode,
      message.texts,
      stillAllowed,
      context,
      controller.signal,
      // 敏感页面的文字只在右键时发送一次，译文不落盘。
      feature === undefined &&
        !isSensitivePage(sender.url ?? '') &&
        (grant === undefined || !isSensitivePage(grant.source.url)),
    )
    checkCurrent(snapshot, controller.signal)
    if (outcome.ok && ticketId !== undefined) {
      const finalGrant = await verifyManualTicket(sender, message.texts[0] ?? '', ticketId, key)
      checkCurrent(snapshot, controller.signal)
      if (finalGrant === undefined) throw new CompletionCancelledError()
    }
    if (outcome.ok && fromOurInputFrame(sender)) {
      if (!(await inputFrameAllowed(sender, snapshot.config))) throw new CompletionCancelledError()
      checkCurrent(snapshot, controller.signal)
    }
    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error ?? '无法连接翻译服务',
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      }
    }
    return {
      ok: true,
      texts: outcome.texts,
      ...(outcome.cachedChars === undefined ? {} : { cachedChars: outcome.cachedChars }),
    }
  } catch (error) {
    return failed(error)
  } finally {
    if (grant?.claimedBy === key) {
      grant.claimedBy = undefined
      const tabId = sender.tab?.id
      if (typeof tabId === 'number' && manualGrants.get(tabId) === grant && Date.now() >= grant.expires) {
        manualGrants.delete(tabId)
      }
    }
    if (requests.get(key) === controller) {
      requests.delete(key)
      interactive.delete(key)
    }
  }
}

function assistScope(sender: MessageSender): string {
  return `${sender.tab?.id ?? -1}:${sender.documentId ?? sender.frameId ?? 0}`
}

async function handleAssist(
  message: Extract<TranslationMessage, { type: 'wt:assist' }>,
  sender: MessageSender,
): Promise<TranslationReply<'wt:assist'>> {
  const pageSession = pageSessionKey(sender, message.pageSession)
  if (pageSessionEnded(pageSession)) return failureReply(new CompletionCancelledError())
  const senderUrl = sender.url ?? ''
  const scope = assistScope(sender)
  const key = `${scope}:${message.requestId}`
  if (requests.has(key)) return { ok: false, error: '请求 ID 重复' }
  const controller = new TrackedRequest('assist', senderUrl, pageSession)
  for (const other of interactive) {
    if (other !== key && other.startsWith(`${scope}:`)) {
      requests.get(other)?.abort()
      requests.delete(other)
      interactive.delete(other)
    }
  }
  requests.set(key, controller)
  interactive.add(key)
  try {
    await restoreAutomaticPause()
    const snapshot = await modelSnapshot().catch(() => undefined)
    if (snapshot === undefined || controller.signal.aborted) {
      return unavailableReply(snapshot)
    }
    const origin = normalizeOrigin(senderUrl)
    const host = origin === '' ? '' : new URL(origin).hostname
    if (host === '' || message.input.site !== host) return { ok: false, error: '站点不匹配' }
    const input: AssistInput = message.input
    const scheduler0 = modelSchedulerGeneration()
    const loadContext = (): Promise<TranslationContext> =>
      translationContext(
        senderUrl,
        message.page,
        message.pageId ?? sender.documentId,
        snapshot.config.proactiveAssistEnabled,
        sender.tab?.id ?? -1,
        snapshot.config,
      )
    const validateDispatch = async (signal: AbortSignal): Promise<void> => {
      await assertDispatchAllowed(snapshot, signal, {
        origin,
        assist: message.input,
        sensitive: isSensitivePage(senderUrl),
      })
      if (modelSchedulerGeneration() !== scheduler0) throw new CompletionCancelledError()
    }
    const cachedContext = await loadContext()
    await validateDispatch(controller.signal)
    const requestConfig = modelRequestConfig(snapshot)
    const cached = await getCachedAssistance(requestConfig, input, cachedContext)
    if (cached !== undefined) {
      checkCurrent(snapshot, controller.signal)
      return { ok: true, result: cached }
    }
    const result = await scheduleModelTask(
      message.input.trigger === 'selection' ? 'interactive' : 'automatic',
      async (signal) => {
        const context = await loadContext()
        await validateDispatch(signal)
        return inferAssistance(requestConfig, input, snapshot.apiKey, signal, fetch, context)
      },
      controller.signal,
    )
    checkCurrent(snapshot, controller.signal)
    return { ok: true, result }
  } catch (error) {
    return failureReply(error)
  } finally {
    if (requests.get(key) === controller) {
      requests.delete(key)
      interactive.delete(key)
    }
  }
}

function handleCancelAssist(
  message: Extract<TranslationMessage, { type: 'wt:cancel-assist' }>,
  sender: MessageSender,
): TranslationReply<'wt:cancel-assist'> {
  const key = `${assistScope(sender)}:${message.requestId}`
  const controller = requests.get(key)
  if (controller !== undefined) {
    controller.abort()
    requests.delete(key)
    interactive.delete(key)
  }
  return { ok: true }
}

async function handleListModels(
  message: Extract<TranslationMessage, { type: 'wt:list-models' }>,
  sender: MessageSender,
): Promise<TranslationReply<'wt:list-models'>> {
  const baseUrl = normalizeBaseUrl(message.baseUrl)
  if (baseUrl === '') return { ok: false, error: '接口地址无效' }
  const key = `${assistScope(sender)}:models:${message.requestId}`
  if (requests.has(key)) return { ok: false, error: '请求 ID 重复' }
  const controller = new TrackedRequest('catalog', '')
  requests.set(key, controller)
  try {
    if (!(await endpointAllowed(baseUrl))) return { ok: false, error: '未授权访问该接口地址' }
    const state = await readConsistentModelState(async (config, revision) => ({
      revision,
      apiKey: message.apiKey === undefined
        ? await readApiKey(baseUrl)
        : message.apiKey === '' ? '' : validateApiKey(message.apiKey),
      customHeaders: message.customHeaders === undefined
        ? await readCustomHeaders(baseUrl, config.customHeadersRevision)
        : normalizeCustomHeaders(message.customHeaders),
    }))
    const check = (): void => {
      if (controller.signal.aborted || state.revision !== currentRevision()) throw new CompletionCancelledError()
    }
    check()
    const models = await requestModelList({ baseUrl, customHeaders: state.customHeaders }, state.apiKey, controller.signal)
    check()
    return { ok: true, models }
  } catch (error) {
    if (controller.signal.aborted) return failureReply(new CompletionCancelledError())
    if (error instanceof TranslationError || error instanceof CompletionCancelledError) return failureReply(error)
    const known = [
      '旧版密钥需要重新输入后使用',
      '接口来源已改变，请重新输入或删除旧密钥',
      '自定义请求头与当前接口不匹配，请重新填写或清空',
      'API Key 须为 1–512 个可打印英文字符，不能包含空格',
    ]
    return { ok: false, error: error instanceof Error && known.includes(error.message) ? error.message : SNAPSHOT_ERROR }
  } finally {
    if (requests.get(key) === controller) requests.delete(key)
  }
}

function handleCancelModels(
  message: Extract<TranslationMessage, { type: 'wt:cancel-models' }>,
  sender: MessageSender,
): TranslationReply<'wt:cancel-models'> {
  const key = `${assistScope(sender)}:models:${message.requestId}`
  const controller = requests.get(key)
  if (controller !== undefined && controller.kind === 'catalog') {
    controller.abort()
    requests.delete(key)
  }
  return { ok: true }
}

async function handlePageAction(
  message: Extract<TranslationMessage, { type: 'wt:page-action' }>,
): Promise<TranslationReply<'wt:page-action'>> {
  const tabs = browser.tabs
  if (message.tabId !== undefined && message.url !== undefined) {
    try {
      const tab = await tabs.get(message.tabId)
      if (tab.incognito) return { ok: false, error: '无痕窗口不启用模型功能' }
      if (typeof tab.url !== 'string' || !sameManualPage(tab.url, message.url)) {
        return { ok: false, error: PAGE_CHANGED_ERROR }
      }
      const top = await readTopDocument(message.tabId)
      if (top === undefined || !sameManualPage(top.url, message.url)) {
        return { ok: false, error: PAGE_CHANGED_ERROR }
      }
      const forward: ContentTranslationMessage = {
        type: 'wt:page-action', action: message.action, url: message.url,
      }
      const reply = await sendToTabMessage(message.tabId, forward, top.documentId)
      if (!isContentTranslationReply(reply, forward)) return { ok: false, error: '当前页面不支持' }
      return reply.ok ? { ok: true } : { ok: false, error: reply.error }
    } catch {
      return { ok: false, error: '当前页面不支持' }
    }
  }
  if (typeof tabs?.query !== 'function' || typeof tabs.sendMessage !== 'function') {
    return { ok: false, error: '当前页面不支持' }
  }
  const [tab] = await tabs.query({ active: true, currentWindow: true }).catch(() => [])
  if (tab?.id === undefined) return { ok: false, error: '当前页面不支持' }
  const forward: ContentTranslationMessage = { type: 'wt:page-action', action: message.action }
  try {
    const reply: unknown = await tabs.sendMessage(tab.id, forward, { frameId: 0 })
    if (!isContentTranslationReply(reply, forward)) return { ok: false, error: '当前页面不支持' }
    return reply.ok ? { ok: true } : { ok: false, error: reply.error }
  } catch {
    return { ok: false, error: '当前页面不支持' }
  }
}

/** 标签页里没有对应内容脚本（Chromium：Receiving end does not exist），区别于脚本在场但回复失败 */
function isNoReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Receiving end does not exist|Could not establish connection/i.test(message)
}

async function forwardPageAction(
  tabId: number,
  documentId: string | undefined,
  url: string,
  action: 'restore' | 'resume',
  recheck?: () => Promise<string | undefined>,
): Promise<TranslationReply<'wt:current-page-controls'>> {
  const unsupported = { ok: false as const, error: '当前页面不支持' }
  const forward: ContentTranslationMessage = { type: 'wt:page-action', action, url }
  // GitHub 页默认只有词典脚本（未授权全部网站、未开自动翻译时不注册通用脚本）：通用引擎不在场时直接走 GitHub 引擎
  let genericHandled = false
  try {
    const generic = await sendToTabMessage(tabId, forward, documentId)
    if (!isContentTranslationReply(generic, forward) || !generic.ok) return unsupported
    genericHandled = true
  } catch (error) {
    if (!isNoReceiverError(error)) return unsupported
  }
  if (action === 'resume' && recheck !== undefined) {
    const again = await recheck()
    if (again !== undefined) return { ok: false, error: again }
  }
  if (parseGitHubUrl(url) === undefined) {
    return genericHandled ? { ok: true, legacy: { active: false, paused: false } } : unsupported
  }
  try {
    const github = await sendToTabMessage(tabId, { type: 'gcn:page-translation', action, url }, documentId)
    if (!isGitHubPageReply(github)) return unsupported
    return { ok: true, legacy: { active: github.active, paused: github.paused } }
  } catch (error) {
    if (genericHandled && isNoReceiverError(error)) return { ok: true, legacy: { active: false, paused: false } }
    return unsupported
  }
}

async function handleCurrentPageControls(
  message: Extract<TranslationMessage, { type: 'wt:current-page-controls' }>,
  sender: MessageSender,
): Promise<TranslationReply<'wt:current-page-controls'>> {
  if (!fromOurContent(sender)) return { ok: false, error: '无权访问' }
  const blocked = await floatingFailure(await getTranslationConfig(), sender)
  if (blocked !== undefined) return { ok: false, error: blocked }
  const tabId = sender.tab!.id!
  const documentId = typeof sender.documentId === 'string' ? sender.documentId : undefined
  const url = sender.url!
  const unsupported = { ok: false as const, error: '当前页面不支持' }
  if (message.action === 'status') {
    if (parseGitHubUrl(url) === undefined) return { ok: true, legacy: { active: false, paused: false } }
    try {
      const reply = await sendToTabMessage(tabId, { type: 'gcn:page-translation', action: message.action, url }, documentId)
      if (!isGitHubPageReply(reply)) return unsupported
      return { ok: true, legacy: { active: reply.active, paused: reply.paused } }
    } catch {
      return unsupported
    }
  }
  return forwardPageAction(tabId, documentId, url, message.action, async () =>
    floatingFailure(await getTranslationConfig(), sender),
  )
}

function isDiscordReplacementStatus(value: unknown): value is DiscordReplacementStatus {
  return value === 'ok' || value === 'changed' || value === 'unsupported' || value === 'failed'
}

function readReplacementResult(results: unknown, documentId: string): DiscordReplacementStatus {
  if (!Array.isArray(results) || results.length !== 1) return 'failed'
  const item = results[0]
  if (typeof item !== 'object' || item === null) return 'failed'
  const record = item as { frameId?: unknown; documentId?: unknown; result?: unknown }
  if (record.frameId !== 0 || record.documentId !== documentId) return 'failed'
  return isDiscordReplacementStatus(record.result) ? record.result : 'failed'
}

async function handleRichInputReplacement(
  message: Extract<TranslationMessage, { type: 'wt:replace-discord-input' | 'wt:replace-chat-input' }>,
  sender: MessageSender,
): Promise<TranslationReply<'wt:replace-discord-input' | 'wt:replace-chat-input'>> {
  if (sender.tab?.incognito === true) return { ok: false, error: '无痕窗口不启用模型功能' }
  if (!fromOurContent(sender)) return { ok: false, error: '无权访问' }
  const pageUrl = sender.url
  const documentId = sender.documentId
  const tabId = sender.tab?.id
  if (typeof pageUrl !== 'string' || typeof documentId !== 'string' || documentId === '' || typeof tabId !== 'number') {
    return { ok: false, error: '无权访问' }
  }
  const allowed = message.type === 'wt:replace-discord-input' ? isDiscordChatUrl(pageUrl) : isSupportedChatUrl(pageUrl)
  if (!allowed) return { ok: false, error: '无权访问' }
  const snapshot = await modelSnapshot().catch(() => undefined)
  if (snapshot === undefined) return unavailableReply(snapshot)
  const signal = new AbortController().signal
  try {
    await assertDispatchAllowed(snapshot, signal, {
      origin: pageUrl,
      sensitive: isSensitivePage(pageUrl),
      feature: 'input',
      manualInput: true,
      pageSender: sender,
    })
    checkCurrent(snapshot, signal)
    const func = message.type === 'wt:replace-discord-input' ? replaceDiscordDraftInMainWorld : replaceChatDraftInMainWorld
    const results = await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: 'MAIN',
      func,
      args: [{ elementId: message.elementId, expectedText: message.expectedText, text: message.text }],
    })
    return { ok: true, inputReplacement: readReplacementResult(results, documentId) }
  } catch (error) {
    return failureReply(error)
  }
}

async function dispatch(message: TranslationMessage, sender: MessageSender): Promise<TranslationReply> {
  if (sender.tab?.incognito === true) return { ok: false, error: '无痕窗口不启用模型功能' }
  switch (message.type) {
    case 'wt:get-config': {
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      return readConsistentModelState(async (config) => {
        const [state, customHeadersState] = await Promise.all([
          keyStateFor(config.baseUrl),
          customHeadersStateFor(config.baseUrl, config.customHeadersRevision),
        ])
        if (state.keyState === 'unavailable') {
          const reply: TranslationReply<'wt:get-config'> = {
            ok: true,
            config,
            keyState: 'unavailable',
            customHeadersState,
          }
          return reply
        }
        const reply: TranslationReply<'wt:get-config'> = {
          ok: true,
          config,
          hasKey: state.hasKey,
          keyState: state.keyState,
          customHeadersState,
        }
        return reply
      }).catch((): TranslationFailure => ({ ok: false, error: '无法读取接口配置或密钥，请在设置中检查' }))
    }
    case 'wt:page-modes': {
      if (fromOurInputFrame(sender)) {
        const [settings, config] = await Promise.all([getSettings(), getTranslationConfig()])
        const allowed = settings.enabled && (await inputFrameAllowed(sender, config))
        const modelReady = config.baseUrl !== '' && config.model !== ''
        return {
          ok: true,
          modes: {
            enabled: allowed,
            fixed: false,
            auto: false,
            selection: false,
            smart: false,
            floating: false,
            subtitles: false,
            input: allowed && modelReady,
          },
        } satisfies TranslationReply<'wt:page-modes'>
      }
      if (!fromOurContent(sender)) return { ok: false, error: '无权访问' }
      const [settings, config] = await Promise.all([getSettings(), getTranslationConfig()])
      const origin = normalizeOrigin(sender.url ?? '')
      if (origin === '') return { ok: false, error: '站点地址无效' }
      const scopeAllowed = isSiteScopeAllowed(sender.url ?? '', config)
      const manualPage = await manualPageAllowed(sender)
      const allowed = settings.enabled && ((await originAllowed(origin)) || manualPage) && scopeAllowed
      const hostname = new URL(origin).hostname
      const disabled = new Set(config.disabledDictionaries)
      const custom = await getCustomDictionaries().catch(() => [])
      const matchedBuiltin = dictionariesForHostname(
        BUILTIN_DICTIONARY_META.filter((d) => !disabled.has(d.id)),
        hostname,
      )
      const matchedCustom = dictionariesForHostname(custom.filter((d) => d.enabled), hostname)
      const hasDictionary = matchedBuiltin.length > 0 || matchedCustom.length > 0
      // 未授权/未启用或无任何词典命中时不加载（不再 await merge）：本地替换只在需要时进行。
      const merged = allowed && hasDictionary
        ? await mergeFixedEntries(matchedBuiltin.map((d) => d.id), matchedCustom, config.targetLanguage)
        : {}
      const fixed = allowed && hasDictionary && Object.keys(merged).length > 0
      const interactiveAllowed =
        allowed && !isExcludedSite(sender.url ?? '', config.excludedHosts) && !isSensitivePage(sender.url ?? '')
      const modelAllowed = interactiveAllowed && config.baseUrl !== '' && config.model !== ''
      const auto = modelAllowed && (config.autoOrigins.includes(origin) || manualPage)
      const selection =
        interactiveAllowed && config.selectionPopupEnabled && (modelAllowed || config.selectionToolbarEnabled)
      return {
        ok: true,
        modes: {
          enabled: settings.enabled && scopeAllowed,
          fixed,
          auto,
          selection,
          smart: selection && !config.selectionToolbarEnabled && config.proactiveAssistEnabled,
          floating: interactiveAllowed && config.floatingButtonEnabled,
          subtitles: modelAllowed && config.autoInteractionEnabled && config.videoSubtitlesEnabled,
          input: modelAllowed && config.inputTranslationEnabled,
          ...(fixed ? { fixedEntries: merged } : {}),
        },
      } satisfies TranslationReply<'wt:page-modes'>
    }
    case 'wt:translate-page': {
      if (fromOurContent(sender)) {
        if ((message.tabId !== undefined && message.tabId !== sender.tab!.id) ||
          (message.url !== undefined && message.url !== sender.url)) return { ok: false, error: '无权访问' }
        if (typeof sender.documentId !== 'string') return { ok: false, error: PAGE_CHANGED_ERROR }
        return startPageTranslation({
          id: sender.tab!.id, url: sender.url, incognito: sender.tab?.incognito, documentId: sender.documentId,
        })
      }
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      try {
        const tab = message.tabId === undefined
          ? (await browser.tabs.query({ active: true, currentWindow: true }))[0]
          : await browser.tabs.get(message.tabId)
        if (tab === undefined) return { ok: false, error: '当前页面不支持' }
        if (message.url !== undefined && message.url !== tab.url) return { ok: false, error: PAGE_CHANGED_ERROR }
        return startPageTranslation(tab)
      } catch {
        return { ok: false, error: '当前页面不支持' }
      }
    }
    case 'wt:save-config':
    case 'wt:set-site-excluded':
    case 'wt:set-site-scope-host':
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      return saveConfig(message)
    case 'wt:set-site-auto':
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      return setSiteAuto(message)
    case 'wt:current-site-auto': {
      if (!fromOurContent(sender)) return { ok: false, error: '无权访问' }
      const result = await setSiteAuto(
        { type: 'wt:set-site-auto', origin: normalizeOrigin(sender.url!), enabled: message.enabled },
        sender,
      )
      return result.ok ? { ok: true } : result
    }
    case 'wt:open-options': {
      if (!fromOurContent(sender)) return { ok: false, error: '无权访问' }
      const failure = await floatingFailure(await getTranslationConfig(), sender)
      if (failure !== undefined) return { ok: false, error: failure }
      if (message.section === 'model') {
        await browser.tabs.create({ url: browser.runtime.getURL('/options.html') + '#wt-title' })
      } else {
        await browser.runtime.openOptionsPage()
      }
      return { ok: true }
    }
    case 'wt:current-page-controls':
      return handleCurrentPageControls(message, sender)
    case 'wt:clear-key': {
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      let cleared = false
      await serializeMutation(async () => {
        const current = await getTranslationConfig()
        await clearApiKey()
        cleared = true
        await syncSiteTabs(current, current).catch(() => undefined)
      }, invalidateModelWork)
      return (cleared
        ? { ok: true, hasKey: false, keyState: 'none' }
        : { ok: false, error: '删除失败' }) satisfies TranslationReply<'wt:clear-key'>
    }
    case 'wt:clear-cache': {
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      // 与配置写入共用屏障：新请求等清除完成后再查缓存或发送文字。
      let cleared = false
      await serializeMutation(async () => {
        cleared = await clearPersistentTranslations()
      }, invalidateModelWork)
      return (cleared ? { ok: true } : { ok: false, error: '清除失败' }) satisfies TranslationReply<'wt:clear-cache'>
    }
    case 'wt:test':
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      return handleTest(sender)
    case 'wt:list-models':
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      return handleListModels(message, sender)
    case 'wt:cancel-models':
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      return handleCancelModels(message, sender)
    case 'wt:page-action':
      if (!fromExtensionPage(sender)) return { ok: false, error: '无权访问' }
      return handlePageAction(message)
    case 'wt:translate':
      if (!fromOurContent(sender) && !(fromOurInputFrame(sender) && message.mode === 'input')) {
        return { ok: false, error: '无权访问' }
      }
      return handleTranslate(message, sender)
    case 'wt:replace-discord-input':
    case 'wt:replace-chat-input':
      return handleRichInputReplacement(message, sender)
    case 'wt:assist':
      if (!fromOurContent(sender)) return { ok: false, error: '无权访问' }
      return handleAssist(message, sender)
    case 'wt:cancel-assist':
      if (!fromOurContent(sender) && !fromOurInputFrame(sender)) return { ok: false, error: '无权访问' }
      return handleCancelAssist(message, sender)
    case 'wt:page-context': {
      if (!fromOurContent(sender)) return { ok: false, error: '无权访问' }
      const contextRevision = currentRevision()
      const reading0 = readingGeneration
      const settings = await getSettings()
      const config = await getTranslationConfig()
      if (
        !settings.enabled ||
        !config.selectionPopupEnabled ||
        !config.proactiveAssistEnabled ||
        config.selectionToolbarEnabled
      ) {
        return { ok: false, error: '未开启主动阅读提示' }
      }
      if (!isSiteScopeAllowed(sender.url ?? '', config)) {
        return { ok: false, error: SITE_SCOPE_BLOCKED_ERROR }
      }
      if (isSensitivePage(sender.url ?? '') || isExcludedSite(sender.url ?? '', config.excludedHosts)) {
        return { ok: false, error: '无权访问' }
      }
      const senderOrigin = normalizeOrigin(sender.url ?? '')
      const host = senderOrigin === '' ? '' : new URL(senderOrigin).hostname
      if (host === '' || message.page.site !== host) return { ok: false, error: '站点不匹配' }
      if (!(await originAllowed(senderOrigin))) {
        return { ok: false, error: '未授权访问该站点' }
      }
      if (contextRevision !== currentRevision() || reading0 !== readingGeneration) {
        return { ok: false, error: '已取消' }
      }
      try {
        await recordPageContext(message.page, message.pageId, sender.tab?.id ?? -1)
      } catch {
        return { ok: false, error: '阅读线索写入失败' }
      }
      return { ok: true } satisfies TranslationReply<'wt:page-context'>
    }
  }
}

async function showSelectionInTab(
  tabId: number,
  message: ContentTranslationMessage,
  documentId?: string,
  beforeSend?: () => Promise<boolean>,
): Promise<void> {
  const scripting = browser.scripting
  if (typeof scripting?.executeScript !== 'function') return
  try {
    await scripting.executeScript({
      target: documentId === undefined ? { tabId } : { tabId, documentIds: [documentId] },
      files: SITE_SCRIPT_FILES,
      injectImmediately: true,
    })
  } catch {
    console.error('[网页汉化助手] 无法在此页面执行')
    return
  }
  if (beforeSend !== undefined && !(await beforeSend())) return
  await sendToTabMessage(tabId, message, documentId).catch(() => {
    console.error('[网页汉化助手] 无法在此页面执行')
  })
}

function installSelectionMenu(): void {
  installMenuClickListener()
  const revision = ++menuRevision
  void getSettings()
    .then((settings) => {
      if (revision !== menuRevision) return
      const language = resolveUiLanguage(settings.uiLanguage, languageEnvironment())
      installSelectionMenuInner(MENU_ID, SELECTION_MENU_TITLES[language], ['selection'], revision)
      installSelectionMenuInner(PAGE_MENU_ID, PAGE_MENU_TITLES[language], ['page', 'link', 'image'], revision)
    })
    .catch(() => {
      if (revision !== menuRevision) return
      const language = resolveUiLanguage('auto', languageEnvironment())
      installSelectionMenuInner(MENU_ID, SELECTION_MENU_TITLES[language], ['selection'], revision)
      installSelectionMenuInner(PAGE_MENU_ID, PAGE_MENU_TITLES[language], ['page', 'link', 'image'], revision)
    })
}

function installSelectionMenuInner(
  id: string,
  title: string,
  contexts: NonNullable<Parameters<typeof browser.contextMenus.create>[0]['contexts']>,
  revision: number,
): void {
  const menus = browser.contextMenus
  if (typeof menus?.create !== 'function' || typeof menus?.update !== 'function') return
  const item = {
    title,
    contexts,
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  }
  try {
    const updated = menus.update(id, item)
    if (updated !== undefined && typeof (updated as Promise<void>).catch === 'function') {
      void (updated as Promise<void>).catch(() => {
        if (revision !== menuRevision) return
        try {
          menus.create({ id, ...item })
        } catch {
          void 0
        }
      })
    }
  } catch {
    try {
      menus.create({ id, ...item })
    } catch {
      void 0
    }
  }
}

let menuListenerInstalled = false

async function grantAndShowSelection(
  tabId: number,
  top: SelectionDocument,
  source: SelectionDocument,
  raw: string,
): Promise<void> {
  pruneManualGrants()
  if (manualGrants.size >= MANUAL_GRANT_MAX) manualGrants.clear()
  const grant: ManualGrant = {
    id: crypto.randomUUID(),
    top,
    source,
    text: raw,
    expires: Date.now() + MANUAL_GRANT_MS,
  }
  manualGrants.set(tabId, grant)
  await showSelectionInTab(
    tabId,
    { type: 'wt:show-selection', text: raw, manualSelectionId: grant.id },
    top.documentId,
    async () => {
      if (activeGrantForTicket(tabId, grant.id, raw) === undefined) return false
      const alive = await verifySelectionDocuments(tabId, grant)
      if (!alive) {
        if (manualGrants.get(tabId)?.id === grant.id) manualGrants.delete(tabId)
        return false
      }
      return activeGrantForTicket(tabId, grant.id, raw) !== undefined
    },
  )
}

async function sourceFrameFailure(
  top: SelectionDocument,
  source: SelectionDocument,
): Promise<string | undefined> {
  const topOrigin = normalizeOrigin(top.url)
  const sourceOrigin = normalizeOrigin(source.url)
  if (topOrigin === '' || sourceOrigin === '') return '暂不支持在嵌入框架中划词'
  const [settings, config] = await Promise.all([getSettings(), getTranslationConfig()])
  if (!settings.enabled) return '总开关已关闭'
  if (!isSiteScopeAllowed(top.url, config) || !isSiteScopeAllowed(source.url, config)) {
    return SITE_SCOPE_BLOCKED_ERROR
  }
  if (isExcludedSite(top.url, config.excludedHosts) || isExcludedSite(source.url, config.excludedHosts)) {
    return '该站点已排除模型处理'
  }
  if (source.frameId !== 0) {
    if (isSensitivePage(source.url)) return SENSITIVE_FRAME_ERROR
    if (sourceOrigin !== topOrigin && !(await originAllowed(sourceOrigin))) {
      return '未授权访问该站点'
    }
  }
  return undefined
}

async function shortcutBlocked(url: string, tabId?: number): Promise<boolean> {
  if (!/^https?:/.test(url)) return true
  const [settings, config] = await Promise.all([getSettings(), getTranslationConfig()])
  if (!settings.enabled) return true
  if (!isSiteScopeAllowed(url, config)) return true
  if (isExcludedSite(url, config.excludedHosts) || isSensitivePage(url)) return true
  if (!(await originAllowed(normalizeOrigin(url)))) {
    if (tabId === undefined) return true
    const top = await readTopDocument(tabId)
    if (top === undefined || !sameManualPage(top.url, url)) return true
    const grant = await getManualPageGrant(tabId, top.documentId, top.url)
    if (grant === undefined || !(await pageGrantCurrent(grant))) return true
  }
  return false
}

async function pageMenuAction(
  tab: PageTarget,
  top: SelectionDocument,
): Promise<TranslationReply<'wt:translate-page'>> {
  if (tab.incognito) return { ok: false, error: '无痕窗口不启用模型功能' }
  if (typeof tab.id !== 'number' || typeof tab.url !== 'string' || !sameManualPage(top.url, tab.url)) {
    return { ok: false, error: PAGE_CHANGED_ERROR }
  }
  const tabId = tab.id
  const url = top.url
  const recheck = async (): Promise<string | undefined> => {
    const [settings, config] = await Promise.all([getSettings(), getTranslationConfig()])
    if (!settings.enabled) return '总开关已关闭'
    if (!isSiteScopeAllowed(url, config)) return SITE_SCOPE_BLOCKED_ERROR
    if (isExcludedSite(url, config.excludedHosts)) return '该站点已排除模型处理'
    if (isSensitivePage(url)) return '该页面仅支持通过右键菜单主动翻译所选文字'
    const current = await readTopDocument(tabId)
    return current?.documentId === top.documentId && sameManualPage(current.url, url) ? undefined : PAGE_CHANGED_ERROR
  }
  const initialFailure = await recheck()
  if (initialFailure !== undefined) return { ok: false, error: initialFailure }
  const emptyStatus = { fixed: false, auto: false, paused: false }
  const emptyLegacy = { active: false, paused: false }
  const statusMessage: ContentTranslationMessage = { type: 'wt:status' }
  const [status, legacy] = await Promise.all([
    sendToTabMessage(tabId, statusMessage, top.documentId).then((reply) => {
      if (reply === undefined) return emptyStatus
      if (!isContentTranslationReply(reply, statusMessage) || !reply.ok || reply.status === undefined) {
        throw new TranslationError(PAGE_START_ERROR)
      }
      return reply.status
    }).catch((error: unknown) => {
      if (isNoReceiverError(error)) return emptyStatus
      throw error
    }),
    parseGitHubUrl(url) === undefined
      ? Promise.resolve(emptyLegacy)
      : sendToTabMessage(tabId, { type: 'gcn:page-translation', action: 'status', url }, top.documentId)
          .then((reply) => {
            if (reply === undefined) return emptyLegacy
            if (!isGitHubPageReply(reply)) throw new TranslationError(PAGE_START_ERROR)
            return { active: reply.active, paused: reply.paused }
          }).catch((error: unknown) => {
            if (isNoReceiverError(error)) return emptyLegacy
            throw error
          }),
  ])
  const currentFailure = await recheck()
  if (currentFailure !== undefined) return { ok: false, error: currentFailure }
  const translated = ((status.fixed || status.auto) && !status.paused) || (legacy.active && !legacy.paused)
  const action = translated ? 'restore' : status.paused || legacy.paused ? 'resume' : undefined
  if (action === 'restore') return forwardPageAction(tabId, top.documentId, url, action, recheck)
  const config = await getTranslationConfig()
  const origin = normalizeOrigin(url)
  if (
    action === undefined ||
    (config.baseUrl !== '' && config.model !== '' &&
      (!config.autoOrigins.includes(origin) || !(await originAllowed(origin))))
  ) {
    return startPageTranslation({ ...tab, documentId: top.documentId })
  }
  return forwardPageAction(tabId, top.documentId, url, 'resume', recheck)
}

async function pageMenuFeedback(tab: PageTarget, top: SelectionDocument | undefined, error: string): Promise<void> {
  if (error === '请先配置接口地址与模型') {
    await browser.tabs.create({ url: browser.runtime.getURL('/options.html') + '#wt-title' })
    return
  }
  if (typeof tab.id !== 'number') return
  const tabId = tab.id
  const notice = error === '总开关已关闭' ? 'disabled' : 'page-unavailable'
  const fallback = async (): Promise<void> => {
    await browser.tabs.create({ url: browser.runtime.getURL('/options.html') + `?notice=${notice}` })
  }
  if (top === undefined) {
    await fallback()
    return
  }
  const current = await readTopDocument(tabId)
  if (current?.documentId !== top.documentId || current.url !== top.url) return
  try {
    await browser.scripting.executeScript({
      target: { tabId, documentIds: [top.documentId] }, files: SITE_SCRIPT_FILES, injectImmediately: true,
    })
    const again = await readTopDocument(tabId)
    if (again?.documentId !== top.documentId || again.url !== top.url) return
    const message: ContentTranslationMessage = { type: 'wt:show-selection', text: '', error }
    const reply = await sendToTabMessage(tabId, message, top.documentId)
    if (!isContentTranslationReply(reply, message) || !reply.ok) await fallback()
  } catch {
    const again = await readTopDocument(tabId)
    if (again?.documentId === top.documentId && again.url === top.url) await fallback()
  }
}

const pageMenuQueues = new Map<number, Promise<void>>()

function enqueuePageMenu(
  tab: PageTarget & { readonly id: number },
  info: MenuClickInfo,
): Promise<void> {
  const topPromise = readTopDocument(tab.id)
  const work = (pageMenuQueues.get(tab.id) ?? Promise.resolve()).catch(reportError).then(async () => {
    const top = await topPromise
    try {
      const reply: TranslationReply<'wt:translate-page'> =
        info.frameId !== undefined && info.frameId !== 0
          ? { ok: false, error: '嵌入页面暂不支持整页翻译，请在主页面操作' }
          : top === undefined
            ? { ok: false, error: '当前页面不支持翻译，或浏览器未授予访问权限' }
            : info.pageUrl !== undefined && !sameManualPage(info.pageUrl, top.url)
              ? { ok: false, error: PAGE_CHANGED_ERROR }
              : await pageMenuAction(tab, top)
      if (!reply.ok) await pageMenuFeedback(tab, top, reply.error)
    } catch (error) {
      await pageMenuFeedback(tab, top, error instanceof TranslationError ? error.message : PAGE_START_ERROR)
    }
  })
  pageMenuQueues.set(tab.id, work)
  void work.finally(() => {
    if (pageMenuQueues.get(tab.id) === work) pageMenuQueues.delete(tab.id)
  }).catch(reportError)
  return work
}

function installMenuClickListener(): void {
  if (menuListenerInstalled) return
  const menus = browser.contextMenus
  if (typeof menus?.onClicked?.addListener !== 'function') return
  try {
    menus.onClicked.addListener((info, tab) => {
      void (async () => {
        try {
          if (info.menuItemId === PAGE_MENU_ID && typeof tab?.id === 'number') {
            await enqueuePageMenu({ id: tab.id, url: tab.url, incognito: tab.incognito }, info)
            return
          }
          if (info.menuItemId !== MENU_ID || typeof tab?.id !== 'number') return
          if (tab.incognito === true) return
          const tabId = tab.id
          const raw = (info.selectionText ?? '').trim()
          if (raw === '') return
          if (raw.length > 6000) {
            await showSelectionInTab(tabId, {
              type: 'wt:show-selection',
              text: '',
              error: '选中文字过长（最多 6000 字）',
            })
            return
          }
          const scripting = browser.scripting
          if (typeof scripting?.executeScript !== 'function') return
          const sourceFrameId = typeof info.frameId === 'number' ? info.frameId : 0
          const frameIds = sourceFrameId === 0 ? [0] : [0, sourceFrameId]
          const rawResults: unknown = await scripting
            .executeScript({
              target: { tabId, frameIds },
              func: readManualSelection,
              args: [false],
            })
            .catch(() => undefined)
          if (rawResults === undefined && sourceFrameId !== 0) {
            const topOnly = await scripting
              .executeScript({
                target: { tabId, frameIds: [0] },
                func: readManualSelection,
                args: [false],
              })
              .catch(() => undefined)
            const topFallback = parseInjectionSnapshots(topOnly).find((item) => item.frameId === 0)
            if (topFallback !== undefined && normalizeOrigin(topFallback.snapshot.url) !== '') {
              const error =
                typeof info.frameUrl === 'string' && normalizeOrigin(info.frameUrl) === ''
                  ? '暂不支持在嵌入框架中划词'
                  : '未授权访问该站点'
              await showSelectionInTab(
                tabId,
                { type: 'wt:show-selection', text: '', error },
                topFallback.documentId,
              )
            }
            return
          }
          const snapshots = parseInjectionSnapshots(rawResults)
          const topEntry = snapshots.find((item) => item.frameId === 0)
          if (topEntry === undefined || normalizeOrigin(topEntry.snapshot.url) === '') return
          const top: SelectionDocument = {
            frameId: 0,
            documentId: topEntry.documentId,
            url: topEntry.snapshot.url,
          }
          const sourceEntry = snapshots.find((item) => item.frameId === sourceFrameId)
          if (sourceEntry === undefined) {
            if (sourceFrameId !== 0) {
              const error =
                typeof info.frameUrl === 'string' && normalizeOrigin(info.frameUrl) === ''
                  ? '暂不支持在嵌入框架中划词'
                  : '未授权访问该站点'
              await showSelectionInTab(
                tabId,
                { type: 'wt:show-selection', text: '', error },
                top.documentId,
              )
            }
            return
          }
          const source: SelectionDocument = {
            frameId: sourceEntry.frameId,
            documentId: sourceEntry.documentId,
            url: sourceEntry.snapshot.url,
          }
          if (typeof info.frameUrl === 'string' && info.frameUrl !== '' && source.url !== info.frameUrl) {
            return
          }
          if (sourceFrameId === 0 && typeof info.pageUrl === 'string' && info.pageUrl !== '' && top.url !== info.pageUrl) {
            return
          }
          if (sourceFrameId !== 0) {
            const failure = await sourceFrameFailure(top, source)
            if (failure !== undefined) {
              await showSelectionInTab(
                tabId,
                { type: 'wt:show-selection', text: '', error: failure },
                top.documentId,
              )
              return
            }
          }
          const selectedText = sourceEntry.snapshot.text
          if (selectedText.length > 6000) {
            await showSelectionInTab(tabId, { type: 'wt:show-selection', text: '', error: '选中文字过长（最多 6000 字）' }, top.documentId)
            return
          }
          if (selectedText === '' || selectedText.replace(/\s+/gu, ' ') !== raw.replace(/\s+/gu, ' ')) {
            await showSelectionInTab(tabId, { type: 'wt:show-selection', text: '', error: NO_SELECTION_ERROR }, top.documentId)
            return
          }
          await grantAndShowSelection(tabId, top, source, selectedText)
        } catch {
          void 0
        }
      })()
    })
    menuListenerInstalled = true
  } catch {
    void 0
  }
}

function installCommandListener(): void {
  if (typeof browser.commands?.onCommand?.addListener !== 'function') return
  try {
    browser.commands.onCommand.addListener((command, passedTab) => {
      void (async () => {
        try {
          if (command !== 'toggle-page-translation' && command !== 'translate-selection' && command !== 'translate-input') return
          const tab =
            passedTab ??
            (typeof browser.tabs?.query === 'function'
              ? (await browser.tabs.query({ active: true, currentWindow: true }))[0]
              : undefined)
          if (typeof tab?.id !== 'number' || tab.incognito === true || typeof tab.url !== 'string') return
          const tabId = tab.id
          const url = tab.url
          if (await shortcutBlocked(url, tabId)) return
          if (command === 'translate-input') {
            const config = await getTranslationConfig()
            if (!config.inputTranslationEnabled) return
            if (!isYouTubePageUrl(url)) {
              await sendToTabMessage(tabId, { type: 'wt:translate-input' }, undefined)
              return
            }
            const documents = await readInputFrameDocuments(tabId)
            const candidates = documents.filter(
              (item) =>
                item.snapshot.focused &&
                item.snapshot.topUrl === url &&
                ((item.frameId === 0 && item.snapshot.url === url) ||
                  (item.frameId > 0 && isYouTubeInputFramePair(url, item.snapshot.url))),
            )
            if (candidates.length !== 1) return
            const chosen = candidates[0]!
            if (chosen.frameId > 0) {
              const candidateSender: MessageSender = {
                id: browser.runtime.id,
                tab: { id: tabId, url, incognito: false } as Browser.tabs.Tab,
                frameId: chosen.frameId,
                documentId: chosen.documentId,
                url: chosen.snapshot.url,
                origin: normalizeOrigin(chosen.snapshot.url),
              }
              if (!(await inputFrameAllowed(candidateSender, config))) return
              if (typeof browser.scripting?.executeScript !== 'function') return
              await browser.scripting.executeScript({
                target: { tabId, documentIds: [chosen.documentId] },
                files: INPUT_FRAME_SCRIPT_FILES,
                injectImmediately: true,
              })
            }
            await browser.tabs.sendMessage(
              tabId,
              { type: 'wt:translate-input' } satisfies ContentTranslationMessage,
              { frameId: chosen.frameId, documentId: chosen.documentId },
            )
            return
          }
          if (command === 'toggle-page-translation') {
            const isGithub = parseGitHubUrl(url) !== undefined
            const statusMessage: ContentTranslationMessage = { type: 'wt:status' }
            let genericOk = false
            let githubOk = false
            const [status, legacy] = await Promise.all([
              sendToTabMessage(tabId, statusMessage, undefined)
                .then((reply) => {
                  if (isContentTranslationReply(reply, statusMessage) && reply.ok && reply.status !== undefined) {
                    genericOk = true
                    return reply.status
                  }
                  return { fixed: false, auto: false, paused: false }
                })
                .catch(() => ({ fixed: false, auto: false, paused: false })),
              isGithub
                ? sendToTabMessage(tabId, { type: 'gcn:page-translation', action: 'status', url }, undefined)
                    .then((reply) => {
                      if (isGitHubPageReply(reply)) {
                        githubOk = true
                        return { active: reply.active, paused: reply.paused }
                      }
                      return { active: false, paused: false }
                    })
                    .catch(() => ({ active: false, paused: false }))
                : Promise.resolve({ active: false, paused: false }),
            ])
            if (!genericOk && !githubOk) return
            const translatedNow = ((status.fixed || status.auto) && !status.paused) || (legacy.active && !legacy.paused)
            const action = translatedNow ? 'restore' : status.paused || legacy.paused ? 'resume' : undefined
            if (action === undefined) {
              // 文案是「翻译本页 / 恢复原文」：没有可切换的翻译时要告诉用户，而不是静默
              await showSelectionInTab(tabId, { type: 'wt:show-selection', text: '', error: NOTHING_TO_TOGGLE_ERROR })
              return
            }
            // 两次往返期间总开关、运行范围可能已变化：动作链里再查一次，与悬浮菜单路径一致
            await forwardPageAction(tabId, undefined, url, action, async () =>
              (await shortcutBlocked(url, tabId)) ? SITE_SCOPE_BLOCKED_ERROR : undefined,
            )
            return
          }
          const scripting = browser.scripting
          if (typeof scripting?.executeScript !== 'function') return
          let rawResults: unknown = await scripting
            .executeScript({ target: { tabId, allFrames: true }, func: readManualSelection })
            .catch(() => undefined)
          if (rawResults === undefined) {
            rawResults = await scripting
              .executeScript({ target: { tabId, frameIds: [0] }, func: readManualSelection })
              .catch(() => undefined)
          }
          const snapshots = parseInjectionSnapshots(rawResults)
          const topEntry = snapshots.find((item) => item.frameId === 0)
          if (topEntry === undefined) return
          const top: SelectionDocument = {
            frameId: 0,
            documentId: topEntry.documentId,
            url: topEntry.snapshot.url,
          }
          if (top.url !== url || (await shortcutBlocked(top.url, tabId))) return
          const focusedEntry = snapshots.find((item) => item.snapshot.focused && !item.snapshot.frameFocused)
          if (focusedEntry === undefined) {
            const error = snapshots.some((item) => item.snapshot.frameFocused)
              ? '未授权访问该站点'
              : NO_SELECTION_ERROR
            await showSelectionInTab(tabId, { type: 'wt:show-selection', text: '', error }, top.documentId)
            return
          }
          const source: SelectionDocument = {
            frameId: focusedEntry.frameId,
            documentId: focusedEntry.documentId,
            url: focusedEntry.snapshot.url,
          }
          if (source.frameId !== 0) {
            const failure = await sourceFrameFailure(top, source)
            if (failure !== undefined) {
              await showSelectionInTab(tabId, { type: 'wt:show-selection', text: '', error: failure }, top.documentId)
              return
            }
          }
          const raw = focusedEntry.snapshot.text.trim()
          if (raw === '') {
            await showSelectionInTab(
              tabId,
              { type: 'wt:show-selection', text: '', error: NO_SELECTION_ERROR },
              top.documentId,
            )
            return
          }
          if (raw.length > 6000) {
            await showSelectionInTab(
              tabId,
              { type: 'wt:show-selection', text: '', error: '选中文字过长（最多 6000 字）' },
              top.documentId,
            )
            return
          }
          await grantAndShowSelection(tabId, top, source, raw)
        } catch {
          void 0
        }
      })()
    })
  } catch {
    void 0
  }
}

export function installTranslationBackground(): void {
  browser.runtime.onMessage.addListener((message: unknown, sender: MessageSender, sendResponse) => {
    if (!isTranslationMessage(message)) {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'wt:save-config') {
        if (sender.tab?.incognito === true) {
          sendResponse({ ok: false, error: '无痕窗口不启用模型功能' } satisfies TranslationReply)
          return true
        }
        if (!fromExtensionPage(sender)) {
          sendResponse({ ok: false, error: '无权访问' } satisfies TranslationReply)
          return true
        }
        sendResponse({ ok: false, error: '接口配置无效，请检查高级设置' } satisfies TranslationReply)
        return true
      }
      return undefined
    }
    void dispatch(message, sender).then(
      (reply) => sendResponse(reply),
      () => sendResponse({ ok: false, error: '请求失败' } satisfies TranslationReply),
    )
    return true
  })
  installPageSessions()
  installMenuClickListener()
  installCommandListener()
  browser.runtime.onInstalled.addListener(() => {
    installSelectionMenu()
    void syncAllSiteScripts().catch(reportError)
  })
  try {
    if (typeof browser.tabs?.onRemoved?.addListener === 'function') {
      browser.tabs.onRemoved.addListener((tabId) => {
        manualGrants.delete(tabId)
        void revokeManualPageGrant(tabId).catch(reportError)
        for (const [key, controller] of requests) {
          if (key.startsWith(`${tabId}:`)) {
            controller.abort()
            requests.delete(key)
            interactive.delete(key)
          }
        }
      })
    }
  } catch {
    void 0
  }
  try {
    if (typeof browser.tabs?.onUpdated?.addListener === 'function') {
      browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
        // 子框架导航也会触发 loading；只按顶层地址变化清票据，同 URL 重载由 documentId 复查拦截。
        if (typeof changeInfo.url === 'string') {
          void expireNavigatedManualPage(tabId, changeInfo.url).catch(reportError)
          const grant = manualGrants.get(tabId)
          if (grant !== undefined && grant.top.url !== changeInfo.url) manualGrants.delete(tabId)
        }
      })
    }
  } catch {
    void 0
  }
  try {
    if (typeof browser.permissions?.onRemoved?.addListener === 'function') {
      browser.permissions.onRemoved.addListener(() => {
        invalidateModelState(() => invalidateModelWork('permissions'))
        clearManualGrants()
        void clearManualPages().catch(reportError)
        void clearPageContexts().catch(() => undefined)
      })
    }
  } catch {
    void 0
  }
  let previousMenuLanguage: UiLanguage | undefined
  watchSettings((settings) => {
    const language = resolveUiLanguage(settings.uiLanguage, languageEnvironment())
    if (previousMenuLanguage !== language) {
      previousMenuLanguage = language
      installSelectionMenu()
    }
    if (!settings.enabled) {
      clearManualGrants()
      void clearManualPages().catch(reportError)
      invalidateModelState(invalidateModelWork)
      void clearPageContexts().catch(() => undefined)
    }
  })
  watchTranslationConfig((next, previous) => {
    if (!next.proactiveAssistEnabled || !next.selectionPopupEnabled) {
      void clearPageContexts().catch(() => undefined)
    }
    if (invalidatedFor === JSON.stringify(next)) {
      invalidatedFor = undefined
      return
    }
    invalidateForConfig(previous, next)
  })
  installContextExpiry()
  installSiteScriptSync()
}
