import type { BrowserContext, CDPSession, Page } from '@playwright/test'

interface CdpNode {
  readonly nodeId: number
  readonly backendNodeId: number
  readonly attributes?: readonly string[]
  readonly children?: readonly CdpNode[]
  readonly shadowRoots?: readonly CdpNode[]
  readonly shadowRootType?: 'user-agent' | 'open' | 'closed'
  readonly contentDocument?: CdpNode
}

interface ExecutionContextDescription {
  readonly id: number
  readonly name: string
  readonly origin: string
  readonly auxData?: {
    readonly isDefault?: boolean
    readonly type?: string
    readonly frameId?: string
  }
}

const UTILITY_WORLD_PREFIX = '__playwright_utility_world'

const inspectedContexts = new WeakSet<BrowserContext>()
const pageInspections = new WeakMap<Page, Promise<void>>()

function hasWtRootAttribute(attributes: readonly string[] | undefined): boolean {
  if (attributes === undefined) return false
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === 'data-wt-root') return true
  }
  return false
}

function collectClosedWtRoots(node: CdpNode, out: Set<number>, parentIsWtHost = false): void {
  const isWtHost = hasWtRootAttribute(node.attributes)
  if (node.shadowRootType === 'closed' && parentIsWtHost) {
    out.add(node.backendNodeId)
  }
  if (node.shadowRoots !== undefined) {
    for (const root of node.shadowRoots) {
      if (isWtHost && root.shadowRootType === 'closed') {
        out.add(root.backendNodeId)
      }
      collectClosedWtRoots(root, out, isWtHost)
    }
  }
  if (node.children !== undefined) {
    for (const child of node.children) {
      collectClosedWtRoots(child, out, false)
    }
  }
  if (node.contentDocument !== undefined) {
    collectClosedWtRoots(node.contentDocument, out, false)
  }
}

function isIgnorableCdpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Target closed') ||
    message.includes('Session closed') ||
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id') ||
    message.includes('No node with given id found') ||
    message.includes('Could not find node with given id') ||
    message.includes('Node with given id does not belong to the document') ||
    message.includes('Inspected target navigated or closed') ||
    message.includes('Protocol error') && message.includes('closed')
  )
}

const REGISTER_CLOSED_ROOT_FN = `function() {
  const root = this;
  if (!root || typeof root !== 'object' || !root.host) return false;
  const g = globalThis;
  let map = g.__wtClosedShadowRoots;
  if (!map) {
    map = new WeakMap();
    Object.defineProperty(g, '__wtClosedShadowRoots', {
      value: map,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot');
    if (desc && typeof desc.get === 'function') {
      const origGet = desc.get;
      Object.defineProperty(Element.prototype, 'shadowRoot', {
        configurable: true,
        enumerable: desc.enumerable ?? true,
        get: function() {
          const nativeRoot = origGet.call(this);
          if (nativeRoot) return nativeRoot;
          return map.get(this) ?? null;
        },
      });
    }
  }
  map.set(root.host, root);
  return true;
}`

class PageClosedShadowInspector {
  private readonly page: Page
  private session: CDPSession | undefined
  private detached = false
  private readonly utilityContexts = new Set<number>()
  private readonly closedRootBackendIds = new Set<number>()
  private readonly boundPairs = new Set<string>()
  private readonly hostNodeIds = new Set<number>()
  private pendingQueue: Promise<void> = Promise.resolve()

  constructor(page: Page) {
    this.page = page
  }

  async start(): Promise<void> {
    if (this.page.isClosed()) return
    const session = await this.page.context().newCDPSession(this.page)
    this.session = session

    // 页面关闭时会话随目标一起失效，不再主动 detach：关闭上下文期间目标已在拆除，detach 可能一直挂起并拖住 context.close()
    this.page.once('close', () => {
      this.detached = true
      this.utilityContexts.clear()
      this.closedRootBackendIds.clear()
      this.boundPairs.clear()
      this.hostNodeIds.clear()
    })

    session.on('Runtime.executionContextCreated', (event: { context: ExecutionContextDescription }) => {
      const ctx = event.context
      if (ctx.name.startsWith(UTILITY_WORLD_PREFIX) && ctx.auxData?.isDefault !== true) {
        this.utilityContexts.add(ctx.id)
        this.enqueue(async () => {
          await this.syncAllToContext(ctx.id)
        })
      }
    })

    session.on('Runtime.executionContextDestroyed', (event: { executionContextId: number }) => {
      this.utilityContexts.delete(event.executionContextId)
      for (const key of [...this.boundPairs]) {
        if (key.startsWith(`${event.executionContextId}:`)) this.boundPairs.delete(key)
      }
    })

    session.on('Runtime.executionContextsCleared', () => {
      this.utilityContexts.clear()
      this.boundPairs.clear()
    })

    session.on('DOM.documentUpdated', () => {
      this.closedRootBackendIds.clear()
      this.boundPairs.clear()
      this.hostNodeIds.clear()
      this.enqueue(async () => {
        await this.scanFullDocument()
      })
    })

    session.on('DOM.childNodeInserted', (event: { node: CdpNode }) => {
      const node = event.node
      if (hasWtRootAttribute(node.attributes)) {
        this.hostNodeIds.add(node.nodeId)
      }
      const discovered = new Set<number>()
      collectClosedWtRoots(node, discovered, false)
      if (discovered.size > 0) {
        for (const id of discovered) this.closedRootBackendIds.add(id)
        this.enqueue(async () => {
          for (const id of discovered) {
            await this.syncRootToAllContexts(id)
          }
        })
      } else if (hasWtRootAttribute(node.attributes)) {
        this.enqueue(async () => {
          await this.describeAndSyncNode(node.backendNodeId)
        })
      }
    })

    session.on('DOM.shadowRootPushed', (event: { hostId: number; root: CdpNode }) => {
      if (event.root.shadowRootType !== 'closed') return
      const rootBackendId = event.root.backendNodeId
      if (this.hostNodeIds.has(event.hostId)) {
        this.closedRootBackendIds.add(rootBackendId)
        this.enqueue(async () => {
          await this.syncRootToAllContexts(rootBackendId)
        })
        return
      }
      this.enqueue(async () => {
        if (this.detached || this.session === undefined) return
        try {
          const { node } = (await this.session.send('DOM.describeNode', {
            nodeId: event.hostId,
            depth: 1,
            pierce: true,
          })) as { node: CdpNode }
          if (hasWtRootAttribute(node.attributes)) {
            this.hostNodeIds.add(event.hostId)
            this.closedRootBackendIds.add(rootBackendId)
            await this.syncRootToAllContexts(rootBackendId)
          }
        } catch (error) {
          if (!isIgnorableCdpError(error)) throw error
        }
      })
    })

    await session.send('Runtime.enable')
    await session.send('DOM.enable')
    await this.scanFullDocument()
    await this.pendingQueue
  }

