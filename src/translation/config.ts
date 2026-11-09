import { storage } from 'wxt/utils/storage'
import { BUILTIN_DICTIONARY_META } from './dictionaries/index'
import { DEFAULT_INPUT_REPLACE_KEY, normalizeHotkey } from './input-hotkey'
import { isSourceLanguage, isTargetLanguage, type SourceLanguage, type TargetLanguage } from './target-language'
import { sanitizeExcludedHosts } from './page-policy'
import {
  isApiType,
  isTemperature,
  normalizeRequestParams,
  type ApiType,
  type JsonObject,
  type RequestOptions,
} from './request-options'
import { isSiteScopeMode, type SiteScopeMode } from './site-scope'

export type InputReplaceMode = 'hotkey' | 'auto'

export function isInputReplaceMode(value: unknown): value is InputReplaceMode {
  return value === 'hotkey' || value === 'auto'
}

export const INPUT_AUTO_REPLACE_DELAY_MIN = 500
export const INPUT_AUTO_REPLACE_DELAY_MAX = 10_000
export const INPUT_AUTO_REPLACE_DELAY_DEFAULT = 1000
export const INPUT_AUTO_REPLACE_DELAY_PRESETS = [1000, 2000, 3000, 5000] as const

export function isInputAutoReplaceDelay(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= INPUT_AUTO_REPLACE_DELAY_MIN &&
    value <= INPUT_AUTO_REPLACE_DELAY_MAX &&
    value % 100 === 0
  )
}

export interface TranslationConfig {
  readonly baseUrl: string
  readonly model: string
  readonly apiType: ApiType
  readonly temperature: number | null
  readonly requestParams: JsonObject
  readonly customHeadersRevision: string
  readonly autoOrigins: readonly string[]
  readonly disabledDictionaries: readonly string[]
  readonly targetLanguage: TargetLanguage
  readonly inputTargetLanguage: TargetLanguage
  readonly inputSourceLanguage: SourceLanguage
  readonly inputReplaceKey: string
  readonly inputReplaceMode: InputReplaceMode
  readonly inputAutoReplaceDelayMs: number
  readonly sourceLanguage: SourceLanguage
  readonly selectionPopupEnabled: boolean
  readonly selectionToolbarEnabled: boolean
  readonly proactiveAssistEnabled: boolean
  readonly floatingButtonEnabled: boolean
  readonly autoInteractionEnabled: boolean
  readonly videoSubtitlesEnabled: boolean
  readonly inputTranslationEnabled: boolean
  /** 模型翻译单页字符上限；0 为不限 */
  readonly pageCharLimit: number
  readonly excludedHosts: readonly string[]
  readonly siteScopeMode: SiteScopeMode
  readonly siteScopeHosts: readonly string[]
}

/** 单页字符上限的可选档位（0 为不限）。旧版固定 20000，长文常在中途停住 */
export const PAGE_CHAR_LIMITS = [20_000, 50_000, 100_000, 200_000, 0] as const
export const DEFAULT_PAGE_CHAR_LIMIT = 50_000

export function isPageCharLimit(value: unknown): value is number {
  return typeof value === 'number' && (PAGE_CHAR_LIMITS as readonly number[]).includes(value)
}

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  baseUrl: '',
  model: '',
  apiType: 'chat-completions',
  temperature: null,
  requestParams: {},
  customHeadersRevision: '',
  autoOrigins: [],
  disabledDictionaries: [],
  targetLanguage: 'zh-CN',
  inputTargetLanguage: 'en',
  inputSourceLanguage: 'auto',
  inputReplaceKey: DEFAULT_INPUT_REPLACE_KEY,
  inputReplaceMode: 'hotkey',
  inputAutoReplaceDelayMs: INPUT_AUTO_REPLACE_DELAY_DEFAULT,
  sourceLanguage: 'auto',
  selectionPopupEnabled: false,
  selectionToolbarEnabled: false,
  proactiveAssistEnabled: false,
  floatingButtonEnabled: true,
  autoInteractionEnabled: true,
  videoSubtitlesEnabled: false,
  inputTranslationEnabled: false,
  pageCharLimit: DEFAULT_PAGE_CHAR_LIMIT,
  excludedHosts: [],
  siteScopeMode: 'all',
  siteScopeHosts: [],
}

