import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { startPageTranslation } from '../../../src/translation/controller'
import {
  NO_SELECTION_ERROR,
  SENSITIVE_FRAME_ERROR,
  TRANSLATION_CONFIG_CHANGED_ERROR,
  TRANSLATION_PERMISSION_REMOVED_ERROR,
} from '../../../src/translation/messages'
import { translationConfigItem, DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import { settingsItem, DEFAULT_SETTINGS } from '../../../src/shared/settings'
import commonTable from '../../../public/dictionaries/zh-CN/common.json'
import devinTable from '../../../public/dictionaries/zh-CN/devin.json'
import en from '../../../src/i18n/en'
import ja from '../../../src/i18n/ja'
import zhCN from '../../../src/i18n/zh-CN'
import zhTW from '../../../src/i18n/zh-TW'
import { getCapturedShadowRoot, installShadowRootCapture, requireCapturedShadowRoot } from '../shared/shadow-roots'

const SINGLETON_KEY = Symbol.for('webTranslate.instance')
const smartMode = vi.hoisted(() => ({ enabled: false }))
const DEVIN_ENTRIES = { ...commonTable, ...devinTable }
let restoreShadowCapture: (() => void) | undefined

function rootShadow(): ShadowRoot | undefined {
  return getCapturedShadowRoot(document.documentElement.querySelector('[data-wt-root]'))
}

function requireRootShadow(): ShadowRoot {
  return requireCapturedShadowRoot(document.documentElement.querySelector('[data-wt-root]'))
}

function defaultTransport(message: { type: string; texts?: string[] }): Promise<unknown> {
  if (message.type === 'wt:page-modes') {
    return Promise.resolve({
      ok: true,
      modes: { enabled: true, fixed: !smartMode.enabled, auto: !smartMode.enabled, selection: true, smart: smartMode.enabled, ...(smartMode.enabled ? {} : { fixedEntries: DEVIN_ENTRIES }) },
    })
  }
  if (message.type === 'wt:translate') {
    return Promise.resolve({ ok: true, texts: (message.texts ?? []).map(() => '译文') })
  }
  return Promise.resolve({ ok: true })
}

vi.mock('../../../src/translation/config', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/translation/config')>()) }))
vi.mock('../../../src/translation/clipboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/translation/clipboard')>()
  return {
    ...actual,
    copySelectionText: vi.fn(actual.copySelectionText),
  }
})
vi.mock('../../../src/translation/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/translation/client')>()
  return {
    ...actual,
    sendTranslationMessage: vi.fn(defaultTransport),
    closePageSession: vi.fn(),
  }
})

const CONFIG = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  disabledDictionaries: [],
  targetLanguage: 'zh-CN' as const,
  autoOrigins: ['https://app.devin.ai'],
}

function stubGeometry(): void {
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
  )
}

function triggerMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    void fakeBrowser.runtime.onMessage.trigger(message, { id: fakeBrowser.runtime.id }, resolve)
  })
}

beforeEach(async () => {
  const { sendTranslationMessage } = await import('../../../src/translation/client')
  const { copySelectionText } = await import('../../../src/translation/clipboard')
  vi.mocked(sendTranslationMessage).mockReset()
  vi.mocked(sendTranslationMessage).mockImplementation(defaultTransport as never)
  vi.mocked(copySelectionText).mockClear()
  smartMode.enabled = false
  fakeBrowser.reset()
  vi.useFakeTimers()
  document.body.innerHTML = ''
  restoreShadowCapture = installShadowRootCapture()
  stubGeometry()
  await translationConfigItem.setValue(CONFIG)
  await settingsItem.setValue(DEFAULT_SETTINGS)
  vi.stubGlobal('location', new URL('https://app.devin.ai/work/a'))
})

afterEach(() => {
  const scope = globalThis as Record<symbol, { dispose(): void } | undefined>
  scope[SINGLETON_KEY]?.dispose()
  restoreShadowCapture?.()
  restoreShadowCapture = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function settle(ms = 600): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

describe('页面额度上限', () => {
  const PARAGRAPHS = 15

  /** 每段 1400 字符独立成批：14 批后再发就超过 20000 字符。 */
  async function capPage(): Promise<HTMLElement[]> {
    const paragraphs = Array.from({ length: PARAGRAPHS }, (_, index) => {
      const paragraph = document.createElement('p')
      paragraph.textContent = `Paragraph ${index} of a long synthetic article. `.repeat(40).slice(0, 1400).trim()
      document.body.append(paragraph)
      return paragraph
    })
    await startPageTranslation()
    await settle(5000)
    expect(await pageStatus()).toMatchObject({ capped: true, auto: false })
    expect(translated(paragraphs)).toBe(PARAGRAPHS - 1)
    expect(await translateCalls()).toBe(PARAGRAPHS - 1)
    return paragraphs
  }

  function translated(paragraphs: HTMLElement[]): number {
    return paragraphs.filter((paragraph) => paragraph.textContent === '译文').length
  }

  async function translateCalls(): Promise<number> {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    return vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length
  }

  async function pageStatus(): Promise<unknown> {
    const reply = (await triggerMessage({ type: 'wt:status' })) as { status: unknown }
    return reply.status
  }

  function chipShadow(): ShadowRoot {
    return requireRootShadow()
  }

  function chip(): HTMLElement {
    return chipShadow().querySelector('.pause-status') as HTMLElement
  }

  function chipButton(): HTMLButtonElement {
    return chipShadow().querySelector('.pause-resume') as HTMLButtonElement
  }

  it('恢复原文保留已结算额度，继续时才追加额度', async () => {
    const paragraphs = await capPage()
    await triggerMessage({ type: 'wt:page-action', action: 'restore' })
    expect(await pageStatus()).toMatchObject({ capped: true })
    await settle(100)
    expect(translated(paragraphs)).toBe(0)
    expect(chip().style.display).toBe('none')
    expect(await translateCalls()).toBe(PARAGRAPHS - 1)
    expect(await triggerMessage({ type: 'wt:page-action', action: 'resume' })).toEqual({ ok: true })
    await settle(5000)
    expect(translated(paragraphs)).toBe(PARAGRAPHS - 1)
    expect(await translateCalls()).toBe(2 * (PARAGRAPHS - 1))
  })

  it.each([
    ['模型', { model: 'm2' }],
    ['接口地址', { baseUrl: 'https://other.example.com/v1' }],
    ['温度', { temperature: 0.5 }],
    ['请求头修订号', { customHeadersRevision: '11111111-1111-4111-8111-111111111111' }],
  ])('达到上限后修改%s，新连接重新翻译', async (_name, change) => {
    const paragraphs = await capPage()
    await translationConfigItem.setValue({ ...CONFIG, ...change })
    await settle(5000)
    expect(translated(paragraphs)).toBe(PARAGRAPHS - 1)
    expect(await translateCalls()).toBe(2 * (PARAGRAPHS - 1))
  })

  it('同义重排 requestParams 键序不重置已译内容或页面额度', async () => {
    await translationConfigItem.setValue({ ...CONFIG, requestParams: { b: 1, a: 2 } })
    const paragraphs = await capPage()
    await translationConfigItem.setValue({ ...CONFIG, requestParams: { a: 2, b: 1 } })
    await settle(2000)
    expect(await pageStatus()).toMatchObject({ capped: true })
    expect(translated(paragraphs)).toBe(PARAGRAPHS - 1)
    expect(await translateCalls()).toBe(PARAGRAPHS - 1)
  })

  it('无关的刷新不重置额度', async () => {
    const paragraphs = await capPage()
    await triggerMessage({ type: 'wt:refresh' })
    await translationConfigItem.setValue({ ...CONFIG, disabledDictionaries: ['devin'] })
    await settle(2000)
    expect(await pageStatus()).toMatchObject({ capped: true })
    expect(translated(paragraphs)).toBe(PARAGRAPHS - 1)
    expect(await translateCalls()).toBe(PARAGRAPHS - 1)
  })

  it('达到上限显示常驻状态条，滚动不消失；继续翻译追加额度', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-CN' })
    const paragraphs = await capPage()
    expect(chip().style.display).not.toBe('none')
    expect(chip().textContent).toContain(zhCN.wtCapNotice)
    expect(chipButton().style.display).not.toBe('none')
    expect(chipButton().textContent).toBe(zhCN.wtResume)
    document.dispatchEvent(new Event('scroll'))
    expect(chip().style.display).not.toBe('none')
    chipButton().click()
    expect(chip().style.display).toBe('none')
    await settle(2000)
    expect(translated(paragraphs)).toBe(PARAGRAPHS)
    expect(await pageStatus()).toMatchObject({ capped: false, auto: true })
    expect(await translateCalls()).toBe(PARAGRAPHS)
  })

  it('状态条跟随界面语言', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    await capPage()
    expect(chip().textContent).toContain(en.wtCapNotice)
    expect(chipButton().textContent).toBe(en.wtResume)
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-TW' })
    await settle(100)
    expect(chip().textContent).toContain(zhTW.wtCapNotice)
    expect(chipButton().textContent).toBe(zhTW.wtResume)
  })

  it('恢复原文期间不显示上限状态条', async () => {
    await capPage()
    expect(chip().style.display).not.toBe('none')
    await triggerMessage({ type: 'wt:page-action', action: 'restore' })
    await settle(100)
    expect(chip().style.display).toBe('none')
  })
})

