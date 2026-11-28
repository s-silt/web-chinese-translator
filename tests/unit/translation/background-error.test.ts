import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatSafeError, reportBackgroundError } from '../../../src/translation/background-error'
import { TranslationError } from '../../../src/translation/transport'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('background-error', () => {
  it('formats TranslationError with name and code without leaking message', () => {
    const error = new TranslationError('Bearer sk-secret-123 https://private.example/?token=abc', 'auth')
    expect(formatSafeError(error)).toBe('TranslationError(auth)')
  })

  it('formats standard Error with name only and omits sensitive message', () => {
    const error = new DOMException('QuotaExceeded for https://secret.example/path', 'QuotaExceededError')
    expect(formatSafeError(error)).toBe('QuotaExceededError')
  })

  it('rejects unsafe or arbitrary error names and falls back to UnknownError', () => {
    expect(formatSafeError({ name: 'Error: sk-secret-key', code: 'https://a.example' })).toBe('UnknownError')
    expect(formatSafeError({ name: 'WorkspaceName', code: 'sk-synthetic-example' })).toBe('UnknownError')
    expect(formatSafeError(new DOMException('ignored', 'sk-synthetic-example'))).toBe('DOMException')
    expect(formatSafeError('raw secret string')).toBe('UnknownError')
    expect(formatSafeError(null)).toBe('UnknownError')
  })

  it('logs only fixed categories even if an error name or code is overwritten', () => {
    const error = new TranslationError('ignored', 'auth')
    error.name = 'WorkspaceName'
    expect(formatSafeError(error)).toBe('TranslationError(auth)')
    Object.defineProperty(error, 'code', { value: 'sk-synthetic-example' })
    expect(formatSafeError(error)).toBe('TranslationError')
    const namedError = new Error('ignored')
    namedError.name = 'WorkspaceName'
    expect(formatSafeError(namedError)).toBe('Error')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reportBackgroundError('sk-synthetic-example', namedError)
    expect(spy).toHaveBeenCalledWith('[网页汉化助手] 后台任务失败 (task): Error')
  })

  it('logs sanitized context and error summary via console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reportBackgroundError('sync-site-scripts', new TypeError('secret payload'))
    expect(spy).toHaveBeenCalledWith('[网页汉化助手] 后台任务失败 (sync-site-scripts): TypeError')
  })
})
