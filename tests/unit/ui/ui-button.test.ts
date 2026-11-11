import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils'
import { importSfc, required } from './sfc'

const UiButton = await importSfc(() => import('../../../src/components/ui/UiButton.vue'))

enableAutoUnmount(afterEach)

/** 宿主（按钮内的波纹层）的位置与尺寸：左上角 (10, 20)，80 × 60 */
const RECT = new DOMRect(10, 20, 80, 60)

function render(options: { disabled?: boolean; onClick?: () => void } = {}): VueWrapper {
  return mount(required(UiButton), {
    props: { disabled: options.disabled },
    attrs: { onClick: options.onClick },
    slots: { default: '保存' },
  })
}

function pointerdown(wrapper: VueWrapper, init: PointerEventInit): void {
  wrapper.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ...init }))
}

/** 键盘（Enter、空格）触发的点击：detail 为 0 */
function keyboardClick(wrapper: VueWrapper): void {
  wrapper.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
}

function mouseClick(wrapper: VueWrapper): void {
  wrapper.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
}

/** 各波纹的位置与边长（px） */
function waves(wrapper: VueWrapper): Array<{ left: number; top: number; size: number }> {
  return wrapper.findAll('.ui-ripple-wave').map((wave) => {
    const style = (wave.element as HTMLElement).style
    expect(style.width).toBe(style.height)
    return { left: parseFloat(style.left), top: parseFloat(style.top), size: parseFloat(style.width) }
  })
}

