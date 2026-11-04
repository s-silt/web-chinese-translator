import { completionUrl } from './config'
import type { SourceLanguage } from './target-language'
import {
  CACHE_TTL_MS,
  readPersistentTranslations,
  writePersistentTranslations,
  type PersistentCacheScope,
  type TranslationCacheEntry,
} from './persistent-cache'
import { translateTextsPartial, translationPrompt, TranslationError } from './provider'
import type { FailureCode } from './failure'
import { cancelModelTasks, describeFailure, modelSchedulerGeneration, scheduleModelTask } from './scheduler'
import { CompletionCancelledError, invalidCompletion } from './transport'
import { modelRequestConfig, type ModelSnapshot } from './model-state'
import type { TranslationContext } from './reading-context'
import { requestOptionsCacheKey } from './request-options'

export type TranslateOutcome =
  | {
      ok: true
      texts: string[]
      /** 由缓存直接提供的字符数：没有花费接口额度，页面不应计入预算。 */
      cachedChars?: number
      error?: never
      code?: never
      retryAfterMs?: never
    }
  | {
      ok: false
      error: string
      code?: FailureCode
      retryAfterMs?: number
      texts?: never
      cachedChars?: never
    }

export type StillAllowed = (snapshot: ModelSnapshot) => Promise<boolean>

const CACHE_MAX_ITEMS = 256
const CACHE_MAX_BYTES = 512 * 1024

const cache = new Map<string, TranslationCacheEntry>()
let cacheBytes = 0
let epoch = 0

/** 只清内存层并取消在途工作。持久层不随之清空：输出相关的配置变化会改变它的键，旧条目自然不可达。 */
export function clearTranslationCache(): void {
  epoch += 1
  cache.clear()
  cacheBytes = 0
  cancelModelTasks()
}

function cacheKey(
  endpoint: string,
  model: string,
  language: string,
  context: unknown,
  text: string,
  sourceLanguage: SourceLanguage = 'auto',
  optionsKey = '',
): string {
  return JSON.stringify([endpoint, model, language, sourceLanguage, context ?? null, text, optionsKey])
}

function liveEntry(value: TranslationCacheEntry | undefined): TranslationCacheEntry | undefined {
  return value !== undefined && Date.now() < value.expiresAt ? value : undefined
}

function entryBytes(key: string, value: TranslationCacheEntry): number {
  return (key.length + value.translation.length) * 2 + 8
}

function cacheGet(key: string): TranslationCacheEntry | undefined {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  if (liveEntry(value) === undefined) {
    cacheBytes -= entryBytes(key, value)
    return undefined
  }
  cache.set(key, value)
  return value
}

function cacheSet(key: string, value: TranslationCacheEntry): void {
  if (liveEntry(value) === undefined) return
  const existing = cache.get(key)
  if (existing !== undefined) {
    cacheBytes -= entryBytes(key, existing)
    cache.delete(key)
  }
  cache.set(key, value)
  cacheBytes += entryBytes(key, value)
  while (cache.size > CACHE_MAX_ITEMS || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const evicted = cache.get(oldest)
    cache.delete(oldest)
    if (evicted !== undefined) cacheBytes -= entryBytes(oldest, evicted)
  }
}

function isBadOutput(error: unknown): boolean {
  return error instanceof TranslationError && error.code === 'bad_output'
}

function cachedCharsField(chars: number): Pick<TranslateOutcome, 'cachedChars'> {
  return chars > 0 ? { cachedChars: chars } : {}
}

async function runJob(
  snapshot: ModelSnapshot,
  mode: 'selection' | 'auto',
  texts: readonly string[],
  epoch0: number,
  signal: AbortSignal,
  context: TranslationContext | undefined,
  persisted: ReadonlyMap<string, TranslationCacheEntry>,
  persistentScope: PersistentCacheScope | undefined,
  optionsKey: string,
): Promise<TranslateOutcome> {
  if (signal.aborted || epoch !== epoch0) throw new CompletionCancelledError()
  const endpoint = completionUrl(snapshot.config.baseUrl, snapshot.config.apiType)
  const results = texts.map((text) =>
    cacheGet(
      cacheKey(
        endpoint,
        snapshot.config.model,
        snapshot.config.targetLanguage,
        context,
        text,
        snapshot.config.sourceLanguage,
        optionsKey,
      ),
    ) ?? liveEntry(persisted.get(text)),
  )
  let cachedChars = 0
  const misses = new Set<string>()
  results.forEach((value, index) => {
    const text = texts[index]!
    if (value !== undefined) cachedChars += text.length
    else misses.add(text)
  })
  const uniqueMisses = [...misses]
  const fresh = new Map<string, TranslationCacheEntry>()
  let failed: unknown
  if (uniqueMisses.length > 0) {
    try {
      const values = await translateTextsPartial(
        modelRequestConfig(snapshot),
        uniqueMisses,
        snapshot.apiKey,
        fetch,
        signal,
        context,
      )
      const expiresAt = Date.now() + CACHE_TTL_MS
      uniqueMisses.forEach((text, index) => {
        const translation = values[index]
        if (translation === undefined) failed ??= invalidCompletion()
        else fresh.set(text, { translation, expiresAt })
      })
    } catch (error) {
      failed = error
    }
  }
  if (signal.aborted || epoch !== epoch0) throw new CompletionCancelledError()
  texts.forEach((text, index) => {
    results[index] ??= fresh.get(text)
  })
  if (failed === undefined && results.some((value) => value === undefined)) failed = invalidCompletion()
  const partial = mode === 'auto' && isBadOutput(failed) && results.some((value) => value !== undefined)
  if (failed !== undefined && !partial) throw failed
  texts.forEach((text, index) => {
    const value = results[index]
    if (value !== undefined) {
      cacheSet(
        cacheKey(
          endpoint,
          snapshot.config.model,
          snapshot.config.targetLanguage,
          context,
          text,
          snapshot.config.sourceLanguage,
          optionsKey,
        ),
        value,
      )
    }
  })
  if (persistentScope !== undefined && fresh.size > 0) {
    void writePersistentTranslations(
      persistentScope,
      [...fresh].map(([text, value]) => [text, value.translation]),
    )
  }
  return { ok: true, texts: results.map((value) => value?.translation ?? ''), ...cachedCharsField(cachedChars) }
}

