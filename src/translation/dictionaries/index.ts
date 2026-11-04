import metaJson from './metadata.json'

export const DICTIONARY_CATEGORIES = ['ai-code', 'ai-model', 'cloud', 'code', 'design', 'community'] as const
export type DictionaryCategory = typeof DICTIONARY_CATEGORIES[number]

export interface BuiltinDictionaryMeta {
  readonly id: string
  readonly label: string
  readonly hosts: readonly string[]
  readonly category: DictionaryCategory
}

export interface FixedDictionary {
  readonly id: string
  readonly label: string
  readonly hosts: readonly string[]
  readonly entries: Readonly<Record<string, string>>
}

export const BUILTIN_DICTIONARY_META: readonly BuiltinDictionaryMeta[] =
  metaJson as readonly BuiltinDictionaryMeta[]

export const MAX_FIXED_ENTRIES = 5000

export function matchesHost(hosts: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase()
  return hosts.some((h) => host === h || host.endsWith('.' + h))
}

export function hostMatchPattern(host: string): string {
  return `https://*.${host}/*`
}

export function dictionariesForHostname<T extends { readonly hosts: readonly string[] }>(
  all: readonly T[],
  hostname: string,
): T[] {
  return all.filter((dictionary) => matchesHost(dictionary.hosts, hostname))
}

export function builtinHostPatterns(): string[] {
  return [...new Set(BUILTIN_DICTIONARY_META.flatMap((d) => d.hosts.map(hostMatchPattern)))].sort()
}

export function fixedTranslationWith(
  entries: Readonly<Record<string, string>>,
  text: string,
): string | undefined {
  const key = text.trim()
  if (key === '') return undefined
  const translated = Object.hasOwn(entries, key) ? (entries as Record<string, string>)[key] : undefined
  if (translated === undefined) return undefined
  const start = text.indexOf(key)
  if (start < 0) return undefined
  return text.slice(0, start) + translated + text.slice(start + key.length)
}
