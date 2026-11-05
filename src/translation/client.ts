import { browser, type Browser } from 'wxt/browser'
import { MAX_REQUEST_TIMEOUT_MS, QUEUE_WAIT_LIMIT_MS } from './failure'
import { createId } from './id'
import { isTranslationReply, PAGE_PORT_PREFIX, type TranslationMessage, type TranslationReply } from './messages'

const WATCHDOG_MARGIN_MS = 7_000
const BACKGROUND_LOST_ERROR = '无法连接扩展后台，请重试或刷新页面'

let pagePort: Browser.runtime.Port | undefined
let pageSession: string | undefined

/**
 * 页面生命周期端口：文档消失时端口断开，后台据此中止这个会话的排队与在途任务。
 * 第一次需要模型时才打开；后台断开后也等下一个请求再连。断开时立刻重连会唤醒刚因空闲退出的后台，
 * 每个标签页都这样做就成了周期性唤醒。一个端口对应一个会话 ID，已结束的会话不会复用。
 */
function ensurePageSession(): string | undefined {
  if (pageSession !== undefined) return pageSession
  try {
    const session = createId()
    const port = browser.runtime.connect({ name: `${PAGE_PORT_PREFIX}${session}` })
    port.onDisconnect.addListener(() => {
      // 读取一次，避免浏览器记录未检查的 lastError。
      void browser.runtime.lastError
      if (pagePort !== port) return
      pagePort = undefined
      pageSession = undefined
    })
    pagePort = port
    pageSession = session
    return session
  } catch {
    // 扩展上下文失效时发送同样会失败，由下面的 disconnected 路径处理。
    return undefined
  }
}

/** 页面主动结束会话（进入往返缓存或卸载）。往返缓存恢复后，下一个请求会打开新会话。 */
export function closePageSession(): void {
  const port = pagePort
  pagePort = undefined
  pageSession = undefined
  try {
    port?.disconnect()
  } catch {
    void 0
  }
}

function withPageSession<M extends TranslationMessage>(message: M): M {
  if (message.type !== 'wt:translate' && message.type !== 'wt:assist') return message
  const session = ensurePageSession()
  return session === undefined ? message : { ...message, pageSession: session }
}

function queueWaitMs(message: TranslationMessage): number {
  if (message.type === 'wt:translate') {
    return message.mode === 'auto' || message.mode === 'subtitle'
      ? QUEUE_WAIT_LIMIT_MS.automatic
      : QUEUE_WAIT_LIMIT_MS.interactive
  }
  if (message.type === 'wt:assist') {
    return message.input.trigger === 'selection' ? QUEUE_WAIT_LIMIT_MS.interactive : QUEUE_WAIT_LIMIT_MS.automatic
  }
  return message.type === 'wt:test' ? QUEUE_WAIT_LIMIT_MS.interactive : 0
}

/**
 * 排队与请求的时限都归后台所有，到期时后台回复 queue_timeout 或 timeout。
 * 这里的时限高于二者之和，所以触发时只说明后台已失联，与排队和接口快慢无关。
 */
function watchdogMs(message: TranslationMessage): number {
  if (message.type === 'wt:list-models') return 22_000
  return queueWaitMs(message) + MAX_REQUEST_TIMEOUT_MS + WATCHDOG_MARGIN_MS
}

/**
 * 发送被拒绝（Receiving end does not exist、端口断开、扩展上下文失效）或没有回复，都说明后台中途重启或失联，
 * 请求本身没有失败，统一上报 disconnected。不按错误文本区分，各浏览器的措辞并不一致。
 */
export async function sendTranslationMessage<M extends TranslationMessage>(
  message: M,
): Promise<TranslationReply<M['type']>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const send = Promise.resolve()
    .then(() => browser.runtime.sendMessage(withPageSession(message)))
    .then((reply: unknown): TranslationReply<M['type']> => {
      if (isTranslationReply(reply, message)) return reply
      return reply === undefined
        ? { ok: false, error: BACKGROUND_LOST_ERROR, code: 'disconnected' }
        : { ok: false, error: '后台响应格式不正确', code: 'unknown' }
    })
    .catch((): TranslationReply<M['type']> => ({ ok: false, error: BACKGROUND_LOST_ERROR, code: 'disconnected' }))
  const timeout = new Promise<TranslationReply<M['type']>>((resolve) => {
    timer = setTimeout(() => {
      if (
        (message.type === 'wt:assist' || message.type === 'wt:translate') &&
        message.requestId !== undefined
      ) {
        void Promise.resolve()
          .then(() => browser.runtime.sendMessage({ type: 'wt:cancel-assist', requestId: message.requestId }))
          .catch(() => undefined)
      } else if (message.type === 'wt:list-models') {
        void Promise.resolve()
          .then(() => browser.runtime.sendMessage({ type: 'wt:cancel-models', requestId: message.requestId }))
          .catch(() => undefined)
      }
      resolve({ ok: false, error: '后台响应超时，请重试', code: 'disconnected' })
    }, watchdogMs(message))
  })
  void send.then(() => undefined, () => undefined)
  try {
    return await Promise.race([send, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
