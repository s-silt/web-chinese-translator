import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPageContextTracker } from '../../../src/translation/page-context-tracker'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('page-context-tracker', () => {
  it('8 秒后上报一次', async () => {
    const send = vi.fn(async () => true)
    const tracker = createPageContextTracker({ enabled: () => true, pageId: () => 'p1', send })
    tracker.refresh()
    await vi.advanceTimersByTimeAsync(8000)
    expect(send).toHaveBeenCalledTimes(1)
    tracker.refresh()
    await vi.advanceTimersByTimeAsync(8000)
    expect(send).toHaveBeenCalledTimes(1)
    tracker.dispose()
  })

  it('关闭后再开启重新计时上报；旧 ack 不标记', async () => {
    let resolve!: (v: boolean) => void
    const send = vi.fn(() => new Promise<boolean>((r) => (resolve = r)))
    let enabled = true
    const tracker = createPageContextTracker({ enabled: () => enabled, pageId: () => 'p1', send })
    tracker.refresh()
    await vi.advanceTimersByTimeAsync(8000)
    expect(send).toHaveBeenCalledTimes(1)
    enabled = false
    tracker.refresh()
    resolve(true)
    await Promise.resolve()
    enabled = true
    tracker.refresh()
    await vi.advanceTimersByTimeAsync(8000)
    expect(send).toHaveBeenCalledTimes(2)
    tracker.dispose()
  })

  it('失焦期间不触发上报', async () => {
    const send = vi.fn(async () => true)
    const tracker = createPageContextTracker({ enabled: () => true, pageId: () => 'p1', send })
    tracker.refresh()
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(9000)
    expect(send).not.toHaveBeenCalled()
    tracker.dispose()
  })
})
