import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFloatingEntry, type FloatingAction, type FloatingLabels, type FloatingPosition, type FloatingView } from '../../../src/translation/floating'

const BUTTON = 40
const VISIBLE = 20

let width = 800
let height = 600
let scale = 1
let obstacles: readonly { left: number; top: number; right: number; bottom: number }[] = []
let hosts: HTMLElement[] = []
let entries: ReturnType<typeof createFloatingEntry>[] = []

function labels(patch: Partial<FloatingLabels> = {}): FloatingLabels {
  return {
    title: '标题',
    open: '打开',
    expand: '展开',
    close: '关闭',
    move: '移动说明',
    translatePage: '翻译本页',
    enable: '开启',
    disable: '关闭自动',
    fold: '收起',
    disclosure: '说明',
    consent: '可见文本、页面标题、主标题、站点名、智能陪读近期线索、私有内容、费用',
    confirm: '确认',
    cancel: '取消',
    restore: '恢复',
    resume: '继续',
    settings: '设置',
    textTranslate: '文本翻译',
    configure: '请先配置模型',
    fixedOn: '词库',
    modelOn: '模型开',
    modelOff: '模型关',
    pageOn: '本页开',
    restored: '已恢复',
    paused: '已暂停',
    loading: '加载',
    positionFailed: '位置失败',
    ...patch,
  }
}

function view(patch: Partial<FloatingView> = {}): FloatingView {
  return {
    visible: true,
    hostname: 'example.com',
    fixedOn: false,
    autoEnabled: false,
    configured: true,
    restored: false,
    canRestore: true,
    resumable: false,
    busy: false,
    checking: false,
    error: '',
    ...patch,
  }
}

function trustedPointer(type: string, init: PointerEventInit = {}): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    ...init,
  })
  Object.defineProperty(event, 'isTrusted', { configurable: true, value: true })
  Object.defineProperty(event, 'isPrimary', { configurable: true, value: init.isPrimary ?? true })
  return event
}

function trustedClick(element: Element, detail = 1): void {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail })
  Object.defineProperty(event, 'isTrusted', { configurable: true, value: true })
  element.dispatchEvent(event)
}

function trustedKey(element: Element, key: string): void {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey: true })
  Object.defineProperty(event, 'isTrusted', { configurable: true, value: true })
  element.dispatchEvent(event)
}

async function frames(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  await Promise.resolve()
}

function mount(options?: {
  read?: () => Promise<unknown>
  write?: (position: FloatingPosition) => Promise<void>
  onOpen?: () => void
  onAction?: (action: FloatingAction) => void
}) {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  document.body.append(host)
  hosts.push(host)
  const onOpen = vi.fn(options?.onOpen ?? (() => undefined))
  const onAction = vi.fn(options?.onAction ?? (() => undefined))
  const writes: FloatingPosition[] = []
  const entry = createFloatingEntry(root, {
    viewport: () => ({ width, height, scale }),
    avoidRects: () => obstacles,
  })
  entries.push(entry)
  const callbacks = {
    imageUrl: '/icon/48.png',
    readPosition: options?.read ?? (async () => ({ side: 'right' as const, ratio: 0.5, collapsed: false })),
    writePosition: async (position: FloatingPosition) => {
      writes.push(position)
      await options?.write?.(position)
    },
    onOpen,
    onAction,
  }
  entry.update(view(), labels(), callbacks)
  return {
    root,
    entry,
    onOpen,
    onAction,
    writes,
    button: () => root.querySelector('.floating-entry') as HTMLButtonElement,
    menu: () => root.querySelector('.floating-menu') as HTMLElement,
    update(next = view(), nextLabels = labels()) {
      entry.update(next, nextLabels, callbacks)
    },
  }
}

