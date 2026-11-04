import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  backoffDelayMs,
  isTransientFailure,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  QUEUE_WAIT_LIMIT_MS,
  requestTimeoutMs,
} from '../../../src/translation/failure'
import { isTranslationReply } from '../../../src/translation/messages'
import { requestTranslation } from '../../../src/translation/queue'
import {
  AutomaticPausedError,
  automaticPauseRemainingMs,
  cancelModelTasks,
  clearAutomaticPause,
  describeFailure,
  pauseAutomaticTasks,
  QueueTimeoutError,
  scheduleModelTask,
} from '../../../src/translation/scheduler'
import * as scheduling from '../../../src/translation/scheduler'
import { sendTranslationMessage } from '../../../src/translation/client'
import { requestCompletion, TranslationError, CompletionCancelledError } from '../../../src/translation/transport'
import type { ModelSnapshot } from '../../../src/translation/model-state'
import { DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'

const CONFIG = { baseUrl: 'https://api.example.com/v1', model: 'm' }
const snapshot: ModelSnapshot = { config: { ...DEFAULT_TRANSLATION_CONFIG, ...CONFIG }, apiKey: 'sk-x', revision: 0 }
const allow = async (): Promise<boolean> => true

function failWith(status: number, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn(async () => new Response('x', { status, headers })) as unknown as typeof fetch
}

async function failure(fetcher: typeof fetch): Promise<TranslationError> {
  return (await requestCompletion(CONFIG, 's', 'u', '', undefined, fetcher).catch((e: unknown) => e)) as TranslationError
}

function completion(texts: readonly string[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts) } }] }), { status: 200 })
}

beforeEach(() => {
  fakeBrowser.reset()
  clearAutomaticPause()
})

afterEach(() => {
  cancelModelTasks()
  clearAutomaticPause()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('退避与 Retry-After', () => {
  it('全抖动指数退避，随机值决定落点且不超过 30 秒上限', () => {
    expect(backoffDelayMs(1, () => 0.999)).toBe(999)
    expect(backoffDelayMs(2, () => 0.5)).toBe(1000)
    expect(backoffDelayMs(3, () => 0.5)).toBe(2000)
    expect(backoffDelayMs(50, () => 0.5)).toBe(15_000)
    expect(backoffDelayMs(3, () => 0)).toBe(0)
  })

  it('解析秒数与 HTTP 日期，拒绝无效与过期值，并限制上限', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')
    expect(parseRetryAfter('7', now)).toBe(7000)
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('86400', now)).toBe(MAX_RETRY_AFTER_MS)
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBeUndefined()
    expect(parseRetryAfter('-1', now)).toBeUndefined()
    expect(parseRetryAfter('soon 1', now)).toBeUndefined()
    expect(parseRetryAfter('', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })

  it('只有超时、限流、5xx、网络和后台断开属于可重试失败', () => {
    for (const code of ['timeout', 'rate_limited', 'server', 'network', 'disconnected'] as const) {
      expect(isTransientFailure(code)).toBe(true)
    }
    for (const code of ['auth', 'not_found', 'bad_output', 'queue_full', 'queue_paused', 'queue_timeout', 'cancelled', 'unknown'] as const) {
      expect(isTransientFailure(code)).toBe(false)
    }
  })
})

describe('请求超时随内容长度缩放', () => {
  function hangingFetch(): typeof fetch {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    ) as unknown as typeof fetch
  }

  it('18 秒起步，每字符 5 毫秒，不超过 28 秒', () => {
    expect(requestTimeoutMs(0)).toBe(18_000)
    expect(requestTimeoutMs(1500)).toBe(25_500)
    expect(requestTimeoutMs(1999)).toBe(27_995)
    expect(requestTimeoutMs(2000)).toBe(28_000)
    expect(requestTimeoutMs(3600)).toBe(28_000)
    expect(requestTimeoutMs(1_000_000)).toBe(MAX_REQUEST_TIMEOUT_MS)
    expect(MAX_REQUEST_TIMEOUT_MS).toBeLessThan(30_000)
  })

  it('请求按内容长度超时，到点前不中止', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const pending = requestCompletion(CONFIG, 's', 'u'.repeat(1500), '', undefined, hangingFetch())
    const assertion = pending.then(
      () => undefined,
      (e: unknown) => {
        settled()
        return e as TranslationError
      },
    )
    await vi.advanceTimersByTimeAsync(25_499)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect((await assertion)?.code).toBe('timeout')
  })

  it('调用方可显式指定超时', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const pending = requestCompletion(CONFIG, 's', 'u', '', undefined, hangingFetch(), 20_000)
    const assertion = pending.then(
      () => undefined,
      (e: unknown) => {
        settled()
        return e as TranslationError
      },
    )
    await vi.advanceTimersByTimeAsync(19_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect((await assertion)?.code).toBe('timeout')
  })
})

