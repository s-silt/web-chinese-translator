import { browser, type Browser } from 'wxt/browser'
import type { TranslationConfig } from './config'
import { TEXT_STREAM_PORT, type TranslationFailure } from './messages'
import { modelRequestConfig, resolveSceneSnapshot, type ModelSnapshot } from './model-state'
import { findMatchedGlossaryEntries } from './preferences-extra'
import { translationPrompt } from './provider'
import { CompletionCancelledError, requestCompletionStream } from './transport'

export interface TextStreamDeps {
  readonly fromTextWindow: (sender: Browser.runtime.MessageSender) => boolean
  readonly modelSnapshot: () => Promise<ModelSnapshot>
  readonly assertDispatchAllowed: (snapshot: ModelSnapshot, signal: AbortSignal) => Promise<void>
  readonly failureReply: (error: unknown) => TranslationFailure
}

/** 挂载独立文本翻译窗口的 SSE 流式端口，支持随时打断与自动释放。 */
export function installTextStreamPort(deps: TextStreamDeps): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== TEXT_STREAM_PORT) return
    if (port.sender === undefined || !deps.fromTextWindow(port.sender)) {
      port.disconnect()
      return
    }
    let activeAbort: AbortController | undefined
    port.onDisconnect.addListener(() => {
      activeAbort?.abort()
      activeAbort = undefined
    })
    port.onMessage.addListener((raw: unknown) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
      const msg = raw as Record<string, unknown>
      if (msg.type === 'cancel') {
        activeAbort?.abort()
        activeAbort = undefined
        return
      }
      if (msg.type !== 'translate' || typeof msg.text !== 'string' || typeof msg.requestId !== 'string') return
      activeAbort?.abort()
      const abort = new AbortController()
      activeAbort = abort
      const requestId = msg.requestId
      const text = msg.text
      const sourceLanguage = typeof msg.sourceLanguage === 'string' ? msg.sourceLanguage : 'auto'
      const targetLanguage = typeof msg.targetLanguage === 'string' ? msg.targetLanguage : 'zh-CN'
      void (async () => {
        try {
          const rawSnapshot = await deps.modelSnapshot().catch(() => undefined)
          if (rawSnapshot === undefined) {
            port.postMessage({ type: 'error', requestId, error: '请先在设置页配置模型接口' })
            return
          }
          const snapshot = await resolveSceneSnapshot(rawSnapshot, 'text')
          await deps.assertDispatchAllowed(snapshot, abort.signal)
          const model = {
            ...modelRequestConfig(snapshot),
            sourceLanguage: sourceLanguage as TranslationConfig['sourceLanguage'],
            targetLanguage: targetLanguage as TranslationConfig['targetLanguage'],
          }
          const matchedGlossary = findMatchedGlossaryEntries(model.promptGlossary, [text])
          const prompt = translationPrompt(
            undefined,
            model.targetLanguage,
            model.sourceLanguage,
            model.translationStyle,
            matchedGlossary,
          ).replace(
            'Return ONLY a JSON array of translated strings in the same order and with exactly the same length. Do not add explanations, markdown fences or extra items.',
            'Return ONLY the translated text directly, preserving line breaks and Markdown structure. Do not wrap in JSON or add explanations.',
          )
          const full = await requestCompletionStream(
            model,
            prompt,
            text,
            snapshot.apiKey,
            (delta, accumulated) => {
              try {
                port.postMessage({ type: 'delta', requestId, delta, text: accumulated })
              } catch {
                abort.abort()
              }
            },
            abort.signal,
          )
          try {
            port.postMessage({ type: 'done', requestId, text: full })
          } catch {
            void 0
          }
        } catch (error) {
          if (error instanceof CompletionCancelledError || abort.signal.aborted) return
          const reply = deps.failureReply(error)
          try {
            port.postMessage({ type: 'error', requestId, error: reply.error })
          } catch {
            void 0
          }
        } finally {
          if (activeAbort === abort) activeAbort = undefined
        }
      })()
    })
  })
}
