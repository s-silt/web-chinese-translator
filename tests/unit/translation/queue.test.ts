import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestTranslation } from '../../../src/translation/queue'
import { clearTranslationCache } from '../../../src/translation/queue'
import { cancelModelTasks, QueueFullError, scheduleModelTask } from '../../../src/translation/scheduler'
import { CompletionCancelledError } from '../../../src/translation/transport'
import type { ModelSnapshot } from '../../../src/translation/model-state'
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from '../../../src/translation/config'

const config: TranslationConfig = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  autoOrigins: [],
  disabledDictionaries: ['devin', 'cursor'],
  targetLanguage: 'zh-CN',
  sourceLanguage: 'auto',
  selectionPopupEnabled: false,
  selectionToolbarEnabled: false,
  proactiveAssistEnabled: false,
  floatingButtonEnabled: false,
  excludedHosts: [],
  siteScopeMode: 'all',
  siteScopeHosts: [],
}

function snapshot(): ModelSnapshot {
  return { config, apiKey: 'sk-x', revision: 0 }
}

function reply(texts: readonly string[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const allow = async () => true

beforeEach(() => {
  clearTranslationCache()
})

describe('requestTranslation', () => {
  it('三条文本与重复项保持精确顺序，一次去重请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['甲', '乙', '丙']))
    const out = await requestTranslation(snapshot(), 'selection', ['a', 'b', 'a', 'c'], allow)
    expect(out.ok).toBe(true)
    expect(out.texts).toEqual(['甲', '乙', '甲', '丙'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const init = (fetcher.mock.calls[0] as [string, RequestInit])[1]
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] }
    expect(JSON.parse(body.messages[1]?.content ?? 'null')).toEqual(['a', 'b', 'c'])
  })

  it('缓存命中不再发请求；失败不写入缓存', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => reply(['乙']))
      .mockImplementation(async () => new Response('x', { status: 500 }))
    const first = await requestTranslation(snapshot(), 'selection', ['b'], allow)
    expect(first.ok).toBe(true)
    const second = await requestTranslation(snapshot(), 'selection', ['b', 'c'], allow)
    expect(second.ok).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const body = JSON.parse((fetcher.mock.calls[1] as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    expect(JSON.parse(body.messages[1]?.content ?? 'null')).toEqual(['c'])
  })

  it('自动模式接受部分结果：不合格项为空串且不写缓存，合格项写缓存', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => reply(['甲', '', '丙']))
      .mockImplementationOnce(async () => reply(['乙']))
    const out = await requestTranslation(snapshot(), 'auto', ['a', 'b', 'c'], allow)
    expect(out).toMatchObject({ ok: true, texts: ['甲', '', '丙'] })
    const again = await requestTranslation(snapshot(), 'auto', ['a', 'b', 'c'], allow)
    expect(again).toMatchObject({ ok: true, texts: ['甲', '乙', '丙'] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const body = JSON.parse((fetcher.mock.calls[1] as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[]
    }
    expect(JSON.parse(body.messages[1]?.content ?? 'null')).toEqual(['b'])
  })

  it('划词模式不接受部分结果', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲', '']))
    const out = await requestTranslation(snapshot(), 'selection', ['a', 'b'], allow)
    expect(out).toMatchObject({ ok: false, code: 'bad_output' })
  })

  it('自动模式条数不符、全部不合格仍是整批格式错误', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    fetcher.mockImplementationOnce(async () => reply(['甲']))
    expect(await requestTranslation(snapshot(), 'auto', ['a', 'b'], allow)).toMatchObject({ ok: false, code: 'bad_output' })
    fetcher.mockImplementationOnce(async () => reply(['', ' ']))
    expect(await requestTranslation(snapshot(), 'auto', ['a', 'b'], allow)).toMatchObject({ ok: false, code: 'bad_output' })
  })

  it('自动模式部分缓存命中而其余条数不符时返回缓存部分', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    fetcher.mockImplementationOnce(async () => reply(['甲']))
    await requestTranslation(snapshot(), 'auto', ['a'], allow)
    fetcher.mockImplementationOnce(async () => reply(['乙', '丙', '丁']))
    expect(await requestTranslation(snapshot(), 'auto', ['a', 'b', 'c'], allow)).toMatchObject({
      ok: true,
      texts: ['甲', '', ''],
    })
  })

  it('外部 signal 取消只影响该作用域生产者', async () => {
    const resolvers: Array<(r: Response) => void> = []
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const controllerA = new AbortController()
    const a = requestTranslation(snapshot(), 'selection', ['a'], allow, undefined, controllerA.signal)
    const b = requestTranslation(snapshot(), 'auto', ['a'], allow)
    await vi.waitFor(() => {
      expect(fetcher.mock.calls.length).toBe(2)
    })
    controllerA.abort()
    for (const resolve of resolvers) resolve(reply(['A']))
    const outA = await a
    const outB = await b
    expect(outA).toMatchObject({ ok: false, code: 'cancelled' })
    expect(outB.ok).toBe(true)
  })

  it('活动任务被取消后 abort 到达 fetch 且结果失败', async () => {
    const signals: AbortSignal[] = []
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((resolve, reject) => {
          if (init?.signal === undefined || init.signal === null) return
          signals.push(init.signal)
          init.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')))
        }),
    )
    const out = requestTranslation(snapshot(), 'selection', ['a'], allow)
    await vi.waitFor(() => {
      expect(fetcher.mock.calls.length).toBeGreaterThan(0)
    })
    cancelModelTasks()
    const result = await out
    expect(result.ok).toBe(false)
    expect(signals[0]?.aborted).toBe(true)
  })
})

