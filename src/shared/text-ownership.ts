import { BUILD_ID } from './build-id'

export type TextOwner = 'github' | 'web'

export interface TextOwnershipScope {
  active: boolean
}

export interface TextOwnership {
  readonly version: number
  readonly buildId: string
  /** 登记 owner 对该节点的写入值；再次登记覆盖。 */
  claim(node: Text, owner: TextOwner, written: string, scope?: TextOwnershipScope): void
  /** 只释放自己的登记；别人的不动。 */
  release(node: Text, owner: TextOwner): void
  /** 节点当前文字仍等于登记的写入值时返回所有者；否则视为过期，返回 undefined。 */
  ownerOf(node: Text): TextOwner | undefined
}

const OWNERSHIP_VERSION = 2
const OWNERSHIP_KEY = Symbol.for(`wt:text-ownership:v${OWNERSHIP_VERSION}:${BUILD_ID}`)

interface OwnershipEntry {
  readonly owner: TextOwner
  readonly written: string
  readonly scope?: TextOwnershipScope
}

function isTextOwnership(value: unknown): value is TextOwnership {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<TextOwnership>
  return (
    candidate.version === OWNERSHIP_VERSION &&
    candidate.buildId === BUILD_ID &&
    typeof candidate.claim === 'function' &&
    typeof candidate.release === 'function' &&
    typeof candidate.ownerOf === 'function'
  )
}

function createTextOwnership(): TextOwnership {
  const entries = new WeakMap<Text, OwnershipEntry>()
  return {
    version: OWNERSHIP_VERSION,
    buildId: BUILD_ID,
    claim(node, owner, written, scope) {
      entries.set(node, scope === undefined ? { owner, written } : { owner, written, scope })
    },
    release(node, owner) {
      if (entries.get(node)?.owner === owner) entries.delete(node)
    },
    ownerOf(node) {
      const entry = entries.get(node)
      if (entry === undefined) return undefined
      if (entry.scope?.active !== false && node.data === entry.written) return entry.owner
      entries.delete(node)
      return undefined
    },
  }
}

/** 两个内容脚本 bundle 共用一份：挂在 globalThis[Symbol.for('wt:text-ownership:v{VERSION}:{BUILD_ID}')]，已存在则复用。 */
export function textOwnership(): TextOwnership {
  const holder = globalThis as Record<symbol, unknown>
  const existing = holder[OWNERSHIP_KEY]
  if (isTextOwnership(existing)) return existing
  const created = createTextOwnership()
  holder[OWNERSHIP_KEY] = created
  return created
}
