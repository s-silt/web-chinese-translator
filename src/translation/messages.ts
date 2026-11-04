import { isGitHubPageState, type GitHubPageAction, type GitHubPageState } from '../shared/messages'
import { isModelList, type TranslationConfig } from './config'
import { BUILTIN_DICTIONARY_META, MAX_FIXED_ENTRIES } from './dictionaries/index'
import { isSiteScopeMode } from './site-scope'
import { isSourceLanguage, isTargetLanguage } from './target-language'
import { isPageContext, isPageId, type PageContext } from './reading-context'
import { isAssistInput, parseAssistResult, type AssistInput, type AssistResult } from './intent'
import { isFailureCode, type FailureCode } from './failure'
import {
  isApiType,
  isTemperature,
  normalizeCustomHeaders,
  normalizeRequestParams,
} from './request-options'

export type TranslationConfigPatch = Partial<
  Omit<TranslationConfig, 'autoOrigins' | 'siteScopeHosts' | 'customHeadersRevision'>
>

/** 页面生命周期端口的名称前缀，后接会话 ID。 */
export const PAGE_PORT_PREFIX = 'wt:page:'

export const NO_SELECTION_ERROR = '请先选中要翻译的文字'
export const SENSITIVE_FRAME_ERROR = '敏感页面中的嵌入内容暂不支持翻译'
export const TRANSLATION_CONFIG_CHANGED_ERROR = '翻译设置已变化'
export const TRANSLATION_PERMISSION_REMOVED_ERROR = '翻译所需的访问权限已撤销'
/** 快捷键「翻译本页 / 恢复原文」：页面既没在翻译也没有暂停的翻译 */
export const NOTHING_TO_TOGGLE_ERROR = '本页没有可切换的翻译'

export interface PageModes {
  readonly enabled: boolean
  readonly fixed: boolean
  readonly auto: boolean
  readonly selection: boolean
  readonly smart: boolean
  readonly floating?: boolean
  /** fixed === true 时页面可立即用于词典替换的完整词条表（含 COMMON_UI 底表）。 */
  readonly fixedEntries?: Readonly<Record<string, string>>
}

export type PageAction = 'restore' | 'resume' | 'retry-failed'

export type TranslationMessage =
  | { type: 'wt:get-config' }
  | { type: 'wt:page-modes' }
  | {
      type: 'wt:save-config'
      patch: TranslationConfigPatch
      apiKey?: string
      customHeaders?: Readonly<Record<string, string>>
      expectedConnection?: { baseUrl: string; model: string; requestOptionsKey?: string }
    }
  | { type: 'wt:set-site-auto'; origin: string; enabled: boolean }
  | { type: 'wt:set-site-excluded'; host: string; excluded: boolean }
  | { type: 'wt:set-site-scope-host'; host: string; listed: boolean }
  | { type: 'wt:clear-key' }
  | { type: 'wt:clear-cache' }
  | { type: 'wt:test' }
  | {
      type: 'wt:translate'
      mode: 'selection' | 'auto'
      texts: string[]
      requestId?: string
      page?: PageContext
      pageId?: string
      pageSession?: string
      manualSelectionId?: string
    }
  | { type: 'wt:page-action'; action: PageAction; tabId?: number; url?: string }
  | { type: 'wt:current-site-auto'; enabled: boolean }
  | { type: 'wt:current-page-controls'; action: GitHubPageAction }
  | { type: 'wt:open-options'; section?: 'model' }
  | {
      type: 'wt:assist'
      requestId: string
      input: AssistInput
      page?: PageContext
      pageId?: string
      pageSession?: string
    }
  | { type: 'wt:cancel-assist'; requestId: string }
  | {
      type: 'wt:list-models'
      baseUrl: string
      apiKey?: string
      customHeaders?: Readonly<Record<string, string>>
      requestId: string
    }
  | { type: 'wt:cancel-models'; requestId: string }
  | { type: 'wt:page-context'; page: PageContext; pageId: string }
  | { type: 'wt:translate-page'; tabId?: number; url?: string }

export type KeyState = 'none' | 'ready' | 'different-origin' | 'legacy' | 'unavailable'
export type CustomHeadersState = 'none' | 'ready' | 'different-origin' | 'unavailable'

export type TranslationFailure = { ok: false; error: string; code?: FailureCode; retryAfterMs?: number }

