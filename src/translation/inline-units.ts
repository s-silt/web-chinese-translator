/**
 * 行内单元：把「带行内格式的段落」作为一个整体发给模型——标签占位保住行内元素边界，
 * 译文按占位回填到各文本节点。规则见 inlineUnitFor；解析失败或快照失效时调用方退回逐节点路径。
 */
import { MAX_MODEL_TEXT } from './sites'

export interface InlineUnit {
  /** 单元根：节点向上第一个非行内标签祖先 */
  readonly block: Element
  /** 参与翻译的文本节点（文档顺序；纯空白、不透出行内元素内部、冻结节点不在内） */
  readonly nodes: readonly Text[]
  /** nodes 逐节点原文，写回前校验 DOM 未变 */
  readonly sources: readonly string[]
  /** 每个节点最内层所在的成对标签编号；块下直属文本节点为 undefined（裸段） */
  readonly containers: readonly (number | undefined)[]
  /** 成对标签编号全集（开/闭各一次） */
  readonly pairedTags: ReadonlySet<number>
  /** 独立占位编号全集（不透出行内元素 + 排除/冻结项） */
  readonly standaloneTags: ReadonlySet<number>
  /** 序列化时遇到的全部 child 节点快照（文档顺序；op/冻结/排除元素自身在内，内部不展开） */
  readonly structure: readonly Node[]
  /** 序列化文本：节点原文 + 成对 <n>…</n>（可嵌套）+ 独立 <n/> */
  readonly template: string
}

export const PHRASING_TAGS: ReadonlySet<string> = new Set(
  'a abbr b bdi bdo cite data del dfn em i ins mark q s small span strong sub sup time u font label'.split(' '),
)
export const OPAQUE_INLINE_TAGS: ReadonlySet<string> = new Set(
  'code kbd var samp img svg br wbr input button select textarea math picture video audio canvas'.split(' '),
)

export const INLINE_MARKUP_HINT =
  'Some strings contain inline markup placeholders: paired tags like <1>…</1> and standalone tags like <2/>. ' +
  'Keep every placeholder exactly once with the same numbering, order and nesting as the source. ' +
  'Translate only the text between placeholders; never move, add or remove placeholders.'

export interface InlineUnitOptions {
  isExcluded: (el: Element) => boolean
  isFrozen?: (text: Text) => boolean
}

const MAX_UNIT_NODES = 200
const MAX_ANCESTOR_CLIMB = 32
const MAX_SERIALIZE_DEPTH = 32

function tagName(el: Element): string {
  return el.tagName.toLowerCase()
}

