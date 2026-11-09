import { completionUrl, isModelId, MAX_DISCOVERED_MODELS, modelsUrl, type CompletionConfig } from './config'
import { parseRetryAfter, requestTimeoutMs, type FailureCode } from './failure'
import { completionBody, normalizeCustomHeaders } from './request-options'

export class TranslationError extends Error {
  readonly code: FailureCode
  readonly retryAfterMs: number | undefined

  constructor(message: string, code: FailureCode = 'unknown', retryAfterMs?: number) {
    super(message)
    this.name = 'TranslationError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export class CompletionCancelledError extends Error {
  constructor(message = '已取消') {
    super(message)
    this.name = 'CompletionCancelledError'
  }
}

const MAX_RESPONSE_BYTES = 1048576
const FENCE_OPEN = /^```(?:json)?[^\S\n]*\n/

export function invalidCompletion(): TranslationError {
  return new TranslationError('翻译服务返回格式不正确', 'bad_output')
}

export function unwrapFence(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.endsWith('```') || !FENCE_OPEN.test(trimmed)) return trimmed
  return trimmed.slice(trimmed.indexOf('\n') + 1, trimmed.length - 3).trim()
}

function httpError(status: number, retryAfterMs: number | undefined): TranslationError {
  if (status === 401 || status === 403) return new TranslationError('凭证无效或没有访问权限', 'auth')
  if (status === 404) return new TranslationError('接口地址或模型不存在（HTTP 404）', 'not_found')
  if (status === 408) return new TranslationError('请求超时，请稍后重试', 'timeout', retryAfterMs)
  if (status === 429) return new TranslationError('请求过于频繁，请稍后重试', 'rate_limited', retryAfterMs)
  if (status >= 500 && status <= 599) {
    return new TranslationError('模型服务暂时不可用，请稍后重试', 'server', retryAfterMs)
  }
  return new TranslationError('翻译请求失败（HTTP ' + status + '）')
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false
  return error.name === 'AbortError'
}

async function cancelBody(response: Response): Promise<void> {
  const body = response.body
  if (body === null) return
  await body.cancel().then(
    () => undefined,
    () => undefined,
  )
}

