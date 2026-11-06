import { createDomScanner, type DomScanner } from './dom-walker'
import { textOwnership } from '../shared/text-ownership'
import { pageIdentity } from './page-lifecycle'
import { backoffDelayMs, isTransientFailure, MAX_ATTEMPTS, MAX_RETRY_AFTER_MS, type FailureInfo } from './failure'
import { invalidateLayout, tryReplaceText, tryReplaceTexts, wasRejected, type TextReplacement } from './layout'
import { isReadableElement as isVisible } from './reading-context'
import {
  canTranslateFixedFormAttributes,
  FIXED_ATTRIBUTES,
  fixedUiContext,
  isExcludedElement,
  isFixedExcludedElement,
  isFixedUiElement,
  isModelCandidateText,
  joinTranslatedChunks,
  MAX_MODEL_TEXT,
  splitLongText,
} from './sites'
import { inlineUnitFor, isInlineUnitCurrent, parseInlineResult, type InlineUnit } from './inline-units'
import type { SourceLanguage, TargetLanguage } from './target-language'

export interface DomEngine {
  start(): void
  stop(): void
  restore(): void
  dispose(): void
  invalidate(): void
  pauseAuto(): void
  resumeAuto(): void
  isAutoPaused(): boolean
  isCapped(): boolean
  /** 上限来自字符额度，可由用户追加；记录数上限不能追加。 */
  isBudgetCapped(): boolean
  /** 用户要求继续：追加一份额度并释放字符上限；并非字符上限时返回 false。 */
  extendBudget(): boolean
  /** 单页上限设置改变后重新判断：调高后已达上限的页面继续处理 */
  budgetChanged(): void
  /** 连接变更时重新开始：取消在途批次并清零额度；普通刷新、恢复原文不得调用。 */
  resetBudget(): void
  /** 已放弃、仍保留原文的文本节点数。 */
  failedCount(): number
  /** 只重新排队已放弃的文本，不动额度；页面未在自动翻译时返回 false。 */
  retryFailed(): boolean
}

/** applied 已写入；retrying 已退回待发或拆分重发；skipped 仅这些条目保留原文，页面继续；dropped 内部取消，静默重排；paused 页面已暂停；stale 批次已失效。 */
export type AutoBatchOutcome = 'applied' | 'retrying' | 'skipped' | 'dropped' | 'paused' | 'stale'

export type AutoBatchApply = (
  results: readonly string[] | undefined,
  failure?: FailureInfo,
  /** 其中由缓存提供的字符数，不计入页面预算。 */
  cachedChars?: number,
) => AutoBatchOutcome

export interface DomEngineOptions {
  fixedEnabled(): boolean
  autoEnabled(): boolean
  /** 当前翻译目标语言；engine 每次判定时调用，允许设置热更新。 */
  targetLanguage(): TargetLanguage
  sourceLanguage?: () => SourceLanguage
  translateFixed?: (text: string) => string | undefined
  onAutoBatch(texts: string[], apply: AutoBatchApply): void
  onCapped?(): void
  onCapReleased?(): void
  onFailedChanged?(): void
  debounceMs?: number
  /** 单页字符预算；每次判定时读取，0 或 Infinity 为不限。不给时用 DEFAULT_BUDGET */
  autoBudget?: number | (() => number)
  recordBudget?: number
  random?: () => number
}

interface NodeRecord {
  original: string
  applied: string
  generation: number
  location: string
}

interface AttrRecord {
  original: string
  applied: string
}

/** 超长文本节点的分段进度：全部分段成功才写回节点。 */
interface LongText {
  source: string
  parent: Element
  parts: (string | undefined)[]
  separators: readonly string[]
  remaining: number
}

interface AutoEntry {
  node: Text
  source: string
  request: string
  readyAt: number
  parent: Element
  /** 存在时 request 只是节点文本的一段。 */
  chunk?: { long: LongText; index: number }
  /** 行内单元：nodes[0] 作为锚点 entry.node，request = template，source = '\u0000' 拼接的逐节点原文。 */
  unit?: InlineUnit
  /** 网站在已译节点末尾追加了原文：request 只是新增部分，写回时保留已译前缀 */
  append?: AppendedTail
}

/** 已译前缀与其原文；source 的开头就是 applied */
interface AppendedTail {
  readonly applied: string
  readonly original: string
}

/** 同一原始批次拆分出的全部子请求共用：限制总请求数，并记录是否有过成功。 */
interface AutoLineage {
  subRequests: number
  succeeded: boolean
}

interface AutoBatch {
  texts: string[]
  grouped: Map<string, AutoEntry[]>
  /** 已失败过的、包含这些条目的请求数。 */
  tries: number
  lineage: AutoLineage
  /** 子批次失败后回到 splitQueue；原始批次回到 pending。 */
  isSub: boolean
}

const STABILIZE_MS = 500
const MAX_PENDING = 1000
const MAX_DEFERRED = 1000
const MAX_BATCH_ITEMS = 20
const MAX_BATCH_CHARS = 1500
const MIN_BATCH_CHARS = 400
const BATCH_CHARS_GROWTH = 100
const MAX_SPLIT_REQUESTS = 16
const MAX_BAD_OUTPUT_TRIES = 2
const MAX_FAILED_STREAK = 8
const DEFAULT_BUDGET = 20000
const MAX_TRACKED_NODES = 2048
const ATTR_WATCH = ['style', 'class', 'hidden', 'aria-hidden', 'contenteditable', 'translate', 'open', 'role', 'onclick']
const RESIZE_SCAN_MS = 400
const VIEWPORT_SCAN_MS = 200
const VISIBILITY_RETRY_MS = 120
const CANCELLED_REQUEUE_MS = 1000
const MIN_BUSY_RETRY_MS = 1000
const MAX_RESTART_RETRIES = 5
const ownership = textOwnership()

