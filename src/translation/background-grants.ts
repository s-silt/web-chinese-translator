import { browser } from 'wxt/browser'
import type { MessageSender } from './background-sender'
import type { ManualSelectionSnapshot } from './selection'

export interface SelectionDocument {
  readonly frameId: number
  readonly documentId: string
  readonly url: string
}

export interface ManualGrant {
  readonly id: string
  readonly top: SelectionDocument
  readonly source: SelectionDocument
  readonly text: string
  readonly expires: number
  claimedBy?: string
}

export interface RawInjectionSnapshot {
  readonly frameId: number
  readonly documentId: string
  readonly snapshot: ManualSelectionSnapshot
}

export const manualGrants = new Map<number, ManualGrant>()
export const MANUAL_GRANT_MS = 15000
export const MANUAL_GRANT_MAX = 32

export function pruneManualGrants(): void {
  const now = Date.now()
  for (const [tabId, grant] of manualGrants) {
    if (grant.claimedBy === undefined && grant.expires <= now) manualGrants.delete(tabId)
  }
}

export function clearManualGrants(): void {
  manualGrants.clear()
}

export function isManualSelectionSnapshot(value: unknown): value is ManualSelectionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.url === 'string' &&
    typeof record.focused === 'boolean' &&
    typeof record.text === 'string' &&
    typeof record.frameFocused === 'boolean'
  )
}

export function parseInjectionSnapshots(results: unknown): RawInjectionSnapshot[] {
  if (!Array.isArray(results)) return []
  const parsed: RawInjectionSnapshot[] = []
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { frameId?: unknown; documentId?: unknown; result?: unknown }
    if (
      typeof entry.frameId === 'number' &&
      typeof entry.documentId === 'string' &&
      entry.documentId !== '' &&
      isManualSelectionSnapshot(entry.result)
    ) {
      parsed.push({
        frameId: entry.frameId,
        documentId: entry.documentId,
        snapshot: entry.result,
      })
    }
  }
  return parsed
}

export function readDocumentHref(): string {
  return location.href
}

export async function verifySelectionDocuments(tabId: number, grant: ManualGrant): Promise<boolean> {
  const scripting = browser.scripting
  if (typeof scripting?.executeScript !== 'function') return false
  const documentIds =
    grant.top.documentId === grant.source.documentId
      ? [grant.top.documentId]
      : [grant.top.documentId, grant.source.documentId]
  try {
    const results = await scripting.executeScript({
      target: { tabId, documentIds },
      func: readDocumentHref,
    })
    if (!Array.isArray(results) || results.length !== documentIds.length) return false
    const matchesDoc = (expected: SelectionDocument): boolean =>
      results.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { frameId?: unknown }).frameId === expected.frameId &&
          (item as { documentId?: unknown }).documentId === expected.documentId &&
          (item as { result?: unknown }).result === expected.url,
      )
    return matchesDoc(grant.top) && matchesDoc(grant.source)
  } catch {
    return false
  }
}

export function activeGrantForTicket(
  tabId: number,
  ticketId: string,
  text: string,
  sender?: MessageSender,
  requestKey?: string,
): ManualGrant | undefined {
  pruneManualGrants()
  const grant = manualGrants.get(tabId)
  if (grant === undefined || grant.id !== ticketId || grant.text !== text) return undefined
  if (grant.claimedBy !== undefined && grant.claimedBy !== requestKey) return undefined
  const leased = requestKey !== undefined && grant.claimedBy === requestKey
  if (!leased && Date.now() >= grant.expires) {
    manualGrants.delete(tabId)
    return undefined
  }
  if (sender !== undefined) {
    if (
      sender.tab?.id !== tabId ||
      sender.frameId !== 0 ||
      sender.documentId !== grant.top.documentId ||
      sender.url !== grant.top.url
    ) {
      return undefined
    }
  }
  return grant
}

export async function verifyManualTicket(
  sender: MessageSender,
  text: string,
  ticketId: string,
  requestKey?: string,
): Promise<ManualGrant | undefined> {
  const tabId = sender.tab?.id
  if (typeof tabId !== 'number') return undefined
  const grant = activeGrantForTicket(tabId, ticketId, text, sender, requestKey)
  if (grant === undefined) return undefined
  const alive = await verifySelectionDocuments(tabId, grant)
  if (!alive) {
    if (manualGrants.get(tabId)?.id === ticketId) manualGrants.delete(tabId)
    return undefined
  }
  return activeGrantForTicket(tabId, ticketId, text, sender, requestKey)
}
