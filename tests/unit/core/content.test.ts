// @vitest-environment-options { "url": "https://github.com/vuejs/core/issues" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentScriptDefinition } from 'wxt'
import type { LocaleBundle } from '../../../src/core/types'
import type { LocaleLoaderDeps } from '../../../src/shared/locale-loader'
import { INSTANCE_MARK_PREFIX } from '../../../src/core/instance-mark'
import {
  installTurboBridge,
  TURBO_RESET_EVENT,
  TURBO_REVISIT_EVENT,
  TURBO_TRANSLATING_EVENT,
  type BridgeWindow,
} from '../../../src/core/turbo-bridge'
import type { TranslationConfig } from '../../../src/translation/config'
import type { SiteScopeMode } from '../../../src/translation/site-scope'
import { $, settle, TEST_BUNDLE } from './helpers'

type Listener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => true | undefined

const state = vi.hoisted(() => ({
  settings: {
    enabled: true,
    translateTime: true,
    translateTitle: true,
    excludedPaths: [] as readonly string[],
    language: 'auto' as string,
    uiLanguage: 'auto',
    theme: 'auto',
  },
  failSettings: false,
  /** 设置后读取设置要等它落定（模拟读存储较慢） */
  settingsGate: undefined as Promise<void> | undefined,
  settingsListener: undefined as ((settings: unknown) => void) | undefined,
  entries: {} as Record<string, string>,
  unwatchSettings: vi.fn(),
  listeners: [] as Listener[],
}))

/** 模拟扩展消息接口：记录监听器，send() 依次调用；sendMessage 为发往后台的消息 */
const runtime = vi.hoisted(() => ({
  /** 扩展 ID：Chrome、Edge 中停用、卸载扩展后读不到 */
  id: 'test-extension' as string | undefined,
  sendMessage: vi.fn(async (_message: unknown): Promise<unknown> => ({ ok: true })),
  onMessage: {
    addListener: vi.fn((listener: Listener) => state.listeners.push(listener)),
    removeListener: vi.fn((listener: Listener) => {
      state.listeners = state.listeners.filter((item) => item !== listener)
    }),
  },
}))

/** 浏览器的语言偏好列表：默认读不到（undefined），按 navigator.languages */
const i18n = vi.hoisted(() => ({
  getAcceptLanguages: vi.fn(async (): Promise<string[] | undefined> => undefined),
}))

vi.mock('wxt/browser', () => ({ browser: { runtime, i18n } }))

const policy = vi.hoisted(() => ({
  mode: 'all' as SiteScopeMode,
  hosts: [] as string[],
  getConfig: vi.fn(async (): Promise<TranslationConfig | undefined> => undefined),
  watch: undefined as ((config: TranslationConfig) => void) | undefined,
  unwatch: vi.fn(),
}))

vi.mock('../../../src/translation/config', () => ({
  getTranslationConfig: policy.getConfig,
  watchTranslationConfig: (callback: (config: TranslationConfig) => void) => {
    policy.watch = callback
    return policy.unwatch
  },
}))

function scopeConfig(mode: SiteScopeMode, hosts: readonly string[]): TranslationConfig {
  return {
    baseUrl: '',
    model: '',
    apiType: 'chat-completions',
    temperature: null,
    requestParams: {},
    customHeadersRevision: '',
    autoOrigins: [],
    disabledDictionaries: [],
    targetLanguage: 'zh-CN',
    sourceLanguage: 'auto',
    selectionPopupEnabled: false,
    selectionToolbarEnabled: false,
    proactiveAssistEnabled: false,
    floatingButtonEnabled: false,
    excludedHosts: [],
    siteScopeMode: mode,
    siteScopeHosts: hosts,
  }
}

/** 语言包加载：按语言返回测试词典；deps 为内容脚本创建加载器时传入的依赖 */
const locales = vi.hoisted(() => ({
  load: vi.fn(async (_locale: string): Promise<unknown> => undefined),
  deps: undefined as LocaleLoaderDeps | undefined,
}))

vi.mock('../../../src/shared/locale-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/locale-loader')>()),
  createLocaleLoader: (deps: LocaleLoaderDeps) => {
    locales.deps = deps
    return { load: locales.load }
  },
}))

vi.mock('../../../src/shared/settings', () => ({
  DEFAULT_SETTINGS: { ...state.settings, enabled: false },
  getSettings: vi.fn(async () => {
    if (state.settingsGate) await state.settingsGate
    if (state.failSettings) throw new Error('storage unavailable')
    return state.settings
  }),
  getCustomEntries: vi.fn(async () => state.entries),
  watchSettings: vi.fn((listener: (settings: unknown) => void) => {
    state.settingsListener = listener
    return state.unwatchSettings
  }),
  isPathExcluded: (pathname: string, patterns: readonly string[]) => patterns.some((p) => pathname.startsWith(p)),
}))

interface FakeContext {
  invalid: boolean
  readonly invalidated: (() => void)[]
  readonly isInvalid: boolean
  readonly isValid: boolean
  readonly intervals: (() => void)[]
  readonly timeouts: (() => void)[]
  onInvalidated(callback: () => void): () => void
  addEventListener(target: EventTarget, type: string, handler: () => void): void
  setInterval(handler: () => void, timeout: number): number
  setTimeout(handler: () => void, timeout: number): number
  /** 执行一轮定时任务 */
  tick(): void
  /** 一次性定时任务全部到期 */
  elapse(): void
  invalidate(): void
}

function createContext(): FakeContext {
  const context: FakeContext = {
    invalid: false,
    invalidated: [],
    intervals: [],
    timeouts: [],
    get isInvalid() {
      return context.invalid
    },
    get isValid() {
      return !context.invalid
    },
    onInvalidated(callback) {
      context.invalidated.push(callback)
      return () => undefined
    },
    // 与 WXT 一致：失效时移除监听
    addEventListener(target, type, handler) {
      const name = type === 'wxt:locationchange' ? 'test:locationchange' : type
      target.addEventListener(name, handler)
      context.invalidated.push(() => target.removeEventListener(name, handler))
    },
    setInterval(handler) {
      context.intervals.push(handler)
      return context.intervals.length
    },
    // 负数编号：被测代码用全局 clearTimeout 清除时碰不到真实的定时器
    setTimeout(handler) {
      context.timeouts.push(handler)
      return -context.timeouts.length
    },
    tick() {
      if (!context.invalid) for (const handler of context.intervals) handler()
    },
    // 与 WXT 一致：失效后不执行
    elapse() {
      for (const handler of context.timeouts.splice(0)) if (!context.invalid) handler()
    },
    invalidate() {
      context.invalid = true
      for (const callback of context.invalidated) callback()
    },
  }
  return context
}

async function load(): Promise<ContentScriptDefinition> {
  return (await import('../../../src/entrypoints/content')).default
}

function send(message: unknown): unknown {
  let response: unknown
  for (const listener of state.listeners) listener(message, {}, (value) => (response = value))
  return response
}