describe('controller 生命周期', () => {
  it('取消尚未完成的批次不能耗尽页面额度', async () => {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const pending = new Map<string, (reply: unknown) => void>()
    vi.mocked(sendTranslationMessage).mockImplementation(((message: { type: string; requestId?: string; texts?: string[] }) => {
      if (message.type === 'wt:translate') {
        return new Promise((resolve) => {
          pending.set(message.requestId!, resolve)
        })
      }
      if (message.type === 'wt:cancel-assist') {
        pending.get(message.requestId!)?.({ ok: false, error: 'synthetic queued cancellation', code: 'cancelled' })
        pending.delete(message.requestId!)
        return Promise.resolve({ ok: true })
      }
      return defaultTransport(message)
    }) as never)
    const text = 'A synthetic sentence for queue cancellation. '.repeat(25).slice(0, 1000)
    const paragraph = document.createElement('p')
    paragraph.textContent = text
    document.body.append(paragraph)
    await startPageTranslation()
    await settle(1000)
    const calls = () => vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => (m as { type: string }).type === 'wt:translate').length
    expect(calls()).toBe(1)
    try {
      for (let index = 0; index < 22; index += 1) {
        await triggerMessage({ type: 'wt:page-action', action: 'restore' })
        await settle(20)
        await triggerMessage({ type: 'wt:page-action', action: 'resume' })
        await settle(1000)
        const status = await triggerMessage({ type: 'wt:status' })
        expect(status, `restore/resume ${index + 1}, requests=${calls()}`).toMatchObject({ ok: true, status: { capped: false } })
        expect(calls()).toBe(index + 2)
      }
    } finally {
      for (const resolve of pending.values()) resolve({ ok: false, error: 'cleanup', code: 'cancelled' })
      pending.clear()
    }
  })

  it('智能陪读仍开启时修改模型，丢弃旧停留并要求重新回读', async () => {
    smartMode.enabled = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.body.innerHTML = '<main><p>Some sufficiently long english paragraph about quantum information.</p></main>'
    const config = { ...CONFIG, selectionPopupEnabled: true, proactiveAssistEnabled: true }
    await translationConfigItem.setValue(config)
    await startPageTranslation()
    await settle(100)
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const assistCalls = (): number => vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:assist').length
    const initialCalls = assistCalls()
    const p = document.querySelector('p')!
    const pointer = (type: string): void => {
      const event = new Event(type)
      Object.defineProperties(event, { isTrusted: { value: true }, target: { value: p }, relatedTarget: { value: null } })
      document.dispatchEvent(event)
    }
    pointer('pointerover')
    await settle(2000)
    pointer('pointerout')
    await settle(800)
    pointer('pointerover')
    await settle(500)
    await translationConfigItem.setValue({ ...config, model: 'replacement-model' })
    await settle(2000)
    expect(assistCalls()).toBe(initialCalls)
    pointer('pointerover')
    await settle(2000)
    pointer('pointerout')
    await settle(800)
    pointer('pointerover')
    await settle(1600)
    expect(assistCalls()).toBe(initialCalls + 1)
  })

  it('初始翻译固定+自动，restore 恢复原文且 resume 再译', async () => {
    document.body.innerHTML = '<nav><button id="b">Settings</button></nav><p>English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('#b')?.textContent).toBe('设置')
    expect(document.querySelector('p')?.textContent).toBe('译文')
    await triggerMessage({ type: 'wt:page-action', action: 'restore' })
    expect(document.querySelector('p')?.textContent).toBe('English text here.')
    await settle(1000)
    expect(document.querySelector('p')?.textContent).toBe('English text here.')
    await triggerMessage({ type: 'wt:page-action', action: 'resume' })
    await settle(600)
    expect(document.querySelector('p')?.textContent).toBe('译文')
  })

  it('wt:stop 恢复且停止；wt:refresh 重启', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    await triggerMessage({ type: 'wt:stop' })
    expect(document.querySelector('p')?.textContent).toBe('English text here.')
    document.body.insertAdjacentHTML('beforeend', '<p>New text again.</p>')
    await settle(600)
    expect(document.querySelectorAll('p')[1]?.textContent).toBe('New text again.')
    await triggerMessage({ type: 'wt:refresh' })
    await settle(600)
    expect(document.querySelectorAll('p')[1]?.textContent).toBe('译文')
  })

  it('导航后的模式读取被较新的刷新取代时仍继续扫描新内容', async () => {
    const navigation = new EventTarget()
    const previous = Object.getOwnPropertyDescriptor(window, 'navigation')
    Object.defineProperty(window, 'navigation', { configurable: true, value: navigation })
    const modesReply = { ok: true, modes: { enabled: true, fixed: true, auto: false, selection: false, smart: false, fixedEntries: { Settings: '设置' } } }
    let holdNextModes = false
    let releaseNavigation: ((value: unknown) => void) | undefined
    try {
      const { sendTranslationMessage } = await import('../../../src/translation/client')
      vi.mocked(sendTranslationMessage).mockImplementation(((message: { type: string; texts?: string[] }) => {
        if (message.type !== 'wt:page-modes') return defaultTransport(message)
        if (holdNextModes) {
          holdNextModes = false
          return new Promise((resolve) => { releaseNavigation = resolve })
        }
        return Promise.resolve(modesReply)
      }) as never)
      document.body.innerHTML = '<button id=label>Settings</button>'
      await startPageTranslation()
      await settle(100)
      expect(document.querySelector('#label')?.textContent).toBe('设置')
      holdNextModes = true
      vi.stubGlobal('location', new URL('https://app.devin.ai/work/navigation-race'))
      document.body.innerHTML = '<button id=latest>Settings</button><pre>Settings</pre>'
      // DOM 变更先排队，导航事件随后取消扫描；后续刷新必须接续。
      await Promise.resolve()
      navigation.dispatchEvent(new Event('navigatesuccess'))
      await settle(0)
      expect(releaseNavigation).toEqual(expect.any(Function))
      expect(await triggerMessage({ type: 'wt:refresh' })).toEqual({ ok: true })
      releaseNavigation!(modesReply)
      await settle(100)
      expect(await triggerMessage({ type: 'wt:status' })).toMatchObject({ ok: true, status: { fixed: true } })
      expect(document.querySelector('#latest')?.textContent).toBe('设置')
      expect(document.querySelector('pre')?.textContent).toBe('Settings')
      expect(vi.mocked(sendTranslationMessage).mock.calls.filter(([message]) => message.type === 'wt:translate')).toHaveLength(0)
    } finally {
      releaseNavigation?.(modesReply)
      if (previous === undefined) Reflect.deleteProperty(window, 'navigation')
      else Object.defineProperty(window, 'navigation', previous)
    }
  })

  it('pagehide/pageshow persisted 保留已翻译 DOM 且不重复请求', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    const hide = new Event('pagehide')
    Object.defineProperty(hide, 'persisted', { value: true })
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const before = vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length
    window.dispatchEvent(hide)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    const show = new Event('pageshow')
    Object.defineProperty(show, 'persisted', { value: true })
    window.dispatchEvent(show)
    await settle(1200)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    expect(vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length).toBe(before)
  })

  it('进入往返缓存和卸载都结束页面会话，单页路由不结束', async () => {
    const { closePageSession } = await import('../../../src/translation/client')
    vi.mocked(closePageSession).mockClear()
    await startPageTranslation()
    await settle(200)
    vi.stubGlobal('location', new URL('https://app.devin.ai/work/b'))
    window.dispatchEvent(new Event('popstate'))
    await settle(200)
    expect(closePageSession).not.toHaveBeenCalled()
    const hide = new Event('pagehide')
    Object.defineProperty(hide, 'persisted', { value: true })
    window.dispatchEvent(hide)
    expect(closePageSession).toHaveBeenCalledTimes(1)
    const show = new Event('pageshow')
    Object.defineProperty(show, 'persisted', { value: true })
    window.dispatchEvent(show)
    await settle(200)
    expect(closePageSession).toHaveBeenCalledTimes(1)
    const unload = new Event('pagehide')
    Object.defineProperty(unload, 'persisted', { value: false })
    window.dispatchEvent(unload)
    expect(closePageSession).toHaveBeenCalledTimes(2)
  })

  it('wt:status 在 ready 后返回 modes', async () => {
    await startPageTranslation()
    await settle(200)
    const reply = (await triggerMessage({ type: 'wt:status' })) as { ok: boolean; status: { supported: boolean } }
    expect(reply.ok).toBe(true)
    expect(reply.status.supported).toBe(true)
  })
})