describe('调度器容量保留', () => {
  it('自动任务最多一个并发，交互任务先取得保留槽', async () => {
    const started: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    let releaseC!: () => void
    const gateC = new Promise<void>((r) => {
      releaseC = r
    })
    const a = scheduleModelTask('automatic', async () => {
      started.push('A')
      await gateA
      return 'a'
    })
    const b = scheduleModelTask('automatic', async () => {
      started.push('B')
      return 'b'
    })
    const c = scheduleModelTask('interactive', async () => {
      started.push('C')
      await gateC
      return 'c'
    })
    try {
      await vi.waitFor(() => {
        expect(started).toEqual(['A', 'C'])
      })
      expect(started).not.toContain('B')
      releaseC()
      await c
      await Promise.resolve()
      await Promise.resolve()
      expect(started).not.toContain('B')
      releaseA()
      await Promise.all([a, b])
      expect(started).toContain('B')
    } finally {
      releaseA()
      releaseC()
      await Promise.allSettled([a, b, c])
    }
  })

  it('自动等待上限后拒绝，交互任务仍能进入保留槽', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = scheduleModelTask('automatic', async () => {
      await gate
      return 'held'
    })
    const waits: Promise<unknown>[] = []
    let fullErrors = 0
    for (let i = 0; i < 20; i += 1) {
      const p = scheduleModelTask('automatic', async () => `w${i}`)
      void p.catch((error: unknown) => {
        if (error instanceof QueueFullError) fullErrors += 1
      })
      waits.push(p)
    }
    let startedInteractive = false
    const c = scheduleModelTask('interactive', async () => {
      startedInteractive = true
      return 'c'
    })
    try {
      await c
      expect(startedInteractive).toBe(true)
      expect(fullErrors).toBeGreaterThan(0)
    } finally {
      release()
      await Promise.allSettled([held, ...waits])
    }
  })

  it('等待中被取消的任务不执行 run 回调', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blockers = [
      scheduleModelTask('interactive', async () => {
        await gate
        return 'x'
      }),
      scheduleModelTask('interactive', async () => {
        await gate
        return 'y'
      }),
    ]
    const run = vi.fn(async () => 'never')
    const controller = new AbortController()
    const outcome = scheduleModelTask('interactive', run, controller.signal).catch((error: unknown) => error)
    controller.abort()
    release()
    await Promise.allSettled(blockers)
    expect(await outcome).toBeInstanceOf(CompletionCancelledError)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('缓存快速路径', () => {
  it('缓存全命中不占用调度槽且不发请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['甲', '乙']))
    const first = await requestTranslation(snapshot(), 'auto', ['a', 'b'], allow)
    expect(first).toEqual({ ok: true, texts: ['甲', '乙'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let blockersStarted = 0
    const blockers = [
      scheduleModelTask('interactive', async () => {
        blockersStarted += 1
        await gate
        return 'x'
      }),
      scheduleModelTask('interactive', async () => {
        blockersStarted += 1
        await gate
        return 'y'
      }),
    ]
    let settled = false
    try {
      await vi.waitFor(() => expect(blockersStarted).toBe(2))
      const cachedPromise = requestTranslation(snapshot(), 'auto', ['a', 'b'], allow).then((result) => {
        settled = true
        return result
      })
      try {
        await vi.waitFor(() => expect(settled).toBe(true))
        const cached = await cachedPromise
        expect(cached).toEqual({ ok: true, texts: ['甲', '乙'], cachedChars: 2 })
        expect(fetcher).toHaveBeenCalledTimes(1)
      } finally {
        release()
        await Promise.allSettled([...blockers, cachedPromise])
      }
    } finally {
      release()
      await Promise.allSettled(blockers)
    }
  })

  it('缓存命中仍需授权；授权挂起时取消或清缓存会拒绝', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['甲']))
    const first = await requestTranslation(snapshot(), 'auto', ['a'], allow)
    expect(first.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const denied = await requestTranslation(snapshot(), 'auto', ['a'], async () => false)
    expect(denied.ok).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    let releaseAuth!: (v: boolean) => void
    const authGate = new Promise<boolean>((r) => {
      releaseAuth = r
    })
    const controller = new AbortController()
    const pending = requestTranslation(snapshot(), 'auto', ['a'], async () => await authGate, undefined, controller.signal)
    controller.abort()
    releaseAuth(true)
    expect((await pending).ok).toBe(false)
    let releaseAuth2!: (v: boolean) => void
    const authGate2 = new Promise<boolean>((r) => {
      releaseAuth2 = r
    })
    const pending2 = requestTranslation(snapshot(), 'auto', ['a'], async () => await authGate2)
    clearTranslationCache()
    releaseAuth2(true)
    expect((await pending2).ok).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('调度代际取消使挂起的缓存完成失效', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['甲']))
    const first = await requestTranslation(snapshot(), 'auto', ['a'], allow)
    expect(first.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    let releaseAuth!: (v: boolean) => void
    const authGate = new Promise<boolean>((r) => {
      releaseAuth = r
    })
    const pending = requestTranslation(snapshot(), 'auto', ['a'], async () => await authGate)
    cancelModelTasks()
    releaseAuth(true)
    expect((await pending).ok).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('目标语言进入缓存键', () => {
  it('同一文本不同语言：内存键不同、互不命中；同语言重放命中', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['乙']))
    const zh = snapshot()
    const ja = { ...zh, config: { ...config, targetLanguage: 'ja' as const } }
    await requestTranslation(zh, 'selection', ['a'], allow)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await requestTranslation(ja, 'selection', ['a'], allow)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await requestTranslation(zh, 'selection', ['a'], allow)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('源语言进入缓存键', () => {
  it('同一文本不同源语言不互命中', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['乙']))
    const auto = snapshot()
    const ja = { ...auto, config: { ...config, sourceLanguage: 'ja' as const } }
    await requestTranslation(auto, 'selection', ['a'], allow)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await requestTranslation(ja, 'selection', ['a'], allow)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await requestTranslation(auto, 'selection', ['a'], allow)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('高级请求参数与自定义请求头缓存隔离及转发', () => {
  it('温度、附加参数、请求头修订号变化各自重新请求，同义参数键序命中同一缓存，且透传私有请求头', async () => {
    const rev1 = '11111111-1111-4111-8111-111111111111'
    const rev2 = '22222222-2222-4222-8222-222222222222'
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => reply(['译1']))
      .mockImplementationOnce(async () => reply(['译2']))
      .mockImplementationOnce(async () => reply(['译3']))
      .mockImplementationOnce(async () => reply(['译4']))

    const snap1: ModelSnapshot = {
      ...snapshot(),
      config: {
        ...config,
        temperature: 0,
        requestParams: { b: 1, a: { d: 'x', c: true } },
        customHeadersRevision: rev1,
      },
      customHeaders: { 'X-Custom-Auth': 'token-1' },
    }
    const out1 = await requestTranslation(snap1, 'selection', ['Hello'], allow, undefined, undefined, false)
    expect(out1).toEqual({ ok: true, texts: ['译1'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const firstHeaders = (fetcher.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(firstHeaders['x-custom-auth']).toBe('token-1')

    const reordered: ModelSnapshot = {
      ...snap1,
      config: {
        ...snap1.config,
        requestParams: { a: { c: true, d: 'x' }, b: 1 },
      },
    }
    const cached = await requestTranslation(reordered, 'selection', ['Hello'], allow, undefined, undefined, false)
    expect(cached).toEqual({ ok: true, texts: ['译1'], cachedChars: 5 })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const diffTemp: ModelSnapshot = { ...snap1, config: { ...snap1.config, temperature: 0.5 } }
    expect(await requestTranslation(diffTemp, 'selection', ['Hello'], allow, undefined, undefined, false)).toEqual({
      ok: true,
      texts: ['译2'],
    })
    expect(fetcher).toHaveBeenCalledTimes(2)

    const diffParams: ModelSnapshot = {
      ...snap1,
      config: { ...snap1.config, requestParams: { b: 2, a: { d: 'x', c: true } } },
    }
    expect(await requestTranslation(diffParams, 'selection', ['Hello'], allow, undefined, undefined, false)).toEqual({
      ok: true,
      texts: ['译3'],
    })
    expect(fetcher).toHaveBeenCalledTimes(3)

    const diffHeaderRev: ModelSnapshot = {
      ...snap1,
      config: { ...snap1.config, customHeadersRevision: rev2 },
      customHeaders: { 'X-Custom-Auth': 'token-2' },
    }
    expect(await requestTranslation(diffHeaderRev, 'selection', ['Hello'], allow, undefined, undefined, false)).toEqual({
      ok: true,
      texts: ['译4'],
    })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('大附加参数不挤出二十条短文本的内存缓存', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['译文']))
    const snap: ModelSnapshot = {
      ...snapshot(),
      config: { ...config, requestParams: { metadata: { padding: 'x'.repeat(15000) } } },
    }
    for (let i = 0; i < 20; i += 1) {
      expect((await requestTranslation(snap, 'selection', [`Term ${i}`], allow, undefined, undefined, false)).ok).toBe(true)
    }
    expect(fetcher).toHaveBeenCalledTimes(20)
    expect(await requestTranslation(snap, 'selection', ['Term 0'], allow, undefined, undefined, false))
      .toMatchObject({ ok: true, cachedChars: 6 })
    expect(fetcher).toHaveBeenCalledTimes(20)
  })

  it('请求摘要计算挂起期间清空缓存会取消任务且不发起 fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['译文']))
    let release!: (value: ArrayBuffer) => void
    const gate = new Promise<ArrayBuffer>((resolve) => {
      release = resolve
    })
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => gate)
    try {
      const pending = requestTranslation(snapshot(), 'selection', ['Hello'], allow, undefined, undefined, false)
      clearTranslationCache()
      release(new Uint8Array(32).buffer)
      expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      digestSpy.mockRestore()
    }
  })
})