export async function requestTranslation(
  snapshot: ModelSnapshot,
  mode: 'selection' | 'auto',
  texts: readonly string[],
  stillAllowed: StillAllowed,
  context?: TranslationContext,
  signal?: AbortSignal,
  persist = true,
): Promise<TranslateOutcome> {
  const epoch0 = epoch
  const scheduler0 = modelSchedulerGeneration()
  const checkActive = (currentSignal?: AbortSignal): void => {
    if (currentSignal?.aborted || epoch !== epoch0 || modelSchedulerGeneration() !== scheduler0) {
      throw new CompletionCancelledError()
    }
  }
  try {
    checkActive(signal)
    const endpoint = completionUrl(snapshot.config.baseUrl, snapshot.config.apiType)
    const optionsKey = await requestOptionsCacheKey(snapshot.config)
    checkActive(signal)
    const memory = texts.map((text) =>
      cacheGet(
        cacheKey(
          endpoint,
          snapshot.config.model,
          snapshot.config.targetLanguage,
          context,
          text,
          snapshot.config.sourceLanguage,
          optionsKey,
        ),
      ),
    )
    // 含近期阅读线索的译文只保留在内存，避免长期保存跨页面语境相关的结果。
    const hasRecentPages = context !== undefined && context.recentPages.length > 0
    const persistentScope: PersistentCacheScope | undefined = persist && !hasRecentPages
      ? {
          endpoint,
          model: snapshot.config.model,
          prompt: translationPrompt(context, snapshot.config.targetLanguage, snapshot.config.sourceLanguage),
          targetLanguage: snapshot.config.targetLanguage,
          ...(context === undefined ? {} : { context }),
          requestOptionsKey: optionsKey,
        }
      : undefined
    let persisted: ReadonlyMap<string, TranslationCacheEntry> = new Map()
    if (persistentScope !== undefined) {
      const missing = new Set(texts.filter((_, index) => memory[index] === undefined))
      if (missing.size > 0) {
        // 在占用调度槽之前查询：整批命中的页面不用排队，也不受接口限流影响。
        persisted = await readPersistentTranslations(persistentScope, [...missing])
        checkActive(signal)
        for (const [text, entry] of persisted) {
          cacheSet(
            cacheKey(
              endpoint,
              snapshot.config.model,
              snapshot.config.targetLanguage,
              context,
              text,
              snapshot.config.sourceLanguage,
              optionsKey,
            ),
            entry,
          )
        }
      }
    }
    const cached = texts.map((text, index) => liveEntry(memory[index]) ?? liveEntry(persisted.get(text)))
    if (cached.every((value): value is TranslationCacheEntry => value !== undefined)) {
      if (!(await stillAllowed(snapshot))) throw new TranslationError('该站点未开启自动翻译')
      checkActive(signal)
      if (cached.every((value) => liveEntry(value) !== undefined)) {
        const chars = texts.reduce((sum, text) => sum + text.length, 0)
        return { ok: true, texts: cached.map((value) => value.translation), ...cachedCharsField(chars) }
      }
    }
    return await scheduleModelTask(mode === 'selection' ? 'interactive' : 'automatic', async (scheduledSignal) => {
      checkActive(scheduledSignal)
      if (!(await stillAllowed(snapshot))) throw new TranslationError('该站点未开启自动翻译')
      checkActive(scheduledSignal)
      return runJob(snapshot, mode, texts, epoch0, scheduledSignal, context, persisted, persistentScope, optionsKey)
    }, signal)
  } catch (error) {
    return { ok: false, ...describeFailure(error) }
  }
}