function fakeMediaQueryList(): {
  mql: MediaQueryList
  listeners: Set<() => void>
  removeSpy: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<() => void>()
  const removeSpy = vi.fn()
  const mql = {
    matches: false,
    media: '',
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => {
      removeSpy(_type, cb)
      listeners.delete(cb)
    },
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  return { mql, listeners, removeSpy }
}

describe.skipIf(!UiButton)('UiButton', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('按钮', () => {
    it('默认 type 为 button，表单里不会误提交；插槽为按钮文字', () => {
      const wrapper = render()
      expect(wrapper.element.tagName).toBe('BUTTON')
      expect(wrapper.attributes('type')).toBe('button')
      expect(wrapper.text()).toBe('保存')
    })

    it('type、样式、尺寸、图标按钮', () => {
      const wrapper = mount(required(UiButton), {
        props: { type: 'submit', variant: 'primary', size: 'sm', icon: true },
      })
      expect(wrapper.attributes('type')).toBe('submit')
      expect(wrapper.classes()).toEqual(
        expect.arrayContaining(['ui-button', 'ui-button-primary', 'ui-button-sm', 'ui-button-icon']),
      )
      expect(render().classes()).toEqual(expect.arrayContaining(['ui-button-default', 'ui-button-md']))
      expect(render().classes()).not.toContain('ui-button-icon')
    })

    it('aria-label、title、data-test、class 落在原生 button 上', () => {
      const wrapper = mount(required(UiButton), {
        attrs: { 'aria-label': '删除 Code', title: '删除', 'data-test': 'remove', class: 'extra' },
        slots: { default: '删除' },
      })
      expect(wrapper.attributes()).toMatchObject({ 'aria-label': '删除 Code', title: '删除', 'data-test': 'remove' })
      expect(wrapper.classes()).toContain('extra')
    })

    it('点击处理在点击事件内同步执行（权限请求须在用户手势内发起）', () => {
      const onClick = vi.fn()
      const wrapper = render({ onClick })
      mouseClick(wrapper)
      expect(onClick).toHaveBeenCalledTimes(1)
      keyboardClick(wrapper)
      expect(onClick).toHaveBeenCalledTimes(2)
    })

    it('禁用时为原生 disabled，点击不触发', async () => {
      const onClick = vi.fn()
      const wrapper = render({ disabled: true, onClick })
      expect((wrapper.element as HTMLButtonElement).disabled).toBe(true)
      await wrapper.trigger('click')
      expect(onClick).not.toHaveBeenCalled()
    })
  })

  describe('链接', () => {
    function renderLink(): VueWrapper {
      return mount(required(UiButton), {
        props: { href: 'https://github.com/vuejs/core', variant: 'invisible', icon: true },
        attrs: { target: '_blank', rel: 'noreferrer', 'aria-label': 'Sample text' },
      })
    }

    it('给出 href 时渲染为链接：外观同按钮，target、rel 等落在 a 上，没有 type 与 disabled', () => {
      const wrapper = renderLink()
      expect(wrapper.element.tagName).toBe('A')
      expect(wrapper.attributes()).toMatchObject({
        href: 'https://github.com/vuejs/core',
        target: '_blank',
        rel: 'noreferrer',
        'aria-label': 'Sample text',
      })
      expect(wrapper.attributes('type')).toBeUndefined()
      expect(wrapper.attributes('disabled')).toBeUndefined()
      expect(wrapper.classes()).toEqual(expect.arrayContaining(['ui-button', 'ui-button-invisible', 'ui-button-icon']))
    })

    it('按下时同样有水波纹', async () => {
      const wrapper = renderLink()
      pointerdown(wrapper, { clientX: 10, clientY: 20 })
      await wrapper.vm.$nextTick()
      expect(waves(wrapper)).toEqual([{ left: -100, top: -100, size: 200 }])
    })
  })

  describe('水波纹', () => {
    it('指针按下时从按下位置扩散，半径为到最远角的距离', async () => {
      const wrapper = render()
      // 按在宿主左上角：最远角是右下角，半径 hypot(80, 60) = 100
      pointerdown(wrapper, { clientX: 10, clientY: 20 })
      await wrapper.vm.$nextTick()
      expect(waves(wrapper)).toEqual([{ left: -100, top: -100, size: 200 }])
    })

    it('键盘触发的点击从中心扩散；鼠标点击不重复生成', async () => {
      const wrapper = render()
      keyboardClick(wrapper)
      await wrapper.vm.$nextTick()
      // 中心 (40, 30)，半径 hypot(40, 30) = 50
      expect(waves(wrapper)).toEqual([{ left: -10, top: -20, size: 100 }])

      pointerdown(wrapper, { clientX: 50, clientY: 50 })
      mouseClick(wrapper)
      await wrapper.vm.$nextTick()
      expect(waves(wrapper)).toHaveLength(2)
    })

    it('非主键（右键、中键）按下不生成', async () => {
      const wrapper = render()
      pointerdown(wrapper, { button: 2, clientX: 30, clientY: 30 })
      pointerdown(wrapper, { button: 1, clientX: 30, clientY: 30 })
      await wrapper.vm.$nextTick()
      expect(waves(wrapper)).toEqual([])
    })

    it('禁用时不生成', async () => {
      const wrapper = render({ disabled: true })
      pointerdown(wrapper, { clientX: 30, clientY: 30 })
      keyboardClick(wrapper)
      await wrapper.vm.$nextTick()
      expect(waves(wrapper)).toEqual([])
    })

    it('系统要求减少动态效果时不生成', async () => {
      const matchMedia = vi
        .spyOn(window, 'matchMedia')
        .mockImplementation((query) => ({ matches: query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList)
      const wrapper = render()
      pointerdown(wrapper, { clientX: 30, clientY: 30 })
      keyboardClick(wrapper)
      await wrapper.vm.$nextTick()
      expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
      expect(waves(wrapper)).toEqual([])
    })

    it('动画结束后移除', async () => {
      const wrapper = render()
      pointerdown(wrapper, { clientX: 30, clientY: 30 })
      await wrapper.vm.$nextTick()
      await wrapper.get('.ui-ripple-wave').trigger('animationend')
      expect(waves(wrapper)).toEqual([])
    })

    it('连点时最多保留 3 个，丢弃最早的', async () => {
      const wrapper = render()
      for (const clientX of [10, 20, 30, 40, 50]) pointerdown(wrapper, { clientX, clientY: 20 })
      await wrapper.vm.$nextTick()
      // 按下位置依次右移 10px：留下的是后 3 个
      const lefts = waves(wrapper).map((wave) => Math.round(wave.left + wave.size / 2 + RECT.left))
      expect(lefts).toEqual([30, 40, 50])
    })

    it('波纹层对读屏隐藏，不改变按钮的可访问名称', async () => {
      const wrapper = render()
      pointerdown(wrapper, { clientX: 30, clientY: 30 })
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.ui-ripple').attributes('aria-hidden')).toBe('true')
      expect(wrapper.text()).toBe('保存')
    })

    it('卸载时移除监听', () => {
      const wrapper = render()
      const remove = vi.spyOn(wrapper.element, 'removeEventListener')
      wrapper.unmount()
      expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function))
      expect(remove).toHaveBeenCalledWith('click', expect.any(Function))
    })

    it('兜底定时器在 220ms 内清除波纹与计时器', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const wrapper = render()
        pointerdown(wrapper, { clientX: 30, clientY: 30 })
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(1)
        vi.advanceTimersByTime(219)
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toHaveLength(1)
        vi.advanceTimersByTime(1)
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('最多 3 个波纹对应最多 3 个兜底计时器，丢弃最早的', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const wrapper = render()
        for (const clientX of [10, 20, 30, 40, 50]) pointerdown(wrapper, { clientX, clientY: 20 })
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toHaveLength(3)
        expect(vi.getTimerCount()).toBe(3)
        vi.advanceTimersByTime(220)
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('animationend 移除波纹及其兜底计时器', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const wrapper = render()
        pointerdown(wrapper, { clientX: 30, clientY: 30 })
        await wrapper.vm.$nextTick()
        expect(vi.getTimerCount()).toBe(1)
        await wrapper.get('.ui-ripple-wave').trigger('animationend')
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('只在波纹存续期间订阅全局事件，多实例分别退订并清理', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { mql, listeners } = fakeMediaQueryList()
      const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
        (query === '(prefers-reduced-motion: reduce)' ? mql : fakeMediaQueryList().mql) as MediaQueryList,
      )
      const docAdd = vi.spyOn(document, 'addEventListener')
      const winAdd = vi.spyOn(window, 'addEventListener')
      try {
        const first = render()
        const second = render()
        expect(listeners.size).toBe(0)
        expect(docAdd.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(0)
        expect(winAdd.mock.calls.filter(([event]) => event === 'pagehide')).toHaveLength(0)
        pointerdown(first, { clientX: 30, clientY: 30 })
        pointerdown(second, { clientX: 30, clientY: 30 })
        await first.vm.$nextTick()
        expect(listeners.size).toBe(2)
        expect(vi.getTimerCount()).toBe(2)
        await first.get('.ui-ripple-wave').trigger('animationend')
        expect(listeners.size).toBe(1)
        expect(vi.getTimerCount()).toBe(1)
        first.unmount()
        expect(listeners.size).toBe(1)
        Object.defineProperty(document, 'hidden', { value: true, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        await second.vm.$nextTick()
        expect(waves(second)).toEqual([])
        expect(listeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
        pointerdown(second, { clientX: 30, clientY: 30 })
        await second.vm.$nextTick()
        expect(listeners.size).toBe(1)
        vi.advanceTimersByTime(220)
        await second.vm.$nextTick()
        expect(listeners.size).toBe(0)
        pointerdown(second, { clientX: 30, clientY: 30 })
        await second.vm.$nextTick()
        second.unmount()
        expect(listeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
        vi.useRealTimers()
        matchMedia.mockRestore()
      }
    })

    it('pagehide 清除全部波纹与计时器', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const wrapper = render()
        pointerdown(wrapper, { clientX: 30, clientY: 30 })
        await wrapper.vm.$nextTick()
        expect(vi.getTimerCount()).toBe(1)
        window.dispatchEvent(new Event('pagehide'))
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('页面隐藏清除波纹与计时器', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const wrapper = render()
        pointerdown(wrapper, { clientX: 30, clientY: 30 })
        await wrapper.vm.$nextTick()
        expect(vi.getTimerCount()).toBe(1)
        Object.defineProperty(document, 'hidden', { value: true, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
        vi.useRealTimers()
      }
    })

    it('减少动态效果媒体查询变化清除波纹', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { mql, listeners } = fakeMediaQueryList()
      const matchMedia = vi
        .spyOn(window, 'matchMedia')
        .mockImplementation((query) => (query === '(prefers-reduced-motion: reduce)' ? mql : fakeMediaQueryList().mql) as MediaQueryList)
      try {
        const wrapper = render()
        pointerdown(wrapper, { clientX: 30, clientY: 30 })
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(1)
        for (const listener of [...listeners]) listener()
        await wrapper.vm.$nextTick()
        expect(waves(wrapper)).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
        matchMedia.mockRestore()
      }
    })

    it('页面隐藏、aria-disabled 与高对比度时不生成波纹', async () => {
      const hiddenWrapper = render()
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      try {
        pointerdown(hiddenWrapper, { clientX: 30, clientY: 30 })
        keyboardClick(hiddenWrapper)
        await hiddenWrapper.vm.$nextTick()
        expect(waves(hiddenWrapper)).toEqual([])
      } finally {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      }

      const disabledWrapper = render()
      disabledWrapper.element.setAttribute('aria-disabled', 'true')
      pointerdown(disabledWrapper, { clientX: 30, clientY: 30 })
      keyboardClick(disabledWrapper)
      await disabledWrapper.vm.$nextTick()
      expect(waves(disabledWrapper)).toEqual([])

      const matchMedia = vi
        .spyOn(window, 'matchMedia')
        .mockImplementation((query) => ({ matches: query === '(forced-colors: active)' }) as MediaQueryList)
      try {
        const forcedWrapper = render()
        pointerdown(forcedWrapper, { clientX: 30, clientY: 30 })
        keyboardClick(forcedWrapper)
        await forcedWrapper.vm.$nextTick()
        expect(waves(forcedWrapper)).toEqual([])
      } finally {
        matchMedia.mockRestore()
      }
    })

    it('卸载移除文档/窗口/媒体查询监听并清空计时器', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { mql, removeSpy } = fakeMediaQueryList()
      const matchMedia = vi
        .spyOn(window, 'matchMedia')
        .mockImplementation((query) => (query === '(prefers-reduced-motion: reduce)' ? mql : fakeMediaQueryList().mql) as MediaQueryList)
      const docRemove = vi.spyOn(document, 'removeEventListener')
      const winRemove = vi.spyOn(window, 'removeEventListener')
      try {
        const wrapper = render()
        pointerdown(wrapper, { clientX: 30, clientY: 30 })
        await wrapper.vm.$nextTick()
        expect(vi.getTimerCount()).toBe(1)
        wrapper.unmount()
        expect(docRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
        expect(winRemove).toHaveBeenCalledWith('pagehide', expect.any(Function))
        expect(removeSpy).toHaveBeenCalledWith('change', expect.any(Function))
        expect(vi.getTimerCount()).toBe(0)
        window.dispatchEvent(new Event('pagehide'))
        document.dispatchEvent(new Event('visibilitychange'))
        await wrapper.vm.$nextTick()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
        matchMedia.mockRestore()
      }
    })
  })
})
