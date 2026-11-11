import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import {
  isContentTranslationMessage,
  isContentTranslationReply,
  isTranslationMessage,
  isTranslationReply,
  NO_SELECTION_ERROR,
  type TranslationMessage,
} from '../../../src/translation/messages'

describe('wt:read-selection 消息与回复校验', () => {
  it('状态中的字符预算标记兼容旧回复，但拒绝非布尔值', () => {
    const message = { type: 'wt:status' } as const
    const status = { supported: true, fixed: false, auto: false, paused: false, capped: true, failed: 0, error: '' }
    expect(isContentTranslationReply({ ok: true, status }, message)).toBe(true)
    for (const budgetCapped of [true, false]) {
      expect(isContentTranslationReply({ ok: true, status: { ...status, budgetCapped } }, message)).toBe(true)
    }
    for (const budgetCapped of ['false', 1]) {
      expect(isContentTranslationReply({ ok: true, status: { ...status, budgetCapped } }, message)).toBe(false)
    }
  })

  it('状态 progress 缺省有效；存在时四字段必须是非负安全整数', () => {
    const message = { type: 'wt:status' } as const
    const status = { supported: true, fixed: false, auto: true, paused: false, capped: false, failed: 0, error: '' }
    const progress = { spent: 10, budget: 20000, translated: 3, queued: 2 }
    expect(isContentTranslationReply({ ok: true, status }, message)).toBe(true)
    expect(isContentTranslationReply({ ok: true, status: { ...status, progress } }, message)).toBe(true)
    for (const bad of [
      { ...progress, spent: -1 },
      { ...progress, budget: 1.5 },
      { ...progress, translated: '3' },
      { spent: 1, budget: 2, translated: 3 },
      'progress',
      42,
    ]) {
      expect(isContentTranslationReply({ ok: true, status: { ...status, progress: bad } }, message)).toBe(false)
    }
  })

  it('自动弹窗仅接受布尔补丁及布尔配置回复', () => {
    const message = { type: 'wt:save-config', patch: { autoInteractionEnabled: false } } as const
    expect(isTranslationMessage(message)).toBe(true)
    expect(isTranslationMessage({ ...message, patch: { autoInteractionEnabled: true } })).toBe(true)
    expect(isTranslationMessage({ ...message, patch: { autoInteractionEnabled: 'false' } })).toBe(false)
    expect(isTranslationReply({ ok: true, config: { ...DEFAULT_TRANSLATION_CONFIG, autoInteractionEnabled: false } }, message)).toBe(true)
    expect(isTranslationReply({ ok: true, config: { ...DEFAULT_TRANSLATION_CONFIG, autoInteractionEnabled: 'false' } }, message)).toBe(false)
  })

  it('wt:read-selection 通过消息校验', () => {
    expect(NO_SELECTION_ERROR).toBe('请先选中要翻译的文字')
    expect(isContentTranslationMessage({ type: 'wt:read-selection' })).toBe(true)
    expect(isContentTranslationMessage({ type: 'wt:unknown' })).toBe(false)
  })

  it('wt:read-selection 回复校验要求 text 为 string', () => {
    const message = { type: 'wt:read-selection' } as const
    expect(isContentTranslationReply({ ok: true, text: '' }, message)).toBe(true)
    expect(isContentTranslationReply({ ok: true, text: 'Hello' }, message)).toBe(true)
    expect(isContentTranslationReply({ ok: true }, message)).toBe(false)
    expect(isContentTranslationReply({ ok: true, text: 123 }, message)).toBe(false)
    expect(isContentTranslationReply({ ok: false, error: '失败' }, message)).toBe(true)
  })

  it('wt:show-selection 与 wt:translate 严格校验 manualSelectionId', () => {
    expect(
      isContentTranslationMessage({
        type: 'wt:show-selection',
        text: 'Hello',
        manualSelectionId: 'ticket-abc-123',
      }),
    ).toBe(true)
    expect(
      isContentTranslationMessage({
        type: 'wt:show-selection',
        text: 'Hello',
        manualSelectionId: 'invalid id!',
      }),
    ).toBe(false)

    expect(
      isTranslationMessage({
        type: 'wt:translate',
        mode: 'selection',
        texts: ['Hello'],
        manualSelectionId: 'ticket-abc-123',
      }),
    ).toBe(true)
    expect(
      isTranslationMessage({
        type: 'wt:translate',
        mode: 'auto',
        texts: ['Hello'],
        manualSelectionId: 'ticket-abc-123',
      }),
    ).toBe(false)
    expect(
      isTranslationMessage({
        type: 'wt:translate',
        mode: 'selection',
        texts: ['Hello', 'World'],
        manualSelectionId: 'ticket-abc-123',
      }),
    ).toBe(false)
    expect(
      isTranslationMessage({
        type: 'wt:translate',
        mode: 'selection',
        texts: ['Hello'],
        manualSelectionId: 'bad id!',
      }),
    ).toBe(false)
  })

  it('wt:save-config 与回复校验覆盖高级连接字段与请求头状态', () => {
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: {
          apiType: 'responses',
          temperature: 0,
          requestParams: { reasoning: { effort: 'medium' } },
        },
        customHeaders: { 'X-Api-Key': 'v' },
        expectedConnection: {
          baseUrl: 'https://api.example.com/v1',
          model: 'm',
          requestOptionsKey: '["chat-completions",null,{},""]',
        },
      }),
    ).toBe(true)

    for (const invalid of [
      { type: 'wt:save-config', patch: { customHeadersRevision: '11111111-1111-4111-8111-111111111111' } },
      { type: 'wt:save-config', patch: { apiType: 'other' } },
      { type: 'wt:save-config', patch: { temperature: 2.5 } },
      { type: 'wt:save-config', patch: { requestParams: { model: 'override' } } },
      { type: 'wt:save-config', patch: {}, customHeaders: { Authorization: 'Bearer x' } },
      {
        type: 'wt:save-config',
        patch: {},
        expectedConnection: { baseUrl: 'https://api.example.com/v1', model: 'm', requestOptionsKey: '' },
      },
    ]) {
      expect(isTranslationMessage(invalid)).toBe(false)
    }

    for (const customHeadersState of ['none', 'ready', 'different-origin', 'unavailable'] as const) {
      expect(
        isTranslationReply(
          { ok: true, config: DEFAULT_TRANSLATION_CONFIG, customHeadersState },
          { type: 'wt:get-config' },
        ),
      ).toBe(true)
    }
    expect(
      isTranslationReply(
        { ok: true, config: DEFAULT_TRANSLATION_CONFIG, customHeadersState: 'legacy' },
        { type: 'wt:get-config' },
      ),
    ).toBe(false)
    expect(
      isTranslationReply(
        { ok: true, config: { ...DEFAULT_TRANSLATION_CONFIG, customHeaders: { 'x-a': '1' } } },
        { type: 'wt:get-config' },
      ),
    ).toBe(false)
  })

  it('wt:list-models 与 wt:cancel-models 消息与回复校验', () => {
    const validList = {
      type: 'wt:list-models',
      baseUrl: 'https://api.example.com/v1',
      requestId: 'req-123',
      apiKey: 'sk-test',
      customHeaders: { 'X-Custom': 'val' },
    } as const
    expect(isTranslationMessage(validList)).toBe(true)
    expect(
      isTranslationMessage({
        type: 'wt:list-models',
        baseUrl: 'https://api.example.com/v1',
        requestId: 'req-123',
      }),
    ).toBe(true)
    expect(isTranslationMessage({ type: 'wt:cancel-models', requestId: 'req-123' })).toBe(true)

    for (const invalid of [
      { type: 'wt:list-models', baseUrl: 'x'.repeat(2049), requestId: 'req-123' },
      { type: 'wt:list-models', baseUrl: 'https://api.example.com/v1', requestId: 'bad id!' },
      { type: 'wt:list-models', baseUrl: 'https://api.example.com/v1', requestId: 'req-123', apiKey: 'k'.repeat(513) },
      {
        type: 'wt:list-models',
        baseUrl: 'https://api.example.com/v1',
        requestId: 'req-123',
        customHeaders: { Authorization: 'Bearer x' },
      },
      { type: 'wt:cancel-models', requestId: '' },
      { type: 'wt:cancel-models', requestId: 'bad id!' },
    ]) {
      expect(isTranslationMessage(invalid)).toBe(false)
    }

    expect(isTranslationReply({ ok: true, models: [] }, validList)).toBe(true)
    expect(isTranslationReply({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] }, validList)).toBe(true)
    expect(isTranslationReply({ ok: true }, validList)).toBe(false)
    expect(isTranslationReply({ ok: true, models: ['dup', 'dup'] }, validList)).toBe(false)
    expect(isTranslationReply({ ok: true, models: [''] }, validList)).toBe(false)
    expect(isTranslationReply({ ok: true, models: [' pad '] }, validList)).toBe(false)
    expect(isTranslationReply({ ok: true }, { type: 'wt:cancel-models', requestId: 'req-123' })).toBe(true)
  })
})

