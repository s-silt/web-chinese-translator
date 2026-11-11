import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSurfaceExit, syncSurfaceVisibility } from '../../../src/translation/ui-surface'

let host: HTMLElement
let surface: HTMLElement
let finishAnimation: () => void

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  host = document.createElement('div')
  surface = document.createElement('div')
  surface.textContent = 'Synthetic result'
  surface.style.setProperty('--gcn-duration-exit', '100ms')
  host.append(surface)
  document.body.append(host)
  const finished = new Promise<void>(resolve => { finishAnimation = resolve })
  Object.defineProperty(surface, 'getAnimations', {
    configurable: true,
    value: () => [{ animationName: 'wt-surface-exit', finished }],
  })
})

afterEach(() => {
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

describe('浮层关闭的视觉收尾', () => {
  it('立即失去交互和无障碍可见性，动画结束后才清空内容', async () => {
    const exit = createSurfaceExit(surface, host)
    const finalize = vi.fn(() => { surface.textContent = '' })
    exit.hide(finalize)
    expect(surface.inert).toBe(true)
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    expect(surface.textContent).toBe('Synthetic result')
    expect(finalize).not.toHaveBeenCalled()
    finishAnimation()
    await vi.runAllTimersAsync()
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(surface.textContent).toBe('')
    expect(exit.isClosing()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('关闭后立即重开，旧动画和兜底计时器不能清掉新内容', async () => {
    const exit = createSurfaceExit(surface, host)
    const finalize = vi.fn(() => { surface.textContent = '' })
    exit.hide(finalize)
    exit.show()
    surface.textContent = 'New result'
    finishAnimation()
    await vi.runAllTimersAsync()
    expect(finalize).not.toHaveBeenCalled()
    expect(surface.textContent).toBe('New result')
    expect(surface.inert).toBe(false)
    expect(surface.hasAttribute('aria-hidden')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('没有动画时同步关闭，不依赖不会触发的结束事件', () => {
    Object.defineProperty(surface, 'getAnimations', { value: () => [] })
    const finalize = vi.fn()
    const exit = createSurfaceExit(surface, host)
    exit.hide(finalize)
    expect(finalize).toHaveBeenCalledOnce()
    expect(exit.isClosing()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('已经隐藏的容器不再触发动画或计算样式查询', () => {
    host.style.display = 'none'
    const computed = vi.spyOn(globalThis, 'getComputedStyle')
    const animations = vi.spyOn(surface, 'getAnimations')
    const finalize = vi.fn()
    createSurfaceExit(surface, host).hide(finalize)
    expect(finalize).toHaveBeenCalledOnce()
    expect(computed).not.toHaveBeenCalled()
    expect(animations).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('页面隐藏时结束在途淡出，不等待后台计时器', async () => {
    const exit = createSurfaceExit(surface, host)
    const finalize = vi.fn()
    exit.hide(finalize)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    syncSurfaceVisibility(host)
    expect(finalize).toHaveBeenCalledOnce()
    expect(host.hasAttribute('data-wt-page-hidden')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    finishAnimation()
    await vi.runAllTimersAsync()
    expect(finalize).toHaveBeenCalledOnce()
  })

  it('动画未返回时有限收尾，重复关闭和销毁不遗留计时器', async () => {
    const exit = createSurfaceExit(surface, host)
    const finalize = vi.fn()
    exit.hide(finalize)
    exit.hide(finalize)
    await vi.advanceTimersByTimeAsync(150)
    expect(finalize).toHaveBeenCalledOnce()
    exit.hide(finalize)
    exit.finish()
    expect(finalize).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