/** 异步应答：handled 为监听器是否保持消息通道 */
function sendAsync(message: unknown): { handled: boolean; response: Promise<unknown> } {
  let resolve: (value: unknown) => void = () => undefined
  const response = new Promise((done) => {
    resolve = done
  })
  const handled = state.listeners.map((listener) => listener(message, {}, resolve)).some((result) => result === true)
  return { handled, response }
}

let context: FakeContext | undefined

/** 繁体测试词典 */
const TW_BUNDLE: LocaleBundle = [['common', { static: { Issues: '議題' } }]]

/** 等待异步回调执行 */
async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 测试结束时撤销的监听 */
let cleanups: (() => void)[] = []

/** window 上派发的重置事件，按派发顺序：reset 为普通重置，revisit 为强制重新访问 */
function captureResets(): string[] {
  const events: string[] = []
  const onReset = (): void => {
    events.push('reset')
  }
  const onRevisit = (): void => {
    events.push('revisit')
  }
  window.addEventListener(TURBO_RESET_EVENT, onReset)
  window.addEventListener(TURBO_REVISIT_EVENT, onRevisit)
  cleanups.push(() => {
    window.removeEventListener(TURBO_RESET_EVENT, onReset)
    window.removeEventListener(TURBO_REVISIT_EVENT, onRevisit)
  })
  return events
}

/** <html> 上的实例标记 */
function marks(): string[] {
  return document.documentElement.getAttributeNames().filter((name) => name.startsWith(INSTANCE_MARK_PREFIX))
}

/** 让读取设置挂起，返回放行函数 */
function holdSettings(): () => void {
  let release: () => void = () => undefined
  state.settingsGate = new Promise((resolve) => {
    release = resolve
  })
  return release
}

/** 模拟页面上的 navigator.languages（隐身窗口等处会被缩减） */
function stubLanguages(languages: readonly string[]): void {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
}

/** 往返缓存恢复（persisted）或普通的 pageshow */
function pageshow(persisted: boolean): void {
  const event = new Event('pageshow')
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

beforeEach(() => {
  vi.resetModules()
  policy.mode = 'all'
  policy.hosts = []
  policy.watch = undefined
  policy.unwatch.mockReset()
  policy.getConfig.mockReset()
  policy.getConfig.mockImplementation(async () => scopeConfig(policy.mode, policy.hosts))
  runtime.id = 'test-extension'
  runtime.sendMessage.mockReset()
  runtime.sendMessage.mockImplementation(async () => ({ ok: true }))
  state.listeners = []
  state.entries = {}
  state.failSettings = false
  state.settingsGate = undefined
  state.settings = { ...state.settings, enabled: true, excludedPaths: [], language: 'auto' }
  locales.load.mockReset()
  locales.load.mockImplementation(async (locale) => (locale === 'zh-TW' ? TW_BUNDLE : TEST_BUNDLE))
  locales.deps = undefined
  i18n.getAcceptLanguages.mockReset()
  document.head.innerHTML = '<title>Issues · vuejs/core</title>'
  document.body.innerHTML = '<p>Issues</p><p>Hello world</p>'
})

afterEach(() => {
  if (context && !context.invalid) context.invalidate()
  context = undefined
  for (const cleanup of cleanups) cleanup()
  cleanups = []
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const name of marks()) document.documentElement.removeAttribute(name)
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  history.replaceState(null, '', '/vuejs/core/issues')
})

describe('content script', () => {
  it('声明匹配地址与运行时机', async () => {
    const definition = await load()
    expect(definition.matches).toEqual([
      'https://github.com/*',
      'https://gist.github.com/*',
      'https://www.githubstatus.com/*',
    ])
    expect(definition.runAt).toBe('document_start')
    expect(definition.noScriptStartedPostMessage).toBe(true)
  })

  it('读取设置后翻译，并同步响应 popup 消息', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect($('p').textContent).toBe('议题')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: true, excluded: false, translatedCount: 2 })
    expect(send({ type: 'unknown' })).toBeUndefined()
    expect(send(null)).toBeUndefined()
  })

  it('不向后台发未翻译文本：定时任务、离开页面、切到后台、状态查询都不发消息', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    // 词典里没有的文字保持原文
    expect($('p:last-child').textContent).toBe('Hello world')
    context.tick()
    window.dispatchEvent(new Event('pagehide'))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockRestore()
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: true })
    await flushTasks()
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'gcn:get-untranslated' },
    { type: 'gcn:flush-untranslated' },
    { type: 'gcn:untranslated-cleared', epoch: 1 },
  ])('旧版本的未翻译消息 %j：不处理、不应答', async (message) => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect(sendAsync(message).handled).toBe(false)
    expect(send(message)).toBeUndefined()
    expect($('p').textContent).toBe('议题')
  })

  it('响应设置变化；自定义词条变化由后台通知后重新读取', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    state.entries = { Issues: '问题' }
    expect(send({ type: 'gcn:custom-entries-changed' })).toBeUndefined()
    await flushTasks()
    expect($('p').textContent).toBe('问题')
    state.settingsListener!({ ...state.settings, enabled: false })
    expect($('p').textContent).toBe('Issues')
  })

  it('从往返缓存恢复时补读设置与自定义词条；普通 pageshow 与失效后不读', async () => {
    const settings = await import('../../../src/shared/settings')
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    const reads = (): number[] => [
      vi.mocked(settings.getSettings).mock.calls.length,
      vi.mocked(settings.getCustomEntries).mock.calls.length,
    ]
    const before = reads()
    const pageshow = (persisted: boolean): void => {
      const event = new Event('pageshow')
      Object.defineProperty(event, 'persisted', { value: persisted })
      window.dispatchEvent(event)
    }

    pageshow(false)
    await flushTasks()
    expect(reads()).toEqual(before)

    state.entries = { Issues: '问题' }
    pageshow(true)
    await flushTasks()
    expect(reads()).toEqual([before[0]! + 1, before[1]! + 1])
    expect($('p').textContent).toBe('问题')

    state.settings = { ...state.settings, enabled: false }
    pageshow(true)
    await flushTasks()
    expect($('p').textContent).toBe('Issues')

    context.invalidate()
    const afterInvalidate = reads()
    pageshow(true)
    await flushTasks()
    expect(reads()).toEqual(afterInvalidate)
  })

  it('软导航事件触发地址检查', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    document.body.innerHTML = '<b>Open</b>'
    await settle()
    expect($('b').textContent).toBe('未解决')
    history.pushState(null, '', '/vuejs/core/pulls')
    window.dispatchEvent(new Event('test:locationchange'))
    expect($('b').textContent).toBe('开启中')
    history.replaceState(null, '', '/vuejs/core/issues')
  })

  it('扩展失效时移除监听并还原', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    context.invalidate()
    expect($('p').textContent).toBe('Issues')
    expect(document.title).toBe('Issues · vuejs/core')
    expect(runtime.onMessage.removeListener).toHaveBeenCalled()
    expect(state.unwatchSettings).toHaveBeenCalled()
    expect(state.listeners).toHaveLength(0)
  })

  it('Chrome、Edge 停用或卸载扩展（不派发事件、不导航）：定时检查 3 秒内发现失效，还原页面、移除标记', async () => {
    // 有 Navigation API：WXT 的软导航监视改听 navigate 事件，不再轮询
    const navigation = new EventTarget()
    const listenNavigation = vi.spyOn(navigation, 'addEventListener')
    vi.stubGlobal('navigation', navigation)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { ContentScriptContext } = await import('wxt/utils/content-script-context')
    const definition = await load()
    const ctx = new ContentScriptContext('content', { noScriptStartedPostMessage: true })
    try {
      await definition.main(ctx)
      expect(listenNavigation).toHaveBeenCalledWith('navigate', expect.any(Function), expect.anything())
      expect($('p').textContent).toBe('议题')
      expect(marks()).toHaveLength(1)
      // 扩展有效时定时检查不打扰
      vi.advanceTimersByTime(3000)
      expect(ctx.isValid).toBe(true)
      expect($('p').textContent).toBe('议题')

      runtime.id = undefined
      expect(ctx.signal.aborted).toBe(false)
      vi.advanceTimersByTime(3000)
      expect(ctx.signal.aborted).toBe(true)
      expect($('p').textContent).toBe('Issues')
      expect(document.title).toBe('Issues · vuejs/core')
      expect(marks()).toEqual([])
      expect(state.listeners).toHaveLength(0)
    } finally {
      ctx.abort()
      vi.useRealTimers()
    }
  })

  it('失效时移除监听抛错（旧上下文）：页面照常还原，其余清理照做', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    state.unwatchSettings.mockClear()
    runtime.onMessage.removeListener.mockImplementationOnce(() => {
      throw new Error('Extension context invalidated.')
    })
    state.unwatchSettings.mockImplementationOnce(() => {
      throw new Error('Extension context invalidated.')
    })
    expect(() => context!.invalidate()).not.toThrow()
    expect($('p').textContent).toBe('Issues')
    expect(document.title).toBe('Issues · vuejs/core')
    expect(state.unwatchSettings).toHaveBeenCalledTimes(1)
  })

  it('启动时已失效：不注册监听、不读存储', async () => {
    const definition = await load()
    const { getSettings } = await import('../../../src/shared/settings')
    runtime.onMessage.addListener.mockClear()
    context = createContext()
    context.invalid = true
    await definition.main(context as never)
    expect(runtime.onMessage.addListener).not.toHaveBeenCalled()
    expect(getSettings).not.toHaveBeenCalled()
    expect($('p').textContent).toBe('Issues')
    expect(state.listeners).toHaveLength(0)
  })

  it('读取设置失败时使用默认设置', async () => {
    state.failSettings = true
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    // 测试中的默认设置为关闭：不加载语言包
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
    expect(locales.load).not.toHaveBeenCalled()
  })
})

