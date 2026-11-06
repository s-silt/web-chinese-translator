import type { TranslationReply } from '../../translation/messages'

export type ConnectionKind =
  | 'unconfigured'
  | 'untested'
  | 'testing'
  | 'ok'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'not-found'
  | 'rate-limited'
  | 'error'

/** 把 wt:test 的 reply.code 映射成连接徽章状态 */
export function connectionKindFromReply(reply: TranslationReply<'wt:test'>): ConnectionKind {
  if (reply.ok) return 'ok'
  switch (reply.code) {
    case 'auth':
      return 'auth'
    case 'timeout':
    case 'queue_timeout':
      return 'timeout'
    case 'network':
    case 'disconnected':
      return 'network'
    case 'not_found':
      return 'not-found'
    case 'rate_limited':
      return 'rate-limited'
    default:
      return 'error'
  }
}
