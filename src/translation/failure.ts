const FAILURE_CODES = [
  'timeout',
  'rate_limited',
  'server',
  'network',
  'auth',
  'not_found',
  'bad_output',
  'queue_full',
  'queue_paused',
  'queue_timeout',
  'cancelled',
  'disconnected',
  'unknown',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

export interface FailureInfo {
  readonly code: FailureCode
  readonly retryAfterMs?: number
}

export const MAX_ATTEMPTS = 3
export const MAX_RETRY_AFTER_MS = 120_000
/** 非流式请求须低于 MV3 的 30 秒 fetch 限制。 */
export const MAX_REQUEST_TIMEOUT_MS = 28_000
/** 任务在后台队列中的最长等待时间，不含请求本身。 */
export const QUEUE_WAIT_LIMIT_MS = { interactive: 15_000, automatic: 45_000 } as const

const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 30_000
const REQUEST_TIMEOUT_BASE_MS = 18_000
const REQUEST_TIMEOUT_PER_CHAR_MS = 5
const TRANSIENT_CODES: readonly FailureCode[] = ['timeout', 'rate_limited', 'server', 'network', 'disconnected']
const HTTP_DATE_PATTERN = /^[A-Za-z]{3,9},? /

export function isFailureCode(value: unknown): value is FailureCode {
  return (FAILURE_CODES as readonly unknown[]).includes(value)
}

export function isTransientFailure(code: FailureCode): boolean {
  return TRANSIENT_CODES.includes(code)
}

/** 按请求内容长度放宽超时：min(18 秒 + 5 毫秒 × 字符数, 28 秒)。 */
export function requestTimeoutMs(chars: number): number {
  return Math.min(REQUEST_TIMEOUT_BASE_MS + chars * REQUEST_TIMEOUT_PER_CHAR_MS, MAX_REQUEST_TIMEOUT_MS)
}

/** 全抖动指数退避：第 n 次失败后在 [0, min(上限, 基数·2^(n-1))) 内取值。 */
export function backoffDelayMs(failures: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, failures - 1)
  return Math.floor(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent))
}

/** 解析 Retry-After（秒数或 HTTP 日期）；无效或已过期返回 undefined，结果不超过 MAX_RETRY_AFTER_MS。 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  const trimmed = value?.trim() ?? ''
  let delay: number
  if (/^\d+(\.\d+)?$/.test(trimmed)) delay = Number(trimmed) * 1000
  else if (HTTP_DATE_PATTERN.test(trimmed)) delay = Date.parse(trimmed) - now
  else return undefined
  if (!Number.isFinite(delay) || delay < 0) return undefined
  return Math.min(delay, MAX_RETRY_AFTER_MS)
}
