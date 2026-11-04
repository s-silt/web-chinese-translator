import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  clearPageContexts,
  installContextExpiry,
  recentPageContexts,
  recordPageContext,
} from '../../../src/translation/context-memory'

const KEY = 'wtReadingContext'

function page(n: number): { title: string; heading: string; site: string } {
  return { title: `t${n}`, heading: `h${n}`, site: `s${n}.example.com` }
}

async function stored(): Promise<number> {
  const env = (await fakeBrowser.storage.session.get(KEY)) as Record<string, { entries?: unknown[] }>
  const entries = env?.[KEY]?.entries
  return Array.isArray(entries) ? entries.length : -1
}

beforeEach(async () => {
  fakeBrowser.reset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_700_000_000_000)
  vi.spyOn(fakeBrowser.alarms, 'create').mockImplementation(async () => undefined as never)
  vi.spyOn(fakeBrowser.alarms, 'clear').mockImplementation(async () => true)
  installContextExpiry()
  await recentPageContexts('none', -1)
})

afterEach(async () => {
  await clearPageContexts().catch(() => undefined)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('context-memory', () => {
  it('13 条上限12，最近4条按新序', async () => {
    for (let i = 0; i < 13; i++) await recordPageContext(page(i), `p${i}`, 1)
    expect(await stored()).toBe(12)
    const recent = await recentPageContexts('none', -1)
    expect(recent.map((p) => p.title)).toEqual(['t12', 't11', 't10', 't9'])
  })

  it('同 pageId+tabId 成对排除，其它保留', async () => {
    await recordPageContext(page(1), 'same-id', 1)
    await recordPageContext(page(2), 'same-id', 2)
    await recordPageContext(page(3), 'other-id', 1)
    const recent = await recentPageContexts('same-id', 1)
    expect(recent.map((p) => p.title)).toEqual(['t3', 't2'])
  })

  it('同元数据更新去重仅留一条', async () => {
    await recordPageContext(page(5), 'a1', 1)
    await recordPageContext(page(5), 'a2', 1)
    expect(await stored()).toBe(1)
  })

  it('过期/未来/非法项被过滤', async () => {
    const now = Date.now()
    await fakeBrowser.storage.session.set({
      [KEY]: {
        entries: [
          { page: page(1), at: now - 30 * 60 * 1000, tabId: 1, pageId: 'x1' },
          { page: page(2), at: now + 60000, tabId: 1, pageId: 'x2' },
          { page: page(3), at: Number.NaN, tabId: 1, pageId: 'x3' },
          { page: page(4), at: now, tabId: -5, pageId: 'x4' },
          { page: page(5), at: now - 1000, tabId: 1, pageId: 'x5' },
        ],
      },
    })
    const recent = await recentPageContexts('none', -1)
    expect(recent.map((p) => p.title)).toEqual(['t5'])
  })

  it('安装设置 TRUSTED_CONTEXTS', async () => {
    const session = fakeBrowser.storage.session as unknown as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> }
    const setLevel = vi.fn(async () => undefined)
    session.setAccessLevel = setLevel
    installContextExpiry()
    await Promise.resolve()
    expect(setLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
  })

  it('alarm 到期后清空存储并清除下次 alarm', async () => {
    const create = vi.mocked(fakeBrowser.alarms.create)
    const clear = vi.mocked(fakeBrowser.alarms.clear)
    create.mockClear()
    clear.mockClear()
    const createdAt = Date.now()
    await recordPageContext(page(1), 'p1', 1)
    expect(create).toHaveBeenCalledWith('wt-context-expiry', { when: createdAt + 1_800_000 })
    expect(clear).not.toHaveBeenCalled()
    vi.setSystemTime(createdAt + 1_800_000)
    const onAlarm = fakeBrowser.alarms.onAlarm as { hasListeners?: () => boolean }
    expect(onAlarm.hasListeners?.() ?? true).toBe(true)
    await fakeBrowser.alarms.onAlarm.trigger({ name: 'wt-context-expiry' } as never)
    await recentPageContexts('none', -1)
    const env = (await fakeBrowser.storage.session.get(KEY)) as Record<string, { entries?: unknown[] }>
    expect(env?.[KEY]?.entries).toBeUndefined()
    expect(clear).toHaveBeenCalledWith('wt-context-expiry')
  })

  it('clear 后无残留条目', async () => {
    await recordPageContext(page(1), 'p1', 1)
    await clearPageContexts()
    const env = (await fakeBrowser.storage.session.get(KEY)) as Record<string, { entries?: unknown[] }>
    expect(env?.[KEY]?.entries).toBeUndefined()
    expect(await recentPageContexts('none', -1)).toEqual([])
  })
})
