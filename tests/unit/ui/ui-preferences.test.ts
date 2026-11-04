import { computed } from 'vue'

type UiPreferencesModule = typeof import('../../../src/components/ui-preferences')

const KEY = 'gcn:ui-preferences'

/** 每个用例重新加载模块：偏好是模块级状态 */
async function load(): Promise<UiPreferencesModule> {
  vi.resetModules()
  return import('../../../src/components/ui-preferences')
}

const root = document.documentElement

beforeEach(() => {
  localStorage.clear()
  delete root.dataset.theme
  root.lang = ''
  document.title = ''
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('initUiPreferences', () => {
  it('按缓存设置界面语言、外观与文档标题', async () => {
    localStorage.setItem(KEY, JSON.stringify({ uiLanguage: 'zh-TW', theme: 'dark', uiStyle: 'classic' }))
    const { initUiPreferences, useI18n } = await load()
    initUiPreferences()
    expect(root.dataset.theme).toBe('dark')
    expect(root.lang).toBe('zh-TW')
    expect(document.title).toBe('網頁漢化助手')
    expect(useI18n().t('enable')).toBe('啟用')
  })

  it.each([
    ['无缓存', null],
    ['内容损坏', 'not json'],
    ['取值非法', JSON.stringify({ uiLanguage: 'zz', theme: 'neon' })],
  ])('%s：自动（跟随浏览器）', async (_name, cached) => {
    if (cached !== null) localStorage.setItem(KEY, cached)
    const { initUiPreferences, useI18n, useUiPreferences } = await load()
    initUiPreferences()
    expect(root.dataset.theme).toBeUndefined()
    expect(useUiPreferences().value).toEqual({ uiLanguage: 'auto', theme: 'auto', uiStyle: 'classic' })
    expect(useI18n().language.value).toBe('en')
    expect(document.title).toBe('Web Chinese Translator')
  })

  it('自动：浏览器语言为中文时用中文', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-HK'])
    const { initUiPreferences, useI18n } = await load()
    initUiPreferences()
    expect(useI18n().language.value).toBe('zh-TW')
    expect(root.lang).toBe('zh-TW')
  })

  it('localStorage 不可用：按自动，不报错', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const { initUiPreferences, useUiPreferences } = await load()
    expect(() => initUiPreferences()).not.toThrow()
    expect(useUiPreferences().value).toEqual({ uiLanguage: 'auto', theme: 'auto', uiStyle: 'classic' })
  })
})

describe('applyUiPreferences', () => {
  it('更新语言与外观并写入缓存；外观为自动时移除 data-theme', async () => {
    const { applyUiPreferences, useI18n } = await load()
    const { t } = useI18n()
    const label = computed(() => t('enable'))
    expect(label.value).toBe('Enable')

    applyUiPreferences({ uiLanguage: 'zh-CN', theme: 'light', uiStyle: 'classic' })
    expect(label.value).toBe('启用')
    expect(root.dataset.theme).toBe('light')
    expect(root.lang).toBe('zh-CN')
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ uiLanguage: 'zh-CN', theme: 'light', uiStyle: 'classic' })

    applyUiPreferences({ uiLanguage: 'zh-CN', theme: 'auto', uiStyle: 'classic' })
    expect(root.dataset.theme).toBeUndefined()
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ uiLanguage: 'zh-CN', theme: 'auto', uiStyle: 'classic' })
  })

  it('写不进缓存：照常应用', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const { applyUiPreferences } = await load()
    expect(() => applyUiPreferences({ uiLanguage: 'en', theme: 'dark', uiStyle: 'classic' })).not.toThrow()
    expect(root.dataset.theme).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('浅色、深色写在指定根元素上；自动时移除', async () => {
    const { applyTheme } = await load()
    const element = document.createElement('div')
    applyTheme('dark', element)
    expect(element.dataset.theme).toBe('dark')
    applyTheme('light', element)
    expect(element.dataset.theme).toBe('light')
    applyTheme('auto', element)
    expect(element.hasAttribute('data-theme')).toBe(false)
  })
})
