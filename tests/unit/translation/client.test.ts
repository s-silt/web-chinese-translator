import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { closePageSession, sendTranslationMessage } from '../../../src/translation/client'
import { MAX_REQUEST_TIMEOUT_MS, QUEUE_WAIT_LIMIT_MS, requestTimeoutMs } from '../../../src/translation/failure'
import {
  isContentTranslationReply,
  type PageModes,
  type TranslationMessage,
  type TranslationReply,
} from '../../../src/translation/messages'

const MARGIN_MS = 7000
const AUTO_WATCHDOG_MS = QUEUE_WAIT_LIMIT_MS.automatic + MAX_REQUEST_TIMEOUT_MS + MARGIN_MS
const INTERACTIVE_WATCHDOG_MS = QUEUE_WAIT_LIMIT_MS.interactive + MAX_REQUEST_TIMEOUT_MS + MARGIN_MS

function hangingSend(): unknown[] {
  const sent: unknown[] = []
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (m: unknown) => {
    sent.push(m)
    return await new Promise(() => undefined)
  })
  return sent
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('sendTranslationMessage', () => {
  it('看门狗到期发出一次 wt:cancel-assist，并按后台失联而不是请求超时上报', async () => {
    const sent = hangingSend()
    const promise = sendTranslationMessage({ type: 'wt:translate', mode: 'auto', texts: ['a'], requestId: 'r1' })
    await vi.advanceTimersByTimeAsync(AUTO_WATCHDOG_MS - 1)
    expect(sent.filter((m) => (m as { type: string }).type === 'wt:cancel-assist')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    const reply = await promise
    expect(reply).toEqual({ ok: false, error: '后台响应超时，请重试', code: 'disconnected' })
    const cancels = sent.filter((m) => (m as { type: string }).type === 'wt:cancel-assist')
    expect(cancels).toHaveLength(1)
    expect((cancels[0] as { requestId: string }).requestId).toBe('r1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wt:list-models 看门狗使用 22_000ms 并在超时后发送 wt:cancel-models', async () => {
    const sent = hangingSend()
    const promise = sendTranslationMessage({
      type: 'wt:list-models',
      baseUrl: 'https://api.example.com/v1',
      requestId: 'models-req-1',
    })
    await vi.advanceTimersByTimeAsync(21_999)
    expect(sent.filter((m) => (m as { type: string }).type === 'wt:cancel-models')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    const reply = await promise
    expect(reply).toEqual({ ok: false, error: '后台响应超时，请重试', code: 'disconnected' })
    const cancels = sent.filter((m) => (m as { type: string }).type === 'wt:cancel-models')
    expect(cancels).toHaveLength(1)
    expect((cancels[0] as { requestId: string }).requestId).toBe('models-req-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('任务排满后台排队上限再跑满请求时限，回复仍能送达', async () => {
    let resolve!: (v: unknown) => void
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(
      async () => await new Promise<unknown>((r) => (resolve = r)),
    )
    const promise = sendTranslationMessage({ type: 'wt:translate', mode: 'auto', texts: ['a'], requestId: 'r3' })
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_LIMIT_MS.automatic + MAX_REQUEST_TIMEOUT_MS)
    resolve({ ok: true, texts: ['译'] })
    expect(await promise).toEqual({ ok: true, texts: ['译'] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['自动翻译', { type: 'wt:translate', mode: 'auto', texts: ['a'], requestId: 'r' }, AUTO_WATCHDOG_MS],
    ['选区翻译', { type: 'wt:translate', mode: 'selection', texts: ['a'], requestId: 'r' }, INTERACTIVE_WATCHDOG_MS],
    ['主动辅助', { type: 'wt:assist', requestId: 'r', input: { trigger: 'revisit' } }, AUTO_WATCHDOG_MS],
    ['选区辅助', { type: 'wt:assist', requestId: 'r', input: { trigger: 'selection' } }, INTERACTIVE_WATCHDOG_MS],
    ['连接测试', { type: 'wt:test' }, INTERACTIVE_WATCHDOG_MS],
    ['不排队的消息', { type: 'wt:page-modes' }, MAX_REQUEST_TIMEOUT_MS + MARGIN_MS],
  ])('%s 的看门狗时限覆盖其排队上限', async (_name, message, limit) => {
    hangingSend()
    let settled = false
    void sendTranslationMessage(message as never).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(limit - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('看门狗严格高于后台时限：短内容与最长内容都留有余量', () => {
    for (const chars of [0, 5, 1500, 1_000_000]) {
      expect(INTERACTIVE_WATCHDOG_MS).toBeGreaterThan(QUEUE_WAIT_LIMIT_MS.interactive + requestTimeoutMs(chars))
      expect(AUTO_WATCHDOG_MS).toBeGreaterThan(QUEUE_WAIT_LIMIT_MS.automatic + requestTimeoutMs(chars))
    }
  })

  it.each([
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
    'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
    'Extension context invalidated.',
  ])('后台重启错误归类为 disconnected：%s', async (text) => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValueOnce(new Error(text))
    const reply = await sendTranslationMessage({ type: 'wt:translate', mode: 'auto', texts: ['a'], requestId: 'r4' })
    expect(reply).toEqual({ ok: false, error: '无法连接扩展后台，请重试或刷新页面', code: 'disconnected' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('后台退出前没有回复同样归类为 disconnected', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValueOnce(undefined as never)
    expect(await sendTranslationMessage({ type: 'wt:page-modes' })).toMatchObject({ ok: false, code: 'disconnected' })
  })

  it('发送后迟到的成功不再改变已结算结果', async () => {
    let resolve!: (v: unknown) => void
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (m: unknown) => {
      if ((m as { type: string }).type === 'wt:cancel-assist') return { ok: true }
      return await new Promise<unknown>((r) => (resolve = r))
    })
    const promise = sendTranslationMessage({ type: 'wt:assist', requestId: 'r2', input: {} as never })
    await vi.advanceTimersByTimeAsync(AUTO_WATCHDOG_MS)
    resolve({ ok: true, result: {} })
    const reply = await promise
    expect(reply.ok).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同步抛出发送返回固定错误且不残留定时器', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(() => {
      throw new Error('sync')
    })
    const reply = await sendTranslationMessage({ type: 'wt:test' })
    expect(reply.ok).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  const assistMessage = {
    type: 'wt:assist',
    requestId: 'assist-1',
    input: {
      text: 'hello',
      context: '',
      pageTitle: '',
      site: 'example.com',
      trigger: 'selection',
      signals: { method: 'mouse', dwellMs: 0, visits: 1 },
    },
  } as const satisfies TranslationMessage

  it.each([
    { type: 'wt:get-config' },
    { type: 'wt:page-modes' },
    { type: 'wt:save-config', patch: {} },
    { type: 'wt:set-site-auto', origin: 'https://example.com', enabled: true },
    { type: 'wt:set-site-excluded', host: 'example.com', excluded: true },
    { type: 'wt:clear-key' },
    { type: 'wt:test' },
    { type: 'wt:list-models', baseUrl: 'https://api.example.com/v1', requestId: 'models-1' },
    { type: 'wt:translate', mode: 'auto', texts: ['a'] },
    assistMessage,
  ] satisfies TranslationMessage[])('$type 缺少必需载荷时拒绝', async (message) => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    const reply = await sendTranslationMessage(message)
    expect(reply).toMatchObject({ ok: false, code: 'unknown' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    {
      name: 'auto 允许部分空白且 cachedChars 不超过源长度',
      mode: 'auto' as const,
      payload: { ok: true, texts: ['甲', ''], cachedChars: 2 },
      ok: true,
    },
    {
      name: 'auto 全部空白拒绝',
      mode: 'auto' as const,
      payload: { ok: true, texts: ['', ''] },
      ok: false,
    },
    {
      name: 'auto 条数不匹配拒绝',
      mode: 'auto' as const,
      payload: { ok: true, texts: ['甲'] },
      ok: false,
    },
    {
      name: 'selection 含空白拒绝',
      mode: 'selection' as const,
      payload: { ok: true, texts: ['甲', ''] },
      ok: false,
    },
    {
      name: 'selection 完整译文成功',
      mode: 'selection' as const,
      payload: { ok: true, texts: ['甲', '乙'] },
      ok: true,
    },
    {
      name: 'selection cachedChars 超过源长度拒绝',
      mode: 'selection' as const,
      payload: { ok: true, texts: ['甲', '乙'], cachedChars: 5 },
      ok: false,
    },
    {
      name: '非数字 cachedChars 由公共守卫拒绝',
      mode: 'auto' as const,
      payload: { ok: true, texts: ['甲', '乙'], cachedChars: '2' },
      ok: false,
    },
    {
      name: '非字符串 texts 由公共守卫拒绝',
      mode: 'auto' as const,
      payload: { ok: true, texts: ['甲', 1] },
      ok: false,
    },
  ])('$name', async ({ mode, payload, ok }) => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => payload)
    const reply = await sendTranslationMessage({ type: 'wt:translate', mode, texts: ['aa', 'bb'] })
    if (ok) expect(reply).toEqual(payload)
    else expect(reply).toMatchObject({ ok: false, code: 'unknown' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { type: 'wt:cancel-assist', requestId: 'r1' },
    { type: 'wt:cancel-models', requestId: 'm1' },
    { type: 'wt:page-action', action: 'restore' as const },
    {
      type: 'wt:page-context',
      pageId: 'page-1',
      page: { title: '', heading: '', site: 'example.com' },
    },
  ] satisfies TranslationMessage[])('$type 的确认回复仍然成功', async (message) => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    await expect(sendTranslationMessage(message)).resolves.toEqual({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('current-page-controls 成功回复必须带合法 legacy', async () => {
    const message = { type: 'wt:current-page-controls', action: 'status' } as const
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    await expect(sendTranslationMessage(message)).resolves.toMatchObject({ ok: false, code: 'unknown' })
    const legacy = { active: true, paused: false }
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({ ok: true, legacy }))
    await expect(sendTranslationMessage(message)).resolves.toEqual({ ok: true, legacy })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('内容状态回复必须带合法 status，其它确认可以只有 ok', () => {
    const status = { supported: true, fixed: false, auto: false, paused: false, capped: false, failed: 2, error: '' }
    for (const failed of [undefined, -1, 1.5, Number.NaN, '2']) {
      expect(isContentTranslationReply({ ok: true, status: { ...status, failed } }, { type: 'wt:status' })).toBe(false)
    }
    expect(isContentTranslationReply({ ok: true }, { type: 'wt:status' })).toBe(false)
    expect(isContentTranslationReply({ ok: true }, { type: 'wt:refresh' })).toBe(true)
    expect(isContentTranslationReply({ ok: true, status }, { type: 'wt:status' })).toBe(true)
    expect(isContentTranslationReply({ ok: true, status: { supported: true } }, { type: 'wt:status' })).toBe(false)
  })

  it('成功回复按消息类型要求载荷', () => {
    expectTypeOf<Extract<TranslationReply<'wt:translate'>, { ok: true }>['texts']>().toEqualTypeOf<string[]>()
    expectTypeOf<Extract<TranslationReply<'wt:page-modes'>, { ok: true }>['modes']>().toEqualTypeOf<PageModes>()
    // @ts-expect-error translation success requires texts
    const invalid: TranslationReply<'wt:translate'> = { ok: true }
    void invalid
  })
})

describe('页面生命周期端口', () => {
  const translate: Extract<TranslationMessage, { type: 'wt:translate' }> = {
    type: 'wt:translate',
    mode: 'auto',
    texts: ['a'],
    requestId: 'r',
  }
  let ports: { name: string; disconnect: ReturnType<typeof vi.fn>; lost(): void }[]
  let sent: { type: string; pageSession?: string }[]
  let connect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    closePageSession()
    ports = []
    sent = []
    connect = vi.fn(({ name }: { name: string }) => {
      const listeners: (() => void)[] = []
      const port = {
        name,
        disconnect: vi.fn(),
        onDisconnect: { addListener: (listener: () => void) => listeners.push(listener) },
      }
      ports.push({ name, disconnect: port.disconnect, lost: () => listeners.forEach((listener) => listener()) })
      return port
    })
    vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(connect as never)
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (m: unknown) => {
      sent.push(m as { type: string; pageSession?: string })
      return (m as { type: string }).type === 'wt:translate' ? { ok: true, texts: ['译'] } : { ok: true }
    })
  })

  afterEach(() => {
    closePageSession()
    vi.restoreAllMocks()
  })

  it('第一个模型请求才打开端口，同一文档复用同一个端口和会话', async () => {
    await sendTranslationMessage({ type: 'wt:page-modes' })
    expect(connect).not.toHaveBeenCalled()
    await sendTranslationMessage(translate)
    await sendTranslationMessage({ ...translate, requestId: 'r2' })
    expect(connect).toHaveBeenCalledTimes(1)
    const session = ports[0]!.name.slice('wt:page:'.length)
    expect(ports[0]!.name).toMatch(/^wt:page:[a-zA-Z0-9-]{1,80}$/)
    expect(sent.filter((m) => m.type === 'wt:translate').map((m) => m.pageSession)).toEqual([session, session])
    expect(sent.find((m) => m.type === 'wt:page-modes')?.pageSession).toBeUndefined()
  })

  it('划词辅助也带会话，取消消息不带', async () => {
    await sendTranslationMessage({ type: 'wt:assist', requestId: 'a', input: {} as never }).catch(() => undefined)
    await sendTranslationMessage({ type: 'wt:cancel-assist', requestId: 'a' })
    expect(sent[0]?.pageSession).toBeDefined()
    expect(sent[1]?.pageSession).toBeUndefined()
  })

  it('后台一侧断开：请求上报 disconnected，不算页面失败；重试时以新会话重连', async () => {
    let reject!: (error: Error) => void
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementationOnce(
      async () => await new Promise((_resolve, rej) => (reject = rej)),
    )
    const pending = sendTranslationMessage(translate)
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledTimes(1)
    ports[0]!.lost()
    reject(new Error('The message port closed before a response was received.'))
    expect(await pending).toMatchObject({ ok: false, code: 'disconnected' })

    expect(await sendTranslationMessage(translate)).toEqual({ ok: true, texts: ['译'] })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(ports[1]!.name).not.toBe(ports[0]!.name)
    expect(sent.at(-1)?.pageSession).toBe(ports[1]!.name.slice('wt:page:'.length))
  })

  it('后台空闲退出时不主动重连，避免反复唤醒后台', async () => {
    await sendTranslationMessage(translate)
    ports[0]!.lost()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('页面主动结束后断开端口，恢复后的请求使用新会话', async () => {
    await sendTranslationMessage(translate)
    closePageSession()
    expect(ports[0]!.disconnect).toHaveBeenCalledTimes(1)
    closePageSession()
    expect(ports[0]!.disconnect).toHaveBeenCalledTimes(1)
    await sendTranslationMessage(translate)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(ports[1]!.name).not.toBe(ports[0]!.name)
  })

  it('旧端口迟到的断开事件不影响新会话', async () => {
    await sendTranslationMessage(translate)
    closePageSession()
    await sendTranslationMessage(translate)
    ports[0]!.lost()
    await sendTranslationMessage(translate)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('无法打开端口时仍发送请求，不带会话', async () => {
    connect.mockImplementation(() => {
      throw new Error('Extension context invalidated.')
    })
    expect(await sendTranslationMessage(translate)).toEqual({ ok: true, texts: ['译'] })
    expect(sent[0]?.pageSession).toBeUndefined()
  })
})
