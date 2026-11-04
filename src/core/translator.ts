/**
 * 翻译引擎：把页面界面文字替换为译文，并与 React 共存。
 *
 * 与 React 共存的约束：
 * - 只改 Text.data 与属性值，绝不插入、删除、替换、包裹节点（React 之后的 removeChild / insertBefore 依赖原节点）。
 * - React 重渲染会把英文写回：按记录区分自身写入与外部改写，外部改写后以新内容为原文重译。
 * - 相邻文本节点（中间只隔注释）先拼接整体匹配，命中则译文写入第一个节点、其余置空（不删除）。
 * - 被 <kbd> 拆开的句子整句匹配，译文按 kbd 文字切分后写回各段文字（见 inline.ts）。
 *
 * 遍历：TreeWalker + FILTER_REJECT 跳过忽略区域；变动根节点按父元素判断祖先，同一批变动内同一父元素只判断一次。
 * 忽略区域内的重新进入区域（REENTRY_SELECTORS）：遍历后只在被拒的忽略区域里按容器类名查找，再单独遍历；
 * 纯代码容器、跳过标签内不查。
 * 忽略区域里只有两类文字照常翻译：占位文字（PLACEHOLDER_TEXTS）与名称区域（LABEL_SELECTORS）里的默认标签名、说明和预置列表名
 * （语言包的名称表、说明表与标签正则、预置列表名表，名称区域、说明区域、星标列表名称区域分开匹配），
 * 都只在最外层的忽略区域根上判断。
 * 一轮（一次全量遍历或一批变动）内同一文本节点的原文只取一次（取原文有副作用，见 records.ts）；
 * 一轮结束时，统一处理行内元素旁的孤立标点与全角标点两侧的空白（见 fit.ts）。
 * 时间元素：设 lang、prefix、hour-cycle，由元素自己渲染中文；渲染出的文字与 title 在中文与数字之间补空格（见 time-text.ts）。
 * hour-cycle 取翻译语言的默认小时制（zh-TW 12 小时制，zh-CN 24 小时制）：元素没有 hour-cycle 时按浏览器默认语言取，
 * 与词典按翻译语言生成的时刻会不一致。
 */
import {
  CLASSIC_PREVIEW_SELECTOR,
  CODE_CONTAINER_SELECTORS,
  EXIT_ATTRIBUTES,
  EXIT_SELECTORS,
  IGNORE_SELECTORS,
  IGNORE_TAGS,
  LABEL_DESCRIPTION_SELECTORS,
  LABEL_SELECTORS,
  LIST_NAME_SELECTORS,
  MIRROR_ATTRIBUTES,
  MIRROR_SELECTOR,
  PLACEHOLDER_SELECTOR,
  PLACEHOLDER_TEXTS,
  REENTRY_CONTAINER_CLASS,
  REENTRY_SELECTORS,
  SKIP_TAG_RELEASE_SELECTORS,
  TRANSLATABLE_ATTRIBUTES,
} from './ignore'
import {
  ELEMENT_NODE,
  FILTER_ACCEPT,
  FILTER_REJECT,
  SHOW_ELEMENT,
  SHOW_TEXT,
  TEXT_NODE,
  TIME_TAGS,
  childTexts,
  isRunNode,
  isTextNode,
  textRun,
  titleElement,
} from './dom'
import { createTextFit, SPACE_ONLY_RE } from './fit'
import { besideKbd, createInlineFragments, isFullPunct, isHalfPunct, isKbd, kbdNeighbor, kbdSpans, sentenceOf } from './inline'
import { normalizeText, type Matcher } from './matcher'
import { detectPages } from './page'
import { createPositionMemo } from './position-memo'
import { CONTESTED, createRecordStore, type Contested } from './records'
import { textOwnership } from '../shared/text-ownership'
import {
  attributeMatches,
  compileIgnoreIndex,
  elementMatches,
  safeMatches,
  splitSelectorList,
  tagMatches,
  type IgnoreIndex,
} from './selectors'
import {
  applyAttributeRules,
  compileAttributeRules,
  EMPTY_ATTRIBUTE_RULES,
  isButtonInput,
  type AttributeRuleSet,
} from './attribute-rules'
import { createTimeText } from './time-text'
import { translateTitleText } from './title'
import type { LabelPart, PageKey } from './types'
import { createUntranslatedBuffer, isSensitivePath, type UntranslatedDelta } from './untranslated'

export interface TranslatorFeatures {
  /** <relative-time> 等时间元素改用中文格式 */
  readonly translateTime: boolean
  /** 翻译标签页标题 */
  readonly translateTitle: boolean
  /** 收集未翻译文本（诊断用，仅测试启用，见 core/untranslated） */
  readonly collectUntranslated: boolean
}

/** 引擎依赖的全局对象（内容脚本中即 globalThis） */
export interface TranslatorHost {
  readonly document: Document
  readonly location: Location
  readonly MutationObserver: typeof MutationObserver
  readonly performance?: { now(): number }
}

export interface TranslatorOptions extends Partial<TranslatorFeatures> {
  readonly matcher: Matcher
  readonly host?: TranslatorHost
  /** 由当前地址推断页面类型；默认 detectPages */
  readonly resolvePages?: (location: Location) => readonly PageKey[]
  /** 检测到地址变化时调用（在重新计算页面类型之前；可在其中 stop） */
  readonly onLocationChange?: (href: string) => void
  /** 待取出的未翻译条目上限 */
  readonly maxUntranslated?: number
  /** 时间元素（<relative-time> 等）渲染所用的 lang；默认 TIME_LANG。元素的 hour-cycle 取这个语言的默认小时制 */
  readonly timeLang?: string
}

export interface Translator {
  readonly active: boolean
  /** 当前页面类型 */
  readonly pages: readonly PageKey[]
  readonly features: TranslatorFeatures
  /** 变动回调次数（诊断用） */
  readonly batches: number
  /** 全量翻译并开始观察 */
  start(): void
  /** 断开观察并还原全部文本、属性、标题、时间元素属性 */
  stop(): void
  /** 更换匹配器（自定义词条变化）：基于原文重译 */
  setMatcher(matcher: Matcher): void
  /** 更换语言：匹配器与时间元素的 lang、hour-cycle 一并更换，基于原文重译 */
  setLocale(matcher: Matcher, timeLang: string): void
  setFeatures(features: Partial<TranslatorFeatures>): void
  /** 比较地址；页面类型变化时基于原文重译。返回是否已全量重译 */
  checkLocation(): boolean
  /** 立即处理尚未回调的变动 */
  flush(): void
  /** 已翻译的文本节点与属性数 */
  translatedCount(): number
  /** 取出未翻译增量（诊断用） */
  drainUntranslated(): UntranslatedDelta[]
}

/** 时间元素渲染所用 lang 的默认值 */
export const TIME_LANG = 'zh-CN'
const TIME_ATTRIBUTES: readonly string[] = ['lang', 'prefix', 'hour-cycle']
/** relative-time 认可的 hour-cycle 取值，其余按浏览器默认 */
const HOUR_CYCLES: ReadonlySet<string> = new Set(['h11', 'h12', 'h23', 'h24'])

/**
 * 语言的默认小时制，取法与 relative-time 判断浏览器默认相同（hour12 为 true 即 h12，否则 h23）：
 * zh-TW → h12，zh-CN → h23；空数组表示浏览器默认语言。取不到时为 undefined
 */
export function defaultHourCycle(locales: string | readonly string[]): string | undefined {
  try {
    return new Intl.DateTimeFormat(locales as string | string[], { hour: 'numeric' }).resolvedOptions().hour12 === true
      ? 'h12'
      : 'h23'
  } catch {
    return undefined
  }
}
const TIME_SELECTOR = [...TIME_TAGS].join(', ')
const LATIN_RE = /[A-Za-z]/
const NON_SPACE_RE = /\S/

