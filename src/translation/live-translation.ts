import type { MessageKey, MessageParams } from '../i18n'
import type { TranslationReply } from './messages'

export interface LiveTranslationOptions {
  readonly translate: (texts: string[], requestId: string) => Promise<TranslationReply<'wt:translate'>>
  readonly cancel: (requestId: string) => void
  readonly t: (key: MessageKey, params?: MessageParams) => string
}

export interface LiveTranslationWatcher {
  dispose(): void
}
