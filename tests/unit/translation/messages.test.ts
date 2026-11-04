import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import {
  isContentTranslationMessage,
  isContentTranslationReply,
  isTranslationMessage,
  isTranslationReply,
  NO_SELECTION_ERROR,
} from '../../../src/translation/messages'

describe('wt:read-selection 消息与回复校验', () => {
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
})
