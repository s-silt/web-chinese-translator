import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import type { ModelSnapshot } from '../../../src/translation/model-state'
import { requestOptionsKey } from '../../../src/translation/request-options'
import { clearTranslationCache, requestTranslation } from '../../../src/translation/queue'
import * as scheduler from '../../../src/translation/scheduler'
import {
  CACHE_TTL_MS,
  type PersistentCacheScope,
} from '../../../src/translation/persistent-cache'
import * as persistentCache from '../../../src/translation/persistent-cache'

const DB = 'web-translator-cache'
const STORE = 'translations'
const NOW = Date.UTC(2026, 9, 1)
const DAY_MS = 24 * 60 * 60 * 1000

const scope: PersistentCacheScope = {
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'm',
  prompt: 'prompt-1',
  targetLanguage: 'zh-Hans',
}

const page = { site: 'a.example', title: 'Title', heading: 'Heading' }

/** 每次重新导入模块，模拟后台重启：内存状态全部丢失，只有 IndexedDB 留下。 */
function restartWorker() {
  vi.resetModules()
  return import('../../../src/translation/persistent-cache')
}

async function sha256Hex(material: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB)
    request.onsuccess = () => {
      resolve()
    }
    request.onerror = () => {
      reject(request.error ?? new Error('delete failed'))
    }
  })
}

async function withRawStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB)
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'))
    }
  })
  try {
    const transaction = db.transaction(STORE, mode)
    const request = run(transaction.objectStore(STORE))
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve()
      }
      transaction.onabort = () => {
        reject(transaction.error ?? new Error('aborted'))
      }
    })
    return request === undefined ? undefined : request.result
  } finally {
    db.close()
  }
}

async function rawRecords(): Promise<{ keys: IDBValidKey[]; values: { translation: string; usedAt: number }[] }> {
  const keys = (await withRawStore('readonly', (store) => store.getAllKeys())) ?? []
  const values = ((await withRawStore('readonly', (store) => store.getAll())) ?? []) as {
    translation: string
    usedAt: number
  }[]
  return { keys, values }
}

let now = NOW

beforeEach(async () => {
  await deleteDb()
  now = NOW
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('持久译文缓存', () => {
  it('后台重启后仍能命中', async () => {
    const before = await restartWorker()
    await before.writePersistentTranslations(scope, [['Hello', '你好']])
    const after = await restartWorker()
    const found = await after.readPersistentTranslations(scope, ['Hello', 'Bye'])
    expect(found).toEqual(new Map([['Hello', { translation: '你好', expiresAt: NOW + CACHE_TTL_MS }]]))
    expect(found.get('Hello')?.expiresAt).toBe(NOW + CACHE_TTL_MS)
  })

  it.each<[string, PersistentCacheScope]>([
    ['接口', { ...scope, endpoint: 'https://other.example/v1/chat/completions' }],
    ['模型', { ...scope, model: 'n' }],
    ['提示词', { ...scope, prompt: 'prompt-2' }],
    ['目标语言', { ...scope, targetLanguage: 'zh-Hant' }],
    ['当前页语境', { ...scope, context: { currentPage: page, recentPages: [] } }],
  ])('%s 不同则不可达，原条目保留', async (_name, other) => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['Hello', '你好']])
    expect((await cache.readPersistentTranslations(other, ['Hello'])).size).toBe(0)
    expect((await cache.readPersistentTranslations(scope, ['Hello'])).get('Hello')?.translation).toBe('你好')
  })

  it('语境相关的译文分桶：页面或近期线索不同都不共用，相同则命中', async () => {
    const cache = await restartWorker()
    const context = { currentPage: page, recentPages: [{ site: 'b.example', title: 'Kubernetes', heading: '' }] }
    await cache.writePersistentTranslations({ ...scope, context }, [['pod', '容器组']])
    const lookup = async (next: typeof context) =>
      (await cache.readPersistentTranslations({ ...scope, context: next }, ['pod'])).get('pod')?.translation
    expect(await lookup({ ...context })).toBe('容器组')
    expect(await lookup({ ...context, recentPages: [] })).toBeUndefined()
    expect(await lookup({ ...context, currentPage: { ...page, title: 'Whales' } })).toBeUndefined()
    expect(await lookup({ ...context, recentPages: [{ site: 'b.example', title: 'Whales', heading: '' }] })).toBeUndefined()
  })

  it('不同站点不共用译文，近期线索里的站点不算当前站点', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations({ ...scope, context: { currentPage: page, recentPages: [] } }, [['pod', '容器组']])
    const other = {
      currentPage: { ...page, site: 'b.example' },
      recentPages: [page],
    }
    expect((await cache.readPersistentTranslations({ ...scope, context: other }, ['pod'])).size).toBe(0)
  })

  it.each([
    ['Match "a  b"', 'Match "a b"'],
    ['Match "a\tb"', 'Match "a b"'],
    ['a\r\nb', 'a\nb'],
    ['e\u0301', '\u00e9'],
    ['  spaced ', 'spaced'],
  ])('原文逐字参与缓存键：%j 与 %j 不共享译文', async (first, second) => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [[first, '甲']])
    expect((await cache.readPersistentTranslations(scope, [second])).size).toBe(0)
    await cache.writePersistentTranslations(scope, [[second, '乙']])
    const found = await cache.readPersistentTranslations(scope, [first, second])
    expect(found.get(first)?.translation).toBe('甲')
    expect(found.get(second)?.translation).toBe('乙')
  })

  it('v1 归一化键写入的旧条目在新版本键下不再命中', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['seed', '种子']])
    const oldKey = await sha256Hex(
      JSON.stringify([1, scope.endpoint, scope.model, scope.prompt, scope.targetLanguage, null, 'Match "a b"']),
    )
    await withRawStore('readwrite', (store) =>
      store.put({ translation: '错误的双空格译文', createdAt: NOW, usedAt: NOW, bytes: 300 }, oldKey),
    )
    expect((await cache.readPersistentTranslations(scope, ['Match "a b"'])).size).toBe(0)
    await cache.writePersistentTranslations(scope, [['Match "a b"', '正确译文']])
    expect((await cache.readPersistentTranslations(scope, ['Match "a b"'])).get('Match "a b"')?.translation).toBe('正确译文')
  })

  it('磁盘上只有哈希键和译文，没有原文和语境', async () => {
    const cache = await restartWorker()
    const secret = 'SECRET-SOURCE-TEXT'
    await cache.writePersistentTranslations({ ...scope, context: { currentPage: page, recentPages: [] } }, [[secret, '译文']])
    const { keys, values } = await rawRecords()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/)
    const stored = JSON.stringify(values)
    expect(stored).toContain('译文')
    for (const leaked of [secret, page.title, page.site]) expect(stored).not.toContain(leaked)
  })

  it('超过 TTL 视为未命中，重新写入后恢复', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['Hello', '你好']])
    now = NOW + CACHE_TTL_MS + 1
    expect((await cache.readPersistentTranslations(scope, ['Hello'])).size).toBe(0)
    await cache.writePersistentTranslations(scope, [['Hello', '新译文']])
    expect((await cache.readPersistentTranslations(scope, ['Hello'])).get('Hello')?.translation).toBe('新译文')
  })

  it('命中不延长 TTL', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['Hello', '你好']])
    now = NOW + 20 * DAY_MS
    expect((await cache.readPersistentTranslations(scope, ['Hello'])).size).toBe(1)
    now = NOW + 31 * DAY_MS
    expect((await cache.readPersistentTranslations(scope, ['Hello'])).size).toBe(0)
  })

  it('损坏的记录视为未命中', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['Hello', '你好']])
    const { keys } = await rawRecords()
    await withRawStore('readwrite', (store) => {
      store.put({ translation: 7, createdAt: NOW, usedAt: NOW, bytes: 1 }, keys[0])
    })
    expect((await cache.readPersistentTranslations(scope, ['Hello'])).size).toBe(0)
  })
})

