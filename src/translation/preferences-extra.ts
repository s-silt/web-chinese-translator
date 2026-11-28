import type { TranslationModelConfig } from './config'
import { isApiType, isTemperature, requestOptionsCacheKey, type ApiType } from './request-options'

export type TranslationDisplayMode = 'replace' | 'bilingual'
export const DEFAULT_DISPLAY_MODE: TranslationDisplayMode = 'replace'

export type TranslationStyle = 'natural' | 'technical' | 'academic' | 'concise'
export const DEFAULT_TRANSLATION_STYLE: TranslationStyle = 'natural'

export const TRANSLATION_STYLES: readonly TranslationStyle[] = ['natural', 'technical', 'academic', 'concise'] as const
export const DISPLAY_MODES: readonly TranslationDisplayMode[] = ['replace', 'bilingual'] as const

export interface PromptGlossaryEntry {
  readonly source: string
  readonly target: string
}

export interface ModelProfile {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly model: string
  readonly apiType: ApiType
  readonly temperature: number | null
}

export const MAX_PROMPT_GLOSSARY = 200
export const MAX_GLOSSARY_TERM_LENGTH = 120
export const MAX_MODEL_PROFILES = 20
export const MAX_PROFILE_NAME_LENGTH = 60
export const MAX_PROFILE_ID_LENGTH = 64

export function isDisplayMode(value: unknown): value is TranslationDisplayMode {
  return value === 'replace' || value === 'bilingual'
}

export function isTranslationStyle(value: unknown): value is TranslationStyle {
  return value === 'natural' || value === 'technical' || value === 'academic' || value === 'concise'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sanitizePromptGlossary(value: unknown): PromptGlossaryEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: PromptGlossaryEntry[] = []
  for (const item of value) {
    if (!isPlainRecord(item)) continue
    if (typeof item.source !== 'string' || typeof item.target !== 'string') continue
    const source = item.source.trim().slice(0, MAX_GLOSSARY_TERM_LENGTH)
    const target = item.target.trim().slice(0, MAX_GLOSSARY_TERM_LENGTH)
    if (source === '' || target === '') continue
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ source, target })
    if (result.length >= MAX_PROMPT_GLOSSARY) break
  }
  return result
}

export function isPromptGlossaryList(value: unknown): value is PromptGlossaryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_PROMPT_GLOSSARY) return false
  return value.every(
    (item) =>
      isPlainRecord(item) &&
      typeof item.source === 'string' &&
      typeof item.target === 'string' &&
      item.source.trim().length > 0 &&
      item.source.trim().length <= MAX_GLOSSARY_TERM_LENGTH &&
      item.target.trim().length > 0 &&
      item.target.trim().length <= MAX_GLOSSARY_TERM_LENGTH,
  )
}

export function sanitizeModelProfiles(
  value: unknown,
  normalizeBaseUrl: (url: string) => string,
  clampModel: (model: string) => string,
): ModelProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: ModelProfile[] = []
  for (const item of value) {
    if (!isPlainRecord(item)) continue
    if (typeof item.id !== 'string' || typeof item.name !== 'string') continue
    const id = item.id.trim().slice(0, MAX_PROFILE_ID_LENGTH)
    const name = item.name.trim().slice(0, MAX_PROFILE_NAME_LENGTH)
    const baseUrl = typeof item.baseUrl === 'string' ? normalizeBaseUrl(item.baseUrl) : ''
    const model = typeof item.model === 'string' ? clampModel(item.model) : ''
    if (id === '' || name === '' || baseUrl === '' || model === '' || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      name,
      baseUrl,
      model,
      apiType: isApiType(item.apiType) ? item.apiType : 'chat-completions',
      temperature: isTemperature(item.temperature) ? item.temperature : null,
    })
    if (result.length >= MAX_MODEL_PROFILES) break
  }
  return result
}

export function isModelProfileList(value: unknown): value is ModelProfile[] {
  if (!Array.isArray(value) || value.length > MAX_MODEL_PROFILES) return false
  return value.every(
    (item) =>
      isPlainRecord(item) &&
      typeof item.id === 'string' &&
      item.id.trim().length > 0 &&
      item.id.trim().length <= MAX_PROFILE_ID_LENGTH &&
      typeof item.name === 'string' &&
      item.name.trim().length > 0 &&
      item.name.trim().length <= MAX_PROFILE_NAME_LENGTH &&
      typeof item.baseUrl === 'string' &&
      typeof item.model === 'string' &&
      (item.apiType === undefined || isApiType(item.apiType)) &&
      (item.temperature === undefined || item.temperature === null || isTemperature(item.temperature)),
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 仅返回当前待译文本里实际命中的术语条目，避免将整份术语表无意义注入每次请求。 */
export function findMatchedGlossaryEntries(
  entries: readonly PromptGlossaryEntry[] | undefined,
  texts: readonly string[],
  limit = 40,
): PromptGlossaryEntry[] {
  if (!entries || entries.length === 0 || texts.length === 0) return []
  const combined = texts.join('\n')
  const matched: PromptGlossaryEntry[] = []
  for (const entry of entries) {
    const isAsciiWord = /^[A-Za-z0-9_-]+$/.test(entry.source)
    const pattern = isAsciiWord
      ? new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(entry.source)}(?![A-Za-z0-9_-])`, 'i')
      : new RegExp(escapeRegExp(entry.source), 'i')
    if (pattern.test(combined)) {
      matched.push(entry)
      if (matched.length >= limit) break
    }
  }
  return matched
}

/** 计算术语表确定性签名，用于区分缓存与检测配置变更。 */
export function glossarySignature(entries: readonly PromptGlossaryEntry[] | undefined): string {
  if (!entries || entries.length === 0) return ''
  return JSON.stringify(entries.map(item => JSON.stringify([item.source.toLowerCase(), item.target])).sort())
}

export function translationOptionsCacheKey(config: TranslationModelConfig): Promise<string> {
  const style = config.translationStyle ?? DEFAULT_TRANSLATION_STYLE
  const glossary = glossarySignature(config.promptGlossary)
  const extra = style === DEFAULT_TRANSLATION_STYLE && glossary === '' ? undefined : [style, glossary]
  return requestOptionsCacheKey(config, extra)
}
