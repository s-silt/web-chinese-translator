import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readManualSelection,
  readSelectionText,
  watchSelection,
  type SelectionWatcher,
} from '../../../src/translation/selection'

const trusted = { isTrusted: true } as Event
const inside = () => false

function makeSelection(text: string, start = 0, end?: number): void {
  const p = document.querySelector('p')!
  if (p.firstChild === null) p.textContent = text
  const sel = window.getSelection()!
  const range = document.createRange()
  range.setStart(p.firstChild!, start)
  range.setEnd(p.firstChild!, end ?? text.length)
  sel.removeAllRanges()
  sel.addRange(range)
}

let watcher: SelectionWatcher | undefined
beforeEach(() => {
  document.body.innerHTML = '<p>English selection text here</p>'
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
  )
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
  )
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
    () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
  )
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})
afterEach(() => {
  watcher?.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function start(): { selects: string[][]; dismisses: number[] } {
  const selects: string[][] = []
  const dismisses: number[] = []
  watcher = watchSelection({
    enabled: () => true,
    isInsidePanel: inside,
    onSelect: (t, a, m) => selects.push([t, m]),
    onDismiss: () => dismisses.push(1),
  })
  return { selects, dismisses }
}

describe('selection watcher', () => {
  it('非受信 pointerup 不触发请求', async () => {
    const { selects } = start()
    makeSelection('English selection text here')
    document.dispatchEvent(new PointerEvent('pointerup'))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toHaveLength(0)
  })

  it('受信选区 350ms 后触发一次', async () => {
    const { selects } = start()
    makeSelection('English selection text here')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toHaveLength(1)
    expect(selects[0]![0]).toContain('English selection text here')
  })

  it('350ms 内选区变为 B 则旧候选丢弃', async () => {
    const { selects, dismisses } = start()
    makeSelection('English selection text here')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    // 在等待期内改选另一个节点
    document.body.insertAdjacentHTML('beforeend', '<p id="b">Other english text</p>')
    const b = document.getElementById('b')!
    const sel = window.getSelection()!
    const r = document.createRange()
    r.selectNodeContents(b)
    sel.removeAllRanges()
    sel.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toHaveLength(0)
    void dismisses
  })

  it('已激活选区 A→B 立即 dismiss', async () => {
    const { selects, dismisses } = start()
    makeSelection('English selection text here')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toHaveLength(1)
    document.body.insertAdjacentHTML('beforeend', '<p id="b">Other english text</p>')
    const b = document.getElementById('b')!
    const sel = window.getSelection()!
    const r = document.createRange()
    r.selectNodeContents(b)
    sel.removeAllRanges()
    sel.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
    expect(dismisses).toHaveLength(1)
  })

  it('复制事件在 350ms 前取消挂起请求', async () => {
    const { selects } = start()
    makeSelection('English selection text here')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    document.dispatchEvent(new Event('copy'))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toHaveLength(0)
  })

  it('acceptText 接受含 CJK 的候选，输入焦点与隐藏文本仍不触发', async () => {
    document.body.innerHTML = '<p>设置页面</p>'
    const selects: string[] = []
    watcher = watchSelection({
      enabled: () => true,
      isInsidePanel: inside,
      acceptText: () => true,
      onSelect: (text) => selects.push(text),
      onDismiss: () => undefined,
    })
    makeSelection('设置页面')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toEqual(['设置页面'])

    selects.length = 0
    const input = document.createElement('input')
    document.body.append(input)
    makeSelection('设置页面')
    input.focus()
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toEqual([])

    input.remove()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    document.body.innerHTML = '<p hidden>设置页面</p>'
    makeSelection('设置页面')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toEqual([])
  })

  it('受信 Tab 且 focusToolbar 成功时保留选区', async () => {
    const selects: string[][] = []
    const dismisses: number[] = []
    watcher = watchSelection({
      enabled: () => true,
      isInsidePanel: inside,
      onSelect: (t, _a, m) => selects.push([t, m]),
      onDismiss: () => dismisses.push(1),
      focusToolbar: () => true,
    })
    makeSelection('English selection text here')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toHaveLength(1)
    const tab = Object.assign(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }), trusted)
    const prevent = vi.spyOn(tab, 'preventDefault')
    document.dispatchEvent(tab)
    expect(prevent).toHaveBeenCalled()
    expect(dismisses).toHaveLength(0)
    document.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'a', bubbles: true }), trusted))
    expect(dismisses).toHaveLength(1)
  })

  it('在卡片里按下后，页面上的 Ctrl+C 不关闭卡片，普通按键仍关闭', async () => {
    const panel = document.createElement('div')
    document.body.append(panel)
    const selects: string[][] = []
    const dismisses: number[] = []
    watcher = watchSelection({
      enabled: () => true,
      isInsidePanel: (event) => event.target instanceof Node && panel.contains(event.target),
      onSelect: (t, _a, m) => selects.push([t, m]),
      onDismiss: () => dismisses.push(1),
    })
    makeSelection('English selection text here')
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), trusted))
    await vi.advanceTimersByTimeAsync(400)
    expect(selects).toHaveLength(1)
    panel.dispatchEvent(Object.assign(new PointerEvent('pointerdown', { bubbles: true }), trusted))
    // 真实按键顺序：先 Control 自身的 keydown，再 c
    document.body.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }), trusted))
    document.body.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }), trusted))
    document.body.dispatchEvent(Object.assign(new Event('copy', { bubbles: true }), trusted))
    expect(dismisses).toHaveLength(0)
    document.body.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'a', bubbles: true }), trusted))
    expect(dismisses).toHaveLength(1)
  })

  it('面板按键后页面 Shift 选区仍会触发', async () => {
    const panel = document.createElement('div')
    document.body.append(panel)
    const selects: string[][] = []
    watcher = watchSelection({
      enabled: () => true,
      isInsidePanel: (event) => event.target instanceof Node && panel.contains(event.target),
      onSelect: (t, _a, m) => selects.push([t, m]),
      onDismiss: () => undefined,
    })
    panel.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'a', bubbles: true }), trusted))
    document.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }), trusted))
    makeSelection('English selection text here')
    document.dispatchEvent(Object.assign(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }), trusted))
    await vi.advanceTimersByTimeAsync(350)
    expect(selects).toHaveLength(1)
  })
})

