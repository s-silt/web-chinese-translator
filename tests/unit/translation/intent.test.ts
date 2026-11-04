import { describe, expect, it, vi } from 'vitest'
import { canonicalAssistInput, isAssistInput, parseAssistResult, type AssistInput } from '../../../src/translation/intent'
import {
  assistSystemPrompt,
  clearAssistCache,
  getCachedAssistance,
  inferAssistance,
} from '../../../src/translation/intent-provider'
import { CompletionCancelledError } from '../../../src/translation/transport'

const INPUT: AssistInput = {
  text: 'quantum decoherence',
  context: 'The experiment shows quantum decoherence in action.',
  pageTitle: 'Physics article',
  site: 'example.com',
  trigger: 'selection',
  signals: { method: 'mouse', dwellMs: 0, visits: 1 },
}

const CONFIG = { baseUrl: 'https://api.example.com/v1', model: 'm', targetLanguage: 'zh-CN' as const }

function reply(result: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
    status: 200,
  })
}

describe('parseAssistResult', () => {
  it('接受 show 各 intent 与合法 silent', () => {
    for (const intent of ['translate', 'define', 'explain'] as const) {
      expect(parseAssistResult({ decision: 'show', intent, translation: '译文', explanation: '' })).toBeTruthy()
    }
    expect(
      parseAssistResult({ decision: 'silent', intent: 'none', translation: '', explanation: '' }),
    ).toBeTruthy()
  })

  it('拒绝额外字段、类型错误、silent 带内容、show 空内容', () => {
    const bad = [
      { decision: 'show', intent: 'translate', translation: 'a', explanation: '', extra: 1 },
      { decision: 'show', intent: 'bogus', translation: 'a', explanation: '' },
      { decision: 'silent', intent: 'none', translation: 'a', explanation: '' },
      { decision: 'show', intent: 'translate', translation: '', explanation: '' },
      { decision: 'show', intent: 'none', translation: 'a', explanation: '' },
      { decision: 'maybe', intent: 'none', translation: '', explanation: '' },
      'not an object',
    ]
    for (const value of bad) expect(parseAssistResult(value)).toBeUndefined()
  })
})

describe('isAssistInput', () => {
  it('校验 trigger 文本长度与信号范围', () => {
    expect(isAssistInput(INPUT)).toBe(true)
    expect(isAssistInput({ ...INPUT, trigger: 'revisit' })).toBe(false)
    expect(isAssistInput({ ...INPUT, text: 'x'.repeat(6001) })).toBe(false)
    expect(isAssistInput({ ...INPUT, site: 'https://evil.com/x?y=1' })).toBe(false)
    expect(isAssistInput({ ...INPUT, site: '[::1]' })).toBe(true)
    expect(isAssistInput({ ...INPUT, site: '[::1]:8000' })).toBe(false)
    expect(isAssistInput({ ...INPUT, site: 'user@example.com' })).toBe(false)
    expect(isAssistInput({ ...INPUT, signals: { method: 'touch', dwellMs: 0, visits: 1 } })).toBe(false)
    expect(isAssistInput({ ...INPUT, signals: { method: 'mouse', dwellMs: 60001, visits: 1 } })).toBe(false)
  })

  it('requestedIntent 仅允许划词释义或解释', () => {
    expect(isAssistInput({ ...INPUT, requestedIntent: 'define' })).toBe(true)
    expect(isAssistInput({ ...INPUT, requestedIntent: 'explain' })).toBe(true)
    expect(isAssistInput({ ...INPUT, requestedIntent: 'translate' })).toBe(false)
    expect(isAssistInput({ ...INPUT, trigger: 'revisit', text: 'x'.repeat(40), requestedIntent: 'define' })).toBe(false)
    expect(canonicalAssistInput(INPUT)).not.toHaveProperty('requestedIntent')
    expect(canonicalAssistInput({ ...INPUT, requestedIntent: 'define' }).requestedIntent).toBe('define')
  })
})

