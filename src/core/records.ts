/**
 * 写入记录：每个文本节点 / 属性的原文与最后写入值。
 * - 当前值等于最后写入值：自身写入，原文不变。
 * - 当前值为其他内容：外部改写（如 React 重渲染），当前值成为新原文。
 * - 当前值恰好等于原文：被外部改回原文。React 只在内容变化时写入，不会这样做；
 *   短时间内反复发生说明页面脚本在与翻译互相覆盖，超过上限即暂停处理该节点，避免死循环。
 * - 文档解析期间，解析器把分块到达的文字追加到已写入的文本节点：原文为记录的原文加追加部分（见 appendedPart）。
 */

import { textOwnership, type TextOwnershipScope } from '../shared/text-ownership'

export const CONTESTED: unique symbol = Symbol('contested')
export type Contested = typeof CONTESTED

/** 统计窗口与上限：窗口内被改回原文超过上限次即暂停 */
export const FIGHT_WINDOW_MS = 1000
export const FIGHT_LIMIT = 8

/** 单词字符：字母、组合附加符号、数字、连接符（下划线） */
const WORD_RE = /[\p{L}\p{M}\p{N}\p{Pc}]/u
const NON_SPACE_RE = /\S/
const ownership = textOwnership()

interface WriteRecord<T extends string | null> {
  readonly original: T
  readonly written: string
  readonly reverts: number
  readonly since: number
}

interface TextRecord extends WriteRecord<string> {
  /** 写入空串时是父元素的最后一个子节点（解析器插入点）；同一解析任务内随后插入的兄弟不影响 */
  readonly tail: boolean
}

type AttributeRecord = WriteRecord<string | null>

export interface RecordStore {
  /** 文本节点的原文；与页面脚本互相覆盖、或已译节点刚被解析器追加标点或符号（本次保持现状）时返回 CONTESTED */
  textSource(node: Text): string | Contested
  /** 只读预判原文：当前为自身写入时返回写入前的原文，否则返回当前文字；不计改回次数、不改记录 */
  peekText(node: Text): string
  /** 写入期望值；期望值等于原文时清除记录 */
  writeText(node: Text, source: string, desired: string): void
  /** 节点当前值是否为自身写入（即处于已翻译状态） */
  ownText(node: Text): boolean
  /** 节点是否有写入记录 */
  hasText(node: Text): boolean
  /** 还原节点（仍为自身写入时）并清除记录 */
  restoreText(node: Text): void

  /** 属性的原文（null 表示原本不存在）；与页面脚本互相覆盖时返回 CONTESTED */
  attributeSource(element: Element, name: string, current: string | null): string | null | Contested
  /** 写入期望值（null 表示移除）；期望值等于原文时清除记录 */
  writeAttribute(
    element: Element,
    name: string,
    current: string | null,
    source: string | null,
    desired: string | null,
  ): void
  ownAttribute(element: Element, name: string, current: string | null): boolean
  /** 还原元素属性（全部或指定名称）并清除记录 */
  restoreAttributes(element: Element, names?: readonly string[]): void
  /** 元素上处于已翻译状态的属性数 */
  translatedAttributes(element: Element): number
  /** 元素上处于已翻译状态的属性名 */
  translatedNames(element: Element): string[]
  /** 丢弃全部记录（不还原） */
  clear(): void
}

function nextRecord<T extends string | null>(
  previous: WriteRecord<T> | undefined,
  original: T,
  written: string,
): WriteRecord<T> {
  const keep = previous !== undefined && previous.original === original
  return { original, written, reverts: keep ? previous.reverts : 0, since: keep ? previous.since : 0 }
}

function nextTextRecord(previous: TextRecord | undefined, node: Text, original: string, written: string): TextRecord {
  return { ...nextRecord(previous, original, written), tail: written === '' && node.nextSibling === null }
}

function countRevert<R extends WriteRecord<string | null>>(record: R, now: number): R {
  const fresh = record.reverts === 0 || now - record.since > FIGHT_WINDOW_MS
  return { ...record, reverts: fresh ? 1 : record.reverts + 1, since: fresh ? now : record.since }
}

/**
 * 解析器追加到已写入节点的文字；不是追加时返回 undefined（按外部改写或改回处理）。
 * 只有文档解析期间（readyState 为 loading）的解析器会往已有文本节点追加，此时 GitHub 的页面脚本（module）尚未运行。
 * - 置空节点（文本组、kbd 片段的非首节点）：置空时须是父元素的最后一个子节点（解析器插入点）。
 *   当前文字全是追加部分，以原文开头或等于原文时也是（「1」+「12」）；
 * - 已译节点：当前文字以译文开头，其后是追加部分。译文是原文前缀（Webhooks → Webhook）、
 *   当前文字又以原文开头时无法区分，按页面写回原文加后缀处理（改写）。
 */
function appendedPart(node: Text, record: TextRecord, data: string): string | undefined {
  if (node.ownerDocument?.readyState !== 'loading') return undefined
  const { original, written } = record
  if (written === '') return record.tail ? data : undefined
  if (!data.startsWith(written) || (original.startsWith(written) && data.startsWith(original))) return undefined
  return data.slice(written.length)
}

