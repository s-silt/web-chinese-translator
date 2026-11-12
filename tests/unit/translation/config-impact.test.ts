import { describe, expect, it } from 'vitest'
import {
  translationOutputChanged,
  readingPolicyChanged,
  requestAffected,
  type RequestScope,
} from '../../../src/translation/config-impact'
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from '../../../src/translation/config'

const BASE: TranslationConfig = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  autoOrigins: ['https://a.example', 'https://b.example'],
  selectionPopupEnabled: true,
  proactiveAssistEnabled: true,
}

function request(kind: RequestScope['kind'], recentSites: readonly string[] = []): RequestScope {
  return { kind, url: 'https://a.example/page', recentSites }
}

describe('配置变更影响判定', () => {
  it('只有接口地址或模型算连接变更', () => {
    expect(translationOutputChanged(BASE, { ...BASE })).toBe(false)
    expect(translationOutputChanged(BASE, { ...BASE, autoOrigins: [] })).toBe(false)
    expect(translationOutputChanged(BASE, { ...BASE, model: 'x' })).toBe(true)
    expect(translationOutputChanged(BASE, { ...BASE, baseUrl: 'https://api.example.com/v2' })).toBe(true)
  })

  it('源语言变化作废输出', () => {
    expect(translationOutputChanged(BASE, { ...BASE, sourceLanguage: 'ja' })).toBe(true)
    expect(translationOutputChanged(BASE, { ...BASE, sourceLanguage: 'auto' })).toBe(false)
  })

  it('协议、温度、附加请求参数或请求头修订号变化作废输出，同义键序不作废', () => {
    expect(translationOutputChanged(BASE, { ...BASE, apiType: 'responses' })).toBe(true)
    expect(translationOutputChanged(BASE, { ...BASE, temperature: 0 })).toBe(true)
    expect(translationOutputChanged(BASE, { ...BASE, requestParams: { reasoning_effort: 'low' } })).toBe(true)
    expect(
      translationOutputChanged(
        { ...BASE, requestParams: { b: 1, a: 2 } },
        { ...BASE, requestParams: { a: 2, b: 1 } },
      ),
    ).toBe(false)
    expect(
      translationOutputChanged(BASE, {
        ...BASE,
        customHeadersRevision: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(true)
  })

  it('阅读策略看划词、主动提示、排除列表和网站运行范围', () => {
    expect(readingPolicyChanged(BASE, { ...BASE, excludedHosts: [...BASE.excludedHosts] })).toBe(false)
    expect(readingPolicyChanged(BASE, { ...BASE, disabledDictionaries: ['devin'], autoOrigins: [] })).toBe(false)
    expect(readingPolicyChanged(BASE, { ...BASE, selectionPopupEnabled: false })).toBe(true)
    expect(readingPolicyChanged(BASE, { ...BASE, selectionToolbarEnabled: true })).toBe(true)
    expect(readingPolicyChanged(BASE, { ...BASE, proactiveAssistEnabled: false })).toBe(true)
    expect(readingPolicyChanged(BASE, { ...BASE, excludedHosts: ['x.example'] })).toBe(true)
    expect(readingPolicyChanged(BASE, { ...BASE, siteScopeMode: 'include' })).toBe(true)
    expect(readingPolicyChanged(BASE, { ...BASE, siteScopeHosts: ['a.example'] })).toBe(true)
    expect(readingPolicyChanged(BASE, { ...BASE, siteScopeHosts: [...BASE.siteScopeHosts] })).toBe(false)
    expect(readingPolicyChanged(BASE, { ...BASE, siteScopeMode: 'all' })).toBe(false)
  })

  it('自动请求只受本站开关影响', () => {
    expect(requestAffected(request('auto'), BASE, { ...BASE, autoOrigins: ['https://a.example'] })).toBe(false)
    expect(requestAffected(request('auto'), BASE, { ...BASE, autoOrigins: ['https://b.example'] })).toBe(true)
  })

  it('划词翻译不受自动翻译开关影响', () => {
    expect(requestAffected(request('selection'), BASE, { ...BASE, autoOrigins: [] })).toBe(false)
  })

  it.each(['auto', 'selection', 'assist'] as const)('%s 请求：排除本站时受影响，排除其他站点时不因本站受影响', (kind) => {
    expect(requestAffected(request(kind), BASE, { ...BASE, excludedHosts: ['a.example'] })).toBe(true)
    if (kind !== 'assist') {
      expect(requestAffected(request(kind), BASE, { ...BASE, excludedHosts: ['c.example'] })).toBe(false)
    }
  })

  it('取消排除本站也算本站模式变化', () => {
    const excluded = { ...BASE, excludedHosts: ['a.example'] }
    expect(requestAffected(request('auto'), excluded, BASE)).toBe(true)
  })

  it('阅读辅助随阅读策略失效，但不受其他站点规则影响', () => {
    expect(requestAffected(request('assist'), BASE, { ...BASE, selectionPopupEnabled: false })).toBe(true)
    expect(requestAffected(request('assist'), BASE, { ...BASE, excludedHosts: ['c.example'] })).toBe(true)
    expect(requestAffected(request('assist'), BASE, { ...BASE, autoOrigins: [] })).toBe(false)
  })

  it('翻译请求只有携带被关闭或被排除的阅读线索时才受影响', () => {
    const clues = request('auto', ['c.example'])
    expect(requestAffected(clues, BASE, { ...BASE, proactiveAssistEnabled: false })).toBe(true)
    expect(requestAffected(clues, BASE, { ...BASE, excludedHosts: ['c.example'] })).toBe(true)
    expect(requestAffected(clues, BASE, { ...BASE, excludedHosts: ['d.example'] })).toBe(false)
    expect(requestAffected(request('auto'), BASE, { ...BASE, proactiveAssistEnabled: false })).toBe(false)
  })

  it('网站运行范围变化影响该网址，阅读线索离开范围也受影响', () => {
    const narrowed = { ...BASE, siteScopeMode: 'include' as const, siteScopeHosts: ['b.example'] }
    expect(requestAffected(request('selection'), BASE, narrowed)).toBe(true)
    const still = { ...BASE, siteScopeMode: 'include' as const, siteScopeHosts: ['a.example'] }
    expect(requestAffected(request('selection'), BASE, still)).toBe(false)
    expect(requestAffected(request('auto', ['c.example']), BASE, still)).toBe(true)
    expect(requestAffected(request('auto', ['c.example']), BASE, { ...BASE, siteScopeMode: 'exclude', siteScopeHosts: ['d.example'] })).toBe(false)
    expect(requestAffected(request('assist'), BASE, { ...BASE, siteScopeMode: 'exclude' })).toBe(true)
  })

  it('连接测试与模型列表不属于任何站点', () => {
    expect(requestAffected({ kind: 'test', url: '', recentSites: [] }, BASE, { ...BASE, excludedHosts: ['a.example'] })).toBe(false)
    expect(requestAffected({ kind: 'catalog', url: '', recentSites: [] }, BASE, { ...BASE, excludedHosts: ['a.example'], selectionPopupEnabled: false, siteScopeMode: 'include' })).toBe(false)
  })

  it('输入翻译请求仅受对应开关、自动弹窗、站点排除及网站范围影响', () => {
    const subOn = { ...BASE, inputTranslationEnabled: true }

    expect(requestAffected(request('input'), subOn, { ...subOn, inputTranslationEnabled: false })).toBe(true)
    expect(requestAffected(request('input'), subOn, { ...subOn, autoInteractionEnabled: false })).toBe(false)
    expect(requestAffected(request('input'), { ...subOn, inputReplaceMode: 'auto' }, { ...subOn, inputReplaceMode: 'auto', autoInteractionEnabled: false })).toBe(false)
    expect(requestAffected(request('input'), subOn, { ...subOn, inputReplaceMode: 'auto' })).toBe(false)
    expect(requestAffected(request('input'), subOn, { ...subOn, autoOrigins: [] })).toBe(false)
    expect(requestAffected(request('input'), subOn, { ...subOn, excludedHosts: ['a.example'] })).toBe(true)
    expect(requestAffected(request('input'), subOn, { ...subOn, inputTargetLanguage: 'es' })).toBe(true)
    expect(requestAffected(request('input'), subOn, { ...subOn, inputSourceLanguage: 'ja' })).toBe(true)
    expect(requestAffected(request('auto'), subOn, { ...subOn, inputTargetLanguage: 'fr' })).toBe(false)
    expect(translationOutputChanged(subOn, { ...subOn, inputTargetLanguage: 'de' })).toBe(false)
    expect(translationOutputChanged(subOn, { ...subOn, inputSourceLanguage: 'de' })).toBe(false)
  })
})
