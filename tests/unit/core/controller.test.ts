// @vitest-environment-options { "url": "https://github.com/vuejs/core/issues" }
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createController, type Controller, type ResetReason } from '../../../src/core/controller'
import type { LocaleBundle } from '../../../src/core/types'
import zhCnTime from '../../../src/locales/zh-CN/common-ui/time'
import type { Settings } from '../../../src/shared/settings'
import { $, settle, TEST_BUNDLE } from './helpers'
import { defineFakeRelativeTime, settleTime } from './time-element'

const HOME = '/vuejs/core/issues'
const SETTINGS: Settings = {
  enabled: true,
  translateTime: true,
  translateTitle: true,
  excludedPaths: [],
  language: 'auto',
  uiLanguage: 'auto',
  theme: 'auto',
  uiStyle: 'classic',
}

/** 简化的排除规则：前缀匹配（正式实现见 shared/settings） */
function isPathExcluded(pathname: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pathname === pattern || pathname.startsWith(`${pattern}/`))
}

let controller: Controller | undefined
const onReset = vi.fn()
const onActiveChange = vi.fn()

function create(
  html: string,
  settings: Partial<Settings> = {},
  customEntries: Record<string, string> = {},
  bundle: LocaleBundle = TEST_BUNDLE,
): Controller {
  document.head.innerHTML = '<title>Issues · vuejs/core</title>'
  document.body.innerHTML = html
  controller = createController({
    bundle,
    settings: { ...SETTINGS, ...settings },
    customEntries,
    isPathExcluded,
    onReset,
    onActiveChange,
    host: window,
  })
  return controller
}

afterEach(() => {
  controller?.dispose()
  controller = undefined
  onReset.mockClear()
  onActiveChange.mockClear()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  history.replaceState(null, '', HOME)
})

describe('createController', () => {
  it('启用且未排除时立即翻译', () => {
    const c = create('<button aria-label="Copy">Issues</button>')
    expect(c.translator.active).toBe(true)
    expect($('button').textContent).toBe('议题')
    expect(document.title).toBe('议题 · vuejs/core')
  })

  it('总开关关闭时不翻译，切换开关时还原与重译', () => {
    const c = create('<p>Issues</p>', { enabled: false })
    expect(c.translator.active).toBe(false)
    expect($('p').textContent).toBe('Issues')
    c.updateSettings({ ...SETTINGS })
    expect($('p').textContent).toBe('议题')
    c.updateSettings({ ...SETTINGS, enabled: false })
    expect($('p').textContent).toBe('Issues')
    expect(document.title).toBe('Issues · vuejs/core')
  })

  it('命中排除路径时不翻译；离开排除路径后开始翻译', async () => {
    const c = create('<p>Issues</p><main></main>', { excludedPaths: ['/vuejs/core/issues'] })
    expect(c.translator.active).toBe(false)
    history.pushState(null, '', '/vuejs/core/pulls')
    $('main').append(document.createElement('i'))
    await settle()
    expect(c.translator.active).toBe(true)
    expect($('p').textContent).toBe('议题')
  })

  it('软导航进入排除路径时停止并还原', async () => {
    const c = create('<p>Issues</p><main></main>', { excludedPaths: ['/settings'] })
    expect($('p').textContent).toBe('议题')
    history.pushState(null, '', '/settings/profile')
    $('main').append(document.createElement('i'))
    await settle()
    expect(c.translator.active).toBe(false)
    expect($('p').textContent).toBe('Issues')
    history.pushState(null, '', '/vuejs/core/issues')
    window.dispatchEvent(new Event('popstate'))
    expect(c.translator.active).toBe(true)
    expect($('p').textContent).toBe('议题')
  })

  it('修改排除路径立即生效', () => {
    const c = create('<p>Issues</p>')
    c.updateSettings({ ...SETTINGS, excludedPaths: ['/vuejs/core'] })
    expect(c.translator.active).toBe(false)
    expect($('p').textContent).toBe('Issues')
  })

  it('功能开关传给引擎', () => {
    const c = create('<relative-time></relative-time>')
    c.updateSettings({ ...SETTINGS, translateTitle: false, translateTime: false })
    expect(document.title).toBe('Issues · vuejs/core')
    expect($('relative-time').hasAttribute('lang')).toBe(false)
    expect(c.translator.features).toMatchObject({ translateTime: false, translateTitle: false })
  })

  it('不收集未翻译文本：引擎的诊断收集保持关闭', async () => {
    const c = create('<p>Issues</p><p>Hello world</p>')
    c.updateSettings({ ...SETTINGS, translateTitle: false })
    document.body.insertAdjacentHTML('beforeend', '<p>Another phrase</p>')
    await settle()
    expect(c.translator.features.collectUntranslated).toBe(false)
    expect(c.translator.drainUntranslated()).toEqual([])
  })

  it('自定义词条变化时重译', () => {
    const c = create('<p>Issues</p>', {}, { Issues: '问题' })
    expect($('p').textContent).toBe('问题')
    c.updateCustomEntries({})
    expect($('p').textContent).toBe('议题')
  })

  it('checkLocation 在页面类型变化时重译', () => {
    const c = create('<b>Open</b>')
    expect($('b').textContent).toBe('未解决')
    history.pushState(null, '', '/vuejs/core/pulls')
    c.checkLocation()
    expect($('b').textContent).toBe('开启中')
  })

  it('处理 popup 消息', () => {
    const c = create('<p>Issues</p><p>Hello world</p><p>Hello world</p>', { excludedPaths: ['/other'] })
    expect(c.getStatus()).toEqual({
      active: true,
      excluded: false,
      pages: ['common', 'repository', 'issues'],
      translatedCount: 2,
    })
  })

  it('排除时的状态', () => {
    const c = create('<p>Issues</p>', { excludedPaths: ['/vuejs'] })
    expect(c.getStatus()).toEqual({
      active: false,
      excluded: true,
      pages: ['common', 'repository', 'issues'],
      translatedCount: 0,
    })
  })

  it('dispose 后还原且不再响应', async () => {
    const c = create('<p>Issues</p>')
    c.dispose()
    c.dispose()
    expect($('p').textContent).toBe('Issues')
    c.updateSettings({ ...SETTINGS })
    c.updateCustomEntries({ Issues: '问题' })
    c.checkLocation()
    document.body.append(document.createElement('i'))
    await settle()
    expect(c.translator.active).toBe(false)
    expect($('p').textContent).toBe('Issues')
  })

  it('自定义词条没变时不重建匹配器（不整页重新遍历）', () => {
    const c = create('<p>Issues</p>', {}, { Issues: '问题' })
    const setMatcher = vi.spyOn(c.translator, 'setMatcher')
    c.updateCustomEntries({ Issues: '问题' })
    expect(setMatcher).not.toHaveBeenCalled()
    c.updateCustomEntries({ Issues: '事项' })
    expect(setMatcher).toHaveBeenCalledTimes(1)
    expect($('p').textContent).toBe('事项')
    c.updateCustomEntries({ Issues: '事项', Pulls: '拉取' })
    c.updateCustomEntries({ Pulls: '拉取' })
    expect(setMatcher).toHaveBeenCalledTimes(3)
    expect($('p').textContent).toBe('议题')
  })
})

