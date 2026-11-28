import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import { exportConfigBackup, parseConfigBackup, planConfigBackupRestore } from '../../../src/translation/config-backup'
import { isTranslationMessage, isTranslationReply } from '../../../src/translation/messages'
import {
  CACHE_TTL_MS, clearPersistentTranslationsForHost, getPersistentCacheStats, readPersistentTranslations,
  writePersistentTranslations, type PersistentCacheScope,
} from '../../../src/translation/persistent-cache'
import { clearTranslationCache, clearTranslationCacheForHost, requestTranslation } from '../../../src/translation/queue'
import { requestOptionsCacheKey } from '../../../src/translation/request-options'
import { translationOptionsCacheKey } from '../../../src/translation/preferences-extra'
import { emptyUsageStats, getUsageStats, resetUsageStats } from '../../../src/translation/usage-stats'
import { resolveSceneSnapshot } from '../../../src/translation/model-state'
import { MAX_MODEL_PROFILES } from '../../../src/translation/preferences-extra'

const settings = { ...DEFAULT_TRANSLATION_CONFIG, baseUrl: 'https://model.example', model: 'fixture' }
const context = (site: string) => ({ currentPage: { title: '', heading: '', site }, recentPages: [] })
const scope = (host: string): PersistentCacheScope => ({
  endpoint: settings.baseUrl, model: settings.model, prompt: '', targetLanguage: 'zh-CN', host, context: context(host),
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearTranslationCache()
})

