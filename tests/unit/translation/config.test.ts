import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  completionUrl,
  DEFAULT_TRANSLATION_CONFIG,
  getTranslationConfig,
  isModelId,
  isModelList,
  MAX_DISCOVERED_MODELS,
  modelsUrl,
  normalizeBaseUrl,
  normalizeOrigin,
  sanitizeTranslationConfig,
  updateTranslationConfig,
} from '../../../src/translation/config'
import {
  isApiType,
  isTemperature,
  normalizeCustomHeaders,
  normalizeRequestParams,
  requestOptionsCacheKey,
  requestOptionsKey,
} from '../../../src/translation/request-options'

describe('normalizeBaseUrl', () => {
  it('拒绝非 http(s) 协议', () => {
    expect(normalizeBaseUrl('javascript:alert(1)')).toBe('')
    expect(normalizeBaseUrl('file:///etc/passwd')).toBe('')
    expect(normalizeBaseUrl('ftp://x.com/v1')).toBe('')
  })

  it('拒绝用户名密码、query、hash', () => {
    expect(normalizeBaseUrl('https://user:pass@x.com/v1')).toBe('')
    expect(normalizeBaseUrl('https://x.com/v1?key=1')).toBe('')
    expect(normalizeBaseUrl('https://x.com/v1#frag')).toBe('')
  })

  it('拒绝公网 http，允许回环 http', () => {
    expect(normalizeBaseUrl('http://example.com/v1')).toBe('')
    expect(normalizeBaseUrl('http://192.168.1.1/v1')).toBe('')
    expect(normalizeBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normalizeBaseUrl('http://[::1]:8080')).toBe('http://[::1]:8080')
  })

  it('去掉末尾斜杠、保留中间路径、要求 scheme', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('  https://a.com/relay/openai  ')).toBe('https://a.com/relay/openai')
    expect(normalizeBaseUrl('api.example.com/v1')).toBe('')
    expect(normalizeBaseUrl('')).toBe('')
  })
})

