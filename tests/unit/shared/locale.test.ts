import { describe, expect, it } from 'vitest'
import {
  chineseScript,
  detectPageLocale,
  detectUiLanguage,
  isPageLocalePreference,
  isUiLanguagePreference,
  resolvePageLocale,
  resolveUiLanguage,
} from '../../../src/shared/locale'

describe('chineseScript', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh_CN', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-MO', 'zh-TW'],
    ['zh_TW', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['zh-Hant-CN', 'zh-TW'],
    ['ZH-hant', 'zh-TW'],
    // 书写体系优先于地区
    ['zh-Hans-HK', 'zh-CN'],
    ['zh-Hans-TW', 'zh-CN'],
    ['yue', 'zh-TW'],
    ['yue-Hans-CN', 'zh-CN'],
    // 扩展、私用子标签不参与判断
    ['zh-TW-u-nu-hans', 'zh-TW'],
    ['zh-CN-u-nu-hant', 'zh-CN'],
    ['zh-x-tw', 'zh-CN'],
    ['zh-Hans-t-zh-hant', 'zh-CN'],
    ['zh-TW-t-zh-hans', 'zh-TW'],
    ['zh-cmn-Hant', 'zh-TW'],
  ] as const)('%s → %s', (tag, script) => {
    expect(chineseScript(tag)).toBe(script)
  })

  it.each(['en-US', 'ja', 'ko-KR', 'zhx', '', 'hant'])('%j 不是中文', (tag) => {
    expect(chineseScript(tag)).toBeUndefined()
  })
})

describe('detectPageLocale', () => {
  it('语言列表里第一个中文决定简繁', () => {
    expect(detectPageLocale(['en-US', 'zh-TW', 'zh-CN'])).toBe('zh-TW')
    expect(detectPageLocale(['ja', 'zh-CN', 'zh-TW'])).toBe('zh-CN')
  })

  it('没有中文：台北、香港、澳门时区为繁体，其余为简体', () => {
    expect(detectPageLocale(['en-US'], 'Asia/Taipei')).toBe('zh-TW')
    expect(detectPageLocale(['en-US'], 'Asia/Hong_Kong')).toBe('zh-TW')
    expect(detectPageLocale(['en-US'], 'Asia/Macau')).toBe('zh-TW')
    expect(detectPageLocale(['en-US'], 'Asia/Shanghai')).toBe('zh-CN')
    expect(detectPageLocale(['en-US'], 'America/New_York')).toBe('zh-CN')
    expect(detectPageLocale([])).toBe('zh-CN')
  })

  it('有中文时不看时区', () => {
    expect(detectPageLocale(['zh-CN'], 'Asia/Taipei')).toBe('zh-CN')
  })
})

describe('detectUiLanguage', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['en-US', 'en'],
    ['ja', 'ja'],
    [undefined, 'en'],
  ] as const)('%s → %s', (language, ui) => {
    expect(detectUiLanguage(language)).toBe(ui)
  })
})

describe('resolvePageLocale', () => {
  it('手动选择优先', () => {
    expect(resolvePageLocale('zh-TW', { languages: ['zh-CN'] })).toBe('zh-TW')
    expect(resolvePageLocale('zh-CN', { languages: ['zh-TW'], timeZone: 'Asia/Taipei' })).toBe('zh-CN')
  })

  it('自动：先看语言列表，再看浏览器界面语言、时区', () => {
    expect(resolvePageLocale('auto', { languages: ['en-US', 'zh-HK'], uiLanguage: 'zh-CN' })).toBe('zh-TW')
    expect(resolvePageLocale('auto', { languages: ['en-US'], uiLanguage: 'zh-TW' })).toBe('zh-TW')
    expect(resolvePageLocale('auto', { languages: ['en-US'], uiLanguage: 'en', timeZone: 'Asia/Taipei' })).toBe('zh-TW')
    expect(resolvePageLocale('auto', { languages: ['en-US'], uiLanguage: 'en' })).toBe('zh-CN')
  })
})

describe('resolveUiLanguage', () => {
  it('手动选择优先', () => {
    expect(resolveUiLanguage('en', { languages: ['zh-CN'], uiLanguage: 'zh-CN' })).toBe('en')
  })

  it('自动：按浏览器界面语言，读不到时按语言列表第一项', () => {
    expect(resolveUiLanguage('auto', { languages: ['en-US'], uiLanguage: 'zh-HK' })).toBe('zh-TW')
    expect(resolveUiLanguage('auto', { languages: ['zh-CN'], uiLanguage: 'en-US' })).toBe('en')
    expect(resolveUiLanguage('auto', { languages: ['zh-TW', 'en'] })).toBe('zh-TW')
    expect(resolveUiLanguage('auto', { languages: [] })).toBe('en')
  })
})

describe('设置取值校验', () => {
  it('页面翻译语言', () => {
    for (const value of ['auto', 'zh-CN', 'zh-TW']) expect(isPageLocalePreference(value)).toBe(true)
    for (const value of ['en', 'zh', '', null, 1]) expect(isPageLocalePreference(value)).toBe(false)
  })

  it('界面语言', () => {
    for (const value of ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko']) expect(isUiLanguagePreference(value)).toBe(true)
    for (const value of ['ja-JP', 'ko_KR', 'EN', '', undefined]) expect(isUiLanguagePreference(value)).toBe(false)
  })
})
