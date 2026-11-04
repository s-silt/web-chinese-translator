// @vitest-environment-options { "url": "https://github.com/vuejs/core/issues" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createController, type Controller, type ControllerHost } from '../../../src/core/controller'
import {
  installTurboBridge,
  TURBO_RESET_EVENT,
  TURBO_REVISIT_EVENT,
  TURBO_TRANSLATING_EVENT,
  type BridgeWindow,
} from '../../../src/core/turbo-bridge'
import { $, settle, TEST_BUNDLE } from './helpers'

const HOME = '/vuejs/core/issues'
const HOME_URL = `https://github.com${HOME}`
const PULLS = '/vuejs/core/pulls'
const PULLS_URL = `https://github.com${PULLS}`
/** 各版本共用的安装记录 */
const BRIDGE_KEY = Symbol.for('github-chinese.turbo-bridge')

interface FakeTurbo {
  readonly cache: { clear: ReturnType<typeof vi.fn>; exemptPageFromCache: ReturnType<typeof vi.fn> }
  readonly visit: ReturnType<typeof vi.fn>
}

let uninstalls: (() => void)[] = []
let turbo: FakeTurbo
/** 为 false 时 visit() 不派发 turbo:visit（turbo:before-visit 被拦下） */
let visitStarts = true

/**
 * Turbo 的快照缓存（按 Turbo 7.2 的顺序）：访问渲染前把当前页面按上次渲染的地址缓存，
 * head 里的 turbo-cache-control 为 no-cache（exemptPageFromCache）时不缓存；每次渲染都合并 head，这个元素随之换掉
 */
const snapshots = new Map<string, HTMLElement>()
let lastRendered = ''

const CACHE_CONTROL = 'meta[name="turbo-cache-control"]'
const TRANSIENT = '[data-turbo-transient]'

/** head 里 turbo-cache-control 的值 */
function cacheControl(): string | null {
  return document.head.querySelector(CACHE_CONTROL)?.getAttribute('content') ?? null
}

/** GitHub 页面 head 里的 turbo-cache-control：no-preview，带 data-turbo-transient */
function cacheControlMeta(): Element {
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'turbo-cache-control')
  meta.setAttribute('content', 'no-preview')
  meta.setAttribute('data-turbo-transient', '')
  return meta
}

/** 换掉 head 里带 data-turbo-transient 的元素（Turbo 合并 head、GitHub 写回帧缓存） */
function replaceTransients(elements: readonly Element[]): void {
  const head = document.head
  if (!head) return
  for (const element of head.querySelectorAll(TRANSIENT)) element.remove()
  head.append(...elements)
}

/** 与 Turbo 一致：exemptPageFromCache 只改 head 里 turbo-cache-control 的 content，没有时新建 */
function setNoCache(): void {
  let meta = document.head.querySelector(CACHE_CONTROL)
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'turbo-cache-control')
    document.head.append(meta)
  }
  meta.setAttribute('content', 'no-cache')
}

/** 与 Turbo 一致：visit() 内同步派发 turbo:visit */
function createTurbo(): FakeTurbo {
  return {
    cache: {
      clear: vi.fn(() => snapshots.clear()),
      exemptPageFromCache: vi.fn(setNoCache),
    },
    visit: vi.fn((url: string, options?: { action?: string }) => {
      if (visitStarts) startVisit(url, options?.action)
    }),
  }
}

function setTurbo(value: FakeTurbo | undefined): void {
  Object.defineProperty(window, 'Turbo', { value, configurable: true })
}

function bridge(): void {
  uninstalls.push(installTurboBridge(window as BridgeWindow))
}

function install(withTurbo = true): void {
  turbo = createTurbo()
  setTurbo(withTurbo ? turbo : undefined)
  bridge()
}

/** 与 Turbo 一致：事件在 <html> 上派发，冒泡 */
function dispatchTurbo(name: string, detail: unknown): void {
  document.documentElement.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }))
}

/** Turbo 开始一次访问 */
function startVisit(url = location.href, action = 'advance'): void {
  dispatchTurbo('turbo:visit', { url, action })
}

/** Turbo 访问完成 */
function load(url = location.href): void {
  dispatchTurbo('turbo:load', { url, timing: {} })
}

/** 按 Turbo 的顺序渲染新 body：先合并 head（换上新页面的 turbo-cache-control），再派发 turbo:before-render，再替换 */
function render(newBody: HTMLElement): void {
  replaceTransients([cacheControlMeta()])
  dispatchTurbo('turbo:before-render', { newBody })
  document.body.replaceWith(newBody)
  lastRendered = location.href
}

/**
 * 不换 body 的渲染（willRender: false）：页面由当前文档重新解析，照样合并 head（换成解析出的副本）、
 * 派发 turbo:before-render（newBody 属于另一个文档），并记下渲染的地址
 */
function renderWithoutReplacing(): void {
  const page = new DOMParser().parseFromString(document.documentElement.outerHTML, 'text/html')
  replaceTransients([...page.head.querySelectorAll(TRANSIENT)])
  dispatchTurbo('turbo:before-render', { newBody: page.body })
  lastRendered = location.href
}

/**
 * 帧导航渲染完后的提升访问（GitHub 的 Turbo：willRender: false）：
 * Turbo 先取消进行中的访问（不派发事件），再派发 turbo:visit、turbo:before-render、turbo:load，不换 body
 */
function promotionVisit(url = location.href): void {
  startVisit(url, 'advance')
  renderWithoutReplacing()
  load()
}

/** 访问的响应到达：渲染前先缓存当前页面，再按访问地址渲染服务器返回的页面 */
function finishVisit(url: string, html: string): void {
  if (cacheControl() !== 'no-cache') snapshots.set(lastRendered, document.body.cloneNode(true) as HTMLElement)
  history.pushState(null, '', url)
  renderResponse(html)
  load(location.href)
}

/** 后退到 url：有缓存快照时直接渲染（不发请求），没有时渲染服务器返回的页面 */
function goBack(url: string, html: string): void {
  history.pushState(null, '', url)
  startVisit(location.href, 'restore')
  const snapshot = snapshots.get(location.href)
  if (cacheControl() !== 'no-cache') snapshots.set(lastRendered, document.body.cloneNode(true) as HTMLElement)
  if (snapshot) render(snapshot.cloneNode(true) as HTMLElement)
  else renderResponse(html)
  load()
}

/** 缓存快照：当前 body 的克隆 */
function renderCachedSnapshot(): void {
  render(document.body.cloneNode(true) as HTMLElement)
}

/** 网络响应：DOMParser 解析的 body，属于另一个文档 */
function renderResponse(html = '<p>Issues</p>'): void {
  render(new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body)
}

function reset(): void {
  window.dispatchEvent(new Event(TURBO_RESET_EVENT))
}

function forceRevisit(): void {
  window.dispatchEvent(new Event(TURBO_REVISIT_EVENT))
}

