import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDomScanner } from '../../../src/translation/dom-walker'

function collect(): { texts: string[]; visitText: (node: Text) => number } {
  const texts: string[] = []
  return {
    texts,
    visitText(node) {
      texts.push(node.nodeValue ?? '')
      return 0
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('dom-walker 扫描器', () => {
  it('每个切片提交暂存写入，空闲通知看到已提交结果', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<p>first</p><p>second</p>'
    const pending: string[] = []
    const applied: string[] = []
    const idle: string[][] = []
    const events: string[] = []
    const scanner = createDomScanner({
      visitText(node) { events.push(`visit:${node.data}`); pending.push(node.data); return 1 },
      writesPerTask: 1,
      flushWrites() {
        if (pending.length > 0) events.push(`flush:${pending.join(',')}`)
        applied.push(...pending.splice(0))
      },
      onIdle() { events.push('idle'); idle.push([...applied]) },
    })
    scanner.queue(document.body)
    await vi.advanceTimersByTimeAsync(100)
    expect(applied).toEqual(['first', 'second'])
    expect(idle.at(-1)).toEqual(applied)
    expect(events).toEqual(['visit:first', 'flush:first', 'visit:second', 'flush:second', 'idle'])
    scanner.cancel()
  })

  it('深度 40 每个文本恰好一次，排除子树不访问', async () => {
    vi.useFakeTimers()
    let html = ''
    for (let i = 0; i < 40; i += 1) html += `<div id="d${i}">text-${i}`
    html += '<code><p>excluded text</p></code>'
    for (let i = 0; i < 40; i += 1) html += '</div>'
    document.body.innerHTML = html
    const { texts, visitText } = collect()
    const scanner = createDomScanner({ visitText, nodesPerTask: 5 })
    scanner.queue(document.body)
    await vi.advanceTimersByTimeAsync(2000)
    for (let i = 0; i < 40; i += 1) {
      expect(texts.filter((t) => t === `text-${i}`)).toHaveLength(1)
    }
    expect(texts).not.toContain('excluded text')
    scanner.cancel()
  })

  it('当前元素被移除后扫描继续，不访问分离子树', async () => {
    vi.useFakeTimers()
    document.body.innerHTML =
      '<div id="a"><p>a-text</p></div><div id="b"><p>b-text</p></div><div id="c"><p>c-text</p></div>'
    const { texts, visitText } = collect()
    const scanner = createDomScanner({ visitText, nodesPerTask: 3 })
    scanner.queue(document.body)
    await vi.runOnlyPendingTimersAsync()
    document.querySelector('#a')?.remove()
    await vi.advanceTimersByTimeAsync(5000)
    expect(texts).toContain('b-text')
    expect(texts).toContain('c-text')
    expect(texts).not.toContain('a-text')
    scanner.cancel()
  })

  it('超过根上限折叠为整页扫描，尾部兄弟仍被访问', async () => {
    vi.useFakeTimers()
    let html = ''
    for (let i = 0; i < 510; i += 1) html += `<div id="r${i}"><p>root-text-${i}</p></div>`
    document.body.innerHTML = html
    const { texts, visitText } = collect()
    const scanner = createDomScanner({ visitText })
    for (let i = 0; i < 510; i += 1) {
      scanner.queue(document.getElementById(`r${i}`)!)
    }
    await vi.advanceTimersByTimeAsync(8000)
    expect(texts).toContain('root-text-0')
    expect(texts).toContain('root-text-509')
    scanner.cancel()
  })

  it('取消后不再处理剩余工作', async () => {
    vi.useFakeTimers()
    let html = ''
    for (let i = 0; i < 50; i += 1) html += `<div><p>tail-text-${i}</p></div>`
    document.body.innerHTML = html
    const { texts, visitText } = collect()
    const scanner = createDomScanner({ visitText, nodesPerTask: 3 })
    scanner.queue(document.body)
    await vi.advanceTimersByTimeAsync(2)
    const before = texts.length
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(50)
    scanner.cancel()
    await vi.advanceTimersByTimeAsync(5000)
    expect(texts).toHaveLength(before)
  })
})