describe('传输层失败分类', () => {
  it('HTTP 状态映射为类型化代码，429 与 5xx 携带 Retry-After', async () => {
    expect((await failure(failWith(401))).code).toBe('auth')
    expect((await failure(failWith(403))).code).toBe('auth')
    expect((await failure(failWith(404))).code).toBe('not_found')
    expect((await failure(failWith(408))).code).toBe('timeout')
    expect((await failure(failWith(400))).code).toBe('unknown')
    const limited = await failure(failWith(429, { 'Retry-After': '12' }))
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfterMs: 12_000 })
    const server = await failure(failWith(503, { 'Retry-After': '3' }))
    expect(server).toMatchObject({ code: 'server', retryAfterMs: 3000 })
    expect((await failure(failWith(500))).retryAfterMs).toBeUndefined()
  })

  it('网络异常、超时与格式错误分别分类', async () => {
    const network = vi.fn(async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    expect((await failure(network)).code).toBe('network')
    const malformed = vi.fn(async () => new Response('not json')) as unknown as typeof fetch
    expect((await failure(malformed)).code).toBe('bad_output')
    vi.useFakeTimers()
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    ) as unknown as typeof fetch
    const pending = failure(hanging)
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await pending).code).toBe('timeout')
  })
})

describe('消息边界', () => {
  it('回复校验接受失败代码，拒绝未知代码与非法 retryAfterMs', () => {
    expect(isTranslationReply({ ok: false, error: 'x' })).toBe(true)
    expect(isTranslationReply({ ok: false, error: 'x', code: 'rate_limited', retryAfterMs: 1000 })).toBe(true)
    expect(isTranslationReply({ ok: false, error: 'x', code: 'nope' })).toBe(false)
    expect(isTranslationReply({ ok: false, error: 'x', retryAfterMs: -1 })).toBe(false)
    expect(isTranslationReply({ ok: false, error: 'x', retryAfterMs: 'soon' })).toBe(false)
  })

  it('后台断开、无应答和看门狗超时带有不同代码', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage')
    send.mockRejectedValueOnce(new Error('message channel closed'))
    expect(await sendTranslationMessage({ type: 'wt:test' })).toMatchObject({ ok: false, code: 'disconnected' })
    send.mockResolvedValueOnce(undefined as never)
    expect(await sendTranslationMessage({ type: 'wt:test' })).toMatchObject({ ok: false, code: 'disconnected' })
    send.mockResolvedValueOnce({ bogus: true } as never)
    expect(await sendTranslationMessage({ type: 'wt:test' })).toMatchObject({ ok: false, code: 'unknown' })
    vi.useFakeTimers()
    send.mockImplementation(async () => await new Promise(() => undefined))
    const pending = sendTranslationMessage({ type: 'wt:test' })
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_LIMIT_MS.interactive + MAX_REQUEST_TIMEOUT_MS + 7000)
    expect(await pending).toMatchObject({ ok: false, code: 'disconnected' })
  })

  it('describeFailure 把各类错误映射为代码且不暴露未知错误内容', () => {
    expect(describeFailure(new CompletionCancelledError())).toEqual({ error: '已取消', code: 'cancelled' })
    expect(describeFailure(new AutomaticPausedError(5000))).toMatchObject({ code: 'queue_paused', retryAfterMs: 5000 })
    expect(describeFailure(new QueueTimeoutError())).toEqual({ error: '排队等待超时，请稍后重试', code: 'queue_timeout' })
    expect(isTranslationReply({ ok: false, ...describeFailure(new QueueTimeoutError()) })).toBe(true)
    expect(describeFailure(new Error('sk-secret'))).toEqual({ error: '无法连接翻译服务', code: 'unknown' })
  })
})