async function readLimitedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await cancelBody(response)
    throw new TranslationError('响应过大', 'bad_output')
  }
  const body = response.body
  if (body === null || typeof body.getReader !== 'function') {
    const text = await response.text()
    if (text.length * 4 > MAX_RESPONSE_BYTES) throw new TranslationError('响应过大', 'bad_output')
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let text = ''
  try {
    let finished = false
    while (!finished) {
      const chunk = await reader.read()
      const bytes = chunk.value
      if (bytes !== undefined) {
        received += bytes.byteLength
        if (received > MAX_RESPONSE_BYTES) {
          await reader.cancel().then(
            () => undefined,
            () => undefined,
          )
          throw new TranslationError('响应过大', 'bad_output')
        }
        text += decoder.decode(bytes, { stream: true })
      }
      finished = chunk.done
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

export async function requestCompletion(
  config: CompletionConfig,
  systemPrompt: string,
  userContent: string,
  apiKey: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = requestTimeoutMs(userContent.length),
): Promise<string> {
  const url = completionUrl(config.baseUrl, config.apiType)
  if (url === '') throw new TranslationError('请先配置接口地址')
  if (signal?.aborted) throw new CompletionCancelledError()
  let headers: Record<string, string>
  let requestBody: string
  try {
    headers = {
      ...normalizeCustomHeaders(config.customHeaders ?? {}),
      'Content-Type': 'application/json',
    }
    if (apiKey !== '') headers.Authorization = 'Bearer ' + apiKey
    requestBody = JSON.stringify(completionBody(config, systemPrompt, userContent))
  } catch {
    throw new TranslationError('模型请求设置无效，请检查高级设置')
  }
  const controller = new AbortController()
  const onExternalAbort = (): void => {
    controller.abort()
  }
  signal?.addEventListener('abort', onExternalAbort)
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers,
      body: requestBody,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      await cancelBody(response)
      throw httpError(response.status, retryAfterMs)
    }
    const body = await readLimitedText(response)
    const parsed = parseJson(body)
    const content = config.apiType === 'responses' ? readResponseContent(parsed) : readMessageContent(parsed)
    if (signal?.aborted) throw new CompletionCancelledError()
    return content
  } catch (error) {
    if (error instanceof TranslationError || error instanceof CompletionCancelledError) throw error
    if (signal?.aborted) throw new CompletionCancelledError()
    if (isAbortError(error)) throw new TranslationError('请求超时，请稍后重试', 'timeout')
    throw new TranslationError('无法连接翻译服务', 'network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw invalidCompletion()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readMessageContent(payload: unknown): string {
  if (!isRecord(payload)) throw invalidCompletion()
  const choices = payload.choices
  if (!Array.isArray(choices)) throw invalidCompletion()
  const first: unknown = choices[0]
  if (!isRecord(first)) throw invalidCompletion()
  const message = first.message
  if (!isRecord(message)) throw invalidCompletion()
  const content = message.content
  if (typeof content !== 'string') throw invalidCompletion()
  return content
}

function readResponseContent(payload: unknown): string {
  if (
    !isRecord(payload) ||
    (payload.error !== undefined && payload.error !== null) ||
    (payload.status !== undefined && payload.status !== 'completed') ||
    (payload.incomplete_details !== undefined && payload.incomplete_details !== null) ||
    !Array.isArray(payload.output)
  ) throw invalidCompletion()
  const parts: string[] = []
  for (const item of payload.output) {
    if (!isRecord(item)) throw invalidCompletion()
    if (item.type === 'reasoning') continue
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      (item.status !== undefined && item.status !== 'completed') ||
      !Array.isArray(item.content)
    ) throw invalidCompletion()
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') throw invalidCompletion()
      parts.push(part.text)
    }
  }
  const content = parts.join('')
  if (content.trim() === '') throw invalidCompletion()
  return content
}

export async function requestModelList(
  config: Pick<CompletionConfig, 'baseUrl' | 'customHeaders'>,
  apiKey: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string[]> {
  const url = modelsUrl(config.baseUrl)
  if (url === '') throw new TranslationError('请先配置有效的接口地址')
  if (signal?.aborted) throw new CompletionCancelledError()
  let headers: Headers
  try {
    headers = new Headers(normalizeCustomHeaders(config.customHeaders ?? {}))
    headers.set('Accept', 'application/json')
    if (apiKey !== '') headers.set('Authorization', 'Bearer ' + apiKey)
  } catch {
    throw new TranslationError('自定义请求头无效，请检查高级设置')
  }
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(onAbort, timeoutMs)
  try {
    const response = await fetcher(url, {
      method: 'GET', headers, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
    })
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      await cancelBody(response)
      if (response.status === 404 || response.status === 405) {
        throw new TranslationError('接口不支持获取模型，请手动填写模型', 'not_found')
      }
      throw httpError(response.status, retryAfterMs)
    }
    const text = await readLimitedText(response)
    let payload: unknown
    try { payload = JSON.parse(text) } catch {
      throw new TranslationError('接口未返回有效的模型列表，请手动填写模型', 'bad_output')
    }
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new TranslationError('接口未返回有效的模型列表，请手动填写模型', 'bad_output')
    }
    const models = new Set<string>()
    for (const item of payload.data) {
      if (!isRecord(item) || typeof item.id !== 'string') continue
      const id = item.id.trim()
      if (isModelId(id)) models.add(id)
      if (models.size > MAX_DISCOVERED_MODELS) {
        throw new TranslationError('模型列表过大，请手动填写模型', 'bad_output')
      }
    }
    if (payload.data.length > 0 && models.size === 0) {
      throw new TranslationError('接口未返回有效的模型列表，请手动填写模型', 'bad_output')
    }
    if (signal?.aborted) throw new CompletionCancelledError()
    return [...models].sort()
  } catch (error) {
    if (signal?.aborted) throw new CompletionCancelledError()
    if (error instanceof TranslationError || error instanceof CompletionCancelledError) throw error
    if (isAbortError(error)) throw new TranslationError('请求超时，请稍后重试', 'timeout')
    throw new TranslationError('无法连接翻译服务', 'network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