interface ReplyFields {
  texts?: string[]
  models?: string[]
  /** 其中由缓存提供、未花费接口额度的字符数。 */
  cachedChars?: number
  config?: TranslationConfig
  hasKey?: boolean
  keyState?: KeyState
  customHeadersState?: CustomHeadersState
  modes?: PageModes
  result?: AssistResult
  warning?: string
  legacy?: GitHubPageState
}

type AckPayload = Record<never, never>

interface ConfigPayload {
  config: TranslationConfig
  hasKey?: boolean
  keyState?: KeyState
  customHeadersState?: CustomHeadersState
  warning?: string
}

interface TranslationPayloads {
  'wt:get-config': ConfigPayload
  'wt:save-config': ConfigPayload
  'wt:set-site-auto': ConfigPayload
  'wt:set-site-excluded': ConfigPayload
  'wt:set-site-scope-host': ConfigPayload
  'wt:page-modes': { modes: PageModes }
  'wt:test': { texts: string[] }
  'wt:translate': { texts: string[]; cachedChars?: number }
  'wt:assist': { result: AssistResult }
  'wt:clear-key': { hasKey: false; keyState?: 'none' }
  'wt:clear-cache': AckPayload
  'wt:page-action': AckPayload
  'wt:cancel-assist': AckPayload
  'wt:list-models': { models: string[] }
  'wt:cancel-models': AckPayload
  'wt:page-context': AckPayload
  'wt:current-site-auto': AckPayload
  'wt:open-options': AckPayload
  'wt:translate-page': AckPayload
  'wt:current-page-controls': { legacy: GitHubPageState }
}

export type TranslationReply<T extends TranslationMessage['type'] = TranslationMessage['type']> =
  | ({ ok: true } & ReplyFields & TranslationPayloads[T])
  | TranslationFailure

export type ContentTranslationMessage =
  | { type: 'wt:show-selection'; text: string; error?: string; manualSelectionId?: string }
  | { type: 'wt:page-action'; action: PageAction; url?: string }
  | { type: 'wt:refresh' }
  | { type: 'wt:stop' }
  | { type: 'wt:status' }
  | { type: 'wt:read-selection' }

export interface PageTranslationStatus {
  readonly supported: boolean
  readonly fixed: boolean
  readonly auto: boolean
  readonly paused: boolean
  readonly capped: boolean
  readonly budgetCapped?: boolean
  /** 已放弃、仍保留原文的文本段数。 */
  readonly failed: number
  readonly error: string
}

interface ContentPayloads {
  'wt:show-selection': AckPayload
  'wt:page-action': AckPayload
  'wt:refresh': AckPayload
  'wt:stop': AckPayload
  'wt:status': { status: PageTranslationStatus }
  'wt:read-selection': { text: string }
}

export type ContentTranslationReply<T extends ContentTranslationMessage['type'] = ContentTranslationMessage['type']> =
  | ({ ok: true; status?: PageTranslationStatus; text?: string } & ContentPayloads[T])
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPageAction(value: unknown): value is PageAction {
  return value === 'restore' || value === 'resume' || value === 'retry-failed'
}

function isOptionalApiKey(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 512)
}

function isExcludedHosts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50 &&
    value.every((host) => typeof host === 'string' && host.length > 0 && host.length <= 2048)
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function isCustomHeadersRevision(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || UUID_PATTERN.test(value))
}

function isValidRequestParams(value: unknown): boolean {
  try {
    normalizeRequestParams(value)
    return true
  } catch {
    return false
  }
}

function isValidCustomHeaders(value: unknown): boolean {
  try {
    normalizeCustomHeaders(value)
    return true
  } catch {
    return false
  }
}

const PATCH_KEYS = new Set([
  'baseUrl',
  'model',
  'apiType',
  'temperature',
  'requestParams',
  'disabledDictionaries',
  'targetLanguage',
  'sourceLanguage',
  'selectionPopupEnabled',
  'selectionToolbarEnabled',
  'proactiveAssistEnabled',
  'floatingButtonEnabled',
  'autoInteractionEnabled',
  'excludedHosts',
  'siteScopeMode',
])

