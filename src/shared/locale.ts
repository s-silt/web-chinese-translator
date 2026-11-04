/**
 * 语言：页面翻译语言（简体、繁体词典）与扩展界面语言（简体、繁体、英文）。
 * 设置为「自动」时按浏览器识别：页面翻译语言看浏览器语言列表里的第一个中文，界面语言看浏览器界面语言。
 */

/** 页面翻译语言 */
export const PAGE_LOCALES = ['zh-CN', 'zh-TW'] as const
export type PageLocale = (typeof PAGE_LOCALES)[number]

/** 扩展界面语言 */
export const UI_LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]

/** 语言设置：auto 按浏览器识别 */
export type PageLocalePreference = 'auto' | PageLocale
export type UiLanguagePreference = 'auto' | UiLanguage

export const PAGE_LOCALE_PREFERENCES: readonly PageLocalePreference[] = ['auto', ...PAGE_LOCALES]
export const UI_LANGUAGE_PREFERENCES: readonly UiLanguagePreference[] = ['auto', ...UI_LANGUAGES]

/** 语言名称：各用本语言书写 */
export const LANGUAGE_NAMES: Readonly<Record<UiLanguage, string>> = {
  ja: '日本語',
  ko: '한국어',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
}

/** 浏览器语言里没有中文时，这些时区（台北、香港、澳门）按繁体 */
const TRADITIONAL_TIME_ZONES: ReadonlySet<string> = new Set(['Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Macau'])
/** 默认繁体的地区 */
const TRADITIONAL_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo'])

/**
 * 中文语言标签的简繁：书写体系 Hant / Hans 优先，其次看地区（台湾、香港、澳门为繁体），其余中文为简体；
 * 粤语（yue）默认繁体。不是中文返回 undefined。
 * 扩展、私用子标签（-u-nu-hant、-x-tw 等，从第一个单字符子标签起）不参与判断
 */
export function chineseScript(tag: string): PageLocale | undefined {
  const parts = tag.trim().toLowerCase().replaceAll('_', '-').split('-')
  const singleton = parts.findIndex((part, index) => index > 0 && part.length === 1)
  const [language = '', ...subtags] = singleton === -1 ? parts : parts.slice(0, singleton)
  if (language !== 'zh' && language !== 'yue') return undefined
  if (subtags.includes('hant')) return 'zh-TW'
  if (subtags.includes('hans')) return 'zh-CN'
  if (language === 'yue' || subtags.some((subtag) => TRADITIONAL_REGIONS.has(subtag))) return 'zh-TW'
  return 'zh-CN'
}

/** 页面翻译语言：语言列表里第一个中文决定简繁；没有中文时按时区，其余为简体 */
export function detectPageLocale(languages: readonly string[], timeZone?: string): PageLocale {
  for (const tag of languages) {
    const script = chineseScript(tag)
    if (script) return script
  }
  return timeZone !== undefined && TRADITIONAL_TIME_ZONES.has(timeZone) ? 'zh-TW' : 'zh-CN'
}

/** 界面语言：中文按简繁，其他语言用英文 */
export function detectUiLanguage(language: string | undefined): UiLanguage {
  const chinese = language === undefined ? undefined : chineseScript(language)
  if (chinese !== undefined) return chinese
  const base = language?.trim().toLowerCase().replaceAll('_', '-').split('-')[0]
  return base === 'ja' || base === 'ko' ? base : 'en'
}

/** 运行环境中的浏览器语言信息 */
export interface LanguageEnvironment {
  /** 浏览器语言列表（偏好顺序，即 navigator.languages） */
  readonly languages: readonly string[]
  /** 浏览器界面语言 */
  readonly uiLanguage?: string
  /** IANA 时区 */
  readonly timeZone?: string
}

/** 页面翻译语言：手动选择优先；自动时先看语言列表，再看浏览器界面语言、时区 */
export function resolvePageLocale(preference: PageLocalePreference, env: LanguageEnvironment): PageLocale {
  if (preference !== 'auto') return preference
  const languages = env.uiLanguage === undefined ? env.languages : [...env.languages, env.uiLanguage]
  return detectPageLocale(languages, env.timeZone)
}

/** 界面语言：手动选择优先；自动时按浏览器界面语言，读不到时按语言列表的第一项 */
export function resolveUiLanguage(preference: UiLanguagePreference, env: LanguageEnvironment): UiLanguage {
  if (preference !== 'auto') return preference
  return detectUiLanguage(env.uiLanguage ?? env.languages[0])
}

export function isPageLocale(value: unknown): value is PageLocale {
  return (PAGE_LOCALES as readonly unknown[]).includes(value)
}

export function isPageLocalePreference(value: unknown): value is PageLocalePreference {
  return value === 'auto' || isPageLocale(value)
}

export function isUiLanguagePreference(value: unknown): value is UiLanguagePreference {
  return value === 'auto' || (UI_LANGUAGES as readonly unknown[]).includes(value)
}