describe('wt:translate-page 消息契约', () => {
  it('允许无目标或完整目标，拒绝不完整和非法目标', () => {
    expect(isTranslationMessage({ type: 'wt:translate-page' })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:translate-page', tabId: 7, url: 'https://page.example/article' })).toBe(true)
    for (const payload of [
      { tabId: 7 }, { url: 'https://page.example' }, { tabId: -1, url: 'https://page.example' },
      { tabId: 1.5, url: 'https://page.example' }, { tabId: 7, url: 'chrome://settings' },
      { tabId: 7, url: 'https://page.example/' + 'x'.repeat(8192) },
    ]) {
      expect(isTranslationMessage({ type: 'wt:translate-page', ...payload })).toBe(false)
    }
  })
  it('使用确认回复，拒绝错误类型', () => {
    const message = { type: 'wt:translate-page' } as const
    expect(isTranslationReply({ ok: true }, message)).toBe(true)
    expect(isTranslationReply({ ok: false, error: '失败' }, message)).toBe(true)
    expect(isTranslationReply({ ok: 'true' }, message)).toBe(false)
  })
})

describe('wt:open-options 固定分区', () => {
  it('默认入口或model合法，不能传任意地址或其他分区', () => {
    expect(isTranslationMessage({ type: 'wt:open-options' })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:open-options', section: 'model' })).toBe(true)
    for (const section of ['general', 'other', 'https://example.com', null, 7]) {
      expect(isTranslationMessage({ type: 'wt:open-options', section })).toBe(false)
    }
  })

  it('视频字幕与输入翻译配置补丁、PageModes 与 wt:translate 消息严格校验', () => {
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: {
          videoSubtitlesEnabled: true,
          inputTranslationEnabled: false,
          inputSourceLanguage: 'ja',
          inputTargetLanguage: 'zh-CN',
          inputReplaceKey: 'Ctrl+Enter',
          inputReplaceMode: 'auto',
          inputAutoReplaceDelayMs: 1500,
        },
      }),
    ).toBe(true)
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: { inputSourceLanguage: 'auto', inputReplaceKey: '', inputReplaceMode: 'hotkey', inputAutoReplaceDelayMs: 500 },
      }),
    ).toBe(true)
    for (const badPatch of [
      { inputReplaceMode: 'manual' },
      { inputReplaceMode: '' },
      { inputReplaceMode: 1 },
      { inputAutoReplaceDelayMs: 499 },
      { inputAutoReplaceDelayMs: 10001 },
      { inputAutoReplaceDelayMs: 150 },
      { inputAutoReplaceDelayMs: 550 },
      { inputAutoReplaceDelayMs: '1000' },
      { inputAutoReplaceDelayMs: null },
    ]) {
      expect(isTranslationMessage({ type: 'wt:save-config', patch: badPatch })).toBe(false)
    }
    expect(
      isTranslationReply(
        {
          ok: true,
          config: { ...DEFAULT_TRANSLATION_CONFIG, inputReplaceMode: 'auto', inputAutoReplaceDelayMs: 2500 },
        },
        { type: 'wt:get-config' },
      ),
    ).toBe(true)
    expect(
      isTranslationReply(
        {
          ok: true,
          config: { ...DEFAULT_TRANSLATION_CONFIG, inputReplaceMode: 'invalid' as never },
        },
        { type: 'wt:get-config' },
      ),
    ).toBe(false)
    expect(
      isTranslationReply(
        {
          ok: true,
          config: { ...DEFAULT_TRANSLATION_CONFIG, inputAutoReplaceDelayMs: 150 },
        },
        { type: 'wt:get-config' },
      ),
    ).toBe(false)
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: { inputSourceLanguage: 'xx' },
      }),
    ).toBe(false)
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: { inputReplaceKey: 'a' },
      }),
    ).toBe(false)
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: { inputReplaceKey: 'Escape' },
      }),
    ).toBe(false)
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: { videoSubtitlesEnabled: 'true' },
      }),
    ).toBe(false)
    expect(
      isTranslationMessage({
        type: 'wt:save-config',
        patch: { inputTranslationEnabled: 1 },
      }),
    ).toBe(false)

    const baseModes = { enabled: true, fixed: false, auto: false, selection: false, smart: false }
    expect(
      isTranslationReply({ ok: true, modes: { ...baseModes, subtitles: true, input: false } }, { type: 'wt:page-modes' }),
    ).toBe(true)
    expect(
      isTranslationReply({ ok: true, modes: { ...baseModes, subtitles: 'true' } }, { type: 'wt:page-modes' }),
    ).toBe(false)
    expect(
      isTranslationReply({ ok: true, modes: { ...baseModes, input: 1 } }, { type: 'wt:page-modes' }),
    ).toBe(false)

    const validSubtitle: Extract<TranslationMessage, { type: 'wt:translate' }> = {
      type: 'wt:translate',
      mode: 'subtitle',
      texts: ['Hello', 'こんにちは'],
      requestId: 'req-sub-1',
    }
    const validInput: Extract<TranslationMessage, { type: 'wt:translate' }> = {
      type: 'wt:translate',
      mode: 'input',
      texts: ['你好，世界'],
      requestId: 'req-in-1',
    }
    expect(isTranslationMessage(validSubtitle)).toBe(true)
    expect(isTranslationMessage(validInput)).toBe(true)
    expect(isTranslationMessage({ ...validInput, manualInput: true })).toBe(true)
    expect(isTranslationMessage({ ...validInput, manualInput: false })).toBe(true)
    expect(isTranslationMessage({ ...validInput, manualInput: 'true' })).toBe(false)
    expect(isTranslationMessage({ ...validSubtitle, manualInput: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:translate', mode: 'selection', texts: ['Hello'], manualInput: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:translate', mode: 'auto', texts: ['Hello'], manualInput: false })).toBe(false)
    expect(isContentTranslationMessage({ type: 'wt:translate-input' })).toBe(true)
    expect(isContentTranslationMessage({ type: 'wt:translate-input', text: '你好' })).toBe(false)
    expect(isContentTranslationReply({ ok: true }, { type: 'wt:translate-input' })).toBe(true)
    for (const type of ['wt:refresh-input-frame', 'wt:stop-input-frame'] as const) {
      expect(isContentTranslationMessage({ type })).toBe(true)
      expect(isContentTranslationMessage({ type, extra: true })).toBe(false)
      expect(isContentTranslationMessage({ type, text: '你好' })).toBe(false)
      expect(isContentTranslationReply({ ok: true }, { type })).toBe(true)
      expect(isContentTranslationReply({ ok: false, error: '失败' }, { type })).toBe(true)
      expect(isContentTranslationReply({ ok: false }, { type })).toBe(false)
    }
    expect(isTranslationMessage({ ...validSubtitle, pageSession: 'page-123' })).toBe(true)

    for (const invalid of [
      { type: 'wt:translate', mode: 'subtitle', texts: ['Hello'] },
      { type: 'wt:translate', mode: 'input', texts: ['你好'] },
      { ...validInput, texts: ['你好', '世界'] },
      { ...validInput, texts: [] },
      { ...validSubtitle, texts: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...validSubtitle, texts: ['x'.repeat(1501)] },
      { ...validSubtitle, texts: ['x'.repeat(1500), 'y'.repeat(1500), 'z'.repeat(1001)] },
      { ...validInput, page: { title: 't', heading: 'h', site: 'example.com' } },
      { ...validInput, pageId: 'page-1' },
      { ...validInput, manualSelectionId: 'ticket-1' },
      { ...validInput, targetLanguage: 'ja' },
      { ...validSubtitle, sourceLanguage: 'en' },
      { ...validSubtitle, extraField: true },
      { type: 'wt:translate', mode: 'selection', texts: ['Hello'], targetLanguage: 'en' },
    ]) {
      expect(isTranslationMessage(invalid)).toBe(false)
    }

    expect(isTranslationReply({ ok: true, texts: ['你好', ''] }, validSubtitle)).toBe(true)
    expect(isTranslationReply({ ok: true, texts: ['', ''] }, validSubtitle)).toBe(false)
    expect(isTranslationReply({ ok: true, texts: ['Hello, world'] }, validInput)).toBe(true)
    expect(isTranslationReply({ ok: true, texts: ['   '] }, validInput)).toBe(false)
  })

  it('Discord 草稿替换只接受四个字段、UUID 和 6000 字以内的非空文本，回复必须带状态', () => {
    const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const message = {
      type: 'wt:replace-discord-input',
      elementId,
      expectedText: '你好',
      text: 'Hello',
    } as const
    expect(isTranslationMessage(message)).toBe(true)
    expect(isTranslationMessage({ ...message, elementId: elementId.toUpperCase() })).toBe(true)
    expect(isTranslationMessage({ ...message, expectedText: '你'.repeat(6000), text: 'a'.repeat(6000) })).toBe(true)
    for (const invalid of [
      { ...message, elementId: 'not-a-uuid' },
      { ...message, elementId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee' },
      { ...message, expectedText: '' },
      { ...message, text: '' },
      { ...message, expectedText: '你'.repeat(6001) },
      { ...message, text: 'a'.repeat(6001) },
      { ...message, tabId: 7 },
      { ...message, frameId: 0 },
      { ...message, url: 'https://discord.com/channels/@me/1' },
      { ...message, extra: true },
    ]) {
      expect(isTranslationMessage(invalid)).toBe(false)
    }
    expect(isTranslationReply({ ok: true }, message)).toBe(false)
    for (const status of ['ok', 'changed', 'unsupported', 'failed'] as const) {
      expect(isTranslationReply({ ok: true, inputReplacement: status }, message)).toBe(true)
    }
    expect(isTranslationReply({ ok: true, inputReplacement: 'nope' }, message)).toBe(false)
    expect(isTranslationReply({ ok: true, inputReplacement: 'bogus' })).toBe(false)
    expect(
      isTranslationReply(
        { ok: true, inputReplacement: 'bogus' },
        { type: 'wt:cancel-models', requestId: 'req-123' },
      ),
    ).toBe(false)
    expect(isTranslationReply({ ok: true }, { type: 'wt:cancel-models', requestId: 'req-123' })).toBe(true)
  })

  it('聊天草稿替换复用同一组四字段校验，缺状态的回复会被拒绝', () => {
    const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const message = {
      type: 'wt:replace-chat-input',
      elementId,
      expectedText: '你好',
      text: 'Hello',
    } as const
    expect(isTranslationMessage(message)).toBe(true)
    expect(isTranslationMessage({ ...message, url: 'https://chatgpt.com/c/1' })).toBe(false)
    expect(isTranslationMessage({ ...message, extra: true })).toBe(false)
    expect(isTranslationReply({ ok: true }, message)).toBe(false)
    expect(isTranslationReply({ ok: true, inputReplacement: 'ok' }, message)).toBe(true)
    expect(isTranslationReply({ ok: true, inputReplacement: 'changed' }, message)).toBe(true)
  })
})

