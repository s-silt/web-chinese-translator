import { browser } from 'wxt/browser'
import type { BackgroundMessage, TabRequest } from './messages'

/** 内容脚本、后台响应超时：未回复时按无响应处理 */
export const MESSAGE_TIMEOUT_MS = 3000

/** 超时未完成时拒绝 */
async function withTimeout<T>(task: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs)
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 向标签页顶层框架的内容脚本发消息。
 * 响应来自页面上下文，调用方须自行校验（isContentStatus 等）。
 * 内容脚本未注入或超时未回复时 Promise 拒绝。
 */
export function sendToTabMessage(tabId: number, message: unknown, documentId?: string): Promise<unknown> {
  return withTimeout<unknown>(
    browser.tabs.sendMessage(tabId, message, { frameId: 0, ...(documentId === undefined ? {} : { documentId }) }),
    MESSAGE_TIMEOUT_MS,
    '内容脚本无响应',
  )
}

export function sendToTab(tabId: number, type: TabRequest['type']): Promise<unknown> {
  const message: TabRequest = { type }
  return sendToTabMessage(tabId, message)
}

/** 向后台发消息；超时未回复时 Promise 拒绝。调用方须校验响应（isAcknowledged） */
export function sendToBackground(message: BackgroundMessage, timeoutMs: number = MESSAGE_TIMEOUT_MS): Promise<unknown> {
  return withTimeout<unknown>(browser.runtime.sendMessage(message), timeoutMs, '后台无响应')
}