describe('页面翻译语言', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('自动：按浏览器语言列表加载语言包', async () => {
    stubLanguages(['en-US', 'zh-TW'])
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect(locales.load).toHaveBeenCalledWith('zh-TW')
    expect($('p').textContent).toBe('議題')
  })

  it('手动选择优先于浏览器语言', async () => {
    stubLanguages(['zh-TW'])
    state.settings = { ...state.settings, language: 'zh-CN' }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect(locales.load).toHaveBeenCalledWith('zh-CN')
    expect($('p').textContent).toBe('议题')
  })

  it('设置改为另一语言：加载后换用，页面按新语言重译', async () => {
    state.settings = { ...state.settings, language: 'zh-CN' }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    const resets = captureResets()
    state.settingsListener!({ ...state.settings, language: 'zh-TW' })
    await flushTasks()
    expect($('p').textContent).toBe('議題')
    expect(resets).toEqual(['reset'])
    // 改回已加载的语言
    state.settingsListener!({ ...state.settings, language: 'zh-CN' })
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('切换时加载失败：沿用当前语言', async () => {
    state.settings = { ...state.settings, language: 'zh-CN' }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    // 等启动时的补读（设置、浏览器语言）完成：补读会重试加载
    await flushTasks()
    locales.load.mockRejectedValueOnce(new Error('语言包加载失败：zh-TW'))
    state.settingsListener!({ ...state.settings, language: 'zh-TW' })
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('加载期间又改回原语言：丢弃过时的结果', async () => {
    state.settings = { ...state.settings, language: 'zh-CN' }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    let resolve: (bundle: LocaleBundle) => void = () => undefined
    locales.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    state.settingsListener!({ ...state.settings, language: 'zh-TW' })
    state.settingsListener!({ ...state.settings, language: 'zh-CN' })
    resolve(TW_BUNDLE)
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('浏览器语言变化：自动识别的语言随之切换', async () => {
    stubLanguages(['zh-CN'])
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect($('p').textContent).toBe('议题')
    stubLanguages(['zh-HK', 'zh-CN'])
    window.dispatchEvent(new Event('languagechange'))
    await flushTasks()
    expect($('p').textContent).toBe('議題')
  })

  it('加载语言包期间改了设置：启动后补读', async () => {
    state.settings = { ...state.settings, language: 'zh-CN' }
    let release: () => void = () => undefined
    locales.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return TEST_BUNDLE
    })
    const definition = await load()
    context = createContext()
    const started = definition.main(context as never)
    await flushTasks()
    state.settings = { ...state.settings, enabled: false }
    release()
    await started
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
  })

  it('加载语言包期间浏览器语言变了：启动后按新语言', async () => {
    stubLanguages(['zh-CN'])
    let release: () => void = () => undefined
    locales.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return TEST_BUNDLE
    })
    const definition = await load()
    context = createContext()
    const started = definition.main(context as never)
    await flushTasks()
    stubLanguages(['zh-HK'])
    release()
    await started
    await flushTasks()
    expect($('p').textContent).toBe('議題')
  })

  it('语言包加载失败：不启动，移除监听', async () => {
    locales.load.mockRejectedValue(new Error('语言包加载失败：zh-CN'))
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect($('p').textContent).toBe('Issues')
    expect(state.listeners).toHaveLength(0)
  })

  it('浏览器语言列表取自 i18n.getAcceptLanguages（隐身窗口中 navigator.languages 被缩减）', async () => {
    i18n.getAcceptLanguages.mockResolvedValue(['en-US', 'zh-TW'])
    stubLanguages(['en-US', 'en'])
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    await flushTasks()
    expect(locales.load.mock.calls).toEqual([['zh-TW']])
    expect($('p').textContent).toBe('議題')
  })

  it('语言列表与设置并行读取：读存储期间已在读', async () => {
    const release = holdSettings()
    const definition = await load()
    context = createContext()
    const started = definition.main(context as never)
    expect(i18n.getAcceptLanguages).toHaveBeenCalledTimes(1)
    release()
    await started
  })

  it('浏览器语言变化：重新读取语言列表', async () => {
    i18n.getAcceptLanguages.mockResolvedValue(['zh-CN'])
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    await flushTasks()
    expect($('p').textContent).toBe('议题')
    i18n.getAcceptLanguages.mockResolvedValue(['zh-HK', 'zh-CN'])
    window.dispatchEvent(new Event('languagechange'))
    await flushTasks()
    expect($('p').textContent).toBe('議題')
  })

  it('浏览器语言连续变化：按最后一次读到的语言列表，先发起的读取迟到时丢弃', async () => {
    i18n.getAcceptLanguages.mockResolvedValue(['zh-CN'])
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    await flushTasks()
    let resolveFirst: (languages: string[]) => void = () => undefined
    i18n.getAcceptLanguages.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveFirst = done
        }),
    )
    window.dispatchEvent(new Event('languagechange'))
    window.dispatchEvent(new Event('languagechange'))
    await flushTasks()
    resolveFirst(['zh-TW'])
    await flushTasks()
    expect($('p').textContent).toBe('议题')
    expect(locales.load).not.toHaveBeenCalledWith('zh-TW')
  })

  it('Firefox 构建：取不到登记时先等注册的词典脚本登记，不动态导入；Chromium 不等，动态导入', async () => {
    await load()
    expect(locales.deps?.waitForRegistration).toBeUndefined()
    expect(locales.deps?.importScript).toBeTypeOf('function')
    vi.resetModules()
    vi.stubEnv('FIREFOX', 'true')
    await load()
    const wait = locales.deps?.waitForRegistration
    expect(wait).toBeTypeOf('function')
    expect(locales.deps?.importScript).toBeUndefined()
    // 页面已解析完：不等
    await expect(wait!()).resolves.toBeUndefined()
  })
})

