import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  DEFAULT_SETTINGS,
  addExcludedPath,
  canExcludePath,
  customEntriesItem,
  getCustomEntries,
  getSettings,
  excludedPathProbe,
  isPathExcluded,
  matchExcludedPath,
  mergeSettings,
  parseExcludedPaths,
  removeExcludedPath,
  sanitizeCustomEntries,
  setCustomEntries,
  settingsItem,
  updateSettings,
  watchCustomEntries,
  watchSettings,
} from '../../../src/shared/settings'

beforeEach(() => {
  fakeBrowser.reset()
})

describe('mergeSettings', () => {
  it.each([undefined, null, 'x', 1, true])('非对象 %s → 默认值', (input) => {
    expect(mergeSettings(input)).toEqual(DEFAULT_SETTINGS)
  })

  it('保留合法字段，补齐缺失字段', () => {
    expect(mergeSettings({ enabled: false, excludedPaths: ['/settings'] })).toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
      excludedPaths: ['/settings'],
    })
  })

  it('丢弃类型不符的字段', () => {
    expect(
      mergeSettings({
        enabled: 'no',
        translateTime: 0,
        translateTitle: false,
        excludedPaths: ['/a', 1],
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, translateTitle: false })
  })

  it('忽略未知字段（含旧版本的 collectUntranslated）', () => {
    const merged = mergeSettings({ enabled: false, collectUntranslated: false, unknown: 1 })
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, enabled: false })
    expect(Object.hasOwn(merged, 'collectUntranslated')).toBe(false)
  })

  it('excludedPaths 不是数组时用默认值', () => {
    expect(mergeSettings({ excludedPaths: '/a' }).excludedPaths).toEqual([])
  })

  it('语言与外观：默认自动；保留合法取值，非法取值用默认值', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ language: 'auto', uiLanguage: 'auto', theme: 'auto' })
    expect(mergeSettings({ language: 'zh-TW', uiLanguage: 'en', theme: 'dark' })).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'zh-TW',
      uiLanguage: 'en',
      theme: 'dark',
    })
    expect(mergeSettings({ language: 'en', uiLanguage: 'zz', theme: 'neon' })).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings({ language: null, uiLanguage: 1, theme: ['dark'] })).toEqual(DEFAULT_SETTINGS)
  })
})

describe('sanitizeCustomEntries', () => {
  it.each([undefined, null, 'x', ['a', 'b']])('非对象 %s → 空对象', (input) => {
    expect(sanitizeCustomEntries(input)).toEqual({})
  })

  it('过滤非字符串值与空键空值', () => {
    expect(sanitizeCustomEntries({ Issues: '议题', ' ': '空', Empty: '  ', Count: 3, Pulls: '拉取请求' })).toEqual({
      Issues: '议题',
      Pulls: '拉取请求',
    })
  })
})

describe('isPathExcluded', () => {
  it.each([
    ['/settings', ['/settings'], true],
    ['/settings/profile', ['/settings'], true],
    ['/settingsx', ['/settings'], false],
    ['/vuejs/core/wiki', ['/*/*/wiki'], true],
    ['/vuejs/core/wiki/Home', ['/*/*/wiki'], true],
    ['/vuejs/wiki', ['/*/*/wiki'], false],
    ['/a/b/c/wiki', ['/**/wiki'], true],
    ['/Settings', ['/settings'], true],
    ['/settings', ['/settings/'], true],
    ['/settings', ['  /settings  '], true],
    ['/settings', ['settings'], false],
    ['/a.b', ['/a.b'], true],
    ['/aXb', ['/a.b'], false],
    ['/anything', [], false],
  ])('%s 对 %j → %s', (pathname, patterns, expected) => {
    expect(isPathExcluded(pathname, patterns)).toBe(expected)
  })
})

describe('matchExcludedPath', () => {
  it.each([
    // 第一条命中规则；规则按顺序判断
    ['/settings/profile', ['/settings', '/settings/profile'], '/settings'],
    ['/a/b', ['/a/**', '/a/b'], '/a/**'],
    // * 单段、** 任意层级、大小写不敏感、命中规则及下级路径
    ['/vuejs/core/wiki/Home', ['/*/*/wiki'], '/*/*/wiki'],
    ['/a/b/c/wiki', ['/**/wiki'], '/**/wiki'],
    ['/Settings', ['  /settings  '], '/settings'],
    ['/anything', ['/**'], '/**'],
    // 不以 / 开头的规则忽略
    ['/a', ['a', '/a'], '/a'],
  ])('%s 对 %j → %s', (pathname, patterns, expected) => {
    expect(matchExcludedPath(pathname, patterns)).toBe(expected)
  })

  it('未命中返回 undefined', () => {
    expect(matchExcludedPath('/y', ['/x'])).toBeUndefined()
    expect(matchExcludedPath('/anything', [])).toBeUndefined()
    expect(matchExcludedPath('/anything', ['settings'])).toBeUndefined()
  })
})