export function createDomEngine(options: DomEngineOptions): DomEngine {
  const debounceMs = options.debounceMs ?? STABILIZE_MS
  const budgetOption = options.autoBudget ?? DEFAULT_BUDGET
  function baseBudgetNow(): number {
    const value = typeof budgetOption === 'function' ? budgetOption() : budgetOption
    return Number.isFinite(value) && value > 0 ? value : Infinity
  }
  /** 本页已追加的额度份数：「继续翻译」每次追加一份基础额度 */
  let budgetShares = 1
  const budgetNow = (): number => baseBudgetNow() * budgetShares
  const random = options.random ?? Math.random
  const requestedRecords = options.recordBudget ?? MAX_TRACKED_NODES
  const recordBudget = Number.isFinite(requestedRecords)
    ? Math.max(1, Math.min(Math.trunc(requestedRecords), MAX_TRACKED_NODES))
    : MAX_TRACKED_NODES
  const records = new WeakMap<Text, NodeRecord>()
  const attrRecords = new WeakMap<Element, Map<string, AttrRecord>>()
  const modifiedTexts = new Set<Text>()
  const modifiedElements = new Set<Element>()
  const pending = new Map<Text, AutoEntry>()
  /** 网站在已译文本末尾追加原文时，记下已译前缀，只翻译新增部分 */
  const appendedTails = new WeakMap<Text, AppendedTail>()
  /** 已属于某个 pending/在途行内单元的文本节点 → 其 AutoEntry；避免重复排队与逐节点抢译。 */
  let unitMembers = new WeakMap<Text, AutoEntry>()
  /** 单元译文解析失败过一次：这些节点退回到逐节点路径，不再尝试单元。 */
  const unitFallback = new WeakSet<Text>()
  const splitQueue: AutoBatch[] = []
  const longTexts = new Map<Text, LongText>()
  const deferred = new Map<Text, Element>()
  const viewportPending = new Map<Element, Set<Text>>()
  const intersectingDeferred = new Set<Element>()
  let observationOverflow = false
  let pendingOverflow = false
  let viewportTimer: ReturnType<typeof setTimeout> | undefined
  let visibilityTimer: ReturnType<typeof setTimeout> | undefined
  let capReason: 'characters' | 'records' | undefined
  let generation = 0
  let lastLocation = pageIdentity(location.href)
  let spent = 0
  let reservedChars = 0
  let capped = false
  let autoPaused = false
  let suspended = true
  let disposed = false
  let cappedNotified = false
  let activeBatch: symbol | undefined
  let notBefore = 0
  let retryFailures = 0
  let busyRetries = 0
  let restartRetries = 0
  let failedStreak = 0
  let batchCharLimit = MAX_BATCH_CHARS
  const failedItems = new Map<Text, string>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let applyTimer: ReturnType<typeof setTimeout> | undefined
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let cleanupAgain = false

  function textValue(node: Text): string {
    return node.nodeValue ?? ''
  }

  function rememberWrite(change: TextReplacement): void {
    records.set(change.node, { original: change.source, applied: change.translated, generation, location: lastLocation })
    ownership.claim(change.node, 'web', change.translated)
    modifiedTexts.add(change.node)
  }

  function forgetNode(node: Text): void {
    records.delete(node)
    modifiedTexts.delete(node)
    ownership.release(node, 'web')
  }

  function writeNode(node: Text, source: string, translated: string): number {
    if (wasRejected(node, source)) return 0
    if (!modifiedTexts.has(node) && trackedCount() >= recordBudget) {
      markCapped('records')
      return 0
    }
    if (!tryReplaceText(node, source, translated)) return 0
    rememberWrite({ node, source, translated })
    return 1
  }

  const fixedWrites = new Map<Text, TextReplacement & { parent: Element }>()
  let recordCapDeferred = false

  function flushFixedWrites(): void {
    const queued = [...fixedWrites.values()]
    const recheck = recordCapDeferred
    fixedWrites.clear()
    recordCapDeferred = false
    if (disposed || suspended || !options.fixedEnabled()) return
    const changes = queued.filter(({ node, source, parent }) =>
      node.isConnected && node.parentElement === parent && textValue(node) === source &&
      !isFixedExcludedElement(parent) && fixedUiContext(parent),
    )
    const applied = tryReplaceTexts(changes)
    changes.forEach((change, index) => {
      if (applied[index]) rememberWrite(change)
    })
    // 暂存只控制准入；提交后的真实占用才触发上限及清理副作用。
    if (recheck && retainedRecordCount() >= recordBudget) markCapped('records')
    releaseRecordCap()
    // 字符上限不能挡住本地词典；被暂存占位跳过的候选也需要重扫。
    if (recheck && retainedRecordCount() < recordBudget && !disposed && !suspended && document.body !== null) {
      scanner.queue(document.body)
    }
  }

  function applyFixedText(node: Text): number {
    const translate = options.translateFixed
    if (translate === undefined || !options.fixedEnabled()) return 0
    const parent = node.parentElement
    if (parent === null || isFixedExcludedElement(parent) || !fixedUiContext(parent)) return 0
    if (ownership.ownerOf(node) === 'github') return 0
    const source = textValue(node)
    const record = records.get(node)
    if (record !== undefined && record.applied === source) return 0
    const translated = translate(source)
    if (translated === undefined || translated === source) return 0
    if (wasRejected(node, source)) return 0
    if (!modifiedTexts.has(node) && !fixedWrites.has(node) && trackedCount() >= recordBudget) {
      markCapped('records')
      return 0
    }
    fixedWrites.set(node, { node, source, translated, parent })
    return 1
  }

  function releaseStaleAttributes(element: Element): void {
    const map = attrRecords.get(element)
    if (map === undefined) return
    for (const [name, record] of map) {
      if (element.getAttribute(name) !== record.applied) map.delete(name)
    }
    if (map.size === 0) {
      attrRecords.delete(element)
      modifiedElements.delete(element)
      releaseRecordCap()
    }
  }

  function applyFixedAttributes(element: Element): number {
    releaseStaleAttributes(element)
    const translate = options.translateFixed
    if (translate === undefined || !options.fixedEnabled()) return 0
    const formAttributes = canTranslateFixedFormAttributes(element)
    if (!formAttributes && (isFixedExcludedElement(element) || !isFixedUiElement(element))) return 0
    let writes = 0
    for (const name of FIXED_ATTRIBUTES) {
      if (name === 'placeholder' && !formAttributes) continue
      const value = element.getAttribute(name)
      if (value === null) continue
      const record = attrRecords.get(element)?.get(name)
      if (record !== undefined && record.applied === value) continue
      const translated = translate(value)
      if (translated === undefined || translated === value) continue
      if (!modifiedElements.has(element) && trackedCount() >= recordBudget) {
        markCapped('records')
        return writes
      }
      let map = attrRecords.get(element)
      if (map === undefined) {
        map = new Map()
        attrRecords.set(element, map)
      }
      map.set(name, { original: value, applied: translated })
      modifiedElements.add(element)
      element.setAttribute(name, translated)
      writes += 1
    }
    return writes
  }

  function autoCandidate(node: Text): boolean {
    if (!node.isConnected || records.has(node)) return false
    if (ownership.ownerOf(node) === 'github') return false
    const parent = node.parentElement
    if (parent === null || isExcludedElement(parent)) return false
    const source = textValue(node)
    const tail = appendedTail(node, source)
    const judged = tail === undefined ? source : source.slice(tail.applied.length)
    return !wasRejected(node, source) && failedItems.get(node) !== source && isModelCandidateText(judged, options.targetLanguage(), options.sourceLanguage?.() ?? 'auto')
  }

  /** 节点当前值仍以记下的已译前缀开头时返回它；否则作废 */
  function appendedTail(node: Text, source: string): AppendedTail | undefined {
    const tail = appendedTails.get(node)
    if (tail === undefined) return undefined
    if (source.length > tail.applied.length && source.startsWith(tail.applied)) return tail
    appendedTails.delete(node)
    return undefined
  }

  function onscreenParent(parent: Element): boolean {
    const rect = parent.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
  }

  const inlineOptions = {
    isExcluded: (el: Element) => isExcludedElement(el) || !isVisible(el),
    isFrozen: (text: Text) =>
      records.has(text) ||
      ownership.ownerOf(text) === 'github' ||
      wasRejected(text, textValue(text)) ||
      failedItems.get(text) === textValue(text),
  }

  function unitCurrent(unit: InlineUnit): boolean {
    return isInlineUnitCurrent(unit, inlineOptions)
  }

  /** 只删自己的登记：迟到的旧 entry 不得清掉新单元的成员登记 */
  function clearUnit(entry: AutoEntry): void {
    if (entry.unit === undefined) return
    for (const member of entry.unit.nodes) {
      if (unitMembers.get(member) === entry) unitMembers.delete(member)
    }
  }

  function dropEntry(node: Text): void {
    const entry = pending.get(node)
    if (entry !== undefined) clearUnit(entry)
    pending.delete(node)
    const parent = deferred.get(node)
    if (parent === undefined) return
    deferred.delete(node)
    const set = viewportPending.get(parent)
    set?.delete(node)
    if (set?.size === 0) {
      viewportPending.delete(parent)
      intersectingDeferred.delete(parent)
      observerIo?.unobserve(parent)
    }
  }

  function defer(node: Text, parent: Element): void {
    const entry = pending.get(node)
    if (entry !== undefined) clearUnit(entry)
    pending.delete(node)
    if (deferred.get(node) === parent) return
    dropEntry(node)
    if (deferred.size >= MAX_DEFERRED) {
      observationOverflow = true
      return
    }
    deferred.set(node, parent)
    let set = viewportPending.get(parent)
    if (set === undefined) {
      set = new Set()
      viewportPending.set(parent, set)
    }
    set.add(node)
    observerIo?.observe(parent)
  }

  function queueAuto(node: Text): void {
    if (!options.autoEnabled() || autoPaused || capped) return
    // 在途批次的预扣可能被缓存退回，只按已结算的字符判断
    if (spent - reservedChars >= budgetNow()) {
      markCapped('characters')
      return
    }
    if (!autoCandidate(node)) {
      dropEntry(node)
      return
    }
    const parent = node.parentElement!
    // 原文或父元素变化时作废旧分段，让当前节点按新位置重新排队。
    const long = longTexts.get(node)
    if (long?.source === textValue(node) && long.parent === parent) return
    if (long !== undefined) longTexts.delete(node)
    // 行内单元：该节点已属于 pending/在途单元 → 快照仍有效则不再排队；失效则清理并重建
    const anchored = unitMembers.get(node)
    if (anchored?.unit !== undefined) {
      if (unitCurrent(anchored.unit)) return
      clearUnit(anchored)
      if (pending.get(anchored.node) === anchored) pending.delete(anchored.node)
    }
    const unit = unitFallback.has(node)
      ? undefined
      : inlineUnitFor(node, inlineOptions)
    if (unit !== undefined) {
      const anchor = unit.nodes[0]!
      const block = unit.block
      if (!isVisible(block) || !onscreenParent(block)) {
        defer(anchor, block)
        return
      }
      if (trackedCount() >= recordBudget) {
        markCapped('records')
        return
      }
      dropEntry(anchor)
      if (pending.size >= MAX_PENDING) {
        pendingOverflow = true
        return
      }
      const entry: AutoEntry = {
        node: anchor,
        source: unit.sources.join('\u0000'),
        request: unit.template,
        readyAt: Date.now() + debounceMs,
        parent: block,
        unit,
      }
      pending.set(anchor, entry)
      for (const member of unit.nodes) unitMembers.set(member, entry)
      scheduleFlush()
      return
    }
    if (!isVisible(parent) || !onscreenParent(parent)) {
      defer(node, parent)
      return
    }
    if (trackedCount() >= recordBudget) {
      markCapped('records')
      return
    }
    const prior = pending.get(node)
    if (prior !== undefined && prior.parent === parent) {
      if (prior.source !== textValue(node)) {
        prior.source = textValue(node)
        prior.append = appendedTail(node, prior.source)
        prior.request = requestFor(prior.source, prior.append)
        prior.readyAt = Date.now() + debounceMs
      }
      scheduleFlush()
      return
    }
    dropEntry(node)
    if (pending.size >= MAX_PENDING) {
      pendingOverflow = true
      return
    }
    const source = textValue(node)
    const append = appendedTail(node, source)
    pending.set(node, {
      node,
      source,
      request: requestFor(source, append),
      readyAt: Date.now() + debounceMs,
      parent,
      ...(append === undefined ? {} : { append }),
    })
    scheduleFlush()
  }

  function requestFor(source: string, append: AppendedTail | undefined): string {
    return (append === undefined ? source : source.slice(append.applied.length)).trim()
  }

  function scheduleFlush(): void {
    if (disposed || suspended || autoPaused || capped || activeBatch !== undefined || flushTimer !== undefined) {
      return
    }
    let earliest = splitQueue.length > 0 ? 0 : Infinity
    for (const entry of pending.values()) {
      if (!entry.node.isConnected) continue
      if (entry.readyAt < earliest) earliest = entry.readyAt
    }
    if (earliest === Infinity) return
    flushTimer = setTimeout(flush, Math.max(0, Math.max(earliest, notBefore) - Date.now()))
  }

  function clearFlush(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
  }

  function liveEntry(entry: AutoEntry): 'live' | 'dead' | 'hidden' | 'soon' {
    if (entry.unit !== undefined) {
      const unit = entry.unit
      if (!unit.block.isConnected || !unitCurrent(unit)) return 'dead'
      if (isExcludedElement(unit.block)) return 'dead'
      if (!options.autoEnabled() || autoPaused || capped) return 'dead'
      const anyMemberDead = unit.nodes.some((member, i) =>
        wasRejected(member, unit.sources[i]!) || records.has(member) || failedItems.get(member) === unit.sources[i])
      if (anyMemberDead) return 'dead'
      if (!isVisible(unit.block) || !onscreenParent(unit.block)) return 'hidden'
      return entry.readyAt <= Date.now() ? 'live' : 'soon'
    }
    if (!entry.node.isConnected || textValue(entry.node) !== entry.source) return 'dead'
    const parent = entry.node.parentElement
    if (parent === null || parent !== entry.parent) return 'dead'
    if (isExcludedElement(parent) || wasRejected(entry.node, entry.source)) return 'dead'
    if (records.has(entry.node) || failedItems.get(entry.node) === entry.source) return 'dead'
    if (entry.chunk !== undefined && longTexts.get(entry.node) !== entry.chunk.long) return 'dead'
    if (!options.autoEnabled() || autoPaused || capped) return 'dead'
    if (!isVisible(parent) || !onscreenParent(parent)) return 'hidden'
    return entry.readyAt <= Date.now() ? 'live' : 'soon'
  }

  function markCapped(reason: 'characters' | 'records'): void {
    if (reason === 'records' && fixedWrites.size > 0 && retainedRecordCount() < recordBudget) {
      recordCapDeferred = true
      return
    }
    if (capReason !== 'characters') capReason = reason
    capped = true
    clearPending()
    if (cappedNotified) return
    cappedNotified = true
    options.onCapped?.()
  }

  function releaseRecordCap(): void {
    if (!capped || capReason !== 'records' || trackedCount() >= recordBudget) return
    capped = false
    capReason = undefined
    cappedNotified = false
    options.onCapReleased?.()
    if (disposed || suspended) return
    if ((options.fixedEnabled() || (options.autoEnabled() && !autoPaused)) && document.body !== null) {
      scanner.queue(document.body)
    }
  }

  function releaseCharacterCap(): void {
    if (!capped || capReason !== 'characters' || spent >= budgetNow()) return
    capped = false
    capReason = undefined
    cappedNotified = false
    options.onCapReleased?.()
    if (disposed || suspended || autoPaused || !options.autoEnabled() || document.body === null) return
    scanner.queue(document.body)
  }

  /** 尚未收到有效结果的批次预扣；失效时由引擎释放，不依赖迟到回包。 */
  function releaseBatchReservation(): boolean {
    const released = reservedChars
    spent -= released
    reservedChars = 0
    return released > 0
  }

  function requeueEntries(entries: readonly AutoEntry[]): void {
    if (capped) return
    for (const entry of entries) {
      clearUnit(entry)
      if (pending.has(entry.node) || deferred.has(entry.node)) continue
      if (pending.size >= MAX_PENDING) {
        pendingOverflow = true
        continue
      }
      pending.set(entry.node, entry)
      if (entry.unit !== undefined) for (const member of entry.unit.nodes) unitMembers.set(member, entry)
    }
  }

  function clearPending(): void {
    pending.clear()
    splitQueue.length = 0
    longTexts.clear()
    deferred.clear()
    viewportPending.clear()
    intersectingDeferred.clear()
    unitMembers = new WeakMap()
    observationOverflow = false
    pendingOverflow = false
    if (viewportTimer !== undefined) {
      clearTimeout(viewportTimer)
      viewportTimer = undefined
    }
    if (visibilityTimer !== undefined) {
      clearTimeout(visibilityTimer)
      visibilityTimer = undefined
    }
    observerIo?.disconnect()
    clearFlush()
  }

  function flush(): void {
    flushTimer = undefined
    if (disposed || suspended || autoPaused || capped || activeBatch !== undefined || !options.autoEnabled()) {
      return
    }
    if (Date.now() < notBefore) {
      scheduleFlush()
      return
    }
    const sub = takeSplitBatch()
    if (sub !== undefined) {
      sendBatch(sub)
      return
    }
    const texts: string[] = []
    const grouped = new Map<string, AutoEntry[]>()
    let chars = 0
    let entries = 0
    const slots = recordBudget - trackedCount()
    let budgetBlocked = false
    let recordsBlocked = false
    const now = Date.now()
    for (const entry of pending.values()) {
      if (entry.readyAt > now) continue
      const state = liveEntry(entry)
      if (state === 'dead') {
        dropEntry(entry.node)
        continue
      }
      if (state === 'hidden') {
        defer(entry.node, entry.parent)
        continue
      }
      if (state === 'soon') continue
      const cost = entry.unit?.nodes.length ?? 1
      if (entry.unit !== undefined && cost > slots) {
        // 单元节点数超过全部记录余位：丢弃并退回逐节点路径，避免以单元反复零延迟重试
        dropEntry(entry.node)
        for (const member of entry.unit.nodes) {
          unitFallback.add(member)
          queueAuto(member)
        }
        continue
      }
      if (entries + cost > slots) {
        recordsBlocked = true
        continue
      }
      if (entry.request.length > MAX_MODEL_TEXT) {
        if (texts.length > 0) continue
        // 比整份额度还长：等它会卡住全页其余内容，直接计为失败
        if (entry.request.length > budgetNow()) {
          recordFailures([entry])
          dropEntry(entry.node)
          continue
        }
        if (spent + entry.request.length > budgetNow()) {
          budgetBlocked = true
          continue
        }
        startLongText(entry)
        const first = takeSplitBatch()
        if (first !== undefined) sendBatch(first)
        else scheduleFlush()
        return
      }
      if (!grouped.has(entry.request)) {
        if (texts.length >= MAX_BATCH_ITEMS) continue
        // 上限收缩后，单条长文本仍要能独立成批
        if (texts.length > 0 && chars + entry.request.length > batchCharLimit) continue
        if (spent + chars + entry.request.length > budgetNow()) {
          budgetBlocked = true
          continue
        }
        grouped.set(entry.request, [])
        texts.push(entry.request)
        chars += entry.request.length
      }
      grouped.get(entry.request)?.push(entry)
      entries += cost
    }
    if (texts.length === 0) {
      if (budgetBlocked) markCapped('characters')
      else if (recordsBlocked && slots <= 0) markCapped('records')
      scheduleFlush()
      return
    }
    sendBatch({ texts, grouped, tries: 0, lineage: { subRequests: 0, succeeded: false }, isSub: false })
  }

  /** 取下一个仍有存活条目的拆分批次；优先于新内容发送，保持每页只有一个在途批次。 */
  function takeSplitBatch(): AutoBatch | undefined {
    for (let batch = splitQueue.shift(); batch !== undefined; batch = splitQueue.shift()) {
      const reservedNodes = new Set<Text>()
      let slots = recordBudget - trackedCount()
      const grouped = new Map<string, AutoEntry[]>()
      for (const request of batch.texts) {
        const live = (batch.grouped.get(request) ?? []).filter((entry) => {
          const state = liveEntry(entry)
          // 分段缺一段就无法写回：作废这一轮，再次可见时重新分段，已译分段由缓存退款。
          if (state !== 'live' && entry.chunk !== undefined && longTexts.get(entry.node) === entry.chunk.long) {
            longTexts.delete(entry.node)
          }
          // 在途单元已离开 pending，defer 清不掉成员登记。
          if (state !== 'live' && entry.unit !== undefined) clearUnit(entry)
          if (state === 'hidden') defer(entry.node, entry.parent)
          if (state !== 'live') return false
          const members = entry.unit?.nodes ?? [entry.node]
          // 同一长文本的多个 chunk 共用节点，只占一个记录位。
          const cost = members.filter((node) => !reservedNodes.has(node)).length
          if (cost > slots) {
            if (entry.unit !== undefined) {
              clearUnit(entry)
              for (const member of members) unitFallback.add(member)
              for (const member of members) queueAuto(member)
              return false
            }
            if (entry.chunk !== undefined && longTexts.get(entry.node) === entry.chunk.long) longTexts.delete(entry.node)
            queueAuto(entry.node)
            return false
          }
          for (const member of members) reservedNodes.add(member)
          slots -= cost
          return true
        })
        if (live.length > 0) grouped.set(request, live)
      }
      if (grouped.size > 0) return { ...batch, texts: [...grouped.keys()], grouped }
    }
    return undefined
  }

  function subBatch(parent: AutoBatch, texts: string[], tries: number): AutoBatch {
    const grouped = new Map(texts.map((request) => [request, parent.grouped.get(request) ?? []]))
    return { texts, grouped, tries, lineage: parent.lineage, isSub: true }
  }

  /** 把长文本节点拆成分段批次排入 splitQueue；分段大小固定，只有批次大小随上限收缩。 */
  function startLongText(entry: AutoEntry): void {
    const { chunks, separators } = splitLongText(entry.request)
    const long: LongText = { source: entry.source, parent: entry.parent, parts: [], separators, remaining: chunks.length }
    longTexts.set(entry.node, long)
    dropEntry(entry.node)
    let current: AutoBatch | undefined
    let chars = 0
    chunks.forEach((request, index) => {
      const full = current !== undefined && (current.texts.length >= MAX_BATCH_ITEMS || chars + request.length > batchCharLimit)
      if (current === undefined || (full && !current.grouped.has(request))) {
        current = { texts: [], grouped: new Map(), tries: 0, lineage: { subRequests: 0, succeeded: false }, isSub: true }
        chars = 0
        splitQueue.push(current)
      }
      let group = current.grouped.get(request)
      if (group === undefined) {
        group = []
        current.grouped.set(request, group)
        current.texts.push(request)
        chars += request.length
      }
      group.push({ ...entry, request, readyAt: 0, chunk: { long, index } })
    })
  }

  /** 记下一段译文；最后一段到齐时返回整节点译文。 */
  function collectChunk(entry: AutoEntry, translated: string): string | undefined {
    const chunk = entry.chunk
    if (chunk === undefined) return translated
    const { long, index } = chunk
    if (longTexts.get(entry.node) !== long) return undefined
    long.parts[index] = translated
    long.remaining -= 1
    if (long.remaining > 0) return undefined
    longTexts.delete(entry.node)
    return joinTranslatedChunks(long.parts as string[], long.separators, options.targetLanguage())
  }

  function retainedRecordCount(): number {
    return modifiedTexts.size + modifiedElements.size + failedItems.size
  }

  function trackedCount(): number {
    let count = retainedRecordCount()
    for (const node of fixedWrites.keys()) if (!modifiedTexts.has(node)) count += 1
    return count
  }

  function pruneFailed(): boolean {
    let changed = false
    for (const [node, source] of failedItems) {
      if (node.isConnected && textValue(node) === source) continue
      failedItems.delete(node)
      changed = true
    }
    if (changed) releaseRecordCap()
    return changed
  }

  function clearFailed(): void {
    if (failedItems.size === 0) return
    failedItems.clear()
    releaseRecordCap()
    options.onFailedChanged?.()
  }

  function recordFailures(entries: readonly AutoEntry[]): void {
    pruneFailed()
    outer: for (const entry of entries) {
      const items = entry.unit === undefined
        ? [{ node: entry.node, source: entry.source }]
        : entry.unit.nodes.map((node, i) => ({ node, source: entry.unit!.sources[i]! }))
      if (entry.unit !== undefined) {
        clearUnit(entry)
        for (const member of entry.unit.nodes) unitFallback.add(member)
      }
      for (const item of items) {
        if (!item.node.isConnected || textValue(item.node) !== item.source || records.has(item.node)) continue
        if (!failedItems.has(item.node) && trackedCount() >= recordBudget) {
          markCapped('records')
          break outer
        }
        failedItems.set(item.node, item.source)
        if (entry.chunk !== undefined) longTexts.delete(entry.node)
        if (trackedCount() >= recordBudget) {
          markCapped('records')
          break outer
        }
      }
    }
    options.onFailedChanged?.()
  }

  function markItemsFailed(batch: AutoBatch): void {
    recordFailures([...batch.grouped.values()].flat())
  }

  /** 排入子批次并计入请求上限；额度用尽时这些条目保留原文，返回 false。 */
  function queueSubBatches(batch: AutoBatch, children: AutoBatch[]): boolean {
    if (batch.lineage.subRequests + children.length > MAX_SPLIT_REQUESTS) {
      markItemsFailed(batch)
      return false
    }
    batch.lineage.subRequests += children.length
    splitQueue.unshift(...children)
    return true
  }

  function pausePage(): AutoBatchOutcome {
    autoPaused = true
    retryFailures = 0
    restartRetries = 0
    failedStreak = 0
    splitQueue.length = 0
    longTexts.clear()
    releaseCharacterCap()
    return 'paused'
  }

  /** 超时或输出不合格：拆半重发，单条用尽尝试后只放弃该条。全部失败才说明问题不在个别条目，此时暂停。 */
  function failSplittable(batch: AutoBatch, code: 'timeout' | 'bad_output', retryAfterMs: number | undefined): AutoBatchOutcome {
    const timedOut = code === 'timeout'
    failedStreak += 1
    if (timedOut) batchCharLimit = Math.max(MIN_BATCH_CHARS, Math.floor(batchCharLimit / 2))
    const tries = batch.tries + 1
    const single = batch.texts.length === 1
    let outcome: AutoBatchOutcome = 'retrying'
    if (single && tries >= (timedOut ? MAX_ATTEMPTS : MAX_BAD_OUTPUT_TRIES)) {
      markItemsFailed(batch)
      outcome = 'skipped'
    } else {
      const middle = Math.ceil(batch.texts.length / 2)
      const children = single
        ? [subBatch(batch, batch.texts, tries)]
        : [subBatch(batch, batch.texts.slice(0, middle), tries), subBatch(batch, batch.texts.slice(middle), tries)]
      if (!queueSubBatches(batch, children)) outcome = 'skipped'
    }
    const lineage = batch.lineage
    const allTimedOut = timedOut && !lineage.succeeded && !splitQueue.some((item) => item.lineage === lineage)
    if (failedStreak >= MAX_FAILED_STREAK || allTimedOut) return pausePage()
    const delay = retryAfterMs ?? (timedOut ? backoffDelayMs(failedStreak, random) : 0)
    notBefore = Date.now() + Math.min(delay, MAX_RETRY_AFTER_MS)
    releaseCharacterCap()
    scheduleFlush()
    return outcome
  }

  function sendBatch(batch: AutoBatch): void {
    const { texts, grouped } = batch
    for (const request of texts) {
      for (const entry of grouped.get(request) ?? []) pending.delete(entry.node)
    }
    const chars = texts.reduce((sum, request) => sum + request.length, 0)
    const ticket = Symbol('batch')
    activeBatch = ticket
    const gen = generation
    const href = pageIdentity(location.href)
    spent += chars
    reservedChars = chars
    let settled = false
    const fail = (failure: FailureInfo | undefined): AutoBatchOutcome => {
      activeBatch = undefined
      releaseBatchReservation()
      const code = failure?.code ?? 'unknown'
      if (code === 'timeout' || code === 'bad_output') return failSplittable(batch, code, failure?.retryAfterMs)
      const cancelled = code === 'cancelled'
      const busy = code === 'queue_full' || code === 'queue_paused' || code === 'queue_timeout'
      // 后台重启不是请求失败：不计尝试次数；发送消息会唤醒后台，退避后重发。额度用尽才说明后台确实回不来了。
      const restarting = code === 'disconnected'
      if (restarting) {
        restartRetries += 1
        if (restartRetries > MAX_RESTART_RETRIES) return pausePage()
      } else if (!cancelled && !busy) {
        retryFailures += 1
        if (!isTransientFailure(code) || retryFailures >= MAX_ATTEMPTS) return pausePage()
      }
      let delay = CANCELLED_REQUEUE_MS
      if (restarting) {
        delay = Math.max(MIN_BUSY_RETRY_MS, backoffDelayMs(restartRetries, random))
      } else if (!cancelled) {
        if (busy) busyRetries += 1
        delay =
          failure?.retryAfterMs ??
          (busy ? Math.max(MIN_BUSY_RETRY_MS, backoffDelayMs(busyRetries, random)) : backoffDelayMs(retryFailures, random))
      }
      notBefore = Date.now() + Math.min(delay, MAX_RETRY_AFTER_MS)
      releaseCharacterCap()
      if (!batch.isSub) requeueEntries(texts.flatMap((request) => grouped.get(request) ?? []))
      else if (!capped) splitQueue.unshift(batch)
      scheduleFlush()
      return cancelled ? 'dropped' : 'retrying'
    }
    const complete: AutoBatchApply = (results, failure, cachedChars = 0) => {
      if (settled || disposed || suspended || activeBatch !== ticket || generation !== gen || pageIdentity(location.href) !== href) {
        return 'stale'
      }
      settled = true
      if (results === undefined) return fail(failure)
      const work: { entry: AutoEntry; translated: string }[] = []
      const bad: string[] = []
      texts.forEach((request, index) => {
        const translated = results[index]
        if (translated === undefined || translated.trim() === '') {
          bad.push(request)
          return
        }
        for (const entry of grouped.get(request) ?? []) {
          work.push({ entry, translated })
        }
      })
      if (bad.length === texts.length) return fail({ code: 'bad_output' })
      reservedChars = 0
      retryFailures = 0
      busyRetries = 0
      restartRetries = 0
      failedStreak = 0
      batch.lineage.succeeded = true
      batchCharLimit = Math.min(MAX_BATCH_CHARS, batchCharLimit + BATCH_CHARS_GROWTH)
      const badChars = bad.reduce((sum, request) => sum + request.length, 0)
      const refund = badChars + Math.min(cachedChars, chars - badChars)
      spent -= refund
      if (refund > 0 && bad.length === 0) releaseCharacterCap()
      if (bad.length > 0) {
        const tries = batch.tries + 1
        const remainder = subBatch(batch, bad, tries)
        if (bad.length === 1 && tries >= MAX_BAD_OUTPUT_TRIES) markItemsFailed(remainder)
        else queueSubBatches(remainder, [remainder])
        releaseCharacterCap()
      }
      let cursor = 0
      const applyChunk = (): void => {
        if (disposed || suspended || activeBatch !== ticket || generation !== gen || pageIdentity(location.href) !== href) return
        let attempted = 0
        const started = performance.now()
        while (cursor < work.length && attempted < 20 && performance.now() - started < 8) {
          const item = work[cursor]
          cursor += 1
          if (item === undefined) continue
          const { entry } = item
          const translated = collectChunk(entry, item.translated)
          if (translated === undefined) continue
          if (entry.unit !== undefined) {
            const unit = entry.unit
            attempted += 1
            const fallback = (): void => {
              clearUnit(entry)
              if (capped) return
              for (const member of unit.nodes) {
                unitFallback.add(member)
                queueAuto(member)
              }
            }
            if (!unitCurrent(unit)) {
              // 快照失效：丢弃结果，但 block 仍在且活动则重扫重译
              clearUnit(entry)
              if (unit.block.isConnected && autoActive()) scanner.queue(unit.block)
              continue
            }
            const segments = parseInlineResult(translated, unit)
            if (segments === undefined) {
              fallback()
              continue
            }
            if (unit.nodes.length > recordBudget - trackedCount()) {
              // 记录余位不足：不写入、不封顶，退到逐节点路径由普通节点逻辑在真正用满时封顶
              fallback()
              continue
            }
            const changes = unit.nodes.map((member, i) => {
              const source = unit.sources[i]!
              const lead = source.slice(0, source.length - source.trimStart().length)
              const trail = source.slice(source.trimEnd().length)
              return { node: member, source, translated: `${lead}${segments[i]!}${trail}` }
            })
            const flags = tryReplaceTexts(changes)
            if (flags.every(Boolean)) {
              changes.forEach((change) => rememberWrite({ node: change.node, source: change.source, translated: change.translated }))
            } else {
              // 任一成员写回失败：整单元回滚；不写 failedItems，成员退到逐节点路径
              changes.forEach((change, i) => {
                if (flags[i] === true) {
                  rememberWrite({ node: change.node, source: change.source, translated: change.translated })
                  restoreNode(change.node)
                }
              })
              fallback()
              continue
            }
            clearUnit(entry)
            continue
          }
          if (!entry.node.isConnected || textValue(entry.node) !== entry.source) continue
          const parent = entry.node.parentElement
          if (parent === null || isExcludedElement(parent) || !isVisible(parent)) continue
          attempted += 1
          const append = entry.append
          if (append !== undefined) {
            const added = entry.source.slice(append.applied.length)
            const trail = added.slice(added.trimEnd().length)
            // 恢复原文时还原整段：已译前缀的原文接上新增原文
            if (writeNode(entry.node, entry.source, `${append.applied}${translated}${trail}`) > 0) {
              const record = records.get(entry.node)
              if (record !== undefined) record.original = `${append.original}${added}`
              appendedTails.delete(entry.node)
            }
            continue
          }
          const lead = entry.source.slice(0, entry.source.length - entry.source.trimStart().length)
          const trail = entry.source.slice(entry.source.trimEnd().length)
          writeNode(entry.node, entry.source, `${lead}${translated}${trail}`)
        }
        if (cursor < work.length) {
          applyTimer = setTimeout(applyChunk, 0)
          return
        }
        activeBatch = undefined
        if (pendingOverflow && pending.size <= MAX_PENDING / 2) {
          pendingOverflow = false
          if (document.body !== null) scanner.queue(document.body)
        }
        if (pending.size > 0 || splitQueue.length > 0) scheduleFlush()
      }
      applyChunk()
      return 'applied'
    }
    try {
      options.onAutoBatch(texts, complete)
    } catch {
      complete(undefined)
    }
  }

  const scanner: DomScanner = createDomScanner({
    flushWrites: flushFixedWrites,
    visitText(node) {
      if (disposed || suspended) return 0
      if (!node.isConnected) return 0
      const failedSource = failedItems.get(node)
      if (failedSource !== undefined && failedSource !== textValue(node)) {
        failedItems.delete(node)
        releaseRecordCap()
        options.onFailedChanged?.()
      }
      if (applyFixedText(node) > 0) return 1
      const record = records.get(node)
      if (record !== undefined && textValue(node) !== record.applied) {
        forgetNode(node)
        queueAuto(node)
        return 0
      }
      queueAuto(node)
      return 0
    },
    visitElement(node) {
      if (disposed || suspended) return 0
      if (!node.isConnected) return 0
      // 发现的 open shadow root 同样进 MutationObserver；host 排除时不进（walker 已挡）
      const shadow = node.shadowRoot
      if (shadow !== null && !isExcludedElement(node) && !observedShadows.has(shadow)) {
        observedShadows.add(shadow)
        observer.observe(shadow, OBSERVER_INIT)
      }
      return applyFixedAttributes(node)
    },
  })

  function isOwnTextWrite(node: Text): boolean {
    const record = records.get(node)
    return record !== undefined && textValue(node) === record.applied
  }

  function* cleanupRecords(): Generator<void> {
    if (pruneFailed()) options.onFailedChanged?.()
    for (const node of modifiedTexts) {
      const record = records.get(node)
      if (!node.isConnected) {
        if (record !== undefined && textValue(node) === record.applied) node.nodeValue = record.original
        forgetNode(node)
      } else if (record === undefined || textValue(node) !== record.applied) {
        forgetNode(node)
      }
      releaseRecordCap()
      yield
    }
    for (const element of modifiedElements) {
      releaseStaleAttributes(element)
      if (!element.isConnected) {
        for (const [name, record] of attrRecords.get(element) ?? []) {
          if (element.getAttribute(name) === record.applied) element.setAttribute(name, record.original)
        }
        modifiedElements.delete(element)
        attrRecords.delete(element)
      }
      releaseRecordCap()
      yield
    }
    for (const node of deferred.keys()) {
      const parent = deferred.get(node)
      if (parent === undefined) continue
      if (!node.isConnected || !parent.isConnected) {
        dropEntry(node)
      } else if (node.parentElement !== parent) {
        dropEntry(node)
        queueAuto(node)
      }
      yield
    }
    for (const entry of pending.values()) {
      if (!entry.node.isConnected) dropEntry(entry.node)
      else if (entry.unit !== undefined ? !unitCurrent(entry.unit) : entry.node.parentElement !== entry.parent) {
        // 单元用快照判断（锚点可在行内元素内）；失效后重扫整块重建而不是只重排锚点
        const block = entry.unit?.block
        dropEntry(entry.node)
        if (block !== undefined && block.isConnected) scanner.queue(block)
        else queueAuto(entry.node)
      }
      yield
    }
  }

  function scheduleCleanup(): void {
    if (suspended || disposed) return
    if (cleanupTimer !== undefined) {
      cleanupAgain = true
      return
    }
    const work = cleanupRecords()
    const step = (): void => {
      cleanupTimer = undefined
      if (suspended || disposed) return
      const started = performance.now()
      let visited = 0
      do {
        if (work.next().done) {
          if (cleanupAgain) {
            cleanupAgain = false
            scheduleCleanup()
          }
          return
        }
        visited += 1
      } while (visited < 100 && performance.now() - started < 4)
      cleanupTimer = setTimeout(step, 0)
    }
    cleanupTimer = setTimeout(step, 0)
  }

  const OBSERVER_INIT: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTR_WATCH, ...FIXED_ATTRIBUTES],
  }
  let observedShadows = new WeakSet<ShadowRoot>()
  const observer = new MutationObserver((mutations) => {
    if (pageIdentity(location.href) !== lastLocation) onNavigation()
    if (suspended || disposed) return
    const roots = new Set<Node>()
    let removed = false
    let inspected = 0
    const started = performance.now()
    const fullScan = (): void => {
      removed = true
      roots.clear()
      if (document.body !== null) roots.add(document.body)
    }
    mutationLoop:
    for (const mutation of mutations) {
      if (++inspected > 200 || performance.now() - started >= 4) {
        fullScan()
        break
      }
      if (mutation.type === 'childList') {
        removed ||= mutation.removedNodes.length > 0
        for (const added of mutation.addedNodes) {
          if (++inspected > 200 || performance.now() - started >= 4) {
            fullScan()
            break mutationLoop
          }
          if (!rootsContain(roots, added)) roots.add(added)
        }
      } else if (mutation.type === 'characterData' && mutation.target instanceof Text) {
        const node = mutation.target
        if (isOwnTextWrite(node)) continue
        const record = records.get(node)
        if (record !== undefined) {
          // 诗歌逐句出现、聊天回复逐字输出：网站在译文后面接着写原文
          const value = textValue(node)
          if (value.length > record.applied.length && value.startsWith(record.applied)) {
            appendedTails.set(node, { applied: record.applied, original: record.original })
          } else {
            appendedTails.delete(node)
          }
          forgetNode(node)
        }
        if (!rootsContain(roots, node)) roots.add(node)
      } else if (mutation.type === 'attributes' && mutation.target instanceof Element) {
        const element = mutation.target
        if (mutation.attributeName !== null && FIXED_ATTRIBUTES.includes(mutation.attributeName)) {
          const record = attrRecords.get(element)?.get(mutation.attributeName)
          if (record !== undefined && element.getAttribute(mutation.attributeName) === record.applied) continue
          releaseStaleAttributes(element)
        }
        if (!rootsContain(roots, element)) roots.add(element)
      }
    }
    if (removed) scheduleCleanup()
    for (const root of roots) {
      if (root instanceof Element && root.closest('[data-wt-root]') !== null) continue
      if (root instanceof Element && isExcludedElement(root) && !canTranslateFixedFormAttributes(root)) continue
      scanner.queue(root)
    }
  })

  const observerIo =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const parent = entry.target
            if (entry.isIntersecting) {
              if (viewportPending.has(parent)) {
                intersectingDeferred.add(parent)
                scanner.queue(parent)
              }
            } else {
              intersectingDeferred.delete(parent)
            }
          }
          scheduleVisibilityRecheck()
        })
      : undefined

  function autoActive(): boolean {
    return !disposed && !suspended && !capped && !autoPaused && options.autoEnabled()
  }

  function scheduleVisibilityRecheck(): void {
    if (visibilityTimer !== undefined || intersectingDeferred.size === 0 || !autoActive()) return
    visibilityTimer = setTimeout(() => {
      visibilityTimer = undefined
      if (!autoActive()) return
      for (const parent of intersectingDeferred) {
        if (viewportPending.has(parent)) scanner.queue(parent)
      }
    }, VISIBILITY_RETRY_MS)
  }

  function scheduleViewportScan(): void {
    if (viewportTimer !== undefined || !autoActive()) return
    if (!observationOverflow && !(observerIo === undefined && deferred.size > 0)) return
    viewportTimer = setTimeout(() => {
      viewportTimer = undefined
      if (autoActive() && document.body !== null) scanner.queue(document.body)
    }, VIEWPORT_SCAN_MS)
  }

  function revealTarget(target: EventTarget | null, force = false): void {
    if (!(target instanceof Element) || !autoActive()) return
    if (target.closest('[data-wt-root]') !== null || isExcludedElement(target)) return
    if (force || observationOverflow) {
      const container = force
        ? target
        : (target.closest('button,a,[role="button"]')?.parentElement ?? target.parentElement ?? target)
      if (container instanceof Element && container.closest('[data-wt-root]') === null && !isExcludedElement(container)) {
        scanner.queue(container)
      }
    } else {
      scanner.queue(target)
    }
    scheduleVisibilityRecheck()
  }

  const onScroll = (): void => {
    scheduleViewportScan()
  }
  const onReveal = (event: Event): void => {
    revealTarget(event.target)
  }
  const onToggle = (event: Event): void => {
    revealTarget(event.target, true)
  }
  const onHint = (event: Event): void => {
    if (!(event.target instanceof Element) || !autoActive()) return
    if (observationOverflow) {
      const container = event.target.closest('button,a,[role="button"]')?.parentElement ?? event.target.parentElement ?? event.target
      if (container instanceof Element && container.closest('[data-wt-root]') === null && !isExcludedElement(container)) {
        scanner.queue(container)
      }
    }
    scheduleVisibilityRecheck()
  }

  function rootsContain(roots: Set<Node>, node: Node): boolean {
    let current: Node | null = node
    while (current !== null) {
      if (roots.has(current)) return true
      current = current.parentNode
    }
    return false
  }

  function onNavigation(): void {
    lastLocation = pageIdentity(location.href)
    releaseBatchReservation()
    spent = 0
    budgetShares = 1
    capped = false
    capReason = undefined
    cappedNotified = false
    autoPaused = false
    invalidateLayout()
    stopPending()
  }

  function stopPending(): void {
    generation += 1
    fixedWrites.clear()
    recordCapDeferred = false
    const released = releaseBatchReservation()
    activeBatch = undefined
    notBefore = 0
    retryFailures = 0
    busyRetries = 0
    restartRetries = 0
    failedStreak = 0
    scanner.cancel()
    if (cleanupTimer !== undefined) {
      clearTimeout(cleanupTimer)
      cleanupTimer = undefined
    }
    cleanupAgain = false
    if (applyTimer !== undefined) {
      clearTimeout(applyTimer)
      applyTimer = undefined
    }
    clearPending()
    clearFailed()
    if (released) releaseCharacterCap()
  }

  function restoreNode(node: Text): void {
    const record = records.get(node)
    if (record !== undefined && textValue(node) === record.applied) {
      node.nodeValue = record.original
    }
    forgetNode(node)
  }

  function restore(): void {
    suspended = true
    observer.disconnect()
    observedShadows = new WeakSet()
    stopPending()
    for (const node of modifiedTexts) {
      restoreNode(node)
    }
    for (const element of modifiedElements) {
      const map = attrRecords.get(element)
      if (map !== undefined) {
        for (const [name, record] of map) {
          if (element.getAttribute(name) === record.applied) {
            element.setAttribute(name, record.original)
          }
        }
      }
      attrRecords.delete(element)
    }
    modifiedTexts.clear()
    modifiedElements.clear()
    releaseRecordCap()
  }

  const onResize = (): void => {
    invalidateLayout()
    if (resizeTimer !== undefined || suspended || disposed || document.body === null) return
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      if (!suspended && !disposed) scanner.queue(document.body)
    }, RESIZE_SCAN_MS)
  }

  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('toggle', onToggle, true)
  document.addEventListener('transitionend', onReveal, true)
  document.addEventListener('animationend', onReveal, true)
  document.addEventListener('pointerover', onHint, true)
  document.addEventListener('focusin', onHint, true)

  return {
    start() {
      if (disposed || document.body === null) return
      if (pageIdentity(location.href) !== lastLocation) onNavigation()
      if (!suspended) {
        scanner.queue(document.body)
        return
      }
      suspended = false
      stopPending()
      observer.observe(document.documentElement, OBSERVER_INIT)
      scanner.queue(document.body)
    },
    stop() {
      restore()
    },
    restore,
    dispose() {
      if (disposed) return
      restore()
      disposed = true
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('toggle', onToggle, true)
      document.removeEventListener('transitionend', onReveal, true)
      document.removeEventListener('animationend', onReveal, true)
      document.removeEventListener('pointerover', onHint, true)
      document.removeEventListener('focusin', onHint, true)
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      modifiedTexts.clear()
      modifiedElements.clear()
    },
    invalidate() {
      stopPending()
    },
    pauseAuto() {
      autoPaused = true
      const released = releaseBatchReservation()
      activeBatch = undefined
      clearPending()
      if (released) releaseCharacterCap()
    },
    resumeAuto() {
      autoPaused = false
      notBefore = 0
      retryFailures = 0
      busyRetries = 0
      restartRetries = 0
      failedStreak = 0
      clearFailed()
      if (!capped && !suspended && !disposed && document.body !== null) scanner.queue(document.body)
    },
    isAutoPaused() {
      return autoPaused
    },
    isCapped() {
      return capped
    },
    isBudgetCapped() {
      return capped && capReason === 'characters'
    },
    extendBudget() {
      if (!capped || capReason !== 'characters') return false
      budgetShares += 1
      releaseCharacterCap()
      return true
    },
    budgetChanged() {
      releaseCharacterCap()
    },
    resetBudget() {
      stopPending()
      spent = 0
      budgetShares = 1
      if (capReason === 'characters') {
        capped = false
        capReason = undefined
      }
      cappedNotified = capped
    },
    failedCount() {
      pruneFailed()
      return failedItems.size
    },
    retryFailed() {
      if (!autoActive()) return false
      const nodes = [...failedItems.keys()]
      failedStreak = 0
      clearFailed()
      for (const node of nodes) queueAuto(node)
      return true
    },
  }
}
