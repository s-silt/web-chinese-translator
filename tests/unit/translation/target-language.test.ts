import { describe, expect, it } from 'vitest'
import {
  isCandidateDraft,
  isTargetLanguage,
  joinsWithoutSpaces,
  looksLikeTargetLanguage,
  TARGET_LANGUAGES,
} from '../../../src/translation/target-language'

describe('isTargetLanguage', () => {
  it('接受枚举值、拒绝其他', () => {
    for (const lang of TARGET_LANGUAGES) expect(isTargetLanguage(lang)).toBe(true)
    expect(isTargetLanguage('xx')).toBe(false)
    expect(isTargetLanguage('auto')).toBe(false)
    expect(isTargetLanguage(1)).toBe(false)
  })
})

describe('looksLikeTargetLanguage', () => {
  it('en：只看字母，标点/弯引号/破折号不判为非英文', () => {
    expect(looksLikeTargetLanguage('Don’t have an account?', 'en')).toBe(true)
    expect(looksLikeTargetLanguage('Paramètres', 'en')).toBe(false)
    expect(looksLikeTargetLanguage('设置', 'en')).toBe(false)
  })

  it('ja/ko/zh 各看本族文字', () => {
    expect(looksLikeTargetLanguage('こんにちは', 'ja')).toBe(true)
    expect(looksLikeTargetLanguage('設定', 'ja')).toBe(false)
    expect(looksLikeTargetLanguage('안녕', 'ko')).toBe(true)
    expect(looksLikeTargetLanguage('你好', 'zh-CN')).toBe(true)
    expect(looksLikeTargetLanguage('你好', 'en')).toBe(false)
  })

  it('es/fr/de/pt 不能只凭 ASCII 判定', () => {
    for (const language of ['es', 'fr', 'de', 'pt'] as const) {
      expect(looksLikeTargetLanguage('Hello', language)).toBe(false)
      expect(looksLikeTargetLanguage('Bonjour', language)).toBe(false)
      expect(joinsWithoutSpaces(language)).toBe(false)
    }
  })
})

describe('joinsWithoutSpaces', () => {
  it('zh/ja 贴合拼接、en/ko 保留分隔', () => {
    expect(joinsWithoutSpaces('zh-CN')).toBe(true)
    expect(joinsWithoutSpaces('zh-TW')).toBe(true)
    expect(joinsWithoutSpaces('ja')).toBe(true)
    expect(joinsWithoutSpaces('en')).toBe(false)
    expect(joinsWithoutSpaces('ko')).toBe(false)
  })
})

describe('isCandidateDraft', () => {
  it('拒绝空白、无字母或超过 6000 字符的草稿', () => {
    expect(isCandidateDraft('', 'auto', 'en')).toBe(false)
    expect(isCandidateDraft('   \n  ', 'auto', 'en')).toBe(false)
    expect(isCandidateDraft('12345 !@#', 'auto', 'en')).toBe(false)
    expect(isCandidateDraft('好'.repeat(6001), 'auto', 'en')).toBe(false)
    expect(isCandidateDraft('好'.repeat(6000), 'auto', 'en')).toBe(true)
  })

  it('source=auto：已是目标语言时跳过，其他语言作为候选（含英文→中文、日文→英文、中文→英文）', () => {
    expect(isCandidateDraft('你好世界', 'auto', 'en')).toBe(true)
    expect(isCandidateDraft('Purely English message', 'auto', 'en')).toBe(false)
    expect(isCandidateDraft('Hello world', 'auto', 'zh-CN')).toBe(true)
    expect(isCandidateDraft('你好世界', 'auto', 'zh-CN')).toBe(false)
    expect(isCandidateDraft('こんにちは', 'auto', 'en')).toBe(true)
    expect(isCandidateDraft('こんにちは', 'auto', 'ja')).toBe(false)
    expect(isCandidateDraft('안녕하세요', 'auto', 'ko')).toBe(false)
    expect(isCandidateDraft('안녕하세요', 'auto', 'zh-CN')).toBe(true)
    expect(isCandidateDraft('Hello', 'auto', 'es')).toBe(true)
  })

  it('指定源语言：按语系文字匹配，且 source === target 时一律返回 false', () => {
    expect(isCandidateDraft('你好', 'zh-CN', 'en')).toBe(true)
    expect(isCandidateDraft('Hello', 'zh-CN', 'en')).toBe(false)
    expect(isCandidateDraft('你好', 'zh-CN', 'zh-TW')).toBe(true)
    expect(isCandidateDraft('你好', 'zh-CN', 'zh-CN')).toBe(false)

    expect(isCandidateDraft('こんにちは', 'ja', 'en')).toBe(true)
    expect(isCandidateDraft('東京', 'ja', 'en')).toBe(true)
    expect(isCandidateDraft('Hello', 'ja', 'en')).toBe(false)
    expect(isCandidateDraft('こんにちは', 'ja', 'ja')).toBe(false)

    expect(isCandidateDraft('안녕하세요', 'ko', 'en')).toBe(true)
    expect(isCandidateDraft('你好', 'ko', 'en')).toBe(false)
    expect(isCandidateDraft('안녕하세요', 'ko', 'ko')).toBe(false)

    expect(isCandidateDraft('Hello world', 'en', 'zh-CN')).toBe(true)
    expect(isCandidateDraft('Bonjour', 'fr', 'en')).toBe(true)
    expect(isCandidateDraft('你好', 'en', 'zh-CN')).toBe(false)
    expect(isCandidateDraft('Hello', 'en', 'en')).toBe(false)
  })
})