/** 跳过子树的标签（小写）；head 内只有标题需要处理，单独负责 */
const SKIP_TAGS: ReadonlySet<string> = new Set([...[...IGNORE_TAGS].map((tag) => tag.toLowerCase()), 'head'])
const SKIP_TAG_SELECTOR = [...SKIP_TAGS, ...TIME_TAGS].join(', ')
const REENTRY_SELECTOR = REENTRY_SELECTORS.join(', ')
const RELEASE_SELECTOR = SKIP_TAG_RELEASE_SELECTORS.join(', ')
/** 重新进入区域不越过的祖先：跳过标签、时间元素、显式退出标记、纯代码容器 */
const HARD_SKIP_SELECTOR = [SKIP_TAG_SELECTOR, ...EXIT_SELECTORS, ...CODE_CONTAINER_SELECTORS].join(', ')
const EXIT_SELECTOR = EXIT_SELECTORS.join(', ')
const LABEL_SELECTOR = LABEL_SELECTORS.join(', ')
/** 标签区域里逐层包装的层数上限（标签页的标签链接里，文字套在三层元素里） */
const MAX_LABEL_DEPTH = 6
const TRANSLATABLE: ReadonlySet<string> = new Set(TRANSLATABLE_ATTRIBUTES)
/** 合并区域内不能有的元素：链接、按钮、表单控件、时间元素、跳过标签（含 kbd） */
const UNMERGEABLE_TAGS: ReadonlySet<string> = new Set(['a', 'button', 'input', 'select', ...SKIP_TAGS, ...TIME_TAGS])
const MIRROR: ReadonlySet<string> = new Set(MIRROR_ATTRIBUTES)
const OBSERVED_ATTRIBUTES = [
  ...new Set([
    ...TRANSLATABLE_ATTRIBUTES,
    'value',
    // 非按钮 input 不再禁用时还原规则写入的 value
    'disabled',
    ...TIME_ATTRIBUTES,
    ...MIRROR_ATTRIBUTES,
    ...EXIT_ATTRIBUTES,
  ]),
]
const OBSERVE_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: OBSERVED_ATTRIBUTES,
}
/** 依赖子节点、兄弟节点的忽略选择器（:has()、:empty、位置伪类、兄弟组合符）：子节点增删可能让它们改变命中 */
const STRUCTURAL_RE = /:has\(|:empty|-child|-of-type|\+|~(?!=)/

/** 遍历模式：重译时，新命中忽略规则的区域要还原 */
type WalkMode = 'translate' | 'retranslate'

/**
 * 变动根节点的父元素：已被同批的其他根节点包含（covered）、不在跳过区域内（open）、
 * 在跳过区域内且不能重新进入（closed）、在跳过区域内但其中可能有重新进入区域（search）
 */
type ParentState = 'covered' | 'open' | 'closed' | 'search'

/** 非按钮 input 的 value、disabled 变化：交给 syncInputValue（只按属性规则改写 value） */
function isInputValueChange(element: Element, name: string): boolean {
  return (name === 'value' || name === 'disabled') && element.localName === 'input' && !isButtonInput(element)
}

/** 镜像文字属性白名单内的元素 */
function isMirrorElement(element: Element): boolean {
  return MIRROR_ATTRIBUTES.some((name) => element.hasAttribute(name)) && safeMatches(element, MIRROR_SELECTOR)
}

function meaningfulCount(sources: readonly string[]): number {
  let count = 0
  for (const source of sources) if (NON_SPACE_RE.test(source)) count++
  return count
}

/** 跳过标签中按选择器放行的元素 */
function isReleasedTag(element: Element): boolean {
  return RELEASE_SELECTOR !== '' && safeMatches(element, RELEASE_SELECTOR)
}

/** 元素是否是可重新进入的区域 */
function isReentry(element: Element): boolean {
  return safeMatches(element, REENTRY_SELECTOR) && !element.parentElement?.closest(HARD_SKIP_SELECTOR)
}

/** element 自身或祖先中、scope 以内（不含 scope）有无重新进入区域 */
function hasReentryWithin(element: Element, scope: Element): boolean {
  for (let current: Element | null = element; current && current !== scope; current = current.parentElement) {
    if (safeMatches(current, REENTRY_SELECTOR)) return true
  }
  return false
}

/** element.closest；选择器出错（个别引擎对已通过校验的选择器仍可能在匹配时抛错）按未命中处理 */
function closestOf(element: Element, selector: string): Element | null {
  try {
    return element.closest(selector)
  } catch {
    return null
  }
}

function isCovered(element: Element, roots: ReadonlySet<Element>): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (roots.has(current)) return true
  }
  return false
}

/**
 * 区域里唯一的段落（经典评论框预览区的占位段落，不查选择器）：不带属性的 <p>，其余子节点只有空白文字，
 * 段落里只有一个文本节点；否则 null
 */
function soleParagraph(region: Element): Element | null {
  const paragraph = region.firstElementChild
  if (paragraph === null || paragraph !== region.lastElementChild || paragraph.localName !== 'p') return null
  const node = paragraph.firstChild
  if (paragraph.attributes.length > 0 || node === null || node !== paragraph.lastChild || !isTextNode(node)) return null
  for (let child = region.firstChild; child; child = child.nextSibling) {
    if (child !== paragraph && !(isTextNode(child) && !NON_SPACE_RE.test(child.data))) return null
  }
  return paragraph
}

/** 判断占位文字的区域根：元素是区域里唯一的段落时为区域，否则为元素自身 */
function placeholderRegionOf(element: Element): Element {
  const parent = element.localName === 'p' ? element.parentElement : null
  return parent !== null && soleParagraph(parent) === element ? parent : element
}

/**
 * 只有图标的元素：svg，或里面只有图标（svg、只有图标的包装）与空白的元素，如已存档标签令牌里包着存档图标的元素。
 * 标签区域里不算一段文字；图片表情（img）、空元素不是图标，仍算一段
 */
function isIconOnly(element: Element, depth = 0): boolean {
  if (element.localName === 'svg') return true
  if (depth >= MAX_LABEL_DEPTH) return false
  let icon = false
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (isTextNode(child)) {
      if (NON_SPACE_RE.test(child.data)) return false
    } else if (child.nodeType === ELEMENT_NODE) {
      if (!isIconOnly(child as Element, depth + 1)) return false
      icon = true
    }
  }
  return icon
}