describe('updateLocale', () => {
  const TW_BUNDLE: LocaleBundle = [['common', { static: { Issues: '議題' } }]]

  it('换用新语言包重译；自定义词条仍优先；翻译中通知重置', () => {
    const c = create('<p>Issues</p><p>Pull requests</p>', {}, { 'Pull requests': '合并请求' })
    c.updateLocale(TW_BUNDLE, 'zh-TW')
    expect($('p').textContent).toBe('議題')
    expect($('p:last-child').textContent).toBe('合并请求')
    expect(onReset).toHaveBeenCalledWith('change')
  })

  it('之后更新自定义词条：沿用新语言包', () => {
    const c = create('<p>Issues</p>')
    c.updateLocale(TW_BUNDLE, 'zh-TW')
    c.updateCustomEntries({ Search: '搜尋' })
    expect($('p').textContent).toBe('議題')
  })

  it('同一语言包、未在翻译、已销毁：不重译、不通知', () => {
    const c = create('<p>Issues</p>')
    c.updateLocale(TEST_BUNDLE, 'zh-CN')
    expect(onReset).not.toHaveBeenCalled()

    c.updateSettings({ ...SETTINGS, enabled: false })
    onReset.mockClear()
    c.updateLocale(TW_BUNDLE, 'zh-TW')
    expect(onReset).not.toHaveBeenCalled()
    expect($('p').textContent).toBe('Issues')
    // 恢复翻译：缓存里的简体译文已过时，启动后补发一次
    c.updateSettings(SETTINGS)
    expect($('p').textContent).toBe('議題')
    expect(onReset.mock.calls).toEqual([['change']])

    c.dispose()
    controller = undefined
    onReset.mockClear()
    c.updateLocale(TEST_BUNDLE, 'zh-CN')
    expect(onReset).not.toHaveBeenCalled()
    expect($('p').textContent).toBe('Issues')
  })
})

