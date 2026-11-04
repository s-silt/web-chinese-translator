import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_DICTIONARY_META,
  DICTIONARY_CATEGORIES,
  dictionariesForHostname,
  fixedTranslationWith,
  hostMatchPattern,
  builtinHostPatterns,
  matchesHost,
  MAX_FIXED_ENTRIES,
} from '../../../src/translation/dictionaries/index'
import { createBuiltinLoader, mergeFixedEntries, type DictionaryLoader } from '../../../src/translation/dictionaries/entries'
import type { TargetLanguage } from '../../../src/translation/target-language'

/** 测试用本地文件 loader：读 public/dictionaries/<lang>/<id>.json，不经网络。 */
const readLocalFixture: DictionaryLoader = async (id, language) => {
  const raw = readFileSync(`public/dictionaries/${language}/${id}.json`, 'utf8')
  return Object.freeze(JSON.parse(raw) as Record<string, string>)
}

const DEVIN = BUILTIN_DICTIONARY_META.find((d) => d.id === 'devin')!
const LANGS: TargetLanguage[] = ['zh-CN', 'zh-TW', 'ja', 'ko']

describe('BUILTIN_DICTIONARY_META', () => {
  it('id 唯一、hosts 规范化小写、patterns 覆盖两站', () => {
    const ids = BUILTIN_DICTIONARY_META.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const meta of BUILTIN_DICTIONARY_META) {
      for (const host of meta.hosts) {
        expect(host).toBe(host.toLowerCase())
        expect(host).toMatch(/^[a-z0-9.-]+$/)
      }
    }
    const patterns = builtinHostPatterns()
    expect(patterns).toContain('https://*.devin.ai/*')
    expect(patterns).toContain('https://*.cursor.com/*')
  })
})

describe('matchesHost', () => {
  it('精确匹配与子域匹配，边界不误伤', () => {
    expect(matchesHost(['devin.ai'], 'devin.ai')).toBe(true)
    expect(matchesHost(['devin.ai'], 'app.devin.ai')).toBe(true)
    expect(matchesHost(['devin.ai'], 'notdevin.ai')).toBe(false)
    expect(matchesHost(['devin.ai'], 'devin.ai.evil.example')).toBe(false)
    expect(matchesHost(['cursor.com'], 'cursor.com.cn')).toBe(false)
    expect(matchesHost(['devin.ai'], 'DEVIN.AI')).toBe(true)
  })
})

describe('dictionariesForHostname / hostMatchPattern', () => {
  it('按主机名选出词典、生成权限 pattern', () => {
    expect(dictionariesForHostname(BUILTIN_DICTIONARY_META, 'app.devin.ai')).toEqual([DEVIN])
    expect(dictionariesForHostname(BUILTIN_DICTIONARY_META, 'github.com')).toEqual([])
    expect(hostMatchPattern('devin.ai')).toBe('https://*.devin.ai/*')
  })

  it('退役域名不再默认匹配/授权；AI Studio 与六新域正确匹配；用户应用域无匹配', () => {
    const patterns = new Set(builtinHostPatterns())
    const retiredHosts = [
      'gitlab.com',
      'pypi.org',
      'dash.cloudflare.com',
      'notion.so',
      'notion.site',
      'atlassian.net',
      'slack.com',
      'chatgpt.com',
      'chat.openai.com',
      'perplexity.ai',
      'x.com',
      'twitter.com',
      'reddit.com',
      'linkedin.com',
      'threads.net',
      'threads.com',
      'discord.com',
      'gemini.google.com',
      'stackoverflow.com',
    ]
    for (const host of retiredHosts) {
      expect(dictionariesForHostname(BUILTIN_DICTIONARY_META, host), host).toEqual([])
      expect(patterns.has(hostMatchPattern(host)), host).toBe(false)
    }

    const activeHosts: ReadonlyArray<readonly [string, string]> = [
      ['aistudio.google.com', 'gemini'],
      ['openrouter.ai', 'openrouter'],
      ['bolt.new', 'bolt'],
      ['lovable.dev', 'lovable'],
      ['app.netlify.com', 'netlify'],
      ['railway.com', 'railway'],
      ['dashboard.render.com', 'render'],
    ]
    for (const [host, expectedId] of activeHosts) {
      expect(
        dictionariesForHostname(BUILTIN_DICTIONARY_META, host).map((d) => d.id),
        host,
      ).toEqual([expectedId])
      expect(patterns.has(hostMatchPattern(host)), host).toBe(true)
    }

    const userAppHosts = [
      'netlify.app',
      'demo.netlify.app',
      'onrender.com',
      'app.onrender.com',
      'railway.app',
      'up.railway.app',
      'bolt.host',
      'lovable.app',
    ]
    for (const host of userAppHosts) {
      expect(dictionariesForHostname(BUILTIN_DICTIONARY_META, host), host).toEqual([])
      expect(patterns.has(hostMatchPattern(host)), host).toBe(false)
    }
  })
})

