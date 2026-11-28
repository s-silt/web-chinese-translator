import { browser } from 'wxt/browser'
import { fromOurContent, fromOurInputFrame, fromTextWindow, type MessageSender } from './background-sender'
import type { RequestKind, RequestScope } from './config-impact'
import { PAGE_PORT_PREFIX } from './messages'
import { isPageId } from './reading-context'

/** 在途请求及其适用范围：配置变更时只中止受影响的请求。 */
export class TrackedRequest extends AbortController implements RequestScope {
  readonly kind: RequestKind
  url: string
  readonly pageSession: string | undefined
  sourceUrl: string | undefined
  recentSites: readonly string[] = []
  cancellationHint: 'settings' | 'permissions' | undefined

  constructor(kind: RequestKind, url: string, pageSession?: string) {
    super()
    this.kind = kind
    this.url = url
    this.pageSession = pageSession
  }
}

export const requests = new Map<string, TrackedRequest>()
export const interactive = new Set<string>()
/** 已结束的页面会话：旧文档卸载前发出的消息可能晚于端口断开才到达。 */
const endedPageSessions = new Set<string>()
const ENDED_PAGE_SESSIONS_MAX = 256

export function assistScope(sender: MessageSender): string {
  return `${sender.tab?.id ?? -1}:${sender.documentId ?? sender.frameId ?? 0}`
}

/** 带上标签页与文档作用域，一个页面或子文档无法影响其他会话。 */
export function pageSessionKey(sender: MessageSender, session: string | undefined): string | undefined {
  return session === undefined ? undefined : `${assistScope(sender)}:${session}`
}

export function pageSessionEnded(key: string | undefined): boolean {
  return key !== undefined && endedPageSessions.has(key)
}

/**
 * 文档已消失：中止它的排队与在途请求，让出调度槽。中止走 cancelled 路径，不计失败，也不触发 429 暂停。
 * 按会话而不是 assistScope 匹配：Firefox 没有 documentId，同一标签页的新旧文档共用一个 scope。
 */
export function endPageSession(key: string): void {
  endedPageSessions.add(key)
  if (endedPageSessions.size > ENDED_PAGE_SESSIONS_MAX) {
    const oldest = endedPageSessions.values().next().value
    if (oldest !== undefined) endedPageSessions.delete(oldest)
  }
  for (const [requestKey, request] of requests) {
    if (request.pageSession !== key) continue
    request.abort()
    requests.delete(requestKey)
    interactive.delete(requestKey)
  }
}

export function abortTabRequests(tabId: number): void {
  for (const [key, controller] of requests) {
    if (key.startsWith(`${tabId}:`)) {
      controller.abort()
      requests.delete(key)
      interactive.delete(key)
    }
  }
}

export function installPageSessions(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(PAGE_PORT_PREFIX)) return
    const session = port.name.slice(PAGE_PORT_PREFIX.length)
    const sender = port.sender
    if (
      sender === undefined ||
      (!fromOurContent(sender) && !fromOurInputFrame(sender) && !fromTextWindow(sender)) ||
      !isPageId(session)
    ) {
      port.disconnect()
      return
    }
    const key = pageSessionKey(sender, session)!
    port.onDisconnect.addListener(() => {
      endPageSession(key)
    })
  })
}