describe('controller 自动翻译失败处理', () => {
  async function runWith(replies: unknown[]): Promise<{ translates(): number; status(): Promise<{ paused: boolean; error: string }> }> {
    document.body.innerHTML = '<p>English text here.</p>'
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type === 'wt:translate') {
        return replies.shift() ?? { ok: true, texts: (message.texts ?? []).map(() => '译文') }
      }
      return await defaultTransport(message)
    }) as never)
    await startPageTranslation()
    return {
      translates: () => vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length,
      status: async () => ((await triggerMessage({ type: 'wt:status' })) as { status: { paused: boolean; error: string } }).status,
    }
  }

  it('内部取消静默重发，不暂停也不留下错误', async () => {
    const page = await runWith([{ ok: false, error: '已取消', code: 'cancelled' }])
    await settle(1000)
    expect(await page.status()).toMatchObject({ paused: false, error: '' })
    await settle(2000)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    expect(page.translates()).toBe(2)
  })

  it('429 按 Retry-After 等待后自动继续，不暂停页面', async () => {
    const page = await runWith([{ ok: false, error: '请求过于频繁，请稍后重试', code: 'rate_limited', retryAfterMs: 30_000 }])
    await settle(1000)
    expect(page.translates()).toBe(1)
    expect(await page.status()).toMatchObject({ paused: false, error: '' })
    await settle(28_000)
    expect(page.translates()).toBe(1)
    await settle(2000)
    expect(page.translates()).toBe(2)
    expect(document.querySelector('p')?.textContent).toBe('译文')
  })

  it('401 立即暂停并显示错误，不重试', async () => {
    const page = await runWith([{ ok: false, error: '凭证无效或没有访问权限', code: 'auth' }])
    await settle(1000)
    expect(await page.status()).toMatchObject({ paused: true, error: '凭证无效或没有访问权限' })
    await settle(60_000)
    expect(page.translates()).toBe(1)
  })

  it('瞬时失败耗尽重试后才暂停并显示错误', async () => {
    const failure = { ok: false, error: '模型服务暂时不可用，请稍后重试', code: 'server' }
    const page = await runWith([failure, failure, failure])
    await settle(600)
    expect(await page.status()).toMatchObject({ paused: false, error: '' })
    await settle(10_000)
    expect(page.translates()).toBe(3)
    expect(await page.status()).toMatchObject({ paused: true, error: failure.error })
  })

  it('后台返回数量错误视为格式错误：重发一次，不暂停', async () => {
    const page = await runWith([{ ok: true, texts: [] }])
    await settle(1000)
    expect(await page.status()).toMatchObject({ paused: false, error: '' })
    expect(page.translates()).toBe(2)
    expect(document.querySelector('p')?.textContent).toBe('译文')
  })

  it('单条持续格式错误只保留该条原文，不暂停也不显示错误', async () => {
    const bad = { ok: false, error: '翻译服务返回格式不正确', code: 'bad_output' }
    const page = await runWith([bad, bad])
    await settle(1000)
    expect(page.translates()).toBe(2)
    expect(await page.status()).toMatchObject({ paused: false, error: '' })
    expect(document.querySelector('p')?.textContent).toBe('English text here.')
  })

  it('回复条数正确但全部为空，连续失败到暂停时也显示错误', async () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) => `<p>Sentence number ${index}.</p>`).join('')
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type === 'wt:translate') return { ok: true, texts: (message.texts ?? []).map(() => '') }
      return await defaultTransport(message)
    }) as never)
    document.body.innerHTML = paragraphs
    await startPageTranslation()
    await settle(5000)
    const { status } = (await triggerMessage({ type: 'wt:status' })) as { status: { paused: boolean; error: string } }
    expect(status).toMatchObject({ paused: true, error: '翻译服务返回格式不正确' })
  })

  it('回复的缓存字符数传给引擎：整页命中缓存不触发字符上限', async () => {
    const paragraph = 'A sentence that is long enough to matter for the page budget. '.repeat(20)
    const paragraphs = Array.from({ length: 12 }, (_, index) => `<p>${index} ${paragraph}</p>`).join('')
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type !== 'wt:translate') return await defaultTransport(message)
      const texts = message.texts ?? []
      return { ok: true, texts: texts.map(() => '译文'), cachedChars: texts.reduce((sum, text) => sum + text.length, 0) }
    }) as never)
    document.body.innerHTML = Array.from({ length: 3 }, () => paragraphs).join('')
    await startPageTranslation()
    await settle(5000)
    const { status } = (await triggerMessage({ type: 'wt:status' })) as { status: { capped: boolean } }
    expect(status.capped).toBe(false)
    expect(document.body.textContent).not.toContain('A sentence')
  })

  it('超时拆分用尽仍无成功时暂停并显示错误', async () => {
    const timeout = { ok: false, error: '请求超时，请稍后重试', code: 'timeout' }
    const page = await runWith([timeout, timeout, timeout])
    await settle(10_000)
    expect(page.translates()).toBe(3)
    expect(await page.status()).toMatchObject({ paused: true, error: timeout.error })
  })
})

describe('controller 暂停状态与继续', () => {
  const AUTH = { ok: false, error: '凭证无效或没有访问权限', code: 'auth' }

  function chip(): HTMLElement | null {
    return rootShadow()?.querySelector('.pause-status') ?? null
  }

  function chipVisible(): boolean {
    const element = chip()
    return element !== null && element.style.display !== 'none'
  }

  async function status(): Promise<{ paused: boolean; error: string }> {
    return ((await triggerMessage({ type: 'wt:status' })) as { status: { paused: boolean; error: string } }).status
  }

  /** 第一段正常译出，之后的新内容按 replies 回复；返回每次翻译请求的原文。 */
  async function pausedPage(replies: unknown[]): Promise<string[][]> {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const sent: string[][] = []
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type !== 'wt:translate') return await defaultTransport(message)
      sent.push([...(message.texts ?? [])])
      const finished = sent.length === 1
      return (finished ? undefined : replies.shift()) ?? { ok: true, texts: (message.texts ?? []).map(() => '译文') }
    }) as never)
    document.body.innerHTML = '<p id="done">Finished english paragraph.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('#done')?.textContent).toBe('译文')
    document.body.insertAdjacentHTML('beforeend', '<p id="next">Next english paragraph.</p>')
    await settle(1200)
    return sent
  }

  it('暂停后显示持久原因，滚动和点击页面都不消失', async () => {
    await pausedPage([AUTH])
    expect(await status()).toMatchObject({ paused: true, error: AUTH.error })
    expect(chipVisible()).toBe(true)
    expect(chip()?.textContent).toContain(AUTH.error)
    document.dispatchEvent(new Event('scroll'))
    document.dispatchEvent(new Event('pointerdown'))
    await settle(5000)
    expect(chipVisible()).toBe(true)
  })

  it('面板已打开时暂停也会显示原因', async () => {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string }) =>
      message.type === 'wt:translate' ? AUTH : await defaultTransport(message)) as never)
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await triggerMessage({ type: 'wt:show-selection', text: '', error: '划词失败' })
    await settle(1200)
    expect(chipVisible()).toBe(true)
  })

  it('点击继续清除暂停，只翻译未完成的内容', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-CN' })
    const sent = await pausedPage([AUTH])
    const before = sent.length
    expect(sent.at(-1)).toEqual(['Next english paragraph.'])
    const button = chip()?.querySelector('button')
    expect(button?.textContent).toBe('继续翻译')
    button?.click()
    expect(chipVisible()).toBe(false)
    await settle(1200)
    expect(await status()).toMatchObject({ paused: false, error: '' })
    expect(document.querySelector('#next')?.textContent).toBe('译文')
    expect(document.querySelector('#done')?.textContent).toBe('译文')
    expect(sent.slice(before)).toEqual([['Next english paragraph.']])
  })

  it('弹窗的继续操作同样移除状态条', async () => {
    await pausedPage([AUTH])
    await triggerMessage({ type: 'wt:page-action', action: 'resume' })
    await settle(1200)
    expect(chipVisible()).toBe(false)
    expect(document.querySelector('#next')?.textContent).toBe('译文')
  })

  it('继续后原因仍在时重新显示', async () => {
    await pausedPage([AUTH, AUTH])
    chip()?.querySelector('button')?.click()
    await settle(1200)
    expect(chipVisible()).toBe(true)
    expect(await status()).toMatchObject({ paused: true, error: AUTH.error })
  })

  it('无关配置刷新不重译、不解除暂停，状态条保留', async () => {
    const sent = await pausedPage([AUTH])
    const before = sent.length
    await translationConfigItem.setValue({ ...CONFIG, autoOrigins: [...CONFIG.autoOrigins, 'https://b.example'] })
    await triggerMessage({ type: 'wt:refresh' })
    await settle(2000)
    expect(chipVisible()).toBe(true)
    expect(sent.length).toBe(before)
    expect(document.querySelector('#done')?.textContent).toBe('译文')
  })

  it('恢复原文或总开关关闭时移除状态条', async () => {
    await pausedPage([AUTH])
    await triggerMessage({ type: 'wt:page-action', action: 'restore' })
    expect(chipVisible()).toBe(false)
    await triggerMessage({ type: 'wt:page-action', action: 'resume' })
    await settle(1200)
    await triggerMessage({ type: 'wt:stop' })
    expect(chipVisible()).toBe(false)
  })

  it('页面导航清除暂停和状态条', async () => {
    await pausedPage([AUTH])
    vi.stubGlobal('location', new URL('https://app.devin.ai/work/b'))
    window.dispatchEvent(new Event('popstate'))
    await triggerMessage({ type: 'wt:refresh' })
    await settle(1200)
    document.body.insertAdjacentHTML('beforeend', '<p id="after">Paragraph after navigation.</p>')
    await settle(1200)
    expect(chipVisible()).toBe(false)
    expect(document.querySelector('#after')?.textContent).toBe('译文')
  })
})