  async flush(): Promise<void> {
    await this.scanFullDocument()
    await this.pendingQueue
  }

  private enqueue(task: () => Promise<void>): void {
    this.pendingQueue = this.pendingQueue.then(task).catch((error) => {
      if (!isIgnorableCdpError(error)) throw error
    })
  }

  private recordHostsFromTree(node: CdpNode): void {
    if (hasWtRootAttribute(node.attributes)) {
      this.hostNodeIds.add(node.nodeId)
    }
    if (node.children !== undefined) {
      for (const child of node.children) this.recordHostsFromTree(child)
    }
    if (node.shadowRoots !== undefined) {
      for (const root of node.shadowRoots) this.recordHostsFromTree(root)
    }
    if (node.contentDocument !== undefined) {
      this.recordHostsFromTree(node.contentDocument)
    }
  }

  private async describeAndSyncNode(backendNodeId: number): Promise<void> {
    if (this.detached || this.session === undefined) return
    try {
      const { node } = (await this.session.send('DOM.describeNode', {
        backendNodeId,
        depth: 2,
        pierce: true,
      })) as { node: CdpNode }
      const discovered = new Set<number>()
      collectClosedWtRoots(node, discovered, false)
      for (const id of discovered) {
        this.closedRootBackendIds.add(id)
        await this.syncRootToAllContexts(id)
      }
    } catch (error) {
      if (!isIgnorableCdpError(error)) throw error
    }
  }

  private async scanFullDocument(): Promise<void> {
    if (this.detached || this.session === undefined || this.page.isClosed()) return
    try {
      const { root } = (await this.session.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      })) as { root: CdpNode }
      this.recordHostsFromTree(root)
      const discovered = new Set<number>()
      collectClosedWtRoots(root, discovered, false)
      for (const id of discovered) {
        this.closedRootBackendIds.add(id)
      }
      for (const id of this.closedRootBackendIds) {
        await this.syncRootToAllContexts(id)
      }
    } catch (error) {
      if (!isIgnorableCdpError(error)) throw error
    }
  }

  private async syncAllToContext(executionContextId: number): Promise<void> {
    if (this.closedRootBackendIds.size === 0) {
      await this.scanFullDocument()
    }
    for (const backendNodeId of this.closedRootBackendIds) {
      await this.bindRootInContext(backendNodeId, executionContextId)
    }
  }

  private async syncRootToAllContexts(backendNodeId: number): Promise<void> {
    for (const executionContextId of this.utilityContexts) {
      await this.bindRootInContext(backendNodeId, executionContextId)
    }
  }

  private async bindRootInContext(backendNodeId: number, executionContextId: number): Promise<void> {
    if (this.detached || this.session === undefined || this.page.isClosed()) return
    const pairKey = `${executionContextId}:${backendNodeId}`
    if (this.boundPairs.has(pairKey)) return
    let objectId: string | undefined
    try {
      const resolved = (await this.session.send('DOM.resolveNode', {
        backendNodeId,
        executionContextId,
      })) as { object?: { objectId?: string } }
      objectId = resolved.object?.objectId
      if (objectId === undefined) return
      const called = (await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: REGISTER_CLOSED_ROOT_FN,
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: boolean } }
      if (called.result?.value === true) {
        this.boundPairs.add(pairKey)
      }
    } catch (error) {
      if (!isIgnorableCdpError(error)) throw error
    } finally {
      if (objectId !== undefined && !this.detached && this.session !== undefined) {
        await this.session.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
      }
    }
  }
}

const pageInspectors = new WeakMap<Page, PageClosedShadowInspector>()

export async function inspectClosedShadowPage(page: Page): Promise<void> {
  if (page.isClosed() || page.url().startsWith('chrome-extension://')) return
  let existing = pageInspections.get(page)
  if (existing === undefined) {
    const inspector = new PageClosedShadowInspector(page)
    pageInspectors.set(page, inspector)
    existing = inspector.start()
    pageInspections.set(page, existing)
  }
  await existing
  const inspector = pageInspectors.get(page)
  if (inspector !== undefined) {
    await inspector.flush()
  }
}

export async function installClosedShadowInspection(context: BrowserContext): Promise<void> {
  if (!inspectedContexts.has(context)) {
    inspectedContexts.add(context)
    context.on('page', (page) => {
      void inspectClosedShadowPage(page).catch((error) => {
        if (!isIgnorableCdpError(error)) throw error
      })
    })
  }
  await Promise.all(context.pages().map((page) => inspectClosedShadowPage(page)))
}