describe('readManualSelection 自包含选区快照', () => {
  it('序列化后再执行不引用模块闭包，读取普通选区并识别焦点状态', () => {
    const serialized = new Function(`return (${readManualSelection.toString()})`)() as typeof readManualSelection
    document.querySelector('p')!.textContent = '  Serialized selection text  '
    makeSelection('  Serialized selection text  ')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(serialized(true)).toEqual({
      url: location.href,
      focused: true,
      text: 'Serialized selection text',
      frameFocused: false,
    })

    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(serialized(true)).toEqual({
      url: location.href,
      focused: false,
      text: '',
      frameFocused: false,
    })
    expect(serialized(false)).toEqual({
      url: location.href,
      focused: false,
      text: 'Serialized selection text',
      frameFocused: false,
    })
  })

  it('递归读取 open shadowRoot 内的 textarea/input 选区，password 返回空且不回退页面选区', () => {
    const serialized = new Function(`return (${readManualSelection.toString()})`)() as typeof readManualSelection
    makeSelection('Stale top page selection')

    const outerHost = document.createElement('div')
    const outerShadow = outerHost.attachShadow({ mode: 'open' })
    const innerHost = document.createElement('div')
    const innerShadow = innerHost.attachShadow({ mode: 'open' })
    const textarea = document.createElement('textarea')
    textarea.value = 'prefix Shadow input text suffix'
    innerShadow.append(textarea)
    outerShadow.append(innerHost)
    document.body.append(outerHost)

    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(outerHost)
    vi.spyOn(outerShadow, 'activeElement', 'get').mockReturnValue(innerHost)
    vi.spyOn(innerShadow, 'activeElement', 'get').mockReturnValue(textarea)
    textarea.setSelectionRange(7, 24)

    expect(serialized(true)).toEqual({
      url: location.href,
      focused: true,
      text: 'Shadow input text',
      frameFocused: false,
    })
    expect(readSelectionText()).toBe('Shadow input text')

    // input/textarea 无选区时不回退读取页面 DOM 残留选区
    textarea.setSelectionRange(3, 3)
    expect(serialized(true).text).toBe('')

    const password = document.createElement('input')
    password.type = 'password'
    password.value = 'top-secret-password'
    innerShadow.append(password)
    password.setSelectionRange(0, 10)
    vi.spyOn(innerShadow, 'activeElement', 'get').mockReturnValue(password)
    expect(serialized(true).text).toBe('')
    expect(serialized(false).text).toBe('')
    expect(readSelectionText()).toBe('')
  })

  it('焦点停在 iframe/frame 时标记 frameFocused=true 且不读取顶层旧选区', () => {
    const serialized = new Function(`return (${readManualSelection.toString()})`)() as typeof readManualSelection
    document.querySelector('p')!.textContent = 'Stale top selection that must not be read'
    makeSelection('Stale top selection that must not be read')

    const iframe = document.createElement('iframe')
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe)

    expect(serialized(true)).toEqual({
      url: location.href,
      focused: false,
      text: '',
      frameFocused: true,
    })
    expect(serialized(false)).toEqual({
      url: location.href,
      focused: false,
      text: '',
      frameFocused: true,
    })
    expect(readSelectionText()).toBe('')
  })

  it('扩展 [data-wt-root] 内部或宿主返回空，超长文本截到 6001 字供识别超长', () => {
    const serialized = new Function(`return (${readManualSelection.toString()})`)() as typeof readManualSelection

    const rootHost = document.createElement('div')
    rootHost.setAttribute('data-wt-root', '')
    const rootShadow = rootHost.attachShadow({ mode: 'open' })
    const rootInput = document.createElement('input')
    rootInput.value = 'Inside panel input'
    rootInput.setSelectionRange(0, 18)
    rootShadow.append(rootInput)
    document.body.append(rootHost)

    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(rootHost)
    vi.spyOn(rootShadow, 'activeElement', 'get').mockReturnValue(rootInput)
    expect(serialized(true).text).toBe('')

    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body)
    const longText = 'a'.repeat(6500)
    document.querySelector('p')!.textContent = longText
    makeSelection(longText)
    expect(serialized(true).text).toHaveLength(6001)
  })
})
