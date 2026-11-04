import { browser } from 'wxt/browser'
import { normalizeOrigin } from './config'
import { pageIdentity } from './page-lifecycle'

export interface ManualPageGrant {
  readonly id: string
  readonly tabId: number
  readonly documentId: string
  readonly url: string
}

export function sameManualPage(left: string, right: string): boolean {
  return normalizeOrigin(left) !== '' && normalizeOrigin(right) !== '' &&
    pageIdentity(left) === pageIdentity(right)
}

const KEY = 'wt:manual-pages:v1'
const MAX_GRANTS = 32
let queue: Promise<void> = Promise.resolve()

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work)
  queue = next.then(() => undefined, () => undefined)
  return next
}

function validGrant(value: unknown): value is ManualPageGrant {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128 &&
    typeof item.tabId === 'number' && Number.isSafeInteger(item.tabId) && item.tabId >= 0 &&
    typeof item.documentId === 'string' && item.documentId.length > 0 && item.documentId.length <= 128 &&
    typeof item.url === 'string' && item.url.length <= 8192 && normalizeOrigin(item.url) !== ''
}

async function readGrants(): Promise<ManualPageGrant[]> {
  const stored = await browser.storage.session.get(KEY)
  const value: unknown = stored[KEY]
  return Array.isArray(value) ? value.filter(validGrant).slice(-MAX_GRANTS) : []
}

export function getManualPageGrant(tabId: number, documentId: string, url: string): Promise<ManualPageGrant | undefined> {
  return exclusive(async () => (await readGrants()).find(
    (grant) => grant.tabId === tabId && grant.documentId === documentId && sameManualPage(grant.url, url),
  ))
}

export function putManualPageGrant(grant: ManualPageGrant): Promise<void> {
  return exclusive(async () => {
    if (!validGrant(grant)) throw new Error('本页翻译授权无效')
    const grants = (await readGrants()).filter((item) => item.tabId !== grant.tabId)
    await browser.storage.session.set({ [KEY]: [...grants, grant].slice(-MAX_GRANTS) })
  })
}

function removeGrants(predicate: (grant: ManualPageGrant) => boolean): Promise<void> {
  return exclusive(async () => {
    const current = await readGrants()
    const next = current.filter((grant) => !predicate(grant))
    if (next.length !== current.length) await browser.storage.session.set({ [KEY]: next })
  })
}

export function revokeManualPageGrant(tabId: number, expectedId?: string): Promise<void> {
  return removeGrants((grant) => grant.tabId === tabId && (expectedId === undefined || grant.id === expectedId))
}

export function expireNavigatedManualPage(tabId: number, url: string): Promise<void> {
  return removeGrants((grant) => grant.tabId === tabId && !sameManualPage(grant.url, url))
}

export function clearManualPages(): Promise<void> {
  return exclusive(() => browser.storage.session.remove(KEY))
}