describe('淘汰', () => {
  // 每条计 1000 字节（372 字符 × 2 + 256 开销）：上限内正好放 5 条，超限后降到 90%，即留 4 条。
  const limits = { maxEntries: 1000, maxBytes: 5000 }
  const sized = (mark: string) => mark.repeat(372)

  async function fill(cache: Awaited<ReturnType<typeof restartWorker>>, names: readonly string[]): Promise<void> {
    for (const name of names) {
      now += 1000
      await cache.writePersistentTranslations(scope, [[name, sized(name)]], limits)
    }
  }

  it('总字节未超限时不淘汰，超限时删除最久未用的条目并降到目标水位', async () => {
    const cache = await restartWorker()
    await fill(cache, ['a', 'b', 'c', 'd', 'e'])
    expect((await rawRecords()).keys).toHaveLength(5)
    await fill(cache, ['f'])
    const found = await cache.readPersistentTranslations(scope, ['a', 'b', 'c', 'd', 'e', 'f'])
    expect([...found.keys()]).toEqual(['c', 'd', 'e', 'f'])
    expect((await rawRecords()).keys).toHaveLength(4)
  })

  it('命中刷新使用时间：常读的旧条目不被淘汰', async () => {
    const cache = await restartWorker()
    await fill(cache, ['a', 'b', 'c', 'd', 'e'])
    now += 2 * 60 * 60 * 1000
    expect((await cache.readPersistentTranslations(scope, ['a'])).size).toBe(1)
    await vi.waitFor(async () => {
      const { values } = await rawRecords()
      expect(values.some((value) => value.usedAt === now)).toBe(true)
    })
    await fill(cache, ['f'])
    const found = await cache.readPersistentTranslations(scope, ['a', 'b', 'c', 'd', 'e', 'f'])
    expect(found.has('a')).toBe(true)
    expect(found.has('b')).toBe(false)
  })

  it('后台重启后首次写入会重新统计，超过条数上限时淘汰', async () => {
    await (await restartWorker()).writePersistentTranslations(scope, [['seed', '种子']])
    await withRawStore('readwrite', (store) => {
      for (let index = 0; index < 10; index += 1) {
        store.put({ translation: 'x', createdAt: NOW, usedAt: NOW - 1000, bytes: 258 }, `old-${index}`)
      }
    })
    now += 1000
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['Hello', '你好']], { maxEntries: 10, maxBytes: 1_000_000 })
    expect(await withRawStore('readonly', (store) => store.count())).toBe(9)
    expect((await cache.readPersistentTranslations(scope, ['Hello', 'seed'])).size).toBe(2)
  })

  it('写入累计超限时无需重启也会再次淘汰', async () => {
    const cache = await restartWorker()
    const small = { maxEntries: 3, maxBytes: 1_000_000 }
    for (const name of ['a', 'b', 'c', 'd']) {
      now += 1000
      await cache.writePersistentTranslations(scope, [[name, name]], small)
    }
    const found = await cache.readPersistentTranslations(scope, ['a', 'b', 'c', 'd'])
    expect([...found.keys()]).toEqual(['c', 'd'])
  })

  it('空闲超过 TTL 的条目在下次扫描时清除，未超限时不动其他条目', async () => {
    const before = await restartWorker()
    await before.writePersistentTranslations(scope, [['old', '旧']])
    now = NOW + 10 * DAY_MS
    await before.writePersistentTranslations(scope, [['recent', '新']])
    now = NOW + CACHE_TTL_MS + 1
    await (await restartWorker()).writePersistentTranslations(scope, [['next', '下一条']])
    expect((await rawRecords()).keys).toHaveLength(2)
  })
})