describe('excludedPathProbe', () => {
  it.each([
    // / 开头：按路径处理，去查询与片段，空格按浏览器规则编码
    ['/a/b?x=1#y', '/a/b'],
    ['//x', '//x'],
    ['/foo bar', '/foo%20bar'],
    ['  /a/b?x=1#y  ', '/a/b'],
    // GitHub 网址（https、主机大小写不敏感）
    ['https://github.com/o/r/wiki', '/o/r/wiki'],
    ['HTTPS://GIST.GITHUB.COM/u/1', '/u/1'],
    // 非 GitHub 站点、http 协议、无法识别的输入
    ['http://github.com/x', undefined],
    ['https://example.com/x', undefined],
    ['foo', undefined],
    ['', undefined],
    ['   ', undefined],
  ])('%s → %s', (input, expected) => {
    expect(excludedPathProbe(input)).toBe(expected)
  })
})

describe('parseExcludedPaths', () => {
  it('按行解析，去空行、首尾空白与重复', () => {
    expect(parseExcludedPaths(' /settings \r\n\n/*/*/wiki\n/settings\n')).toEqual({
      paths: ['/settings', '/*/*/wiki'],
      invalid: [],
    })
  })

  it('不以 / 开头的行列为无效', () => {
    expect(parseExcludedPaths('/ok\nsettings\n*/wiki')).toEqual({ paths: ['/ok'], invalid: ['settings', '*/wiki'] })
  })

  it('空文本', () => {
    expect(parseExcludedPaths('')).toEqual({ paths: [], invalid: [] })
  })
})

describe('排除此页 / 取消排除', () => {
  it('根路径不可排除', () => {
    expect(canExcludePath('/')).toBe(false)
    expect(canExcludePath('')).toBe(false)
    expect(canExcludePath('/vuejs/core')).toBe(true)
  })

  it('加入当前路径，去掉末尾斜杠', () => {
    expect(addExcludedPath(['/settings'], '/vuejs/core/')).toEqual(['/settings', '/vuejs/core'])
  })

  it('已命中或根路径时原样返回', () => {
    const patterns = ['/vuejs']
    expect(addExcludedPath(patterns, '/vuejs/core')).toBe(patterns)
    expect(addExcludedPath(patterns, '/')).toBe(patterns)
  })

  it('移除所有命中当前路径的规则', () => {
    expect(removeExcludedPath(['/vuejs', '/*/*/wiki', '/settings', '/vuejs/core'], '/vuejs/core')).toEqual([
      '/*/*/wiki',
      '/settings',
    ])
  })
})

describe('存储读写', () => {
  it('无存储值时返回默认设置', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('updateSettings 合并写入', async () => {
    await settingsItem.setValue({ translateTime: false })
    const next = await updateSettings({ enabled: false })
    expect(next).toEqual({ ...DEFAULT_SETTINGS, enabled: false, translateTime: false })
    expect(await settingsItem.getValue()).toEqual({ ...next, collectUntranslated: false })
  })

  it.each<[string, Record<string, unknown>]>([
    ['开启', { collectUntranslated: true }],
    ['关闭', { collectUntranslated: false }],
    ['没有该字段', {}],
  ])(
    '旧版本的 collectUntranslated（%s）：读取时忽略；写入时固定为 false（设置会同步，未更新的旧版本读不到时按开启处理）',
    async (_name, legacy) => {
      await fakeBrowser.storage.sync.set({ settings: { enabled: false, ...legacy } })
      expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: false })
      const next = await updateSettings({ translateTitle: false })
      expect(Object.hasOwn(next, 'collectUntranslated')).toBe(false)
      expect(await settingsItem.getValue()).toEqual({
        ...DEFAULT_SETTINGS,
        enabled: false,
        translateTitle: false,
        collectUntranslated: false,
      })
    },
  )

  it('watchSettings 回调合并后的设置', async () => {
    const callback = vi.fn()
    const stop = watchSettings(callback)
    await settingsItem.setValue({ enabled: false, excludedPaths: 'bad' as never })
    expect(callback).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, enabled: false })
    stop()
  })

  it('setCustomEntries 过滤后写入', async () => {
    const saved = await setCustomEntries({ Issues: '议题', Bad: ' ' })
    expect(saved).toEqual({ Issues: '议题' })
    expect(await customEntriesItem.getValue()).toEqual({ Issues: '议题' })
    expect(await getCustomEntries()).toEqual({ Issues: '议题' })
  })

  it('watchCustomEntries 回调过滤后的词条', async () => {
    const callback = vi.fn()
    const stop = watchCustomEntries(callback)
    await customEntriesItem.setValue({ Pulls: '拉取请求', Bad: 1 as never })
    expect(callback).toHaveBeenLastCalledWith({ Pulls: '拉取请求' })
    stop()
  })
})