describe('失败段数量与全部重试', () => {
  const LONG = Array.from({ length: 100 }, (_, index) => `Sentence number ${index} of a long article body.`).join(' ')
  const POISON = 'Sentence number 50 '

  /** 含 POISON 的分段返回空译文，其余正常；poisoned 改为 false 后全部成功。 */
  async function failedPage(): Promise<{ sent: string[][]; heal(): void }> {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const sent: string[][] = []
    let poisoned = true
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type !== 'wt:translate') return await defaultTransport(message)
      const texts = message.texts ?? []
      sent.push(texts)
      return { ok: true, texts: texts.map((text) => (poisoned && text.includes(POISON) ? '' : '译文')) }
    }) as never)
    document.body.innerHTML = `<p id="long">${LONG}</p><p id="short">Short tail paragraph.</p>`
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-CN' })
    await startPageTranslation()
    await settle(5000)
    return {
      sent,
      heal() {
        poisoned = false
      },
    }
  }

  async function status(): Promise<unknown> {
    return ((await triggerMessage({ type: 'wt:status' })) as { status: unknown }).status
  }

  function chip(): HTMLElement {
    return requireRootShadow().querySelector('.pause-status') as HTMLElement
  }

  it('状态报告失败数量，状态条提供全部重试，只重发失败段并清零', async () => {
    const { sent, heal } = await failedPage()
    expect(document.querySelector('#long')?.textContent).toBe(LONG)
    expect(document.querySelector('#short')?.textContent).toBe('译文')
    expect(await status()).toMatchObject({ failed: 1, auto: true, paused: false })
    expect(chip().style.display).not.toBe('none')
    expect(chip().textContent).toContain('1 段翻译失败')
    const button = chip().querySelector('button')!
    expect(button.textContent).toBe(zhCN.wtRetryFailed)
    heal()
    const before = sent.length
    button.click()
    expect(chip().style.display).toBe('none')
    await settle(5000)
    expect(document.querySelector('#long')?.textContent).toMatch(/^(译文)+$/)
    expect(await status()).toMatchObject({ failed: 0, auto: true })
    expect(chip().style.display).toBe('none')
    expect(sent.slice(before).flat().every((text) => LONG.includes(text))).toBe(true)
    expect(sent.slice(before).flat()).not.toContain('Short tail paragraph.')
  })

  it('弹窗发送 retry-failed；仍失败则数量和状态条回来', async () => {
    await failedPage()
    expect(await triggerMessage({ type: 'wt:page-action', action: 'retry-failed' })).toEqual({ ok: true })
    expect(await status()).toMatchObject({ failed: 0 })
    await settle(5000)
    expect(await status()).toMatchObject({ failed: 1 })
    expect(chip().style.display).not.toBe('none')
  })

  it('恢复原文清除失败记录，且此时 retry-failed 被拒绝', async () => {
    await failedPage()
    await triggerMessage({ type: 'wt:page-action', action: 'restore' })
    expect(await status()).toMatchObject({ failed: 0 })
    expect(chip().style.display).toBe('none')
    expect(document.querySelector('#short')?.textContent).toBe('Short tail paragraph.')
    expect(await triggerMessage({ type: 'wt:page-action', action: 'retry-failed' })).toEqual({ ok: false, error: zhCN.wtAutoPaused })
  })

  it('导航清除失败记录和状态条', async () => {
    await failedPage()
    vi.stubGlobal('location', new URL('https://app.devin.ai/work/b'))
    window.dispatchEvent(new Event('popstate'))
    document.body.innerHTML = '<p>Fresh page paragraph.</p>'
    await settle(2000)
    expect(await status()).toMatchObject({ failed: 0 })
    expect(chip().style.display).toBe('none')
  })

  it('状态条跟随界面语言', async () => {
    await failedPage()
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    await settle(100)
    expect(chip().textContent).toContain(en.wtFailedCount.replace('{count}', '1'))
    expect(chip().querySelector('button')?.textContent).toBe(en.wtRetryFailed)
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-TW' })
    await settle(100)
    expect(chip().textContent).toContain(zhTW.wtFailedCount.replace('{count}', '1'))
    expect(chip().querySelector('button')?.textContent).toBe(zhTW.wtRetryFailed)
  })
})

describe('controller 后台重启', () => {
  const LOST = { ok: false, error: '无法连接扩展后台，请重试或刷新页面', code: 'disconnected' }

  it('翻译请求遇到后台重启时重发，不暂停也不留下错误', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const replies: unknown[] = [LOST, LOST]
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) =>
      message.type === 'wt:translate'
        ? (replies.shift() ?? { ok: true, texts: (message.texts ?? []).map(() => '译文') })
        : await defaultTransport(message)) as never)
    await startPageTranslation()
    await settle(1000)
    const { status } = (await triggerMessage({ type: 'wt:status' })) as { status: { paused: boolean; error: string } }
    expect(status).toMatchObject({ paused: false, error: '' })
    await settle(5000)
    expect(document.querySelector('p')?.textContent).toBe('译文')
  })

  it('读取模式时后台重启：保留已译内容和模式，稍后重读', async () => {
    document.body.innerHTML = '<p id="first">English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('#first')?.textContent).toBe('译文')
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const before = vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:page-modes').length
    vi.mocked(sendTranslationMessage).mockImplementationOnce((async () => LOST) as never)
    await triggerMessage({ type: 'wt:refresh' })
    expect(document.querySelector('#first')?.textContent).toBe('译文')
    await settle(1500)
    expect(vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:page-modes').length).toBe(before + 2)
    expect(document.querySelector('#first')?.textContent).toBe('译文')
    document.body.insertAdjacentHTML('beforeend', '<p id="later">Fresh english paragraph.</p>')
    await settle(1200)
    expect(document.querySelector('#later')?.textContent).toBe('译文')
  })

  it('后台始终不恢复：重读有界，用尽后才关闭页面功能', async () => {
    document.body.innerHTML = '<p id="first">English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const calls = (): number => vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:page-modes').length
    vi.mocked(sendTranslationMessage).mockImplementation((async () => LOST) as never)
    const before = calls()
    await triggerMessage({ type: 'wt:refresh' })
    await settle(4000)
    expect(document.querySelector('#first')?.textContent).toBe('译文')
    await settle(30_000)
    expect(calls()).toBe(before + 6)
    expect(document.querySelector('#first')?.textContent).toBe('English text here.')
  })
})

describe('controller 幂等刷新', () => {
  async function translates(): Promise<number> {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    return vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length
  }

  it('配置不变的 wt:refresh 不取消也不重译；重复入口不刷新', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    const before = await translates()
    expect(before).toBeGreaterThan(0)
    await triggerMessage({ type: 'wt:refresh' })
    await settle(600)
    await triggerMessage({ type: 'wt:refresh' })
    await settle(600)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    expect(await translates()).toBe(before)
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3 } as never)
    await startPageTranslation()
    await settle(600)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    expect(await translates()).toBe(before)
  })

  it('在途自动请求在不变刷新后仍可应用', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((r) => {
      release = r
    })
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type === 'wt:page-modes') {
        return { ok: true, modes: { enabled: true, fixed: true, auto: true, selection: true, smart: false, fixedEntries: DEVIN_ENTRIES } }
      }
      if (message.type === 'wt:translate') return await gate
      return { ok: true }
    }) as never)
    await startPageTranslation()
    await settle(600)
    const before = vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length
    await triggerMessage({ type: 'wt:refresh' })
    release({ ok: true, texts: ['译文'] })
    await settle(600)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    expect(vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length).toBe(before)
  })

  it('普通 #anchor 不导航，#/route 与 #!route 触发导航', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const modesCalls = (): number => vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:page-modes').length
    const before = modesCalls()
    vi.stubGlobal('location', new URL('https://app.devin.ai/work/a#section'))
    window.dispatchEvent(new Event('hashchange'))
    await settle(600)
    expect(modesCalls()).toBe(before)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    vi.stubGlobal('location', new URL('https://app.devin.ai/work/a#/route'))
    window.dispatchEvent(new Event('hashchange'))
    await settle(600)
    expect(modesCalls()).toBeGreaterThan(before)
    const after = modesCalls()
    vi.stubGlobal('location', new URL('https://app.devin.ai/work/a#!/deep'))
    window.dispatchEvent(new Event('hashchange'))
    await settle(600)
    expect(modesCalls()).toBeGreaterThan(after)
  })

  it('界面语言 ja 注入卡片标题', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'ja' })
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await settle()
    await triggerMessage({ type: 'wt:show-selection', text: 'Physics term' })
    await settle()
    const title = requireRootShadow().querySelector('.panel-title')
    expect(title?.textContent).toBe(ja.wtPanelTranslate)
  })

  it('配置读取失败后刷新可恢复并继续翻译', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    const configModule = await import('../../../src/translation/config')
    vi.spyOn(configModule, 'getTranslationConfig').mockRejectedValueOnce(new Error('storage down'))
    await triggerMessage({ type: 'wt:refresh' })
    await settle(600)
    await triggerMessage({ type: 'wt:refresh' })
    await settle(600)
    document.body.insertAdjacentHTML('beforeend', '<p id="later">Fresh english paragraph.</p>')
    await settle(600)
    expect(document.querySelector('#later')?.textContent).toBe('译文')
    expect(document.querySelector('p')?.textContent).toBe('译文')
  })

  it('SPA 导航保留已译节点，新内容继续翻译', async () => {
    document.body.innerHTML = '<p id="keep">English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('#keep')?.textContent).toBe('译文')
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const before = vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate').length
    document.querySelector('#keep')!.insertAdjacentHTML('afterend', '<p id="new">A sibling changed by route.</p>')
    vi.stubGlobal('location', new URL('https://app.devin.ai/work/b'))
    window.dispatchEvent(new Event('hashchange'))
    await settle(1200)
    expect(document.querySelector('#keep')?.textContent).toBe('译文')
    expect(document.querySelector('#new')?.textContent).toBe('译文')
    const calls = vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate')
    const added = calls.slice(before)
    expect(added.length).toBeGreaterThan(0)
    for (const call of added) {
      const texts = (call[0] as { texts?: string[] }).texts ?? []
      expect(texts).toContain('A sibling changed by route.')
      expect(texts).not.toContain('English text here.')
    }
  })
})