describe('wt:open-text-window 消息契约', () => {
  it('仅接受无附加字段的请求，拒绝 text/url/section 等多余字段与空请求', () => {
    expect(isTranslationMessage({ type: 'wt:open-text-window' })).toBe(true)
    expect(isTranslationMessage({})).toBe(false)
    expect(isTranslationMessage({ type: 'wt:open-text-window', text: 'hi' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:open-text-window', url: 'https://x' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:open-text-window', section: 'model' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:open-text-window', extra: true })).toBe(false)
  })

  it('确认回复被接受，错误回复需带字符串 error', () => {
    const message = { type: 'wt:open-text-window' } as const
    expect(isTranslationReply({ ok: true }, message)).toBe(true)
    expect(isTranslationReply({ ok: false, error: '失败' }, message)).toBe(true)
    expect(isTranslationReply({ ok: 'true' }, message)).toBe(false)
    expect(isTranslationReply({ ok: false }, message)).toBe(false)
  })
})

describe('wt:translate-text 消息契约', () => {
  const valid = {
    type: 'wt:translate-text',
    text: 'Hello **world**\n第二行',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    requestId: 'req-text-1',
  } as const

  it('接受合法消息与可选 pageSession', () => {
    expect(isTranslationMessage(valid)).toBe(true)
    expect(isTranslationMessage({ ...valid, pageSession: 'page-1' })).toBe(true)
    expect(isTranslationMessage({ ...valid, sourceLanguage: 'ja', targetLanguage: 'en' })).toBe(true)
    expect(isTranslationMessage({ ...valid, text: '  padded  ' })).toBe(true)
    expect(isTranslationMessage({ ...valid, text: 'x'.repeat(6000) })).toBe(true)
  })

  it('拒绝空白、超长、非法语言、非法 requestId 与未知字段', () => {
    for (const invalid of [
      { ...valid, text: '' },
      { ...valid, text: '   ' },
      { ...valid, text: 'x'.repeat(6001) },
      { ...valid, text: 42 },
      { ...valid, text: undefined },
      { ...valid, sourceLanguage: 'xx' },
      { ...valid, sourceLanguage: undefined },
      { ...valid, targetLanguage: 'zh' },
      { ...valid, targetLanguage: 'zh-Hans' },
      { ...valid, requestId: 'bad id!' },
      { ...valid, requestId: '' },
      { ...valid, requestId: undefined },
      { ...valid, pageSession: 'bad id!' },
      { ...valid, pageSession: 7 },
      { ...valid, extra: true },
      { ...valid, texts: ['hi'] },
      { type: 'wt:translate-text', text: 'hi', sourceLanguage: 'auto', targetLanguage: 'zh-CN' },
      { type: 'wt:translate-text' },
    ]) {
      expect(isTranslationMessage(invalid)).toBe(false)
    }
  })

  it('回复要求恰好一条非空译文', () => {
    expect(isTranslationReply({ ok: true, texts: ['你好'] }, valid)).toBe(true)
    expect(isTranslationReply({ ok: true, texts: [' 译 '] }, valid)).toBe(true)
    for (const reply of [
      { ok: true },
      { ok: true, texts: [] },
      { ok: true, texts: ['a', 'b'] },
      { ok: true, texts: ['   '] },
      { ok: true, texts: [42] },
      { ok: true, texts: 'a' },
      { ok: false },
    ]) {
      expect(isTranslationReply(reply, valid)).toBe(false)
    }
    expect(isTranslationReply({ ok: false, error: '失败' }, valid)).toBe(true)
    expect(isTranslationReply({ ok: false, error: '失败', code: 'cancelled' }, valid)).toBe(true)
  })
})

describe('wt:document-input 消息契约', () => {
  const elementId = '123e4567-e89b-42d3-a456-426614174000'
  const read = { type: 'wt:document-input', elementId, action: 'read' } as const
  const replace = {
    type: 'wt:document-input',
    elementId,
    action: 'replace',
    expectedText: '原文',
    text: '译文',
  } as const

  it('接受合法 read/replace 消息', () => {
    expect(isTranslationMessage(read)).toBe(true)
    expect(isTranslationMessage(replace)).toBe(true)
    expect(isTranslationMessage({ ...replace, expectedText: 'x'.repeat(6000) })).toBe(true)
    expect(isTranslationMessage({ ...replace, expectedText: 'x'.repeat(18000) })).toBe(true)
    expect(isTranslationMessage({ ...replace, text: 'x'.repeat(18000) })).toBe(true)
  })

  it('拒绝非法 elementId、action、长度与未知字段', () => {
    for (const invalid of [
      { ...read, elementId: 'not-a-uuid' },
      { ...read, elementId: '' },
      { ...read, elementId: 7 },
      { ...read, action: 'delete' },
      { ...read, action: undefined },
      { ...read, expectedText: 'x' },
      { ...read, text: 'x' },
      { ...read, extra: 1 },
      { ...replace, expectedText: '' },
      { ...replace, expectedText: 'x'.repeat(18001) },
      { ...replace, expectedText: undefined },
      { ...replace, text: '' },
      { ...replace, text: 'x'.repeat(18001) },
      { ...replace, text: undefined },
      { ...replace, extra: true },
      { type: 'wt:document-input', elementId, action: 'read', text: 'x' },
    ]) {
      expect(isTranslationMessage(invalid)).toBe(false)
    }
  })

  it('回复按 action 校验 editor 形状、状态与长度', () => {
    const okRead = { ok: true, editor: { status: 'ok', text: '文本', canReplace: true } }
    const okReplace = { ok: true, editor: { status: 'ok', text: 'x'.repeat(18000), canReplace: true } }
    expect(isTranslationReply(okRead, read)).toBe(true)
    expect(isTranslationReply(okRead, replace)).toBe(true)
    expect(isTranslationReply(okReplace, replace)).toBe(true)
    expect(isTranslationReply({ ok: true, editor: { status: 'changed' } }, read)).toBe(true)
    expect(isTranslationReply({ ok: true, editor: { status: 'unsupported' } }, replace)).toBe(true)
    expect(isTranslationReply({ ok: true, editor: { status: 'failed' } }, read)).toBe(true)
    for (const reply of [
      { ok: true },
      { ok: true, editor: undefined },
      { ok: true, editor: 'ok' },
      { ok: true, editor: { status: 'bogus' } },
      { ok: true, editor: { status: 'changed', extra: 1 } },
      { ok: true, editor: { status: 'ok', text: 'x'.repeat(6001), canReplace: true } },
      { ok: true, editor: { status: 'ok', text: 'ok', canReplace: 'yes' } },
      { ok: true, editor: { status: 'ok', text: 'ok' } },
      { ok: true, editor: { status: 'ok', text: 1, canReplace: true } },
    ]) {
      expect(isTranslationReply(reply, read)).toBe(false)
    }
    expect(
      isTranslationReply(
        { ok: true, editor: { status: 'ok', text: 'x'.repeat(6001), canReplace: true } },
        replace,
      ),
    ).toBe(true)
    expect(
      isTranslationReply(
        { ok: true, editor: { status: 'ok', text: 'x'.repeat(18001), canReplace: true } },
        replace,
      ),
    ).toBe(false)
    expect(isTranslationReply({ ok: false, error: '失败' }, read)).toBe(true)
    expect(isTranslationReply({ ok: false }, read)).toBe(false)
  })
})