describe('onReset（Turbo 缓存克隆体）', () => {
  it.each<[string, (c: Controller) => void]>([
    ['词条', (c) => c.updateCustomEntries({ Issues: '问题' })],
    ['时间本地化开关', (c) => c.updateSettings({ ...SETTINGS, enabled: false, translateTime: false })],
    ['语言包', (c) => c.updateLocale([['common', { static: { Issues: '議題' } }]], 'zh-TW')],
  ])('停止翻译期间换了%s：恢复翻译、启动后补发一次', (_name, act) => {
    const c = create('<p>Issues</p>')
    c.updateSettings({ ...SETTINGS, enabled: false })
    onReset.mockClear()
    act(c)
    expect(onReset).not.toHaveBeenCalled()
    const order: string[] = []
    onActiveChange.mockImplementation(() => order.push('active'))
    onReset.mockImplementation(() => order.push('reset'))
    c.updateSettings({ ...SETTINGS, translateTime: c.translator.active ? SETTINGS.translateTime : false })
    expect(order).toEqual(['active', 'reset'])
    // 只补发一次
    c.updateSettings({ ...SETTINGS, enabled: false })
    c.updateSettings({ ...SETTINGS })
    expect(onReset.mock.calls.filter(([reason]) => reason === 'change')).toHaveLength(2)
    onActiveChange.mockReset()
    onReset.mockReset()
  })

  it('从未翻译过（排除路径上启动）：停止期间的变化不补发', () => {
    const c = create('<p>Issues</p>', { excludedPaths: ['/vuejs/core'] })
    c.updateCustomEntries({ Issues: '问题' })
    c.updateSettings(SETTINGS)
    expect(c.translator.active).toBe(true)
    expect(onReset).not.toHaveBeenCalled()
  })

  it.each<[string, (c: Controller) => void, ResetReason]>([
    ['停用', (c) => c.updateSettings({ ...SETTINGS, enabled: false }), 'change'],
    ['排除路径设置命中当前页', (c) => c.updateSettings({ ...SETTINGS, excludedPaths: ['/vuejs/core'] }), 'change'],
    ['词条有变化', (c) => c.updateCustomEntries({ Issues: '问题' }), 'change'],
    ['时间本地化开关变化', (c) => c.updateSettings({ ...SETTINGS, translateTime: false }), 'change'],
    ['dispose', (c) => c.dispose(), 'dispose'],
  ])('翻译中%s：通知一次，带上原因', (_name, act, reason) => {
    const c = create('<p>Issues</p>')
    act(c)
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith(reason)
  })

  it('软导航进入排除路径：停止并通知', async () => {
    create('<p>Issues</p><main></main>', { excludedPaths: ['/settings'] })
    history.pushState(null, '', '/settings/profile')
    $('main').append(document.createElement('i'))
    await settle()
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('change')
  })

  it('停用并同时改时间开关：只通知一次', () => {
    const c = create('<p>Issues</p>')
    c.updateSettings({ ...SETTINGS, enabled: false, translateTime: false })
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('启用并同时改时间开关（同一次更新，如往返缓存恢复后补读设置）：不通知', () => {
    const c = create('<p>Issues</p>', { enabled: false, translateTime: false })
    c.updateSettings({ ...SETTINGS })
    expect(c.translator.active).toBe(true)
    expect(onReset).not.toHaveBeenCalled()
  })

  it('离开排除路径并同时改时间开关：不通知', () => {
    const c = create('<p>Issues</p>', { excludedPaths: ['/vuejs/core'], translateTime: false })
    c.updateSettings({ ...SETTINGS })
    expect(c.translator.active).toBe(true)
    expect(onReset).not.toHaveBeenCalled()
  })

  it.each<[string, (c: Controller) => void]>([
    ['词条相同', (c) => c.updateCustomEntries({})],
    ['只改标题开关', (c) => c.updateSettings({ ...SETTINGS, translateTitle: false })],
    [
      '页面类型变化',
      (c) => {
        history.pushState(null, '', '/vuejs/core/pulls')
        c.checkLocation()
      },
    ],
  ])('%s：不通知', (_name, act) => {
    const c = create('<p>Issues</p>')
    act(c)
    expect(onReset).not.toHaveBeenCalled()
  })

  it('未在翻译时（已停用）：启用、改词条、改时间开关、dispose 都不通知', () => {
    const c = create('<p>Issues</p>', { enabled: false })
    c.updateCustomEntries({ Issues: '问题' })
    c.updateSettings({ ...SETTINGS, enabled: false, translateTime: false })
    c.dispose()
    expect(onReset).not.toHaveBeenCalled()
    const d = create('<p>Issues</p>', { enabled: false })
    d.updateSettings({ ...SETTINGS })
    expect(onReset).not.toHaveBeenCalled()
  })
})

describe('onActiveChange（实例标记）', () => {
  /** 各次通知的参数 */
  function changes(): boolean[] {
    return onActiveChange.mock.calls.map(([active]) => active as boolean)
  }

  it('启动、停止时各通知一次；状态没变时不通知', () => {
    const c = create('<p>Issues</p>')
    expect(changes()).toEqual([true])
    c.updateSettings({ ...SETTINGS, translateTitle: false })
    c.updateCustomEntries({ Issues: '问题' })
    expect(changes()).toEqual([true])
    c.updateSettings({ ...SETTINGS, enabled: false })
    c.updateSettings({ ...SETTINGS, enabled: false, translateTime: false })
    expect(changes()).toEqual([true, false])
    c.updateSettings({ ...SETTINGS })
    expect(changes()).toEqual([true, false, true])
    c.dispose()
    c.dispose()
    expect(changes()).toEqual([true, false, true, false])
  })

  it('先通知停止，再通知重置', () => {
    const c = create('<p>Issues</p>')
    c.updateSettings({ ...SETTINGS, enabled: false })
    expect(onActiveChange.mock.invocationCallOrder[1]).toBeLessThan(onReset.mock.invocationCallOrder[0]!)
  })

  it('软导航进出排除路径时通知', async () => {
    create('<p>Issues</p><main></main>', { excludedPaths: ['/settings'] })
    history.pushState(null, '', '/settings/profile')
    $('main').append(document.createElement('i'))
    await settle()
    expect(changes()).toEqual([true, false])
    history.pushState(null, '', HOME)
    window.dispatchEvent(new Event('popstate'))
    expect(changes()).toEqual([true, false, true])
  })

  it('一开始就停用或排除：不通知', () => {
    create('<p>Issues</p>', { enabled: false }).dispose()
    create('<p>Issues</p>', { excludedPaths: ['/vuejs/core'] }).dispose()
    expect(onActiveChange).not.toHaveBeenCalled()
  })
})

/**
 * 改了系统时区、页面不刷新（Node 改 TZ 时重设默认时区，同 Chrome）。
 * 假时间元素注册后对整个文件生效：放在最后，前面的用例按未定义的 relative-time 处理
 */
describe('本地时区变化', () => {
  /** 测试词典加上完整时间的词条 */
  const ZONE_BUNDLE: LocaleBundle = [...TEST_BUNDLE, ['common', zhCnTime]]
  const FULL_TIME = 'Oct 26, 2026, 10:03 AM GMT+8'
  const LOCAL_TIME = '2026 年 10 月 26 日 10:03'
  const OTHER_ZONE_TIME = '2026 年 10 月 26 日 10:03 (GMT+8)'

  beforeAll(defineFakeRelativeTime)

  afterEach(() => {
    process.env.TZ = 'Asia/Shanghai'
    vi.restoreAllMocks()
  })

  it('窗口获得焦点时发现时区变了：重建匹配器，完整时间的文字与属性按新时区重译；通知重置', () => {
    create(`<p title="${FULL_TIME}">${FULL_TIME}</p>`, {}, {}, ZONE_BUNDLE)
    expect($('p').textContent).toBe(LOCAL_TIME)

    process.env.TZ = 'Asia/Tokyo'
    window.dispatchEvent(new Event('focus'))

    expect($('p').textContent).toBe(OTHER_ZONE_TIME)
    expect($('p').getAttribute('title')).toBe(OTHER_ZONE_TIME)
    expect(onReset.mock.calls).toEqual([['change']])
  })

  it('时区没变：获得焦点、页面重新可见不重建匹配器、不通知', () => {
    const c = create('<p>Issues</p>')
    const setMatcher = vi.spyOn(c.translator, 'setMatcher')

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))

    expect(setMatcher).not.toHaveBeenCalled()
    expect(onReset).not.toHaveBeenCalled()
  })

  it('翻译中（引擎与控制器各有一个监听）：一次事件只读一次探针', () => {
    create('<p>Issues</p>')
    const intl = vi.spyOn(Intl, 'DateTimeFormat')
    const offset = vi.spyOn(Date.prototype, 'getTimezoneOffset')

    window.dispatchEvent(new Event('focus'))

    expect(intl).toHaveBeenCalledTimes(1)
    expect(offset).toHaveBeenCalledTimes(2)
  })

  it('重建的匹配器沿用当前语言包与自定义词条', () => {
    const c = create(`<p>${FULL_TIME}</p><b>Issues</b><i>Search</i>`, {}, { Search: '查找' }, ZONE_BUNDLE)
    c.updateLocale(
      [
        ['common', { static: { Issues: '議題' } }],
        ['common', zhCnTime],
      ],
      'zh-CN',
    )

    process.env.TZ = 'Asia/Tokyo'
    document.dispatchEvent(new Event('visibilitychange'))

    expect($('p').textContent).toBe(OTHER_ZONE_TIME)
    expect($('b').textContent).toBe('議題')
    expect($('i').textContent).toBe('查找')
  })

  it('停止翻译期间时区变了：恢复翻译时按新时区翻译，启动后补发重置', () => {
    const c = create(`<p>${FULL_TIME}</p>`, {}, {}, ZONE_BUNDLE)
    c.updateSettings({ ...SETTINGS, enabled: false })
    onReset.mockClear()

    process.env.TZ = 'Asia/Tokyo'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(onReset).not.toHaveBeenCalled()
    expect($('p').textContent).toBe(FULL_TIME)
    c.updateSettings({ ...SETTINGS })

    expect($('p').textContent).toBe(OTHER_ZONE_TIME)
    expect(onReset.mock.calls).toEqual([['change']])
  })

  it.each<[string, (c: Controller) => void]>([
    [
      '进出排除路径',
      (c) => {
        history.pushState(null, '', '/settings/profile')
        c.checkLocation()
        history.pushState(null, '', HOME)
        c.checkLocation()
      },
    ],
    [
      '停用再启用',
      (c) => {
        c.updateSettings({ ...SETTINGS, excludedPaths: ['/settings'], enabled: false })
        c.updateSettings({ ...SETTINGS, excludedPaths: ['/settings'] })
      },
    ],
  ])('改了时区、还没派发事件就%s：恢复翻译时按新时区翻译，与时间元素一致；启动后补发重置', async (_name, restart) => {
    const c = create(
      `<p title="${FULL_TIME}">${FULL_TIME}</p><relative-time datetime="2026-10-26T02:03:00Z"></relative-time>`,
      { excludedPaths: ['/settings'] },
      {},
      ZONE_BUNDLE,
    )
    await settleTime()

    process.env.TZ = 'Asia/Tokyo'
    restart(c)
    await settleTime()

    expect($('p').textContent).toBe(OTHER_ZONE_TIME)
    expect($('p').getAttribute('title')).toBe(OTHER_ZONE_TIME)
    expect($('relative-time').getAttribute('title')).toBe('2026 年 10 月 26 日 GMT+8 10:03')
    // 停止时通知一次，恢复翻译后补发一次
    expect(onReset.mock.calls).toEqual([['change'], ['change']])
    // 已按新时区重建：之后的事件不再重建
    const setMatcher = vi.spyOn(c.translator, 'setMatcher')
    window.dispatchEvent(new Event('focus'))
    expect(setMatcher).not.toHaveBeenCalled()
  })

  it('从未翻译过（停用启动）：改了时区、还没派发事件就启用，按新时区翻译，不通知重置', () => {
    const c = create(`<p>${FULL_TIME}</p>`, { enabled: false }, {}, ZONE_BUNDLE)

    process.env.TZ = 'Asia/Tokyo'
    c.updateSettings({ ...SETTINGS })

    expect($('p').textContent).toBe(OTHER_ZONE_TIME)
    expect(onReset).not.toHaveBeenCalled()
  })

  it('dispose 后不再响应', () => {
    const c = create(`<p>${FULL_TIME}</p>`, {}, {}, ZONE_BUNDLE)
    const setMatcher = vi.spyOn(c.translator, 'setMatcher')
    c.dispose()
    onReset.mockClear()

    process.env.TZ = 'Asia/Tokyo'
    window.dispatchEvent(new Event('focus'))

    expect(setMatcher).not.toHaveBeenCalled()
    expect(onReset).not.toHaveBeenCalled()
  })

  it('时间元素改写过的 title 与普通文本一并按新时区：元素仍按旧时区生成时保留时区', async () => {
    create(`<p>${FULL_TIME}</p><relative-time datetime="2026-10-26T02:03:00Z"></relative-time>`, {}, {}, ZONE_BUNDLE)
    await settleTime()
    expect($('relative-time').getAttribute('title')).toBe(LOCAL_TIME)

    process.env.TZ = 'Asia/Tokyo'
    window.dispatchEvent(new Event('focus'))
    await settleTime()

    expect($('p').textContent).toBe(OTHER_ZONE_TIME)
    expect($('relative-time').getAttribute('title')).toBe('2026 年 10 月 26 日 GMT+8 10:03')
  })
})