export type CompletionConfig = Pick<TranslationConfig, 'baseUrl' | 'model'> & RequestOptions & {
  readonly customHeaders?: Readonly<Record<string, string>>
}

export type TranslationModelConfig = CompletionConfig &
  Pick<TranslationConfig, 'targetLanguage'> &
  Partial<Pick<TranslationConfig, 'sourceLanguage'>>

export const translationConfigItem = storage.defineItem<TranslationConfig>('local:translationConfig', {
  fallback: DEFAULT_TRANSLATION_CONFIG,
})

const MAX_URL_LENGTH = 2048
const MAX_MODEL_LENGTH = 200
const MAX_AUTO_ORIGINS = 50
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

export function normalizeOrigin(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return ''
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (url.username !== '' || url.password !== '') return ''
  if (url.origin.length > MAX_URL_LENGTH) return ''
  return url.origin
}

function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
}

function isAllowedBase(url: URL): boolean {
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH || !hasScheme(trimmed)) return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return ''
  }
  if (!isAllowedBase(url)) return ''
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return ''
  const path = url.pathname.replace(/\/+$/, '')
  const normalized = path === '' ? url.origin : url.origin + path
  if (normalized.length > MAX_URL_LENGTH) return ''
  return normalized
}

export function hostPermissionPattern(value: string): string {
  const url = new URL(value)
  return `${url.protocol}//${url.hostname}/*`
}

export function completionUrl(value: string, apiType: ApiType = 'chat-completions'): string {
  const base = normalizeBaseUrl(value)
  if (base === '') return ''
  const suffix = apiType === 'responses' ? '/responses' : '/chat/completions'
  if (base.endsWith('/chat/completions')) return base.slice(0, -'/chat/completions'.length) + suffix
  if (base.endsWith('/responses')) return base.slice(0, -'/responses'.length) + suffix
  return new URL(base).pathname === '/' ? `${base}/v1${suffix}` : `${base}${suffix}`
}

export const MAX_DISCOVERED_MODELS = 2000

export function modelsUrl(value: string): string {
  const url = completionUrl(value, 'chat-completions')
  return url === '' ? '' : url.slice(0, -'/chat/completions'.length) + '/models'
}

export function isModelId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_LENGTH || value.trim() !== value) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return false
  }
  return true
}

export function isModelList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_DISCOVERED_MODELS &&
    value.every(isModelId) && new Set(value).size === value.length
}

function clampModel(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= MAX_MODEL_LENGTH) return trimmed
  return trimmed.slice(0, MAX_MODEL_LENGTH)
}

function sanitizeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const origins: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const origin = normalizeOrigin(item)
    if (origin === '' || seen.has(origin)) continue
    seen.add(origin)
    origins.push(origin)
    if (origins.length >= MAX_AUTO_ORIGINS) break
  }
  return origins
}

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_DICTIONARY_META.map((d) => d.id))