describe('不可用时回退到仅内存', () => {
  it('没有 IndexedDB 时读写都静默跳过', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const cache = await restartWorker()
    await expect(cache.writePersistentTranslations(scope, [['a', '甲']])).resolves.toBeUndefined()
    expect((await cache.readPersistentTranslations(scope, ['a'])).size).toBe(0)
  })

  it('打开失败（如 Firefox 隐私模式）不抛错，冷却期内不再重试，之后恢复', async () => {
    const open = vi.fn(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const real = indexedDB
    vi.stubGlobal('indexedDB', { open })
    const cache = await restartWorker()
    expect((await cache.readPersistentTranslations(scope, ['a'])).size).toBe(0)
    await cache.writePersistentTranslations(scope, [['a', '甲']])
    expect(open).toHaveBeenCalledTimes(1)
    vi.stubGlobal('indexedDB', real)
    now += 61_000
    await cache.writePersistentTranslations(scope, [['a', '甲']])
    expect((await cache.readPersistentTranslations(scope, ['a'])).get('a')?.translation).toBe('甲')
  })

  it('打开挂起时读取超时并视为未命中', async () => {
    vi.stubGlobal('indexedDB', { open: () => ({}) })
    const cache = await restartWorker()
    const started = performance.now()
    expect((await cache.readPersistentTranslations(scope, ['a'])).size).toBe(0)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it('写入事务失败不抛错', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['a', '甲']])
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    await expect(cache.writePersistentTranslations(scope, [['b', '乙']])).resolves.toBeUndefined()
    vi.mocked(IDBDatabase.prototype.transaction).mockRestore()
  })

  it('摘要不可用时不抛错', async () => {
    vi.stubGlobal('crypto', {})
    const cache = await restartWorker()
    expect((await cache.readPersistentTranslations(scope, ['a'])).size).toBe(0)
    await expect(cache.writePersistentTranslations(scope, [['a', '甲']])).resolves.toBeUndefined()
  })
})

describe('清除持久译文', () => {
  it('清空全部条目，之后读取未命中，新写入仍可用', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['a', '甲'], ['b', '乙']])
    await cache.writePersistentTranslations({ ...scope, model: 'n' }, [['c', '丙']])
    expect((await rawRecords()).keys).toHaveLength(3)
    await expect(cache.clearPersistentTranslations()).resolves.toBe(true)
    expect((await rawRecords()).keys).toHaveLength(0)
    expect((await cache.readPersistentTranslations(scope, ['a', 'b'])).size).toBe(0)
    await cache.writePersistentTranslations(scope, [['a', '新']])
    expect((await cache.readPersistentTranslations(scope, ['a'])).get('a')?.translation).toBe('新')
  })

  it('清除前发起的写入不会把译文写回', async () => {
    const cache = await restartWorker()
    const writing = cache.writePersistentTranslations(scope, [['a', '甲']])
    await expect(cache.clearPersistentTranslations()).resolves.toBe(true)
    await writing
    expect((await rawRecords()).keys).toHaveLength(0)
  })

  it('清除前读到的条目不会被使用时间更新写回', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['a', '甲']])
    now += 2 * 60 * 60 * 1000
    // 第二次打开来自命中后的使用时间更新：让清除先完成，再放行这次打开。
    const realOpen = indexedDB.open.bind(indexedDB)
    let opens = 0
    let cleared: Promise<boolean> | undefined
    let finishTouch!: () => void
    let failTouch!: (error: Error) => void
    const touchDone = new Promise<void>((resolve, reject) => { finishTouch = resolve; failTouch = reject })
    let touchTransaction: MockInstance<IDBDatabase['transaction']> | undefined
    const open = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      opens += 1
      if (opens !== 2) return realOpen(...args)
      const held = {} as IDBOpenDBRequest & { result: IDBDatabase }
      cleared = cache.clearPersistentTranslations()
      void cleared.then(() => {
        const request = realOpen(...args)
        request.onsuccess = (event) => {
          const db = request.result
          const realTransaction = db.transaction.bind(db)
          touchTransaction = vi.spyOn(db, 'transaction').mockImplementation((...txArgs) => {
            const tx = realTransaction(...txArgs)
            tx.addEventListener('complete', finishTouch, { once: true })
            tx.addEventListener('abort', () => failTouch(new Error('touch transaction aborted')), { once: true })
            return tx
          })
          Object.assign(held, { result: request.result })
          held.onsuccess?.call(request, event)
        }
      })
      return held
    })
    try {
      expect((await cache.readPersistentTranslations(scope, ['a'])).size).toBe(1)
      await vi.waitFor(() => expect(opens).toBe(3))
      await cleared
      await touchDone
    } finally {
      touchTransaction?.mockRestore()
      open.mockRestore()
    }
    expect((await rawRecords()).keys).toHaveLength(0)
  })

  it('打开失败时返回 false 且不抛错，冷却期内重试仍会真正清除', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['a', '甲']])
    const real = indexedDB
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    await expect(cache.clearPersistentTranslations()).resolves.toBe(false)
    vi.stubGlobal('indexedDB', real)
    expect((await rawRecords()).keys).toHaveLength(1)
    await expect(cache.clearPersistentTranslations()).resolves.toBe(true)
    expect((await rawRecords()).keys).toHaveLength(0)
  })

  it('事务失败或没有 IndexedDB 时返回 false 且不抛错', async () => {
    const cache = await restartWorker()
    await cache.writePersistentTranslations(scope, [['a', '甲']])
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    await expect(cache.clearPersistentTranslations()).resolves.toBe(false)
    vi.mocked(IDBDatabase.prototype.transaction).mockRestore()
    vi.stubGlobal('indexedDB', undefined)
    await expect((await restartWorker()).clearPersistentTranslations()).resolves.toBe(false)
  })
})