describe('429 全局暂停自动队列', () => {
  it('Retry-After 期间拒绝新的自动任务并返回剩余时间，到期后恢复；交互任务不受影响', async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response('x', { status: 429, headers: { 'Retry-After': '10' } }))
      .mockImplementation(async () => completion(['译']))
    const limited = await requestTranslation(snapshot, 'auto', ['a'], allow, undefined, undefined)
    expect(limited).toMatchObject({ ok: false, code: 'rate_limited', retryAfterMs: 10_000 })

    await vi.advanceTimersByTimeAsync(4000)
    const otherTab = await requestTranslation(snapshot, 'auto', ['b'], allow, undefined, undefined)
    expect(otherTab).toMatchObject({ ok: false, code: 'queue_paused', retryAfterMs: 6000 })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const selection = await requestTranslation(snapshot, 'selection', ['c'], allow, undefined, undefined)
    expect(selection).toMatchObject({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(6000)
    expect(automaticPauseRemainingMs()).toBe(0)
    expect(await requestTranslation(snapshot, 'auto', ['d'], allow, undefined, undefined)).toMatchObject({ ok: true })
  })

  it('交互请求收到 429 也暂停自动队列；无 Retry-After 时使用退避', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x', { status: 429 }))
    const out = await requestTranslation(snapshot, 'selection', ['a'], allow)
    expect(out).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(out.retryAfterMs).toBeGreaterThanOrEqual(1)
    expect(automaticPauseRemainingMs()).toBeGreaterThan(0)
  })

  it('暂停时等待中的自动任务带剩余时间拒绝且不执行，运行中的不受影响', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = scheduleModelTask('automatic', async () => {
      await gate
      return 'done'
    })
    const run = vi.fn(async () => 'never')
    const queued = scheduleModelTask('automatic', run).catch((error: unknown) => error)
    pauseAutomaticTasks(5000)
    const error = await queued
    expect(error).toBeInstanceOf(AutomaticPausedError)
    expect((error as AutomaticPausedError).retryAfterMs).toBeGreaterThan(0)
    release()
    await expect(running).resolves.toBe('done')
    expect(run).not.toHaveBeenCalled()
  })

  it('Retry-After 超长时暂停被限制在上限内', () => {
    pauseAutomaticTasks(10 * 60 * 1000)
    expect(automaticPauseRemainingMs()).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS)
  })

  it('401 与 404 不暂停自动队列', async () => {
    for (const status of [401, 404]) {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => new Response('x', { status }))
      const out = await requestTranslation(snapshot, 'auto', [`s${status}`], allow)
      expect(out.ok).toBe(false)
      expect(automaticPauseRemainingMs()).toBe(0)
    }
  })

  it('暂停时间记录到 storage.session，后台重启后恢复；清除后不再恢复', async () => {
    vi.useFakeTimers()
    pauseAutomaticTasks(30_000)
    await vi.advanceTimersByTimeAsync(0)
    vi.resetModules()
    const fresh = await import('../../../src/translation/scheduler')
    expect(fresh.automaticPauseRemainingMs()).toBe(0)
    await fresh.restoreAutomaticPause()
    expect(fresh.automaticPauseRemainingMs()).toBe(30_000)
    const rejected = await fresh.scheduleModelTask('automatic', async () => 'never').catch((error: unknown) => error)
    expect(fresh.describeFailure(rejected)).toMatchObject({ code: 'queue_paused', retryAfterMs: 30_000 })
    fresh.clearAutomaticPause()
    await vi.advanceTimersByTimeAsync(0)
    vi.resetModules()
    const again = await import('../../../src/translation/scheduler')
    await again.restoreAutomaticPause()
    expect(again.automaticPauseRemainingMs()).toBe(0)
  })
})

describe('取消后到达的限流错误', () => {
  it('已取消的旧请求迟到 429 不暂停新请求', async () => {
    const abort = new AbortController()
    let reject!: (error: unknown) => void
    const gate = new Promise<never>((_resolve, fail) => {
      reject = fail
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = scheduleModelTask('interactive', async () => {
      entered()
      return gate
    }, abort.signal)
    const result = pending.catch((error: unknown) => error)
    await started
    abort.abort()
    clearAutomaticPause()
    reject(new TranslationError('旧接口限流', 'rate_limited', 60_000))
    expect(await result).toBeInstanceOf(CompletionCancelledError)
    expect(automaticPauseRemainingMs()).toBe(0)
    expect(await scheduleModelTask('automatic', async () => 'new')).toBe('new')
  })
})

describe('持久化暂停恢复', () => {
  it('清除暂停后迟到的持久化读取不能恢复旧暂停', async () => {
    vi.resetModules()
    const fresh = await import('../../../src/translation/scheduler')
    let release!: (value: Record<string, unknown>) => void
    const gate = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve
    })
    const read = vi
      .spyOn(fakeBrowser.storage.session, 'get')
      .mockImplementation(async () => await gate as never)
    const restoring = fresh.restoreAutomaticPause()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
    fresh.clearAutomaticPause()
    release({ wtAutomaticPausedUntil: Date.now() + 60_000 })
    await restoring
    expect(fresh.automaticPauseRemainingMs()).toBe(0)
    await expect(fresh.scheduleModelTask('automatic', async () => 'new')).resolves.toBe('new')
  })
})