afterEach(() => {
  for (const entry of entries) entry.dispose()
  entries = []
  for (const host of hosts) host.remove()
  hosts = []
  width = 800
  height = 600
  scale = 1
  obstacles = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('悬浮入口', () => {
  it.each([
    ['暂停', false, true, true, true],
    ['硬上限', false, false, true, false],
    ['已恢复', true, true, false, true],
  ] as const)('%s时恢复和继续是独立操作', async (_state, restored, resumable, showRestore, showResume) => {
    const ui = mount()
    ui.update(view({ restored, resumable, canRestore: true }))
    await frames()
    trustedClick(ui.button())
    const restore = ui.root.querySelector('.floating-page') as HTMLButtonElement
    const resume = ui.root.querySelector('.floating-resume') as HTMLButtonElement
    expect(resume).not.toBeNull()
    expect(restore.hidden).toBe(!showRestore)
    expect(resume.hidden).toBe(!showResume)
    const actions: FloatingAction[] = []
    if (showRestore) {
      trustedClick(restore)
      actions.push('restore')
    }
    if (showResume) {
      trustedClick(resume)
      actions.push('resume')
    }
    expect(ui.onAction.mock.calls.map(([action]) => action)).toEqual(actions)
  })

  it('无存储时默认半收起，悬停展开，移开900ms后收起且不写存储', async () => {
    const ui = mount({ read: async () => undefined })
    await frames()
    expect(Number.parseFloat(ui.button().style.left)).toBe(780)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ui.button().dispatchEvent(trustedPointer('pointerenter', { pointerType: 'mouse' }))
    expect(Number.parseFloat(ui.button().style.left)).toBe(760)
    ui.button().dispatchEvent(trustedPointer('pointerleave', { pointerType: 'mouse' }))
    vi.advanceTimersByTime(899)
    expect(Number.parseFloat(ui.button().style.left)).toBe(760)
    vi.advanceTimersByTime(1)
    expect(Number.parseFloat(ui.button().style.left)).toBe(780)
    expect(ui.writes).toEqual([])
  })

  it('菜单、通知和键盘焦点保持展开；鼠标留下的普通焦点不阻止收起', async () => {
    const ui = mount()
    await frames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let keyboardFocus = false
    vi.spyOn(ui.button(), 'matches').mockImplementation((selector) => selector === ':focus-visible' && keyboardFocus)
    trustedClick(ui.button())
    vi.advanceTimersByTime(1800)
    expect(Number.parseFloat(ui.button().style.left)).toBe(760)
    ui.entry.closeMenu()
    ui.entry.setNoticeVisible(true)
    vi.advanceTimersByTime(1800)
    expect(Number.parseFloat(ui.button().style.left)).toBe(760)
    ui.entry.setNoticeVisible(false)
    keyboardFocus = true
    ui.button().dispatchEvent(new FocusEvent('focusin'))
    ui.button().dispatchEvent(trustedPointer('pointerleave'))
    vi.advanceTimersByTime(1800)
    expect(Number.parseFloat(ui.button().style.left)).toBe(760)
    keyboardFocus = false
    ui.button().dispatchEvent(new FocusEvent('focusout'))
    await Promise.resolve()
    vi.advanceTimersByTime(900)
    expect(Number.parseFloat(ui.button().style.left)).toBe(780)
    expect(ui.writes).toEqual([])
  })

  it('在中间松开后贴最近侧，自动收起并只保存稳定贴边位置', async () => {
    const ui = mount()
    await frames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ui.button().dispatchEvent(trustedPointer('pointerdown', { clientX: 790, clientY: 300 }))
    document.dispatchEvent(trustedPointer('pointermove', { clientX: 210, clientY: 240 }))
    document.dispatchEvent(trustedPointer('pointerup', { clientX: 210, clientY: 240 }))
    expect(Number.parseFloat(ui.button().style.left)).toBe(0)
    expect(ui.writes).toHaveLength(1)
    expect(ui.writes[0]).toMatchObject({ side: 'left', collapsed: true })
    vi.advanceTimersByTime(900)
    expect(Number.parseFloat(ui.button().style.left)).toBe(-20)
    expect(ui.writes).toHaveLength(1)
  })

  it('dispose 清理自动收起计时器，迟到读取不会复活入口', async () => {
    let resolveRead!: (value: unknown) => void
    const ui = mount({ read: () => new Promise((resolve) => { resolveRead = resolve }) })
    await frames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ui.button().dispatchEvent(trustedPointer('pointerenter', { pointerType: 'mouse' }))
    ui.button().dispatchEvent(trustedPointer('pointerleave'))
    expect(vi.getTimerCount()).toBe(1)
    ui.entry.dispose()
    expect(vi.getTimerCount()).toBe(0)
    resolveRead({ side: 'left', ratio: 0, collapsed: false })
    await Promise.resolve()
    expect(ui.root.querySelector('.floating-entry')).toBeNull()
    expect(ui.entry.getAnchor()).toBeUndefined()
  })

  it('普通点击开关菜单', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button(), 1)
    expect(ui.entry.isMenuOpen()).toBe(true)
    expect(ui.onOpen).toHaveBeenCalledTimes(1)
    trustedClick(ui.button(), 1)
    expect(ui.entry.isMenuOpen()).toBe(false)
  })

  it('拖动后的指针点击不打开菜单', async () => {
    const ui = mount()
    await frames()
    const button = ui.button()
    button.dispatchEvent(trustedPointer('pointerdown', { clientX: 100, clientY: 100 }))
    document.dispatchEvent(trustedPointer('pointermove', { clientX: 140, clientY: 100 }))
    document.dispatchEvent(trustedPointer('pointerup', { clientX: 140, clientY: 100 }))
    trustedClick(button, 1)
    expect(ui.entry.isMenuOpen()).toBe(false)
    expect(ui.onOpen).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'blur', 'hidden'] as const)('%s 释放拖动后键盘点击可以打开', async (kind) => {
    const ui = mount()
    await frames()
    const button = ui.button()
    const release = vi.spyOn(button, 'releasePointerCapture')
    const before = button.style.left
    button.dispatchEvent(trustedPointer('pointerdown', { clientX: 20, clientY: 20 }))
    document.dispatchEvent(trustedPointer('pointermove', { clientX: 80, clientY: 20 }))
    expect(button.style.left).not.toBe(before)
    if (kind === 'cancel') document.dispatchEvent(trustedPointer('pointercancel', { clientX: 80, clientY: 20 }))
    if (kind === 'blur') window.dispatchEvent(new Event('blur'))
    if (kind === 'hidden') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    }
    expect(release).toHaveBeenCalled()
    expect(button.style.left).toBe(before)
    expect(ui.writes).toHaveLength(0)
    document.dispatchEvent(trustedPointer('pointermove', { clientX: 200, clientY: 20 }))
    expect(button.style.left).toBe(before)
    trustedClick(button, 0)
    expect(ui.entry.isMenuOpen()).toBe(true)
    ui.entry.dispose()
  })

  it('dispose 停止拖动并移除入口', async () => {
    const ui = mount()
    await frames()
    const button = ui.button()
    button.dispatchEvent(trustedPointer('pointerdown', { clientX: 20, clientY: 20 }))
    document.dispatchEvent(trustedPointer('pointermove', { clientX: 90, clientY: 20 }))
    ui.entry.dispose()
    expect(ui.root.querySelector('.floating-entry')).toBeNull()
    expect(ui.writes).toHaveLength(0)
    expect(ui.onOpen).not.toHaveBeenCalled()
    expect(() => document.dispatchEvent(trustedPointer('pointermove', { clientX: 120, clientY: 20 }))).not.toThrow()
    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow()
  })

  it('左右贴边收起只露出20px，缩放只除一次', async () => {
    let resolveRead: (value: unknown) => void = () => undefined
    const read = new Promise<unknown>((resolve) => {
      resolveRead = resolve
    })
    const ui = mount({ read: async () => read })
    resolveRead({ side: 'left', ratio: 0.5, collapsed: true })
    await frames()
    expect(Number.parseFloat(ui.button().style.left)).toBeCloseTo(-(BUTTON - VISIBLE))
    scale = 2
    ui.entry.reposition()
    await frames()
    expect(Number.parseFloat(ui.button().style.left)).toBeCloseTo(-(BUTTON - VISIBLE) / 2)
    expect(ui.button().style.getPropertyValue('--wt-floating-scale')).toBe('2')
    trustedKey(ui.button(), 'ArrowRight')
    expect(Number.parseFloat(ui.button().style.left)).toBeCloseTo(width - VISIBLE / 2)
  })

  it('缩放窗口和 Shift 移动后仍在边界内', async () => {
    const ui = mount()
    await frames()
    for (let count = 0; count < 40; count += 1) trustedKey(ui.button(), 'ArrowDown')
    width = 30
    height = 20
    ui.entry.reposition()
    await frames()
    trustedKey(ui.button(), 'ArrowLeft')
    trustedKey(ui.button(), 'ArrowUp')
    const left = Number.parseFloat(ui.button().style.left)
    const top = Number.parseFloat(ui.button().style.top)
    expect(left).toBeGreaterThanOrEqual(-(BUTTON - VISIBLE))
    expect(left).toBeLessThanOrEqual(width)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThanOrEqual(height)
  })

  it('非法位置回默认，用户拖动后的迟到读取不覆盖', async () => {
    let resolveRead: (value: unknown) => void = () => undefined
    const read = new Promise<unknown>((resolve) => {
      resolveRead = resolve
    })
    const illegal = mount({ read: async () => read })
    resolveRead({ side: 'up', ratio: 4, collapsed: 'no' })
    await frames()
    expect(Number.parseFloat(illegal.button().style.left)).toBe(780)
    illegal.entry.dispose()

    let resolveLate: (value: unknown) => void = () => undefined
    const late = new Promise<unknown>((resolve) => {
      resolveLate = resolve
    })
    const ui = mount({ read: async () => late })
    await frames()
    const button = ui.button()
    button.dispatchEvent(trustedPointer('pointerdown', { clientX: 10, clientY: 10 }))
    document.dispatchEvent(trustedPointer('pointermove', { clientX: 40, clientY: 10 }))
    document.dispatchEvent(trustedPointer('pointerup', { clientX: 40, clientY: 10 }))
    const dropped = button.style.left
    resolveLate({ side: 'left', ratio: 0, collapsed: true })
    await frames()
    expect(button.style.left).toBe(dropped)
    expect(Number.parseFloat(button.style.left)).not.toBeCloseTo(-(BUTTON - VISIBLE))
  })

  it('慢写 A 期间的快写 B 最终落成 B', async () => {
    let release: () => void = () => undefined
    let gate = true
    const ui = mount({
      write: () => {
        if (!gate) return Promise.resolve()
        gate = false
        return new Promise<void>((done) => {
          release = done
        })
      },
    })
    await frames()
    trustedKey(ui.button(), 'ArrowUp')
    trustedKey(ui.button(), 'ArrowUp')
    expect(ui.writes).toHaveLength(1)
    release()
    await frames()
    expect(ui.writes).toHaveLength(2)
    expect(ui.writes[1]?.ratio).toBeLessThan(ui.writes[0]?.ratio ?? 1)
  })

  it('空间不够、菜单压住入口时入口让位，关闭后恢复；空间够时不让位', async () => {
    width = 120
    height = 200
    const tight = mount()
    await frames()
    trustedClick(tight.button(), 1)
    expect(tight.entry.isMenuOpen()).toBe(true)
    expect(tight.button().classList.contains('is-covered')).toBe(true)
    tight.entry.closeMenu()
    expect(tight.button().classList.contains('is-covered')).toBe(false)
    tight.entry.dispose()
    width = 800
    height = 600
    const roomy = mount()
    await frames()
    trustedClick(roomy.button(), 1)
    expect(roomy.entry.isMenuOpen()).toBe(true)
    expect(roomy.button().classList.contains('is-covered')).toBe(false)
  })

  it('避开选区障碍时不写存储', async () => {
    const ui = mount()
    await frames()
    const before = ui.button().style.top
    obstacles = [{ left: 700, top: 200, right: 900, bottom: 400 }]
    ui.entry.reposition()
    await frames()
    expect(ui.button().style.top).not.toBe(before)
    expect(ui.button().style.visibility).not.toBe('hidden')
    expect(ui.writes).toHaveLength(0)
  })

  it('没有模型时设置和关闭菜单仍可用', async () => {
    const ui = mount()
    ui.update(view({ configured: false }))
    await frames()
    trustedClick(ui.button(), 1)
    const settings = ui.root.querySelector('.floating-settings') as HTMLButtonElement
    const close = ui.root.querySelector('.floating-close') as HTMLButtonElement
    const primary = ui.root.querySelector('.floating-auto') as HTMLButtonElement
    expect(settings.disabled).toBe(false)
    expect(close.disabled).toBe(false)
    expect(ui.root.querySelector('.floating-fold')).toBeNull()
    expect(primary.disabled).toBe(true)
    trustedClick(settings, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.onAction).toHaveBeenCalledWith('settings')
    trustedClick(close, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.entry.isMenuOpen()).toBe(false)
  })

  it('本站自动开关一次可信点击就生效，无二次确认；忙碌和不可信事件不重复提交', async () => {
    const ui = mount()
    ui.update(view({ configured: true, autoEnabled: false }))
    await frames()
    trustedClick(ui.button(), 1)
    const primary = ui.root.querySelector('.floating-auto') as HTMLButtonElement
    expect(primary.getAttribute('role')).toBe('switch')
    expect(primary.getAttribute('aria-checked')).toBe('false')
    expect(ui.root.querySelector('.floating-consent')).toBeNull()
    primary.click()
    expect(ui.onAction).not.toHaveBeenCalled()
    trustedClick(primary, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.onAction).toHaveBeenCalledWith('toggle-auto')
    ui.update(view({ autoEnabled: true, busy: true }))
    expect(primary.getAttribute('aria-checked')).toBe('true')
    trustedClick(primary)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    ui.update(view({ autoEnabled: true, configured: false }))
    expect(primary.disabled).toBe(false)
    trustedClick(primary)
    expect(ui.onAction).toHaveBeenCalledTimes(2)
  })

  it('语言更新不发动作也不丢掉焦点', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button(), 0)
    const settings = ui.root.querySelector('.floating-settings') as HTMLButtonElement
    settings.focus()
    expect(ui.root.activeElement).toBe(settings)
    ui.update(view(), labels({ title: 'Title', settings: 'Settings' }))
    expect(ui.entry.isMenuOpen()).toBe(true)
    expect(ui.root.activeElement).toBe(settings)
    expect(settings.textContent).toBe('Settings')
    expect(ui.onAction).not.toHaveBeenCalled()
  })

  it('合成事件不执行', async () => {
    const ui = mount()
    await frames()
    const button = ui.button()
    const before = button.style.left
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, clientX: 80, clientY: 0 }))
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, clientX: 80, clientY: 0 }))
    expect(ui.entry.isMenuOpen()).toBe(false)
    expect(ui.onOpen).not.toHaveBeenCalled()
    expect(ui.onAction).not.toHaveBeenCalled()
    expect(button.style.left).toBe(before)
  })

  it.each([true, false])('配置状态%s：本页按钮须可信输入，且不打开永久自动同意', async (configured) => {
    const ui = mount()
    ui.update(view({ configured }))
    await frames()
    trustedClick(ui.button(), 1)
    const translate = ui.root.querySelector('.floating-translate') as HTMLButtonElement
    expect(translate.disabled).toBe(false)
    translate.click()
    expect(ui.onAction).not.toHaveBeenCalled()
    trustedClick(translate)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.onAction).toHaveBeenCalledWith('translate-page')
    expect(ui.root.querySelector('.floating-consent')).toBeNull()
    ui.update(view({ configured, busy: true }))
    trustedClick(translate)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
  })

  it('文本翻译按钮可见、本地化，可信点击派发一次 text-window，不可信点击不派发', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button(), 1)
    const text = ui.root.querySelector('.floating-text') as HTMLButtonElement
    expect(text).not.toBeNull()
    expect(text.hidden).toBe(false)
    expect(text.textContent).toBe('文本翻译')
    expect(text.disabled).toBe(false)
    text.click()
    expect(ui.onAction).not.toHaveBeenCalled()
    trustedClick(text, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.onAction).toHaveBeenCalledWith('text-window')
  })

  it('忙碌或 aria-disabled 时文本按钮不派发', async () => {
    const ui = mount()
    ui.update(view({ busy: true }))
    await frames()
    trustedClick(ui.button(), 1)
    const text = ui.root.querySelector('.floating-text') as HTMLButtonElement
    expect(text.getAttribute('aria-disabled')).toBe('true')
    for (const selector of ['.floating-text', '.floating-settings', '.floating-translate', '.floating-auto']) {
      const button = ui.root.querySelector(selector) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('aria-describedby')).toBe('wt-floating-disabled-reason')
      expect(ui.root.querySelector('#wt-floating-disabled-reason')?.textContent).toBe(labels().loading)
    }
    trustedClick(text, 1)
    expect(ui.onAction).not.toHaveBeenCalled()
    ui.update(view({ busy: false }))
    text.setAttribute('aria-disabled', 'true')
    trustedClick(text, 1)
    expect(ui.onAction).not.toHaveBeenCalled()
  })

  it('键盘操作进入忙碌态前将焦点移到关闭按钮，保留原生禁用', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button(), 0)
    const translate = ui.root.querySelector('.floating-translate') as HTMLButtonElement
    const close = ui.root.querySelector('.floating-close') as HTMLButtonElement
    expect(ui.root.activeElement).toBe(translate)
    ui.update(view({ busy: true }))
    expect(translate.disabled).toBe(true)
    expect(ui.root.activeElement).toBe(close)
    trustedClick(close, 0)
    expect(ui.entry.isMenuOpen()).toBe(false)
  })

  it('键盘触发的操作结束后焦点回到原按钮；期间用户移走焦点则不抢回', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button(), 0)
    const translate = ui.root.querySelector('.floating-translate') as HTMLButtonElement
    const close = ui.root.querySelector('.floating-close') as HTMLButtonElement
    expect(ui.root.activeElement).toBe(translate)
    ui.update(view({ busy: true }))
    expect(ui.root.activeElement).toBe(close)
    ui.update(view({ busy: true, error: '仍在进行' }))
    expect(ui.root.activeElement).toBe(close)
    ui.update(view())
    expect(ui.root.activeElement).toBe(translate)
    expect(ui.entry.isMenuOpen()).toBe(true)

    ui.update(view({ busy: true }))
    expect(ui.root.activeElement).toBe(close)
    ui.button().focus()
    ui.update(view())
    expect(ui.root.activeElement).toBe(ui.button())

    translate.focus()
    ui.update(view({ busy: true }))
    trustedClick(close, 0)
    expect(ui.entry.isMenuOpen()).toBe(false)
    ui.update(view())
    expect(ui.root.activeElement).toBe(ui.button())
  })

  it('聚焦的操作被隐藏时焦点移到关闭按钮；操作结束时原按钮已隐藏则留在关闭按钮', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button(), 0)
    const restore = ui.root.querySelector('.floating-page') as HTMLButtonElement
    const close = ui.root.querySelector('.floating-close') as HTMLButtonElement
    restore.focus()
    ui.update(view({ restored: true, resumable: true }))
    expect(restore.hidden).toBe(true)
    expect(ui.root.activeElement).toBe(close)

    ui.update(view())
    restore.focus()
    ui.update(view({ busy: true }))
    expect(ui.root.activeElement).toBe(close)
    ui.update(view({ restored: true, resumable: true }))
    expect(restore.hidden).toBe(true)
    expect(ui.root.activeElement).toBe(close)
  })

  it('忙碌或检查中显示可见的原因文字并与禁用按钮关联，空闲与未配置时隐藏', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button())
    const translate = ui.root.querySelector('.floating-translate') as HTMLButtonElement
    const auto = ui.root.querySelector('.floating-auto') as HTMLButtonElement
    const reason = ui.root.getElementById('wt-floating-disabled-reason') as HTMLElement
    expect(reason.hidden).toBe(true)
    ui.update(view({ busy: true }))
    expect(reason.hidden).toBe(false)
    expect(reason.textContent).toBe('加载')
    expect(translate.disabled).toBe(true)
    expect(translate.getAttribute('aria-describedby')).toBe(reason.id)
    ui.update(view({ checking: true }))
    expect(reason.hidden).toBe(false)
    ui.update(view())
    expect(reason.hidden).toBe(true)
    expect(translate.hasAttribute('aria-describedby')).toBe(false)
    ui.update(view({ configured: false }))
    expect(reason.hidden).toBe(true)
    expect(translate.textContent).toBe('请先配置模型')
    expect(auto.disabled).toBe(true)
    expect(auto.getAttribute('aria-describedby')).toBe(reason.id)
  })

  it('强制高对比度下开关拨钮保留：渐变不被系统配色移除，并按状态使用系统色', () => {
    const ui = mount()
    const css = ui.root.querySelector('style')?.textContent ?? ''
    const forced = css.slice(css.lastIndexOf('.floating-auto::after { forced-color-adjust'))
    expect(css.slice(0, css.length - forced.length).trimEnd().endsWith('@media (forced-colors: active) {')).toBe(true)
    expect(forced).toContain('.floating-auto::after { forced-color-adjust: none; --gcn-knob: ButtonText; --gcn-switch-off: Canvas;')
    expect(forced).toContain(".floating-auto[aria-checked='true']::after { --gcn-knob: HighlightText; --gcn-knob-on: HighlightText; --gcn-switch-on: Highlight;")
    expect(forced).toContain('.floating-auto:disabled::after { --gcn-knob: GrayText;')
  })

  it('强制高对比度下主按钮退出系统改色，避免文字底板盖住 HighlightText 文字', () => {
    const ui = mount()
    const css = ui.root.querySelector('style')?.textContent ?? ''
    const start = css.indexOf('@media (forced-colors: active) {\n  :host, :host([data-style])')
    expect(start).toBeGreaterThan(-1)
    const block = css.slice(start, css.indexOf('.floating-entry, .floating-menu'))
    expect(block).toContain('--gcn-primary-fg: HighlightText; --gcn-primary-bg: Highlight;')
    expect(block).toContain(
      ".floating-primary, .actions button[data-action='replace'], .selection-toolbar button[data-action='translate'] { forced-color-adjust: none; }",
    )
  })

  it('未配置模型仍允许打开空白文本窗口', async () => {
    const ui = mount()
    ui.update(view({ configured: false }))
    await frames()
    trustedClick(ui.button(), 1)
    const text = ui.root.querySelector('.floating-text') as HTMLButtonElement
    expect(text.disabled).toBe(false)
    expect(text.getAttribute('aria-disabled')).not.toBe('true')
    trustedClick(text, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.onAction).toHaveBeenCalledWith('text-window')
  })

  it('文本按钮在键盘焦点序列中可聚焦', async () => {
    const ui = mount()
    await frames()
    trustedClick(ui.button(), 0)
    const text = ui.root.querySelector('.floating-text') as HTMLButtonElement
    expect(text.tabIndex).not.toBe(-1)
    expect(text.disabled).toBe(false)
    text.focus()
    expect(ui.root.activeElement).toBe(text)
  })

  it('页面隐藏取消收起定时器与待执行定位，恢复后重新排程', async () => {
    const ui = mount()
    await frames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const button = ui.button()
    button.dispatchEvent(trustedPointer('pointerenter', { pointerType: 'mouse' }))
    button.dispatchEvent(trustedPointer('pointerleave', { pointerType: 'mouse' }))
    expect(vi.getTimerCount()).toBe(1)
    ui.entry.reposition()
    const cancelRaf = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const setHidden = (hidden: boolean, state: DocumentVisibilityState): void => {
      Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
      visibility.mockReturnValue(state)
    }
    try {
      setHidden(true, 'hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(cancelRaf).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      setHidden(false, 'visible')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      setHidden(false, 'visible')
      vi.useRealTimers()
    }
  })

  it('dispose 后可见性与指针事件不再排程工作', async () => {
    const ui = mount()
    await frames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ui.entry.dispose()
    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow()
    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