/** 视为独立占位：不透出行内标签、明确标注不翻译的元素、可编辑区域 */
function isStandalone(el: Element, isExcluded: (el: Element) => boolean): boolean {
  return (
    OPAQUE_INLINE_TAGS.has(tagName(el)) ||
    isExcluded(el) ||
    el.closest('[translate="no"], .notranslate') !== null ||
    (el instanceof HTMLElement && el.isContentEditable)
  )
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
function unescapeText(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

export function inlineUnitFor(node: Text, options: InlineUnitOptions): InlineUnit | undefined {
  const { isExcluded, isFrozen } = options
  let block = node.parentElement
  if (block === null) return undefined
  let climb = 0
  while (PHRASING_TAGS.has(tagName(block)) && block.parentElement !== null) {
    if ((climb += 1) > MAX_ANCESTOR_CLIMB) return undefined
    block = block.parentElement
  }
  if (isExcluded(block)) return undefined
  if (block.closest('[translate="no"], .notranslate') !== null ||
    (block instanceof HTMLElement && block.isContentEditable)) return undefined

  const nodes: Text[] = []
  const sources: string[] = []
  const containers: (number | undefined)[] = []
  const paired = new Set<number>()
  const standalone = new Set<number>()
  const structure: Node[] = []
  const stack: number[] = []
  let next = 1
  let template = ''

  const append = (text: string): boolean => {
    template += text
    return template.length <= MAX_MODEL_TEXT
  }

  const serialize = (el: Element, depth: number): boolean => {
    if (depth > MAX_SERIALIZE_DEPTH) return false
    for (const child of el.childNodes) {
      if (structure.length >= MAX_UNIT_NODES) return false
      structure.push(child)
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue ?? ''
        // 冻结节点（已有 records，例如固定词典写过）：独立占位，不发送、不参与写回
        if (text.trim() !== '' && isFrozen?.(child as Text) === true) {
          standalone.add(next)
          if (!append(`<${next}/>`)) return false
          next += 1
          continue
        }
        if (!append(escapeText(text))) return false
        if (text.trim() !== '') {
          nodes.push(child as Text)
          sources.push(text)
          containers.push(stack.at(-1))
        }
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el2 = child as Element
      if (isStandalone(el2, isExcluded)) {
        standalone.add(next)
        if (!append(`<${next}/>`)) return false
        next += 1
        continue
      }
      if (!PHRASING_TAGS.has(tagName(el2))) return false
      const id = next
      next += 1
      paired.add(id)
      stack.push(id)
      if (!append(`<${id}>`)) return false
      if (!serialize(el2, depth + 1)) return false
      stack.pop()
      if (!append(`</${id}>`)) return false
    }
    return true
  }
  if (!serialize(block, 1)) return undefined
  if (nodes.length < 2) return undefined
  return { block, nodes, sources, containers, pairedTags: paired, standaloneTags: standalone, structure, template }
}

/** 快照有效性：block 仍挂载、重序列化结果与单元完全一致（结构/节点/原文均未变） */
export function isInlineUnitCurrent(unit: InlineUnit, options: InlineUnitOptions): boolean {
  const first = unit.nodes[0]
  if (first === undefined || !unit.block.isConnected) return false
  const current = inlineUnitFor(first, options)
  return current !== undefined && current.block === unit.block && current.template === unit.template &&
    current.structure.length === unit.structure.length && current.structure.every((n, i) => n === unit.structure[i]) &&
    current.nodes.length === unit.nodes.length && current.nodes.every((n, i) => n === unit.nodes[i] && current.sources[i] === unit.sources[i])
}

/**
 * 校验并切回 nodes.length 段：每个占位恰一次、成对标签嵌套合法、无未知标签，
 * 且标签序列与模板完全一致（不允许改变标签顺序/嵌套——真实 DOM 不会移动）。
 * 裸段与标签内段按出现顺序归位；任何不满足返回 undefined。
 */
export function parseInlineResult(translated: string, unit: InlineUnit): string[] | undefined {
  const sourceTags = [...unit.template.matchAll(/<\/?\d+\/?>/g)].map((m) => m[0])
  const outputTags = [...translated.matchAll(/<\/?\d+\/?>/g)].map((m) => m[0])
  if (sourceTags.length !== outputTags.length || sourceTags.some((tag, i) => tag !== outputTags[i])) return undefined

  interface Tok {
    kind: 'open' | 'close' | 'self' | 'text'
    tag?: number
    text?: string
  }
  const toks: Tok[] = []
  let last = 0
  for (const m of translated.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
    if (m.index > last) toks.push({ kind: 'text', text: unescapeText(translated.slice(last, m.index)) })
    const tag = Number(m[2])
    toks.push({ kind: m[1] === '/' ? 'close' : m[3] === '/' ? 'self' : 'open', tag })
    last = m.index + m[0].length
  }
  if (last < translated.length) toks.push({ kind: 'text', text: unescapeText(translated.slice(last)) })

  const seenOpen = new Set<number>()
  const seenClose = new Set<number>()
  const seenSelf = new Set<number>()
  const nest: number[] = []
  for (const tok of toks) {
    if (tok.kind === 'text') continue
    const tag = tok.tag!
    if (!unit.pairedTags.has(tag) && !unit.standaloneTags.has(tag)) return undefined
    if (tok.kind === 'open') {
      if (!unit.pairedTags.has(tag) || seenOpen.has(tag)) return undefined
      seenOpen.add(tag)
      nest.push(tag)
    } else if (tok.kind === 'close') {
      if (seenClose.has(tag) || nest.pop() !== tag) return undefined
      seenClose.add(tag)
    } else {
      if (!unit.standaloneTags.has(tag) || seenSelf.has(tag)) return undefined
      seenSelf.add(tag)
    }
  }
  if (nest.length > 0) return undefined
  if (seenOpen.size !== unit.pairedTags.size || seenSelf.size !== unit.standaloneTags.size) return undefined

  // 每容器一个游标：文本串按出现顺序分给该容器下还没领段的节点；多余的段或漏段都判失败
  const segments = new Map<number, string>()
  const cursors = new Map<number, number>()
  const runStack: number[] = []
  for (const tok of toks) {
    if (tok.kind === 'open') {
      runStack.push(tok.tag!)
      continue
    }
    if (tok.kind === 'close') {
      runStack.pop()
      continue
    }
    if (tok.kind !== 'text') continue
    // 纯空白段只是占位间隔，不占节点段（序列化时空白原样写入、不计入 nodes）
    if ((tok.text ?? '').trim() === '') continue
    const container = runStack.at(-1) ?? 0
    let i = cursors.get(container) ?? 0
    while (i < unit.nodes.length && (unit.containers[i] ?? 0) !== container) i += 1
    if (i >= unit.nodes.length) return undefined
    segments.set(i, tok.text ?? '')
    cursors.set(container, i + 1)
  }
  if (segments.size !== unit.nodes.length) return undefined
  return unit.nodes.map((_, i) => segments.get(i)!)
}