/** 迁移旧 devinEnabled/cursorEnabled 开关；未知 id 过滤、去重。 */
function sanitizeDisabledDictionaries(value: Record<string, unknown>): string[] {
  const disabled = new Set<string>()
  if (Array.isArray(value.disabledDictionaries)) {
    for (const item of value.disabledDictionaries) {
      if (typeof item === 'string' && BUILTIN_IDS.has(item)) disabled.add(item)
    }
  }
  if (value.devinEnabled === false) disabled.add('devin')
  if (value.cursorEnabled === false) disabled.add('cursor')
  return [...disabled]
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function sanitizeRequestParams(value: unknown): JsonObject {
  try {
    return normalizeRequestParams(value)
  } catch {
    return {}
  }
}

function sanitizeCustomHeadersRevision(value: unknown): string {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : ''
}

export function sanitizeTranslationConfig(value: unknown): TranslationConfig {
  if (!isConfigRecord(value)) return DEFAULT_TRANSLATION_CONFIG
  const selectionOn = value.selectionPopupEnabled === true
  const toolbarOn = selectionOn && value.selectionToolbarEnabled === true
  return {
    baseUrl: typeof value.baseUrl === 'string' ? normalizeBaseUrl(value.baseUrl) : '',
    model: typeof value.model === 'string' ? clampModel(value.model) : '',
    apiType: isApiType(value.apiType) ? value.apiType : 'chat-completions',
    temperature: isTemperature(value.temperature) ? value.temperature : null,
    requestParams: sanitizeRequestParams(value.requestParams),
    customHeadersRevision: sanitizeCustomHeadersRevision(value.customHeadersRevision),
    autoOrigins: sanitizeOrigins(value.autoOrigins),
    disabledDictionaries: sanitizeDisabledDictionaries(value),
    targetLanguage: isTargetLanguage(value.targetLanguage) ? value.targetLanguage : 'zh-CN',
    inputTargetLanguage: isTargetLanguage(value.inputTargetLanguage) ? value.inputTargetLanguage : 'en',
    inputSourceLanguage: isSourceLanguage(value.inputSourceLanguage) ? value.inputSourceLanguage : 'auto',
    inputReplaceKey:
      typeof value.inputReplaceKey === 'string'
        ? normalizeHotkey(value.inputReplaceKey) ?? DEFAULT_INPUT_REPLACE_KEY
        : DEFAULT_INPUT_REPLACE_KEY,
    inputReplaceMode: isInputReplaceMode(value.inputReplaceMode) ? value.inputReplaceMode : 'hotkey',
    inputAutoReplaceDelayMs: isInputAutoReplaceDelay(value.inputAutoReplaceDelayMs)
      ? value.inputAutoReplaceDelayMs
      : INPUT_AUTO_REPLACE_DELAY_DEFAULT,
    sourceLanguage: isSourceLanguage(value.sourceLanguage) ? value.sourceLanguage : 'auto',
    selectionPopupEnabled: selectionOn,
    selectionToolbarEnabled: toolbarOn,
    proactiveAssistEnabled: selectionOn && !toolbarOn && value.proactiveAssistEnabled === true,
    floatingButtonEnabled: value.floatingButtonEnabled !== false,
    autoInteractionEnabled: value.autoInteractionEnabled !== false,
    videoSubtitlesEnabled: value.videoSubtitlesEnabled === true,
    inputTranslationEnabled: value.inputTranslationEnabled === true,
    pageCharLimit: isPageCharLimit(value.pageCharLimit) ? value.pageCharLimit : DEFAULT_PAGE_CHAR_LIMIT,
    excludedHosts: sanitizeExcludedHosts(value.excludedHosts),
    siteScopeMode: isSiteScopeMode(value.siteScopeMode) ? value.siteScopeMode : 'all',
    siteScopeHosts: sanitizeExcludedHosts(value.siteScopeHosts),
  }
}

export async function getTranslationConfig(): Promise<TranslationConfig> {
  return sanitizeTranslationConfig(await translationConfigItem.getValue())
}

let updateQueue: Promise<void> = Promise.resolve()

export function updateTranslationConfig(patch: Partial<TranslationConfig>): Promise<TranslationConfig> {
  const pending = updateQueue.then(async () => {
    const current = await getTranslationConfig()
    const next = sanitizeTranslationConfig({ ...current, ...patch })
    await translationConfigItem.setValue(next)
    return next
  })
  updateQueue = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

export function watchTranslationConfig(
  callback: (config: TranslationConfig, previous: TranslationConfig) => void,
): () => void {
  return translationConfigItem.watch((value, previous) => {
    callback(sanitizeTranslationConfig(value), sanitizeTranslationConfig(previous))
  })
}
