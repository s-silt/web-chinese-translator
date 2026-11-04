import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  contextualTranslationSystemPrompt,
  translateTexts,
  translateTextsPartial,
  translationSystemPrompt,
  TranslationError,
} from '../../../src/translation/provider'
import { CompletionCancelledError, requestModelList } from '../../../src/translation/transport'
import { MAX_DISCOVERED_MODELS } from '../../../src/translation/config'
import { sourceLanguageInstruction } from '../../../src/translation/target-language'

const CONFIG = { baseUrl: 'https://api.example.com/v1', model: 'test-model', targetLanguage: 'zh-CN' as const }

function completion(texts: readonly string[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fetchWith(response: Response | (() => Response)): ReturnType<typeof vi.fn> {
  return vi.fn(async () => (typeof response === 'function' ? response() : response.clone()))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('translateTexts 请求', () => {
  it('POST 完整地址，body 严格为 system+user+stream:false', async () => {
    const fetcher = fetchWith(completion(['你好']))
    await translateTexts(CONFIG, ['Hello'], 'key', fetcher as never)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.referrerPolicy).toBe('no-referrer')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: translationSystemPrompt('zh-CN') },
        { role: 'user', content: '["Hello"]' },
      ],
      stream: false,
    })
    expect('temperature' in body).toBe(false)
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe('Bearer key')
  })

  it('Responses 协议使用 /v1/responses 请求体与自定义请求头，并拼接 assistant output_text', async () => {
    const fetcher = fetchWith(
      jsonResponse({
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'THIS MUST NOT BECOME TRANSLATION' }] },
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: '["你' },
              { type: 'output_text', text: '好"]' },
            ],
          },
        ],
      }),
    )
    const result = await translateTexts(
      {
        ...CONFIG,
        apiType: 'responses',
        temperature: 0,
        requestParams: { reasoning: { effort: 'medium' } },
        customHeaders: { 'X-Api-Key': ' key-val ' },
      },
      ['Hello'],
      '',
      fetcher as never,
    )
    expect(result).toEqual(['你好'])
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/responses')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toEqual({
      reasoning: { effort: 'medium' },
      model: 'test-model',
      instructions: translationSystemPrompt('zh-CN'),
      input: [{ role: 'user', content: [{ type: 'input_text', text: '["Hello"]' }] }],
      stream: false,
      store: false,
      temperature: 0,
    })
    expect('messages' in body).toBe(false)
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('key-val')
    expect('Authorization' in headers).toBe(false)
  })

  it('Responses 协议默认 null 温度不发送 temperature 字段', async () => {
    const fetcher = fetchWith(
      jsonResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '["你好"]' }],
          },
        ],
      }),
    )
    await translateTexts({ ...CONFIG, apiType: 'responses', temperature: null }, ['Hello'], '', fetcher as never)
    const body = JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect('temperature' in body).toBe(false)
  })

  it('非法高级参数或请求头在发起 fetch 前立即拒绝', async () => {
    const fetcher = fetchWith(completion(['你好']))
    await expect(
      translateTexts({ ...CONFIG, requestParams: { model: 'override' } }, ['Hello'], '', fetcher as never),
    ).rejects.toThrow(TranslationError)
    await expect(
      translateTexts({ ...CONFIG, customHeaders: { Authorization: 'Bearer x' } }, ['Hello'], '', fetcher as never),
    ).rejects.toThrow(TranslationError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(
    (['chat-completions', 'responses'] as const).flatMap((apiType) =>
      (
        [
          'functions',
          'function_call',
          'prompt',
          'web_search_options',
          'modalities',
          'audio',
          'n',
          'stream_options',
        ] as const
      ).map((key) => [apiType, key] as const),
    ),
  )('受限附加参数 %s / %s 在发起 fetch 前拒绝', async (apiType, key) => {
    const fetcher = fetchWith(completion(['你好']))
    await expect(
      translateTexts(
        { ...CONFIG, apiType, requestParams: { [key]: true } },
        ['Hello'],
        '',
        fetcher as never,
      ),
    ).rejects.toThrow(TranslationError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('空 key 不发 Authorization', async () => {
    const fetcher = fetchWith(completion(['你好']))
    await translateTexts(CONFIG, ['Hello'], '', fetcher as never)
    const headers = (fetcher.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect('Authorization' in headers).toBe(false)
  })

  it('auto 源语言的 system 与冻结提示词哈希一致', async () => {
    expect(sourceLanguageInstruction()).toBe('')
    expect(sourceLanguageInstruction('auto')).toBe('')

    const fetcher = fetchWith(completion(['你好']))
    await translateTexts({ ...CONFIG, sourceLanguage: 'auto' }, ['Hello'], 'key', fetcher as never)
    const body = JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    const content = body.messages[0]?.content ?? ''
    expect(createHash('sha256').update(content).digest('hex')).toBe(
      'd1bb8fd225a1d66c86283fff67b624edfbd99847ef5909a5dc943e820fd2c5f8',
    )
    expect(content).not.toContain('The source language is')

    const context = {
      currentPage: { title: 't', heading: 'h', site: 'example.com' },
      recentPages: [{ title: 'r', heading: 'rh', site: 'other.example' }],
    }
    const contextual = fetchWith(completion(['你好']))
    await translateTexts({ ...CONFIG, sourceLanguage: 'auto' }, ['Hello'], 'key', contextual as never, undefined, context)
    const contextBody = JSON.parse((contextual.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    const contextContent = contextBody.messages[0]?.content ?? ''
    expect(createHash('sha256').update(contextContent).digest('hex')).toBe(
      '7c01ca1c337a6acae1cc92ddf438dc0dcd1210925e9cd465b2e0cad1ca9e6f75',
    )
    expect(contextContent).not.toContain('The source language is')
  })

  it('手动源语言写入 system，语境版同样带上且只多一段说明', async () => {
    const jaFetcher = fetchWith(completion(['Hello']))
    await translateTexts({ ...CONFIG, targetLanguage: 'en', sourceLanguage: 'ja' }, ['こんにちは'], 'key', jaFetcher as never)
    const jaBody = JSON.parse((jaFetcher.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    const jaBase = translationSystemPrompt('en')
    const jaHint = sourceLanguageInstruction('ja')
    expect(jaBody.messages[0]?.content).toBe(`${jaBase} ${jaHint}`)
    expect(jaBody.messages[0]?.content.length).toBe(jaBase.length + 1 + jaHint.length)

    const context = { currentPage: { title: 't', heading: 'h', site: 'example.com' }, recentPages: [] }
    const koFetcher = fetchWith(completion(['안녕']))
    await translateTexts(
      { ...CONFIG, targetLanguage: 'zh-CN', sourceLanguage: 'ko' },
      ['안녕하세요'],
      'key',
      koFetcher as never,
      undefined,
      context,
    )
    const koBody = JSON.parse((koFetcher.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    const koBase = contextualTranslationSystemPrompt('zh-CN')
    const koHint = sourceLanguageInstruction('ko')
    expect(koBody.messages[0]?.content).toBe(`${koBase} ${koHint}`)
    expect(koBody.messages[0]?.content).toContain('The source language is Korean.')
    expect(koBody.messages[1]?.content).toContain('안녕하세요')
  })

  it('未配置接口地址时报固定错误，不发请求', async () => {
    const fetcher = fetchWith(completion(['x']))
    await expect(translateTexts({ baseUrl: '', model: 'm', targetLanguage: 'zh-CN' as const }, ['a'], '', fetcher as never)).rejects.toThrow(
      TranslationError,
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('translateTexts 响应解析', () => {
  it('正常返回数组', async () => {
    const fetcher = fetchWith(completion(['你好', '世界']))
    await expect(translateTexts(CONFIG, ['Hello', 'World'], '', fetcher as never)).resolves.toEqual(['你好', '世界'])
  })

  it('接受外层代码围栏包裹的 JSON', async () => {
    const fenced = jsonResponse({ choices: [{ message: { content: '```json\n["你好"]\n```' } }] })
    await expect(translateTexts(CONFIG, ['Hello'], '', fetchWith(fenced) as never)).resolves.toEqual(['你好'])
  })

  it('JSON 非法、条数不符、空串、纯空白、非数组都报格式错误', async () => {
    for (const content of ['not json', '["a","b"]', '[]', '[""]', '["   "]', '[123]', '{"a":1}']) {
      const fetcher = fetchWith(jsonResponse({ choices: [{ message: { content } }] }))
      await expect(translateTexts(CONFIG, ['x'], '', fetcher as never)).rejects.toThrow('翻译服务返回格式不正确')
    }
    const missing = fetchWith(jsonResponse({ choices: [] }))
    await expect(translateTexts(CONFIG, ['x'], '', missing as never)).rejects.toThrow('翻译服务返回格式不正确')
  })

  it.each(['incomplete', 'failed', 'in_progress'] as const)(
    'Responses 协议拒绝非 completed 的顶层状态：%s',
    async (status) => {
      const fetcher = fetchWith(
        jsonResponse({
          status,
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '["你好"]' }],
            },
          ],
        }),
      )
      await expect(translateTexts({ ...CONFIG, apiType: 'responses' }, ['Hello'], '', fetcher as never)).rejects.toMatchObject({
        code: 'bad_output',
      })
    },
  )

  it('Responses 协议拒绝 refusal、仅工具调用、顶层 error/incomplete_details、未完成消息、缺失 output 或仅扁平 output_text', async () => {
    const invalidPayloads = [
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'no' }],
          },
        ],
      },
      {
        status: 'completed',
        output: [{ type: 'function_call', name: 'tool', arguments: '{}' }],
      },
      {
        status: 'completed',
        error: { message: 'failed' },
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '["你好"]' }],
          },
        ],
      },
      {
        status: 'completed',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '["你好"]' }],
          },
        ],
      },
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'incomplete',
            content: [{ type: 'output_text', text: '["你好"]' }],
          },
        ],
      },
      { status: 'completed' },
      { status: 'completed', output_text: '["你好"]' },
    ]
    for (const payload of invalidPayloads) {
      const fetcher = fetchWith(jsonResponse(payload))
      await expect(
        translateTexts({ ...CONFIG, apiType: 'responses' }, ['Hello'], '', fetcher as never),
      ).rejects.toMatchObject({ code: 'bad_output' })
    }
  })

  it('translateTexts 严格：任一项不合格都报错；translateTextsPartial 保留合格项', async () => {
    const content = '["甲","","丙",5]'
    const strict = fetchWith(jsonResponse({ choices: [{ message: { content } }] }))
    await expect(translateTexts(CONFIG, ['a', 'b', 'c', 'd'], '', strict as never)).rejects.toThrow('翻译服务返回格式不正确')
    const lenient = fetchWith(jsonResponse({ choices: [{ message: { content } }] }))
    await expect(translateTextsPartial(CONFIG, ['a', 'b', 'c', 'd'], '', lenient as never)).resolves.toEqual([
      '甲',
      undefined,
      '丙',
      undefined,
    ])
  })

  it('translateTextsPartial 在条数不符或全部不合格时仍报错', async () => {
    for (const content of ['["甲"]', '["",""]', 'not json']) {
      const fetcher = fetchWith(jsonResponse({ choices: [{ message: { content } }] }))
      await expect(translateTextsPartial(CONFIG, ['a', 'b'], '', fetcher as never)).rejects.toThrow('翻译服务返回格式不正确')
    }
  })

  it('HTTP 状态映射固定错误且不包含响应体与密钥', async () => {
    const cases: [number, string][] = [
      [401, '凭证无效或没有访问权限'],
      [403, '凭证无效或没有访问权限'],
      [429, '请求过于频繁，请稍后重试'],
      [500, '模型服务暂时不可用，请稍后重试'],
      [503, '模型服务暂时不可用，请稍后重试'],
      [404, '接口地址或模型不存在（HTTP 404）'],
      [400, '翻译请求失败（HTTP 400）'],
    ]
    for (const [status, message] of cases) {
      const fetcher = fetchWith(new Response('secret-body sk-leaked', { status }))
      const error = await translateTexts(CONFIG, ['x'], 'sk-secret', fetcher as never).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TranslationError)
      expect((error as Error).message).toBe(message)
      expect((error as Error).message).not.toContain('secret-body')
      expect((error as Error).message).not.toContain('sk-secret')
    }
  })

  it('响应超过 1MiB 拒绝（无 Content-Length 也截断流）', async () => {
    const big = 'x'.repeat(1048577)
    const fetcher = fetchWith(new Response(big))
    await expect(translateTexts(CONFIG, ['x'], '', fetcher as never)).rejects.toThrow('响应过大')
  })

  it('Content-Length 超限时直接拒绝', async () => {
    const fetcher = fetchWith(new Response('x', { headers: { 'Content-Length': '2000000' } }))
    await expect(translateTexts(CONFIG, ['x'], '', fetcher as never)).rejects.toThrow('响应过大')
  })

  it('短内容约 18 秒超时中止并定时器被清理', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )
    const pending = translateTexts(CONFIG, ['x'], '', fetcher as never)
    const assertion = expect(pending).rejects.toThrow('请求超时，请稍后重试')
    await vi.advanceTimersByTimeAsync(18_100)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fetch 网络异常映射为连接错误', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED sk-secret')
    })
    const error = await translateTexts(CONFIG, ['x'], 'sk-secret', fetcher as never).catch((e: unknown) => e)
    expect((error as Error).message).toBe('无法连接翻译服务')
  })
})