describe('completionUrl', () => {
  it('/v1 结尾补 /chat/completions', () => {
    expect(completionUrl('https://relay.example/v1')).toBe('https://relay.example/v1/chat/completions')
  })

  it('已是完整路径不重复追加', () => {
    expect(completionUrl('https://x.com/v1/chat/completions')).toBe('https://x.com/v1/chat/completions')
  })

  it('纯 origin 补 /v1/chat/completions', () => {
    expect(completionUrl('https://api.example.com')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('任意路径只补 /chat/completions，不猜 /v1', () => {
    expect(completionUrl('https://relay.example/openai')).toBe('https://relay.example/openai/chat/completions')
  })

  it('非法输入返回空', () => {
    expect(completionUrl('http://evil.com')).toBe('')
    expect(completionUrl('')).toBe('')
  })

  it('按协议类型切换 /chat/completions 与 /responses，保留前缀且不重复拼接', () => {
    expect(completionUrl('https://api.example/v1/chat/completions', 'responses')).toBe(
      'https://api.example/v1/responses',
    )
    expect(completionUrl('https://api.example/v1/responses', 'chat-completions')).toBe(
      'https://api.example/v1/chat/completions',
    )
    expect(completionUrl('https://api.example', 'responses')).toBe('https://api.example/v1/responses')
    expect(completionUrl('https://api.example/relay/openai', 'responses')).toBe(
      'https://api.example/relay/openai/responses',
    )
    expect(completionUrl('http://api.example/v1', 'responses')).toBe('')
    expect(completionUrl('https://api.example/v1?x=1', 'responses')).toBe('')
    expect(completionUrl('https://user:pass@api.example/v1', 'responses')).toBe('')
  })
})

describe('modelsUrl 与模型列表校验', () => {
  it('根地址补 /v1/models，/v1、完整 chat/responses 与尾斜杠统一映射到 /models，非法地址拒绝', () => {
    expect(modelsUrl('https://api.example.com')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/v1/chat/completions/')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/v1/responses')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/relay/openai/')).toBe('https://api.example.com/relay/openai/models')
    expect(modelsUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/models')

    expect(modelsUrl('http://api.example.com/v1')).toBe('')
    expect(modelsUrl('ftp://api.example.com/v1')).toBe('')
    expect(modelsUrl('https://api.example.com/v1?k=1')).toBe('')
    expect(modelsUrl('https://api.example.com/v1#frag')).toBe('')
    expect(modelsUrl('')).toBe('')
    expect(modelsUrl('https://user:pass@api.example.com/v1')).toBe('')
  })

  it('isModelId 与 isModelList 校验长度、控制字符、空白与去重上限', () => {
    expect(isModelId('gpt-4o-mini')).toBe(true)
    expect(isModelId('')).toBe(false)
    expect(isModelId(' gpt-4o ')).toBe(false)
    expect(isModelId('bad\nmodel')).toBe(false)
    expect(isModelId('bad\x7fmodel')).toBe(false)
    expect(isModelId('x'.repeat(201))).toBe(false)

    expect(isModelList([])).toBe(true)
    expect(isModelList(['a', 'b'])).toBe(true)
    expect(isModelList(['a', 'a'])).toBe(false)
    expect(isModelList(['a', ''])).toBe(false)
    expect(isModelList(Array.from({ length: MAX_DISCOVERED_MODELS + 1 }, (_, i) => `m-${i}`))).toBe(false)
  })
})

describe('request-options 校验与规范化', () => {
  it('isApiType 与 isTemperature 严格校验边界', () => {
    expect(isApiType('chat-completions')).toBe(true)
    expect(isApiType('responses')).toBe(true)
    expect(isApiType('other')).toBe(false)

    expect(isTemperature(null)).toBe(true)
    expect(isTemperature(0)).toBe(true)
    expect(isTemperature(2)).toBe(true)
    for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 2.1, '1']) {
      expect(isTemperature(invalid)).toBe(false)
    }
  })

  it('normalizeRequestParams 递归排序键名并拒绝非法、受限、超深或超大输入', () => {
    const normalized = normalizeRequestParams({ b: 1, a: { d: true, c: null } })
    expect(JSON.stringify(normalized)).toBe('{"a":{"c":null,"d":true},"b":1}')
    expect(
      requestOptionsKey({ requestParams: { b: 1, a: { d: true, c: null } } }),
    ).toBe(
      requestOptionsKey({ requestParams: { a: { c: null, d: true }, b: 1 } }),
    )

    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 8; i += 1) deep = { next: deep }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    for (const bad of [
      [],
      null,
      { model: 'other' },
      JSON.parse('{"x":{"__proto__":1}}') as unknown,
      { x: '汉'.repeat(6000) },
      deep,
      cyclic,
    ]) {
      expect(() => normalizeRequestParams(bad)).toThrow()
    }
  })

  it('normalizeCustomHeaders 归一化小写、修剪空白并拒绝重复、受限或注入请求头', () => {
    expect(normalizeCustomHeaders({ 'X-Api-Key': ' value ' })).toEqual({ 'x-api-key': 'value' })
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-H-${index}`, '1']))
    for (const bad of [
      { 'X-A': '1', 'x-a': '2' },
      { 'X-A': 'bad\r\nX-B: yes' },
      { Authorization: 'Bearer x' },
      { Cookie: 'a=b' },
      { 'Sec-Fetch-Site': 'none' },
      { 'X-A': 1 },
      tooMany,
      { 'X-A': 'x'.repeat(8192) },
    ]) {
      expect(() => normalizeCustomHeaders(bad)).toThrow()
    }
  })

  it('requestOptionsCacheKey 生成规范 UTF-8 SHA-256 摘要，摘要失败时回退完整规范键', async () => {
    const a = { requestParams: { z: '中文', a: 1 } }
    const expected = createHash('sha256').update(requestOptionsKey(a), 'utf8').digest('hex')
    expect(await requestOptionsCacheKey(a)).toBe(expected)
    expect(await requestOptionsCacheKey({ requestParams: { a: 1, z: '中文' } })).toBe(expected)
    for (const change of [
      { apiType: 'responses' as const },
      { temperature: 0 },
      { requestParams: { a: 2, z: '中文' } },
      { customHeadersRevision: '11111111-1111-4111-8111-111111111111' },
    ]) expect(await requestOptionsCacheKey({ ...a, ...change })).not.toBe(expected)

    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest unavailable'))
    try {
      expect(await requestOptionsCacheKey(a)).toBe(requestOptionsKey(a))
    } finally {
      digestSpy.mockRestore()
    }
  })
})

describe('normalizeOrigin', () => {
  it('页面 URL 提取精确 origin，小写化', () => {
    expect(normalizeOrigin('https://APP.Devin.AI/sessions/abc?x=1')).toBe('https://app.devin.ai')
    expect(normalizeOrigin('app.devin.ai/workspace')).toBe('https://app.devin.ai')
  })

  it('拒绝凭据与非 http(s)', () => {
    expect(normalizeOrigin('https://u:p@x.com/')).toBe('')
    expect(normalizeOrigin('javascript:x')).toBe('')
    expect(normalizeOrigin('chrome://extensions')).toBe('')
  })
})

describe('sanitizeTranslationConfig', () => {
  it('旧配置默认没有排除网站，新列表规范化并去重', () => {
    expect(sanitizeTranslationConfig({ model: 'legacy' }).excludedHosts).toEqual([])
    expect(sanitizeTranslationConfig({
      excludedHosts: ['EXAMPLE.COM', 'https://example.com/path', 'https://other.example:8443/', '*.bad.example'],
    }).excludedHosts).toEqual(['example.com', 'other.example'])
  })

  it('去重 autoOrigins、丢弃非法项、截断到 50', () => {
    const origins = ['https://a.com', 'https://a.com/', 'https://b.com/x', 'not a url', 42]
    const config = sanitizeTranslationConfig({ autoOrigins: origins, model: 'm' })
    expect(config.autoOrigins).toEqual(['https://a.com', 'https://b.com'])
    const many = Array.from({ length: 60 }, (_, i) => `https://s${i}.example.com`)
    expect(sanitizeTranslationConfig({ autoOrigins: many }).autoOrigins).toHaveLength(50)
  })

  it('旧 devinEnabled/cursorEnabled 开关迁移为 disabledDictionaries', () => {
    expect(sanitizeTranslationConfig({ devinEnabled: false }).disabledDictionaries).toEqual(['devin'])
    expect(sanitizeTranslationConfig({ devinEnabled: false, cursorEnabled: false }).disabledDictionaries).toEqual(['devin', 'cursor'])
    expect(sanitizeTranslationConfig({ disabledDictionaries: ['devin', 'unknown', 'cursor', 'devin'] }).disabledDictionaries).toEqual(['devin', 'cursor'])
  })

  it('非法目标语言回落默认，已加入的拉丁语种保留', () => {
    expect(sanitizeTranslationConfig({ targetLanguage: 'xx' }).targetLanguage).toBe('zh-CN')
    expect(sanitizeTranslationConfig({ targetLanguage: 'auto' }).targetLanguage).toBe('zh-CN')
    expect(sanitizeTranslationConfig({ targetLanguage: 'ja' }).targetLanguage).toBe('ja')
    for (const targetLanguage of ['es', 'fr', 'de', 'pt'] as const) {
      expect(sanitizeTranslationConfig({ targetLanguage }).targetLanguage).toBe(targetLanguage)
    }
  })

  it('缺省输入目标语言迁移为 en，合法值保留，非法值回落 en', () => {
    expect(sanitizeTranslationConfig({ model: 'legacy' }).inputTargetLanguage).toBe('en')
    expect(sanitizeTranslationConfig({ inputTargetLanguage: 'auto' }).inputTargetLanguage).toBe('en')
    expect(sanitizeTranslationConfig({ inputTargetLanguage: 'xx' }).inputTargetLanguage).toBe('en')
    for (const inputTargetLanguage of ['ja', 'es', 'fr', 'de', 'pt'] as const) {
      expect(sanitizeTranslationConfig({ inputTargetLanguage }).inputTargetLanguage).toBe(inputTargetLanguage)
    }
  })

  it('缺省与非法源语言迁移为 auto，有效值保留', () => {
    expect(sanitizeTranslationConfig({ model: 'legacy' }).sourceLanguage).toBe('auto')
    expect(sanitizeTranslationConfig({ sourceLanguage: 'xx' }).sourceLanguage).toBe('auto')
    expect(sanitizeTranslationConfig({ sourceLanguage: '' }).sourceLanguage).toBe('auto')
    for (const sourceLanguage of ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt'] as const) {
      expect(sanitizeTranslationConfig({ sourceLanguage }).sourceLanguage).toBe(sourceLanguage)
    }
  })

  it('非对象输入返回默认值', () => {
    expect(sanitizeTranslationConfig(null)).toEqual(DEFAULT_TRANSLATION_CONFIG)
    expect(sanitizeTranslationConfig(['x'])).toEqual(DEFAULT_TRANSLATION_CONFIG)
    expect(sanitizeTranslationConfig('x')).toEqual(DEFAULT_TRANSLATION_CONFIG)
  })

  it('网站运行范围默认 all 且名单为空，非法模式回落，名单按排除规则清洗', () => {
    expect(sanitizeTranslationConfig({ model: 'legacy' }).siteScopeMode).toBe('all')
    expect(sanitizeTranslationConfig({ model: 'legacy' }).siteScopeHosts).toEqual([])
    expect(sanitizeTranslationConfig({ siteScopeMode: 'nope' }).siteScopeMode).toBe('all')
    expect(sanitizeTranslationConfig({ siteScopeMode: 'include' }).siteScopeMode).toBe('include')
    expect(sanitizeTranslationConfig({ siteScopeMode: 'exclude' }).siteScopeMode).toBe('exclude')
    expect(sanitizeTranslationConfig({
      siteScopeHosts: ['EXAMPLE.COM', 'https://example.com/path', 'https://other.example:8443/', '*.bad.example'],
    }).siteScopeHosts).toEqual(['example.com', 'other.example'])
  })

  it('不包含 apiKey 字段；model 截断到 200', () => {
    const config = sanitizeTranslationConfig({ apiKey: 'sk-secret', model: 'x'.repeat(300) })
    expect('apiKey' in config).toBe(false)
    expect(config.model).toHaveLength(200)
  })

  it('选择工具栏默认关闭，并与划词/主动提示保持一致状态', () => {
    expect(DEFAULT_TRANSLATION_CONFIG.selectionToolbarEnabled).toBe(false)
    expect(sanitizeTranslationConfig({ model: 'legacy' }).selectionToolbarEnabled).toBe(false)
    expect(sanitizeTranslationConfig({
      selectionPopupEnabled: true,
      selectionToolbarEnabled: true,
      proactiveAssistEnabled: true,
    })).toMatchObject({
      selectionPopupEnabled: true,
      selectionToolbarEnabled: true,
      proactiveAssistEnabled: false,
    })
    expect(sanitizeTranslationConfig({
      selectionPopupEnabled: false,
      selectionToolbarEnabled: true,
      proactiveAssistEnabled: true,
    })).toMatchObject({
      selectionPopupEnabled: false,
      selectionToolbarEnabled: false,
      proactiveAssistEnabled: false,
    })
    expect(sanitizeTranslationConfig({
      selectionPopupEnabled: true,
      selectionToolbarEnabled: false,
      proactiveAssistEnabled: true,
    })).toMatchObject({
      selectionPopupEnabled: true,
      selectionToolbarEnabled: false,
      proactiveAssistEnabled: true,
    })
  })

  it('悬浮入口默认显示，显式关闭保留，不改划词级联', () => {
    expect(DEFAULT_TRANSLATION_CONFIG.floatingButtonEnabled).toBe(true)
    expect(sanitizeTranslationConfig({ model: 'legacy' }).floatingButtonEnabled).toBe(true)
    for (const floatingButtonEnabled of ['yes', 1, 0, null, undefined]) {
      expect(sanitizeTranslationConfig({ floatingButtonEnabled }).floatingButtonEnabled).toBe(true)
    }
    expect(sanitizeTranslationConfig({ floatingButtonEnabled: false }).floatingButtonEnabled).toBe(false)
    expect(sanitizeTranslationConfig({
      floatingButtonEnabled: true,
      selectionPopupEnabled: false,
      proactiveAssistEnabled: true,
    })).toMatchObject({
      floatingButtonEnabled: true,
      selectionPopupEnabled: false,
      proactiveAssistEnabled: false,
    })
  })
  it('旧配置缺省或损坏高级字段时回落默认，合法值保留', () => {
    const legacy = sanitizeTranslationConfig({ model: 'legacy', requestParams: { model: 'override' }, temperature: 9, apiType: 'bad', customHeadersRevision: 'not-uuid' })
    expect(legacy.apiType).toBe('chat-completions')
    expect(legacy.temperature).toBeNull()
    expect(legacy.requestParams).toEqual({})
    expect(legacy.customHeadersRevision).toBe('')

    const valid = sanitizeTranslationConfig({
      apiType: 'responses',
      temperature: 0,
      requestParams: { b: 2, a: 1 },
      customHeadersRevision: '11111111-1111-4111-8111-111111111111',
    })
    expect(valid.apiType).toBe('responses')
    expect(valid.temperature).toBe(0)
    expect(JSON.stringify(valid.requestParams)).toBe('{"a":1,"b":2}')
    expect(valid.customHeadersRevision).toBe('11111111-1111-4111-8111-111111111111')
  })
})

describe('floatingButtonEnabled 保存', () => {
  beforeEach(() => {
    fakeBrowser.reset()
  })

  it('自动弹窗旧配置默认开启，关闭持久化且不改变其他功能偏好', async () => {
    expect(sanitizeTranslationConfig({ model: 'legacy' }).autoInteractionEnabled).toBe(true)
    await updateTranslationConfig({ selectionPopupEnabled: true, proactiveAssistEnabled: true, floatingButtonEnabled: true })
    await updateTranslationConfig({ autoInteractionEnabled: false })
    expect(await getTranslationConfig()).toMatchObject({
      autoInteractionEnabled: false, selectionPopupEnabled: true, proactiveAssistEnabled: true, floatingButtonEnabled: true,
    })
    await updateTranslationConfig({ model: 'different-model' })
    expect((await getTranslationConfig()).autoInteractionEnabled).toBe(false)
    await updateTranslationConfig({ autoInteractionEnabled: true })
    expect((await getTranslationConfig()).autoInteractionEnabled).toBe(true)
  })

  it('显式关闭和重新开启均保留，其他patch不会重置开关', async () => {
    expect((await getTranslationConfig()).floatingButtonEnabled).toBe(true)
    await updateTranslationConfig({ floatingButtonEnabled: false })
    expect((await getTranslationConfig()).floatingButtonEnabled).toBe(false)
    await updateTranslationConfig({ model: 'm' })
    expect((await getTranslationConfig()).floatingButtonEnabled).toBe(false)
    await updateTranslationConfig({ floatingButtonEnabled: true })
    await updateTranslationConfig({ model: 'm2' })
    expect((await getTranslationConfig()).floatingButtonEnabled).toBe(true)
  })

  it('视频字幕与输入翻译旧配置默认关闭，开启与保存互不干扰', async () => {
    expect(DEFAULT_TRANSLATION_CONFIG.videoSubtitlesEnabled).toBe(false)
    expect(DEFAULT_TRANSLATION_CONFIG.inputTranslationEnabled).toBe(false)
    expect(sanitizeTranslationConfig({ model: 'legacy' })).toMatchObject({
      videoSubtitlesEnabled: false,
      inputTranslationEnabled: false,
    })
    for (const invalid of ['true', 1, null, undefined, {}]) {
      expect(
        sanitizeTranslationConfig({
          videoSubtitlesEnabled: invalid,
          inputTranslationEnabled: invalid,
        }),
      ).toMatchObject({
        videoSubtitlesEnabled: false,
        inputTranslationEnabled: false,
      })
    }
    expect(
      sanitizeTranslationConfig({
        videoSubtitlesEnabled: true,
        inputTranslationEnabled: true,
      }),
    ).toMatchObject({
      videoSubtitlesEnabled: true,
      inputTranslationEnabled: true,
    })
    await updateTranslationConfig({ videoSubtitlesEnabled: true })
    expect(await getTranslationConfig()).toMatchObject({
      videoSubtitlesEnabled: true,
      inputTranslationEnabled: false,
    })
    await updateTranslationConfig({ inputTranslationEnabled: true })
    expect(await getTranslationConfig()).toMatchObject({
      videoSubtitlesEnabled: true,
      inputTranslationEnabled: true,
    })
    await updateTranslationConfig({ model: 'other' })
    expect(await getTranslationConfig()).toMatchObject({
      videoSubtitlesEnabled: true,
      inputTranslationEnabled: true,
    })
  })
})

describe('单页字符上限', () => {
  it('默认 50000；只接受预设档位，0 为不限', () => {
    expect(DEFAULT_TRANSLATION_CONFIG.pageCharLimit).toBe(50_000)
    expect(sanitizeTranslationConfig({ pageCharLimit: 0 }).pageCharLimit).toBe(0)
    expect(sanitizeTranslationConfig({ pageCharLimit: 200_000 }).pageCharLimit).toBe(200_000)
    // 旧版配置没有这个字段；任意数值、负数、字符串都回到默认
    for (const value of [undefined, 12345, -1, '50000', Infinity]) {
      expect(sanitizeTranslationConfig({ pageCharLimit: value }).pageCharLimit).toBe(50_000)
    }
  })
})