describe('按站点缓存', () => {
  it('长术语表和风格进入同一份定长摘要', async () => {
    const glossary = Array.from({ length: 200 }, (_, i) => ({ source: '术'.repeat(105) + i, target: '词'.repeat(100) }))
    const key = await translationOptionsCacheKey({ ...settings, translationStyle: 'technical', promptGlossary: glossary })
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(await translationOptionsCacheKey({ ...settings, promptGlossary: glossary })).not.toBe(key)
    expect(await translationOptionsCacheKey({ ...settings, translationStyle: 'technical', promptGlossary: glossary.slice(1) })).not.toBe(key)
    expect(await translationOptionsCacheKey(settings)).toBe(await requestOptionsCacheKey(settings))
    expect(await requestOptionsCacheKey(settings)).not.toBe(key)
  })

  it('已发布的 v2 连接阻塞后，迟到的 v3 连接关闭并允许下一次真实升级，旧条目仍可统计', async () => {
    const factory = new IDBFactory()
    vi.stubGlobal('indexedDB', factory)
    const openVersion = (version: number) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('web-translator-cache', version)
      request.onupgradeneeded = event => {
        if (event.oldVersion !== 0) return
        const store = request.result.createObjectStore('translations')
        store.createIndex('lru', ['usedAt', 'bytes'])
        store.createIndex('createdAt', 'createdAt')
        store.put({ translation: '旧', createdAt: Date.now(), usedAt: Date.now(), bytes: 258 }, 'legacy')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('数据库升级仍被阻塞'))
    })
    const old = await openVersion(2)
    try {
      await expect(getPersistentCacheStats()).rejects.toThrow()
    } finally {
      old.close()
    }
    expect(await getPersistentCacheStats()).toEqual({ entries: 1, approxBytes: 258, expired: 0, hosts: [] })
    const next = await openVersion(4)
    try {
      expect(next.transaction('translations').objectStore('translations').indexNames.contains('by_host')).toBe(true)
    } finally {
      next.close()
    }
  })

  it('同文两站分桶；先写再清按调用顺序，保留其他站点、旧版无 host 条目及清理后的新写入', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const a = scope('a.example')
    const b = scope('b.example')
    const legacy = { endpoint: settings.baseUrl, model: 'legacy', prompt: '', targetLanguage: 'zh-CN' }
    await writePersistentTranslations(legacy, [['Text', '旧']])
    const before = writePersistentTranslations(a, [['Text', '甲']])
    const independent = writePersistentTranslations(b, [['Text', '乙']])
    const clearing = clearPersistentTranslationsForHost('A.EXAMPLE')
    const after = writePersistentTranslations(a, [['New', '新']])
    await Promise.all([before, independent, after])
    expect(await clearing).toBe(1)
    expect((await readPersistentTranslations(a, ['Text', 'New'])).get('Text')).toBeUndefined()
    expect((await readPersistentTranslations(a, ['New'])).get('New')?.translation).toBe('新')
    expect((await readPersistentTranslations(b, ['Text'])).get('Text')?.translation).toBe('乙')
    expect((await readPersistentTranslations(legacy, ['Text'])).get('Text')?.translation).toBe('旧')
    const stats = await getPersistentCacheStats(now + CACHE_TTL_MS)
    expect(stats).toMatchObject({ entries: 3, expired: 3, approxBytes: 3 * 258 })
    expect(stats.hosts).toEqual([{ host: 'a.example', entries: 1 }, { host: 'b.example', entries: 1 }])
    expect(await clearPersistentTranslationsForHost('missing.example')).toBe(0)
    vi.stubGlobal('indexedDB', undefined)
    expect(await clearPersistentTranslationsForHost('b.example')).toBeUndefined()
  })

  it('部分命中、全命中和按站点清除后的内存命中都正确计数', async () => {
    await resetUsageStats()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '["结果"]' } }] })),
    )
    const translate = (host: string, texts: string[]) =>
      requestTranslation({ config: settings, revision: 1, apiKey: '' }, 'auto', texts, async () => true, context(host), undefined, false)
    expect((await translate('a.example', ['one'])).ok).toBe(true)
    expect((await translate('b.example', ['one'])).ok).toBe(true)
    expect(await translate('a.example', ['one', 'two'])).toMatchObject({ ok: true, cachedChars: 3 })
    clearTranslationCacheForHost('a.example')
    expect(await translate('b.example', ['one'])).toMatchObject({ ok: true, cachedChars: 3 })
    expect(await translate('a.example', ['one'])).toEqual({ ok: true, texts: ['结果'] })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect((await getUsageStats()).total.cacheHits).toBe(2)
  })

  it('拒绝路径替代主机及会破坏设置界面的统计回复', () => {
    expect(isTranslationMessage({ type: 'wt:clear-site-cache', host: 'a.example/path' })).toBe(false)
    const cacheStats = { entries: 0, approxBytes: 0, expired: 0, hosts: [] }
    const usageStats = emptyUsageStats()
    expect(isTranslationReply({ ok: true, cacheStats }, { type: 'wt:get-cache-stats' })).toBe(true)
    expect(isTranslationReply({ ok: true, cacheStats: { ...cacheStats, hosts: [{}] } }, { type: 'wt:get-cache-stats' })).toBe(false)
    expect(isTranslationReply({ ok: true, usageStats: { ...usageStats, total: {} } }, { type: 'wt:get-usage-stats' })).toBe(false)
  })
})