/** 当前滚动位置固定为 (0, 640)，返回 scrollTo 的监视 */
function scrolledTo640(): ReturnType<typeof vi.spyOn> {
  vi.spyOn(window, 'scrollX', 'get').mockReturnValue(0)
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640)
  return vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
}

/** 内容脚本翻译中在 <html> 上留的实例标记（见 core/instance-mark） */
const MARK = 'data-gcn-i-test'
/** 带 GitHub 帧缓存可替换元素的页面 */
const NAV_HTML = '<nav id="repo-nav" data-turbo-replace><p>Issues</p></nav>'

/** 翻译中的内容脚本应答桥接的询问 */
const answerTranslating = (event: Event): void => event.preventDefault()

/** 内容脚本开始、停止翻译：维护实例标记，翻译中应答询问 */
function translating(on: boolean): void {
  if (on) {
    document.documentElement.setAttribute(MARK, '')
    window.addEventListener(TURBO_TRANSLATING_EVENT, answerTranslating)
  } else {
    document.documentElement.removeAttribute(MARK)
    window.removeEventListener(TURBO_TRANSLATING_EVENT, answerTranslating)
  }
}

/** 内容脚本被直接销毁（Firefox 停用、更新扩展）：不再应答询问，标记与译文留在页面上 */
function destroyContentScript(): void {
  window.removeEventListener(TURBO_TRANSLATING_EVENT, answerTranslating)
}

/** GitHub 帧缓存里各地址 head 的 transient 元素：缓存时克隆，写回时原样移进 head（不克隆） */
const cachedTransients = new Map<string, Element[]>()
/** GitHub 的帧导航标志：帧渲染时设上，soft-nav:success 时清掉 */
let githubFrameNavigation = false

/** GitHub 按当前地址用帧缓存里的 transient 元素换掉 head 里的 */
function replaceTransientTags(): void {
  const cached = cachedTransients.get(location.href)
  if (cached) replaceTransients(cached)
}

/** GitHub 帧导航：帧请求的响应到达时，GitHub 缓存当前页面的标题、head 里的 transient 元素与 [data-turbo-replace] 元素 */
function frameResponse(): void {
  const frame = document.createElement('turbo-frame')
  document.body.append(frame)
  frame.dispatchEvent(new CustomEvent('turbo:before-fetch-response', { bubbles: true, detail: {} }))
  frame.remove()
  const transients = [...document.head.querySelectorAll(TRANSIENT)].map((element) => element.cloneNode(true) as Element)
  cachedTransients.set(location.href, transients)
}

/**
 * GitHub 帧渲染：渲染前用响应里的原文缓存目标地址（transient 元素为响应里的 no-preview），
 * 并换上响应里的 [data-turbo-replace] 元素；帧渲染后按当前地址写回帧缓存里的 transient 元素
 */
function frameRender(url: string, nav = '<p>Pull requests</p>'): void {
  const frame = document.createElement('turbo-frame')
  document.body.append(frame)
  const target = new URL(url, location.href)
  const detail = { fetchResponse: { location: target } }
  frame.dispatchEvent(new CustomEvent('turbo:before-frame-render', { bubbles: true, detail }))
  frame.remove()
  githubFrameNavigation = true
  cachedTransients.set(target.href, [cacheControlMeta()])
  const element = document.querySelector('[data-turbo-replace]')
  if (element) {
    const fresh = element.cloneNode(false) as Element
    fresh.innerHTML = nav
    element.replaceWith(fresh)
  }
  replaceTransientTags()
}

/**
 * 提升访问的 turbo:load 里 GitHub 派发 soft-nav:success；它的监听（注册在桥接之后）在帧导航后按当前地址
 * 写回帧缓存里的标题与 head 里的 transient 元素（packages/turbo/frame.ts）。cachedTitle 为该地址缓存里的标题
 */
function softNavSuccess(cachedTitle?: string): void {
  const replaceFromCache = (): void => {
    if (!githubFrameNavigation) return
    githubFrameNavigation = false
    if (cachedTitle !== undefined) document.title = cachedTitle
    replaceTransientTags()
  }
  document.addEventListener('soft-nav:success', replaceFromCache, { once: true })
  document.dispatchEvent(new Event('soft-nav:success'))
}

/** 恢复访问的 turbo:load 之后：GitHub 写回帧缓存里的标题与 [data-turbo-replace] 元素，派发 turbo:restored */
function writeBack(title = '议题 · vuejs/core', nav = '<p>议题</p>'): void {
  document.title = title
  const element = document.querySelector('[data-turbo-replace]')
  if (element) {
    const restored = element.cloneNode(false) as Element
    restored.innerHTML = nav
    element.replaceWith(restored)
  }
  document.dispatchEvent(new CustomEvent('turbo:restored'))
}

/** 前进后退到 url：Turbo 的缓存已清，渲染网络响应；之后 GitHub 写回帧缓存 */
function restoreFromGitHubCache(url: string, title?: string, nav?: string): void {
  history.pushState(null, '', url)
  startVisit(location.href, 'restore')
  renderResponse(NAV_HTML)
  document.title = 'Issues · vuejs/core'
  load()
  writeBack(title, nav)
}

beforeEach(() => {
  visitStarts = true
  snapshots.clear()
  cachedTransients.clear()
  githubFrameNavigation = false
  lastRendered = location.href
  replaceTransients([cacheControlMeta()])
  document.body.innerHTML = '<p>议题</p>'
})

afterEach(() => {
  for (const uninstall of uninstalls) uninstall()
  uninstalls = []
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'Turbo')
  Reflect.deleteProperty(window, BRIDGE_KEY)
  translating(false)
  document.title = ''
  for (const meta of document.head.querySelectorAll(CACHE_CONTROL)) meta.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', HOME)
})