describe('总开关关闭时启动', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 以关闭状态启动，等启动时的补读完成 */
  async function startDisabled(patch: Partial<typeof state.settings> = {}): Promise<void> {
    state.settings = { ...state.settings, ...patch, enabled: false }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    await flushTasks()
  }

  /** 加载挂起，返回放行函数 */
  function holdLoad(): (bundle: LocaleBundle) => void {
    let resolve: (bundle: LocaleBundle) => void = () => undefined
    locales.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    return (bundle) => resolve(bundle)
  }

  /** 主世界桥接的询问：被取消即为在翻译 */
  function askTranslating(): boolean {
    return !window.dispatchEvent(new Event(TURBO_TRANSLATING_EVENT, { cancelable: true }))
  }

  it('不加载语言包；状态查询、桥接询问照常应答（未在翻译）', async () => {
    await startDisabled()
    expect(locales.load).not.toHaveBeenCalled()
    expect($('p').textContent).toBe('Issues')
    const status = send({ type: 'gcn:get-status' }) as { pages: readonly string[] }
    expect(status).toMatchObject({ active: false, excluded: false, translatedCount: 0 })
    expect(status.pages).toContain('issues')
    expect(askTranslating()).toBe(false)
    expect(state.listeners).toHaveLength(1)
  })

  it('排除路径照常判断', async () => {
    await startDisabled({ excludedPaths: ['/vuejs/core'] })
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false, excluded: true })
  })

  it('开启后加载一次并翻译', async () => {
    await startDisabled()
    state.settingsListener!({ ...state.settings, enabled: true })
    await flushTasks()
    expect(locales.load.mock.calls).toEqual([['zh-CN']])
    expect($('p').textContent).toBe('议题')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: true, translatedCount: 2 })
    expect(askTranslating()).toBe(true)
  })

  it('加载完成前不启动翻译；换上语言包后开始翻译', async () => {
    await startDisabled()
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    expect(askTranslating()).toBe(false)
    // 软导航时重新判断开关：仍不启动
    window.dispatchEvent(new Event('test:locationchange'))
    expect($('p').textContent).toBe('Issues')
    release(TEST_BUNDLE)
    await flushTasks()
    expect($('p').textContent).toBe('议题')
    expect(askTranslating()).toBe(true)
  })

  it('开启后立即查询状态（popup）：保持消息通道，语言包换上后应答翻译中', async () => {
    await startDisabled()
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    const probe = sendAsync({ type: 'gcn:get-status' })
    expect(probe.handled).toBe(true)
    let answered = false
    void probe.response.then(() => (answered = true))
    await flushTasks()
    expect(answered).toBe(false)
    release(TEST_BUNDLE)
    expect(await probe.response).toMatchObject({ active: true, translatedCount: 2 })
    expect($('p').textContent).toBe('议题')
  })

  it('语言包迟迟加载不完：状态查询等到时限，按未在翻译应答', async () => {
    await startDisabled()
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    const probe = sendAsync({ type: 'gcn:get-status' })
    let answered = false
    void probe.response.then(() => (answered = true))
    await flushTasks()
    expect(answered).toBe(false)
    context!.elapse()
    expect(await probe.response).toMatchObject({ active: false })
    release(TEST_BUNDLE)
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('等待中加载失败：状态查询随即按未在翻译应答', async () => {
    await startDisabled()
    let fail: (error: Error) => void = () => undefined
    locales.load.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    state.settingsListener!({ ...state.settings, enabled: true })
    const probe = sendAsync({ type: 'gcn:get-status' })
    expect(probe.handled).toBe(true)
    fail(new Error('语言包加载失败：zh-CN'))
    expect(await probe.response).toMatchObject({ active: false })
    expect($('p').textContent).toBe('Issues')
  })

  it('等待中又关闭：状态查询按未在翻译应答', async () => {
    await startDisabled()
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    const probe = sendAsync({ type: 'gcn:get-status' })
    state.settingsListener!({ ...state.settings, enabled: false })
    release(TEST_BUNDLE)
    expect(await probe.response).toMatchObject({ active: false })
    expect($('p').textContent).toBe('Issues')
  })

  it('等待中切换语言：等新语言的语言包换上后应答', async () => {
    await startDisabled({ language: 'zh-CN' })
    const releaseFirst = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    const probe = sendAsync({ type: 'gcn:get-status' })
    const releaseSecond = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true, language: 'zh-TW' })
    let answered = false
    void probe.response.then(() => (answered = true))
    releaseFirst(TEST_BUNDLE)
    await flushTasks()
    expect(answered).toBe(false)
    releaseSecond(TW_BUNDLE)
    expect(await probe.response).toMatchObject({ active: true })
    expect($('p').textContent).toBe('議題')
  })

  it('等待中失效：不应答', async () => {
    await startDisabled()
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    const probe = sendAsync({ type: 'gcn:get-status' })
    let answered = false
    void probe.response.then(() => (answered = true))
    context!.invalidate()
    release(TEST_BUNDLE)
    await flushTasks()
    context!.elapse()
    await flushTasks()
    expect(answered).toBe(false)
  })

  it('加载中又关闭：保持原文；再开启时照常换上', async () => {
    await startDisabled()
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    state.settingsListener!({ ...state.settings, enabled: false })
    release(TEST_BUNDLE)
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
    state.settingsListener!({ ...state.settings, enabled: true })
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('加载中切换语言：采用新语言', async () => {
    await startDisabled({ language: 'zh-CN' })
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    state.settingsListener!({ ...state.settings, enabled: true, language: 'zh-TW' })
    await flushTasks()
    expect($('p').textContent).toBe('議題')
    release(TEST_BUNDLE)
    await flushTasks()
    expect($('p').textContent).toBe('議題')
  })

  it('关闭期间改语言、浏览器语言变化：不加载；开启时按新语言加载', async () => {
    stubLanguages(['zh-CN'])
    await startDisabled()
    state.settingsListener!({ ...state.settings, language: 'zh-TW' })
    stubLanguages(['zh-HK'])
    window.dispatchEvent(new Event('languagechange'))
    await flushTasks()
    expect(locales.load).not.toHaveBeenCalled()
    state.settingsListener!({ ...state.settings, enabled: true, language: 'auto' })
    await flushTasks()
    expect(locales.load.mock.calls).toEqual([['zh-TW']])
    expect($('p').textContent).toBe('議題')
  })

  it('翻译过后关闭：关闭期间改语言不加载，重新开启时加载新语言', async () => {
    state.settings = { ...state.settings, language: 'zh-CN' }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    await flushTasks()
    state.settingsListener!({ ...state.settings, enabled: false })
    state.settingsListener!({ ...state.settings, enabled: false, language: 'zh-TW' })
    await flushTasks()
    expect(locales.load.mock.calls).toEqual([['zh-CN']])
    expect($('p').textContent).toBe('Issues')
    state.settingsListener!({ ...state.settings, enabled: true, language: 'zh-TW' })
    await flushTasks()
    expect(locales.load.mock.calls).toEqual([['zh-CN'], ['zh-TW']])
    expect($('p').textContent).toBe('議題')
  })

  it('开启时加载失败：保持原文，状态查询随即应答；设置再变化时重试', async () => {
    await startDisabled()
    locales.load.mockRejectedValueOnce(new Error('语言包加载失败：zh-CN'))
    state.settingsListener!({ ...state.settings, enabled: true })
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
    expect(state.listeners).toHaveLength(1)
    state.settingsListener!({ ...state.settings, enabled: true, translateTitle: false })
    await flushTasks()
    expect(locales.load).toHaveBeenCalledTimes(2)
    expect($('p').textContent).toBe('议题')
  })

  it('往返缓存恢复时补读到已开启：加载并翻译', async () => {
    await startDisabled()
    state.settings = { ...state.settings, enabled: true }
    pageshow(true)
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('加载中失效：丢弃结果，不翻译', async () => {
    await startDisabled()
    const release = holdLoad()
    state.settingsListener!({ ...state.settings, enabled: true })
    context!.invalidate()
    release(TEST_BUNDLE)
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    expect(marks()).toEqual([])
  })
})

describe('读存储期间收到的消息', () => {
  it('启动时先注册监听：读存储期间的状态查询保持消息通道，就绪后应答（后台补注前据此判断，不重复注入）', async () => {
    const release = holdSettings()
    const definition = await load()
    context = createContext()
    const started = definition.main(context as never)
    expect(state.listeners).toHaveLength(1)
    const probe = sendAsync({ type: 'gcn:get-status' })
    expect(probe.handled).toBe(true)
    let answered = false
    void probe.response.then(() => (answered = true))
    await flushTasks()
    expect(answered).toBe(false)
    release()
    await started
    expect(await probe.response).toMatchObject({ active: true, excluded: false, translatedCount: 2 })
    expect(state.listeners).toHaveLength(1)
  })

  it('词条变化：不占消息通道，就绪后照常处理', async () => {
    const release = holdSettings()
    const definition = await load()
    context = createContext()
    const started = definition.main(context as never)
    state.entries = { Issues: '问题' }
    expect(sendAsync({ type: 'gcn:custom-entries-changed' }).handled).toBe(false)
    release()
    await started
    await flushTasks()
    expect($('p').textContent).toBe('问题')
  })

  it('旧版本的立即上报：不排队、不占消息通道', async () => {
    const release = holdSettings()
    const definition = await load()
    context = createContext()
    const started = definition.main(context as never)
    const flush = sendAsync({ type: 'gcn:flush-untranslated' })
    expect(flush.handled).toBe(false)
    let answered = false
    void flush.response.then(() => (answered = true))
    release()
    await started
    await flushTasks()
    expect(answered).toBe(false)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('读存储期间失效：不启动，移除监听；排队的查询不应答（页面上的新实例会应答）', async () => {
    const release = holdSettings()
    const definition = await load()
    context = createContext()
    const started = definition.main(context as never)
    const probe = sendAsync({ type: 'gcn:get-status' })
    let answered = false
    void probe.response.then(() => (answered = true))
    context.invalidate()
    release()
    await started
    await flushTasks()
    expect(state.listeners).toHaveLength(0)
    expect(answered).toBe(false)
    expect($('p').textContent).toBe('Issues')
    expect(marks()).toEqual([])
  })
})

describe('重置事件与实例标记', () => {
  /** 后台通知自定义词条已变化，等内容脚本读完 */
  async function changeEntries(entries: Record<string, string>): Promise<void> {
    state.entries = entries
    send({ type: 'gcn:custom-entries-changed' })
    await flushTasks()
  }

  /** 按 Turbo 的顺序渲染新 body：先派发 turbo:before-render，再替换 */
  function renderBody(newBody: HTMLElement): void {
    document.dispatchEvent(new CustomEvent('turbo:before-render', { detail: { newBody } }))
    document.body.replaceWith(newBody)
  }

  /** 服务器返回的页面：DOMParser 解析，属于另一个文档 */
  function serverBody(html: string): HTMLElement {
    return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  }

  /**
   * 照 GitHub 的 packages/turbo/cache.ts、events.ts：按地址缓存 <html> 的属性（Attr 节点），
   * popstate 时删掉缓存里没有的属性，其余按缓存值写回
   */
  function simulateGitHubAttributeRestore(): { cache(): void; popTo(path: string): void } {
    const cached = new Map<string, Attr[]>()
    const onPopState = (): void => {
      const root = document.documentElement
      const attributes = cached.get(location.href)
      if (!attributes) return
      for (const attr of [...root.attributes]) {
        if (!attributes.some((item) => item.name === attr.name)) root.removeAttribute(attr.name)
      }
      for (const attr of attributes) {
        if (root.getAttribute(attr.name) !== attr.value) root.setAttribute(attr.name, attr.value)
      }
    }
    window.addEventListener('popstate', onPopState)
    cleanups.push(() => window.removeEventListener('popstate', onPopState))
    return {
      cache: () => cached.set(location.href, [...document.documentElement.attributes]),
      popTo(path) {
        history.replaceState(null, '', path)
        window.dispatchEvent(new PopStateEvent('popstate'))
      },
    }
  }

  it('停用、改自定义词条、改时间本地化开关、失效时在 window 上派发重置事件；启用时不派发', async () => {
    const definition = await load()
    context = createContext()
    const events = captureResets()
    await definition.main(context as never)
    expect(events).toEqual([])
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(events).toEqual(['reset'])
    state.settingsListener!({ ...state.settings })
    expect(events).toEqual(['reset'])
    await changeEntries({ Issues: '问题' })
    expect(events).toEqual(['reset', 'reset'])
    state.settingsListener!({ ...state.settings, translateTime: false })
    expect(events).toEqual(['reset', 'reset', 'reset'])
    context.invalidate()
    expect(events).toEqual(['reset', 'reset', 'reset', 'reset'])
  })

  it('重置事件是不带 detail 的普通 Event：跨世界读不到 detail', async () => {
    document.documentElement.setAttribute(`${INSTANCE_MARK_PREFIX}stale`, '')
    const seen: Event[] = []
    const listener = (event: Event): void => {
      seen.push(event)
    }
    window.addEventListener(TURBO_RESET_EVENT, listener)
    window.addEventListener(TURBO_REVISIT_EVENT, listener)
    cleanups.push(() => {
      window.removeEventListener(TURBO_RESET_EVENT, listener)
      window.removeEventListener(TURBO_REVISIT_EVENT, listener)
    })
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    state.settingsListener!({ ...state.settings, enabled: false })
    state.settingsListener!({ ...state.settings })
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(seen.map((event) => event.type)).toEqual([TURBO_REVISIT_EVENT, TURBO_RESET_EVENT])
    for (const event of seen) {
      expect(event.constructor).toBe(Event)
      expect('detail' in event).toBe(false)
    }
  })

  it('翻译中在 <html> 上留本实例的标记：停用后移除，启用后写回，失效后移除', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    const own = marks()
    expect(own).toHaveLength(1)
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(marks()).toEqual([])
    state.settingsListener!({ ...state.settings })
    expect(marks()).toEqual(own)
    context.invalidate()
    expect(marks()).toEqual([])
  })

  it('失效后不再维护本实例的标记', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    const [own] = marks()
    context.invalidate()
    document.documentElement.setAttribute(own!, '')
    await settle()
    expect(marks()).toEqual([own])
  })

  it('各实例的标记不同；未在翻译时不写', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    const [first] = marks()
    context.invalidate()
    context = createContext()
    await definition.main(context as never)
    expect(marks()).toHaveLength(1)
    expect(marks()).not.toContain(first)
    context.invalidate()

    state.settings = { ...state.settings, excludedPaths: ['/vuejs/core'] }
    context = createContext()
    await definition.main(context as never)
    expect(marks()).toEqual([])
  })

  it('有已失效实例的标记：停用时移除这些标记并强制重新访问，之后照常重置', async () => {
    document.documentElement.setAttribute(`${INSTANCE_MARK_PREFIX}stale`, '')
    const definition = await load()
    context = createContext()
    const events = captureResets()
    await definition.main(context as never)
    expect(marks()).toHaveLength(2)
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(events).toEqual(['revisit'])
    expect(marks()).toEqual([])
    state.settingsListener!({ ...state.settings })
    await changeEntries({ Issues: '问题' })
    expect(events).toEqual(['revisit', 'reset'])
  })

  it.each<[string, () => Promise<void>]>([
    ['改自定义词条', () => changeEntries({ Issues: '问题' })],
    ['改时间本地化开关', async () => state.settingsListener!({ ...state.settings, translateTime: false })],
  ])('有已失效实例的标记：%s时同样强制重新访问，保留本实例的标记', async (_name, act) => {
    document.documentElement.setAttribute(`${INSTANCE_MARK_PREFIX}stale`, '')
    const definition = await load()
    context = createContext()
    const events = captureResets()
    await definition.main(context as never)
    const own = marks().filter((name) => name !== `${INSTANCE_MARK_PREFIX}stale`)
    await act()
    expect(events).toEqual(['revisit'])
    expect(marks()).toEqual(own)
  })

  it('失效时只做普通重置：不检查、不移除其他实例（新实例）的标记', async () => {
    const definition = await load()
    context = createContext()
    const events = captureResets()
    await definition.main(context as never)
    document.documentElement.setAttribute(`${INSTANCE_MARK_PREFIX}newer`, '')
    context.invalidate()
    expect(events).toEqual(['reset'])
    expect(marks()).toEqual([`${INSTANCE_MARK_PREFIX}newer`])
  })

  it('旧实例未还原就被销毁（Firefox 更新扩展）：新实例停用时强制重新访问，页面换回原文', async () => {
    const definition = await load()
    // 旧实例：观察器随沙箱一起失效，不会调用 dispose
    let sandboxAlive = true
    class SandboxedObserver extends MutationObserver {
      constructor(callback: MutationCallback) {
        super((records, observer) => {
          if (sandboxAlive) callback(records, observer)
        })
      }
    }
    vi.stubGlobal('MutationObserver', SandboxedObserver)
    const destroyed = createContext()
    await definition.main(destroyed as never)
    vi.unstubAllGlobals()
    sandboxAlive = false
    expect($('p').textContent).toBe('议题')

    // 新实例：中文没有记录，自己还原不了
    context = createContext()
    await definition.main(context as never)
    expect(marks()).toHaveLength(2)
    // 主世界桥接：重新访问时 Turbo 换成服务器返回的原文
    const visit = vi.fn(() => {
      document.body.innerHTML = '<p>Issues</p><p>Hello world</p>'
    })
    Object.defineProperty(window, 'Turbo', { value: { cache: { clear: vi.fn() }, visit }, configurable: true })
    const uninstall = installTurboBridge(window as BridgeWindow)
    try {
      state.settingsListener!({ ...state.settings, enabled: false })
      expect(visit).toHaveBeenCalledWith(location.href, { action: 'replace' })
      expect($('p').textContent).toBe('Issues')
      expect(marks()).toEqual([])
    } finally {
      uninstall()
      Reflect.deleteProperty(window, 'Turbo')
      destroyed.invalidate()
    }
  })

  it('扩展更新（Chrome）：已译克隆体在新桥接注入前就已显示，旧实例失效后新实例停用，页面换回原文', async () => {
    const definition = await load()
    // 重新访问：Turbo 换成服务器返回的原文
    const visit = vi.fn(() => renderBody(serverBody('<p>Issues</p><p>Hello world</p>')))
    Object.defineProperty(window, 'Turbo', { value: { cache: { clear: vi.fn() }, visit }, configurable: true })
    // 随页面加载注入的桥接
    const bridges = [installTurboBridge(window as BridgeWindow)]
    const old = createContext()
    try {
      await definition.main(old as never)
      expect($('p').textContent).toBe('议题')
      // 前进后退：Turbo 渲染离开时缓存的已译克隆体，克隆出的节点没有翻译记录
      renderBody(document.body.cloneNode(true) as HTMLElement)
      await settle()

      // 后台先注入新桥接，再注入内容脚本：新内容脚本的上下文构造时旧实例失效、派发重置
      bridges.push(installTurboBridge(window as BridgeWindow))
      old.invalidate()
      expect(visit).toHaveBeenCalledTimes(1)
      context = createContext()
      await definition.main(context as never)
      expect($('p').textContent).toBe('议题')
      state.settingsListener!({ ...state.settings, enabled: false })
      expect($('p').textContent).toBe('Issues')
    } finally {
      for (const uninstall of bridges) uninstall()
      Reflect.deleteProperty(window, 'Turbo')
    }
  })

  it('GitHub 前进后退写回更新前实例的标记（它已正常还原，Chrome）：不算失效实例；本实例的标记随即写回', async () => {
    const github = simulateGitHubAttributeRestore()
    const definition = await load()
    const old = createContext()
    await definition.main(old as never)
    // GitHub 渲染时按地址缓存 <html> 属性，带着旧实例的标记
    github.cache()
    old.invalidate()
    context = createContext()
    const events = captureResets()
    await definition.main(context as never)
    const own = marks()
    expect(own).toHaveLength(1)

    // 前进到别处再后退：GitHub 按缓存还原 <html> 属性
    history.pushState(null, '', '/vuejs/core/pulls')
    github.popTo('/vuejs/core/issues')
    await settle()
    expect(marks()).toContain(own[0])
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(events).toEqual(['reset'])
    expect(marks()).toEqual([])
  })

  it('Firefox：强制重新访问后 GitHub 又写回已失效实例的标记：不再强制重新访问', async () => {
    const github = simulateGitHubAttributeRestore()
    document.documentElement.setAttribute(`${INSTANCE_MARK_PREFIX}dead`, '')
    github.cache()
    const definition = await load()
    context = createContext()
    const events = captureResets()
    await definition.main(context as never)
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(events).toEqual(['revisit'])
    state.settingsListener!({ ...state.settings })
    const own = marks()
    expect(own).toHaveLength(1)

    history.pushState(null, '', '/vuejs/core/pulls')
    github.popTo('/vuejs/core/issues')
    await settle()
    expect(marks()).toContain(own[0])
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(events).toEqual(['revisit', 'reset'])
  })

  /** 主世界桥接的询问（见 core/turbo-bridge）：有实例取消询问事件即为在翻译 */
  function askTranslating(): boolean {
    return !window.dispatchEvent(new Event(TURBO_TRANSLATING_EVENT, { cancelable: true }))
  }

  it('应答桥接的询问：翻译中取消询问事件；停用后、失效后不取消', async () => {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect(askTranslating()).toBe(true)
    state.settingsListener!({ ...state.settings, enabled: false })
    expect(askTranslating()).toBe(false)
    state.settingsListener!({ ...state.settings })
    expect(askTranslating()).toBe(true)
    context.invalidate()
    expect(askTranslating()).toBe(false)
  })

  it('应答桥接的询问：排除路径上没在翻译，不取消', async () => {
    state.settings = { ...state.settings, excludedPaths: ['/vuejs/core'] }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    expect(askTranslating()).toBe(false)
  })

  it('停用扩展（Chrome：失效）后后退：GitHub 写回了本实例的标记，询问仍无人应答，桥接按写回带译文的标题重新访问', async () => {
    const github = simulateGitHubAttributeRestore()
    const visit = vi.fn()
    Object.defineProperty(window, 'Turbo', { value: { cache: { clear: vi.fn() }, visit }, configurable: true })
    const uninstall = installTurboBridge(window as BridgeWindow)
    try {
      const definition = await load()
      context = createContext()
      await definition.main(context as never)
      github.cache()
      // 翻译中帧导航离开：帧请求的响应到达时 GitHub 缓存当前页面（标题带译文）
      const frame = document.createElement('turbo-frame')
      document.body.append(frame)
      frame.dispatchEvent(new CustomEvent('turbo:before-fetch-response', { bubbles: true, detail: {} }))
      frame.remove()
      history.pushState(null, '', '/vuejs/core/pulls')
      context.invalidate()
      expect(marks()).toEqual([])

      // 后退：GitHub 按地址还原 <html> 属性，恢复访问后写回带译文的标题
      github.popTo('/vuejs/core/issues')
      await settle()
      expect(marks()).toHaveLength(1)
      expect(askTranslating()).toBe(false)
      document.title = '议题 · vuejs/core'
      document.dispatchEvent(new CustomEvent('turbo:restored'))
      expect(visit).toHaveBeenCalledTimes(1)
      expect(visit).toHaveBeenCalledWith(location.href, { action: 'replace' })
    } finally {
      uninstall()
      Reflect.deleteProperty(window, 'Turbo')
    }
  })
})

describe('网站运行范围', () => {
  async function start(): Promise<void> {
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    await flushTasks()
  }

  it('include 空表不加载语言包；放宽后翻译，再收窄立即还原', async () => {
    policy.mode = 'include'
    policy.hosts = []
    await start()
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
    expect(locales.load).not.toHaveBeenCalled()
    policy.watch?.(scopeConfig('all', []))
    await flushTasks()
    await settle()
    expect($('p').textContent).toBe('议题')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: true })
    policy.watch?.(scopeConfig('include', []))
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
  })

  it('读配置失败时不加载语言包也不翻译', async () => {
    policy.getConfig.mockRejectedValue(new Error('storage down'))
    await start()
    expect(locales.load).not.toHaveBeenCalled()
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
  })

  it('pageshow 挂起的旧读取不能覆盖之后的收窄', async () => {
    await start()
    expect($('p').textContent).toBe('议题')
    let release!: (config: TranslationConfig) => void
    policy.getConfig.mockImplementation(() => new Promise<TranslationConfig>((resolve) => {
      release = resolve
    }))
    pageshow(true)
    policy.watch?.(scopeConfig('include', []))
    expect($('p').textContent).toBe('Issues')
    release(scopeConfig('all', []))
    await flushTasks()
    await settle()
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
    expect(locales.load).toHaveBeenCalledTimes(1)
  })

  it('撤销时丢掉迟到语言包，再次允许后可以翻译', async () => {
    policy.mode = 'include'
    policy.hosts = []
    await start()
    expect(locales.load).not.toHaveBeenCalled()
    expect($('p').textContent).toBe('Issues')
    let release!: (bundle: LocaleBundle) => void
    locales.load.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    policy.watch?.(scopeConfig('all', []))
    await flushTasks()
    expect(locales.load).toHaveBeenCalledTimes(1)
    expect($('p').textContent).toBe('Issues')
    policy.watch?.(scopeConfig('include', []))
    expect($('p').textContent).toBe('Issues')
    release(TEST_BUNDLE)
    await flushTasks()
    await settle()
    expect($('p').textContent).toBe('Issues')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: false })
    policy.watch?.(scopeConfig('all', []))
    await flushTasks()
    await settle()
    expect($('p').textContent).toBe('议题')
    expect(send({ type: 'gcn:get-status' })).toMatchObject({ active: true })
  })

  it('失效时取消配置监听，迟到的读取不再改页面', async () => {
    await start()
    expect($('p').textContent).toBe('议题')
    const loads = locales.load.mock.calls.length
    let release!: (config: TranslationConfig) => void
    policy.getConfig.mockImplementation(() => new Promise<TranslationConfig>((resolve) => {
      release = resolve
    }))
    pageshow(true)
    context?.invalidate()
    expect(policy.unwatch).toHaveBeenCalled()
    release(scopeConfig('all', []))
    await flushTasks()
    await settle()
    expect(locales.load.mock.calls.length).toBe(loads)
    expect($('p').textContent).toBe('Issues')
  })
})

