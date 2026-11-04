import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchReadingSignals, type ReadingCandidate } from '../../../src/translation/reading-signals'

function over(el: Element): Event {
  const e = new Event('pointerover')
  Object.defineProperties(e, { isTrusted: { value: true }, target: { value: el } })
  return e
}
function out(el: Element): Event {
  const e = new Event('pointerout')
  Object.defineProperties(e, { isTrusted: { value: true }, target: { value: el }, relatedTarget: { value: null } })
  return e
}

let now = 0
let watcher: { dispose(): void; reset(): void } | undefined

beforeEach(() => {
  now = 0
  document.body.innerHTML = '<main><p>Some sufficiently long english paragraph for testing.</p></main>'
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
  )
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})
afterEach(() => {
  watcher?.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function start(candidates: ReadingCandidate[]): void {
  watcher = watchReadingSignals({
    enabled: () => true,
    hasActiveSelection: () => false,
    onCandidate: (c) => candidates.push(c),
    now: () => now,
  })
}

describe('reading-signals', () => {
  it('持续浏览新段落时淘汰最早的停留记录，即使旧节点仍连接在页面上', async () => {
    vi.useFakeTimers()
    const candidates: ReadingCandidate[] = []
    start(candidates)
    const original = document.querySelector('p')!
    document.dispatchEvent(over(original))
    now += 2000
    document.dispatchEvent(out(original))
    for (let i = 0; i < 65; i += 1) {
      const paragraph = document.createElement('p')
      paragraph.textContent = `Reading paragraph ${i} about quantum information in a large article.`
      document.querySelector('main')!.append(paragraph)
      document.dispatchEvent(over(paragraph))
      now += 10
      document.dispatchEvent(out(paragraph))
    }
    now += 800
    document.dispatchEvent(over(original))
    now += 2000
    await vi.advanceTimersByTimeAsync(2000)
    expect(candidates).toHaveLength(0)
    document.dispatchEvent(out(original))
    now += 800
    document.dispatchEvent(over(original))
    now += 1600
    await vi.advanceTimersByTimeAsync(1600)
    expect(candidates).toHaveLength(1)
  })

  it('两次访问累计 3500ms 发一次候选', async () => {
    vi.useFakeTimers()
    const candidates: ReadingCandidate[] = []
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    start(candidates)
    const p = document.querySelector('p')!
    document.dispatchEvent(over(p))
    now += 2000
    document.dispatchEvent(out(p))
    now += 800
    document.dispatchEvent(over(p))
    now += 1500
    await vi.advanceTimersByTimeAsync(1600)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.dwellMs).toBeGreaterThanOrEqual(3500)
    expect(candidates[0]!.visits).toBe(2)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
    vi.useRealTimers()
  })

  it('首次访问不发射', async () => {
    const candidates: ReadingCandidate[] = []
    start(candidates)
    const p = document.querySelector('p')!
    document.dispatchEvent(over(p))
    now += 5000
    await Promise.resolve()
    expect(candidates).toHaveLength(0)
  })

  it('非受信事件不记录', async () => {
    const candidates: ReadingCandidate[] = []
    start(candidates)
    const p = document.querySelector('p')!
    const e = new Event('pointerover')
    Object.defineProperty(e, 'target', { value: p })
    document.dispatchEvent(e)
    now += 5000
    document.dispatchEvent(out(p))
    document.dispatchEvent(over(p))
    now += 5000
    await Promise.resolve()
    expect(candidates).toHaveLength(0)
  })

  it('reset 后需重新两次访问', async () => {
    const candidates: ReadingCandidate[] = []
    start(candidates)
    const p = document.querySelector('p')!
    document.dispatchEvent(over(p))
    now += 2000
    document.dispatchEvent(out(p))
    now += 800
    watcher!.reset()
    document.dispatchEvent(over(p))
    now += 5000
    await Promise.resolve()
    expect(candidates).toHaveLength(0)
    document.dispatchEvent(out(p))
    now += 800
    document.dispatchEvent(over(p))
    now += 3500
    await Promise.resolve()
    expect(candidates).toHaveLength(1)
  })

  it('predicate 接受含 CJK 的段落，输入焦点与隐藏段落仍不产生候选', async () => {
    vi.useFakeTimers()
    const text = '这是一段足够长的中文说明，用来确认阅读信号可以接受含有汉字的候选。'
    document.body.innerHTML = `<main><p id="visible">${text}</p><p id="hidden" hidden>${text}</p><input></main>`
    const candidates: ReadingCandidate[] = []
    watcher = watchReadingSignals({
      enabled: () => true,
      hasActiveSelection: () => false,
      acceptText: () => true,
      onCandidate: (candidate) => candidates.push(candidate),
      now: () => now,
    })
    const hidden = document.querySelector('#hidden')!
    document.dispatchEvent(over(hidden))
    now += 2000
    document.dispatchEvent(out(hidden))
    now += 800
    document.dispatchEvent(over(hidden))
    now += 1500
    await vi.advanceTimersByTimeAsync(1600)
    expect(candidates).toHaveLength(0)

    const input = document.querySelector('input')!
    const visible = document.querySelector('#visible')!
    input.focus()
    document.dispatchEvent(over(visible))
    now += 2000
    document.dispatchEvent(out(visible))
    now += 800
    document.dispatchEvent(over(visible))
    now += 1500
    await vi.advanceTimersByTimeAsync(1600)
    expect(candidates).toHaveLength(0)

    input.blur()
    document.dispatchEvent(out(visible))
    now += 800
    document.dispatchEvent(over(visible))
    now += 2000
    document.dispatchEvent(out(visible))
    now += 800
    document.dispatchEvent(over(visible))
    now += 1500
    await vi.advanceTimersByTimeAsync(1600)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.text).toBe(text)
  })
})
