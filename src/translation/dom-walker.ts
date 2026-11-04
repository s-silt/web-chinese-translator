import { canTranslateFixedFormAttributes, isExcludedElement } from './sites'

export interface WalkerJob {
  root: Node
  walker: TreeWalker
  rootPending: boolean
}

export interface DomScanner {
  queue(root: Node): void
  cancel(): void
  readonly busy: boolean
}

const ROOT_CAP = 500
const NODES_PER_TASK = 200
const TASK_MS = 8
const WRITES_PER_TASK = 20

function isPrunedElement(element: Element): boolean {
  return isExcludedElement(element) && !canTranslateFixedFormAttributes(element)
}

function filterNode(node: Node): number {
  if (node instanceof Element && isPrunedElement(node)) return NodeFilter.FILTER_REJECT
  if (node instanceof Text && (node.parentElement === null || isExcludedElement(node.parentElement))) {
    return NodeFilter.FILTER_REJECT
  }
  return NodeFilter.FILTER_ACCEPT
}

export function createDomScanner(options: {
  /** 返回本轮安排的写入尝试数，包含交给 flushWrites 提交的暂存写入。 */
  visitText: (node: Text) => number
  visitElement?: (node: Element) => number
  onIdle?: () => void
  /** 每个扫描时间片结束时提交暂存写入，先于 onIdle。 */
  flushWrites?: () => void
  stepMs?: number
  nodesPerTask?: number
  writesPerTask?: number
}): DomScanner {
  const roots: WalkerJob[] = []
  let current: WalkerJob | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const stepMs = options.stepMs ?? TASK_MS
  const nodesPerTask = options.nodesPerTask ?? NODES_PER_TASK
  const writesPerTask = options.writesPerTask ?? WRITES_PER_TASK

  function processNode(node: Node): number {
    if (node instanceof Text) return options.visitText(node)
    if (node instanceof Element) {
      // open shadow root：host 未被排除则另起一个扫描任务；closed 拿不到引用，静默跳过
      const shadow = node.shadowRoot
      if (shadow !== null && !isExcludedElement(node)) queueRoot(shadow)
      return options.visitElement?.(node) ?? 0
    }
    return 0
  }

  function makeJob(root: Node): WalkerJob {
    return {
      root,
      walker: document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filterNode),
      rootPending: true,
    }
  }

  function step(): void {
    timer = undefined
    const started = performance.now()
    let visited = 0
    let writes = 0
    while (visited < nodesPerTask && writes < writesPerTask && performance.now() - started < stepMs) {
      if (current === undefined) {
        current = roots.shift()
        if (current === undefined) {
          break
        }
      }
      if (
        !current.root.isConnected ||
        (current.root instanceof Element && isPrunedElement(current.root)) ||
        (current.root instanceof Text &&
          (current.root.parentElement === null || isExcludedElement(current.root.parentElement)))
      ) {
        current = undefined
        continue
      }
      if (current.rootPending) {
        current.rootPending = false
        visited += 1
        writes += processNode(current.root)
        continue
      }
      if (!current.root.contains(current.walker.currentNode)) {
        current.walker.currentNode = current.root
        current.rootPending = true
        continue
      }
      const node = current.walker.nextNode()
      if (node === null) {
        current = undefined
        continue
      }
      visited += 1
      writes += processNode(node)
    }
    options.flushWrites?.()
    if (current === undefined && roots.length === 0) {
      options.onIdle?.()
      return
    }
    if (timer === undefined) timer = setTimeout(step, 0)
  }

  function queueRoot(root: Node): void {
      if (!root.isConnected || (root instanceof Element && isPrunedElement(root))) return
      if (root instanceof Text && (root.parentElement === null || isExcludedElement(root.parentElement))) return
      if (roots.some((job) => job.root.contains(root))) return
      for (let i = roots.length - 1; i >= 0; i--) {
        const job = roots[i]
        if (job !== undefined && root.contains(job.root)) roots.splice(i, 1)
      }
      if (current?.root === root && current.rootPending) return
      if (roots.length >= ROOT_CAP) {
        roots.length = 0
        current = undefined
        roots.push(makeJob(document.body ?? document.documentElement))
      } else {
        roots.push(makeJob(root))
      }
      if (timer === undefined) timer = setTimeout(step, 0)
  }

  return {
    queue(root: Node): void {
      queueRoot(root)
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      roots.length = 0
      current = undefined
    },
    get busy() {
      return timer !== undefined || current !== undefined || roots.length > 0
    },
  }
}