describe('mergeFixedEntries', () => {
  it('common 兜底，后项覆盖前项：自定义 > 内置 > 底表', async () => {
    const custom = [{ entries: { Settings: '自定义设置', Sessions: '自定义会话' } }]
    const merged = await mergeFixedEntries(['devin'], custom, 'zh-CN', readLocalFixture)
    expect(merged['Settings']).toBe('自定义设置')
    expect(merged['Sessions']).toBe('自定义会话')
    const builtin = await mergeFixedEntries(['devin'], [], 'zh-CN', readLocalFixture)
    expect(builtin['Settings']).toBe('设置')
    expect(builtin['Sessions']).toBe('会话')
    expect(builtin['Models']).toBeUndefined()
    expect((await mergeFixedEntries(['cursor'], [], 'zh-CN', readLocalFixture))['Models']).toBe('模型')
  })

  it('en 目标不加载内置表、超限按插入顺序截断到 MAX_FIXED_ENTRIES', async () => {
    const spy = vi.fn(readLocalFixture)
    expect(Object.keys(await mergeFixedEntries(['devin', 'cursor'], [], 'en', createBuiltinLoader(spy)))).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
    const big = { id: 'custom:b', label: 'b', hosts: [], entries: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`K${i}`, `V${i}`])), enabled: true }
    expect(Object.keys(await mergeFixedEntries(['devin'], [big], 'zh-CN', readLocalFixture))).toHaveLength(MAX_FIXED_ENTRIES)
  })

  it('三本各 2000 条自定义词截断时保留最后一本，冲突键仍以自定义为准', async () => {
    const host = ['example.com']
    const words = (prefix: string, extra: Record<string, string> = {}) => {
      const entries: Record<string, string> = { ...extra }
      const need = 2000 - Object.keys(extra).length
      for (let index = 0; index < need; index += 1) entries[`${prefix}${index}`] = `值${prefix}${index}`
      return { hosts: host, entries }
    }
    const last = words('C', { Settings: '自定义设置' })
    expect(Object.keys(last.entries)).toHaveLength(2000)
    const merged = await mergeFixedEntries(['devin'], [words('A'), words('B'), last], 'zh-CN', readLocalFixture)
    expect(Object.keys(merged)).toHaveLength(MAX_FIXED_ENTRIES)
    for (const [key, value] of Object.entries(last.entries)) expect(merged[key]).toBe(value)
    expect(merged['Settings']).toBe('自定义设置')
  })

  it('无匹配词典不加载表；unknown id 被跳过，自定义词典仍加载 common', async () => {
    const spy = vi.fn(readLocalFixture)
    await mergeFixedEntries([], [], 'zh-CN', spy)
    expect(spy).not.toHaveBeenCalled()
    await mergeFixedEntries(['nonexistent'], [{ entries: { A: 'B' } }], 'zh-CN', spy)
    expect(spy).toHaveBeenCalledWith('common', 'zh-CN')
    expect(spy).not.toHaveBeenCalledWith('nonexistent', 'zh-CN')
  })

  it('退休 13 id 无自定义词典时 loader 完全不调用；自定义词典覆盖仍有效', async () => {
    const retiredIds = [
      'gitlab',
      'pypi',
      'cloudflare',
      'notion',
      'jira',
      'slack',
      'chatgpt',
      'perplexity',
      'x',
      'reddit',
      'linkedin',
      'threads',
      'discord',
    ]
    const spy = vi.fn(readLocalFixture)
    expect(await mergeFixedEntries(retiredIds, [], 'zh-CN', spy)).toEqual({})
    expect(spy).not.toHaveBeenCalled()

    const withCustom = await mergeFixedEntries(
      retiredIds,
      [{ entries: { Settings: '自定义设置', CustomKey: '自定义值' } }],
      'zh-CN',
      spy,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('common', 'zh-CN')
    expect(withCustom['Settings']).toBe('自定义设置')
    expect(withCustom['CustomKey']).toBe('自定义值')
  })
})