export function createRecordStore(clock: () => number): RecordStore {
  let texts = new WeakMap<Text, TextRecord>()
  let attributes = new WeakMap<Element, Map<string, AttributeRecord>>()
  let scope: TextOwnershipScope = { active: true }

  function getAttributeRecord(element: Element, name: string): AttributeRecord | undefined {
    return attributes.get(element)?.get(name)
  }

  function setAttributeRecord(element: Element, name: string, record: AttributeRecord): void {
    const map = attributes.get(element)
    if (map) map.set(name, record)
    else attributes.set(element, new Map([[name, record]]))
  }

  function deleteAttributeRecord(element: Element, name: string): void {
    const map = attributes.get(element)
    if (!map) return
    map.delete(name)
    if (map.size === 0) attributes.delete(element)
  }

  return {
    textSource(node) {
      if (ownership.ownerOf(node) === 'web') return CONTESTED
      const data = node.data
      const record = texts.get(node)
      if (record === undefined) return data
      if (data === record.written) return record.original
      // 先判断追加：置空节点被追加的文字可能恰好等于原文
      const appended = appendedPart(node, record, data)
      if (appended === undefined && data === record.original) {
        const counted = countRevert(record, clock())
        texts.set(node, counted)
        return counted.reverts > FIGHT_LIMIT ? CONTESTED : data
      }
      texts.delete(node)
      ownership.release(node, 'github')
      if (appended === undefined) return data
      const source = record.original + appended
      // 追加到置空节点，或追加部分含字母、数字（「编辑」+「 file」、「展开第 1 行」+「2」）、只有空白：
      // 按原文加追加部分重译，未命中时显示原文，与整段一次到达相同
      if (record.written === '' || WORD_RE.test(appended) || !NON_SPACE_RE.test(appended)) return source
      // 只追加标点、符号（「编辑」+「…」）：显示不变，记录改为追加后的原文，停用时能还原。
      // 返回 CONTESTED 让调用方本次跳过；返回当前文字会被当作原文写回（如标题），记录随之清除
      texts.set(node, nextTextRecord(record, node, source, data))
      ownership.claim(node, 'github', data, scope)
      return CONTESTED
    },

    peekText(node) {
      const record = texts.get(node)
      return record !== undefined && node.data === record.written ? record.original : node.data
    },

    writeText(node, source, desired) {
      if (ownership.ownerOf(node) === 'web') {
        texts.delete(node)
        return
      }
      if (node.data !== desired) node.data = desired
      if (desired === source) {
        texts.delete(node)
        ownership.release(node, 'github')
      } else {
        texts.set(node, nextTextRecord(texts.get(node), node, source, desired))
        ownership.claim(node, 'github', desired, scope)
      }
    },

    ownText(node) {
      if (ownership.ownerOf(node) === 'web') return false
      const record = texts.get(node)
      return record !== undefined && node.data === record.written
    },

    hasText(node) {
      return texts.has(node)
    },

    restoreText(node) {
      if (ownership.ownerOf(node) === 'web') {
        texts.delete(node)
        return
      }
      const record = texts.get(node)
      if (record === undefined) return
      if (node.data === record.written) node.data = record.original
      texts.delete(node)
      ownership.release(node, 'github')
    },

    attributeSource(element, name, current) {
      const record = getAttributeRecord(element, name)
      if (record === undefined) return current
      if (current === record.written) return record.original
      if (current === record.original) {
        const counted = countRevert(record, clock())
        setAttributeRecord(element, name, counted)
        return counted.reverts > FIGHT_LIMIT ? CONTESTED : current
      }
      deleteAttributeRecord(element, name)
      return current
    },

    writeAttribute(element, name, current, source, desired) {
      if (current !== desired) {
        if (desired === null) element.removeAttribute(name)
        else element.setAttribute(name, desired)
      }
      if (desired === null || desired === source) deleteAttributeRecord(element, name)
      else setAttributeRecord(element, name, nextRecord(getAttributeRecord(element, name), source, desired))
    },

    ownAttribute(element, name, current) {
      const record = getAttributeRecord(element, name)
      return record !== undefined && current === record.written
    },

    restoreAttributes(element, names) {
      const map = attributes.get(element)
      if (!map) return
      for (const [name, record] of map) {
        if (names && !names.includes(name)) continue
        if (element.getAttribute(name) === record.written) {
          if (record.original === null) element.removeAttribute(name)
          else element.setAttribute(name, record.original)
        }
        map.delete(name)
      }
      if (map.size === 0) attributes.delete(element)
    },

    translatedAttributes(element) {
      const map = attributes.get(element)
      if (!map) return 0
      let count = 0
      for (const [name, record] of map) {
        if (element.getAttribute(name) === record.written) count++
      }
      return count
    },

    translatedNames(element) {
      const map = attributes.get(element)
      if (!map) return []
      return [...map].filter(([name, record]) => element.getAttribute(name) === record.written).map(([name]) => name)
    },

    clear() {
      // WeakMap 不可遍历；停用旧 scope 使此前登记的所有权在 ownerOf 时失效，其余过期登记由文字比对自然失效
      scope.active = false
      scope = { active: true }
      texts = new WeakMap()
      attributes = new WeakMap()
    },
  }
}
