import { storage } from 'wxt/utils/storage'
import { normalizeExcludedHost } from './page-policy'
import type { FixedDictionary } from './dictionaries/index'

export interface CustomDictionary extends FixedDictionary {
  readonly enabled: boolean
}

export interface CustomDictionaryDraft {
  readonly label: string
  readonly hosts: readonly string[]
  readonly entries: Readonly<Record<string, string>>
  readonly enabled?: boolean
}

export const customDictionariesItem = storage.defineItem<readonly CustomDictionary[]>('local:customDictionaries', {
  fallback: [],
})

export const LIMITS = {
  dictionaries: 20,
  hosts: 10,
  entries: 2000,
  keyLength: 200,
  valueLength: 400,
} as const

const CUSTOM_ID = /^custom:[a-zA-Z0-9-]{4,40}$/

// 词典主机必须指向具体站点：单标签（如 com）会把整份词典铺到整个顶级域，
// 常见公共后缀（co.uk、github.io 等）同理；导入或手填时一律拒绝。
const DICTIONARY_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'me.uk', 'net.uk', 'nhs.uk', 'org.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'ac.nz', 'co.nz', 'net.nz', 'org.nz',
  'ac.za', 'co.za', 'gov.za', 'net.za', 'org.za',
  'ac.jp', 'co.jp', 'ed.jp', 'go.jp', 'gr.jp', 'ne.jp', 'or.jp',
  'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
  'com.hk', 'edu.hk', 'gov.hk', 'net.hk', 'org.hk',
  'com.tw', 'gov.tw', 'net.tw', 'org.tw',
  'co.kr', 'ne.kr', 'or.kr', 're.kr',
  'com.sg', 'edu.sg', 'gov.sg', 'net.sg', 'org.sg', 'per.sg',
  'com.my', 'edu.my', 'gov.my', 'net.my', 'org.my',
  'ac.id', 'co.id', 'go.id', 'or.id', 'sch.id', 'web.id',
  'com.br', 'edu.br', 'gov.br', 'net.br', 'org.br',
  'com.mx', 'edu.mx', 'gob.mx', 'net.mx', 'org.mx',
  'com.ar', 'gob.ar', 'net.ar', 'org.ar',
  'com.co', 'edu.co', 'gov.co', 'net.co', 'org.co',
  'com.tr', 'com.sa', 'com.ae',
  'ac.il', 'co.il', 'gov.il', 'org.il',
  'co.ke', 'ac.ke', 'go.ke', 'or.ke', 'ne.ke',
  'com.eg', 'com.ng',
  'github.io', 'gitlab.io', 'bitbucket.io', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'vercel.app', 'netlify.app', 'herokuapp.com',
  'onrender.com', 'fly.dev', 'surge.sh', 'glitch.me', 'repl.co', 'replit.app',
  'blogspot.com', 'wordpress.com', 'wixsite.com', 'weebly.com',
  'tripod.com', 'angelfire.com', 'readthedocs.io', 'pythonanywhere.com',
])

// ccTLD 下的二级后缀（co.uk、com.cn、or.jp 等）未必都在上表，按模式一并拒绝。
const CCTLD_SECOND_LEVEL = /^(?:ac|co|com|edu|gov|mil|net|or|ne|go|gob|org)\.[a-z]{2}$/

export function normalizeDictionaryHost(value: string): string {
  const host = normalizeExcludedHost(value)
  if (
    host === '' ||
    !host.includes('.') ||
    DICTIONARY_PUBLIC_SUFFIXES.has(host) ||
    CCTLD_SECOND_LEVEL.test(host)
  ) {
    return ''
  }
  return host
}

