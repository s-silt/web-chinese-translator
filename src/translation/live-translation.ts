import type { TranslationReply } from './messages'

export interface LiveTranslationOptions {
  readonly translate: (texts: string[], requestId: string) => Promise<TranslationReply<'wt:translate'>>
  readonly cancel: (requestId: string) => void
  readonly t: (key: import('../i18n').MessageKey) => string
}

export interface LiveTranslationWatcher {
  dispose(): void
}