function isSaveConfig(value: unknown): boolean {
  if (!isRecord(value)) return false
  const patch = value.patch
  if (!isRecord(patch)) return false
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) return false
    if (key === 'excludedHosts' && !isExcludedHosts((patch as Record<string, unknown>)[key])) return false
    if (key === 'disabledDictionaries' && !isDisabledDictionaries((patch as Record<string, unknown>)[key])) return false
    if (key === 'targetLanguage' && !isTargetLanguage((patch as Record<string, unknown>)[key])) return false
    if (key === 'sourceLanguage' && !isSourceLanguage((patch as Record<string, unknown>)[key])) return false
    if (key === 'siteScopeMode' && !isSiteScopeMode((patch as Record<string, unknown>)[key])) return false
    if (key === 'apiType' && !isApiType((patch as Record<string, unknown>)[key])) return false
    if (key === 'temperature' && !isTemperature((patch as Record<string, unknown>)[key])) return false
    if (key === 'requestParams' && !isValidRequestParams((patch as Record<string, unknown>)[key])) return false
  }
  if (patch.baseUrl !== undefined && (typeof patch.baseUrl !== 'string' || patch.baseUrl.length > 2048)) return false
  if (patch.model !== undefined && (typeof patch.model !== 'string' || patch.model.length > 200)) return false
  for (const key of ['selectionPopupEnabled', 'selectionToolbarEnabled', 'proactiveAssistEnabled', 'floatingButtonEnabled', 'autoInteractionEnabled'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') return false
  }
  if (!isOptionalApiKey(value.apiKey)) return false
  if (value.customHeaders !== undefined && !isValidCustomHeaders(value.customHeaders)) return false
  const expected = value.expectedConnection
  if (expected !== undefined) {
    if (!isRecord(expected)) return false
    if (typeof expected.baseUrl !== 'string' || expected.baseUrl.length > 2048) return false
    if (typeof expected.model !== 'string' || expected.model.length > 200) return false
    if (
      expected.requestOptionsKey !== undefined &&
      (typeof expected.requestOptionsKey !== 'string' ||
        expected.requestOptionsKey.length === 0 ||
        expected.requestOptionsKey.length > 20000)
    ) {
      return false
    }
  }
  return true
}

function isSetSiteAuto(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.origin === 'string' && value.origin.length <= 2048 && typeof value.enabled === 'boolean'
}

function isSetSiteExcluded(value: unknown): boolean {
  return isRecord(value) && typeof value.host === 'string' && value.host.length > 0 &&
    value.host.length <= 2048 && typeof value.excluded === 'boolean'
}