describe('inferAssistance', () => {
  it('请求体为固定提示词 + 规范化输入；一条 fetch', async () => {
    clearAssistCache()
    const fetcher = vi.fn(async () => reply({ decision: 'show', intent: 'define', translation: '', explanation: '量子退相干' }))
    const result = await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never)
    expect(result.intent).toBe('define')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      messages: { role: string; content: string }[]
    }
    expect(body.messages[0]?.content).toBe(assistSystemPrompt('zh-CN'))
    const payload = JSON.parse(body.messages[1]?.content ?? '') as Record<string, unknown>
    expect(payload).toEqual({
      text: 'quantum decoherence',
      context: INPUT.context,
      pageTitle: INPUT.pageTitle,
      site: 'example.com',
      trigger: 'selection',
    })
    for (const key of ['signals', 'method', 'dwellMs', 'visits']) expect(payload).not.toHaveProperty(key)
  })

  it('本地操作方式与计数变化不外发，也不使相同语境缓存失效', async () => {
    clearAssistCache()
    const fetcher = vi.fn(async () => reply({ decision: 'show', intent: 'define', translation: '退相干', explanation: '' }))
    const context = { currentPage: { title: 'Physics', heading: 'Decoherence', site: 'example.com' }, recentPages: [] }
    await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never, context)
    await inferAssistance(CONFIG, {
      ...INPUT, signals: { method: 'keyboard', dwellMs: 50_000, visits: 3 },
    }, 'k', undefined, fetcher as never, context)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    const payload = JSON.parse(body.messages[1]!.content) as Record<string, unknown>
    expect(payload.currentPage).toEqual(context.currentPage)
    expect(payload).not.toHaveProperty('signals')
    await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never, {
      ...context, currentPage: { ...context.currentPage, title: 'A different topic' },
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('缓存区分 context 不同的相同 text', async () => {
    clearAssistCache()
    const fetcher = vi.fn(async () => reply({ decision: 'show', intent: 'translate', translation: '译', explanation: '' }))
    await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never)
    await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await inferAssistance(CONFIG, { ...INPUT, context: 'other' }, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('相同文本不同源语言不命中同一缓存，不同目标语言也不串用', async () => {
    clearAssistCache()
    const fetcher = vi.fn(async () => reply({ decision: 'show', intent: 'translate', translation: '译', explanation: '' }))
    await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never)
    await inferAssistance({ ...CONFIG, sourceLanguage: 'ja' }, INPUT, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const jaBody = JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    expect(jaBody.messages[0]?.content).toBe(assistSystemPrompt('zh-CN', 'ja'))
    expect(jaBody.messages[0]?.content).toContain('The source language is Japanese.')
    await inferAssistance({ ...CONFIG, targetLanguage: 'en' }, INPUT, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(3)
    await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('显式释义追加规则并拒绝不符的模型输出', async () => {
    clearAssistCache()
    const defineRule = 'The reader explicitly requested a definition. Set decision to "show" and intent to "define". Give a concise definition of the selected term or phrase in the target language, using the supplied context to disambiguate it. Do not choose silence or another intent. If the text cannot be defined reliably, state that briefly in the explanation instead of inventing a meaning.'
    const fetcher = vi.fn(async () => reply({ decision: 'show', intent: 'translate', translation: '译', explanation: '' }))
    await expect(
      inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'define' }, 'k', undefined, fetcher as never),
    ).rejects.toMatchObject({ message: '翻译服务返回格式不正确' })
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    expect(body.messages[0]?.content).toBe(`${assistSystemPrompt('zh-CN')} ${defineRule}`)
    expect(JSON.parse(body.messages[1]?.content ?? '')).toMatchObject({ requestedIntent: 'define' })
    fetcher.mockImplementationOnce(async () => reply({ decision: 'show', intent: 'define', translation: '', explanation: '定义' }))
    await expect(
      inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'define' }, 'k', undefined, fetcher as never),
    ).resolves.toMatchObject({ decision: 'show', intent: 'define' })
  })

  it('自动、释义、解释缓存互相隔离', async () => {
    clearAssistCache()
    const fetcher = vi.fn()
    fetcher.mockResolvedValueOnce(reply({ decision: 'show', intent: 'translate', translation: '译', explanation: '' }))
    fetcher.mockResolvedValueOnce(reply({ decision: 'show', intent: 'define', translation: '', explanation: '定义' }))
    fetcher.mockResolvedValueOnce(reply({ decision: 'show', intent: 'explain', translation: '', explanation: '解释' }))
    const auto = await inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never)
    const defined = await inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'define' }, 'k', undefined, fetcher as never)
    const explained = await inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'explain' }, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(auto.intent).toBe('translate')
    expect(defined.intent).toBe('define')
    expect(explained.intent).toBe('explain')
    const userIntent = (index: number): string | undefined => {
      const body = JSON.parse((fetcher.mock.calls[index] as unknown as [string, RequestInit])[1].body as string) as {
        messages: { content: string }[]
      }
      return (JSON.parse(body.messages[1]?.content ?? '') as { requestedIntent?: string }).requestedIntent
    }
    expect(userIntent(0)).toBeUndefined()
    expect(userIntent(1)).toBe('define')
    expect(userIntent(2)).toBe('explain')
    const system = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    expect(system.messages[0]?.content).toBe(assistSystemPrompt('zh-CN'))
    await expect(inferAssistance(CONFIG, INPUT, 'k', undefined, fetcher as never)).resolves.toMatchObject({ intent: 'translate' })
    await expect(
      inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'define' }, 'k', undefined, fetcher as never),
    ).resolves.toMatchObject({ intent: 'define' })
    await expect(
      inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'explain' }, 'k', undefined, fetcher as never),
    ).resolves.toMatchObject({ intent: 'explain' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('显式释义收到 silent 不缓存，随后正确释义会再次请求', async () => {
    clearAssistCache()
    const fetcher = vi.fn()
    fetcher.mockResolvedValueOnce(reply({ decision: 'silent', intent: 'none', translation: '', explanation: '' }))
    await expect(
      inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'define' }, 'k', undefined, fetcher as never),
    ).rejects.toMatchObject({ message: '翻译服务返回格式不正确' })
    fetcher.mockResolvedValueOnce(reply({ decision: 'show', intent: 'define', translation: '', explanation: '定义' }))
    await expect(
      inferAssistance(CONFIG, { ...INPUT, requestedIntent: 'define' }, 'k', undefined, fetcher as never),
    ).resolves.toMatchObject({ decision: 'show', intent: 'define', explanation: '定义' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('温度、请求头修订号变化使辅助缓存隔离，同义参数键序命中同一缓存，且支持 Responses 协议 output_text', async () => {
    clearAssistCache()
    const rev1 = '11111111-1111-4111-8111-111111111111'
    const rev2 = '22222222-2222-4222-8222-222222222222'
    const showResult = { decision: 'show', intent: 'define', translation: '退相干', explanation: '量子效应' }
    const fetcher = vi.fn(async () => reply(showResult))

    const cfg0 = {
      ...CONFIG,
      temperature: 0,
      requestParams: { b: 1, a: 2 },
      customHeadersRevision: rev1,
    }
    await expect(inferAssistance(cfg0, INPUT, 'k', undefined, fetcher as never)).resolves.toEqual(showResult)
    expect(fetcher).toHaveBeenCalledTimes(1)

    expect(await getCachedAssistance({ ...cfg0, temperature: 1 }, INPUT)).toBeUndefined()
    await inferAssistance({ ...cfg0, temperature: 1 }, INPUT, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(2)

    expect(await getCachedAssistance({ ...cfg0, requestParams: { a: 2, b: 1 } }, INPUT)).toEqual(showResult)
    await inferAssistance({ ...cfg0, requestParams: { a: 2, b: 1 } }, INPUT, 'k', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(2)

    expect(await getCachedAssistance({ ...cfg0, customHeadersRevision: rev2 }, INPUT)).toBeUndefined()

    const responsesFetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'reasoning', summary: [] },
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: JSON.stringify(showResult) }],
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const responsesOut = await inferAssistance(
      { ...CONFIG, apiType: 'responses', requestParams: { reasoning: { effort: 'low' } } },
      INPUT,
      'k',
      undefined,
      responsesFetcher as never,
    )
    expect(responsesOut).toEqual(showResult)
    expect(responsesFetcher).toHaveBeenCalledTimes(1)
    expect((responsesFetcher.mock.calls[0] as unknown as [string])[0]).toBe('https://api.example.com/v1/responses')
  })

  it('大附加参数不挤出二十条辅助结果的内存缓存', async () => {
    clearAssistCache()
    const result = { decision: 'show', intent: 'define', translation: '译文', explanation: '说明' }
    const fetcher = vi.fn(async () => reply(result))
    const config = { ...CONFIG, requestParams: { metadata: { padding: 'x'.repeat(15000) } } }
    for (let i = 0; i < 20; i += 1) {
      await expect(inferAssistance(config, { ...INPUT, text: `Term ${i}` }, '', undefined, fetcher as never))
        .resolves.toEqual(result)
    }
    expect(await getCachedAssistance(config, { ...INPUT, text: 'Term 0' })).toEqual(result)
    await inferAssistance(config, { ...INPUT, text: 'Term 0' }, '', undefined, fetcher as never)
    expect(fetcher).toHaveBeenCalledTimes(20)
  })

  it.each(['abort', 'clear'] as const)('请求摘要计算挂起期间 %s 会拒绝 CompletionCancelledError 且不发起 fetch', async (mode) => {
    clearAssistCache()
    const fetcher = vi.fn(async () => reply({ decision: 'show', intent: 'define', translation: '译', explanation: '' }))
    let release!: (value: ArrayBuffer) => void
    const gate = new Promise<ArrayBuffer>((resolve) => {
      release = resolve
    })
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => gate)
    const controller = new AbortController()
    try {
      const pending = inferAssistance(CONFIG, INPUT, 'k', controller.signal, fetcher as never)
      if (mode === 'abort') controller.abort()
      else clearAssistCache()
      release(new Uint8Array(32).buffer)
      await expect(pending).rejects.toBeInstanceOf(CompletionCancelledError)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      digestSpy.mockRestore()
    }
  })
})