describe('后台排队时限', () => {
  /** 占满自动槽，返回释放函数；交互任务需占满两个槽才会排队。 */
  function hold(priority: 'interactive' | 'automatic'): { release: () => void; done: Promise<unknown> } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const done = scheduleModelTask(priority, async () => await gate).catch((error: unknown) => error)
    return { release, done }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('自动任务排队超过上限后以 queue_timeout 拒绝且不执行，运行中的任务不受影响', async () => {
    const holder = hold('automatic')
    const run = vi.fn(async () => 'never')
    const queued = scheduleModelTask('automatic', run).catch((error: unknown) => error)
    let settled = false
    void queued.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_LIMIT_MS.automatic - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await queued
    expect(error).toBeInstanceOf(QueueTimeoutError)
    expect(describeFailure(error).code).toBe('queue_timeout')
    holder.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('交互任务的排队上限更短', async () => {
    const holders = [hold('interactive'), hold('interactive')]
    const queued = scheduleModelTask('interactive', async () => 'never').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_LIMIT_MS.interactive)
    expect(await queued).toBeInstanceOf(QueueTimeoutError)
    holders.forEach((holder) => holder.release())
    await vi.advanceTimersByTimeAsync(0)
  })

  it('时限只计排队时间：上限前开始运行的任务不再受其约束', async () => {
    const holder = hold('automatic')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = scheduleModelTask('automatic', async () => {
      await gate
      return 'done'
    })
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_LIMIT_MS.automatic - 1000)
    holder.release()
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_LIMIT_MS.automatic * 2)
    release()
    await expect(queued).resolves.toBe('done')
  })

  it('排队中被取消或因 429 暂停的任务不残留时限定时器', async () => {
    const holder = hold('automatic')
    const baseline = vi.getTimerCount()
    const controller = new AbortController()
    const cancelled = scheduleModelTask('automatic', async () => 'never', controller.signal).catch((error: unknown) => error)
    const paused = scheduleModelTask('automatic', async () => 'never').catch((error: unknown) => error)
    expect(vi.getTimerCount()).toBe(baseline + 2)
    controller.abort()
    expect(await cancelled).toBeInstanceOf(CompletionCancelledError)
    pauseAutomaticTasks(1000)
    expect(await paused).toBeInstanceOf(AutomaticPausedError)
    expect(vi.getTimerCount()).toBe(baseline)
    holder.release()
    await holder.done
  })

  it('requestTranslation 把排队超时报告为 queue_timeout，不发出请求', async () => {
    const holder = hold('automatic')
    const scheduled = vi.spyOn(scheduling, 'scheduleModelTask')
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const controller = new AbortController()
    // 排队测试不依赖IndexedDB；真实WebCrypto摘要仍会在入队前异步完成。
    const out = requestTranslation(snapshot, 'auto', ['queued text'], allow, undefined, controller.signal, false)
    try {
      await vi.waitFor(() => expect(scheduled).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(QUEUE_WAIT_LIMIT_MS.automatic)
      expect(await out).toEqual({ ok: false, error: '排队等待超时，请稍后重试', code: 'queue_timeout' })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      controller.abort()
      holder.release()
      await Promise.all([out, holder.done])
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it('有任务时定期发送心跳保持后台存活，全部结束后停止', async () => {
    const beat = vi.spyOn(fakeBrowser.runtime, 'getPlatformInfo').mockResolvedValue({} as never)
    const holder = hold('automatic')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(beat).toHaveBeenCalledTimes(2)
    holder.release()
    await holder.done
    await vi.advanceTimersByTimeAsync(40_000)
    expect(beat).toHaveBeenCalledTimes(2)
  })
})
