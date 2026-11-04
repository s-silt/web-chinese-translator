export type ApiType = 'chat-completions' | 'responses'
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface RequestOptions {
  readonly apiType?: ApiType
  readonly temperature?: number | null
  readonly requestParams?: JsonObject
  readonly customHeadersRevision?: string
}

export const MAX_REQUEST_PARAMS_BYTES = 16 * 1024
export const MAX_CUSTOM_HEADERS_BYTES = 8 * 1024
const MAX_JSON_DEPTH = 8
const MAX_JSON_NODES = 1024
const MAX_HEADERS = 32
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const RESERVED_PARAMS = new Set([
  'model', 'messages', 'input', 'instructions', 'stream', 'temperature', 'store',
  'background', 'previous_response_id', 'conversation', 'tools', 'tool_choice',
  'parallel_tool_calls', 'headers', 'api_key', 'apiKey', 'authorization',
  'functions', 'function_call', 'prompt', 'web_search_options', 'modalities',
  'audio', 'n', 'stream_options',
])
const RESERVED_HEADERS = new Set([
  'content-type', 'authorization', 'accept-charset', 'accept-encoding',
  'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'permissions-policy', 'referer', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'via', 'user-agent', 'x-http-method', 'x-http-method-override', 'x-method-override',
])

export function isApiType(value: unknown): value is ApiType {
  return value === 'chat-completions' || value === 'responses'
}

export function isTemperature(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2)
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function normalizeRequestParams(value: unknown): JsonObject {
  const invalid = (): Error => new Error('附加请求参数须为有效 JSON 对象，不能覆盖扩展管理的字段，且不得超过 16 KiB')
  if (!plainObject(value)) throw invalid()
  const active = new Set<object>()
  let visited = 0
  const visit = (item: unknown, depth: number): JsonValue => {
    visited += 1
    if (visited > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw invalid()
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null || active.has(item)) throw invalid()
    active.add(item)
    try {
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
      if (!plainObject(item)) throw invalid()
      const pairs: [string, JsonValue][] = []
      for (const key of Object.keys(item).sort()) {
        if (UNSAFE_KEYS.has(key) || (depth === 0 && RESERVED_PARAMS.has(key))) throw invalid()
        pairs.push([key, visit(item[key], depth + 1)])
      }
      return Object.fromEntries(pairs)
    } finally {
      active.delete(item)
    }
  }
  const normalized = visit(value, 0) as JsonObject
  if (jsonBytes(normalized) > MAX_REQUEST_PARAMS_BYTES) throw invalid()
  return normalized
}

export function normalizeCustomHeaders(value: unknown): Readonly<Record<string, string>> {
  const invalid = (): Error => new Error('自定义请求头须为有效 JSON 对象，值须为字符串，不能包含受限请求头，且不得超过 8 KiB')
  if (!plainObject(value) || Object.keys(value).length > MAX_HEADERS) throw invalid()
  const entries = new Map<string, string>()
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase()
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName) ||
      UNSAFE_KEYS.has(name) ||
      RESERVED_HEADERS.has(name) ||
      name.startsWith('proxy-') ||
      name.startsWith('sec-') ||
      entries.has(name) ||
      typeof rawValue !== 'string' ||
      !/^[\t\x20-\x7e\x80-\xff]*$/.test(rawValue)
    ) throw invalid()
    entries.set(name, rawValue.replace(/^[\t ]+|[\t ]+$/g, ''))
  }
  const normalized = Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  if (jsonBytes(normalized) > MAX_CUSTOM_HEADERS_BYTES) throw invalid()
  return normalized
}

export function requestOptionsKey(config: RequestOptions): string {
  return JSON.stringify([
    config.apiType ?? 'chat-completions',
    config.temperature ?? null,
    normalizeRequestParams(config.requestParams ?? {}),
    config.customHeadersRevision ?? '',
  ])
}

/** 内存缓存只保留固定长度摘要，避免每条译文重复占用整份附加参数的空间。 */
export async function requestOptionsCacheKey(config: RequestOptions): Promise<string> {
  const material = requestOptionsKey(config)
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // 缓存优化不可阻止翻译；缺少 WebCrypto 时保留完整键，现有容量限制继续生效。
    return material
  }
}

export function completionBody(
  config: RequestOptions & { readonly model: string },
  systemPrompt: string,
  userContent: string,
): JsonObject {
  const temperature = config.temperature ?? null
  if (!isTemperature(temperature)) throw new Error('温度须为空或 0–2 之间的数值')
  if (config.apiType !== undefined && !isApiType(config.apiType)) throw new Error('接口类型无效')
  const params = normalizeRequestParams(config.requestParams ?? {})
  const sampling: JsonObject = temperature === null ? {} : { temperature }
  if (config.apiType === 'responses') {
    return {
      ...params,
      model: config.model,
      instructions: systemPrompt,
      input: [{ role: 'user', content: [{ type: 'input_text', text: userContent }] }],
      stream: false,
      store: false,
      ...sampling,
    }
  }
  return {
    ...params,
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    stream: false,
    ...sampling,
  }
}
