import type { TranslationContext } from './reading-context'

const CACHE_DB = 'web-translator-cache'
const CACHE_STORE = 'translations'
const LRU_INDEX = 'lru'
const DB_VERSION = 1
/** 协议和高级请求设置加入键布局；旧缓存按原有 TTL/LRU 规则淘汰。 */
const KEY_VERSION = 3

export interface CacheLimits {
  readonly maxEntries: number
  readonly maxBytes: number
}

const DEFAULT_LIMITS: CacheLimits = { maxEntries: 20_000, maxBytes: 20 * 1024 * 1024 }
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 超限时淘汰到上限的 90%，避免之后每次写入都全表扫描。 */
const EVICT_TARGET_RATIO = 0.9
const EVICT_BATCH = 500
/** 命中时最多每小时更新一次使用时间：LRU 只需粗略顺序，不值得每次读都写盘。 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000
const READ_TIMEOUT_MS = 500
const FAILURE_COOLDOWN_MS = 60_000
const ENTRY_OVERHEAD_BYTES = 256

interface CacheRecord {
  readonly translation: string
  readonly createdAt: number
  readonly usedAt: number
  readonly bytes: number
}

export interface TranslationCacheEntry {
  readonly translation: string
  readonly expiresAt: number
}

/** 决定译文内容的全部因素。接口、模型、提示词或语境变化时键随之变化，旧条目不可达，无需清库。 */
export interface PersistentCacheScope {
  readonly endpoint: string
  readonly model: string
  readonly prompt: string
  readonly targetLanguage: string
  readonly context?: TranslationContext
  readonly requestOptionsKey?: string
}

let unavailableUntil = 0
/** 库内规模的估算，本次后台生命周期首次写入时扫描得到；undefined 表示尚未扫描。 */
let estimate: { entries: number; bytes: number } | undefined
// 维护串行排队；某次失败被吞掉，不阻断后续 touch、写入和清扫。
let mutationTail: Promise<void> = Promise.resolve()
/** 每次清除时递增：清除前发起、尚未落盘的写入据此放弃，已清除的译文不会被写回。 */
let clearGeneration = 0

function serializeCacheMutation(run: () => Promise<void>): Promise<void> {
  const pending = mutationTail.then(run)
  mutationTail = pending.catch(() => undefined)
  return pending
}

function unavailable(): Error {
  return new Error('IndexedDB 不可用')
}

function usable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null && Date.now() >= unavailableUntil
}

function markFailed(): void {
  unavailableUntil = Date.now() + FAILURE_COOLDOWN_MS
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains(CACHE_STORE)) return
      // 索引键带上大小：淘汰扫描用 key cursor 即可算总量，不必把全部译文读进内存。
      db.createObjectStore(CACHE_STORE).createIndex(LRU_INDEX, ['usedAt', 'bytes'])
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? unavailable())
    }
    request.onblocked = () => {
      reject(unavailable())
    }
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await openCache()
  try {
    const transaction = db.transaction(CACHE_STORE, mode)
    const read = run(transaction.objectStore(CACHE_STORE))
    return await new Promise<T>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve(read())
      }
      transaction.onerror = (event) => {
        event.preventDefault()
        reject(transaction.error ?? unavailable())
      }
      transaction.onabort = () => {
        reject(transaction.error ?? unavailable())
      }
    })
  } finally {
    db.close()
  }
}

/** 语境相关的译文分开存放：页面或近期线索不同就是不同的桶。只有键的哈希落盘，语境本身不写入。 */
function contextBucket(context: TranslationContext | undefined): unknown {
  if (context === undefined) return null
  const page = ({ site, title, heading }: TranslationContext['currentPage']) => [site, title, heading]
  return [page(context.currentPage), context.recentPages.map(page)]
}