function isSetSiteScopeHost(value: unknown): boolean {
  return isRecord(value) && typeof value.host === 'string' && value.host.length > 0 &&
    value.host.length <= 2048 && typeof value.listed === 'boolean'
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

function isTranslateTexts(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return false
  let total = 0
  for (const item of value) {
    if (typeof item !== 'string' || item.length < 1 || item.length > 6000) return false
    total += item.length
    if (total > 6000) return false
  }
  return true
}

function isOptionalPageTarget(value: Record<string, unknown>): boolean {
  return (value.tabId === undefined && value.url === undefined) ||
    (typeof value.tabId === 'number' && Number.isSafeInteger(value.tabId) && value.tabId >= 0 &&
      typeof value.url === 'string' && value.url.length > 0 && value.url.length <= 8192 &&
      /^https?:\/\//.test(value.url))
}

export function isTranslationMessage(value: unknown): value is TranslationMessage {
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('wt:')) return false
  switch (value.type) {
    case 'wt:get-config':
    case 'wt:page-modes':
    case 'wt:clear-key':
    case 'wt:clear-cache':
    case 'wt:test':
      return true
    case 'wt:save-config':
      return isSaveConfig(value)
    case 'wt:set-site-auto':
      return isSetSiteAuto(value)
    case 'wt:set-site-excluded':
      return isSetSiteExcluded(value)
    case 'wt:set-site-scope-host':
      return isSetSiteScopeHost(value)
    case 'wt:translate':
      return (
        (value.mode === 'selection' || value.mode === 'auto') &&
        isTranslateTexts(value.texts) &&
        (value.requestId === undefined || isRequestId(value.requestId)) &&
        (value.page === undefined || isPageContext(value.page)) &&
        (value.pageId === undefined || isPageId(value.pageId)) &&
        (value.pageSession === undefined || isPageId(value.pageSession)) &&
        (value.manualSelectionId === undefined ||
          (value.mode === 'selection' && value.texts.length === 1 && isRequestId(value.manualSelectionId)))
      )
    case 'wt:page-action':
      return isPageAction(value.action) && isOptionalPageTarget(value)
    case 'wt:current-site-auto':
      return typeof value.enabled === 'boolean'
    case 'wt:current-page-controls':
      return value.action === 'status' || value.action === 'restore' || value.action === 'resume'
    case 'wt:open-options':
      return value.section === undefined || value.section === 'model'
    case 'wt:assist':
      return (
        isRequestId(value.requestId) &&
        isAssistInput(value.input) &&
        (value.page === undefined || isPageContext(value.page)) &&
        (value.pageId === undefined || isPageId(value.pageId)) &&
        (value.pageSession === undefined || isPageId(value.pageSession))
      )
    case 'wt:cancel-assist':
      return isRequestId(value.requestId)
    case 'wt:list-models':
      return (
        typeof value.baseUrl === 'string' &&
        value.baseUrl.length <= 2048 &&
        isOptionalApiKey(value.apiKey) &&
        (value.customHeaders === undefined || isValidCustomHeaders(value.customHeaders)) &&
        isRequestId(value.requestId)
      )
    case 'wt:cancel-models':
      return isRequestId(value.requestId)
    case 'wt:page-context':
      return isPageId(value.pageId) && isPageContext(value.page)
    case 'wt:translate-page':
      return isOptionalPageTarget(value)
    default:
      return false
  }
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || isBoundedString(value, max)
}

function isOptionalHttpUrl(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isContentTranslationMessage(value: unknown): value is ContentTranslationMessage {
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('wt:')) return false
  switch (value.type) {
    case 'wt:show-selection':
      return (
        isBoundedString(value.text, 6000) &&
        isOptionalBoundedString(value.error, 500) &&
        (value.manualSelectionId === undefined || isRequestId(value.manualSelectionId))
      )
    case 'wt:page-action':
      return isPageAction(value.action) && isOptionalHttpUrl(value.url)
    case 'wt:refresh':
    case 'wt:stop':
    case 'wt:status':
    case 'wt:read-selection':
      return true
    default:
      return false
  }
}

export function isPageTranslationStatus(value: unknown): value is PageTranslationStatus {
  return (
    isRecord(value) &&
    typeof value.supported === 'boolean' &&
    typeof value.fixed === 'boolean' &&
    typeof value.auto === 'boolean' &&
    typeof value.paused === 'boolean' &&
    typeof value.capped === 'boolean' &&
    (value.budgetCapped === undefined || typeof value.budgetCapped === 'boolean') &&
    Number.isSafeInteger(value.failed) &&
    (value.failed as number) >= 0 &&
    typeof value.error === 'string'
  )
}

function isConfigShape(value: unknown): value is TranslationConfig {
  if (!isRecord(value)) return false
  if ('apiKey' in value || 'customHeaders' in value) return false
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048) return false
  if (typeof value.model !== 'string' || value.model.length > 200) return false
  if (!isApiType(value.apiType)) return false
  if (!isTemperature(value.temperature)) return false
  if (!isValidRequestParams(value.requestParams)) return false
  if (!isCustomHeadersRevision(value.customHeadersRevision)) return false
  if (!Array.isArray(value.autoOrigins) || value.autoOrigins.length > 50) return false
  if (!value.autoOrigins.every((o) => typeof o === 'string' && o.length <= 2048)) return false
  return (
    isDisabledDictionaries(value.disabledDictionaries) &&
    isTargetLanguage(value.targetLanguage) &&
    isSourceLanguage(value.sourceLanguage) &&
    typeof value.selectionPopupEnabled === 'boolean' &&
    typeof value.selectionToolbarEnabled === 'boolean' &&
    typeof value.proactiveAssistEnabled === 'boolean' &&
    typeof value.floatingButtonEnabled === 'boolean' &&
    typeof value.autoInteractionEnabled === 'boolean' &&
    isExcludedHosts(value.excludedHosts) &&
    isSiteScopeMode(value.siteScopeMode) &&
    isExcludedHosts(value.siteScopeHosts)
  )
}

function isDisabledDictionaries(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= BUILTIN_DICTIONARY_META.length &&
    value.every((id) => typeof id === 'string' && BUILTIN_DICTIONARY_META.some((d) => d.id === id))
}

function isModes(value: unknown): value is PageModes {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    typeof value.fixed === 'boolean' &&
    typeof value.auto === 'boolean' &&
    typeof value.selection === 'boolean' &&
    typeof value.smart === 'boolean' &&
    (value.floating === undefined || typeof value.floating === 'boolean') &&
    (value.fixedEntries === undefined ||
      (isRecord(value.fixedEntries) &&
        Object.keys(value.fixedEntries).length <= MAX_FIXED_ENTRIES &&
        Object.values(value.fixedEntries).every((item) => typeof item === 'string' && item.length <= 400)))
  )
}