describe('源语言切换', () => {
  it('切换源语言恢复原文并挡住迟到回包', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    let releaseFirst!: (value: unknown) => void
    const firstGate = new Promise<unknown>((resolve) => {
      releaseFirst = resolve
    })
    let translates = 0
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type === 'wt:page-modes') {
        return {
          ok: true,
          modes: { enabled: true, fixed: true, auto: true, selection: true, smart: false, fixedEntries: DEVIN_ENTRIES },
        }
      }
      if (message.type === 'wt:translate') {
        translates += 1
        if (translates === 1) return await firstGate
        return { ok: true, texts: (message.texts ?? []).map(() => '新源译文') }
      }
      return { ok: true }
    }) as never)
    await startPageTranslation()
    await settle(600)
    expect(translates).toBe(1)
    expect(document.querySelector('p')?.textContent).toBe('English text here.')
    await translationConfigItem.setValue({ ...CONFIG, sourceLanguage: 'ja' })
    await settle(1200)
    expect(document.querySelector('p')?.textContent).toBe('新源译文')
    releaseFirst({ ok: true, texts: ['迟到译文'] })
    await settle(600)
    expect(document.querySelector('p')?.textContent).toBe('新源译文')
  })
})

describe('辅助候选与自动翻译分流', () => {
  it('英文 auto 选区仍辅助，显式日语同源选区可辅助，自动翻译仍跳过同源', async () => {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const assistTexts = (): string[] =>
      vi.mocked(sendTranslationMessage).mock.calls.flatMap(([message]) =>
        message.type === 'wt:assist' ? [message.input.text] : [],
      )
    const translatedSources = (): string[] =>
      vi.mocked(sendTranslationMessage).mock.calls.flatMap(([message]) =>
        message.type === 'wt:translate' ? [...message.texts] : [],
      )
    const selectParagraph = (selector: string): void => {
      const paragraph = document.querySelector(selector)
      const node = paragraph?.firstChild
      if (paragraph === null || !(node instanceof Text)) throw new Error(`missing text in ${selector}`)
      const selection = window.getSelection()
      if (selection === null) throw new Error('missing selection')
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, node.length)
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), { isTrusted: true }))
    }
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
    )
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
      () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
    )
    const english = 'English selection text here.'
    await translationConfigItem.setValue({ ...CONFIG, targetLanguage: 'en', sourceLanguage: 'auto' })
    document.body.innerHTML = `<p id="en">${english}</p>`
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('#en')?.textContent).toBe(english)
    selectParagraph('#en')
    await settle(400)
    expect(assistTexts()).toContain(english)

    const japanese = 'これは日本語の文章です。'
    await translationConfigItem.setValue({ ...CONFIG, targetLanguage: 'ja', sourceLanguage: 'ja' })
    await settle(1200)
    document.body.insertAdjacentHTML('beforeend', `<p id="ja">${japanese}</p>`)
    await settle(1200)
    expect(document.querySelector('#ja')?.textContent).toBe(japanese)
    expect(translatedSources()).not.toContain(japanese)
    selectParagraph('#ja')
    await settle(400)
    expect(assistTexts()).toContain(japanese)
  })
})

describe('词典词条表变更', () => {
  it('refresh 后 fixedEntries 变化触发重扫：旧替换还原、新词条生效', async () => {
    document.body.innerHTML = '<nav><button id="b">Settings</button><button id="c">Sessions</button></nav>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('#b')?.textContent).toBe('设置')
    expect(document.querySelector('#c')?.textContent).toBe('会话')

    const nextEntries = { ...DEVIN_ENTRIES, Settings: '自定义设置', Sessions: '自定义会话' }
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    vi.mocked(sendTranslationMessage).mockImplementation(((message: { type: string; texts?: string[] }) => {
      if (message.type === 'wt:page-modes') {
        return Promise.resolve({
          ok: true,
          modes: { enabled: true, fixed: true, auto: true, selection: true, smart: false, fixedEntries: nextEntries },
        })
      }
      if (message.type === 'wt:translate') {
        return Promise.resolve({ ok: true, texts: (message.texts ?? []).map(() => '译文') })
      }
      return Promise.resolve({ ok: true })
    }) as never)

    await triggerMessage({ type: 'wt:refresh' })
    await settle(1200)
    expect(document.querySelector('#b')?.textContent).toBe('自定义设置')
    expect(document.querySelector('#c')?.textContent).toBe('自定义会话')
    vi.mocked(sendTranslationMessage).mockImplementation(defaultTransport as never)
  })
})

describe('选择工具栏', () => {
  function selectText(text: string): void {
    document.body.innerHTML = `<p>${text}</p>`
    const node = document.querySelector('p')?.firstChild
    if (!(node instanceof Text)) throw new Error('missing text')
    const selection = window.getSelection()
    if (selection === null) throw new Error('missing selection')
    const range = document.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
    )
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
      () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
    )
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), { isTrusted: true }))
  }

  function toolbar(): HTMLElement {
    return requireRootShadow().querySelector('.selection-toolbar') as HTMLElement
  }

  it('工具栏模式先显示动作，点击后才发请求，同语言文字也可释义', async () => {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    await translationConfigItem.setValue({
      ...CONFIG,
      selectionPopupEnabled: true,
      selectionToolbarEnabled: true,
    })
    await startPageTranslation()
    await settle(100)
    selectText('设置页面')
    await settle(400)
    expect(toolbar().style.display).not.toBe('none')
    expect(vi.mocked(sendTranslationMessage).mock.calls.filter(([message]) => message.type === 'wt:assist')).toHaveLength(0)
    const define = toolbar().querySelector('[data-action="define"]') as HTMLButtonElement
    define.dispatchEvent(Object.assign(new MouseEvent('click', { bubbles: true }), { isTrusted: true }))
    await settle(20)
    const assist = vi.mocked(sendTranslationMessage).mock.calls.filter(([message]) => message.type === 'wt:assist')
    expect(assist).toHaveLength(1)
    expect(assist[0]?.[0]).toMatchObject({ input: { text: '设置页面', requestedIntent: 'define' } })
  })

  const source = '设置页面'

  async function selectionModes(): Promise<void> {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    vi.mocked(sendTranslationMessage).mockImplementation((async (message: { type: string; texts?: string[] }) => {
      if (message.type === 'wt:page-modes') {
        return {
          ok: true,
          modes: { enabled: true, fixed: false, auto: false, selection: true, smart: false },
        }
      }
      return defaultTransport(message)
    }) as never)
  }

  async function messages(): Promise<{ translate: { type: string; mode?: string; texts?: string[] }[]; assist: { type: string; input?: { text?: string; requestedIntent?: string } }[] }> {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const calls = vi.mocked(sendTranslationMessage).mock.calls
    return {
      translate: calls.filter(([message]) => message.type === 'wt:translate').map(([message]) => message) as { type: string; mode?: string; texts?: string[] }[],
      assist: calls.filter(([message]) => message.type === 'wt:assist').map(([message]) => message) as { type: string; input?: { text?: string; requestedIntent?: string } }[],
    }
  }

  async function openToolbar(extra: Partial<typeof CONFIG> = {}): Promise<void> {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-CN' })
    await selectionModes()
    await translationConfigItem.setValue({
      ...CONFIG,
      selectionPopupEnabled: true,
      selectionToolbarEnabled: true,
      ...extra,
    })
    await startPageTranslation()
    await settle(100)
    selectText(source)
    await settle(400)
  }

  function clickAction(name: string): void {
    const button = toolbar().querySelector(`[data-action="${name}"]`) as HTMLButtonElement
    button.dispatchEvent(Object.assign(new MouseEvent('click', { bubbles: true }), { isTrusted: true }))
  }

  it.each(['translate', 'define', 'explain', 'copy'] as const)('%s 只发送对应请求', async (action) => {
    await openToolbar()
    expect((await messages()).translate).toHaveLength(0)
    expect((await messages()).assist).toHaveLength(0)
    if (action === 'copy') {
      const writeText = vi.fn(async () => undefined)
      vi.stubGlobal('navigator', { clipboard: { writeText } })
      clickAction('copy')
      await settle(20)
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith(source)
      expect(toolbar().querySelector('[data-action="copy"]')?.textContent).toBe('已复制')
    } else {
      clickAction(action)
      await settle(20)
    }
    const sent = await messages()
    if (action === 'translate') {
      expect(sent.assist).toHaveLength(0)
      expect(sent.translate).toHaveLength(1)
      expect(sent.translate[0]).toMatchObject({ mode: 'selection', texts: [source] })
    } else if (action === 'define' || action === 'explain') {
      expect(sent.translate).toHaveLength(0)
      expect(sent.assist).toHaveLength(1)
      expect(sent.assist[0]).toMatchObject({ input: { text: source, requestedIntent: action } })
    } else {
      expect(sent.translate).toHaveLength(0)
      expect(sent.assist).toHaveLength(0)
    }
  })

  it('选区隐藏后迟到的复制成功不显示已复制', async () => {
    await openToolbar()
    let resolveCopy: () => void = () => undefined
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      resolveCopy = resolve
    }))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    clickAction('copy')
    expect(writeText).toHaveBeenCalledTimes(1)
    const paragraph = document.querySelector('p')
    if (!(paragraph instanceof HTMLElement)) throw new Error('missing paragraph')
    paragraph.hidden = true
    resolveCopy()
    await settle(20)
    expect(toolbar().style.display).not.toBe('none')
    expect(toolbar().querySelector('[data-action="copy"]')?.textContent).toBe('复制')
    expect(toolbar().querySelector('.toolbar-announcement')?.textContent).toBe('')
  })

  it('无模型时三模型按钮禁用但复制可用且不发模型消息', async () => {
    await openToolbar({ model: '', baseUrl: '' })
    expect((toolbar().querySelector('[data-action="translate"]') as HTMLButtonElement).disabled).toBe(true)
    expect((toolbar().querySelector('[data-action="define"]') as HTMLButtonElement).disabled).toBe(true)
    expect((toolbar().querySelector('[data-action="explain"]') as HTMLButtonElement).disabled).toBe(true)
    expect((toolbar().querySelector('[data-action="copy"]') as HTMLButtonElement).disabled).toBe(false)
    expect((toolbar().querySelector('[data-action="translate"]') as HTMLButtonElement).title).toBe(zhCN.wtToolbarConfigureHint)
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    clickAction('copy')
    await settle(20)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(source)
    const sent = await messages()
    expect(sent.translate).toHaveLength(0)
    expect(sent.assist).toHaveLength(0)
  })
})