describe('installTurboBridge', () => {
  it('渲染缓存克隆体后重置：清缓存，按原地址重新访问', () => {
    install()
    renderCachedSnapshot()
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(location.href, { action: 'replace' })
  })

  it('当前 body 来自网络响应：只清缓存，不重新访问', () => {
    install()
    reset()
    renderResponse()
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(2)
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('克隆体渲染后又经帧导航（body 不变）：仍重新访问', () => {
    install()
    renderCachedSnapshot()
    startVisit()
    $('p').textContent = 'Pull requests'
    load()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('访问进行中重置：等 turbo:load 再判断', () => {
    install()
    renderCachedSnapshot()
    startVisit()
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
    expect(turbo.visit).not.toHaveBeenCalled()
    renderResponse()
    load()
    expect(turbo.visit).not.toHaveBeenCalled()

    // 恢复访问开始时已取出缓存快照，随后才渲染
    startVisit(location.href, 'restore')
    reset()
    renderCachedSnapshot()
    load()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('推迟的重置被之后的访问取代：取代它的访问渲染缓存克隆体（重置后才缓存的）也不再访问', () => {
    install()
    startVisit('https://github.com/vuejs/core/pulls')
    reset()
    startVisit(location.href, 'restore')
    renderCachedSnapshot()
    load()
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('页面没有 Turbo、事件不带 newBody：不报错，普通重置不整页重新加载', () => {
    install(false)
    const reload = vi.spyOn(location, 'reload').mockImplementation(() => undefined)
    document.dispatchEvent(new CustomEvent('turbo:before-render'))
    document.dispatchEvent(new Event('turbo:visit'))
    renderCachedSnapshot()
    expect(() => reset()).not.toThrow()
    document.dispatchEvent(new Event('turbo:load'))
    expect(reload).not.toHaveBeenCalled()
  })

  it('还没有 body：只清缓存', () => {
    install()
    const body = document.body
    body.remove()
    try {
      reset()
      expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
      expect(turbo.visit).not.toHaveBeenCalled()
    } finally {
      document.documentElement.append(body)
    }
  })

  it('卸载后不再响应', () => {
    install()
    renderCachedSnapshot()
    uninstalls.pop()!()
    reset()
    forceRevisit()
    expect(turbo.cache.clear).not.toHaveBeenCalled()
    expect(turbo.visit).not.toHaveBeenCalled()
  })
})

describe('重复安装（扩展更新、补注）', () => {
  it('新装的先卸载旧桥接：一次重置只清一次缓存、访问一次', () => {
    install()
    bridge()
    renderCachedSnapshot()
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('克隆体在重装前就已渲染（Chrome 更新：先注入新桥接，旧实例随后失效）：新桥接接手克隆体记录，重置时重新访问', () => {
    install()
    renderCachedSnapshot()
    bridge()
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(location.href, { action: 'replace' })
  })

  it('访问进行中重装：新桥接同样等这次访问结束再判断，不打断它', () => {
    install()
    renderCachedSnapshot()
    startVisit('https://github.com/vuejs/core/pulls')
    bridge()
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
    finishVisit('/vuejs/core/pulls', '<p>Pull requests</p>')
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('安装记录在 window 上，卸载后移除；旧的卸载函数不影响新桥接', () => {
    install()
    const first = uninstalls[0]!
    bridge()
    const record = (window as unknown as Record<symbol, { uninstall?: unknown } | undefined>)[BRIDGE_KEY]
    expect(typeof record?.uninstall).toBe('function')
    first()
    forceRevisit()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    uninstalls.pop()!()
    expect(BRIDGE_KEY in window).toBe(false)
  })

  it('调用旧的卸载函数后记录仍属于新桥接：再装一次时卸载的是它，一次重置只清一次缓存', () => {
    install()
    const first = uninstalls[0]!
    bridge()
    first()
    bridge()
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
  })

  it('window 上的记录不是桥接（没有卸载函数）：照常安装', () => {
    ;(window as unknown as Record<symbol, unknown>)[BRIDGE_KEY] = {}
    install()
    renderCachedSnapshot()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('记录里的克隆体表、访问状态格式不符：卸载旧桥接后从空记录开始', () => {
    const uninstallOld = vi.fn()
    ;(window as unknown as Record<symbol, unknown>)[BRIDGE_KEY] = {
      uninstall: uninstallOld,
      clones: {},
      visiting: 'yes',
      translatedUrls: [location.href],
      restored: {},
    }
    install()
    expect(uninstallOld).toHaveBeenCalledTimes(1)
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
    renderCachedSnapshot()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('记录里的卸载函数抛错（被页面改过）：照常安装并处理重置', () => {
    ;(window as unknown as Record<symbol, unknown>)[BRIDGE_KEY] = {
      uninstall() {
        throw new Error('page')
      },
    }
    expect(() => install()).not.toThrow()
    renderCachedSnapshot()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('新桥接接手 GitHub 帧缓存的记录：旧桥接记下的带译文地址照常处理', () => {
    translating(true)
    install()
    frameResponse()
    history.pushState(null, '', '/vuejs/core/pulls')
    install()
    translating(false)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('新桥接接手重置前的记录：仍在翻译时写回重置前缓存的译文，照常重新访问', () => {
    translating(true)
    install()
    frameResponse()
    history.pushState(null, '', PULLS)
    reset()
    install()
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
  })

  it('接手的帧缓存记录一律算过时（新版本可能换了词典）：旧实例失效重置时新实例还没开始翻译，之后翻译中写回照常重新访问', () => {
    translating(true)
    install()
    frameResponse()
    history.pushState(null, '', PULLS)
    // 后台先注入新桥接；新内容脚本启动时旧实例失效，停止翻译并重置；新实例读完存储才开始翻译
    bridge()
    translating(false)
    reset()
    translating(true)
    restoreFromGitHubCache(HOME)
    expect(turbo.cache.exemptPageFromCache).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
  })

  it('接手后 GitHub 按当前页面重新缓存的以新缓存为准：翻译中写回不访问', () => {
    translating(true)
    install()
    frameResponse()
    history.pushState(null, '', PULLS)
    bridge()
    // 新实例翻译中帧导航回来、再离开：GitHub 按当前页面重新缓存
    history.pushState(null, '', HOME)
    frameResponse()
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('重装前注册的 GitHub 一次性 turbo:load 监听先于新桥接执行：写回时这次访问已结束，照常处理', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    // 锚点后退（同页恢复，不派发 turbo:visit、turbo:load）：GitHub 在 popstate 时注册的一次性监听留到之后的访问
    document.addEventListener('turbo:load', () => writeBack(), { once: true })
    // 扩展更新：新桥接的监听注册在它之后
    bridge()
    translating(false)
    reset()
    history.pushState(null, '', HOME)
    startVisit(location.href, 'advance')
    renderResponse(NAV_HTML)
    document.title = 'Issues · vuejs/core'
    load()
    expect(document.title).toBe('议题 · vuejs/core')
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
  })
})

describe('滚动位置绑定本次重新访问', () => {
  it('重新访问完成：turbo:load 时恢复，只恢复一次', () => {
    install()
    const scrollTo = scrolledTo640()
    renderCachedSnapshot()
    reset()
    renderResponse()
    load()
    expect(scrollTo).toHaveBeenCalledWith(0, 640)
    load()
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('重新访问被其他访问取代：之后的 turbo:load 不恢复', () => {
    install()
    const scrollTo = scrolledTo640()
    renderCachedSnapshot()
    reset()
    startVisit('https://github.com/vuejs/core/pulls')
    renderResponse()
    load('https://github.com/vuejs/core/pulls')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('被同一地址的用户导航取代：turbo:load 地址相同也不恢复', () => {
    install()
    const scrollTo = scrolledTo640()
    renderCachedSnapshot()
    reset()
    startVisit(location.href, 'advance')
    renderResponse()
    load()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('visit() 内派发的不是这次 replace 访问：不当作本次重新访问', () => {
    install()
    const scrollTo = scrolledTo640()
    turbo.visit.mockImplementation((url: string) => startVisit(url, 'advance'))
    renderCachedSnapshot()
    reset()
    renderResponse()
    load()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('visit() 内派发的 replace 访问地址不同：不当作本次重新访问', () => {
    install()
    const scrollTo = scrolledTo640()
    turbo.visit.mockImplementation(() => startVisit('https://github.com/vuejs/core/pulls', 'replace'))
    renderCachedSnapshot()
    reset()
    renderResponse()
    load()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('重新访问失败（只有 turbo:visit，没有 turbo:load），之后正常导航：不恢复', () => {
    install()
    const scrollTo = scrolledTo640()
    renderCachedSnapshot()
    reset()
    renderResponse('<p>Server error</p>')
    startVisit('https://github.com/vuejs/core/pulls')
    renderResponse()
    load('https://github.com/vuejs/core/pulls')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('重新访问进行中又收到重置，随后被用户导航取代：不恢复滚动，导航完成后不再访问', () => {
    install()
    const scrollTo = scrolledTo640()
    renderCachedSnapshot()
    reset()
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(2)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    startVisit('https://github.com/vuejs/core/pulls')
    renderResponse()
    load('https://github.com/vuejs/core/pulls')
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('visit() 没有派发 turbo:visit（被拦下）：之后同地址的访问不当作本次重新访问', () => {
    install()
    const scrollTo = scrolledTo640()
    visitStarts = false
    renderCachedSnapshot()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    startVisit(location.href, 'replace')
    renderResponse()
    load()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('重定向到别处（turbo:load 的地址不同）：不恢复', () => {
    install()
    const scrollTo = scrolledTo640()
    renderCachedSnapshot()
    reset()
    renderResponse()
    load('https://github.com/login')
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('克隆体渲染后地址变化', () => {
  it('前进后退（Turbo 在同一任务里接手）：只清缓存，不重新访问', async () => {
    install()
    const scrollTo = scrolledTo640()
    renderCachedSnapshot()
    history.replaceState(null, '', '/settings/profile')
    reset()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
    expect(turbo.visit).not.toHaveBeenCalled()
    startVisit(location.href, 'restore')
    await settle()
    renderResponse('<p>Public profile</p>')
    load()
    expect(turbo.visit).not.toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('其他脚本改了地址（本轮任务没有访问接手）：随后按当前地址重新访问', async () => {
    install()
    renderCachedSnapshot()
    history.pushState(null, '', '/vuejs/core/issues/1')
    reset()
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
    await settle()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith('https://github.com/vuejs/core/issues/1', { action: 'replace' })
  })

  it('本轮任务内多次重置只排一次检查：visit() 被拦下也只访问一次', async () => {
    install()
    visitStarts = false
    renderCachedSnapshot()
    history.pushState(null, '', '/vuejs/core/issues/1')
    reset()
    reset()
    await settle()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('等待期间 body 已换成网络响应：不重新访问', async () => {
    install()
    renderCachedSnapshot()
    history.pushState(null, '', '/vuejs/core/issues/1')
    reset()
    renderResponse()
    await settle()
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('等待期间卸载：不再重新访问', async () => {
    install()
    renderCachedSnapshot()
    history.pushState(null, '', '/vuejs/core/issues/1')
    reset()
    uninstalls.pop()!()
    await settle()
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('只改了锚点：同一页面，立即重新访问', () => {
    install()
    renderCachedSnapshot()
    history.replaceState(null, '', `${HOME}#issuecomment-1`)
    reset()
    expect(turbo.visit).toHaveBeenCalledWith(location.href, { action: 'replace' })
  })
})

describe('强制重新访问（页面上有已失效实例的译文）', () => {
  it('body 不是克隆体也清缓存，按当前地址重新访问', () => {
    install()
    forceRevisit()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(location.href, { action: 'replace' })
  })

  it('没有 Turbo：整页重新加载', () => {
    install(false)
    const reload = vi.spyOn(location, 'reload').mockImplementation(() => undefined)
    forceRevisit()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('访问进行中：等 turbo:load，换成网络响应的不再访问，克隆体照常重新访问', () => {
    install()
    startVisit('https://github.com/vuejs/core/pulls')
    forceRevisit()
    expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
    expect(turbo.visit).not.toHaveBeenCalled()
    renderResponse()
    load('https://github.com/vuejs/core/pulls')
    expect(turbo.visit).not.toHaveBeenCalled()

    startVisit(location.href, 'restore')
    forceRevisit()
    renderCachedSnapshot()
    load()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('访问进行中，这次访问没换 body（帧提升访问）：turbo:load 后按当前地址重新访问', () => {
    install()
    startVisit('https://github.com/vuejs/core/pulls')
    forceRevisit()
    expect(turbo.visit).not.toHaveBeenCalled()
    history.pushState(null, '', '/vuejs/core/pulls')
    // GitHub 的 Turbo 不换 body 也派发 turbo:before-render
    renderWithoutReplacing()
    load(location.href)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(location.href, { action: 'replace' })
  })

  it('访问进行中先收到强制事件、再收到普通重置，这次访问没换 body：仍按强制重新访问', () => {
    install()
    startVisit(PULLS_URL)
    forceRevisit()
    // 已失效实例的标记已清掉，之后的重置是普通重置；body 上仍是那些旧译文
    reset()
    history.pushState(null, '', PULLS)
    renderWithoutReplacing()
    load(location.href)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(PULLS_URL, { action: 'replace' })
  })

  it('访问进行中又有一次不换 body 的访问：等之后的 turbo:load，只访问一次', () => {
    install()
    startVisit('https://github.com/vuejs/core/pulls')
    forceRevisit()
    startVisit('https://github.com/vuejs/core/pulls?q=is%3Aopen')
    load()
    load()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('滚动位置同样绑定本次访问', () => {
    install()
    const scrollTo = scrolledTo640()
    forceRevisit()
    renderResponse()
    load()
    expect(scrollTo).toHaveBeenCalledWith(0, 640)

    forceRevisit()
    startVisit('https://github.com/vuejs/core/pulls')
    renderResponse()
    load('https://github.com/vuejs/core/pulls')
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })
})

describe('帧导航的提升访问取消重新访问（不派发事件、不换 body）', () => {
  it('克隆体页面上帧导航进排除路径：提升访问结束时 body 仍是克隆体，再按当前地址访问一次', async () => {
    install()
    renderCachedSnapshot()
    const clone = document.body
    // 帧响应到达后 changeHistory：内容脚本发现进了排除路径，停止翻译并重置
    frameResponse()
    history.pushState(null, '', PULLS)
    reset()
    await settle()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenLastCalledWith(PULLS_URL, { action: 'replace' })
    // 帧渲染完成后的提升访问：Turbo 取消进行中的重新访问
    frameRender(PULLS_URL)
    promotionVisit()
    expect(document.body).toBe(clone)
    await settle()
    expect(turbo.visit).toHaveBeenCalledTimes(2)
    expect(turbo.visit).toHaveBeenLastCalledWith(PULLS_URL, { action: 'replace' })

    // 这次重新访问换上原文：之后不再访问
    renderResponse('<p>Pull requests</p>')
    load()
    await settle()
    expect(turbo.visit).toHaveBeenCalledTimes(2)
  })

  it('强制重新访问被提升访问取消：提升访问结束后再强制访问一次', () => {
    install()
    const stale = document.body
    frameResponse()
    history.pushState(null, '', PULLS)
    forceRevisit()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    frameRender(PULLS_URL)
    promotionVisit()
    expect(document.body).toBe(stale)
    expect(turbo.visit).toHaveBeenCalledTimes(2)
    expect(turbo.visit).toHaveBeenLastCalledWith(PULLS_URL, { action: 'replace' })
  })

  it('强制重新访问进行中又收到普通重置，随后被提升访问取消：仍按强制再访问一次', () => {
    install()
    const stale = document.body
    frameResponse()
    history.pushState(null, '', PULLS)
    forceRevisit()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    // 内容脚本已清掉已失效实例的标记，再次重置时派发普通重置；body 上仍是那些旧译文
    reset()
    frameRender(PULLS_URL)
    promotionVisit()
    expect(document.body).toBe(stale)
    expect(turbo.visit).toHaveBeenCalledTimes(2)
    expect(turbo.visit).toHaveBeenLastCalledWith(PULLS_URL, { action: 'replace' })
  })

  it('推迟的重置随后被不换 body 的访问取代：结束时照常按克隆体判断', () => {
    install()
    renderCachedSnapshot()
    startVisit(PULLS_URL)
    reset()
    promotionVisit(HOME_URL)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
  })

  it('重新访问先于提升访问完成：不再访问', async () => {
    install()
    renderCachedSnapshot()
    frameResponse()
    history.pushState(null, '', PULLS)
    reset()
    await settle()
    renderResponse('<p>Pull requests</p>')
    load()
    frameRender(PULLS_URL)
    promotionVisit()
    await settle()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('body 不是克隆体、页面上也没有写回的译文：帧导航后不访问', async () => {
    install()
    frameResponse()
    history.pushState(null, '', PULLS)
    reset()
    frameRender(PULLS_URL)
    promotionVisit()
    await settle()
    expect(turbo.visit).not.toHaveBeenCalled()
  })
})

describe('带旧译文的页面不再进 Turbo 缓存', () => {
  it('克隆体上的重新访问被用户导航取代：后退时不再渲染这个克隆体', () => {
    install()
    renderCachedSnapshot()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    startVisit('https://github.com/vuejs/core/pulls')
    finishVisit('/vuejs/core/pulls', '<p>Pull requests</p>')
    goBack(HOME, '<p>Issues</p>')
    expect($('p').textContent).toBe('Issues')
  })

  it('跳转进行中在克隆体上重置：后退时不再渲染这个克隆体', () => {
    install()
    renderCachedSnapshot()
    startVisit('https://github.com/vuejs/core/pulls')
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
    finishVisit('/vuejs/core/pulls', '<p>Pull requests</p>')
    expect(turbo.visit).not.toHaveBeenCalled()
    goBack(HOME, '<p>Issues</p>')
    expect($('p').textContent).toBe('Issues')
  })

  it('前进后退途中在克隆体上重置（地址已变）：离开的克隆体不进缓存', async () => {
    install()
    renderCachedSnapshot()
    history.pushState(null, '', '/settings/profile')
    reset()
    startVisit(location.href, 'restore')
    await settle()
    finishVisit('/settings/profile', '<p>Public profile</p>')
    expect(turbo.visit).not.toHaveBeenCalled()
    goBack(HOME, '<p>Issues</p>')
    expect($('p').textContent).toBe('Issues')
  })

  it('重新访问完成：克隆体本身不进缓存，之后照常缓存', () => {
    install()
    renderCachedSnapshot()
    reset()
    finishVisit(HOME, '<p>Issues</p>')
    expect(snapshots.size).toBe(0)
    startVisit('https://github.com/vuejs/core/pulls')
    finishVisit('/vuejs/core/pulls', '<p>Pull requests</p>')
    expect([...snapshots.keys()]).toEqual([`https://github.com${HOME}`])
  })

  it('强制重新访问：不论 body 来源都不缓存当前页面', () => {
    install()
    forceRevisit()
    expect(turbo.cache.exemptPageFromCache).toHaveBeenCalledTimes(1)
    renderResponse()
    load()

    startVisit('https://github.com/vuejs/core/pulls')
    forceRevisit()
    expect(turbo.cache.exemptPageFromCache).toHaveBeenCalledTimes(2)
  })

  it('当前 body 来自网络响应：重置时照常缓存（页面已由内容脚本还原）', () => {
    install()
    reset()
    startVisit('https://github.com/vuejs/core/pulls')
    reset()
    expect(turbo.cache.exemptPageFromCache).not.toHaveBeenCalled()
  })

  it('Turbo 没有 exemptPageFromCache（旧版本）：照常重新访问', () => {
    install()
    Object.defineProperty(turbo, 'cache', { value: { clear: turbo.cache.clear } })
    renderCachedSnapshot()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('页面没有 <head>：不调用 exemptPageFromCache（它要往 head 里写），照常重新访问', () => {
    install()
    const head = document.head
    head.remove()
    try {
      renderCachedSnapshot()
      reset()
      expect(turbo.cache.exemptPageFromCache).not.toHaveBeenCalled()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
    } finally {
      document.documentElement.prepend(head)
    }
  })

  describe('帧导航打断重新访问：GitHub 在 soft-nav:success 换回 head 里的 turbo-cache-control', () => {
    /** 响应到达前点了仓库标签：帧导航，提升访问取消重新访问；随后 GitHub 在 soft-nav:success 写回 /pulls 的帧缓存 */
    function frameNavigateToPulls(): void {
      frameResponse()
      history.pushState(null, '', PULLS)
      frameRender(PULLS_URL)
      promotionVisit()
      softNavSuccess('Pull requests · vuejs/core')
    }

    /** 翻译中前进后退渲染的克隆体上停用翻译：按克隆体重新访问，响应到达前帧导航；提升访问结束后再访问 /pulls */
    async function interruptCloneRevisit(): Promise<void> {
      install()
      translating(true)
      renderCachedSnapshot()
      translating(false)
      reset()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      frameNavigateToPulls()
      await settle()
      expect(turbo.visit).toHaveBeenCalledTimes(2)
      expect(turbo.visit).toHaveBeenLastCalledWith(PULLS_URL, { action: 'replace' })
    }

    /** 再访问的响应到达前后退：GitHub 写回 /issues 帧缓存里的旧译文，桥接重新访问换成原文；随后前进到 /pulls */
    function backThenForward(): void {
      goBack(HOME, NAV_HTML)
      writeBack()
      expect(turbo.visit).toHaveBeenCalledTimes(3)
      expect(turbo.visit).toHaveBeenLastCalledWith(HOME_URL, { action: 'replace' })
      finishVisit(HOME, NAV_HTML)
      goBack(PULLS, '<p>Pull requests</p>')
    }

    it('克隆体：再访问期间 turbo-cache-control 仍为 no-cache', async () => {
      await interruptCloneRevisit()
      expect(cacheControl()).toBe('no-cache')
    })

    it('克隆体：再访问的响应到达前后退、再前进，不渲染这个克隆体', async () => {
      await interruptCloneRevisit()
      backThenForward()
      expect($('p').textContent).toBe('Pull requests')
      expect(snapshots.has(PULLS_URL)).toBe(false)
      expect(turbo.visit).toHaveBeenCalledTimes(3)
    })

    it('强制重新访问：再访问期间同样仍为 no-cache，后退再前进不渲染带旧译文的页面', async () => {
      install()
      forceRevisit()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      frameNavigateToPulls()
      expect(turbo.visit).toHaveBeenCalledTimes(2)
      expect(turbo.visit).toHaveBeenLastCalledWith(PULLS_URL, { action: 'replace' })
      await settle()
      expect(cacheControl()).toBe('no-cache')

      backThenForward()
      expect($('p').textContent).toBe('Pull requests')
      expect(snapshots.has(PULLS_URL)).toBe(false)
      expect(turbo.visit).toHaveBeenCalledTimes(3)
    })

    it('页面上没有等重新访问换掉的旧译文：不免缓存', async () => {
      install()
      translating(true)
      frameNavigateToPulls()
      await settle()
      expect(turbo.cache.exemptPageFromCache).not.toHaveBeenCalled()
      expect(cacheControl()).toBe('no-preview')
    })

    it('soft-nav:success 推迟到之后的访问期间（如 React 页面），访问中收到重置、页面上没有旧译文：不免缓存', async () => {
      install()
      frameResponse()
      history.pushState(null, '', PULLS)
      frameRender(PULLS_URL)
      promotionVisit()
      startVisit(`${PULLS_URL}/1`)
      reset()
      softNavSuccess()
      await settle()
      expect(turbo.cache.exemptPageFromCache).not.toHaveBeenCalled()
    })

    it('soft-nav:success 之前没有帧渲染（GitHub 不换 head）：不再免缓存', async () => {
      install()
      renderCachedSnapshot()
      reset()
      expect(turbo.cache.exemptPageFromCache).toHaveBeenCalledTimes(1)
      softNavSuccess()
      await settle()
      expect(turbo.cache.exemptPageFromCache).toHaveBeenCalledTimes(1)
      expect(cacheControl()).toBe('no-cache')
    })
  })
})

describe('GitHub 帧缓存写回带译文的标题与元素', () => {
  beforeEach(() => {
    document.body.innerHTML = '<nav id="repo-nav" data-turbo-replace><p>议题</p></nav>'
    document.title = '议题 · vuejs/core'
  })

  it('翻译中缓存，停止翻译后写回：立即按当前地址重新访问，不缓存当前页面', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    translating(false)
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()

    restoreFromGitHubCache(HOME)
    expect(turbo.cache.exemptPageFromCache).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
  })

  it('翻译中写回：显示正常，不访问；之后重置时重新访问', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).not.toHaveBeenCalled()

    translating(false)
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
  })

  it('只写回了标题（页面上没有可替换元素）：重置时同样重新访问', () => {
    document.body.innerHTML = '<p>议题</p>'
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    history.pushState(null, '', HOME)
    startVisit(location.href, 'restore')
    renderResponse('<p>Issues</p>')
    load()
    writeBack()
    translating(false)
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('写回的元素还在、标题已被页面改掉：重置时照常重新访问', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME)
    document.title = '(1) Issues · vuejs/core'
    translating(false)
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('不在翻译时缓存的：写回后不访问，重置也不访问', () => {
    install()
    frameResponse()
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME, 'Issues · vuejs/core', '<p>Issues</p>')
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('翻译中缓存过、之后不在翻译时又被缓存：以最近一次为准', () => {
    install()
    translating(true)
    frameResponse()
    translating(false)
    frameResponse()
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME, 'Issues · vuejs/core', '<p>Issues</p>')
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('帧渲染时 GitHub 用响应里的原文缓存目标地址：此前带译文的记录作废', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    translating(false)
    // 停止翻译后帧导航回来：GitHub 先缓存当前页面，再用响应缓存目标地址
    frameResponse()
    frameRender(HOME_URL, '<p>Issues</p>')
    history.pushState(null, '', HOME)
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME, 'Issues · vuejs/core', '<p>Issues</p>')
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('不是帧发出的请求（整页访问）：GitHub 不缓存，不记下', () => {
    install()
    translating(true)
    document.dispatchEvent(new CustomEvent('turbo:before-fetch-response', { bubbles: true, detail: {} }))
    history.pushState(null, '', PULLS)
    translating(false)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('写回后又有访问换掉标题与元素：重置时不再访问', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME)
    history.pushState(null, '', PULLS)
    startVisit()
    renderResponse('<nav id="repo-nav" data-turbo-replace><p>Pull requests</p></nav>')
    document.title = 'Pull requests · vuejs/core'
    load()
    translating(false)
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('写回后再次访问同一页面：标题译成相同文字，重置时也不再访问', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    restoreFromGitHubCache(HOME)
    startVisit()
    renderResponse('<nav id="repo-nav" data-turbo-replace><p>议题</p></nav>')
    document.title = '议题 · vuejs/core'
    load()
    // 仍在翻译（如改了自定义词条）
    reset()
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('写回时本桥接的重新访问已在进行：不另行访问，重新访问完成后不再访问', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    // 后退：Turbo 渲染缓存快照，途中停止翻译
    history.pushState(null, '', HOME)
    startVisit(location.href, 'restore')
    renderCachedSnapshot()
    translating(false)
    reset()
    // turbo:load：桥接先按克隆体重新访问，GitHub 随后写回
    load()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
    writeBack()
    expect(turbo.visit).toHaveBeenCalledTimes(1)

    renderResponse(NAV_HTML)
    document.title = 'Issues · vuejs/core'
    load()
    reset()
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('首次安装时文档已就绪且正在翻译：首个页面按带译文算', () => {
    translating(true)
    install()
    history.pushState(null, '', PULLS)
    translating(false)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('重装时接手旧桥接的记录：不按现在是否在翻译猜测当前页面', () => {
    install()
    frameResponse()
    translating(true)
    install()
    history.pushState(null, '', PULLS)
    translating(false)
    restoreFromGitHubCache(HOME, 'Issues · vuejs/core', '<p>Issues</p>')
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('文档解析中安装：按 DOMContentLoaded 时是否在翻译记下首个页面', () => {
    const readyState = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
    install()
    readyState.mockReturnValue('interactive')
    translating(true)
    document.dispatchEvent(new Event('DOMContentLoaded'))
    history.pushState(null, '', PULLS)
    translating(false)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).toHaveBeenCalledTimes(1)
  })

  it('文档解析中安装、DOMContentLoaded 时没在翻译：首个页面不算', () => {
    const readyState = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
    install()
    readyState.mockReturnValue('interactive')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    translating(true)
    history.pushState(null, '', PULLS)
    translating(false)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  it('卸载后不再处理写回', () => {
    install()
    translating(true)
    frameResponse()
    history.pushState(null, '', PULLS)
    for (const uninstall of uninstalls) uninstall()
    uninstalls = []
    translating(false)
    restoreFromGitHubCache(HOME)
    expect(turbo.visit).not.toHaveBeenCalled()
  })

  describe('是否在翻译只认应答询问的内容脚本，不看 <html> 上的标记', () => {
    it('GitHub 前进后退写回已失效实例的标记（Chrome 停用扩展）：写回后立即重新访问', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      translating(false)
      reset()
      // 后退：GitHub 按地址还原 <html> 属性，写回了这个已失效实例的标记
      document.documentElement.setAttribute(MARK, '')
      restoreFromGitHubCache(HOME)
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
    })

    it('内容脚本被直接销毁（Firefox 停用扩展，不派发重置）：留下的标记不算在翻译，写回后立即重新访问', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      destroyContentScript()
      restoreFromGitHubCache(HOME)
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
    })

    it('GitHub 缓存当前页面时只有已失效实例的标记：按未在翻译记下', () => {
      install()
      document.documentElement.setAttribute(MARK, '')
      frameResponse()
      history.pushState(null, '', PULLS)
      restoreFromGitHubCache(HOME, 'Issues · vuejs/core', '<p>Issues</p>')
      reset()
      expect(turbo.visit).not.toHaveBeenCalled()
    })

    it('首次安装时只有已失效实例的标记：首个页面不按带译文算', () => {
      document.documentElement.setAttribute(MARK, '')
      install()
      history.pushState(null, '', PULLS)
      restoreFromGitHubCache(HOME, 'Issues · vuejs/core', '<p>Issues</p>')
      reset()
      expect(turbo.visit).not.toHaveBeenCalled()
    })

    it('询问事件是可取消、不带 detail 的普通 Event：跨世界读不到 detail', () => {
      const seen: Event[] = []
      const listener = (event: Event): void => {
        seen.push(event)
      }
      window.addEventListener(TURBO_TRANSLATING_EVENT, listener)
      try {
        install()
        frameResponse()
      } finally {
        window.removeEventListener(TURBO_TRANSLATING_EVENT, listener)
      }
      expect(seen).toHaveLength(2)
      for (const event of seen) {
        expect(event.constructor).toBe(Event)
        expect(event.cancelable).toBe(true)
        expect('detail' in event).toBe(false)
      }
    })
  })

  describe('重置前缓存的译文已过时', () => {
    it('停止翻译的重置不作废（关闭再开启翻译）：之后翻译中写回此前缓存的译文，与当前译文一致，不访问', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      translating(false)
      reset()
      translating(true)
      restoreFromGitHubCache(HOME)
      expect(turbo.cache.exemptPageFromCache).not.toHaveBeenCalled()
      expect(turbo.visit).not.toHaveBeenCalled()

      // 写回的译文没有翻译记录：之后停止翻译时照常重新访问
      translating(false)
      reset()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
    })

    it('翻译中缓存，改词条（重置）后写回：仍在翻译也立即重新访问，不缓存当前页面', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      reset()
      restoreFromGitHubCache(HOME)
      expect(turbo.cache.exemptPageFromCache).toHaveBeenCalledTimes(1)
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      expect(turbo.visit).toHaveBeenCalledWith(HOME_URL, { action: 'replace' })
    })

    it('改词条后、重新访问完成前帧导航：GitHub 缓存了写回的旧译文，翻译中写回照常重新访问', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      restoreFromGitHubCache(HOME)
      // 改词条：写回的旧译文还在，重新访问；响应到达前点了仓库标签，GitHub 缓存当前页面
      reset()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      frameResponse()
      history.pushState(null, '', PULLS)
      frameRender(PULLS_URL)
      document.title = 'Pull requests · vuejs/core'
      promotionVisit()
      restoreFromGitHubCache(HOME)
      expect(turbo.visit).toHaveBeenCalledTimes(2)
      expect(turbo.visit).toHaveBeenLastCalledWith(HOME_URL, { action: 'replace' })
    })

    it('强制重新访问同样作废此前的帧缓存', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      forceRevisit()
      renderResponse('<nav id="repo-nav" data-turbo-replace><p>拉取请求</p></nav>')
      load()
      restoreFromGitHubCache(HOME)
      expect(turbo.visit).toHaveBeenCalledTimes(2)
      expect(turbo.visit).toHaveBeenLastCalledWith(HOME_URL, { action: 'replace' })
    })

    it('重置后 GitHub 按当前页面重新缓存该地址：以新缓存为准，翻译中写回时不再访问', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      reset()
      restoreFromGitHubCache(HOME)
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      // 重新访问换上服务器返回的原文，内容脚本按新词条翻译
      renderResponse('<nav id="repo-nav" data-turbo-replace><p>问题</p></nav>')
      document.title = '问题 · vuejs/core'
      load()
      // 帧导航离开：GitHub 按当前页面重新缓存
      frameResponse()
      history.pushState(null, '', PULLS)
      restoreFromGitHubCache(HOME, '问题 · vuejs/core', '<p>问题</p>')
      expect(turbo.visit).toHaveBeenCalledTimes(1)
    })
  })

  describe('停止翻译后页面上留着写回的译文时被 GitHub 缓存', () => {
    it('重新访问完成前帧导航：GitHub 缓存了写回的标题与元素，后退写回时重新访问', () => {
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      restoreFromGitHubCache(HOME)
      translating(false)
      reset()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      // 响应到达前点了仓库标签：GitHub 缓存当前页面，标题与导航仍是写回的译文
      frameResponse()
      history.pushState(null, '', PULLS)
      frameRender(PULLS_URL)
      document.title = 'Pull requests · vuejs/core'
      promotionVisit()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      restoreFromGitHubCache(HOME)
      expect(turbo.visit).toHaveBeenCalledTimes(2)
      expect(turbo.visit).toHaveBeenLastCalledWith(HOME_URL, { action: 'replace' })
    })

    it('只写回了标题：重新访问开始后标题仍算写回的，帧导航时 GitHub 缓存的标题带译文', () => {
      document.body.innerHTML = '<p>议题</p>'
      install()
      translating(true)
      frameResponse()
      history.pushState(null, '', PULLS)
      history.pushState(null, '', HOME)
      startVisit(location.href, 'restore')
      renderResponse('<p>Issues</p>')
      load()
      writeBack()
      translating(false)
      reset()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      frameResponse()
      history.pushState(null, '', PULLS)
      frameRender(PULLS_URL)
      document.title = 'Pull requests · vuejs/core'
      promotionVisit()
      history.pushState(null, '', HOME)
      startVisit(location.href, 'restore')
      renderResponse('<p>Issues</p>')
      document.title = 'Issues · vuejs/core'
      load()
      writeBack()
      expect(turbo.visit).toHaveBeenCalledTimes(2)
    })

    it('未在翻译时渲染的克隆体（不带译文）被 GitHub 缓存：不记下', () => {
      document.body.innerHTML = NAV_HTML
      document.title = 'Issues · vuejs/core'
      install()
      renderCachedSnapshot()
      frameResponse()
      history.pushState(null, '', PULLS)
      restoreFromGitHubCache(HOME, 'Issues · vuejs/core', '<p>Issues</p>')
      expect(turbo.visit).not.toHaveBeenCalled()
    })
  })

  describe('帧导航到带锚点的地址：GitHub 在 soft-nav:success 按带锚点的当前地址写回标题', () => {
    const ISSUE = '/vuejs/core/issues/1'
    const ISSUE_URL = `https://github.com${ISSUE}`
    const ANCHORED = `${ISSUE}#issuecomment-1`
    const TRANSLATED = 'Sample text · 议题 #1 · vuejs/core'

    /** 翻译中经帧导航离开带锚点的地址：GitHub 按带锚点的当前地址缓存标题 */
    function leaveAnchoredWhileTranslating(): void {
      translating(true)
      history.replaceState(null, '', ANCHORED)
      document.title = TRANSLATED
      frameResponse()
      history.pushState(null, '', PULLS)
      frameRender(PULLS_URL)
      promotionVisit(PULLS_URL)
      softNavSuccess('Pull requests · vuejs/core')
    }

    /** 帧导航到同一锚点链接：响应地址不带锚点，GitHub 渲染后补回锚点，按带锚点地址的缓存写回标题 */
    function frameNavigateToAnchored(): void {
      frameResponse()
      history.pushState(null, '', ISSUE)
      frameRender(ISSUE_URL)
      history.replaceState(null, '', ANCHORED)
      promotionVisit(ISSUE_URL)
      softNavSuccess(TRANSLATED)
    }

    it('停止翻译后进入：写回翻译中缓存的标题，立即重新访问', async () => {
      install()
      leaveAnchoredWhileTranslating()
      await settle()
      expect(turbo.visit).not.toHaveBeenCalled()
      translating(false)
      reset()
      frameNavigateToAnchored()
      expect(document.title).toBe(TRANSLATED)
      await settle()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      expect(turbo.visit).toHaveBeenCalledWith(`https://github.com${ANCHORED}`, { action: 'replace' })
    })

    it('翻译中进入：显示正常不访问，之后停止翻译时重新访问', async () => {
      install()
      leaveAnchoredWhileTranslating()
      frameNavigateToAnchored()
      await settle()
      expect(turbo.visit).not.toHaveBeenCalled()
      translating(false)
      reset()
      expect(turbo.visit).toHaveBeenCalledTimes(1)
      expect(turbo.visit).toHaveBeenCalledWith(`https://github.com${ANCHORED}`, { action: 'replace' })
    })

    it('soft-nav:success 之前没有帧渲染（React 等导航）：GitHub 不写回标题，不处理', async () => {
      install()
      translating(true)
      frameResponse()
      translating(false)
      softNavSuccess()
      await settle()
      expect(turbo.visit).not.toHaveBeenCalled()
    })

    it('写回后卸载：不再处理', async () => {
      install()
      leaveAnchoredWhileTranslating()
      translating(false)
      reset()
      frameNavigateToAnchored()
      for (const uninstall of uninstalls) uninstall()
      uninstalls = []
      await settle()
      expect(turbo.visit).not.toHaveBeenCalled()
    })
  })
})

describe('与控制器一起：排除路径', () => {
  /** 照 content.ts 接线的真实控制器：重置时派发重置事件，翻译中应答桥接的询问；地址变化由 currententrychange 通知 */
  function startController(excludedPaths: string[]): { controller: Controller; navigation: EventTarget; stop(): void } {
    const navigation = new EventTarget()
    const host: ControllerHost & { navigation: EventTarget } = {
      document,
      location,
      MutationObserver,
      navigation,
      addEventListener: (type, listener) => window.addEventListener(type, listener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    }
    const controller = createController({
      bundle: TEST_BUNDLE,
      settings: {
        enabled: true,
        translateTime: true,
        translateTitle: true,
        excludedPaths,
        language: 'auto',
        uiLanguage: 'auto',
        theme: 'auto',
  uiStyle: 'classic',
      },
      customEntries: {},
      isPathExcluded: (pathname, patterns) => patterns.some((pattern) => pathname.startsWith(pattern)),
      onReset: () => window.dispatchEvent(new Event(TURBO_RESET_EVENT)),
      host,
    })
    const answer = (event: Event): void => {
      if (controller.translator.active) event.preventDefault()
    }
    window.addEventListener(TURBO_TRANSLATING_EVENT, answer)
    return {
      controller,
      navigation,
      stop() {
        window.removeEventListener(TURBO_TRANSLATING_EVENT, answer)
        controller.dispose()
      },
    }
  }

  it('currententrychange 先于 popstate 停止翻译：不按目标地址重新访问，不套用上一页的滚动位置', async () => {
    install()
    const scrollTo = scrolledTo640()
    document.body.innerHTML = '<p>Issues</p>'
    const { controller, navigation, stop } = startController(['/settings'])
    try {
      expect($('p').textContent).toBe('议题')
      // 前进到别处再后退：Turbo 渲染离开时的缓存快照
      renderCachedSnapshot()
      await settle()

      // 再后退到排除路径：地址先变，currententrychange 先派发
      history.replaceState(null, '', '/settings/profile')
      navigation.dispatchEvent(new Event('currententrychange'))
      expect(controller.translator.active).toBe(false)
      expect(turbo.cache.clear).toHaveBeenCalledTimes(1)
      // 随后的 popstate：Turbo 发起恢复访问，缓存已清，走网络
      startVisit(location.href, 'restore')
      await settle()
      renderResponse('<p>Public profile</p>')
      load()
      expect(turbo.visit).not.toHaveBeenCalled()
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('翻译中帧导航进排除路径再后退：恢复翻译，GitHub 写回的译文与当前一致，不重新访问', async () => {
    install()
    document.body.innerHTML = NAV_HTML
    const { controller, navigation, stop } = startController(['/vuejs/core/wiki'])
    try {
      await settle()
      expect($('#repo-nav p').textContent).toBe('议题')
      // 点仓库的 Wiki 标签：帧响应到达时 GitHub 缓存当前页面（带译文），随后 pushState 进入排除路径
      frameResponse()
      history.pushState(null, '', '/vuejs/core/wiki')
      navigation.dispatchEvent(new Event('currententrychange'))
      expect(controller.translator.active).toBe(false)
      frameRender('https://github.com/vuejs/core/wiki', '<p>Wiki</p>')
      promotionVisit()
      await settle()

      // 后退：恢复翻译；Turbo 缓存已清，走网络，GitHub 随后写回带译文的标题与导航
      history.pushState(null, '', HOME)
      navigation.dispatchEvent(new Event('currententrychange'))
      expect(controller.translator.active).toBe(true)
      restoreFromGitHubCache(HOME)
      await settle()
      expect(document.title).toBe('议题 · vuejs/core')
      expect(turbo.cache.exemptPageFromCache).not.toHaveBeenCalled()
      expect(turbo.visit).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})