describe('turbo-bridge 入口', () => {
  async function loadBridge(): Promise<ContentScriptDefinition> {
    return (await import('../../../src/entrypoints/turbo-bridge.content')).default
  }

  it('在主世界、document_start 运行（读得到 window.Turbo），匹配地址与内容脚本一致', async () => {
    const bridge = await loadBridge()
    expect(bridge.world).toBe('MAIN')
    expect(bridge.runAt).toBe('document_start')
    expect(bridge.matches).toEqual((await load()).matches)
  })

  it('main 在 window 上安装桥接', async () => {
    const bridge = await loadBridge()
    const clear = vi.fn()
    Object.defineProperty(window, 'Turbo', { value: { cache: { clear }, visit: vi.fn() }, configurable: true })
    try {
      if (bridge.world === 'MAIN') await bridge.main()
      window.dispatchEvent(new Event(TURBO_RESET_EVENT))
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      const registry = window as unknown as Record<symbol, { uninstall(): void } | undefined>
      registry[Symbol.for('github-chinese.turbo-bridge')]?.uninstall()
      Reflect.deleteProperty(window, 'Turbo')
    }
  })
})

describe('本页暂停', () => {
  const sender = { id: 'test-extension' }

  function command(action: 'status' | 'restore' | 'resume', url = location.href) {
    return { type: 'gcn:page-translation', action, url }
  }

  function sendFrom(message: unknown, from: unknown = sender): { handled: boolean; response: unknown } {
    let response: unknown
    let handled = false
    for (const listener of state.listeners) {
      if (listener(message, from, (value) => {
        response = value
      }) === true) handled = true
    }
    return { handled, response }
  }

  function sendAsyncFrom(message: unknown, from: unknown = sender): { handled: boolean; response: Promise<unknown> } {
    let resolve: (value: unknown) => void = () => undefined
    const response = new Promise((done) => {
      resolve = done
    })
    const handled = state.listeners.some((listener) => listener(message, from, resolve) === true)
    return { handled, response }
  }

  async function boot(enabled: boolean): Promise<void> {
    state.settings = { ...state.settings, enabled }
    const definition = await load()
    context = createContext()
    await definition.main(context as never)
    await flushTasks()
  }

  function holdLoads(): { release(): void } {
    const pending: Array<(bundle: LocaleBundle) => void> = []
    locales.load.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve)
    }))
    return {
      release() {
        for (const resolve of pending.splice(0)) resolve(TEST_BUNDLE)
      },
    }
  }

  it('restore 保持原文且不改设置，resume 重新翻译', async () => {
    await boot(true)
    expect($('p').textContent).toBe('议题')
    const saved = { ...state.settings }
    expect(sendFrom(command('restore')).response).toMatchObject({ ok: true, paused: true, active: false })
    expect($('p').textContent).toBe('Issues')
    expect(state.settings).toEqual(saved)
    expect(sendFrom(command('resume')).response).toMatchObject({ ok: true, paused: false })
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('暂停期间不加载语言包，迟到的语言包不重新翻译', async () => {
    await boot(false)
    const loads = holdLoads()
    state.settingsListener!({ ...state.settings, enabled: true })
    await flushTasks()
    expect(locales.load).toHaveBeenCalledTimes(1)
    expect($('p').textContent).toBe('Issues')
    expect(sendFrom(command('restore')).response).toMatchObject({ ok: true, paused: true })
    expect(locales.load).toHaveBeenCalledTimes(1)
    loads.release()
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    expect(locales.load).toHaveBeenCalledTimes(1)
  })

  it('真正换页恢复翻译，普通 hash 不恢复', async () => {
    await boot(true)
    sendFrom(command('restore'))
    expect($('p').textContent).toBe('Issues')
    history.pushState(null, '', '/vuejs/core/issues#anchor')
    window.dispatchEvent(new Event('test:locationchange'))
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    history.pushState(null, '', '/vuejs/core/pull/1')
    window.dispatchEvent(new Event('test:locationchange'))
    await flushTasks()
    expect($('p').textContent).toBe('议题')
  })

  it('往返缓存恢复后仍保持暂停', async () => {
    await boot(true)
    sendFrom(command('restore'))
    expect($('p').textContent).toBe('Issues')
    pageshow(true)
    await flushTasks()
    expect($('p').textContent).toBe('Issues')
    expect(sendFrom(command('status')).response).toMatchObject({ ok: true, paused: true, active: false })
  })

  it('错误 sender 与旧 URL 不改变页面', async () => {
    await boot(true)
    const bad = [null, 'sender', {}, { id: 'other' }, { id: 'test-extension', tab: { id: 1 } }]
    for (const from of bad) {
      const result = sendFrom(command('restore'), from)
      expect(result.handled).toBe(false)
      expect(result.response).toBeUndefined()
    }
    expect($('p').textContent).toBe('议题')
    expect(sendFrom(command('restore', 'https://github.com/vuejs/core/pull/9')).response).toEqual({ ok: false })
    expect($('p').textContent).toBe('议题')
  })

  it('总开关 off→on 重置本页恢复态，引擎恢复运行', async () => {
    await boot(true)
    expect(sendFrom(command('restore')).response).toMatchObject({ ok: true, paused: true, active: false })
    expect($('p').textContent).toBe('Issues')
    state.settingsListener!({ ...state.settings, enabled: false })
    state.settingsListener!({ ...state.settings, enabled: true })
    await flushTasks()
    expect($('p').textContent).toBe('议题')
    expect(sendFrom(command('status')).response).toMatchObject({ ok: true, paused: false, active: true })
  })

  it('运行范围撤销再恢复时重置本页恢复态，引擎恢复运行', async () => {
    await boot(true)
    expect(sendFrom(command('restore')).response).toMatchObject({ ok: true, paused: true, active: false })
    expect($('p').textContent).toBe('Issues')
    policy.watch?.(scopeConfig('include', []))
    expect($('p').textContent).toBe('Issues')
    policy.watch?.(scopeConfig('all', []))
    await flushTasks()
    expect($('p').textContent).toBe('议题')
    expect(sendFrom(command('status')).response).toMatchObject({ ok: true, paused: false, active: true })
  })

  it('resume 等待中 restore 使旧 resume 失败，页面仍是原文', async () => {
    await boot(false)
    const loads = holdLoads()
    state.settingsListener!({ ...state.settings, enabled: true })
    await flushTasks()
    const resume = sendAsyncFrom(command('resume'))
    expect(resume.handled).toBe(true)
    let answered = false
    void resume.response.then(() => {
      answered = true
    })
    await flushTasks()
    expect(answered).toBe(false)
    expect(sendFrom(command('restore')).response).toMatchObject({ ok: true, paused: true })
    loads.release()
    await flushTasks()
    expect(await resume.response).toEqual({ ok: false })
    expect($('p').textContent).toBe('Issues')
  })
})