describe('页面动作 url', () => {
  it('带旧 url 不改引擎和额度，当前 url 仍有效，未带 url 仍按原逻辑', async () => {
    document.body.innerHTML = '<p>English text here.</p>'
    await startPageTranslation()
    await settle(1200)
    expect(document.querySelector('p')?.textContent).toBe('译文')
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    const calls = (): number => vi.mocked(sendTranslationMessage).mock.calls.filter(([message]) => message.type === 'wt:translate').length
    const before = calls()
    expect(await triggerMessage({
      type: 'wt:page-action',
      action: 'restore',
      url: 'https://app.devin.ai/work/old',
    })).toEqual({ ok: false, error: '页面已变化' })
    expect(document.querySelector('p')?.textContent).toBe('译文')
    expect(calls()).toBe(before)
    expect(await triggerMessage({
      type: 'wt:page-action',
      action: 'restore',
      url: 'https://app.devin.ai/work/a#anchor',
    })).toEqual({ ok: true })
    expect(document.querySelector('p')?.textContent).toBe('English text here.')
    expect(calls()).toBe(before)
    expect(await triggerMessage({ type: 'wt:page-action', action: 'resume' })).toEqual({ ok: true })
    await settle(600)
    expect(document.querySelector('p')?.textContent).toBe('译文')
  })
})

describe('悬浮入口接线', () => {
  const FLOATING_MODES = {
    enabled: true,
    fixed: true,
    auto: false,
    selection: false,
    smart: false,
    floating: true,
    fixedEntries: { Settings: '设置' },
  }

  function entry(): HTMLElement | null {
    return rootShadow()?.querySelector('.floating-entry') ?? null
  }

  function shadowText(): string {
    return rootShadow()?.textContent ?? ''
  }

  function trustedClick(element: Element): void {
    element.dispatchEvent(Object.assign(new MouseEvent('click', { bubbles: true }), { isTrusted: true }))
  }

  async function sender(): Promise<ReturnType<typeof vi.mocked<(typeof import('../../../src/translation/client'))['sendTranslationMessage']>>> {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    return vi.mocked(sendTranslationMessage)
  }

  async function install(reply: (message: { type: string; action?: string }) => unknown): Promise<void> {
    const send = await sender()
    send.mockImplementation((async (message: { type: string; action?: string }) => reply(message)) as never)
  }

  async function boot(extra: Record<string, unknown> = {}, href = 'https://app.devin.ai/work/a'): Promise<void> {
    vi.stubGlobal('location', new URL(href))
    await translationConfigItem.setValue({ ...CONFIG, floatingButtonEnabled: true, ...extra })
    await startPageTranslation()
    await settle(500)
  }

  it('只有本地词库、没有模型时也显示入口', async () => {
    await install((message) => {
      if (message.type === 'wt:page-modes') return { ok: true, modes: { ...FLOATING_MODES, auto: false } }
      return { ok: true }
    })
    await boot({ baseUrl: '', model: '' })
    expect(entry()).not.toBeNull()
    expect(shadowText()).toContain(en.wtAssistConfigure)
    expect(document.documentElement.querySelector('[data-wt-root]')?.getAttribute('style')).toContain('display: block')
    const send = await sender()
    expect(send.mock.calls.filter(([message]) => message.type === 'wt:translate')).toHaveLength(0)
  })

  it('非 GitHub 打开菜单不发送模型或状态请求', async () => {
    await install((message) => {
      if (message.type === 'wt:page-modes') return { ok: true, modes: FLOATING_MODES }
      return { ok: true }
    })
    await boot()
    trustedClick(entry()!)
    await settle(50)
    expect(entry()?.getAttribute('aria-expanded')).toBe('true')
    const send = await sender()
    const types = send.mock.calls.map(([message]) => message.type)
    expect(types).not.toContain('wt:translate')
    expect(types).not.toContain('wt:assist')
    expect(types).not.toContain('wt:current-page-controls')
  })

  it('GitHub 打开菜单只查询状态', async () => {
    await install((message) => {
      if (message.type === 'wt:page-modes') return { ok: true, modes: FLOATING_MODES }
      if (message.type === 'wt:current-page-controls') return { ok: true, legacy: { active: false, paused: false } }
      return { ok: true }
    })
    await boot({}, 'https://github.com/vuejs/core')
    trustedClick(entry()!)
    await settle(50)
    const send = await sender()
    expect(send.mock.calls.filter(([message]) => message.type === 'wt:current-page-controls').map(([message]) => message)).toEqual([
      { type: 'wt:current-page-controls', action: 'status' },
    ])
    expect(send.mock.calls.filter(([message]) => message.type === 'wt:translate' || message.type === 'wt:assist')).toHaveLength(0)
  })

  it('菜单恢复原文不在本地再执行引擎', async () => {
    document.body.innerHTML = '<nav><button id="b">Settings</button></nav>'
    await install((message) => {
      if (message.type === 'wt:page-modes') return { ok: true, modes: FLOATING_MODES }
      if (message.type === 'wt:current-page-controls') return { ok: true, legacy: { active: false, paused: true } }
      return { ok: true }
    })
    await boot({}, 'https://github.com/vuejs/core')
    await settle(800)
    expect(document.querySelector('#b')?.textContent).toBe('设置')
    trustedClick(entry()!)
    await settle(50)
    const root = rootShadow()
    trustedClick(root?.querySelector('.floating-page') as HTMLButtonElement)
    await settle(100)
    expect(document.querySelector('#b')?.textContent).toBe('设置')
    const send = await sender()
    expect(send.mock.calls.filter(([message]) => message.type === 'wt:current-page-controls').map(([message]) => message)).toEqual([
      { type: 'wt:current-page-controls', action: 'status' },
      { type: 'wt:current-page-controls', action: 'restore' },
    ])
    expect(send.mock.calls.filter(([message]) => message.type === 'wt:translate')).toHaveLength(0)
  })

  it('关闭菜单后迟到的状态不重新打开', async () => {
    let release: (value: unknown) => void = () => undefined
    await install((message) => {
      if (message.type === 'wt:page-modes') return { ok: true, modes: { ...FLOATING_MODES, fixed: false } }
      if (message.type === 'wt:current-page-controls') return new Promise((resolve) => {
        release = resolve
      })
      return { ok: true }
    })
    await boot({}, 'https://github.com/vuejs/core')
    trustedClick(entry()!)
    trustedClick(entry()!)
    expect(entry()?.getAttribute('aria-expanded')).toBe('false')
    release({ ok: true, legacy: { active: true, paused: false } })
    await settle(50)
    expect(entry()?.getAttribute('aria-expanded')).toBe('false')
    expect(shadowText()).toContain(en.wtFloatingFixedOn)
  })

  it('范围、总开关或导航之后，迟到的状态和动作不更新', async () => {
    let releaseStatus: (value: unknown) => void = () => undefined
    let releaseAction: (value: unknown) => void = () => undefined
    let master = true
    await install((message) => {
      if (message.type === 'wt:page-modes') {
        return { ok: true, modes: { ...FLOATING_MODES, enabled: master } }
      }
      if (message.type === 'wt:current-page-controls' && message.action === 'status') {
        return new Promise((resolve) => {
          releaseStatus = resolve
        })
      }
      if (message.type === 'wt:current-page-controls') {
        return new Promise((resolve) => {
          releaseAction = resolve
        })
      }
      return { ok: true }
    })
    document.body.innerHTML = '<nav><button id="b">Settings</button></nav>'
    await boot({}, 'https://github.com/vuejs/core')
    await settle(800)
    trustedClick(entry()!)
    await translationConfigItem.setValue({
      ...CONFIG,
      floatingButtonEnabled: true,
      siteScopeMode: 'include',
      siteScopeHosts: ['other.example'],
    })
    await settle(200)
    releaseStatus({ ok: false, error: 'LATE_STATUS' })
    await settle(50)
    expect(entry()).toBeNull()
    expect(shadowText()).not.toContain('LATE_STATUS')

    await translationConfigItem.setValue({ ...CONFIG, floatingButtonEnabled: true })
    await settle(800)
    expect(document.querySelector('#b')?.textContent).toBe('设置')
    trustedClick(entry()!)
    await settle(20)
    releaseStatus({ ok: true, legacy: { active: false, paused: false } })
    await settle(20)
    const root = rootShadow()
    trustedClick(root?.querySelector('.floating-page') as HTMLButtonElement)
    master = false
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    await settle(200)
    releaseAction({ ok: false, error: 'LATE_ACTION' })
    await settle(50)
    expect(shadowText()).not.toContain('LATE_ACTION')
    expect(entry()?.getAttribute('aria-expanded') ?? 'false').toBe('false')

    master = true
    await settingsItem.setValue(DEFAULT_SETTINGS)
    await settle(500)
    trustedClick(entry()!)
    vi.stubGlobal('location', new URL('https://github.com/vuejs/core/other'))
    window.dispatchEvent(new Event('popstate'))
    await settle(200)
    releaseStatus({ ok: false, error: 'LATE_NAV' })
    await settle(50)
    expect(shadowText()).not.toContain('LATE_NAV')
    expect(entry()?.getAttribute('aria-expanded') ?? 'false').toBe('false')
  })

  it('界面语言和风格变化不发送模型请求', async () => {
    await install((message) => {
      if (message.type === 'wt:page-modes') return { ok: true, modes: FLOATING_MODES }
      return { ok: true }
    })
    await boot()
    const send = await sender()
    const modelCalls = (): number =>
      send.mock.calls.filter(([message]) => message.type === 'wt:translate' || message.type === 'wt:assist' || message.type === 'wt:current-page-controls').length
    const before = modelCalls()
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    await settle(200)
    expect(modelCalls()).toBe(before)
    expect(shadowText()).toContain(en.appName)
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en', uiStyle: 'glass' })
    await settle(200)
    expect(modelCalls()).toBe(before)
    expect(entry()?.getAttribute('data-style')).toBe('glass')
  })

  it('资格失效后隐藏入口', async () => {
    await install((message) => {
      if (message.type === 'wt:page-modes') return { ok: true, modes: FLOATING_MODES }
      return { ok: true }
    })
    await boot()
    expect(entry()).not.toBeNull()
    await translationConfigItem.setValue({ ...CONFIG, floatingButtonEnabled: true, excludedHosts: ['devin.ai'] })
    await settle(300)
    expect(entry()).toBeNull()
    await translationConfigItem.setValue({ ...CONFIG, floatingButtonEnabled: true, excludedHosts: [] })
    await settle(300)
    expect(entry()).not.toBeNull()
    vi.stubGlobal('location', new URL('http://localhost/secret'))
    window.dispatchEvent(new Event('popstate'))
    await settle(300)
    expect(entry()).toBeNull()
  })
})

