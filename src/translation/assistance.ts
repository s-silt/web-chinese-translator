import { sendTranslationMessage } from './client'
import { createId } from './id'
import type { AssistInput, RequestedAssistIntent } from './intent'
import {
  TRANSLATION_CONFIG_CHANGED_ERROR,
  TRANSLATION_PERMISSION_REMOVED_ERROR,
} from './messages'
import type { TranslationPanel } from './panel'
import { collectPageContext, readSelectionRange, readVisibleContext, selectionContext } from './reading-context'
import type { ReadingCandidate } from './reading-signals'
import type { SelectionAnchor } from './selection'

const DEFAULT_ERRORS = {
  wtAssistDisabled: '总开关已关闭',
  wtAssistConfigure: '请在扩展设置中配置模型',
  wtAssistInvalidResult: '翻译服务返回格式不正确',
  wtManualSelectionExpired: '请重新选中文字，再通过右键菜单或快捷键翻译。',
  wtTranslationConfigChanged: '翻译设置已变化，请确认设置后重新发起翻译。',
  wtTranslationPermissionRemoved: '网站或模型接口的访问权限已撤销，请重新授权后再翻译。',
} as const

interface AssistOptions {
  panel: TranslationPanel
  enabled: () => boolean
  configured: () => boolean
  smart: () => boolean
  pageId: () => string
  message?: (
    key:
      | 'wtAssistDisabled'
      | 'wtAssistConfigure'
      | 'wtAssistInvalidResult'
      | 'wtManualSelectionExpired'
      | 'wtTranslationConfigChanged'
      | 'wtTranslationPermissionRemoved',
  ) => string
}

