export type TargetLanguage = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'es' | 'fr' | 'de' | 'pt'

export type SourceLanguage = 'auto' | TargetLanguage

export const TARGET_LANGUAGES: readonly TargetLanguage[] = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt']

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && (TARGET_LANGUAGES as readonly string[]).includes(value)
}

export function isSourceLanguage(value: unknown): value is SourceLanguage {
  return value === 'auto' || isTargetLanguage(value)
}

export const TARGET_LANGUAGE_NATIVE_LABEL: Readonly<Record<TargetLanguage, string>> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
}

export const TARGET_LANGUAGE_PROMPT_NAME: Readonly<Record<TargetLanguage, string>> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese (Taiwan)',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
}

export function sourceLanguageInstruction(source: SourceLanguage = 'auto'): string {
  if (source === 'auto') return ''
  return `The source language is ${TARGET_LANGUAGE_PROMPT_NAME[source]}. Interpret the source text in that language; do not infer a different source language from isolated borrowed words or technical identifiers.`
}

const HAN = /[㐀-鿿]/
const KANA = /[぀-ヿㇰ-ㇿ]/
const HANGUL = /[가-힯ᄀ-ᇿꥠ-꥿]/
const NON_ASCII_LETTER = /(?=\p{L})[^ -~]/u

/** 文本是否已经像目标语言：zh-* → 含汉字；ja → 含假名；ko → 含谚文；en → 全部字符都是 ASCII 且不含 CJK/谚文/假名。 */
export function looksLikeTargetLanguage(text: string, language: TargetLanguage): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  switch (language) {
    case 'zh-CN':
    case 'zh-TW':
      return HAN.test(trimmed)
    case 'ja':
      return KANA.test(trimmed)
    case 'ko':
      return HANGUL.test(trimmed)
    case 'en':
      return !NON_ASCII_LETTER.test(trimmed) && !HAN.test(trimmed) && !KANA.test(trimmed) && !HANGUL.test(trimmed)
    case 'es':
    case 'fr':
    case 'de':
    case 'pt':
      return false
  }
}

/** 分段拼接时相邻处是否不留空格。 */
export function joinsWithoutSpaces(language: TargetLanguage): boolean {
  return language === 'zh-CN' || language === 'zh-TW' || language === 'ja'
}

const MAX_INPUT_DRAFT_LENGTH = 6000
const HAN_SCRIPT = /\p{Script=Han}/u
const LATIN_SCRIPT = /\p{Script=Latin}/u
const LETTER_CHAR = /\p{L}/u

/** 输入框草稿是否适合发起输入翻译。 */
export function isCandidateDraft(
  value: string,
  source: SourceLanguage = 'auto',
  target: TargetLanguage = 'en',
): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || value.length > MAX_INPUT_DRAFT_LENGTH) return false
  if (!LETTER_CHAR.test(trimmed)) return false
  if (source === 'auto') {
    return !looksLikeTargetLanguage(trimmed, target)
  }
  if (source === target) return false
  switch (source) {
    case 'zh-CN':
    case 'zh-TW':
      return HAN_SCRIPT.test(trimmed)
    case 'ja':
      return KANA.test(trimmed) || HAN_SCRIPT.test(trimmed)
    case 'ko':
      return HANGUL.test(trimmed)
    case 'en':
    case 'es':
    case 'fr':
    case 'de':
    case 'pt':
      return LATIN_SCRIPT.test(trimmed)
  }
}