export function createTranslator(options: TranslatorOptions): Translator {
  const host = options.host ?? (globalThis as unknown as TranslatorHost)
  const doc = host.document
  const clock = (): number => host.performance?.now() ?? Date.now()
  const resolvePages = (): readonly PageKey[] => (options.resolvePages ?? detectPages)(host.location)
  const records = createRecordStore(clock)
  const ownership = textOwnership()
  const untranslated = createUntranslatedBuffer({ maxPending: options.maxUntranslated })

  let matcher = options.matcher
  let timeLang = options.timeLang ?? TIME_LANG
  /** 各翻译语言的默认小时制（见 defaultHourCycle） */
  const hourCycles = new Map<string, string | undefined>()
  /** 浏览器默认小时制：元素及祖先、<html> 都没有 hour-cycle 时元素按它渲染 */
  let browserHourCycle: string | undefined
  let features: TranslatorFeatures = {
    translateTime: options.translateTime ?? true,
    translateTitle: options.translateTitle ?? true,
    collectUntranslated: options.collectUntranslated ?? false,
  }
  let active = false
  let pages = resolvePages()
  let pagesKey = pages.join('|')
  let lastHref = ''
  let ignore: IgnoreIndex = compileIgnoreIndex([], doc.createElement('div'))
  /** 依赖子节点、兄弟节点的忽略选择器（逗号连接）；没有时为空串 */
  let structuralSelector = ''
  let attributeRules: AttributeRuleSet = EMPTY_ATTRIBUTE_RULES
  /** 整段合并的元素 */
  let mergeIndex: IgnoreIndex = compileIgnoreIndex([], doc.createElement('div'))
  /** 本轮判断过的合并区域：true 表示已整段写入，false 表示不能合并或整段未命中、照常逐组处理 */
  let mergedRegions = new Map<Element, boolean>()
  /** 本轮重新遍历过的合并区域：其中的文字已照常处理 */
  let releasedRegions = new Set<Element>()
  /** 整段写入过的合并区域：不能再合并或整段不再命中时其中的文字要照常重算 */
  let mergedOnce = new WeakSet<Element>()
  /** 本轮已取得的原文：只记取原文有副作用的节点（有记录、当前不是自身写入）；不在一轮中时为 null */
  let roundSources: Map<Text, string | Contested> | null = null
  /** 当前页面范围内有无行内句规则 */
  let inlineEnabled = false
  /** 标签区域的索引（选择器固定）：忽略区域根按特征预判是否标签区域 */
  const labelIndex = compileIgnoreIndex(LABEL_SELECTORS, doc.createElement('div'))
  /** 标签说明区域的索引：文字所在的最内层标签区域是否说明区域（见 labelPartOf） */
  const descriptionIndex = compileIgnoreIndex(LABEL_DESCRIPTION_SELECTORS, doc.createElement('div'))
  /** 星标列表名称区域的索引：文字所在的最内层区域是否列表名（见 labelPartOf） */
  const listIndex = compileIgnoreIndex(LIST_NAME_SELECTORS, doc.createElement('div'))
  /** 匹配器有无名称表、说明表、标签正则或预置列表名表：都没有时不判断标签区域 */
  let labelsEnabled = false
  let skipSelector = SKIP_TAG_SELECTOR
  let observer: MutationObserver | null = null
  let batches = 0
  let textMisses = new WeakMap<Text, string>()
  let attributeMisses = new WeakMap<Element, Map<string, string>>()
  /** 当前地址是否允许收集（令牌、恢复码、账单等页面不收集） */
  let collectHere = true
  /** 在不收集的页面上出现过的节点（不随清空重置） */
  const sensitiveNodes = new WeakSet<Node>()
  /** 遍历中遇到的镜像文字元素：文字处理完后统一同步；不在遍历中时为 null */
  let mirrorPending: Element[] | null = null
  /** 遍历中命中忽略规则被拒的元素：遍历后在其中查找重新进入区域；不在遍历中时为 null */
  let rejectedPending: Element[] | null = null
  /**
   * 时间元素是否位于跳过区域（见 isSkippedElement），供渲染后补空格时判断：补过空格的元素每次定时刷新都派发事件
   * （有不足 1 分钟的时间时每秒一次），逐次按忽略选择器查找祖先开销大，按元素沿用（见 position-memo.ts）。
   * 忽略规则重新编译、页面增删节点或改动观察的属性后作废
   */
  const timePositions = createPositionMemo(isSkippedElement)
  /** 按中文渲染的时间元素（克隆体带着 lang，也算）：渲染后补空格 */
  const timeText = createTimeText(
    doc,
    (element) => features.translateTime && element.getAttribute('lang') === timeLang && !timePositions.get(element),
  )

  function compileIgnore(): void {
    const probe = doc.createElement('div')
    ignore = compileIgnoreIndex([...IGNORE_SELECTORS, ...matcher.ignoreSelectors(pages)], probe)
    skipSelector = ignore.selector ? `${SKIP_TAG_SELECTOR}, ${ignore.selector}` : SKIP_TAG_SELECTOR
    structuralSelector = splitSelectorList(ignore.selector)
      .filter((selector) => STRUCTURAL_RE.test(selector))
      .join(', ')
    attributeRules = compileAttributeRules(matcher.attributeRules(pages), probe)
    mergeIndex = compileIgnoreIndex(matcher.mergeSelectors(pages), probe)
    inlineEnabled = matcher.hasInline(pages)
    labelsEnabled = matcher.hasLabels()
    timePositions.invalidate()
  }

  /** 元素自身或祖先中最近的跳过区域；组合选择器出错时退回只按标签判断 */
  function closestSkipped(element: Element): Element | null {
    for (let current: Element | null = element; current;) {
      let skipped: Element | null
      try {
        skipped = current.closest(skipSelector)
      } catch {
        skipped = current.closest(SKIP_TAG_SELECTOR)
      }
      if (!skipped || !isReleasedSkipTag(skipped)) return skipped
      current = skipped.parentElement
    }
    return null
  }

  /** 放行的跳过标签：自身未命中忽略规则时不算跳过区域，继续向上找 */
  function isReleasedSkipTag(element: Element): boolean {
    return SKIP_TAGS.has(element.localName) && isReleasedTag(element) && !elementMatches(ignore, element)
  }

  /** 元素自身或祖先是否属于跳过区域：最近的跳过区域内有重新进入区域包含元素时不算 */
  function insideSkipped(element: Element): boolean {
    const skipped = closestSkipped(element)
    if (!skipped) return false
    const reentry = element.closest(REENTRY_SELECTOR)
    return !(reentry && reentry !== skipped && skipped.contains(reentry) && isReentry(reentry))
  }

  function translate(source: string): string | undefined {
    return LATIN_RE.test(source) ? matcher.translateRaw(source, pages) : undefined
  }

  // ---------- 未翻译收集 ----------

  /** 最具体的页面类型 */
  function currentPage(): PageKey {
    return pages[pages.length - 1] ?? 'common'
  }

  function shouldCollect(node: Node, source: string): boolean {
    // 不收集的页面上出现过的节点做标记：离开后页面类型变化、重新遍历时也不收集
    if (!collectHere) {
      sensitiveNodes.add(node)
      return false
    }
    return features.collectUntranslated && LATIN_RE.test(source) && !sensitiveNodes.has(node)
  }

  /**
   * 文档内现有的全部节点（含已翻译的、忽略区域内的）记为不收集。
   * 离开不收集的页面时旧 DOM 还在：Turbo 先改地址再换正文，重走旧 DOM 会把该页的文字记到新页面类型下
   */
  function markDocument(): void {
    const root = doc.documentElement
    if (!root) return
    sensitiveNodes.add(root)
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) sensitiveNodes.add(node)
  }

  /** 按当前地址更新收集开关；页面类型不变也要更新（仓库设置在同一帧内导航） */
  function updateCollectHere(): void {
    const next = !isSensitivePath(host.location.pathname)
    if (next && !collectHere) markDocument()
    collectHere = next
  }

  function noteTextMiss(node: Text, source: string): void {
    if (!shouldCollect(node, source)) return
    const text = normalizeText(source)
    if (textMisses.get(node) === text) return
    textMisses.set(node, text)
    untranslated.add(text, 'text', currentPage())
  }

  /**
   * 整句未命中（文本组、kbd 句子）：nodes 为句中全部文本节点，记在第一个上。
   * 任一节点在不收集的页面上出现过时，整句含该页的文字：不记，其余节点一并标记
   */
  function noteRunMiss(nodes: readonly Text[], source: string): void {
    const first = nodes[0]
    if (!first) return
    if (!collectHere || nodes.some((node) => sensitiveNodes.has(node))) {
      for (const node of nodes) sensitiveNodes.add(node)
      return
    }
    noteTextMiss(first, source)
  }

  function noteAttributeMiss(element: Element, name: string, source: string): void {
    if (!shouldCollect(element, source)) return
    const text = normalizeText(source)
    let seen = attributeMisses.get(element)
    if (seen?.get(name) === text) return
    if (!seen) attributeMisses.set(element, (seen = new Map()))
    seen.set(name, text)
    untranslated.add(text, 'attr', currentPage())
  }

  // ---------- 文本 ----------

  /** 全角标点两侧的空白；只有空白的页面文字不在忽略、跳过区域内时才置空 */
  const fitting = createTextFit(records, (node) => node.parentElement !== null && !insideSkipped(node.parentElement))

  /**
   * 文本节点的原文：一轮内同一节点只取一次。没有记录、或当前为自身写入时取原文没有副作用，不必记下；
   * 否则再取会多计一次改回，或在解析器刚追加标点（CONTESTED、记录已改写）后取到追加后的原文
   */
  function sourceOf(node: Text): string | Contested {
    const known = roundSources?.get(node)
    if (known !== undefined) return known
    if (roundSources === null || !records.hasText(node) || records.ownText(node)) return records.textSource(node)
    const source = records.textSource(node)
    roundSources.set(node, source)
    return source
  }

  /**
   * 写入未命中节点的原文（同时清除过期的记录）；已转为全角的孤立标点留给轮末重算；
   * 只有空白的紧邻全角标点时置空（见 fit.ts）
   */
  function restoreSource(node: Text, source: string): void {
    if (isHalfPunct(source) && isFullPunct(node.data) && records.ownText(node)) return
    const desired = SPACE_ONLY_RE.test(source) ? fitting.space(node, source) : source
    if (node.data !== desired || records.hasText(node)) records.writeText(node, source, desired)
  }

  /** 按已取得的原文处理单个文本节点；collect 为 false 时不记未翻译 */
  function applyText(node: Text, source: string | Contested, collect: boolean): void {
    if (source === CONTESTED) return
    const translated = translate(source)
    if (translated !== undefined) {
      records.writeText(node, source, fitting.fit(node, translated))
      return
    }
    restoreSource(node, source)
    if (collect) noteTextMiss(node, source)
  }

  /**
   * 整体匹配：原文都已取得、有意义的文字不少于两段且拼接后命中时，译文写入第一个节点、其余置空，返回 true；
   * 否则不写入
   */
  function applyJoined(nodes: readonly Text[], sources: readonly (string | Contested)[]): boolean {
    if (sources.includes(CONTESTED) || meaningfulCount(sources as string[]) < 2) return false
    const translated = translate((sources as string[]).join(''))
    if (translated === undefined) return false
    nodes.forEach((node, i) =>
      records.writeText(node, sources[i] as string, i === 0 ? fitting.fit(node, translated) : ''),
    )
    return true
  }

  /**
   * 按已取得的原文处理文本组：先整体匹配，未命中再逐个匹配。
   * collect 为 false 时不记未翻译（由调用方记录整句）。
   */
  function applyRun(run: readonly Text[], sources: readonly (string | Contested)[], collect: boolean): void {
    if (run.some(isWebOwned)) return
    if (run.length <= 1) {
      if (run[0]) applyText(run[0], sources[0]!, collect)
      return
    }
    if (applyJoined(run, sources)) return
    const clean = !sources.includes(CONTESTED)
    let hits = 0
    const misses: [Text, string][] = []
    run.forEach((node, i) => {
      const source = sources[i]!
      if (source === CONTESTED) return
      const translated = translate(source)
      if (translated === undefined) {
        restoreSource(node, source)
        misses.push([node, source])
      } else {
        records.writeText(node, source, fitting.fit(node, translated))
        hits++
      }
    })
    if (!collect) return
    if (clean && hits === 0) noteRunMiss(run, (sources as string[]).join(''))
    else for (const [node, source] of misses) noteTextMiss(node, source)
  }

  /** 被 kbd、其他元素拆开的句子，孤立标点 */
  const inline = createInlineFragments({
    records,
    textSource: sourceOf,
    translate,
    fit: (node, translated) => fitting.fit(node, translated),
    applyRun,
    noteRunMiss,
    translateInline: (key) => matcher.translateInline(key, pages),
    inlineEnabled: () => inlineEnabled,
    touch: (node) => fitting.touch(node),
    skipped: (element) => insideSkipped(element),
  })

  function beginRound(): void {
    mergedRegions = new Map()
    releasedRegions = new Set()
    roundSources = new Map()
    inline.beginRound()
    fitting.beginRound()
  }

  function endRound(): void {
    inline.endRound()
    fitting.endRound()
    mergedRegions = new Map()
    releasedRegions = new Set()
    roundSources = null
  }

  // ---------- 整段合并 ----------

  /** 元素自身或祖先中最近的合并区域 */
  function closestMerge(element: Element): Element | null {
    return mergeIndex.selector ? closestOf(element, mergeIndex.selector) : null
  }

  /** 元素自身或祖先中的合并区域，从外到内 */
  function mergeChain(element: Element): Element[] {
    const chain: Element[] = []
    for (
      let region = closestMerge(element);
      region;
      region = region.parentElement && closestMerge(region.parentElement)
    ) {
      chain.unshift(region)
    }
    return chain
  }

  /**
   * 合并区域内的文本节点，按文档顺序；区域自身命中忽略规则、区域内有不能合并的元素（含忽略区域）时返回 undefined
   */
  function mergeTexts(region: Element): Text[] | undefined {
    if (elementMatches(ignore, region)) return undefined
    const texts: Text[] = []
    const walker = doc.createTreeWalker(region, SHOW_ELEMENT | SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === TEXT_NODE) texts.push(node as Text)
      else if (UNMERGEABLE_TAGS.has((node as Element).localName) || elementMatches(ignore, node as Element))
        return undefined
    }
    return texts
  }

  function isWebOwned(node: Text): boolean {
    return ownership.ownerOf(node) === 'web'
  }

  function hasWebOwnedText(root: Node): boolean {
    if (isTextNode(root)) return isWebOwned(root)
    const walker = doc.createTreeWalker(root, SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (isWebOwned(node as Text)) return true
    }
    return false
  }

  function kbdHasWebOwned(parent: Element | null): boolean {
    if (!parent) return false
    return kbdSpans(parent).some(
      (span) => span.groups.some((group) => group.some(isWebOwned)) || span.kbds.some(hasWebOwnedText),
    )
  }

  function sentenceHasWebOwned(parent: Element | null): boolean {
    if (!parent || !inline.maybeSentence(parent)) return false
    const sentence = sentenceOf(parent)
    return (
      sentence !== undefined &&
      (sentence.groups.some((group) => group.some(isWebOwned)) || sentence.slots.some(hasWebOwnedText))
    )
  }

  /**
   * 合并区域：区域内（含后代）的全部文字连成一段匹配（见 applyJoined），命中时译文写入第一个文本节点、其余置空。
   * 每轮每个区域判断一次；返回 false 表示区域内有不能合并的元素或整段未命中，不写入，由遍历照常处理其中的文字。
   * 整段写入时区域及其祖先下的孤立标点轮末重算（区域里的文字可能是外面包着标点的 span 的语境，见 inline.ts）
   */
  function processMerge(region: Element): boolean {
    let merged = mergedRegions.get(region)
    if (merged !== undefined) return merged
    const texts = mergeTexts(region)
    if (texts?.some(isWebOwned)) {
      mergedRegions.set(region, true)
      return true
    }
    merged = texts !== undefined && applyJoined(texts, texts.map(sourceOf))
    mergedRegions.set(region, merged)
    if (merged) {
      mergedOnce.add(region)
      inline.noteRewritten(region)
    }
    return merged
  }

  /**
   * 之前整段写入过、现在不能合并或整段未命中：清除记号，区域内新命中忽略规则的部分还原（整段写入时置空的文字遍历不到）。
   * 返回之前是否整段写入过（其中的文字要照常重算）
   */
  function unmerge(region: Element): boolean {
    if (!mergedOnce.delete(region)) return false
    restoreIgnoredWithin(region)
    return true
  }

  /** 遍历到的合并区域：整段命中时整段处理；否则由遍历照常处理其中的文字 */
  function enterMerge(region: Element): boolean {
    if (processMerge(region)) return true
    unmerge(region)
    return false
  }

  /**
   * element 所在的合并区域，从外到内：第一个整段命中的整段处理；之前整段写入过、现在不能合并或未命中的照常重新遍历
   * 整个区域（每轮一次），其中的合并区域由遍历处理。返回处理过的区域，没有时返回 null
   */
  function handleMerge(element: Element, mode: WalkMode): Element | null {
    for (const region of mergeChain(element)) {
      if (processMerge(region) || releasedRegions.has(region)) return region
      if (!unmerge(region)) continue
      releasedRegions.add(region)
      collecting(mode, () => walkSubtree(region, mode, null))
      return region
    }
    return null
  }

  /**
   * 相邻文本组。紧邻 kbd 的文本组、只有孤立标点的文本组交给 inline 处理。
   * beside 为遍历时已知的「是否紧邻 kbd」。
   */
  function processRun(run: readonly Text[], beside = besideKbd(run)): void {
    const parent = run[0]?.parentElement ?? null
    if (run.some(isWebOwned) || (beside ? kbdHasWebOwned(parent) : sentenceHasWebOwned(parent))) return
    if (inline.claimRun(run, beside)) return
    const single = run.length === 1 ? run[0] : undefined
    if (single) {
      applyText(single, sourceOf(single), true)
      return
    }
    const sources = run.map((node) => sourceOf(node))
    applyRun(run, sources, true)
  }

  // ---------- 属性 ----------

  function translateAttribute(element: Element, name: string, current: string | null): void {
    if (current === null) return
    const source = records.attributeSource(element, name, current)
    if (source === CONTESTED || source === null) return
    // 属性规则命中时不查词典、不记未翻译
    const translated = applyAttributeRules(attributeRules, element, name, source) ?? translate(source)
    if (translated !== undefined || current !== source) {
      records.writeAttribute(element, name, current, source, translated ?? source)
    }
    if (translated === undefined) noteAttributeMiss(element, name, source)
  }

  /**
   * 非按钮 input 的 value：只按属性规则改写（规则只作用于带 disabled 属性的 input，见 attribute-rules），
   * 不查词典、不记未翻译；没有规则命中（含不再禁用）时还原原文
   */
  function syncInputValue(element: Element): void {
    const current = element.getAttribute('value')
    const source = records.attributeSource(element, 'value', current)
    if (source === CONTESTED || source === null) return
    const desired = applyAttributeRules(attributeRules, element, 'value', source) ?? source
    if (desired !== current || desired !== source) records.writeAttribute(element, 'value', current, source, desired)
  }

  /** 非按钮 input 需要 syncInputValue：当前页面有 value 规则，或 value 是此前写入的 */
  function tracksInputValue(element: Element): boolean {
    return attributeRules.has('value') || records.translatedNames(element).includes('value')
  }

  /**
   * 镜像文字属性随元素文字同步（在文字处理之后调用）：
   * 属性原文与直接子文本的原文相同时才处理；写入属性原文的译文，与当前文字不一致时保持当前文字对应的值。
   * 不计入未翻译收集。
   */
  function syncMirror(element: Element): void {
    const texts = childTexts(element)
    const sources: string[] = []
    for (const node of texts) {
      const source = sourceOf(node)
      if (source === CONTESTED) return
      sources.push(source)
    }
    const textSource = normalizeText(sources.join(''))
    const shown = normalizeText(texts.map((node) => node.data).join(''))
    for (const name of MIRROR_ATTRIBUTES) {
      const current = element.getAttribute(name)
      if (current === null) continue
      const source = records.attributeSource(element, name, current)
      if (source === CONTESTED || source === null || normalizeText(source) !== textSource) continue
      const translated = translate(source)
      let desired: string | undefined
      if (translated !== undefined && normalizeText(translated) === shown) desired = translated
      else if (textSource === shown) desired = source
      if (desired !== undefined && (desired !== current || desired !== source)) {
        records.writeAttribute(element, name, current, source, desired)
      }
    }
  }

  /** 强制设置属性（时间元素的 lang / prefix / hour-cycle）；replace 由原值得出新值 */
  function forceAttribute(element: Element, name: string, replace: (source: string | null) => string): void {
    const current = element.getAttribute(name)
    const source = records.attributeSource(element, name, current)
    if (source === CONTESTED) return
    records.writeAttribute(element, name, current, source, replace(source))
  }

  /** relative-time 前缀：缺省为 "on"，中文下会显示成「on 2022年3月8日」，置空；其余（如 "Today at "）查词典 */
  function timePrefix(element: Element, source: string | null): string {
    if (source === null || !source.trim() || source.trim().toLowerCase() === 'on') return ''
    const translated = translate(source)
    if (translated === undefined) noteAttributeMiss(element, 'prefix', source)
    return translated ?? source
  }

  /** 还原时间元素的 lang、prefix、hour-cycle 与改写过的 title */
  function restoreTime(element: Element): void {
    records.restoreAttributes(element, TIME_ATTRIBUTES)
    timeText.restore(element)
  }

  /** 元素按哪个 lang 渲染：自身或最近祖先的 lang（与元素一致，不分大小写） */
  function rendersInTimeLang(element: Element): boolean {
    return (element.closest('[lang]')?.getAttribute('lang') ?? '').toLowerCase() === timeLang.toLowerCase()
  }

  /** 翻译语言的默认小时制；取不到时为 undefined，不设 hour-cycle */
  function timeHourCycle(): string | undefined {
    if (!hourCycles.has(timeLang)) hourCycles.set(timeLang, defaultHourCycle(timeLang))
    return hourCycles.get(timeLang)
  }

  /** 元素按哪种小时制渲染：自身或最近祖先、<html> 的 hour-cycle，都没有（或不认可）时按浏览器默认（与元素的取法一致） */
  function hourCycleOf(element: Element): string {
    const value =
      element.closest('[hour-cycle]')?.getAttribute('hour-cycle') || doc.documentElement.getAttribute('hour-cycle')
    if (value && HOUR_CYCLES.has(value)) return value
    browserHourCycle ??= defaultHourCycle([]) ?? 'h23'
    return browserHourCycle
  }

  function processTime(element: Element): void {
    if (!features.translateTime) {
      restoreTime(element)
      return
    }
    const cycle = timeHourCycle()
    const langMatches = rendersInTimeLang(element)
    const unchanged = langMatches && (cycle === undefined || hourCycleOf(element) === cycle)
    // lang 或小时制将要变化（页面自设了别的中文 lang、切换了翻译语言、浏览器默认小时制与翻译语言不同等）：
    // 按原来的 lang、小时制生成或改写的 title 元素当作自定义值保留，先移除，元素按新的设置重新生成，渲染后在事件中补空格
    if (!unchanged) timeText.reset(element)
    forceAttribute(element, 'lang', () => timeLang)
    if (cycle !== undefined) forceAttribute(element, 'hour-cycle', () => cycle)
    if (element.localName === 'relative-time') {
      forceAttribute(element, 'prefix', (source) => timePrefix(element, source))
    }
    if (element.getAttribute('lang') !== timeLang) return
    // 原本就按 timeLang 与其小时制渲染时元素不会重新渲染：当前文字与 title 立即补空格
    if (unchanged) timeText.sync(element)
    // 只有小时制要变：元素重新渲染，但相对时间的文字不变，title 是页面自定义值时也不变，不会派发事件；
    // 文字先补空格（元素渲染时发现文字不同会写回并派发事件，事件中再补），title 留给渲染后的事件
    else if (langMatches) timeText.syncText(element)
  }

  // ---------- 遍历 ----------

  /** 判断元素并处理其属性；返回 FILTER_REJECT 表示跳过子树 */
  function inspect(element: Element, mode: WalkMode): number {
    const localName = element.localName
    const attributes = element.attributes
    let ignored = tagMatches(ignore, element, localName)
    let found: string[] | undefined
    let mirrored = false
    for (let i = 0; i < attributes.length; i++) {
      const attribute = attributes[i]!
      const name = attribute.name
      if (!ignored && attributeMatches(ignore, element, name, attribute.value)) ignored = true
      if (TRANSLATABLE.has(name)) (found ??= []).push(name, attribute.value)
      else if (MIRROR.has(name)) mirrored = true
    }
    if (ignored) {
      if (mode === 'retranslate') restoreSubtree(element)
      applyRootRules(element)
      const placeholder = placeholderNode(element)
      if (placeholder) translatePlaceholder(placeholder)
      // 遍历走到的忽略区域根都是最外层的：命中标签区域时其中的默认标签照常翻译
      if (labelsEnabled && elementMatches(labelIndex, element)) translateLabelRoot(element)
      rejectedPending?.push(element)
      return FILTER_REJECT
    }
    if (TIME_TAGS.has(localName)) {
      processTime(element)
      return FILTER_REJECT
    }
    if (found) {
      for (let i = 0; i < found.length; i += 2) translateAttribute(element, found[i]!, found[i + 1]!)
    }
    if (localName === 'input') {
      if (isButtonInput(element)) translateAttribute(element, 'value', element.getAttribute('value'))
      else if (tracksInputValue(element)) syncInputValue(element)
    }
    if (mirrored && mirrorPending && isMirrorElement(element)) mirrorPending.push(element)
    return SKIP_TAGS.has(localName) && !isReleasedTag(element) ? FILTER_REJECT : FILTER_ACCEPT
  }

  /**
   * 遍历 root 及其中被跳过的重新进入区域；inSkipped 为 true 时 root 位于跳过区域内，只遍历后者。
   * 只在遍历中被拒的忽略区域里查找；遍历重新进入区域时再被拒的区域追加在后面，一并查找。
   */
  function walk(root: Element, mode: WalkMode, inSkipped = false): void {
    collecting(mode, () => {
      if (inSkipped) walkReentries(root, mode)
      else walkTree(root, mode)
    })
  }

  /**
   * 执行遍历：遍历到的镜像文字元素、被拒的忽略区域在结束后统一处理。
   * 已在遍历中时（遍历中重新遍历合并区域）并入外层，由外层统一处理
   */
  function collecting(mode: WalkMode, task: () => void): void {
    if (mirrorPending !== null) {
      task()
      return
    }
    const mirrors: Element[] = []
    const rejected: Element[] = []
    mirrorPending = mirrors
    rejectedPending = rejected
    try {
      task()
      for (let i = 0; i < rejected.length; i++) walkReentries(rejected[i]!, mode)
    } finally {
      mirrorPending = null
      rejectedPending = null
    }
    for (const element of mirrors) syncMirror(element)
  }

  /**
   * 遍历 scope 内的重新进入区域。scope 为被拒的忽略区域，或位于跳过区域内的变动根节点（自身不是重新进入区域）。
   * 容器自身或其在 scope 内的祖先是重新进入区域时跳过：其子元素随该区域遍历，或在该区域内被拒的区域里另行查找。
   */
  function walkReentries(scope: Element, mode: WalkMode): void {
    // scope 自身是纯代码容器、显式退出标记等时，其中的区域都不能重新进入
    if (!scope.firstElementChild || safeMatches(scope, HARD_SKIP_SELECTOR)) return
    const targets: Element[] = []
    const collect = (container: Element): void => {
      if (hasReentryWithin(container, scope)) return
      for (let child = container.firstElementChild; child; child = child.nextElementSibling) {
        if (isReentry(child)) targets.push(child)
      }
    }
    if (scope.classList.contains(REENTRY_CONTAINER_CLASS)) collect(scope)
    for (const container of scope.getElementsByClassName(REENTRY_CONTAINER_CLASS)) collect(container)
    for (const target of targets) walkTree(target, mode)
  }

  /** 遍历 root：位于合并区域内时先按区域处理（见 handleMerge） */
  function walkTree(root: Element, mode: WalkMode): void {
    const region = handleMerge(root, mode)
    if (region === null || !releasedRegions.has(region)) {
      walkSubtree(root, mode, region)
      return
    }
    // 所在区域本轮已重新遍历：根已随区域处理。根在区域内被拒的忽略区域里（其中的重新进入区域）时，
    // 该忽略区域可能已查找过，照常遍历（同一轮重复处理结果不变）
    if (ignoredBetween(root, region)) walkSubtree(root, mode, null)
  }

  /** root 与包含它的 region 之间（都不含）有无命中忽略规则的元素 */
  function ignoredBetween(root: Element, region: Element): boolean {
    if (root === region) return false
    for (let current = root.parentElement; current && current !== region; current = current.parentElement) {
      if (elementMatches(ignore, current)) return true
    }
    return false
  }

  /** 遍历 root 的子树；merged 为已整段处理的合并区域，其中的文字不再组成文本组 */
  function walkSubtree(root: Element, mode: WalkMode, merged: Element | null): void {
    if (inspect(root, mode) === FILTER_REJECT) return
    /** 当前所在的合并区域：其中的文字已整段处理，不再组成文本组 */
    let merging = merged
    let run: Text[] = []
    /** 当前文本组紧跟在同一父元素下的 kbd 之后 */
    let runAfterKbd = false
    /** 最近经过的元素：按文档顺序，它之后、下一个元素之前的文本与它相邻（中间只可能隔注释） */
    let lastElement = null as Element | null
    const flush = (next: Element | null): void => {
      if (run.length === 0) return
      const current = run
      run = []
      processRun(current, runAfterKbd || (isKbd(next) && next.parentNode === current[0]!.parentNode))
    }
    const filter = (node: Node): number => {
      if (node.nodeType === TEXT_NODE) return FILTER_ACCEPT
      const element = node as Element
      flush(element)
      lastElement = element
      const result = inspect(element, mode)
      if (
        result === FILTER_ACCEPT &&
        mergeIndex.selector &&
        !merging?.contains(element) &&
        elementMatches(mergeIndex, element) &&
        enterMerge(element)
      ) {
        merging = element
      }
      return result
    }
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, filter)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType !== TEXT_NODE || merging?.contains(node)) continue
      if (run.length > 0 && run[0]!.parentNode !== node.parentNode) flush(null)
      if (run.length === 0) runAfterKbd = isKbd(lastElement) && lastElement.parentNode === node.parentNode
      run.push(node as Text)
    }
    flush(null)
  }

  function walkDocument(mode: WalkMode): void {
    const root = doc.documentElement
    if (!root) return
    beginRound()
    walk(root, mode)
    endRound()
  }

  function restoreElement(element: Element): void {
    records.restoreAttributes(element)
    if (TIME_TAGS.has(element.localName)) timeText.restore(element)
  }

  /** 不论忽略规则，还原子树内全部记录 */
  function restoreSubtree(root: Element): void {
    restoreElement(root)
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === TEXT_NODE) records.restoreText(node as Text)
      else restoreElement(node as Element)
    }
  }

  // ---------- 标题 ----------

  function syncTitle(): void {
    const title = titleElement(doc)
    if (!title) return
    const texts = childTexts(title)
    if (texts.length === 0) return
    const sources = texts.map((node) => records.textSource(node))
    if (sources.includes(CONTESTED)) return
    const originals = sources as string[]
    const normalized = normalizeText(originals.join(''))
    const translated = features.translateTitle
      ? translateTitleText(
          normalized,
          (segment) => matcher.translate(segment, pages),
          host.location.pathname,
          host.location.hostname,
        )
      : normalized
    const changed = translated !== normalized
    texts.forEach((node, i) => {
      records.writeText(node, originals[i]!, !changed ? originals[i]! : i === 0 ? translated : '')
    })
  }

  // ---------- 变动 ----------

  function processMutations(mutations: readonly MutationRecord[]): void {
    const roots = new Set<Element>()
    const seeds = new Set<Node>()
    const changed = new Map<Element, Set<string>>()
    /** 有子节点被移除的父节点：孤立标点的语境可能随之消失 */
    const removedFrom = new Set<Node>()
    /** 有子节点插入的父节点：紧贴包着标点的 span 插入的元素不产生种子，孤立标点的位置可能随之改变 */
    const addedTo = new Set<Node>()
    /** 子节点有增删的元素：依赖子节点的忽略规则（:has()）可能随之命中 */
    const reshaped = new Set<Element>()
    /** 文字被页面改写的文本节点所在的元素 */
    const rewritten = new Set<Element>()
    /** 按行内句重判的宿主（见 rejudgeHosts） */
    const hosts = new Set<Element>()
    const addSeed = (node: Node | null): void => {
      // 增删的节点紧邻 kbd：kbd 所在片段的组成变了，整句重算（见 seedAnchor）
      if (isRunNode(node) || isKbd(node)) seeds.add(node)
    }
    const addHost = (element: Element | null): void => {
      if (element !== null) hosts.add(element)
    }
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        if (mutation.target.nodeType === ELEMENT_NODE) reshaped.add(mutation.target as Element)
        if (mutation.addedNodes.length > 0) addedTo.add(mutation.target)
        for (const node of mutation.addedNodes) {
          if (node.nodeType === ELEMENT_NODE) {
            roots.add(node as Element)
            // 插入元素会把原来的文本组拆开
            addSeed(node.previousSibling)
            addSeed(node.nextSibling)
          } else if (isTextNode(node)) {
            seeds.add(node)
          }
        }
        // 移除节点可能把两段文本合成一组
        if (mutation.removedNodes.length > 0) {
          addSeed(mutation.previousSibling)
          addSeed(mutation.nextSibling)
          removedFrom.add(mutation.target)
        }
      } else if (mutation.type === 'characterData') {
        const target = mutation.target
        if (!isTextNode(target) || records.ownText(target)) continue
        seeds.add(target)
        if (target.parentElement) rewritten.add(target.parentElement)
      } else if (mutation.attributeName) {
        const element = mutation.target as Element
        const name = mutation.attributeName
        // disabled 只对需要 syncInputValue 的 input 有意义；其余元素（按钮等）频繁切换，不计入变动
        if (name === 'disabled' && !(isInputValueChange(element, name) && tracksInputValue(element))) continue
        if (records.ownAttribute(element, name, element.getAttribute(name))) continue
        const names = changed.get(element)
        if (names) names.add(name)
        else changed.set(element, new Set([name]))
      }
    }
    // 增删节点、页面改动属性后，忽略规则的命中可能变化（文字改写不影响）
    if (reshaped.size > 0 || changed.size > 0) timePositions.invalidate()
    // 在处理前判断（处理时记下新的槽位标记）
    for (const element of reshaped) {
      // 子节点有增删的行内句宿主：槽位数可能变了
      addHost(inline.sentenceHost(element))
      // 子节点有增删的槽位：标记（数字 / 非数字）可能变了
      addHost(inline.slotHost(element))
    }
    // 文字被改写的槽位：同上
    for (const element of rewritten) addHost(inline.slotHost(element))
    beginRound()
    for (const parent of removedFrom) {
      inline.noteChildren(parent)
      fitting.touch(parent)
    }
    for (const parent of addedTo) inline.noteChildren(parent)
    for (const root of roots) fitting.touch(root)
    processRoots(roots)
    processSeeds(seeds, roots)
    rejudgeHosts(hosts, roots)
    processReshapedMerges(reshaped)
    processAttributeChanges(changed, roots)
    for (const element of reshaped) if (element.isConnected) restoreStructural(element)
    endRound()
  }

  /**
   * 子节点有增删的合并区域（含区域内的后代元素）：增删的节点两侧可能没有文本，不会产生种子。
   * 按 handleMerge 整段重算，或重新遍历之前整段写入过、现在不能合并或未命中的区域
   */
  function processReshapedMerges(reshaped: ReadonlySet<Element>): void {
    if (!mergeIndex.selector) return
    for (const element of reshaped) {
      if (!element.isConnected || closestMerge(element) === null || insideSkipped(element)) continue
      const region = handleMerge(element, 'translate')
      if (region !== null) fitting.touch(region)
    }
  }

  /** 变动根节点所在位置，按父元素判断 */
  function parentState(parent: Element, roots: ReadonlySet<Element>): ParentState {
    if (isCovered(parent, roots)) return 'covered'
    if (!insideSkipped(parent)) return 'open'
    return parent.closest(HARD_SKIP_SELECTOR) ? 'closed' : 'search'
  }

  function processRoots(roots: ReadonlySet<Element>): void {
    // 同一批变动常向同一父元素插入大量节点（代码视图虚拟滚动的行、差异行）：按父元素缓存判断
    const states = new Map<Element, ParentState>()
    const stateOf = (parent: Element): ParentState => {
      let state = states.get(parent)
      if (state === undefined) states.set(parent, (state = parentState(parent, roots)))
      return state
    }
    /** 本批已按标签区域判断过的父元素 */
    const labelParents = new Set<Element>()
    for (const root of roots) {
      if (!root.isConnected) continue
      const parent = root.parentElement
      const state = parent ? stateOf(parent) : 'open'
      if (state === 'open') walk(root, 'translate')
      // 插入跳过区域内的只遍历其中的重新进入区域（经典视图的模板克隆、React 门户、正文整体替换）；
      // 根节点自身是重新进入区域时照常遍历
      else if (state === 'search' && parent !== null) {
        walk(root, 'translate', !isReentry(root))
        // 经典评论框预览区：脚本用 innerHTML 换上的占位段落
        if (placeholderRegionOf(root) === parent) translateRegionPlaceholder(parent)
        // 标签区域里换上的元素（React 换掉令牌里的文字元素、标签页的标签链接里换上新令牌）：按所在的标签区域根判断
        if (!labelParents.has(parent)) {
          labelParents.add(parent)
          translateLabelsAt(parent)
        }
      }
    }
  }

  /** 文本组是否可能需要处理：含英文，或有写入记录（已翻译 / 已置空），或只有空白（紧邻全角标点时置空，见 fit.ts） */
  function runNeedsWork(run: readonly Text[]): boolean {
    return (
      run.some((node) => LATIN_RE.test(node.data) || records.hasText(node)) ||
      SPACE_ONLY_RE.test(run.map((node) => node.data).join(''))
    )
  }

  /** kbd 内的文字变化、kbd 旁增删节点：改由 kbd 所在片段中的文本定位（见 kbdNeighbor） */
  function seedAnchor(seed: Node): Node | null {
    if (isKbd(seed)) return kbdNeighbor(seed)
    const parent = seed.parentNode
    return isKbd(parent) ? kbdNeighbor(parent) : seed
  }

  function processSeeds(seeds: ReadonlySet<Node>, roots: ReadonlySet<Element>): void {
    const heads = new Set<Text>()
    for (const seed of seeds) {
      const node = seed.isConnected ? seedAnchor(seed) : null
      const parent = node?.parentNode
      if (!node || parent?.nodeType !== ELEMENT_NODE) continue
      const element = parent as Element
      const run = textRun(node)
      const head = run[0]
      if (!head || heads.has(head)) continue
      heads.add(head)
      // kbd 文字变化、kbd 旁增删节点时，片段中的文本可能只有空白，仍要整句重算；可能是行内句宿主时整句重算
      // （整句写入时不留记录的段，如原样写入的「.」、保持原文的空白，被改写后也要重算）
      const work = node !== seed || runNeedsWork(run) || inline.maybeSentence(element)
      // 不含字母、没有记录、不只有空白的文字变化：在合并区域内（整段可能因此命中）或有孤立标点时才处理
      if (!work && !mergeIndex.selector && !run.some(inline.isPunctNode)) continue
      if (roots.size > 0 && isCovered(element, roots)) continue
      if (insideSkipped(element)) {
        // 文字在经典评论框预览区的段落里时按预览区判断
        translateRegionPlaceholder(placeholderRegionOf(element))
        // 文字在标签区域里时按所在的标签区域根判断
        translateLabelsAt(element)
        continue
      }
      fitting.touch(element)
      const region = handleMerge(element, 'translate')
      if (region !== null) {
        fitting.touch(region)
        continue
      }
      if (!work) {
        inline.notePunct(run)
        continue
      }
      processRun(run)
      if (isMirrorElement(element)) syncMirror(element)
    }
  }

  /**
   * 按行内句重判的宿主（子节点有增删、槽位的标记变了）：之前按整句写入、或按当前文字预判命中时整句重算；
   * 否则其中的文字没变，不处理（见 inline.rejudge）
   */
  function rejudgeHosts(hosts: ReadonlySet<Element>, roots: ReadonlySet<Element>): void {
    for (const element of hosts) {
      if (!element.isConnected || (roots.size > 0 && isCovered(element, roots)) || insideSkipped(element)) continue
      const region = handleMerge(element, 'translate')
      if (region !== null) {
        fitting.touch(region)
        continue
      }
      if (sentenceHasWebOwned(element) || !inline.rejudge(element)) continue
      fitting.touch(element)
      if (isMirrorElement(element)) syncMirror(element)
    }
  }

  /** 变动的属性中需要处理的名称；时间元素只看 lang / prefix / hour-cycle */
  function relevantAttributes(element: Element, names: ReadonlySet<string>): readonly string[] {
    const localName = element.localName
    if (TIME_TAGS.has(localName)) return TIME_ATTRIBUTES.some((name) => names.has(name)) ? TIME_ATTRIBUTES : []
    return [...names].filter(
      (name) =>
        TRANSLATABLE.has(name) ||
        (name === 'value' && localName === 'input' && isButtonInput(element)) ||
        (isInputValueChange(element, name) && tracksInputValue(element)) ||
        (MIRROR.has(name) && isMirrorElement(element)),
    )
  }

  /**
   * 单个元素（属性变动、时间开关切换）的位置：位于跳过区域内且自身不是重新进入区域（inside）、
   * 自身命中忽略规则（root）、照常处理（open）。
   * 不能改为 insideSkipped(element)：时间元素自身就是跳过标签
   */
  function elementState(element: Element): 'inside' | 'root' | 'open' {
    const parent = element.parentElement
    if (parent !== null && insideSkipped(parent) && !isReentry(element)) return 'inside'
    return elementMatches(ignore, element) ? 'root' : 'open'
  }

  function isSkippedElement(element: Element): boolean {
    return elementState(element) !== 'open'
  }

  /** 忽略区域根元素自身的属性：只按属性规则改写（没有命中时保持原文），不查词典、不记未翻译 */
  function applyRootRules(element: Element): void {
    for (const name of attributeRules.keys()) {
      const current = element.getAttribute(name)
      if (current === null) continue
      const source = records.attributeSource(element, name, current)
      if (source === CONTESTED || source === null) continue
      const desired = applyAttributeRules(attributeRules, element, name, source) ?? source
      if (desired !== current || desired !== source) records.writeAttribute(element, name, current, source, desired)
    }
  }

  /** 元素自身命中忽略规则，且不在其他跳过区域内（遍历时会走到它的位置） */
  function isOuterIgnoredRoot(element: Element): boolean {
    const parent = element.parentElement
    return elementMatches(ignore, element) && (parent === null || !insideSkipped(parent))
  }

  /**
   * 占位区域根（自身不是退出标记）里的占位文本节点，且是写过译文的节点或占位原文；否则 null。占位区域根有两种：
   * 预览窗格（PLACEHOLDER_SELECTOR），节点是其中唯一的文本节点；经典评论框预览区（CLASSIC_PREVIEW_SELECTOR），
   * 节点是其中唯一段落里的文本节点（见 soleParagraph）。
   * 先做不查选择器的判断：忽略区域里的变动种子都会走到这里
   */
  function placeholderNode(region: Element): Text | null {
    const first = region.firstChild
    const single = first !== null && first === region.lastChild && isTextNode(first)
    const node = single ? first : soleParagraph(region)?.firstChild
    if (!isTextNode(node)) return null
    // 写过译文的节点按记录判断（解析器在译文后追加的文字由 sourceOf 识别），没有记录时看当前文字
    if (!records.hasText(node) && !PLACEHOLDER_TEXTS.has(normalizeText(node.data))) return null
    const selector = single ? PLACEHOLDER_SELECTOR : CLASSIC_PREVIEW_SELECTOR
    return safeMatches(region, selector) && !safeMatches(region, EXIT_SELECTOR) ? node : null
  }

  /** 变动所在的占位区域根（自身命中忽略规则、不在其他跳过区域内）：其中的占位文字照常翻译 */
  function translateRegionPlaceholder(region: Element): void {
    const placeholder = placeholderNode(region)
    if (placeholder && isOuterIgnoredRoot(region)) translatePlaceholder(placeholder)
  }

  /** 占位区域里只有占位文字（PLACEHOLDER_TEXTS）时照常翻译；其余内容仍不处理，也不记未翻译 */
  function translatePlaceholder(node: Text): void {
    const source = sourceOf(node)
    if (source === CONTESTED || !PLACEHOLDER_TEXTS.has(normalizeText(source))) return
    applyText(node, source, false)
  }

  // ---------- 标签区域 ----------

  /**
   * 标签区域里逐层的包装元素：不是跳过标签、时间元素；命中忽略规则的只能是标签区域（标签页的标签链接里套着标签令牌），
   * 且不是退出标记
   */
  function isLabelWrapper(element: Element): boolean {
    const name = element.localName
    if (SKIP_TAGS.has(name) || TIME_TAGS.has(name)) return false
    if (!elementMatches(ignore, element)) return true
    return elementMatches(labelIndex, element) && !safeMatches(element, EXIT_SELECTOR)
  }

  /**
   * 标签区域里的那段文字：区域里只有一段文字（只有空白的文字、注释、只有图标的元素不计，见 isIconOnly），
   * 可以套在逐层只有一个元素的包装里（span.css-truncate-target、令牌的文字元素，见 isLabelWrapper）；否则 null
   */
  function labelTextOf(region: Element): Text | null {
    let element = region
    for (let depth = 0; depth < MAX_LABEL_DEPTH; depth++) {
      let only: ChildNode | null = null
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (isTextNode(child)) {
          if (!NON_SPACE_RE.test(child.data)) continue
        } else if (child.nodeType !== ELEMENT_NODE || isIconOnly(child as Element)) continue
        if (only !== null) return null
        only = child
      }
      if (only === null) return null
      if (isTextNode(only)) return only
      if (!isLabelWrapper(only as Element)) return null
      element = only as Element
    }
    return null
  }

  /** region 与区域根之间（含 region，不含根）的元素都能做包装（见 isLabelWrapper） */
  function labelPathOpen(region: Element, root: Element): boolean {
    for (let current: Element | null = region; current !== null && current !== root; current = current.parentElement) {
      if (!isLabelWrapper(current)) return false
    }
    return true
  }

  /**
   * 标签区域根（最外层的忽略区域根，命中标签区域）：根自身是退出标记时不处理。根里只有一段文字（见 labelTextOf）时按根处理，
   * 否则按根里的各个标签区域处理（贡献页的 span.IssueLabel 里是标签链接与说明两段）；根里写过标签译文、现在不是
   * 标签文字的节点（区域变成多段：追加了文字、表情）写回原文
   */
  function translateLabelRoot(root: Element): void {
    if (safeMatches(root, EXIT_SELECTOR) || hasWebOwnedText(root)) return
    const sole = labelTextOf(root)
    if (sole !== null) {
      translateLabelText(sole)
      return
    }
    const texts = new Set<Text>()
    if (root.firstElementChild !== null) {
      let regions: NodeListOf<Element> | undefined
      try {
        regions = root.querySelectorAll(LABEL_SELECTOR)
      } catch {
        regions = undefined
      }
      for (const region of regions ?? []) {
        const node = labelPathOpen(region, root) ? labelTextOf(region) : null
        if (node !== null) texts.add(node)
      }
    }
    const walker = doc.createTreeWalker(root, SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!texts.has(node as Text) && records.ownText(node as Text)) records.restoreText(node as Text)
    }
    for (const node of texts) translateLabelText(node)
  }

  /**
   * 标签区域里的文字按所在的最内层标签区域匹配：说明区域（LABEL_DESCRIPTION_SELECTORS）查说明表与标签正则，
   * 星标列表名称区域（LIST_NAME_SELECTORS）查预置名称表，
   * 其余（名称区域）查名称表。贡献页的经典标签根里，标签链接是名称区域、提示是说明区域
   */
  function labelPartOf(node: Text): LabelPart {
    let region = node.parentElement
    while (region !== null && !elementMatches(labelIndex, region)) region = region.parentElement
    if (region === null) return 'name'
    if (elementMatches(descriptionIndex, region)) return 'description'
    return elementMatches(listIndex, region) ? 'list' : 'name'
  }

  /** 文字整段是名称表、说明表（含标签正则）或预置列表名表的原文 */
  function isLabelText(text: string): boolean {
    return (
      matcher.translateLabel(text, 'name') !== undefined ||
      matcher.translateLabel(text, 'description') !== undefined ||
      matcher.translateLabel(text, 'list') !== undefined
    )
  }

  /**
   * 标签区域里的那段文字：整段命中所在区域（名称、说明或星标列表名，见 labelPartOf）的表或标签正则时写入译文；
   * 不命中时写回原文（写过译文、原文后来变了，或解析器在译文后追加了文字）。不记未翻译
   */
  function translateLabelText(node: Text): void {
    if (isWebOwned(node)) return
    // 没有记录时只看当前文字，名称、说明、列表名都不命中就不取原文（取原文有副作用，见 sourceOf），也不判断区域种类
    if (!records.hasText(node) && !isLabelText(node.data)) return
    const part = labelPartOf(node)
    let source = sourceOf(node)
    if (source === CONTESTED) {
      // 与页面脚本互相覆盖（当前不是自身写入）时不处理。解析器在译文后只追加了符号、标点时，记录已改为追加后的原文、
      // 显示保持译文加追加部分（见 records.ts）：按追加后的原文判断，不再是默认标签时写回原文，不留半译的标签
      if (!records.ownText(node)) return
      source = records.peekText(node)
    }
    const translated = matcher.translateLabel(source, part)
    if (translated === undefined) restoreSource(node, source)
    else records.writeText(node, source, fitting.fit(node, translated))
  }

  /**
   * element 所在的标签区域根：element 自身或祖先中最外层的标签区域，且它是最外层的忽略区域根（不在其他跳过区域内）；
   * 否则 null。只沿标签区域向上找：嵌在其他忽略区域里的标签区域不处理（同遍历）
   */
  function labelRootOf(element: Element): Element | null {
    let root = closestOf(element, LABEL_SELECTOR)
    if (root === null) return null
    for (
      let outer = root.parentElement && closestOf(root.parentElement, LABEL_SELECTOR);
      outer;
      outer = outer.parentElement && closestOf(outer.parentElement, LABEL_SELECTOR)
    ) {
      root = outer
    }
    return isOuterIgnoredRoot(root) ? root : null
  }

  /** 变动所在的标签区域根（见 labelRootOf）：其中的默认标签照常翻译 */
  function translateLabelsAt(element: Element): void {
    if (!labelsEnabled) return
    const root = labelRootOf(element)
    if (root !== null) translateLabelRoot(root)
  }

  // ---------- 先译后忽略 ----------

  /** 元素上有不是属性规则写入的译文属性 */
  function hasStrayAttributes(element: Element): boolean {
    for (const name of records.translatedNames(element)) {
      const source = records.attributeSource(element, name, element.getAttribute(name))
      if (typeof source !== 'string') return true
      if (applyAttributeRules(attributeRules, element, name, source) === undefined) return true
    }
    return false
  }

  /** 区域内有本引擎的写入：区域根上有不是属性规则写入的译文属性，或后代有写入的文字、属性 */
  function hasRecordsWithin(region: Element): boolean {
    if (hasStrayAttributes(region)) return true
    const walker = doc.createTreeWalker(region, SHOW_ELEMENT | SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const written =
        node.nodeType === TEXT_NODE ? records.ownText(node as Text) : records.translatedAttributes(node as Element) > 0
      if (written) return true
    }
    return false
  }

  /** 元素自身或祖先中最近的忽略区域（只看忽略规则）；元素位于其中的重新进入区域内时返回 null */
  function ignoredRegion(element: Element): Element | null {
    const region = ignore.selector ? closestOf(element, ignore.selector) : null
    if (!region) return null
    const reentry = element.closest(REENTRY_SELECTOR)
    return reentry && reentry !== region && region.contains(reentry) && isReentry(reentry) ? null : region
  }

  /**
   * 先翻译、后变为忽略的区域（忽略规则依赖子节点或属性，如 :not(:has(…))）：其中有本引擎的写入时按全新遍历的结果还原，
   * 区域根照常按属性规则改写，区域内的重新进入区域照常翻译（本轮此前对其中宿主、合并区域的判断作废，重新判断），
   * 区域在标签区域里时其中的默认标签照常翻译（标签区域根的属性变了也走这里：还原的译文随即写回）；
   * 还原的文字可能是外面包着标点的 span 的语境，区域及其祖先下的孤立标点轮末重算（见 inline.ts）。
   * 位于合并区域内时所在区域随之重算（不能再整段合并；区域内没有写入时同样）
   */
  function restoreIfWritten(region: Element): void {
    if (hasRecordsWithin(region)) {
      restoreSubtree(region)
      inline.noteRewritten(region)
      forgetWithin(region)
      applyRootRules(region)
      walk(region, 'translate', true)
      translateLabelsAt(region)
      fitting.touch(region)
    }
    const parent = region.parentElement
    if (parent === null || closestMerge(parent) === null || insideSkipped(parent)) return
    const merged = handleMerge(parent, 'translate')
    if (merged !== null) fitting.touch(merged)
  }

  /** 区域内的文字已还原、随后重新遍历：区域内宿主、合并区域本轮的判断作废，重新遍历时重新判断 */
  function forgetWithin(region: Element): void {
    inline.forget(region)
    for (const merged of mergedRegions.keys()) if (region.contains(merged)) mergedRegions.delete(merged)
    for (const released of releasedRegions) if (region.contains(released)) releasedRegions.delete(released)
  }

  /** 位于忽略区域内的元素留有译文属性：所在区域是先译后忽略的 */
  function restoreIgnoredRegion(element: Element): void {
    if (!hasStrayAttributes(element)) return
    const region = ignoredRegion(element)
    if (region) restoreIfWritten(region)
  }

  /**
   * 子节点有增删的元素：依赖结构的忽略规则（:has() 等）可能随之命中它自身或祖先。
   * 取最外层命中的祖先检查（嵌套的组：内层加载完成后外层随之命中）。
   * 条件在兄弟或祖先上、命中的区域在变动元素之下时不在此检查，文档解析结束时统一检查一次（见 restoreParsed）
   */
  function restoreStructural(element: Element): void {
    if (!structuralSelector) return
    let outermost: Element | null = null
    for (
      let region = closestOf(element, structuralSelector);
      region;
      region = region.parentElement && closestOf(region.parentElement, structuralSelector)
    ) {
      outermost = region
    }
    if (outermost) restoreIfWritten(outermost)
  }

  /** 区域内新命中忽略规则的部分还原（整段合并的区域不能再合并时）；区域根自身命中时整个区域还原 */
  function restoreIgnoredWithin(region: Element): void {
    if (!ignore.selector) return
    if (elementMatches(ignore, region)) {
      restoreSubtree(region)
      return
    }
    let found: NodeListOf<Element>
    try {
      found = region.querySelectorAll(ignore.selector)
    } catch {
      return
    }
    for (const element of found) restoreSubtree(element)
  }

  /**
   * 文档解析结束：分块到达期间，依赖结构的忽略规则可能在区域译出之后才命中（条件元素后到）。
   * 全文档按依赖结构的忽略规则查一次，最外层命中且其中有写入的区域还原
   */
  function restoreParsed(): void {
    if (!active || !structuralSelector) return
    flushMutations()
    let regions: NodeListOf<Element>
    try {
      regions = doc.querySelectorAll(structuralSelector)
    } catch {
      return
    }
    beginRound()
    for (const region of regions) {
      const outer = region.parentElement && closestOf(region.parentElement, structuralSelector)
      if (outer === null && region.isConnected) restoreIfWritten(region)
    }
    endRound()
  }

  function processAttributeChanges(
    changed: ReadonlyMap<Element, ReadonlySet<string>>,
    roots: ReadonlySet<Element>,
  ): void {
    for (const [element, names] of changed) {
      if (!element.isConnected) continue
      // 退出标记变化：元素因此进入忽略区域时还原其中的译文（离开忽略区域不补译）。
      // 元素在同一批里被移动、插入（自身或祖先是变动根节点）时同样要还原：遍历变动根节点时命中忽略规则只拒绝、不还原
      if (EXIT_ATTRIBUTES.some((name) => names.has(name))) {
        const region = ignoredRegion(element)
        if (region) restoreIfWritten(region)
      }
      if (roots.size > 0 && isCovered(element, roots)) continue
      const relevant = relevantAttributes(element, names)
      if (relevant.length === 0) continue
      const state = elementState(element)
      if (state === 'root') {
        restoreIfWritten(element)
        applyRootRules(element)
        continue
      }
      if (state === 'inside') {
        restoreIgnoredRegion(element)
        continue
      }
      if (TIME_TAGS.has(element.localName)) {
        processTime(element)
        continue
      }
      for (const name of relevant) {
        if (isInputValueChange(element, name)) syncInputValue(element)
        else if (!MIRROR.has(name)) translateAttribute(element, name, element.getAttribute(name))
      }
      if (relevant.some((name) => MIRROR.has(name))) syncMirror(element)
    }
  }

  function onMutations(mutations: MutationRecord[]): void {
    batches++
    if (!active) return
    // 页面类型变化时已全量重译，本批变动无需再处理
    if (checkLocation() || !active) return
    processMutations(mutations)
    syncTitle()
  }

  /** 立即处理尚未回调的变动 */
  function flushMutations(): void {
    const pending = observer?.takeRecords() ?? []
    if (pending.length > 0) onMutations(pending)
  }

  // ---------- 状态切换 ----------

  function retranslate(): void {
    walkDocument('retranslate')
    syncTitle()
  }

  function checkLocation(): boolean {
    if (!active) return false
    const href = host.location.href
    if (href === lastHref) return false
    lastHref = href
    untranslated.startVisit()
    updateCollectHere()
    options.onLocationChange?.(href)
    if (!active) return false
    const next = resolvePages()
    const key = next.join('|')
    if (key === pagesKey) return false
    pages = next
    pagesKey = key
    compileIgnore()
    retranslate()
    return true
  }

  function processAllTime(): void {
    for (const element of doc.querySelectorAll(TIME_SELECTOR)) {
      if (!features.translateTime) restoreTime(element)
      else if (!isSkippedElement(element)) processTime(element)
    }
  }

  /** 关闭收集时丢弃待取出的增量，已见过的节点重新计数 */
  function clearUntranslated(): void {
    untranslated.clear()
    textMisses = new WeakMap()
    attributeMisses = new WeakMap()
  }

  function countTranslated(): number {
    const root = doc.documentElement
    if (!root) return 0
    let count = records.translatedAttributes(root)
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // 文本组置空的节点不计数：一组只算一次
      if (node.nodeType === TEXT_NODE) count += records.ownText(node as Text) && (node as Text).data !== '' ? 1 : 0
      else count += records.translatedAttributes(node as Element)
    }
    return count
  }

  return {
    get active() {
      return active
    },
    get pages() {
      return active ? pages : resolvePages()
    },
    get features() {
      return features
    },
    get batches() {
      return batches
    },

    start() {
      if (active) return
      active = true
      lastHref = host.location.href
      untranslated.startVisit()
      updateCollectHere()
      pages = resolvePages()
      pagesKey = pages.join('|')
      compileIgnore()
      timeText.attach()
      walkDocument('translate')
      syncTitle()
      observer = new host.MutationObserver(onMutations)
      observer.observe(doc, OBSERVE_OPTIONS)
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', restoreParsed)
    },

    stop() {
      if (!active) return
      active = false
      observer?.disconnect()
      observer = null
      doc.removeEventListener('DOMContentLoaded', restoreParsed)
      timeText.detach()
      const root = doc.documentElement
      if (root) restoreSubtree(root)
      records.clear()
      inline.reset()
      fitting.reset()
      mergedOnce = new WeakSet()
    },

    setMatcher(next) {
      matcher = next
      if (!active) return
      compileIgnore()
      retranslate()
    },

    setLocale(next, lang) {
      matcher = next
      timeLang = lang
      if (!active) return
      compileIgnore()
      // 重译时时间元素随遍历换成新的 lang
      retranslate()
    },

    setFeatures(next) {
      const previous = features
      features = { ...features, ...next }
      if (!active) return
      if (previous.translateTime !== features.translateTime) processAllTime()
      if (previous.translateTitle !== features.translateTitle) syncTitle()
      if (previous.collectUntranslated === features.collectUntranslated) return
      if (!features.collectUntranslated) {
        clearUntranslated()
        return
      }
      // 开启时补收当前页面已有文本
      walkDocument('translate')
    },

    checkLocation,

    flush: flushMutations,

    translatedCount() {
      return active ? countTranslated() : 0
    },

    drainUntranslated() {
      return untranslated.drain()
    },
  }
}
