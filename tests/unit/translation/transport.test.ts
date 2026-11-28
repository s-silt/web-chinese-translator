import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../../src/translation/request-options'
import { requestCompletion, requestCompletionStream, setCompletionUsageObserver, unwrapFence } from '../../../src/translation/transport'

describe('unwrapFence', () => {
  it('剥掉 ``` 与 ```json 围栏，返回内部 JSON', () => {
    expect(unwrapFence('```json\n["你好"]\n```')).toBe('["你好"]')
    expect(unwrapFence('```\n{"a":1}\n```')).toBe('{"a":1}')
    expect(unwrapFence('  ```json\n[1]\n```  ')).toBe('[1]')
    expect(unwrapFence('```json   \n[1]\n```')).toBe('[1]')
    expect(unwrapFence('```\r\n[1]\r\n```')).toBe('[1]')
  })

  it('非围栏、非 json 标签、未闭合围栏原样返回', () => {
    expect(unwrapFence('plain text')).toBe('plain text')
    expect(unwrapFence('```rust\ncode\n```')).toBe('```rust\ncode\n```')
    expect(unwrapFence('```JSON\n[1]\n```')).toBe('```JSON\n[1]\n```')
    expect(unwrapFence('```\n[1]\n``')).toBe('```\n[1]\n``')
    expect(unwrapFence('```')).toBe('```')
    expect(unwrapFence('``````')).toBe('``````')
  })

  it('围栏内含空行与反引号仍按首尾围栏剥离', () => {
    expect(unwrapFence('```\n\n\n[1]\n\n\n```')).toBe('[1]')
    expect(unwrapFence('```\nuse `code` here\n```')).toBe('use `code` here')
    expect(unwrapFence('```\n```inner```\n```')).toBe('```inner```')
  })

  it('未闭合围栏后跟超长空白不回溯（ReDoS 回归）', () => {
    const hostile = '```\n' + '\n'.repeat(500_000) + 'x'
    const started = performance.now()
    expect(unwrapFence(hostile)).toBe(hostile)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('闭合围栏内超长空白也保持线性耗时', () => {
    const fenced = '```\n' + '\n'.repeat(200_000) + '```'
    const started = performance.now()
    expect(unwrapFence(fenced)).toBe('')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('开头围栏行的超长空白同样线性耗时', () => {
    const hostile = '```' + ' '.repeat(500_000) + '\n```'
    const started = performance.now()
    expect(unwrapFence(hostile)).toBe('')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('流式译文收尾', () => {
  const config = { baseUrl: 'https://stream.example/v1', model: 'fixture', apiType: 'responses' as const,
    temperature: null, requestParams: {} }

  function stream(chunks: string[]): Response {
    const encoder = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }

  it('Responses 跨分块且末行无换行时仍交付完整译文', async () => {
    const response = stream(['data: {"type":"response.output_text.', 'delta","delta":"末行"}\n', 'data: {"type":"response.completed"}'])
    const delta = vi.fn()
    await expect(requestCompletionStream(config, 'sys', 'sample', '', delta, undefined, async () => response))
      .resolves.toBe('末行')
    expect(delta).toHaveBeenCalledExactlyOnceWith('末行', '末行')
  })

  it('部分输出后服务端明确宣告 incomplete 时返回受控错误', async () => {
    const response = stream(['data: {"type":"response.output_text.delta","delta":"片段"}\n',
      'data: {"type":"response.incomplete","error":{"message":"synthetic-private-marker"}}\n'])
    await expect(requestCompletionStream(config, 'sys', 'sample', '', () => {}, undefined, async () => response))
      .rejects.toMatchObject({ code: 'bad_output', message: '模型未完成翻译，请重试' })
  })

  it.each(['length', 'content_filter', 'tool_calls'])('Chat 停止原因 %s 不会把片段标为成功', async (finish_reason) => {
    const response = stream(['data: {"choices":[{"delta":{"content":"开头"}}]}\n',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}\n\ndata: [DONE]\n`])
    await expect(requestCompletionStream({ ...config, apiType: 'chat-completions' }, 'sys', 'sample', '', vi.fn(), undefined, async () => response))
      .rejects.toMatchObject({ code: 'bad_output' })
  })

  it('Chat 在没有终止事件时拒绝已收到的片段；合法 stop 后可在 EOF 结束', async () => {
    for (const finished of [false, true]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream([
        'data: {"choices":[{"delta":{"content":"译文"}}]}\n',
        finished ? 'data: {"choices":[{"finish_reason":"stop"}]}\n' : '',
      ]))
      const pending = requestCompletionStream({ ...config, apiType: 'chat-completions' }, 'sys', 'sample', '', vi.fn(), undefined, fetcher)
      if (finished) await expect(pending).resolves.toBe('译文')
      else await expect(pending).rejects.toMatchObject({ code: 'bad_output' })
    }
  })

  it.each([
    ['https://api.openai.com/v1', undefined, true],
    ['https://api.deepseek.com', undefined, false],
    ['https://api.anthropic.com/v1', undefined, false],
    ['https://generativelanguage.googleapis.com/v1beta/openai', undefined, false],
    ['http://localhost:11434/v1', undefined, false],
    ['http://localhost:1234/v1', undefined, false],
    ['https://gateway.example/v1', undefined, false],
    ['https://gateway.example/v1', true, true],
    ['https://api.openai.com/v1', false, false],
  ] as const)('Chat 流式用量按实际接口与显式选项发送一次 %s / %s', async (baseUrl, configured, expected) => {
    const observer = vi.fn()
    setCompletionUsageObserver(observer)
    const options: JsonObject = configured === undefined ? {} : { stream_options: { include_usage: configured } }
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { stream_options?: { include_usage: boolean } }
      if (!expected && 'stream_options' in body) return new Response(null, { status: 400 })
      expect(body.stream_options?.include_usage === true).toBe(expected)
      return stream(['data: {"choices":[{"delta":{"content":"译文"},"finish_reason":"stop"}]}\n',
        expected ? 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n' : '',
        'data: [DONE]\n'])
    })
    try {
      await expect(requestCompletionStream({ ...config, apiType: 'chat-completions', baseUrl, requestParams: options }, 'sys', 'text', '', vi.fn(), undefined, fetcher)).resolves.toBe('译文')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(observer).toHaveBeenCalledExactlyOnceWith(expected ? { inputTokens: 9, outputTokens: 3, totalTokens: 12 } : undefined, 4)
    } finally {
      setCompletionUsageObserver(undefined)
    }
  })

  it('显式流式用量参数不进入普通连接测试或 Responses 请求', async () => {
    const requestParams = { stream_options: { include_usage: true } }
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { stream_options?: unknown; stream: boolean }
      expect(body).not.toHaveProperty('stream_options')
      return body.stream
        ? stream(['data: {"type":"response.output_text.delta","delta":"译文"}\ndata: {"type":"response.completed"}\n'])
        : Response.json({ choices: [{ message: { content: '译文' } }] })
    })
    await expect(requestCompletion({ ...config, apiType: 'chat-completions', requestParams }, 'sys', 'text', '', undefined, fetcher)).resolves.toBe('译文')
    await expect(requestCompletionStream({ ...config, requestParams }, 'sys', 'text', '', vi.fn(), undefined, fetcher)).resolves.toBe('译文')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each<JsonObject>([{ include_usage: 'yes' }, { include_usage: true, other: true }])('拒绝非布尔或额外流式选项 %#', async (streamOptions) => {
    const fetcher = vi.fn<typeof fetch>()
    const requestParams = { stream_options: streamOptions }
    await expect(requestCompletionStream({ ...config, requestParams }, 'sys', 'text', '', vi.fn(), undefined, fetcher))
      .rejects.toThrow('模型请求设置无效')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