describe('结果卡片复制', () => {
  function panelRoot(): ShadowRoot {
    return requireRootShadow()
  }

  function copyResultButton(): HTMLButtonElement | null {
    return panelRoot().querySelector('.panel-actions button.panel-copy[data-action="copy-result"]')
  }

  it('点击卡片复制调用 copySelectionText 并在成功后显示已复制', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-CN' })
    const { copySelectionText } = await import('../../../src/translation/clipboard')
    vi.mocked(copySelectionText).mockResolvedValueOnce(true)
    await startPageTranslation()
    await settle(100)
    await triggerMessage({ type: 'wt:show-selection', text: 'Physics term' })
    await settle(50)
    const button = copyResultButton()
    expect(button?.textContent).toBe('复制')
    button?.click()
    await settle(20)
    expect(copySelectionText).toHaveBeenCalledTimes(1)
    expect(copySelectionText).toHaveBeenCalledWith('译文')
    expect(copyResultButton()?.textContent).toBe('已复制')
    await settle(1500)
    expect(copyResultButton()?.textContent).toBe('复制')
  })

  it('复制 promise 在 panel.close 之后才 resolve 时不改任何文字', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'zh-CN' })
    const { copySelectionText } = await import('../../../src/translation/clipboard')
    let resolveCopy!: (copied: boolean) => void
    vi.mocked(copySelectionText).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        resolveCopy = resolve
      }),
    )
    await startPageTranslation()
    await settle(100)
    await triggerMessage({ type: 'wt:show-selection', text: 'Physics term' })
    await settle(50)
    copyResultButton()?.click()
    expect(copySelectionText).toHaveBeenCalledWith('译文')
    ;(panelRoot().querySelector('.panel-close') as HTMLButtonElement).click()
    const beforeCloseText = panelRoot().textContent
    resolveCopy(true)
    await settle(50)
    expect(panelRoot().textContent).toBe(beforeCloseText)
    expect(panelRoot().textContent).not.toContain('已复制')
  })
})

