import { browser } from 'wxt/browser'
import type { TargetLanguage } from '../target-language'
import { BUILTIN_DICTIONARY_META, MAX_FIXED_ENTRIES } from './index'

type Entries = Readonly<Record<string, string>>
export type DictionaryLoader = (id: string, language: TargetLanguage) => Promise<Entries>

const EMPTY: Entries = Object.freeze({})
const IDS = new Set(['common', ...BUILTIN_DICTIONARY_META.map((d) => d.id)])
const LANGS = new Set<TargetLanguage>(['zh-CN', 'zh-TW', 'ja', 'ko'])

/** 打包本地 JSON（扩展只读资源，不是网页请求，不新增 web_accessible_resources）。 */
async function readBundledTable(id: string, language: TargetLanguage): Promise<Entries> {
  const readOnce = async (): Promise<Entries> => {
    const path = `/dictionaries/${language}/${id}.json`
    const response = await fetch(browser.runtime.getURL(path as Parameters<typeof browser.runtime.getURL>[0]))
    if (!response.ok) throw new Error('Bundled dictionary unavailable')
    const data: unknown = await response.json()
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Invalid dictionary')
    const pairs = Object.entries(data)
    if (pairs.length > MAX_FIXED_ENTRIES || pairs.some(([key, value]) =>
      ['__proto__', 'prototype', 'constructor'].includes(key) || !key.trim() || key.length > 200 ||
      typeof value !== 'string' || !value.trim() || value.length > 400)) throw new Error('Invalid dictionary')
    return Object.freeze(Object.fromEntries(pairs))
  }
  try {
    return await readOnce()
  } catch {
    return await readOnce()
  }
}

/** LRU 缓存 loader：同 key 并发只读一次；失败可重试；超过 8 项淘汰最旧。 */
export function createBuiltinLoader(read: DictionaryLoader = readBundledTable): DictionaryLoader {
  const cache = new Map<string, Promise<Entries>>()
  return (id, language) => {
    if (!IDS.has(id) || !LANGS.has(language)) return Promise.resolve(EMPTY)
    const key = `${language}:${id}`
    const found = cache.get(key)
    if (found) {
      cache.delete(key)
      cache.set(key, found)
      return found
    }
    const pending = Promise.resolve().then(() => read(id, language)).catch(() => {
      if (cache.get(key) === pending) cache.delete(key)
      return EMPTY
    })
    cache.set(key, pending)
    while (cache.size > 8) cache.delete(cache.keys().next().value!)
    return pending
  }
}

export const builtinTranslations = createBuiltinLoader()

interface CustomEntries {
  readonly entries: Entries
}

/** 合并：common 底表 → 按顺序叠内置 → 叠自定义。重复 key 仍以后者为准；超过 MAX_FIXED_ENTRIES 时截断优先保留后方自定义。 */
export async function mergeFixedEntries(
  ids: readonly string[],
  custom: readonly CustomEntries[],
  language: TargetLanguage,
  load: DictionaryLoader = builtinTranslations,
): Promise<Entries> {
  const selected = [...new Set(ids)].filter((id) => id !== 'common' && IDS.has(id))
  if (selected.length === 0 && custom.length === 0) return EMPTY
  const tables = await Promise.all(['common', ...selected].map((id) => load(id, language)))
  const chosen = new Map<string, string>()
  const layers = [...tables, ...custom.map((dictionary) => dictionary.entries)]
  for (const table of layers.reverse()) {
    for (const [key, value] of Object.entries(table)) {
      if (!chosen.has(key)) chosen.set(key, value)
      if (chosen.size === MAX_FIXED_ENTRIES) return Object.fromEntries(chosen)
    }
  }
  return Object.fromEntries(chosen)
}