async function entryKey(scope: PersistentCacheScope, text: string): Promise<string> {
  const material = JSON.stringify([
    KEY_VERSION,
    scope.endpoint,
    scope.model,
    scope.prompt,
    scope.targetLanguage,
    contextBucket(scope.context),
    // 原文逐字参与缓存键；空白、Unicode 形式及换行可能属于字符串字面量。
    text,
    scope.requestOptionsKey ?? '',
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validRecord(value: unknown): value is CacheRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<CacheRecord>
  return (
    typeof record.translation === 'string' &&
    record.translation.trim() !== '' &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.usedAt === 'number' &&
    Number.isFinite(record.usedAt) &&
    typeof record.bytes === 'number' &&
    Number.isFinite(record.bytes) &&
    record.bytes >= 0
  )
}

async function touch(
  entries: readonly (readonly [string, CacheRecord])[],
  now: number,
  generation: number,
): Promise<void> {
  try {
    await serializeCacheMutation(() =>
      withStore<void>('readwrite', (store) => {
        if (generation !== clearGeneration) return () => undefined
        for (const [key, record] of entries) {
          const request = store.get(key) as IDBRequest<unknown>
          request.onsuccess = () => {
            const current = request.result
            if (
              generation !== clearGeneration ||
              !validRecord(current) ||
              current.createdAt !== record.createdAt ||
              current.translation !== record.translation ||
              current.bytes !== record.bytes ||
              now - current.usedAt <= TOUCH_INTERVAL_MS ||
              Date.now() >= current.createdAt + CACHE_TTL_MS
            ) {
              return
            }
            store.put({ ...current, usedAt: now }, key)
          }
        }
        return () => undefined
      }),
    )
  } catch {
    markFailed()
  }
}

async function lookup(scope: PersistentCacheScope, texts: readonly string[]): Promise<Map<string, TranslationCacheEntry>> {
  const generation = clearGeneration
  const keys = await Promise.all(texts.map((text) => entryKey(scope, text)))
  const values = await withStore('readonly', (store) => {
    const requests = keys.map((key) => store.get(key) as IDBRequest<unknown>)
    return () => requests.map((request) => request.result)
  })
  const now = Date.now()
  const found = new Map<string, TranslationCacheEntry>()
  const stale: [string, CacheRecord][] = []
  values.forEach((value, index) => {
    const text = texts[index]
    const key = keys[index]
    if (text === undefined || key === undefined || !validRecord(value)) return
    const expiresAt = value.createdAt + CACHE_TTL_MS
    if (now >= expiresAt) return
    found.set(text, { translation: value.translation, expiresAt })
    if (now - value.usedAt > TOUCH_INTERVAL_MS) stale.push([key, value])
  })
  if (stale.length > 0) void touch(stale, now, generation)
  return found
}

/** 查询持久缓存，返回译文及其绝对过期时间。永不拒绝：不可用、出错或超时都视为未命中，翻译照常走接口。 */
export async function readPersistentTranslations(
  scope: PersistentCacheScope,
  texts: readonly string[],
): Promise<Map<string, TranslationCacheEntry>> {
  if (texts.length === 0 || !usable()) return new Map()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(unavailable())
    }, READ_TIMEOUT_MS)
  })
  try {
    return await Promise.race([lookup(scope, texts), timeout])
  } catch {
    markFailed()
    return new Map()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 从最近使用的条目往回扫描：过期的总是删除；总量超限时再删掉目标水位之外最久未用的条目。 */
async function sweepOnce(limits: CacheLimits, generation: number): Promise<void> {
  const cutoff = Date.now() - CACHE_TTL_MS
  const targetEntries = Math.floor(limits.maxEntries * EVICT_TARGET_RATIO)
  const targetBytes = Math.floor(limits.maxBytes * EVICT_TARGET_RATIO)
  const expired: IDBValidKey[] = []
  const overflow: IDBValidKey[] = []
  const total = { entries: 0, bytes: 0 }
  const kept = { entries: 0, bytes: 0 }
  await withStore<void>('readonly', (store) => {
    if (generation !== clearGeneration) return () => undefined
    let overTarget = false
    const request = store.index(LRU_INDEX).openKeyCursor(null, 'prev')
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor === null) return
      const [usedAt, bytes] = cursor.key as [number, number]
      if (usedAt < cutoff) {
        expired.push(cursor.primaryKey)
      } else {
        total.entries += 1
        total.bytes += bytes
        overTarget ||= kept.entries >= targetEntries || kept.bytes + bytes > targetBytes
        if (overTarget) {
          overflow.push(cursor.primaryKey)
        } else {
          kept.entries += 1
          kept.bytes += bytes
        }
      }
      cursor.continue()
    }
    return () => undefined
  })
  if (generation !== clearGeneration) return
  const overCap = total.entries > limits.maxEntries || total.bytes > limits.maxBytes
  const doomed = overCap ? [...expired, ...overflow] : expired
  // 分批删除，让排队的读取不必等待一个覆盖全表的写事务。
  for (let start = 0; start < doomed.length; start += EVICT_BATCH) {
    const batch = doomed.slice(start, start + EVICT_BATCH)
    await withStore<void>('readwrite', (store) => {
      if (generation !== clearGeneration) return () => undefined
      for (const key of batch) store.delete(key)
      return () => undefined
    })
    if (generation !== clearGeneration) return
  }
  if (generation !== clearGeneration) return
  estimate = overCap ? kept : total
}

/** 写入成功的译文并按需淘汰。永不拒绝，调用方无需等待：写不进去只是少一次命中。 */
export async function writePersistentTranslations(
  scope: PersistentCacheScope,
  entries: readonly (readonly [text: string, translation: string])[],
  limits: CacheLimits = DEFAULT_LIMITS,
): Promise<void> {
  if (entries.length === 0 || !usable()) return
  const generation = clearGeneration
  try {
    const keys = await Promise.all(entries.map(([text]) => entryKey(scope, text)))
    await serializeCacheMutation(async () => {
      if (generation !== clearGeneration) return
      const now = Date.now()
      let added = 0
      await withStore<void>('readwrite', (store) => {
        if (generation !== clearGeneration) return () => undefined
        entries.forEach(([, translation], index) => {
          const bytes = translation.length * 2 + ENTRY_OVERHEAD_BYTES
          const record: CacheRecord = { translation, createdAt: now, usedAt: now, bytes }
          store.put(record, keys[index])
          added += bytes
        })
        return () => undefined
      })
      if (generation !== clearGeneration) return
      // 覆盖已有键会高估，最多让淘汰扫描提前发生，扫描后即校正。
      if (estimate !== undefined) {
        estimate = { entries: estimate.entries + entries.length, bytes: estimate.bytes + added }
      }
      if (estimate === undefined || estimate.entries > limits.maxEntries || estimate.bytes > limits.maxBytes) {
        await sweepOnce(limits, generation)
      }
    })
  } catch {
    markFailed()
  }
}

/** 清空持久译文。永不拒绝，返回是否确实清空；用户显式操作，即使处于失败冷却期也会尝试。 */
export async function clearPersistentTranslations(): Promise<boolean> {
  // 不入 mutationTail：先作废代际，再直接清空。
  clearGeneration += 1
  try {
    await withStore<void>('readwrite', (store) => {
      store.clear()
      return () => undefined
    })
    estimate = undefined
    return true
  } catch {
    markFailed()
    return false
  }
}
