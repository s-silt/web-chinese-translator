import { storage } from 'wxt/utils/storage'
import { parseGitHubUrl } from './github'
import {
  isPageLocalePreference,
  isUiLanguagePreference,
  type PageLocalePreference,
  type UiLanguagePreference,
} from './locale'

/** 扩展界面外观：auto 跟随浏览器 */
export type ThemePreference = 'auto' | 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['auto', 'light', 'dark']

export function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value)
}

export type UiStyle = 'classic' | 'cyber' | 'glass'
export const UI_STYLES: readonly UiStyle[] = ['classic', 'cyber', 'glass']
export function isUiStyle(value: unknown): value is UiStyle {
  return (UI_STYLES as readonly unknown[]).includes(value)
}

export interface Settings {
  /** 总开关 */
  readonly enabled: boolean
  /** 时间本地化：<relative-time> 等元素改用中文格式 */
  readonly translateTime: boolean
  /** 翻译标签页标题 */
  readonly translateTitle: boolean
  /**
   * 排除路径。以 / 开头；* 匹配单段，** 匹配任意多段；
   * 命中路径本身及其下级路径。例：/settings、/*\/*\/wiki
   */
  readonly excludedPaths: readonly string[]
  /** 页面翻译语言（简体 / 繁体）；auto 按浏览器语言 */
  readonly language: PageLocalePreference
  /** 扩展界面语言；auto 按浏览器界面语言 */
  readonly uiLanguage: UiLanguagePreference
  /** 扩展界面外观；auto 跟随浏览器 */
  readonly theme: ThemePreference
  /** 扩展界面风格；cyber 固定深色 */
  readonly uiStyle: UiStyle
}

/**
 * 自定义词条：原文 → 译文，优先于内置词条与正则。
 * 内置属性规则命中的属性、内置行内句整句命中的句子不再查词典，自定义词条对它们不生效
 */
export type CustomEntries = Readonly<Record<string, string>>

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  translateTime: true,
  translateTitle: true,
  excludedPaths: [],
  language: 'auto',
  uiLanguage: 'auto',
  theme: 'auto',
  uiStyle: 'classic',
}

/**
 * 已删除的设置项，写入时固定为下列值（读取时忽略）。
 * collectUntranslated：旧版本的「收集未翻译」开关。设置随浏览器账号同步，未更新的旧版本读不到时按开启处理
 */
export const LEGACY_SETTING_VALUES = { collectUntranslated: false } as const

export const settingsItem = storage.defineItem<Partial<Settings>>('sync:settings', {
  fallback: DEFAULT_SETTINGS,
})

export const customEntriesItem = storage.defineItem<CustomEntries>('local:customEntries', {
  fallback: {},
})

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 合并存储值与默认值，丢弃类型不符的字段与未知字段 */
export function mergeSettings(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SETTINGS
  const value = stored as Record<string, unknown>
  const pickBoolean = (key: keyof Settings, fallback: boolean): boolean =>
    typeof value[key] === 'boolean' ? (value[key] as boolean) : fallback
  return {
    enabled: pickBoolean('enabled', DEFAULT_SETTINGS.enabled),
    translateTime: pickBoolean('translateTime', DEFAULT_SETTINGS.translateTime),
    translateTitle: pickBoolean('translateTitle', DEFAULT_SETTINGS.translateTitle),
    excludedPaths: isStringArray(value.excludedPaths) ? value.excludedPaths : DEFAULT_SETTINGS.excludedPaths,
    language: isPageLocalePreference(value.language) ? value.language : DEFAULT_SETTINGS.language,
    uiLanguage: isUiLanguagePreference(value.uiLanguage) ? value.uiLanguage : DEFAULT_SETTINGS.uiLanguage,
    theme: isThemePreference(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
    uiStyle: isUiStyle(value.uiStyle) ? value.uiStyle : DEFAULT_SETTINGS.uiStyle,
  }
}

/** 过滤非字符串、空键空值 */
export function sanitizeCustomEntries(stored: unknown): CustomEntries {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  const entries = Object.entries(stored as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[0].trim() !== '' && entry[1].trim() !== '',
  )
  return Object.fromEntries(entries)
}

export async function getSettings(): Promise<Settings> {
  return mergeSettings(await settingsItem.getValue())
}

/** 合并写入；已删除的设置项一并写入固定值（见 LEGACY_SETTING_VALUES） */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await settingsItem.setValue({ ...next, ...LEGACY_SETTING_VALUES })
  return next
}

export function watchSettings(callback: (settings: Settings) => void): () => void {
  return settingsItem.watch((value) => callback(mergeSettings(value)))
}

export async function getCustomEntries(): Promise<CustomEntries> {
  return sanitizeCustomEntries(await customEntriesItem.getValue())
}

export function watchCustomEntries(callback: (entries: CustomEntries) => void): () => void {
  return customEntriesItem.watch((value) => callback(sanitizeCustomEntries(value)))
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/\/+$/, '')
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === '**') return '.*'
      if (part === '*') return '[^/]*'
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${source}(?:/.*)?$`, 'i')
}

/** 第一条命中路径的排除规则（去首尾空白后的原文）；未命中返回 undefined */
export function matchExcludedPath(pathname: string, patterns: readonly string[]): string | undefined {
  return patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.startsWith('/'))
    .find((pattern) => globToRegExp(pattern).test(pathname))
}

/** 路径是否被排除规则命中 */
export function isPathExcluded(pathname: string, patterns: readonly string[]): boolean {
  return matchExcludedPath(pathname, patterns) !== undefined
}

/** 排除规则测试框的输入 → 待判断的路径（不含查询与片段）；无法识别返回 undefined */
export function excludedPathProbe(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  // 以 / 开头按路径处理：//x 仍是路径，查询、片段去掉，空格等按浏览器规则编码，与 location.pathname 一致
  if (trimmed.startsWith('/')) return new URL(`https://github.com${trimmed}`).pathname
  if (/^https?:\/\//i.test(trimmed)) return parseGitHubUrl(trimmed)?.pathname
  return undefined
}

/** 值为布尔的设置项 */
export type BooleanSettingKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]

/** 写入自定义词条（先过滤无效项），返回实际写入的值 */
export async function setCustomEntries(entries: CustomEntries): Promise<CustomEntries> {
  const next = sanitizeCustomEntries(entries)
  await customEntriesItem.setValue(next)
  return next
}

export interface ParsedExcludedPaths {
  /** 去重后的规则 */
  readonly paths: readonly string[]
  /** 不以 / 开头的行 */
  readonly invalid: readonly string[]
}

/** 解析排除路径文本：每行一条，忽略空行与首尾空白 */
export function parseExcludedPaths(text: string): ParsedExcludedPaths {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return {
    paths: [...new Set(lines.filter((line) => line.startsWith('/')))],
    invalid: lines.filter((line) => !line.startsWith('/')),
  }
}

/** 根路径 / 作为规则会命中全部页面，不能单独排除 */
export function canExcludePath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') !== ''
}

/** 把页面路径加入排除规则；已命中或不可排除时原样返回 */
export function addExcludedPath(patterns: readonly string[], pathname: string): readonly string[] {
  if (!canExcludePath(pathname) || isPathExcluded(pathname, patterns)) return patterns
  return [...patterns, pathname.replace(/\/+$/, '')]
}

/** 移除所有命中页面路径的排除规则 */
export function removeExcludedPath(patterns: readonly string[], pathname: string): readonly string[] {
  return patterns.filter((pattern) => !isPathExcluded(pathname, [pattern]))
}