describe('可移植配置', () => {
  const profile = (id: string, site: string) => ({
    id, name: site, baseUrl: `https://${site}.fixture.test/v1`, model: site, apiType: 'responses' as const, temperature: null,
  })
  const local = profile('shared', 'local')
  const remote = profile('shared', 'remote')
  const denied = profile('denied', 'denied')
  const filler = Array.from({ length: MAX_MODEL_PROFILES - 2 }, (_, i) => profile(`imported-${i + 1}`, `extra-${i}`))

  it.each([true, false])('部分恢复保留未授权场景的本机端点（拒绝专用模型=%s），同 ID 和满档案表也不串用', denySelection => {
    const current = {
      ...settings, baseUrl: local.baseUrl, model: local.model, apiType: local.apiType, modelProfiles: [local],
      activeProfileId: local.id, selectionProfileId: local.id,
    }
    const primary = denySelection ? remote : denied
    const dedicated = denySelection ? denied : remote
    const imported = {
      ...settings, baseUrl: primary.baseUrl, model: primary.model, apiType: primary.apiType, activeProfileId: primary.id,
      selectionProfileId: dedicated.id, modelProfiles: [...filler, denied, remote],
    }
    const { patch, omittedProfiles } = planConfigBackupRestore(imported, current, ['https://denied.fixture.test/*'])
    const restored = { ...current, ...patch }
    expect(restored.modelProfiles).toHaveLength(MAX_MODEL_PROFILES)
    expect(new Set(restored.modelProfiles.map(p => p.id)).size).toBe(MAX_MODEL_PROFILES)
    expect(restored.modelProfiles.find(p => p.id === local.id)).toEqual(local)
    expect(omittedProfiles).toEqual(imported.modelProfiles.filter(p => !restored.modelProfiles.some(saved =>
      saved.name === p.name && saved.baseUrl === p.baseUrl && saved.model === p.model)).map(p => p.name))
    expect(omittedProfiles).toHaveLength(1)
    const completed = planConfigBackupRestore(imported, current)
    expect(completed.omittedProfiles).toEqual([])
    expect(completed.patch.modelProfiles).toEqual(imported.modelProfiles)
    expect(denySelection ? restored.selectionProfileId : restored.activeProfileId).toBe(local.id)
    const snapshot = { config: restored, revision: 0, apiKey: '' }
    const main = resolveSceneSnapshot(snapshot, 'page').config
    expect(main.baseUrl).toBe(denySelection ? remote.baseUrl : local.baseUrl)
    expect(restored.modelProfiles.find(p => p.id === restored.activeProfileId)?.baseUrl).toBe(main.baseUrl)
    for (const scene of ['selection', 'text'] as const) {
      const effective = resolveSceneSnapshot(snapshot, scene).config
      expect([effective.baseUrl, effective.model]).toEqual(denySelection ? [local.baseUrl, local.model] : [remote.baseUrl, remote.model])
    }
  })

  it('备份明确选择跟随主模型时才清空先前的专用选择', () => {
    const current = { ...settings, modelProfiles: [local], selectionProfileId: local.id }
    const { patch } = planConfigBackupRestore({ ...settings, baseUrl: denied.baseUrl, selectionProfileId: '' }, current, ['https://denied.fixture.test/*'])
    expect(patch.selectionProfileId).toBe('')
    const effective = resolveSceneSnapshot({ config: { ...current, ...patch }, revision: 0, apiKey: '' }, 'text').config
    expect(effective.baseUrl).toBe(current.baseUrl)
  })

  it('导出后可保存，保留本机授权和快捷键，不传递任意请求参数里的凭据', () => {
    const config = {
      ...settings, displayMode: 'bilingual' as const, requestParams: { metadata: { opaque: 'fixture-private' } },
      siteScopeHosts: ['local.example'], autoOrigins: ['https://local.example'],
    }
    const exported = exportConfigBackup(config)
    expect(exported).not.toContain('fixture-private')
    expect(exported).not.toContain('local.example')
    const imported = parseConfigBackup(exported)
    if (!imported.ok) throw new Error(imported.error)
    const { patch } = planConfigBackupRestore(imported.config, config)
    expect(isTranslationMessage({ type: 'wt:save-config', patch })).toBe(true)
    expect(patch.displayMode).toBe('bilingual')
    expect(patch).not.toHaveProperty('inputReplaceKey')
    expect(patch).not.toHaveProperty('siteScopeMode')
    expect(patch).not.toHaveProperty('requestParams')
    expect(planConfigBackupRestore(imported.config, { ...config, baseUrl: 'https://other.example' }).patch.requestParams).toEqual({})
  })

  it.each([[], {}, { unknown: true }])('不完整的导入数据无法覆盖现有设置', config => {
    expect(parseConfigBackup(JSON.stringify({ version: 1, config })).ok).toBe(false)
  })
})
