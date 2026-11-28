import { TranslationError } from './transport'

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : undefined
}

/**
 * 提取可安全写入控制台的错误摘要：仅保留标准错误类型名与受控错误码，
 * 绝不输出 error.message、堆栈、URL 参数、请求头或用户正文，避免隐私泄露。
 */
export function formatSafeError(error: unknown): string {
  if (error instanceof TranslationError) {
    return `${error.name}(${error.code})`
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { name?: unknown; code?: unknown }
    const name = safeToken(record.name)
    const code = safeToken(record.code)
    if (name !== undefined && code !== undefined) return `${name}(${code})`
    if (name !== undefined) return name
    if (code !== undefined) return `Error(${code})`
  }
  return 'UnknownError'
}

export function reportBackgroundError(context: string, error?: unknown): void {
  const scope = safeToken(context) ?? 'task'
  const detail = error === undefined ? '' : `: ${formatSafeError(error)}`
  console.error(`[网页汉化助手] 后台任务失败 (${scope})${detail}`)
}
