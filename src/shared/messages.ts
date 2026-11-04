import type { PageKey } from '../core/types'
import { parseGitHubUrl } from './github'
import { isPageLocale, type PageLocale } from './locale'

export type GitHubPageAction = 'status' | 'restore' | 'resume'
export interface GitHubPageState { readonly active: boolean; readonly paused: boolean }
export interface GitHubPageReply extends GitHubPageState { readonly ok: true }

/** popup、后台 → content script 的消息 */
export type ContentMessage =
  | { readonly type: 'gcn:get-status' }
  /** 自定义词条已变化，重新读取（后台转发设置页的保存通知） */
  | { readonly type: 'gcn:custom-entries-changed' }
  | { readonly type: 'gcn:page-translation'; readonly action: GitHubPageAction; readonly url: string }

/** popup 向内容脚本发的请求 */
export type TabRequest = Extract<ContentMessage, { readonly type: 'gcn:get-status' }>

export interface ContentStatus {
  /** 当前页面正在翻译 */
  readonly active: boolean
  /** 当前路径被排除 */
  readonly excluded: boolean
  /** 当前页面类型 */
  readonly pages: readonly PageKey[]
  /** 已翻译的文本节点与属性数 */
  readonly translatedCount: number
}

/** 内容脚本、扩展页面 → 后台的消息 */
export type BackgroundMessage =
  /** 自定义词条已保存（设置页），由后台转发给各 GitHub 标签页 */
  | { readonly type: 'gcn:custom-entries-saved' }
  /** 内容脚本动态导入词典脚本失败时，请后台把词典脚本注入发送方所在的框架 */
  | { readonly type: 'gcn:inject-locale'; readonly locale: PageLocale }

/** 后台应答：处理成功为 ok */
export interface BackgroundAck {
  readonly ok: boolean
}

const CONTENT_MESSAGE_TYPES: ReadonlySet<string> = new Set<ContentMessage['type']>([
  'gcn:get-status',
  'gcn:custom-entries-changed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isGitHubPageAction(value: unknown): value is GitHubPageAction {
  return value === 'status' || value === 'restore' || value === 'resume'
}

export function isGitHubPageState(value: unknown): value is GitHubPageState {
  return isRecord(value) && typeof value.active === 'boolean' && typeof value.paused === 'boolean'
}

export function isGitHubPageReply(value: unknown): value is GitHubPageReply {
  return isRecord(value) && value.ok === true && typeof value.active === 'boolean' && typeof value.paused === 'boolean'
}

export function isContentMessage(value: unknown): value is ContentMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'gcn:page-translation') {
    return isGitHubPageAction(value.action) && typeof value.url === 'string' && parseGitHubUrl(value.url) !== undefined
  }
  return CONTENT_MESSAGE_TYPES.has(value.type)
}

/** 校验内容脚本返回的状态 */
export function isContentStatus(value: unknown): value is ContentStatus {
  return (
    isRecord(value) &&
    typeof value.active === 'boolean' &&
    typeof value.excluded === 'boolean' &&
    Array.isArray(value.pages) &&
    value.pages.every((page) => typeof page === 'string') &&
    isCount(value.translatedCount)
  )
}

/** 校验发往后台的消息 */
export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  if (!isRecord(value)) return false
  if (value.type === 'gcn:custom-entries-saved') return true
  return value.type === 'gcn:inject-locale' && isPageLocale(value.locale)
}

/** 后台已确认处理 */
export function isAcknowledged(value: unknown): value is BackgroundAck {
  return isRecord(value) && value.ok === true
}