export function newCustomDictionaryId(): string {
  return `custom:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const host = normalizeDictionaryHost(item)
    if (host === '' || hosts.includes(host)) continue
    hosts.push(host)
    if (hosts.length >= LIMITS.hosts) break
  }
  return hosts
}

function sanitizeEntries(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const entries: Record<string, string> = {}
  for (const [key, translated] of Object.entries(value)) {
    if (Object.keys(entries).length >= LIMITS.entries) break
    if (typeof translated !== 'string') continue
    const source = key.trim()
    const target = translated.trim()
    if (source === '' || target === '') continue
    if (source.length > LIMITS.keyLength || target.length > LIMITS.valueLength) continue
    entries[source] = target
  }
  return entries
}

/** 丢弃非法项；主机名与词条超限按 LIMITS 截断；id 不合法则丢弃。 */
export function sanitizeCustomDictionaries(value: unknown): CustomDictionary[] {
  if (!Array.isArray(value)) return []
  const dictionaries: CustomDictionary[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, LIMITS.dictionaries)) {
    if (!isRecord(item)) continue
    const { id, label, hosts, entries, enabled } = item
    if (typeof id !== 'string' || !CUSTOM_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    dictionaries.push({
      id,
      label: typeof label === 'string' ? label.trim().slice(0, 80) : '',
      hosts: sanitizeHosts(hosts),
      entries: sanitizeEntries(entries),
      enabled: enabled === true,
    })
  }
  return dictionaries
}

const ENTRY_LINE = /^(.*?)(?:\s=\s|\t)(.*)$/

/** 解析 `原文 = 译文` 或 `原文<TAB>译文` 行；空行忽略，非法行进 invalid。 */
export function parseEntryLines(text: string): { entries: Record<string, string>; invalid: string[] } {
  const entries: Record<string, string> = {}
  const invalid: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const match = ENTRY_LINE.exec(line)
    const source = match?.[1]?.trim() ?? ''
    const target = match?.[2]?.trim() ?? ''
    if (
      match === null || source === '' || target === '' ||
      source.length > LIMITS.keyLength || target.length > LIMITS.valueLength
    ) {
      invalid.push(line)
      continue
    }
    entries[source] = target
  }
  return { entries, invalid }
}

export function serializeEntryLines(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries).map(([source, target]) => `${source} = ${target}`).join('\n')
}

/** 接受 {label, hosts, entries, enabled?}，也接受纯 {原文:译文}（label/hosts 留空由表单补）。 */
export function parseDictionaryJson(text: string): CustomDictionaryDraft | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (Array.isArray(parsed.hosts) || typeof parsed.label === 'string' || isRecord(parsed.entries)) {
    const entries = sanitizeEntries(isRecord(parsed.entries) ? parsed.entries : parsed)
    if (Object.keys(entries).length === 0) return undefined
    return {
      label: typeof parsed.label === 'string' ? parsed.label.trim().slice(0, 80) : '',
      hosts: sanitizeHosts(parsed.hosts),
      entries,
      enabled: parsed.enabled === true ? true : undefined,
    }
  }
  const entries = sanitizeEntries(parsed)
  if (Object.keys(entries).length === 0) return undefined
  return { label: '', hosts: [], entries }
}

export function serializeDictionary(dictionary: CustomDictionary): string {
  return JSON.stringify(
    {
      label: dictionary.label,
      hosts: dictionary.hosts,
      enabled: dictionary.enabled,
      entries: dictionary.entries,
    },
    null,
    2,
  )
}

export async function getCustomDictionaries(): Promise<CustomDictionary[]> {
  return sanitizeCustomDictionaries(await customDictionariesItem.getValue())
}

export async function setCustomDictionaries(value: readonly CustomDictionary[]): Promise<CustomDictionary[]> {
  const next = sanitizeCustomDictionaries([...value])
  await customDictionariesItem.setValue(next)
  return next
}

export function watchCustomDictionaries(
  callback: (dictionaries: CustomDictionary[]) => void,
): () => void {
  return customDictionariesItem.watch((value) => {
    callback(sanitizeCustomDictionaries(value))
  })
}
