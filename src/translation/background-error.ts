import { isFailureCode } from './failure'
import { TranslationError } from './transport'

/** 后台控制台仅记录已识别的类别与翻译错误码。 */
export function formatSafeError(error: unknown): string {
  if (error instanceof TranslationError) {
    const code = error.code
    return isFailureCode(code) ? `TranslationError(${code})` : 'TranslationError'
  }
  if (error instanceof DOMException) {
    const name = error.name
    return name === 'QuotaExceededError' || name === 'AbortError' ? name : 'DOMException'
  }
  if (error instanceof TypeError) return 'TypeError'
  if (error instanceof Error) return 'Error'
  return 'UnknownError'
}

export function reportBackgroundError(context: string, error?: unknown): void {
  const scope = context === 'background' || context === 'sync-site-scripts' ? context : 'task'
  const detail = error === undefined ? '' : `: ${formatSafeError(error)}`
  console.error(`[网页汉化助手] 后台任务失败 (${scope})${detail}`)
}
