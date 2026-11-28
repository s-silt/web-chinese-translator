import { storage } from 'wxt/utils/storage'

export interface CompletionUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface UsageBucket {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheHits: number
  readonly translatedChars: number
}

export interface UsageStatsSnapshot {
  readonly todayDate: string
  readonly today: UsageBucket
  readonly monthKey: string
  readonly month: UsageBucket
  readonly total: UsageBucket
}

const EMPTY_BUCKET: UsageBucket = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheHits: 0,
  translatedChars: 0,
}

function localDateKey(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localMonthKey(now: Date): string {
  return localDateKey(now).slice(0, 7)
}

export function emptyUsageStats(now: Date = new Date()): UsageStatsSnapshot {
  return {
    todayDate: localDateKey(now),
    today: { ...EMPTY_BUCKET },
    monthKey: localMonthKey(now),
    month: { ...EMPTY_BUCKET },
    total: { ...EMPTY_BUCKET },
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function sanitizeBucket(value: unknown): UsageBucket {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...EMPTY_BUCKET }
  const record = value as Record<string, unknown>
  return {
    requests: isFiniteNonNegative(record.requests) ? Math.floor(record.requests) : 0,
    inputTokens: isFiniteNonNegative(record.inputTokens) ? Math.floor(record.inputTokens) : 0,
    outputTokens: isFiniteNonNegative(record.outputTokens) ? Math.floor(record.outputTokens) : 0,
    cacheHits: isFiniteNonNegative(record.cacheHits) ? Math.floor(record.cacheHits) : 0,
    translatedChars: isFiniteNonNegative(record.translatedChars) ? Math.floor(record.translatedChars) : 0,
  }
}

export function sanitizeUsageStats(value: unknown, now: Date = new Date()): UsageStatsSnapshot {
  const todayDate = localDateKey(now)
  const monthKey = localMonthKey(now)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyUsageStats(now)
  const record = value as Record<string, unknown>
  return {
    todayDate,
    today: record.todayDate === todayDate ? sanitizeBucket(record.today) : { ...EMPTY_BUCKET },
    monthKey,
    month: record.monthKey === monthKey ? sanitizeBucket(record.month) : { ...EMPTY_BUCKET },
    total: sanitizeBucket(record.total),
  }
}

export function isUsageStatsSnapshot(value: unknown): value is UsageStatsSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.todayDate === 'string' &&
    typeof record.monthKey === 'string' &&
    [record.today, record.month, record.total].every(bucket => {
      if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) return false
      return Object.keys(EMPTY_BUCKET).every(key => {
        const count = (bucket as Record<string, unknown>)[key]
        return isFiniteNonNegative(count) && Number.isSafeInteger(count)
      })
    })
  )
}

function addBucket(base: UsageBucket, delta: Partial<UsageBucket>): UsageBucket {
  return {
    requests: base.requests + (delta.requests ?? 0),
    inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
    cacheHits: base.cacheHits + (delta.cacheHits ?? 0),
    translatedChars: base.translatedChars + (delta.translatedChars ?? 0),
  }
}

export const usageStatsItem = storage.defineItem<UsageStatsSnapshot>('local:translationUsageStats', {
  fallback: emptyUsageStats(),
})

let writeQueue: Promise<void> = Promise.resolve()

export async function getUsageStats(now: Date = new Date()): Promise<UsageStatsSnapshot> {
  await writeQueue
  return sanitizeUsageStats(await usageStatsItem.getValue(), now)
}

export function recordUsageDelta(delta: Partial<UsageBucket>, now: Date = new Date()): Promise<UsageStatsSnapshot> {
  const pending = writeQueue.then(async () => {
    const current = sanitizeUsageStats(await usageStatsItem.getValue(), now)
    const next: UsageStatsSnapshot = {
      todayDate: current.todayDate,
      today: addBucket(current.today, delta),
      monthKey: current.monthKey,
      month: addBucket(current.month, delta),
      total: addBucket(current.total, delta),
    }
    await usageStatsItem.setValue(next)
    return next
  })
  writeQueue = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

export function resetUsageStats(now: Date = new Date()): Promise<UsageStatsSnapshot> {
  const pending = writeQueue.then(async () => {
    const next = emptyUsageStats(now)
    await usageStatsItem.setValue(next)
    return next
  })
  writeQueue = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

/** 从 OpenAI Chat Completions / Responses 或 Anthropic 风格响应中提取 Token 用量。 */
export function extractCompletionUsage(payload: unknown): CompletionUsage | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const usage = (payload as Record<string, unknown>).usage
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return undefined
  const record = usage as Record<string, unknown>
  const inputRaw = record.prompt_tokens ?? record.input_tokens
  const outputRaw = record.completion_tokens ?? record.output_tokens
  const totalRaw = record.total_tokens
  const inputTokens = isFiniteNonNegative(inputRaw) ? Math.floor(inputRaw) : 0
  const outputTokens = isFiniteNonNegative(outputRaw) ? Math.floor(outputRaw) : 0
  const totalTokens = isFiniteNonNegative(totalRaw) ? Math.floor(totalRaw) : inputTokens + outputTokens
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined
  return { inputTokens, outputTokens, totalTokens }
}