describe('requestModelList 模型发现请求与解析', () => {
  it('GET /models 地址，携带 Accept、Authorization 与自定义头，安全选项齐全且无 body', async () => {
    const fetcher = fetchWith(
      jsonResponse({
        object: 'list',
        data: [
          { id: 'gpt-4o' },
          { id: ' claude-3-5-sonnet ' },
          { id: 'gpt-4o' },
          { id: '' },
          { id: '   ' },
          { id: 'bad\nmodel' },
          { id: 'x'.repeat(201) },
          { name: 'missing-id' },
          null,
        ],
      }),
    )
    const models = await requestModelList(
      { baseUrl: 'https://api.example.com/v1/responses', customHeaders: { 'X-Custom-Header': ' custom-val ' } },
      'sk-test-token',
      undefined,
      fetcher as never,
    )
    expect(models).toEqual(['claude-3-5-sonnet', 'gpt-4o'])
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/models')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.cache).toBe('no-store')
    expect('body' in init).toBe(false)
    const headers = init.headers as Headers
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer sk-test-token')
    expect(headers.get('x-custom-header')).toBe('custom-val')
  })

  it('空 data 数组返回空列表，空 key 不发 Authorization', async () => {
    const fetcher = fetchWith(jsonResponse({ data: [] }))
    const models = await requestModelList({ baseUrl: 'https://api.example.com' }, '', undefined, fetcher as never)
    expect(models).toEqual([])
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/models')
    const headers = init.headers as Headers
    expect(headers.get('authorization')).toBeNull()
  })

  it('非法地址或非法自定义头在 fetch 前拒绝', async () => {
    const fetcher = fetchWith(jsonResponse({ data: [] }))
    await expect(
      requestModelList({ baseUrl: 'http://evil.example/v1' }, '', undefined, fetcher as never),
    ).rejects.toThrow('请先配置有效的接口地址')
    await expect(
      requestModelList(
        { baseUrl: 'https://api.example.com/v1', customHeaders: { Authorization: 'Bearer x' } },
        '',
        undefined,
        fetcher as never,
      ),
    ).rejects.toThrow('自定义请求头无效，请检查高级设置')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('无 data、data 非数组、非法 JSON、只有无效 id 或超过上限时拒绝', async () => {
    for (const body of ['not-json', '{}', '{"data":null}', '{"data":"bad"}', '{"data":[{"id":"  "},{"id":"a\\nb"}]}']) {
      const fetcher = fetchWith(new Response(body, { status: 200 }))
      await expect(
        requestModelList({ baseUrl: 'https://api.example.com/v1' }, '', undefined, fetcher as never),
      ).rejects.toMatchObject({
        message: '接口未返回有效的模型列表，请手动填写模型',
        code: 'bad_output',
      })
    }

    const tooMany = jsonResponse({
      data: Array.from({ length: MAX_DISCOVERED_MODELS + 1 }, (_, i) => ({ id: `model-${i}` })),
    })
    await expect(
      requestModelList({ baseUrl: 'https://api.example.com/v1' }, '', undefined, fetchWith(tooMany) as never),
    ).rejects.toMatchObject({
      message: '模型列表过大，请手动填写模型',
      code: 'bad_output',
    })
  })

  it('401/403/404/405/429/500 与超大响应报错固定，绝不回显服务端错误正文或模拟密钥', async () => {
    const cases: [number, string, string][] = [
      [401, '凭证无效或没有访问权限', 'auth'],
      [403, '凭证无效或没有访问权限', 'auth'],
      [404, '接口不支持获取模型，请手动填写模型', 'not_found'],
      [405, '接口不支持获取模型，请手动填写模型', 'not_found'],
      [429, '请求过于频繁，请稍后重试', 'rate_limited'],
      [500, '模型服务暂时不可用，请稍后重试', 'server'],
    ]
    for (const [status, message, code] of cases) {
      const fetcher = fetchWith(new Response('server-echo sk-echo-secret', { status }))
      const err = await requestModelList(
        { baseUrl: 'https://api.example.com/v1' },
        'sk-echo-secret',
        undefined,
        fetcher as never,
      ).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TranslationError)
      expect((err as TranslationError).message).toBe(message)
      expect((err as TranslationError).code).toBe(code)
      expect((err as Error).message).not.toContain('server-echo')
      expect((err as Error).message).not.toContain('sk-echo-secret')
    }

    const big = fetchWith(new Response('x'.repeat(1048577), { status: 200 }))
    await expect(
      requestModelList({ baseUrl: 'https://api.example.com/v1' }, '', undefined, big as never),
    ).rejects.toThrow('响应过大')
  })

  it('15 秒超时与外部 AbortSignal 取消分别抛出 timeout 与 CompletionCancelledError', async () => {
    vi.useFakeTimers()
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )
    const timeoutPending = requestModelList({ baseUrl: 'https://api.example.com/v1' }, '', undefined, hanging as never)
    const timeoutAssert = expect(timeoutPending).rejects.toMatchObject({
      message: '请求超时，请稍后重试',
      code: 'timeout',
    })
    await vi.advanceTimersByTimeAsync(15_100)
    await timeoutAssert
    expect(vi.getTimerCount()).toBe(0)

    const external = new AbortController()
    const cancelPending = requestModelList(
      { baseUrl: 'https://api.example.com/v1' },
      '',
      external.signal,
      hanging as never,
    )
    external.abort()
    await expect(cancelPending).rejects.toBeInstanceOf(CompletionCancelledError)
    expect(vi.getTimerCount()).toBe(0)
  })
})
