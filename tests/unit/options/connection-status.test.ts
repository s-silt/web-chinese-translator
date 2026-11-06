import { describe, expect, it } from 'vitest'
import { connectionKindFromReply } from '../../../src/entrypoints/options/connection-status'

describe('connectionKindFromReply', () => {
  it('成功为 ok', () => {
    expect(connectionKindFromReply({ ok: true, texts: ['ok'] })).toBe('ok')
  })

  it.each([
    ['auth', 'auth'],
    ['timeout', 'timeout'],
    ['queue_timeout', 'timeout'],
    ['network', 'network'],
    ['disconnected', 'network'],
    ['not_found', 'not-found'],
    ['rate_limited', 'rate-limited'],
    ['server', 'error'],
    ['unknown', 'error'],
  ] as const)('code=%s → %s', (code, kind) => {
    expect(connectionKindFromReply({ ok: false, error: code, code })).toBe(kind)
  })
})
