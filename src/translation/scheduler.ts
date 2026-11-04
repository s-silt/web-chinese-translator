import { browser } from 'wxt/browser'
import { backoffDelayMs, MAX_RETRY_AFTER_MS, QUEUE_WAIT_LIMIT_MS, type FailureCode } from './failure'
import { CompletionCancelledError, TranslationError } from './transport'

export class QueueFullError extends Error {
  constructor() {
    super('请求过多，请稍后重试')
    this.name = 'QueueFullError'
  }
}

export class QueueTimeoutError extends Error {
  constructor() {
    super('排队等待超时，请稍后重试')
    this.name = 'QueueTimeoutError'
  }
}

export class AutomaticPausedError extends Error {
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super('请求过于频繁，自动翻译稍后继续')
    this.name = 'AutomaticPausedError'
    this.retryAfterMs = retryAfterMs
  }
}

export type TaskPriority = 'interactive' | 'automatic'

interface ScheduledJob<T> {
  priority: TaskPriority
  run: (signal: AbortSignal) => Promise<T>
  controller: AbortController
  resolve: (value: T) => void
  reject: (error: unknown) => void
  queueTimer?: ReturnType<typeof setTimeout>
}

const MAX_CONCURRENT = 2
const MAX_WAITING = 16
const MAX_AUTOMATIC_CONCURRENT = MAX_CONCURRENT - 1
const MAX_AUTOMATIC_WAITING = MAX_WAITING - MAX_CONCURRENT
const MIN_RATE_LIMIT_PAUSE_MS = 1000
const PAUSE_KEY = 'wtAutomaticPausedUntil'
const HEARTBEAT_MS = 20_000

const running = new Set<ScheduledJob<unknown>>()
const waiting: ScheduledJob<unknown>[] = []
let generation = 0
let automaticPausedUntil = 0
let rateLimitStreak = 0
let pauseRestore: Promise<void> | undefined
let pauseRevision = 0
let heartbeat: ReturnType<typeof setInterval> | undefined

/** 有任务时定期调用扩展 API，避免排队期间后台被判定空闲而终止。等待中的任务总排在运行中的任务之后，只需看 running。 */
function syncHeartbeat(): void {
  if (running.size > 0 && heartbeat === undefined) {
    heartbeat = setInterval(() => {
      void Promise.resolve()
        .then(() => browser.runtime.getPlatformInfo())
        .catch(() => undefined)
    }, HEARTBEAT_MS)
  } else if (running.size === 0 && heartbeat !== undefined) {
    clearInterval(heartbeat)
    heartbeat = undefined
  }
}

function persistAutomaticPause(): void {
  void Promise.resolve()
    .then(() =>
      automaticPausedUntil > 0
        ? browser.storage.session.set({ [PAUSE_KEY]: automaticPausedUntil })
        : browser.storage.session.remove(PAUSE_KEY),
    )
    .catch(() => undefined)
}

/** 后台重启后恢复 429 暂停时间；每次后台生命周期只读取一次。 */
export function restoreAutomaticPause(): Promise<void> {
  const revision = pauseRevision
  pauseRestore ??= Promise.resolve()
    .then(() => (browser.storage.session.get as (key: string) => Promise<Record<string, unknown>>)(PAUSE_KEY))
    .then((stored) => {
      if (revision !== pauseRevision) return
      const until = stored[PAUSE_KEY]
      if (typeof until !== 'number' || !Number.isFinite(until)) return
      automaticPausedUntil = Math.max(automaticPausedUntil, Math.min(until, Date.now() + MAX_RETRY_AFTER_MS))
    })
    .catch(() => undefined)
  return pauseRestore
}

export function automaticPauseRemainingMs(): number {
  return Math.max(0, automaticPausedUntil - Date.now())
}

/** 暂停全部自动任务：等待中的任务带剩余时间拒绝，积压留在各页面，到时由页面自行重发。 */
export function pauseAutomaticTasks(retryAfterMs?: number): void {
  rateLimitStreak += 1
  const pauseMs = Math.min(
    retryAfterMs ?? Math.max(MIN_RATE_LIMIT_PAUSE_MS, backoffDelayMs(rateLimitStreak)),
    MAX_RETRY_AFTER_MS,
  )
  automaticPausedUntil = Math.max(automaticPausedUntil, Date.now() + pauseMs)
  persistAutomaticPause()
  const remaining = automaticPauseRemainingMs()
  for (const job of waiting.filter((item) => item.priority === 'automatic')) {
    waiting.splice(waiting.indexOf(job), 1)
    job.reject(new AutomaticPausedError(remaining))
  }
}