describe('快捷键选区读取与空选区提示', () => {
  it('wt:read-selection 返回 trim 后的页面选区、密码框返回空串、textarea 返回选区切片', async () => {
    document.body.innerHTML = '<p id="p">  Selected sentence  </p>'
    await startPageTranslation()
    await settle(100)

    const p = document.getElementById('p')!
    const range = document.createRange()
    range.selectNodeContents(p)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(await triggerMessage({ type: 'wt:read-selection' })).toEqual({
      ok: true,
      text: 'Selected sentence',
    })

    const password = document.createElement('input')
    password.type = 'password'
    password.value = 'secret-password'
    document.body.append(password)
    password.focus()
    expect(await triggerMessage({ type: 'wt:read-selection' })).toEqual({
      ok: true,
      text: '',
    })
    password.remove()

    const textarea = document.createElement('textarea')
    textarea.value = 'prefix  sliced words  suffix'
    document.body.append(textarea)
    textarea.focus()
    textarea.setSelectionRange(6, 22)
    expect(await triggerMessage({ type: 'wt:read-selection' })).toEqual({
      ok: true,
      text: 'sliced words',
    })
  })

  it('wt:show-selection 带 NO_SELECTION_ERROR 时显示本地化 wtNoSelection 通知且不发 wt:translate', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    await startPageTranslation()
    await settle(100)
    vi.mocked(sendTranslationMessage).mockClear()

    expect(await triggerMessage({ type: 'wt:show-selection', text: '', error: NO_SELECTION_ERROR })).toEqual({
      ok: true,
    })
    await settle(20)
    const root = requireRootShadow()
    expect(root.querySelector('.panel-status')?.textContent).toBe(en.wtNoSelection)
    expect(root.querySelector('.panel-actions button')).toBeNull()
    expect(vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate')).toHaveLength(0)
  })

  it('wt:show-selection 带 SENSITIVE_FRAME_ERROR 时显示本地化 wtSensitiveFrameUnsupported 通知且不发 wt:translate', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    await startPageTranslation()
    await settle(100)
    vi.mocked(sendTranslationMessage).mockClear()

    expect(await triggerMessage({ type: 'wt:show-selection', text: '', error: SENSITIVE_FRAME_ERROR })).toEqual({
      ok: true,
    })
    await settle(20)
    const root = requireRootShadow()
    expect(root.querySelector('.panel-status')?.textContent).toBe(en.wtSensitiveFrameUnsupported)
    expect(root.querySelector('.panel-actions button')).toBeNull()
    expect(vi.mocked(sendTranslationMessage).mock.calls.filter(([m]) => m.type === 'wt:translate')).toHaveLength(0)
  })

  it.each([
    [SENSITIVE_FRAME_ERROR, en.wtSensitiveFrameUnsupported],
    [NO_SELECTION_ERROR, en.wtNoSelection],
    ['未授权访问该站点', '未授权访问该站点'],
  ])('在途选区翻译期间收到 %s 时取消旧请求且不回写旧译文', async (errorCode, expectedNotice) => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    let capturedRequestId: string | undefined
    let resolveTranslate!: (value: unknown) => void
    vi.mocked(sendTranslationMessage).mockImplementation(((message: { type: string; requestId?: string; texts?: string[] }) => {
      if (message.type === 'wt:translate') {
        capturedRequestId = message.requestId
        return new Promise((resolve) => {
          resolveTranslate = resolve
        })
      }
      return defaultTransport(message)
    }) as never)
    await startPageTranslation()
    await settle(100)

    expect(
      await triggerMessage({
        type: 'wt:show-selection',
        text: 'Pending selection',
        manualSelectionId: 'manual-ticket-pending',
      }),
    ).toEqual({ ok: true })
    await settle(20)
    expect(capturedRequestId).toEqual(expect.any(String))

    expect(await triggerMessage({ type: 'wt:show-selection', text: '', error: errorCode })).toEqual({
      ok: true,
    })
    await settle(20)
    expect(vi.mocked(sendTranslationMessage)).toHaveBeenCalledWith({
      type: 'wt:cancel-assist',
      requestId: capturedRequestId,
    })

    resolveTranslate({ ok: true, texts: ['stale'] })
    await settle(50)
    const root = requireRootShadow()
    expect(root.querySelector('.panel-status')?.textContent).toBe(expectedNotice)
    expect(root.querySelector('.panel-target')).toBeNull()
    expect(root.querySelector('.panel-actions button')).toBeNull()
  })

  it('wt:show-selection 透传 manualSelectionId 到 wt:translate，普通选区不会继承旧 ticket', async () => {
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    await translationConfigItem.setValue({
      ...CONFIG,
      selectionPopupEnabled: true,
      selectionToolbarEnabled: true,
    })
    await startPageTranslation()
    await settle(100)
    vi.mocked(sendTranslationMessage).mockClear()

    expect(
      await triggerMessage({
        type: 'wt:show-selection',
        text: 'Manual frame selection',
        manualSelectionId: 'manual-ticket-xyz',
      }),
    ).toEqual({ ok: true })
    await settle(20)
    const translateCalls = () =>
      vi
        .mocked(sendTranslationMessage)
        .mock.calls.filter(([m]) => m.type === 'wt:translate')
        .map(([m]) => m as { type: string; texts?: string[]; manualSelectionId?: string })
    expect(translateCalls()).toHaveLength(1)
    expect(translateCalls()[0]).toMatchObject({
      type: 'wt:translate',
      texts: ['Manual frame selection'],
      manualSelectionId: 'manual-ticket-xyz',
    })

    // 普通页面选区通过工具栏触发翻译不应携带旧 manualSelectionId
    document.body.innerHTML = '<p id="plain">Plain top selection</p>'
    const node = document.getElementById('plain')!.firstChild!
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
    )
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
      () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
    )
    document.dispatchEvent(Object.assign(new PointerEvent('pointerup'), { isTrusted: true }))
    await settle(400)
    const root = requireRootShadow()
    const btn = root.querySelector('.selection-toolbar [data-action="translate"]') as HTMLButtonElement
    btn.dispatchEvent(Object.assign(new MouseEvent('click', { bubbles: true }), { isTrusted: true }))
    await settle(20)
    expect(translateCalls()).toHaveLength(2)
    expect(translateCalls()[1]?.texts).toEqual(['Plain top selection'])
    expect(translateCalls()[1]).not.toHaveProperty('manualSelectionId')
  })

  it.each([
    ['reply-first', TRANSLATION_CONFIG_CHANGED_ERROR, en.wtTranslationConfigChanged],
    ['reload-first', TRANSLATION_CONFIG_CHANGED_ERROR, en.wtTranslationConfigChanged],
    ['reply-first', TRANSLATION_PERMISSION_REMOVED_ERROR, en.wtTranslationPermissionRemoved],
  ] as const)(
    '在途手动选区翻译遇到设置变化（%s, %s）保留通知且不显示重试',
    async (order, error, expectedText) => {
      await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
      const { sendTranslationMessage } = await import('../../../src/translation/client')
      let resolveTranslate!: (value: unknown) => void
      vi.mocked(sendTranslationMessage).mockImplementation(((
        message: { type: string; manualSelectionId?: string; texts?: string[] },
      ) => {
        if (message.type === 'wt:translate' && message.manualSelectionId === 'ticket-config') {
          return new Promise((resolve) => {
            resolveTranslate = resolve
          })
        }
        return defaultTransport(message)
      }) as never)
      await startPageTranslation()
      await settle(100)

      expect(
        await triggerMessage({
          type: 'wt:show-selection',
          text: 'Pending manual text',
          manualSelectionId: 'ticket-config',
        }),
      ).toEqual({ ok: true })
      await settle(20)

      if (order === 'reply-first') {
        resolveTranslate({
          ok: false,
          code: 'cancelled',
          error,
        })
        await settle(20)
        await translationConfigItem.setValue({ ...CONFIG, targetLanguage: 'ja' })
        await settle(200)
      } else {
        await translationConfigItem.setValue({ ...CONFIG, targetLanguage: 'ja' })
        await settle(200)
        resolveTranslate({
          ok: false,
          code: 'cancelled',
          error,
        })
        await settle(20)
      }

      const root = requireRootShadow()
      expect((root.querySelector('.panel') as HTMLElement).style.display).not.toBe('none')
      expect(root.querySelector('.panel-status')?.textContent).toBe(expectedText)
      expect(root.querySelector('.panel-target')).toBeNull()
      expect(root.querySelector('.panel-actions button')).toBeNull()
    },
  )

  it('在途手动选区先关闭面板再重装保持关闭；无票据在途选区遇设置变化直接关闭', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    const { sendTranslationMessage } = await import('../../../src/translation/client')
    vi.mocked(sendTranslationMessage).mockImplementation(((
      message: { type: string; mode?: string; texts?: string[] },
    ) => {
      if (message.type === 'wt:translate' && message.mode === 'selection') {
        return new Promise(() => undefined)
      }
      return defaultTransport(message)
    }) as never)
    await startPageTranslation()
    await settle(100)

    expect(
      await triggerMessage({
        type: 'wt:show-selection',
        text: 'Pending manual text',
        manualSelectionId: 'ticket-config',
      }),
    ).toEqual({ ok: true })
    await settle(20)
    const root = requireRootShadow()
    expect((root.querySelector('.panel') as HTMLElement).style.display).not.toBe('none')
    ;(root.querySelector('.panel-close') as HTMLButtonElement).click()
    expect((root.querySelector('.panel') as HTMLElement).style.display).toBe('none')

    await translationConfigItem.setValue({ ...CONFIG, targetLanguage: 'ja' })
    await settle(200)
    expect((root.querySelector('.panel') as HTMLElement).style.display).toBe('none')

    expect(
      await triggerMessage({
        type: 'wt:show-selection',
        text: 'Plain pending selection',
      }),
    ).toEqual({ ok: true })
    await settle(20)
    expect((root.querySelector('.panel') as HTMLElement).style.display).not.toBe('none')

    await translationConfigItem.setValue({ ...CONFIG, targetLanguage: 'en' })
    await settle(200)
    expect((root.querySelector('.panel') as HTMLElement).style.display).toBe('none')
  })

  it.each([
    ['temperature', { temperature: 0.4 }],
    ['customHeadersRevision', { customHeadersRevision: '11111111-1111-4111-8111-111111111111' }],
  ] as const)(
    '在途手动选区翻译期间修改 %s 同样保留设置变化通知且重译自动段落',
    async (_field, change) => {
      await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
      const { sendTranslationMessage } = await import('../../../src/translation/client')
      let resolveManual!: (value: unknown) => void
      vi.mocked(sendTranslationMessage).mockImplementation(((
        message: { type: string; manualSelectionId?: string; texts?: string[] },
      ) => {
        if (message.type === 'wt:translate' && message.manualSelectionId === 'ticket-adv') {
          return new Promise((resolve) => {
            resolveManual = resolve
          })
        }
        return defaultTransport(message)
      }) as never)
      document.body.innerHTML = '<p>English text here.</p>'
      await startPageTranslation()
      await settle(1200)
      expect(document.querySelector('p')?.textContent).toBe('译文')

      expect(
        await triggerMessage({
          type: 'wt:show-selection',
          text: 'Pending manual text',
          manualSelectionId: 'ticket-adv',
        }),
      ).toEqual({ ok: true })
      await settle(20)

      await translationConfigItem.setValue({ ...CONFIG, ...change })
      await settle(200)
      resolveManual({
        ok: false,
        code: 'cancelled',
        error: TRANSLATION_CONFIG_CHANGED_ERROR,
      })
      await settle(600)

      const root = requireRootShadow()
      expect((root.querySelector('.panel') as HTMLElement).style.display).not.toBe('none')
      expect(root.querySelector('.panel-status')?.textContent).toBe(en.wtTranslationConfigChanged)
      expect(document.querySelector('p')?.textContent).toBe('译文')
    },
  )
})