describe('built-in dictionary assets', () => {
  it('元数据与四语言资产目录集合一致；category 合法、id 唯一非空；逐站 4 语键集合与 zh-CN 一致、键非空、值有界限', () => {
    const ids = BUILTIN_DICTIONARY_META.map((d) => d.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    for (const meta of BUILTIN_DICTIONARY_META) {
      expect(meta.id.trim()).not.toBe('')
      expect(DICTIONARY_CATEGORIES).toContain(meta.category)
    }

    const expectedAssetIds = [...ids, 'common'].sort()
    for (const lang of LANGS) {
      const actualIds = readdirSync(`public/dictionaries/${lang}`)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -5))
        .sort()
      expect(actualIds, lang).toEqual(expectedAssetIds)
    }

    for (const meta of BUILTIN_DICTIONARY_META) {
      const zhCN = JSON.parse(readFileSync(`public/dictionaries/zh-CN/${meta.id}.json`, 'utf8')) as Record<string, string>
      const expectedKeys = Object.keys(zhCN).sort()
      expect(expectedKeys.length).toBeGreaterThan(0)
      for (const lang of LANGS) {
        const table = JSON.parse(readFileSync(`public/dictionaries/${lang}/${meta.id}.json`, 'utf8')) as Record<string, string>
        expect(Object.keys(table).sort(), `${meta.id}/${lang}`).toEqual(expectedKeys)
        for (const [key, value] of Object.entries(table)) {
          expect(key.trim()).not.toBe('')
          expect(key.length).toBeLessThanOrEqual(200)
          expect(typeof value).toBe('string')
          expect(value.trim()).not.toBe('')
          expect(value.length).toBeLessThanOrEqual(400)
        }
      }
    }
  })

  it('旧 Devin/Cursor 词条保留；site 覆盖 common、自定义覆盖 site', async () => {
    const devin = await readLocalFixture('devin', 'zh-CN')
    const cursor = await readLocalFixture('cursor', 'zh-CN')
    expect(devin['Settings']).toBe('设置')
    expect(cursor['Models']).toBe('模型')
    const merged = await mergeFixedEntries(['devin'], [{ entries: { Settings: '我的覆盖' } }], 'zh-CN', readLocalFixture)
    expect(merged['Settings']).toBe('我的覆盖')
  })

  it('Claude 元数据存在且限定官方域名，ChatGPT 已移除', () => {
    const chatgpt = BUILTIN_DICTIONARY_META.find((d) => d.id === 'chatgpt')
    const claude = BUILTIN_DICTIONARY_META.find((d) => d.id === 'claude')
    expect(chatgpt).toBeUndefined()
    expect(claude).toBeDefined()
    expect(claude!.hosts).toEqual(expect.arrayContaining(['claude.ai', 'console.anthropic.com']))
  })
})

describe('createBuiltinLoader', () => {
  it('同 key 并发只 read 一次；不同语言隔离；未知 id 不读取；超过 8 项淘汰', async () => {
    const read = vi.fn(readLocalFixture)
    const loader = createBuiltinLoader(read)
    const [a, b] = await Promise.all([loader('devin', 'zh-CN'), loader('devin', 'zh-CN')])
    expect(a).toBe(b)
    expect(read).toHaveBeenCalledTimes(1)
    const ja = await loader('devin', 'ja')
    expect(ja).not.toBe(a)
    expect(read).toHaveBeenCalledTimes(2)
    // 不存在的 id 直接 EMPTY（IDS 之外的 id 不触发 read）
    expect(await loader('ghost', 'zh-CN')).toEqual({})
    expect(read).toHaveBeenCalledTimes(2)
    // 超过 8 项淘汰最旧
    for (const id of ['cursor', 'claude', 'linear', 'figma', 'vercel', 'supabase', 'npm', 'dockerhub', 'openrouter', 'railway']) {
      await loader(id, 'zh-CN')
    }
    const reads = read.mock.calls.length
    await loader('devin', 'zh-CN')
    expect(read.mock.calls.length).toBe(reads + 1)
  })

  it('打包表读取首次失败立即重试，同一次调用可恢复；第三次不再读', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ Settings: '设定' }), { status: 200 }))
      const recovered = createBuiltinLoader()
      await expect(recovered('devin', 'ja')).resolves.toEqual({ Settings: '设定' })
      expect(fetchMock).toHaveBeenCalledTimes(2)

      fetchMock.mockReset()
      fetchMock
        .mockRejectedValueOnce(new Error('1'))
        .mockRejectedValueOnce(new Error('2'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ Nope: '不该读到' }), { status: 200 }))
      const exhausted = createBuiltinLoader()
      await expect(exhausted('cursor', 'ko')).resolves.toEqual({})
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('read reject 后返回空表，下一次相同 key 可重新读取', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic'))
      .mockResolvedValueOnce({ Settings: '設定' })
    const loader = createBuiltinLoader(read)
    expect(await loader('devin', 'ja')).toEqual({})
    expect(await loader('devin', 'ja')).toEqual({ Settings: '設定' })
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('fixedTranslationWith', () => {
  it('保留首尾空白、只替换 trim 后的键', async () => {
    const entries = await mergeFixedEntries(['devin'], [], 'zh-CN', readLocalFixture)
    expect(fixedTranslationWith(entries, 'Settings')).toBe('设置')
    expect(fixedTranslationWith(entries, '  Settings  ')).toBe('  设置  ')
    expect(fixedTranslationWith(entries, 'Settingsx')).toBeUndefined()
    expect(fixedTranslationWith(entries, '   ')).toBeUndefined()
  })
})
