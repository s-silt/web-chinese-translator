const TOLERANCE = 1
const MAX_ANCESTORS = 6

interface RejectedRecord {
  source: string
  epoch: number
}

const rejected = new WeakMap<Text, RejectedRecord>()
let layoutEpoch = 0

export function invalidateLayout(): void {
  layoutEpoch += 1
}

function isConstrained(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  const display = style.display
  return (
    element.tagName === 'BUTTON' ||
    element.tagName === 'TD' ||
    element.tagName === 'TH' ||
    element.tagName === 'A' ||
    display === 'inline-block' ||
    display === 'table-cell' ||
    display.includes('flex') ||
    display.includes('grid') ||
    (style.overflowX !== '' && style.overflowX !== 'visible') ||
    (style.overflowY !== '' && style.overflowY !== 'visible') ||
    style.whiteSpace === 'nowrap'
  )
}

interface ConstraintSnapshot {
  element: HTMLElement
  excessX: number
  excessY: number
  clipped: boolean
}

interface CollisionSnapshot {
  element: Element
  overlapped: boolean
}

function textRect(node: Text): DOMRect | undefined {
  const range = node.ownerDocument.createRange()
  range.selectNode(node)
  const rect = range.getBoundingClientRect()
  range.detach()
  return rect.width === 0 && rect.height === 0 ? undefined : rect
}

function siblingElements(node: Text): Element[] {
  const parent = node.parentElement
  if (parent === null) return []
  const siblings: Element[] = []
  const prev = node.previousElementSibling ?? parent.previousElementSibling
  const next = node.nextElementSibling ?? parent.nextElementSibling
  if (prev !== null) siblings.push(prev)
  if (next !== null) siblings.push(next)
  return siblings
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > TOLERANCE &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > TOLERANCE
  )
}

function clippedOutside(rect: DOMRect | undefined, ancestor: HTMLElement): boolean {
  if (rect === undefined) return false
  const bound = ancestor.getBoundingClientRect()
  return (
    rect.right > bound.right + TOLERANCE ||
    rect.left < bound.left - TOLERANCE ||
    rect.bottom > bound.bottom + TOLERANCE ||
    rect.top < bound.top - TOLERANCE
  )
}

export function wasRejected(node: Text, source: string): boolean {
  const prior = rejected.get(node)
  return prior !== undefined && prior.source === source && prior.epoch === layoutEpoch
}

export interface TextReplacement {
  readonly node: Text
  readonly source: string
  readonly translated: string
}

interface ReplacementSnapshot {
  readonly change: TextReplacement
  readonly constraints: ConstraintSnapshot[]
  readonly collisions: CollisionSnapshot[]
}

function canReplace(change: TextReplacement): boolean {
  return change.node.isConnected && change.node.parentElement !== null &&
    change.node.data === change.source && !wasRejected(change.node, change.source)
}

function snapshotReplacement(change: TextReplacement): ReplacementSnapshot {
  const ancestors: HTMLElement[] = []
  let cursor: HTMLElement | null = change.node.parentElement
  while (cursor !== null && ancestors.length < MAX_ANCESTORS) {
    ancestors.push(cursor)
    const next: HTMLElement | null = cursor.parentElement
    if (next !== null) {
      cursor = next
      continue
    }
    const root = cursor.getRootNode()
    cursor = root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null
  }
  const beforeText = textRect(change.node)
  const constraints = ancestors.filter(isConstrained).map((element) => ({
    element,
    excessX: Math.max(0, element.scrollWidth - element.clientWidth),
    excessY: Math.max(0, element.scrollHeight - element.clientHeight),
    clipped: clippedOutside(beforeText, element),
  }))
  const collisions: CollisionSnapshot[] = []
  for (const element of siblingElements(change.node)) {
    const bounds = element.getBoundingClientRect()
    if (bounds.width > 0) collisions.push({
      element, overlapped: beforeText !== undefined && overlaps(beforeText, bounds),
    })
  }
  return { change, constraints, collisions }
}