export function isTranslationReply<M extends TranslationMessage>(
  value: unknown,
  message: M,
): value is TranslationReply<M['type']>
export function isTranslationReply(value: unknown): value is TranslationReply
export function isTranslationReply(value: unknown, message?: TranslationMessage): value is TranslationReply {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) {
    return (
      typeof value.error === 'string' &&
      (value.code === undefined || isFailureCode(value.code)) &&
      (value.retryAfterMs === undefined ||
        (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0))
    )
  }
  if (value.texts !== undefined && (!Array.isArray(value.texts) || !value.texts.every((t) => typeof t === 'string')))
    return false
  if (value.models !== undefined && !isModelList(value.models)) return false
  if (
    value.cachedChars !== undefined &&
    (typeof value.cachedChars !== 'number' || !Number.isFinite(value.cachedChars) || value.cachedChars < 0)
  ) {
    return false
  }
  if (value.config !== undefined && !isConfigShape(value.config)) return false
  if (value.warning !== undefined && (typeof value.warning !== 'string' || value.warning.length > 500)) return false
  if (value.hasKey !== undefined && typeof value.hasKey !== 'boolean') return false
  if (
    value.keyState !== undefined &&
    !['none', 'ready', 'different-origin', 'legacy', 'unavailable'].includes(value.keyState as string)
  ) {
    return false
  }
  if (
    value.customHeadersState !== undefined &&
    !['none', 'ready', 'different-origin', 'unavailable'].includes(value.customHeadersState as string)
  ) {
    return false
  }
  if (value.modes !== undefined && !isModes(value.modes)) return false
  if (value.result !== undefined && parseAssistResult(value.result) === undefined) return false
  if (value.legacy !== undefined && !isLegacyState(value.legacy)) return false
  if (message === undefined) return true
  switch (message.type) {
    case 'wt:get-config':
    case 'wt:save-config':
    case 'wt:set-site-auto':
    case 'wt:set-site-excluded':
    case 'wt:set-site-scope-host':
      return isConfigShape(value.config)
    case 'wt:page-modes':
      return isModes(value.modes)
    case 'wt:assist':
      return parseAssistResult(value.result) !== undefined
    case 'wt:clear-key':
      return value.hasKey === false && (value.keyState === undefined || value.keyState === 'none')
    case 'wt:test':
      return (
        Array.isArray(value.texts) &&
        value.texts.length === 1 &&
        typeof value.texts[0] === 'string' &&
        value.texts[0].trim() !== ''
      )
    case 'wt:list-models':
      return isModelList(value.models)
    case 'wt:translate': {
      if (!Array.isArray(value.texts) || value.texts.length !== message.texts.length) return false
      const texts = value.texts as string[]
      if (
        message.mode === 'selection'
          ? texts.some((text) => text.trim() === '')
          : !texts.some((text) => text.trim() !== '')
      ) {
        return false
      }
      return (
        value.cachedChars === undefined ||
        (value.cachedChars as number) <= message.texts.reduce((sum, text) => sum + text.length, 0)
      )
    }
    case 'wt:clear-cache':
    case 'wt:page-action':
    case 'wt:cancel-assist':
    case 'wt:cancel-models':
    case 'wt:page-context':
    case 'wt:current-site-auto':
    case 'wt:open-options':
    case 'wt:translate-page':
      return true
    case 'wt:current-page-controls':
      return isLegacyState(value.legacy)
  }
}

function isLegacyState(value: unknown): value is GitHubPageState {
  return isGitHubPageState(value) && Object.keys(value).length === 2
}

export function isContentTranslationReply<M extends ContentTranslationMessage>(
  value: unknown,
  message: M,
): value is ContentTranslationReply<M['type']>
export function isContentTranslationReply(value: unknown): value is ContentTranslationReply
export function isContentTranslationReply(
  value: unknown,
  message?: ContentTranslationMessage,
): value is ContentTranslationReply {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return typeof value.error === 'string'
  if (message?.type === 'wt:status') return isPageTranslationStatus(value.status)
  if (message?.type === 'wt:read-selection') return typeof value.text === 'string'
  return (
    (value.status === undefined || isPageTranslationStatus(value.status)) &&
    (value.text === undefined || typeof value.text === 'string')
  )
}