export function createAssistance(o: AssistOptions) {
  let epoch = 0
  let activeRequestId = ''
  let lastSource = ''
  let lastAnchor: SelectionAnchor | undefined
  let lastGuard: (() => boolean) | undefined
  let lastManualSelectionId: string | undefined
  let lastRetry: (() => void) | undefined
  let lastManualCancellationNotice: 'wtTranslationConfigChanged' | 'wtTranslationPermissionRemoved' | undefined

  function manualCancellationNotice(
    settingsChanged: boolean,
  ): 'wtTranslationConfigChanged' | 'wtTranslationPermissionRemoved' | undefined {
    if (!o.panel.isOpen()) return undefined
    return (
      lastManualCancellationNotice ??
      (settingsChanged && activeRequestId !== '' && lastManualSelectionId !== undefined
        ? 'wtTranslationConfigChanged'
        : undefined)
    )
  }

  function message(key: keyof typeof DEFAULT_ERRORS): string {
    return o.message?.(key) ?? DEFAULT_ERRORS[key]
  }

  function currentSelectionRange(): Range | undefined {
    const selection = window.getSelection()
    return selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined
  }

  function begin(
    source: string,
    anchor: SelectionAnchor | undefined,
    guard: (() => boolean) | undefined,
    manualSelectionId?: string,
  ) {
    if (activeRequestId !== '') {
      void sendTranslationMessage({ type: 'wt:cancel-assist', requestId: activeRequestId })
      activeRequestId = ''
    }
    const myEpoch = ++epoch
    const id = createId()
    activeRequestId = id
    lastSource = source
    lastAnchor = anchor
    lastGuard = guard
    lastManualSelectionId = manualSelectionId
    lastManualCancellationNotice = undefined
    const doc = o.pageId()
    const href = location.href
    const current = (): boolean => myEpoch === epoch && doc === o.pageId() && href === location.href && o.enabled()
    const valid = (): boolean => current() && (guard === undefined || guard())
    return { id, doc, current, valid }
  }

  function cancel(): void {
    epoch += 1
    if (activeRequestId !== '') {
      void sendTranslationMessage({ type: 'wt:cancel-assist', requestId: activeRequestId })
      activeRequestId = ''
    }
    lastSource = ''
    lastAnchor = undefined
    lastGuard = undefined
    lastManualSelectionId = undefined
    lastManualCancellationNotice = undefined
    lastRetry = undefined
  }

  function guardFor(source: string): (() => boolean) | undefined {
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return undefined
    const range = selection.getRangeAt(0).cloneRange()
    if (readSelectionRange(range) !== source) return undefined
    const start = range.startContainer
    const end = range.endContainer
    return () => {
      if (!start.isConnected || !end.isConnected) return false
      return readSelectionRange(range) === source
    }
  }

  function literal(
    source: string,
    anchor?: SelectionAnchor,
    guard?: () => boolean,
    manualSelectionId?: string,
  ): void {
    if (!o.enabled()) {
      cancel()
      o.panel.showNotice(message('wtAssistDisabled'))
      return
    }
    if (!o.configured()) {
      cancel()
      o.panel.showNotice(message('wtAssistConfigure'))
      return
    }
    const sourceGuard = guard ?? guardFor(source)
    const { id, doc, current, valid } = begin(source, anchor, sourceGuard, manualSelectionId)
    if (!valid()) {
      cancel()
      return
    }
    const retryHref = location.href
    lastRetry = () => {
      if (doc === o.pageId() && retryHref === location.href) literal(source, anchor, sourceGuard, manualSelectionId)
    }
    o.panel.setAnchor(anchor)
    o.panel.showSelection(source)
    void sendTranslationMessage({
      type: 'wt:translate',
      mode: 'selection',
      texts: [source],
      requestId: id,
      page: collectPageContext(),
      pageId: doc,
      ...(manualSelectionId === undefined ? {} : { manualSelectionId }),
    }).then((reply) => {
      if (activeRequestId === id) activeRequestId = ''
      if (!current()) return
      if (!valid()) {
        cancel()
        o.panel.close()
        return
      }
      if (reply.ok && reply.texts !== undefined && reply.texts.length === 1) {
        o.panel.showSelectionResult(source, reply.texts)
      } else if (!reply.ok && reply.code === 'cancelled' && manualSelectionId !== undefined) {
        const key = reply.error === TRANSLATION_PERMISSION_REMOVED_ERROR
          ? 'wtTranslationPermissionRemoved'
          : reply.error === TRANSLATION_CONFIG_CHANGED_ERROR
            ? 'wtTranslationConfigChanged'
            : 'wtManualSelectionExpired'
        lastManualCancellationNotice = key === 'wtManualSelectionExpired' ? undefined : key
        o.panel.showNotice(message(key))
      } else {
        o.panel.showError(reply.ok ? message('wtAssistInvalidResult') : reply.error)
      }
    })
  }

  function select(
    text: string,
    anchor: SelectionAnchor,
    method: 'mouse' | 'keyboard',
    stillValid: () => boolean,
    requestedIntent?: RequestedAssistIntent,
  ): void {
    if (!o.enabled() || !o.configured()) {
      cancel()
      if (o.enabled() && requestedIntent !== undefined) o.panel.showNotice(message('wtAssistConfigure'))
      else o.panel.close()
      return
    }
    const { id, doc, current, valid } = begin(text, anchor, stillValid)
    if (!valid()) {
      cancel()
      return
    }
    const retryHref = location.href
    lastRetry = () => {
      if (doc === o.pageId() && retryHref === location.href) select(text, anchor, method, stillValid, requestedIntent)
    }
    o.panel.setAnchor(anchor)
    o.panel.showSelection(text)
    const range = currentSelectionRange()
    const input: AssistInput = {
      text,
      context: range !== undefined ? selectionContext(range) : '',
      pageTitle: document.title.slice(0, 160),
      site: location.hostname,
      trigger: 'selection',
      signals: { method, dwellMs: 0, visits: 1 },
      ...(requestedIntent === undefined ? {} : { requestedIntent }),
    }
    void sendTranslationMessage({ type: 'wt:assist', requestId: id, input, page: collectPageContext(), pageId: doc }).then(
      (reply) => {
        if (activeRequestId === id) activeRequestId = ''
        if (!current()) return
        if (!valid()) {
          cancel()
          o.panel.close()
          return
        }
        if (!reply.ok) {
          o.panel.showError(reply.error)
          return
        }
        const result = reply.result
        if (result === undefined) {
          o.panel.showError(message('wtAssistInvalidResult'))
          return
        }
        if (result.decision === 'silent') {
          o.panel.close()
          return
        }
        o.panel.setAnchor(anchor)
        o.panel.showAssist(text, result)
      },
    )
  }

  function revisit(candidate: ReadingCandidate): void {
    if (!o.smart() || !o.configured() || o.panel.isOpen()) return
    if (!candidate.element.isConnected) return
    const text = readVisibleContext(candidate.element, 1201).trim()
    if (text !== candidate.text) return
    const { id, doc, current, valid } = begin(candidate.text, candidate.anchor, () => {
      if (!candidate.element.isConnected) return false
      const rect = candidate.element.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        return false
      }
      return readVisibleContext(candidate.element, 1201).trim() === candidate.text
    })
    if (!valid()) {
      cancel()
      return
    }
    const input: AssistInput = {
      text: candidate.text,
      context: '',
      pageTitle: document.title.slice(0, 160),
      site: location.hostname,
      trigger: 'revisit',
      signals: { method: 'none', dwellMs: candidate.dwellMs, visits: candidate.visits },
    }
    void sendTranslationMessage({ type: 'wt:assist', requestId: id, input, page: collectPageContext(), pageId: doc }).then(
      (reply) => {
        if (activeRequestId === id) activeRequestId = ''
        if (!current()) return
        if (!valid() || !o.smart() || o.panel.isOpen()) return
        if (!reply.ok || reply.result === undefined || reply.result.decision !== 'show') return
        const result = reply.result
        o.panel.showHint(candidate.anchor, () => {
          if (!valid() || !o.smart()) return
          o.panel.setAnchor(candidate.anchor)
          o.panel.showAssist(candidate.text, result)
        })
      },
    )
  }

  function repeatLiteral(): void {
    if (lastSource === '') return
    literal(lastSource, lastAnchor, lastGuard, lastManualSelectionId)
  }

  function repeatRequest(): void {
    lastRetry?.()
  }

  return { select, literal, revisit, repeatLiteral, repeatRequest, cancel, manualCancellationNotice }
}
