import { browser } from 'wxt/browser'
import { isPageContext, isPageId, type PageContext } from './reading-context'

const KEY = 'wtReadingContext'
const MAX_ENTRIES = 12
const TTL_MS = 30 * 60 * 1000
const RECENT_LIMIT = 4
const EXPIRY_ALARM = 'wt-context-expiry'

interface Entry {
  readonly page: PageContext
  readonly at: number
  readonly tabId: number
  readonly pageId: string
}

let generation = 0
let queue: Promise<void> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const pending = queue.then(task, task)
  queue = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

function reportError(): void {
  console.error('[网页汉化助手] 阅读上下文存储失败')
}

async function readEntries(): Promise<Entry[]> {
  const envelope = (await (browser.storage.session.get as (key: string) => Promise<Record<string, unknown>>)(
    KEY,
  )) as Record<string, unknown>
  const stored = envelope?.[KEY] as { entries?: unknown } | undefined
  if (stored === undefined || stored === null || typeof stored !== 'object' || !Array.isArray(stored.entries)) {
    return []
  }
  const now = Date.now()
  return (stored.entries as unknown[])
    .slice(-MAX_ENTRIES)
    .filter(
      (entry): entry is Entry =>
        typeof entry === 'object' &&
        entry !== null &&
        isPageContext((entry as Entry).page) &&
        Number.isFinite((entry as Entry).at) &&
        (entry as Entry).at > now - TTL_MS &&
        (entry as Entry).at <= now &&
        Number.isInteger((entry as Entry).tabId) &&
        (entry as Entry).tabId >= 0 &&
        isPageId((entry as Entry).pageId),
    )
    .sort((a, b) => a.at - b.at)
}

async function scheduleExpiry(entries: readonly Entry[]): Promise<void> {
  if (typeof browser.alarms?.create !== 'function') return
  if (entries.length === 0) {
    await browser.alarms.clear(EXPIRY_ALARM).catch(() => false)
    return
  }
  const oldest = entries.reduce((min, entry) => Math.min(min, entry.at), Number.MAX_SAFE_INTEGER)
  await browser.alarms.create(EXPIRY_ALARM, { when: oldest + TTL_MS })
}

async function pruneExpired(): Promise<void> {
  const entries = await readEntries()
  if (entries.length === 0) {
    await browser.storage.session.remove(KEY)
    await scheduleExpiry([])
    return
  }
  await browser.storage.session.set({ [KEY]: { entries } })
  await scheduleExpiry(entries)
}

export function recordPageContext(page: PageContext, pageId: string, tabId: number): Promise<void> {
  const gen = generation
  return serialized(async () => {
    if (gen !== generation) return
    const dedupeKey = JSON.stringify([page.site, page.title, page.heading])
    const entries = (await readEntries()).filter(
      (entry) =>
        !(entry.pageId === pageId && entry.tabId === tabId) &&
        JSON.stringify([entry.page.site, entry.page.title, entry.page.heading]) !== dedupeKey,
    )
    entries.push({ page, at: Date.now(), tabId, pageId })
    const trimmed = entries.slice(-MAX_ENTRIES)
    if (gen !== generation) return
    await browser.storage.session.set({ [KEY]: { entries: trimmed } })
    await scheduleExpiry(trimmed)
  })
}

export async function recentPageContexts(excludePageId: string, excludeTabId = -1): Promise<PageContext[]> {
  try {
    return await serialized(async () => {
      const entries = await readEntries()
      const seen = new Set<string>()
      const recent: PageContext[] = []
      for (const entry of [...entries].reverse()) {
        if (entry.pageId === excludePageId && entry.tabId === excludeTabId) continue
        const key = JSON.stringify([entry.page.site, entry.page.title, entry.page.heading])
        if (seen.has(key)) continue
        seen.add(key)
        recent.push(entry.page)
        if (recent.length >= RECENT_LIMIT) break
      }
      return recent
    })
  } catch {
    return []
  }
}

export function clearPageContexts(): Promise<void> {
  generation += 1
  return serialized(async () => {
    await browser.storage.session.remove(KEY)
    if (typeof browser.alarms?.clear === 'function') await browser.alarms.clear(EXPIRY_ALARM).catch(() => false)
  })
}

function onExpiryAlarm(alarm: { name: string }): void {
  if (alarm.name !== EXPIRY_ALARM) return
  void serialized(pruneExpired).catch(reportError)
}

export function installContextExpiry(): void {
  if (typeof browser.alarms?.onAlarm?.addListener !== 'function') return
  try {
    const session = browser.storage.session as unknown as {
      setAccessLevel?: (opts: { accessLevel: string }) => Promise<void>
    }
    void session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => undefined)
    const alarms = browser.alarms.onAlarm as unknown as {
      hasListener?: (fn: (alarm: { name: string }) => void) => boolean
      addListener(fn: (alarm: { name: string }) => void): void
    }
    if (alarms.hasListener?.(onExpiryAlarm) !== true) alarms.addListener(onExpiryAlarm)
    void serialized(pruneExpired).catch(reportError)
  } catch {
    reportError()
  }
}