describe('队列的两级缓存', () => {
  it('review5 同站同标题但主标题不同不能串用译文', async () => {
    const cache = await restartWorker()
    const currentPage = { site: 'a.example', title: 'Reader', heading: 'Kubernetes pods' }
    const first = { ...scope, context: { currentPage, recentPages: [] } }
    const second = { ...scope, context: { currentPage: { ...currentPage, heading: 'Whale pods' }, recentPages: [] } }
    await cache.writePersistentTranslations(first, [['pod', '容器组']])
    expect((await cache.readPersistentTranslations(second, ['pod'])).size).toBe(0)
    expect((await cache.readPersistentTranslations(first, ['pod'])).get('pod')?.translation).toBe('容器组')
  })

  it('同站点不同标题不命中，重新请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['指南']))
    try {
      await requestTranslation(snapshot, 'auto', ['Guide'], allow, english)
      await storedCount(1)
      clearTranslationCache()
      fetcher.mockClear()
      fetcher.mockImplementationOnce(async () => reply(['向导']))
      const otherTitle = { ...english, currentPage: { ...english.currentPage, title: 'Wizard' } }
      expect(await requestTranslation(snapshot, 'auto', ['Guide'], allow, otherTitle)).toEqual({ ok: true, texts: ['向导'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
      await storedCount(2)
    } finally {
      fetcher.mockRestore()
    }
  })

  it('带近期线索时不读不写持久层，内存层和提示内容不变', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['旧译文']))
    const readSpy = vi.spyOn(persistentCache, 'readPersistentTranslations')
    const smart = {
      currentPage: english.currentPage,
      recentPages: [{ site: 'b.example', title: 'Kubernetes', heading: 'Pods' }],
    }
    try {
      // 持久层已有同站点同标题的条目：带线索的请求也不能读到它。
      await requestTranslation(snapshot, 'auto', ['Reply'], allow, english)
      await storedCount(1)
      expect(readSpy).toHaveBeenCalledTimes(1)
      expect(writeSpy).toHaveBeenCalledTimes(1)
      clearTranslationCache()
      fetcher.mockClear()
      readSpy.mockClear()
      writeSpy?.mockClear()
      fetcher.mockImplementationOnce(async () => reply(['答复']))
      expect(await requestTranslation(snapshot, 'auto', ['Reply'], allow, smart)).toEqual({ ok: true, texts: ['答复'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(sentTexts(fetcher, 0)).toEqual({
        texts: ['Reply'],
        currentPage: smart.currentPage,
        recentPages: smart.recentPages,
      })
      expect(await requestTranslation(snapshot, 'auto', ['Reply'], allow, smart)).toEqual({
        ok: true,
        texts: ['答复'],
        cachedChars: 5,
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(readSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
      // 线索的译文也没有落进普通请求的桶。
      clearTranslationCache()
      expect(await requestTranslation(snapshot, 'auto', ['Reply'], allow, english)).toMatchObject({ texts: ['旧译文'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
      await storedCount(1)
    } finally {
      readSpy.mockRestore()
      fetcher.mockRestore()
    }
  })


  const snapshot: ModelSnapshot = {
    config: {
      ...DEFAULT_TRANSLATION_CONFIG,
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      autoOrigins: [],
      disabledDictionaries: ['devin', 'cursor'],
      targetLanguage: 'zh-CN',
      sourceLanguage: 'auto',
      selectionPopupEnabled: false,
      selectionToolbarEnabled: false,
      proactiveAssistEnabled: false,
      floatingButtonEnabled: false,
      excludedHosts: [],
      siteScopeMode: 'all',
      siteScopeHosts: [],
    },
    apiKey: 'sk-x',
    revision: 0,
  }
  const english = {
    currentPage: { site: 'a.example', title: 'Guide', heading: 'Getting started' },
    recentPages: [] as { site: string; title: string; heading: string }[],
  }

  const allow = async () => true

  function reply(texts: readonly string[]): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts) } }] }), { status: 200 })
  }

  // 这些用例只关心内存层丢失：清空内存缓存即等同重启。重新导入队列会连带重建依赖 fake browser 的配置模块。
  let clock = NOW
  const pendingWrites: Promise<void>[] = []
  let writeSpy: MockInstance<typeof persistentCache.writePersistentTranslations> | undefined

  beforeEach(() => {
    pendingWrites.length = 0
    const realWrite = persistentCache.writePersistentTranslations
    writeSpy = vi.spyOn(persistentCache, 'writePersistentTranslations').mockImplementation((...args) => {
      const work = realWrite(...args)
      pendingWrites.push(work)
      return work
    })
    clearTranslationCache()
    // 跨过上一条用例可能留下的失败冷却期。
    clock += 120_000
    now = clock
  })

  afterEach(async () => {
    try {
      await Promise.all(pendingWrites)
    } finally {
      writeSpy?.mockRestore()
      pendingWrites.length = 0
    }
  })

  function sentTexts(fetcher: { mock: { calls: unknown[][] } }, call: number): unknown {
    const init = fetcher.mock.calls[call]?.[1] as RequestInit
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] }
    return JSON.parse(body.messages[1]?.content ?? 'null')
  }

  async function storedCount(expected: number): Promise<void> {
    await Promise.all(pendingWrites)
    await vi.waitFor(async () => {
      expect((await rawRecords()).keys).toHaveLength(expected)
    })
  }

  it('写穿后重启：整批命中不发请求，报告缓存字符数', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(['甲', '乙']))
    const first = await requestTranslation(snapshot, 'auto', ['aa', 'bbb'], allow)
    expect(first).toEqual({ ok: true, texts: ['甲', '乙'] })
    await storedCount(2)
    clearTranslationCache()
    fetcher.mockClear()
    const second = await requestTranslation(snapshot, 'auto', ['aa', 'bbb'], allow)
    expect(second).toEqual({ ok: true, texts: ['甲', '乙'], cachedChars: 5 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('部分命中只请求未命中的文本，缓存字符数只算命中部分', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
    await requestTranslation(snapshot, 'auto', ['aa'], allow)
    await storedCount(1)
    clearTranslationCache()
    fetcher.mockClear()
    fetcher.mockImplementationOnce(async () => reply(['乙']))
    const out = await requestTranslation(snapshot, 'auto', ['aa', 'bbb'], allow)
    expect(out).toEqual({ ok: true, texts: ['甲', '乙'], cachedChars: 2 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sentTexts(fetcher, 0)).toEqual(['bbb'])
    await storedCount(2)
  })

  it('持久缓存按原文逐字命中：双空格源与单空格源互不影响', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
    try {
      const first = await requestTranslation(snapshot, 'auto', ['Match "a  b"'], allow)
      expect(first).toEqual({ ok: true, texts: ['甲'] })
      await storedCount(1)
      clearTranslationCache()
      fetcher.mockClear()
      fetcher.mockImplementationOnce(async () => reply(['乙']))
      const second = await requestTranslation(snapshot, 'auto', ['Match "a b"'], allow)
      expect(second).toEqual({ ok: true, texts: ['乙'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(sentTexts(fetcher, 0)).toEqual(['Match "a b"'])
      await storedCount(2)
      clearTranslationCache()
      fetcher.mockClear()
      const again = await requestTranslation(snapshot, 'auto', ['Match "a  b"', 'Match "a b"'], allow)
      expect(again).toEqual({ ok: true, texts: ['甲', '乙'], cachedChars: 23 })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })

  describe('语境与缓存层', () => {
    const english = { currentPage: { site: 'a.example', title: 'Guide', heading: 'Getting started' }, recentPages: [] }
    const otherPage = {
      currentPage: { site: 'a.example', title: '(3) Inbox', heading: 'Messages' },
      recentPages: [{ site: 'b.example', title: 'Kubernetes', heading: 'Pods' }],
    }

    it('其他站点不命中，重新请求', async () => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['回复']))
      try {
        await requestTranslation(snapshot, 'auto', ['Reply'], allow, english)
        await storedCount(1)
        clearTranslationCache()
        fetcher.mockClear()
        fetcher.mockImplementationOnce(async () => reply(['答复']))
        const otherSite = { ...english, currentPage: { ...english.currentPage, site: 'b.example' } }
        expect(await requestTranslation(snapshot, 'auto', ['Reply'], allow, otherSite)).toEqual({ ok: true, texts: ['答复'] })
        expect(fetcher).toHaveBeenCalledTimes(1)
        await storedCount(2)
      } finally {
        fetcher.mockRestore()
      }
    })

    it('内存层仍按完整语境区分，提示内容仍带完整语境', async () => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
      try {
        await requestTranslation(snapshot, 'selection', ['Reply'], allow, english, undefined, false)
        fetcher.mockImplementationOnce(async () => reply(['乙']))
        // 不读持久层时，语境不同只能靠内存键区分：相同语境命中，不同语境重新请求。
        expect(await requestTranslation(snapshot, 'selection', ['Reply'], allow, otherPage, undefined, false)).toEqual({
          ok: true,
          texts: ['乙'],
        })
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(await requestTranslation(snapshot, 'selection', ['Reply'], allow, english, undefined, false)).toMatchObject({
          texts: ['甲'],
          cachedChars: 5,
        })
        expect(fetcher).toHaveBeenCalledTimes(2)
        const init = fetcher.mock.calls[1]?.[1] as RequestInit
        const body = JSON.parse(init.body as string) as { messages: { content: string }[] }
        expect(JSON.parse(body.messages[1]?.content ?? 'null')).toEqual({
          texts: ['Reply'],
          currentPage: otherPage.currentPage,
          recentPages: otherPage.recentPages,
        })
      } finally {
        fetcher.mockRestore()
      }
    })
  })

  it('持久命中仍需授权', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
    await requestTranslation(snapshot, 'auto', ['aa'], allow)
    await storedCount(1)
    clearTranslationCache()
    fetcher.mockClear()
    const denied = await requestTranslation(snapshot, 'auto', ['aa'], async () => false)
    expect(denied).toMatchObject({ ok: false })
    expect(denied.texts).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('清空内存缓存不影响持久层；换模型后旧条目不可达，换回仍可用', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
    await requestTranslation(snapshot, 'auto', ['aa'], allow)
    await storedCount(1)
    clearTranslationCache()
    fetcher.mockClear()
    expect(await requestTranslation(snapshot, 'auto', ['aa'], allow)).toMatchObject({ texts: ['甲'], cachedChars: 2 })
    expect(fetcher).not.toHaveBeenCalled()
    clearTranslationCache()
    fetcher.mockImplementationOnce(async () => reply(['丙']))
    const changed = { ...snapshot, config: { ...snapshot.config, model: 'n' } }
    expect(await requestTranslation(changed, 'auto', ['aa'], allow)).toEqual({ ok: true, texts: ['丙'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await storedCount(2)
    clearTranslationCache()
    expect(await requestTranslation(snapshot, 'auto', ['aa'], allow)).toMatchObject({ texts: ['甲'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('不合格与失败的结果不写入', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲', '']))
    expect(await requestTranslation(snapshot, 'auto', ['aa', 'bb'], allow)).toMatchObject({ texts: ['甲', ''] })
    await storedCount(1)
    fetcher.mockImplementationOnce(async () => new Response('x', { status: 500 }))
    expect(await requestTranslation(snapshot, 'selection', ['cc'], allow)).toMatchObject({ ok: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await rawRecords()).keys).toHaveLength(1)
  })

  it('persist 为 false 时既不读也不写持久层', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
    await requestTranslation(snapshot, 'auto', ['aa'], allow)
    await storedCount(1)
    clearTranslationCache()
    fetcher.mockClear()
    fetcher.mockImplementationOnce(async () => reply(['敏感']))
    const out = await requestTranslation(snapshot, 'selection', ['aa'], allow, undefined, undefined, false)
    expect(out).toEqual({ ok: true, texts: ['敏感'] })
    fetcher.mockImplementationOnce(async () => reply(['敏感2']))
    await requestTranslation(snapshot, 'selection', ['secret'], allow, undefined, undefined, false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await rawRecords()).keys).toHaveLength(1)
  })

  it('持久层查询期间取消：不命中也不发请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
    await requestTranslation(snapshot, 'auto', ['aa'], allow)
    await storedCount(1)
    clearTranslationCache()
    fetcher.mockClear()
    const controller = new AbortController()
    const pending = requestTranslation(snapshot, 'auto', ['aa'], allow, undefined, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('IndexedDB 不可用时照常翻译，内存缓存继续工作', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['甲']))
    expect(await requestTranslation(snapshot, 'auto', ['aa'], allow)).toEqual({ ok: true, texts: ['甲'] })
    expect(await requestTranslation(snapshot, 'auto', ['aa'], allow)).toEqual({ ok: true, texts: ['甲'], cachedChars: 2 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('缓存TTL不能在提升到内存后丢失', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['旧译文']))
    try {
      const text = 'Synthetic near expiry sentence.'
      expect(await requestTranslation(snapshot, 'auto', [text], allow)).toMatchObject({ ok: true, texts: ['旧译文'] })
      await storedCount(1)
      clearTranslationCache()
      fetcher.mockClear()
      now += CACHE_TTL_MS - 1000
      expect(await requestTranslation(snapshot, 'auto', [text], allow)).toMatchObject({ ok: true, texts: ['旧译文'] })
      expect(fetcher).not.toHaveBeenCalled()
      now += 2000
      fetcher.mockImplementationOnce(async () => reply(['新译文']))
      const expired = await requestTranslation(snapshot, 'auto', [text], allow)
      expect(expired).toMatchObject({ ok: true, texts: ['新译文'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  })

  it('混合批次命中旧条目不延长它的有效期', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['旧甲']))
    try {
      await requestTranslation(snapshot, 'auto', ['aa'], allow)
      await storedCount(1)
      now += CACHE_TTL_MS - 1000
      fetcher.mockImplementationOnce(async () => reply(['乙']))
      expect(await requestTranslation(snapshot, 'auto', ['aa', 'bb'], allow)).toMatchObject({ texts: ['旧甲', '乙'], cachedChars: 2 })
      await storedCount(2)
      now += 2000
      fetcher.mockImplementationOnce(async () => reply(['新甲']))
      expect(await requestTranslation(snapshot, 'auto', ['aa'], allow)).toMatchObject({ texts: ['新甲'] })
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally {
      fetcher.mockRestore()
    }
  })

  it('授权等待期间过期的条目不命中', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['旧']))
    try {
      const text = 'Synthetic gate-expiry sentence.'
      expect(await requestTranslation(snapshot, 'auto', [text], allow)).toMatchObject({ ok: true, texts: ['旧'] })
      await storedCount(1)
      clearTranslationCache()
      fetcher.mockClear()
      now += CACHE_TTL_MS - 1000
      let waited = false
      const stillAllowed = async () => {
        if (!waited) {
          waited = true
          now += 2000
        }
        return true
      }
      fetcher.mockImplementationOnce(async () => reply(['新']))
      expect(await requestTranslation(snapshot, 'auto', [text], stillAllowed)).toMatchObject({ ok: true, texts: ['新'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  })

  it('排队期间到期的持久命中不能从暂存映射再次返回', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['旧甲']))
    let releaseHeld!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    let held: Promise<unknown> | undefined
    let pending: ReturnType<typeof requestTranslation> | undefined
    let scheduleSpy: MockInstance<typeof scheduler.scheduleModelTask> | undefined
    try {
      await requestTranslation(snapshot, 'auto', ['aa'], allow)
      await storedCount(1)
      clearTranslationCache()
      now += CACHE_TTL_MS - 1000
      fetcher.mockClear()
      fetcher.mockImplementationOnce(async () => reply(['新甲', '乙']))
      held = scheduler.scheduleModelTask('automatic', async () => {
        started()
        await gate
      })
      await entered
      scheduleSpy = vi.spyOn(scheduler, 'scheduleModelTask')
      pending = requestTranslation(snapshot, 'auto', ['aa', 'bb'], allow)
      await vi.waitFor(() => expect(scheduleSpy).toHaveBeenCalledTimes(1))
      expect(fetcher).not.toHaveBeenCalled()
      now += 2000
      releaseHeld()
      expect(await pending).toEqual({ ok: true, texts: ['新甲', '乙'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(sentTexts(fetcher, 0)).toEqual(['aa', 'bb'])
    } finally {
      releaseHeld()
      await Promise.allSettled([held, pending])
      scheduleSpy?.mockRestore()
      fetcher.mockRestore()
    }
  })

  it('补丁回归_不同语境不串用磁盘译文', async () => {
    const technical = { currentPage: { site: 'a.example', title: 'Kubernetes', heading: 'Pod networking' }, recentPages: [] }
    const wildlife = { currentPage: { site: 'a.example', title: 'Whales', heading: 'Whale social groups' }, recentPages: [] }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['容器组']))
    try {
      await requestTranslation(snapshot, 'auto', ['pod'], allow, technical)
      await storedCount(1)
      clearTranslationCache()
      fetcher.mockClear()
      fetcher.mockImplementationOnce(async () => reply(['鲸群']))
      expect(await requestTranslation(snapshot, 'auto', ['pod'], allow, wildlife)).toEqual({ ok: true, texts: ['鲸群'] })
      expect(fetcher).toHaveBeenCalledTimes(1)
      await storedCount(2)
    } finally { fetcher.mockRestore() }
  })

  it('requestOptionsKey 参与持久层分桶，清空内存后相同高级配置仍命中持久层而变更后未命中', async () => {
    const keyA = requestOptionsKey({
      apiType: 'chat-completions',
      temperature: 0,
      requestParams: { b: 1, a: 2 },
      customHeadersRevision: '11111111-1111-4111-8111-111111111111',
    })
    const keyASameOrder = requestOptionsKey({
      apiType: 'chat-completions',
      temperature: 0,
      requestParams: { a: 2, b: 1 },
      customHeadersRevision: '11111111-1111-4111-8111-111111111111',
    })
    const keyB = requestOptionsKey({
      apiType: 'chat-completions',
      temperature: 0.7,
      requestParams: { a: 2, b: 1 },
      customHeadersRevision: '11111111-1111-4111-8111-111111111111',
    })
    expect(keyA).toBe(keyASameOrder)
    await persistentCache.writePersistentTranslations({ ...scope, requestOptionsKey: keyA }, [['Hello', '你好']])
    await Promise.all(pendingWrites)
    expect((await persistentCache.readPersistentTranslations({ ...scope, requestOptionsKey: keyB }, ['Hello'])).size).toBe(0)
    expect(
      (await persistentCache.readPersistentTranslations({ ...scope, requestOptionsKey: keyASameOrder }, ['Hello'])).get(
        'Hello',
      )?.translation,
    ).toBe('你好')

    const advSnap: ModelSnapshot = {
      ...snapshot,
      config: {
        ...snapshot.config,
        temperature: 0.2,
        requestParams: { b: 'two', a: 'one' },
        customHeadersRevision: '11111111-1111-4111-8111-111111111111',
      },
      customHeaders: { 'x-secret': 'never-stored-in-cache' },
    }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => reply(['高级译文']))
    try {
      expect(await requestTranslation(advSnap, 'auto', ['Persist me'], allow)).toEqual({
        ok: true,
        texts: ['高级译文'],
      })
      await storedCount(2)
      clearTranslationCache()
      fetcher.mockClear()

      const reorderedAdvSnap: ModelSnapshot = {
        ...advSnap,
        config: {
          ...advSnap.config,
          requestParams: { a: 'one', b: 'two' },
        },
      }
      expect(await requestTranslation(reorderedAdvSnap, 'auto', ['Persist me'], allow)).toEqual({
        ok: true,
        texts: ['高级译文'],
        cachedChars: 10,
      })
      expect(fetcher).not.toHaveBeenCalled()

      clearTranslationCache()
      fetcher.mockImplementationOnce(async () => reply(['升温译文']))
      const changedAdvSnap: ModelSnapshot = {
        ...advSnap,
        config: { ...advSnap.config, temperature: 0.8 },
      }
      expect(await requestTranslation(changedAdvSnap, 'auto', ['Persist me'], allow)).toEqual({
        ok: true,
        texts: ['升温译文'],
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  })
})

describe('并发维护', () => {
  const small = { maxEntries: 5, maxBytes: 1_000_000 }

  function installImmediateDigest(): MockInstance<(typeof crypto.subtle)['digest']> {
    return vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
      const hash = createHash('sha256').update(view).digest()
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength)
    })
  }

  interface OpenGate {
    readonly requested: Promise<void>
    readonly entered: Promise<void>
    readonly done: Promise<void>
    release: () => void
  }

  function holdOpens(ordinals: readonly number[]) {
    const realOpen = indexedDB.open.bind(indexedDB)
    let opens = 0
    const txSpies: MockInstance[] = []
    const gates = new Map<
      number,
      OpenGate & {
        resolveRequested: () => void
        resolveEntered: () => void
        resolveDone: () => void
        released: boolean
        hit: boolean
        arm?: () => void
      }
    >()
    for (const ordinal of ordinals) {
      let resolveRequested!: () => void
      let resolveEntered!: () => void
      let resolveDone!: () => void
      const gate = {
        requested: new Promise<void>((resolve) => {
          resolveRequested = resolve
        }),
        entered: new Promise<void>((resolve) => {
          resolveEntered = resolve
        }),
        done: new Promise<void>((resolve) => {
          resolveDone = resolve
        }),
        resolveRequested,
        resolveEntered,
        resolveDone,
        released: false,
        hit: false,
        arm: undefined as (() => void) | undefined,
        release() {
          if (gate.released) return
          gate.released = true
          gate.arm?.()
        },
      }
      gates.set(ordinal, gate)
    }

    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      opens += 1
      const gate = gates.get(opens)
      if (gate === undefined || gate.released) return realOpen(...args)
      gate.hit = true
      gate.resolveRequested()
      const held = {} as IDBOpenDBRequest & { result: IDBDatabase }
      let started = false
      gate.arm = () => {
        if (started) return
        started = true
        const request = realOpen(...args)
        request.onerror = (event) => {
          gate.resolveDone()
          held.onerror?.call(request, event)
        }
        request.onblocked = (event) => {
          held.onblocked?.call(request, event)
        }
        request.onsuccess = (event) => {
          const db = request.result
          const realTransaction = db.transaction.bind(db)
          txSpies.push(
            vi.spyOn(db, 'transaction').mockImplementation((...txArgs) => {
              const tx = realTransaction(...txArgs)
              tx.addEventListener('complete', () => gate.resolveDone(), { once: true })
              tx.addEventListener('abort', () => gate.resolveDone(), { once: true })
              return tx
            }),
          )
          held.result = db
          held.onsuccess?.call(request, event)
        }
      }
      gate.resolveEntered()
      return held
    })

    return {
      gate(ordinal: number): OpenGate {
        const gate = gates.get(ordinal)
        if (gate === undefined) throw new Error(`missing open gate ${ordinal}`)
        return gate
      },
      releaseAll() {
        for (const gate of gates.values()) gate.release()
      },
      async finish() {
        await Promise.all([...gates.values()].filter((gate) => gate.hit).map((gate) => gate.done))
      },
      restore() {
        for (const spy of txSpies) spy.mockRestore()
        openSpy.mockRestore()
      },
    }
  }

  async function finishHold(
    session: ReturnType<typeof holdOpens> | undefined,
    started: readonly Promise<unknown>[],
    digest: MockInstance,
  ): Promise<void> {
    session?.releaseAll()
    try {
      await Promise.allSettled(started)
      await session?.finish()
    } finally {
      session?.restore()
      digest.mockRestore()
    }
  }

  async function seedLetters(cache: Awaited<ReturnType<typeof restartWorker>>, names: readonly string[]): Promise<void> {
    for (const name of names) {
      now += 1000
      await cache.writePersistentTranslations(scope, [[name, name]], small)
    }
  }

  it('A touch覆写新值', async () => {
    const cache = await restartWorker()
    const digest = installImmediateDigest()
    const started: Promise<unknown>[] = []
    let session: ReturnType<typeof holdOpens> | undefined
    try {
      await cache.writePersistentTranslations(scope, [['a', '旧']])
      now += 2 * 60 * 60 * 1000
      session = holdOpens([1, 3])
      const fresh = cache.writePersistentTranslations(scope, [['a', '新']])
      started.push(fresh)
      await session.gate(1).entered
      const reading = cache.readPersistentTranslations(scope, ['a'])
      started.push(reading)
      await reading
      session.gate(1).release()
      await fresh
      await session.gate(3).entered
      session.gate(3).release()
      await session.gate(3).done
      const found = await cache.readPersistentTranslations(scope, ['a'])
      expect(found.get('a')).toEqual({ translation: '新', expiresAt: now + CACHE_TTL_MS })
    } finally {
      await finishHold(session, started, digest)
    }
  })

  it('B missing 条目不被 touch 重建', async () => {
    const cache = await restartWorker()
    const digest = installImmediateDigest()
    const started: Promise<unknown>[] = []
    let session: ReturnType<typeof holdOpens> | undefined
    try {
      await cache.writePersistentTranslations(scope, [['a', '旧']])
      const key = (await rawRecords()).keys[0]
      if (key === undefined) throw new Error('missing seed key')
      now += 2 * 60 * 60 * 1000
      session = holdOpens([2])
      const reading = cache.readPersistentTranslations(scope, ['a'])
      started.push(reading)
      await reading
      await session.gate(2).entered
      await withRawStore('readwrite', (store) => {
        store.delete(key)
      })
      session.gate(2).release()
      await session.gate(2).done
      expect(await withRawStore('readonly', (store) => store.count())).toBe(0)
    } finally {
      await finishHold(session, started, digest)
    }
  })

  it('C 清扫候选被新译文覆盖', async () => {
    const cache = await restartWorker()
    const digest = installImmediateDigest()
    const started: Promise<unknown>[] = []
    let session: ReturnType<typeof holdOpens> | undefined
    try {
      await seedLetters(cache, ['a', 'b', 'c', 'd', 'e'])
      session = holdOpens([3])
      now += 1000
      const evicting = cache.writePersistentTranslations(scope, [['f', 'f']], small)
      started.push(evicting)
      await session.gate(3).entered
      now += 1000
      const fresh = cache.writePersistentTranslations(scope, [['a', '新']], small)
      started.push(fresh)
      await withRawStore('readonly', (store) => store.count())
      session.gate(3).release()
      await Promise.all([evicting, fresh])
      expect((await cache.readPersistentTranslations(scope, ['a'])).get('a')?.translation).toBe('新')
    } finally {
      await finishHold(session, started, digest)
    }
  })

  it('D 扫描后新增不漏进 estimate', async () => {
    const cache = await restartWorker()
    const digest = installImmediateDigest()
    const started: Promise<unknown>[] = []
    let session: ReturnType<typeof holdOpens> | undefined
    try {
      await seedLetters(cache, ['a', 'b', 'c', 'd', 'e'])
      session = holdOpens([3])
      now += 1000
      const evicting = cache.writePersistentTranslations(scope, [['f', 'f']], small)
      started.push(evicting)
      await session.gate(3).entered
      now += 1000
      const extraG = cache.writePersistentTranslations(scope, [['g', 'g']], small)
      started.push(extraG)
      now += 1000
      const extraH = cache.writePersistentTranslations(scope, [['h', 'h']], small)
      started.push(extraH)
      await withRawStore('readonly', (store) => store.count())
      session.gate(3).release()
      await Promise.all([evicting, extraG, extraH])
      now += 1000
      await cache.writePersistentTranslations(scope, [['i', 'i']], small)
      expect(await withRawStore('readonly', (store) => store.count())).toBeLessThanOrEqual(small.maxEntries)
    } finally {
      await finishHold(session, started, digest)
    }
  })

  it('E 队列拒绝恢复边界', async () => {
    const cache = await restartWorker()
    const digest = installImmediateDigest()
    const realTransaction = IDBDatabase.prototype.transaction
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      storeNames,
      mode,
      options,
    ) {
      if (mode === 'readwrite') throw new DOMException('quota', 'QuotaExceededError')
      return realTransaction.call(this, storeNames, mode, options)
    })
    try {
      await expect(cache.writePersistentTranslations(scope, [['a', '甲']])).resolves.toBeUndefined()
      txSpy.mockRestore()
      now += 60_001
      await cache.writePersistentTranslations(scope, [['b', '乙']])
      expect((await cache.readPersistentTranslations(scope, ['b'])).get('b')?.translation).toBe('乙')
    } finally {
      txSpy.mockRestore()
      digest.mockRestore()
    }
  })

  it('清除越过挂起清扫，旧排队写入丢弃而新代际仍能写入', async () => {
    const cache = await restartWorker()
    const digest = installImmediateDigest()
    const started: Promise<unknown>[] = []
    let session: ReturnType<typeof holdOpens> | undefined
    try {
      await seedLetters(cache, ['a', 'b', 'c', 'd', 'e'])
      session = holdOpens([3])
      now += 1000
      const evicting = cache.writePersistentTranslations(scope, [['f', 'f']], small)
      started.push(evicting)
      await session.gate(3).entered
      const obsolete = cache.writePersistentTranslations(scope, [['g', '旧排队']], small)
      started.push(obsolete)
      await expect(cache.clearPersistentTranslations()).resolves.toBe(true)
      expect(await withRawStore('readonly', (store) => store.count())).toBe(0)
      const fresh = cache.writePersistentTranslations(scope, [['h', '清除后']], small)
      started.push(fresh)
      session.gate(3).release()
      await Promise.all([evicting, obsolete, fresh])
      const found = await cache.readPersistentTranslations(scope, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
      expect([...found.keys()]).toEqual(['h'])
      expect(found.get('h')?.translation).toBe('清除后')
      expect(await withRawStore('readonly', (store) => store.count())).toBe(1)
    } finally {
      await finishHold(session, started, digest)
    }
  })
})
