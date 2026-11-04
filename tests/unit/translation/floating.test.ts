import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFloatingEntry, type FloatingAction, type FloatingLabels, type FloatingPosition, type FloatingView } from '../../../src/translation/floating'

const BUTTON = 52
const VISIBLE = 26

let width = 800
let height = 600
let scale = 1
let obstacles: readonly { left: number; top: number; right: number; bottom: number }[] = []
let hosts: HTMLElement[] = []

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
    paused: false,
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
  for (const host of hosts) host.remove()
  hosts = []
  width = 800
  height = 600
  scale = 1
  obstacles = []
  vi.restoreAllMocks()
})

describe('悬浮入口', () => {
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

  it('左右贴边收起只露出 26px，缩放只除一次', async () => {
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
    expect(Number.parseFloat(illegal.button().style.left)).toBeCloseTo(width - BUTTON - 12)
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

  it('没有模型时设置和收起仍可用', async () => {
    const ui = mount()
    ui.update(view({ configured: false }))
    await frames()
    trustedClick(ui.button(), 1)
    const settings = ui.root.querySelector('.floating-settings') as HTMLButtonElement
    const fold = ui.root.querySelector('.floating-fold') as HTMLButtonElement
    const primary = ui.root.querySelector('.floating-auto') as HTMLButtonElement
    expect(settings.disabled).toBe(false)
    expect(fold.disabled).toBe(false)
    expect(primary.disabled).toBe(true)
    trustedClick(settings, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.onAction).toHaveBeenCalledWith('settings')
    trustedClick(fold, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.entry.isMenuOpen()).toBe(false)
    expect(ui.button().getAttribute('aria-label')).toBe('展开')
  })

  it('未勾选确认不发动作，勾选后只发一次', async () => {
    const ui = mount()
    ui.update(view({ configured: true, autoEnabled: false }))
    await frames()
    trustedClick(ui.button(), 1)
    const primary = ui.root.querySelector('.floating-auto') as HTMLButtonElement
    const consent = ui.root.querySelector('.floating-consent') as HTMLElement
    const box = consent.querySelector('input') as HTMLInputElement
    trustedClick(primary, 1)
    expect(ui.onAction).not.toHaveBeenCalled()
    expect(consent.hidden).toBe(false)
    expect(consent.textContent).toContain('私有内容')
    trustedClick(primary, 1)
    expect(ui.onAction).not.toHaveBeenCalled()
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    trustedClick(primary, 1)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
    expect(ui.onAction).toHaveBeenCalledWith('toggle-auto')
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
    expect((ui.root.querySelector('.floating-consent') as HTMLElement).hidden).toBe(true)
    ui.update(view({ configured, busy: true }))
    trustedClick(translate)
    expect(ui.onAction).toHaveBeenCalledTimes(1)
  })
})
