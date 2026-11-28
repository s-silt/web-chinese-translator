import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachBilingualBlock, attachBilingualNode, isBilingualElement, removeBilingualNode } from '../../../src/translation/bilingual'
import { DEFAULT_TRANSLATION_CONFIG, sanitizeTranslationConfig } from '../../../src/translation/config'
import { exportConfigBackup, parseConfigBackup } from '../../../src/translation/config-backup'
import { createHoverTranslator } from '../../../src/translation/hover-translate'
import {
  findMatchedGlossaryEntries,
  glossarySignature,
  sanitizePromptGlossary,
} from '../../../src/translation/preferences-extra'
import { glossaryPromptInstruction, translationStyleInstruction } from '../../../src/translation/translation-style'
import { requestCompletionStream } from '../../../src/translation/transport'
import { extractCompletionUsage } from '../../../src/translation/usage-stats'

describe('preferences-extra & config sanitization', () => {
  it('sanitizes new fields and falls back safely on invalid input', () => {
    const clean = sanitizeTranslationConfig({
      ...DEFAULT_TRANSLATION_CONFIG,
      displayMode: 'bilingual',
      translationStyle: 'technical',
      hoverTranslateEnabled: true,
      promptGlossary: [
        { source: 'Token', target: 'Token' },
        { source: 'token', target: '词元' }, // duplicate case-insensitive
        { source: '  ', target: 'ignored' },
      ],
      modelProfiles: [
        {
          id: 'p1',
          name: 'DeepSeek Fast',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiType: 'chat-completions',
          temperature: 0.2,
        },
      ],
      activeProfileId: 'p1',
      selectionProfileId: 'p1',
    })
    expect(clean.displayMode).toBe('bilingual')
    expect(clean.translationStyle).toBe('technical')
    expect(clean.hoverTranslateEnabled).toBe(true)
    expect(clean.promptGlossary).toEqual([{ source: 'Token', target: 'Token' }])
    expect(clean.modelProfiles).toHaveLength(1)
    expect(clean.selectionProfileId).toBe('p1')

    const fallback = sanitizeTranslationConfig({
      displayMode: 'invalid',
      translationStyle: 'unknown',
      hoverTranslateEnabled: 'yes',
    })
    expect(fallback.displayMode).toBe('replace')
    expect(fallback.translationStyle).toBe('natural')
    expect(fallback.hoverTranslateEnabled).toBe(false)
  })

  it('matches only glossary terms present in texts and computes stable signatures', () => {
    const glossary = sanitizePromptGlossary([
      { source: 'Token', target: 'Token' },
      { source: 'Repository', target: '仓库' },
      { source: 'Agent', target: '智能体' },
    ])
    const matched = findMatchedGlossaryEntries(glossary, ['Each token is billed per request in this repository.'])
    expect(matched.map((item) => item.source)).toEqual(['Token', 'Repository'])
    expect(glossarySignature(glossary)).toBe(glossarySignature([...glossary].reverse()))
  })
})

describe('translation-style & glossary prompt instruction', () => {
  it('adds style-specific guidance for technical/academic/concise while preserving natural baseline', () => {
    const natural = translationStyleInstruction('zh-CN', 'natural')
    const technical = translationStyleInstruction('zh-CN', 'technical')
    const academic = translationStyleInstruction('zh-CN', 'academic')
    const concise = translationStyleInstruction('zh-CN', 'concise')
    expect(technical.startsWith(natural)).toBe(true)
    expect(technical).toContain('CLI flags')
    expect(academic).toContain('academic')
    expect(concise).toContain('compact')
    expect(glossaryPromptInstruction([{ source: 'PR', target: 'PR' }])).toContain('"PR" => "PR"')
    expect(glossaryPromptInstruction([])).toBe('')
  })
})

describe('config-backup', () => {
  it('exports JSON without secrets and round-trips safely', () => {
    const exported = exportConfigBackup({
      ...DEFAULT_TRANSLATION_CONFIG,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      customHeadersRevision: '11111111-1111-1111-1111-111111111111',
      displayMode: 'bilingual',
      translationStyle: 'academic',
    })
    expect(exported).not.toContain('11111111-1111-1111-1111-111111111111')
    expect(exported).toContain('"excludesSecrets": true')
    const parsed = parseConfigBackup(exported)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.config.displayMode).toBe('bilingual')
      expect(parsed.config.translationStyle).toBe('academic')
      expect(parsed.config.customHeadersRevision).toBe('')
    }
    expect(parseConfigBackup('not-json').ok).toBe(false)
    expect(parseConfigBackup(JSON.stringify({ version: 99, config: {} })).ok).toBe(false)
  })
})

