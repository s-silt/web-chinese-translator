import { describe, expect, it } from 'vitest'
import {
  isTargetLanguage,
  joinsWithoutSpaces,
  looksLikeTargetLanguage,
  TARGET_LANGUAGES,
} from '../../../src/translation/target-language'

describe('isTargetLanguage', () => {
  it('接受枚举值、拒绝其他', () => {
    for (const lang of TARGET_LANGUAGES) expect(isTargetLanguage(lang)).toBe(true)
    expect(isTargetLanguage('fr')).toBe(false)
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