export function clearAutomaticPause(): void {
  pauseRevision += 1
  automaticPausedUntil = 0
  rateLimitStreak = 0
  pauseRestore = Promise.resolve()
  persistAutomaticPause()
}

export function describeFailure(error: unknown): { error: string; code: FailureCode; retryAfterMs?: number } {
  if (error instanceof CompletionCancelledError) return { error: '已取消', code: 'cancelled' }
  if (error instanceof QueueFullError) return { error: error.message, code: 'queue_full' }
  if (error instanceof QueueTimeoutError) return { error: error.message, code: 'queue_timeout' }
  if (error instanceof AutomaticPausedError) {
    return { error: error.message, code: 'queue_paused', retryAfterMs: error.retryAfterMs }
  }
  if (!(error instanceof TranslationError)) return { error: '无法连接翻译服务', code: 'unknown' }
  const retryAfterMs = error.code === 'rate_limited' ? automaticPauseRemainingMs() || error.retryAfterMs : error.retryAfterMs
  return { error: error.message, code: error.code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
}

export function modelSchedulerGeneration(): number {
  return generation
}

export function cancelModelTasks(): void {
  generation += 1
  for (const job of waiting.splice(0)) {
    job.controller.abort()
    job.reject(new CompletionCancelledError())
  }
  for (const job of running) {
    job.controller.abort()
  }
}

function schedule(): void {
  while (running.size < MAX_CONCURRENT && waiting.length > 0) {
    const automaticRunning = [...running].filter((item) => item.priority === 'automatic').length
    const index = waiting.findIndex((item) =>
      item.priority === 'interactive' || automaticRunning < MAX_AUTOMATIC_CONCURRENT,
    )
    if (index < 0) return
    const [job] = waiting.splice(index, 1)
    if (job === undefined) return
    clearTimeout(job.queueTimer)
    running.add(job)
    void Promise.resolve()
      .then(() => {
        if (job.controller.signal.aborted) throw new CompletionCancelledError()
        return job.run(job.controller.signal)
      })
      .then(
        (value) => {
          if (job.controller.signal.aborted) {
            job.reject(new CompletionCancelledError())
          } else {
            rateLimitStreak = 0
            job.resolve(value)
          }
        },
        (error: unknown) => {
          if (job.controller.signal.aborted) {
            job.reject(new CompletionCancelledError())
            return
          }
          if (error instanceof TranslationError && error.code === 'rate_limited') {
            pauseAutomaticTasks(error.retryAfterMs)
          }
          job.reject(error)
        },
      )
      .finally(() => {
        running.delete(job)
        schedule()
        syncHeartbeat()
      })
  }
}

export function scheduleModelTask<T>(
  priority: TaskPriority,
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CompletionCancelledError())
      return
    }
    const pausedMs = priority === 'automatic' ? automaticPauseRemainingMs() : 0
    if (pausedMs > 0) {
      reject(new AutomaticPausedError(pausedMs))
      return
    }
    if (
      waiting.length >= MAX_WAITING ||
      (priority === 'automatic' && waiting.filter((item) => item.priority === 'automatic').length >= MAX_AUTOMATIC_WAITING)
    ) {
      reject(new QueueFullError())
      return
    }
    const controller = new AbortController()
    const onAbort = (): void => {
      controller.abort()
      const index = waiting.indexOf(job as ScheduledJob<unknown>)
      if (index >= 0) {
        waiting.splice(index, 1)
        job.reject(new CompletionCancelledError())
      }
    }
    const job: ScheduledJob<T> = {
      priority,
      run,
      controller,
      resolve: (value) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      reject: (error: unknown) => {
        clearTimeout(job.queueTimer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (priority === 'interactive') {
      const firstAuto = waiting.findIndex((item) => item.priority !== 'interactive')
      if (firstAuto < 0) waiting.push(job as ScheduledJob<unknown>)
      else waiting.splice(firstAuto, 0, job as ScheduledJob<unknown>)
    } else {
      waiting.push(job as ScheduledJob<unknown>)
    }
    schedule()
    syncHeartbeat()
    if (waiting.includes(job as ScheduledJob<unknown>)) {
      job.queueTimer = setTimeout(() => {
        const index = waiting.indexOf(job as ScheduledJob<unknown>)
        if (index < 0) return
        waiting.splice(index, 1)
        job.reject(new QueueTimeoutError())
      }, QUEUE_WAIT_LIMIT_MS[priority])
    }
  })
}