describe('usage-stats extraction', () => {
  it('extracts OpenAI and Anthropic style token usage', () => {
    expect(extractCompletionUsage({ usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    })
    expect(extractCompletionUsage({ usage: { input_tokens: 80, output_tokens: 20 } })).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    })
    expect(extractCompletionUsage({})).toBeUndefined()
  })
})

describe('SSE streaming transport', () => {
  it('streams OpenAI chat completion delta chunks and returns accumulated text', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const fetcher = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    const deltas: string[] = []
    const full = await requestCompletionStream(
      { baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiType: 'chat-completions', temperature: null, requestParams: {} },
      'sys',
      'Hello, world',
      'sk-test',
      (delta) => deltas.push(delta),
      undefined,
      fetcher as unknown as typeof fetch,
    )
    expect(deltas).toEqual(['你好', '，世界'])
    expect(full).toBe('你好，世界')
  })

  it('gracefully falls back when endpoint returns standard JSON', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '完整响应' } }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    const deltas: string[] = []
    const full = await requestCompletionStream(
      { baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiType: 'chat-completions', temperature: null, requestParams: {} },
      'sys',
      'Hello',
      'sk-test',
      (delta) => deltas.push(delta),
      undefined,
      fetcher as unknown as typeof fetch,
    )
    expect(deltas).toEqual(['完整响应'])
    expect(full).toBe('完整响应')
  })
})

describe('bilingual DOM rendering & hover-translate', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('attaches and cleanly removes bilingual translation elements', () => {
    const p = document.createElement('p')
    const text = document.createTextNode('Original paragraph')
    p.appendChild(text)
    document.body.appendChild(p)

    const el = attachBilingualNode(text, '中文对照段落')
    expect(el).toBeDefined()
    expect(isBilingualElement(el!)).toBe(true)
    expect(p.textContent).toContain('Original paragraph')
    expect(p.textContent).toContain('中文对照段落')

    removeBilingualNode(el)
    expect(p.querySelector('[data-wt-bilingual="1"]')).toBeNull()
    expect(p.textContent).toBe('Original paragraph')
  })

  it('ignores synthetic Alt+hover events from page scripts', async () => {
    vi.useFakeTimers()
    const p = document.createElement('p')
    p.textContent = 'Hover me with Alt pressed'
    document.body.appendChild(p)

    const translateText = vi.fn(async () => '按住 Alt 悬停翻译结果')
    const hover = createHoverTranslator({
      isEnabled: () => true,
      displayMode: () => 'bilingual',
      translateText,
    })

    p.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey: true }))
    await vi.advanceTimersByTimeAsync(200)
    expect(translateText).not.toHaveBeenCalled()
    expect(p.getAttribute('data-wt-hover-translated')).toBeNull()
    expect(document.body.querySelector('[data-wt-bilingual="1"]')).toBeNull()

    hover.dispose()
  })
})

describe('Anthropic native SSE & bilingual block micro-interaction', () => {
  it('parses Anthropic content_block_delta text_delta events', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"流式"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"译文"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'))
        controller.close()
      },
    })
    const fetcher = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    const chunks: string[] = []
    const full = await requestCompletionStream(
      { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', apiType: 'chat-completions', temperature: null, requestParams: {} },
      'sys',
      'streamed text',
      'sk-ant',
      (delta) => chunks.push(delta),
      undefined,
      fetcher as unknown as typeof fetch,
    )
    expect(chunks).toEqual(['流式', '译文'])
    expect(full).toBe('流式译文')
  })

  it('attaches bilingual block preserving rich inline markup and toggles dim state on click', () => {
    const p = document.createElement('p')
    p.innerHTML = 'Read <a href="https://example.com">the <strong>guide</strong></a> now.'
    document.body.appendChild(p)

    const el = attachBilingualBlock(p, '立即阅读指南。')
    expect(el).toBeDefined()
    expect(p.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(p.querySelector('strong')?.textContent).toBe('guide')
    expect(el!.getAttribute('data-wt-bilingual-collapsed')).toBeNull()

    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(el!.getAttribute('data-wt-bilingual-collapsed')).toBe('1')

    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(el!.getAttribute('data-wt-bilingual-collapsed')).toBeNull()

    removeBilingualNode(el)
    expect(p.querySelector('[data-wt-bilingual="1"]')).toBeNull()
  })
})