function replacementFits(snapshot: ReplacementSnapshot): boolean {
  const afterText = textRect(snapshot.change.node)
  for (const before of snapshot.constraints) {
    const afterX = Math.max(0, before.element.scrollWidth - before.element.clientWidth)
    const afterY = Math.max(0, before.element.scrollHeight - before.element.clientHeight)
    if (afterX - before.excessX > TOLERANCE || afterY - before.excessY > TOLERANCE) return false
    if (!before.clipped && clippedOutside(afterText, before.element)) return false
  }
  if (afterText !== undefined) {
    for (const before of snapshot.collisions) {
      if (!before.overlapped && overlaps(afterText, before.element.getBoundingClientRect())) return false
    }
  }
  return true
}

interface BatchSnapshot {
  readonly epoch: number
  readonly document: HTMLElement
  readonly excessX: number
  readonly replacements: readonly ReplacementSnapshot[]
}

function snapshotBatch(changes: readonly TextReplacement[]): BatchSnapshot {
  const doc = document.documentElement
  return {
    epoch: layoutEpoch,
    document: doc,
    excessX: Math.max(0, doc.scrollWidth - doc.clientWidth),
    replacements: changes.map(snapshotReplacement),
  }
}

function batchFits(before: BatchSnapshot): boolean {
  return before.epoch === layoutEpoch &&
    before.document.scrollWidth - before.document.clientWidth <= before.excessX + TOLERANCE &&
    before.replacements.every(replacementFits)
}

/** 集中写入后检查原始基线；回退时也检查整批，避免后项挤坏前项。 */
function commitReplacements(changes: readonly TextReplacement[], before = snapshotBatch(changes)): boolean {
  let ok = false
  try {
    for (const change of changes) change.node.data = change.translated
    ok = batchFits(before)
    return ok
  } finally {
    if (!ok) for (const change of changes) change.node.data = change.source
  }
}

export function tryReplaceText(node: Text, source: string, translated: string): boolean {
  const change = { node, source, translated }
  if (!canReplace(change)) return false
  const epoch = layoutEpoch
  const ok = commitReplacements([change])
  if (!ok) rejected.set(node, { source, epoch })
  return ok
}

/** 调用方按时间片传入小批次；失败先全量还原，再逐项判断。重复 Text 只接受首个有效项。 */
export function tryReplaceTexts(changes: readonly TextReplacement[]): boolean[] {
  const results = changes.map(() => false)
  const seen = new Set<Text>()
  const pending: { change: TextReplacement; index: number }[] = []
  changes.forEach((change, index) => {
    if (seen.has(change.node) || !canReplace(change)) return
    seen.add(change.node)
    pending.push({ change, index })
  })
  if (pending.length === 0) return results
  if (pending.length === 1) {
    const { change, index } = pending[0]!
    results[index] = tryReplaceText(change.node, change.source, change.translated)
    return results
  }
  const before = snapshotBatch(pending.map((item) => item.change))
  if (commitReplacements(pending.map((item) => item.change), before)) {
    for (const item of pending) results[item.index] = true
    return results
  }
  if (before.epoch !== layoutEpoch) return results
  const accepted: { change: TextReplacement; index: number }[] = []
  let completed = false
  try {
    for (const item of pending) {
      const { change, index } = item
      if (!canReplace(change)) continue
      if (commitReplacements([change], before)) {
        results[index] = true
        accepted.push(item)
      } else {
        rejected.set(change.node, { source: change.source, epoch: before.epoch })
      }
      if (before.epoch !== layoutEpoch) return results
    }
    completed = true
    return results
  } finally {
    // 异常或布局代次失效不能留下尚未被调用方登记的成功写入。
    if (!completed) for (const { change, index } of accepted) {
      change.node.data = change.source
      results[index] = false
    }
  }
}
