import { enableAutoUnmount, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { clearToasts } from '../../../src/components/toast'
import { getSettings, settingsItem } from '../../../src/shared/settings'
import {
  STATUS,
  contentMissing,
  contentWith,
  focusWindow,
  mockContent,
  mockPermission,
  mockVersion,
  openTab,
  seedChineseUi,
  settle,
  ZH_SETTINGS,
} from './helpers'
import { importSfc, required } from './sfc'

const App = await importSfc(() => import('../../../src/entrypoints/popup/App.vue'))
const OptionsApp = await importSfc(() => import('../../../src/entrypoints/options/App.vue'))
let renderOptions = false

const REPO_URL = 'https://github.com/vuejs/core'

enableAutoUnmount(afterEach)

/** attached：接入文档（label 与控件的关联只在文档内生效） */
async function render(attached = false): Promise<VueWrapper> {
  const wrapper = mount(required(renderOptions ? OptionsApp : App), attached ? { attachTo: document.body } : {})
  await settle()
  if (renderOptions) {
    await wrapper.get('[data-test="nav-github-title"]').trigger('click')
    await settle()
  }
  return wrapper
}

function button(scope: VueWrapper | DOMWrapper<Element>, text: string): DOMWrapper<HTMLButtonElement> {
  const found = scope.findAll('button').find((item) => item.text() === text)
  if (!found) throw new Error(`未找到按钮：${text}`)
  return found as DOMWrapper<HTMLButtonElement>
}

function hasButton(wrapper: VueWrapper, text: string): boolean {
  return wrapper.findAll('button').some((item) => item.text() === text)
}

function stateText(wrapper: VueWrapper): string {
  return wrapper.get('[data-test="state"]').text()
}

/** 有标题的分区（常规、语言），按标题查找 */
function section(wrapper: VueWrapper, title: string): DOMWrapper<Element> {
  const found = wrapper.findAll('section').find((item) => item.find('h2').exists() && item.get('h2').text() === title)
  if (!found) throw new Error(`未找到分区：${title}`)
  return found
}

/** 页面顶部的提示文字（读屏朗读的区域内），先显示的在前 */
function toastTexts(wrapper: VueWrapper): string[] {
  return wrapper
    .get('[aria-live="polite"]')
    .findAll('.ui-toast')
    .map((toast) => toast.text())
}

function headings(wrapper: VueWrapper): string[] {
  return wrapper.findAll('h2').map((item) => item.text())
}

function switchOf(scope: VueWrapper | DOMWrapper<Element>, label: string): DOMWrapper<HTMLButtonElement> {
  const labelEl = scope.findAll('label').find((item) => item.text() === label)
  if (!labelEl) throw new Error(`未找到开关：${label}`)
  return scope.get(`#${CSS.escape(labelEl.attributes('for') ?? '')}`) as DOMWrapper<HTMLButtonElement>
}

/** 下拉框的按钮 */
function select(wrapper: VueWrapper, name: string): DOMWrapper<HTMLButtonElement> {
  return wrapper.get(`[data-test="${name}"]`) as DOMWrapper<HTMLButtonElement>
}

/** 下拉框的选项：在按钮 aria-controls 指向的列表里 */
function optionsOf(wrapper: VueWrapper, name: string): DOMWrapper<Element>[] {
  const id = select(wrapper, name).attributes('aria-controls') ?? ''
  return wrapper.get(`#${CSS.escape(id)}`).findAll('[role="option"]')
}

function optionLabels(wrapper: VueWrapper, name: string): string[] {
  return optionsOf(wrapper, name).map((option) => option.text())
}

function optionLangs(wrapper: VueWrapper, name: string): (string | undefined)[] {
  return optionsOf(wrapper, name).map((option) => option.attributes('lang'))
}

/** 选中项的文字 */
function selectedLabel(wrapper: VueWrapper, name: string): string | undefined {
  return optionsOf(wrapper, name)
    .find((option) => option.attributes('aria-selected') === 'true')
    ?.text()
}

/** 按钮上显示的当前值：去掉对读屏隐藏、只用来撑开宽度的部分 */
function shownLabel(wrapper: VueWrapper, name: string): string {
  const clone = select(wrapper, name).element.cloneNode(true) as HTMLElement
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return clone.textContent?.trim() ?? ''
}

/** 打开下拉并点选项 */
async function choose(wrapper: VueWrapper, name: string, label: string): Promise<void> {
  await select(wrapper, name).trigger('click')
  const option = optionsOf(wrapper, name).find((item) => item.text() === label)
  if (!option) throw new Error(`未找到选项：${label}`)
  await option.trigger('click')
}

describe.skipIf(!App)('弹出页组件', () => {
  beforeEach(async () => {
    fakeBrowser.reset()
    localStorage.removeItem('gcn:popup-more-open')
    await seedChineseUi()
    mockVersion('1.2.3')
    mockPermission(true)
  })

  afterEach(() => {
    delete document.documentElement.dataset.theme
    clearToasts()
    vi.restoreAllMocks()
  })

  it('标题后紧跟版本号（不在标题内）', async () => {
    mockContent(contentWith())
    const wrapper = await render()
    const title = wrapper.get('h1')
    const version = wrapper.get('[data-test="version"]')
    expect(title.text()).toBe('网页汉化助手')
    expect(version.text()).toBe('v1.2.3')
    expect(title.element.nextElementSibling).toBe(version.element)
  })

  it('读不到版本号时不显示', async () => {
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockImplementation(() => {
      throw new Error('不可用')
    })
    mockContent(contentWith())
    const wrapper = await render()
    expect(wrapper.find('[data-test="version"]').exists()).toBe(false)
  })

  it('GitHub 页面词典行显示 GitHub 汉化状态', async () => {
    await openTab(REPO_URL)
    mockContent(contentWith())
    const wrapper = await render()
    const row = wrapper.findAll('.popup-engine').find((item) => item.text().includes('GitHub'))
    expect(row?.text()).toContain('已翻译')
    expect(row?.text()).not.toContain('未启用')
  })

  it('普通已翻译页面不展示 GitHub 状态行，总开关仍在', async () => {
    await openTab(REPO_URL)
    mockContent(contentWith())
    const wrapper = await render()
    expect(wrapper.find('[data-test="state"]').exists()).toBe(false)
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-test="settings"]').attributes('aria-label')).toBe('设置')
  })

  it('启用开关写入存储', async () => {
    await openTab(REPO_URL)
    mockContent(contentWith())
    const wrapper = await render()
    const toggle = wrapper.get('[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(wrapper.get(`label[for="${toggle.attributes('id')}"]`).text()).toBe('启用')

    await toggle.trigger('click')
    await settle()
    expect((await getSettings()).enabled).toBe(false)
    expect(toggle.attributes('aria-checked')).toBe('false')
  })

  it('非 GitHub 页面不展示 GitHub 状态及排除操作', async () => {
    await openTab('https://example.com/')
    mockContent(contentWith())
    const wrapper = await render()
    expect(wrapper.find('[data-test="state"]').exists()).toBe(false)
    expect(hasButton(wrapper, '排除此页')).toBe(false)
    expect(hasButton(wrapper, '刷新')).toBe(false)
    expect(hasButton(wrapper, '规则')).toBe(false)
    expect(wrapper.find('[data-test="settings"]').exists()).toBe(true)
  })

  it('没有未翻译一行与收集开关；存储里有旧版本的未翻译文本也不显示', async () => {
    await openTab(REPO_URL)
    await fakeBrowser.storage.local.set({
      'untranslated:Code': { count: 3, kinds: 1, seen: 1, pages: { code: 2 } },
      untranslatedMeta: { count: 1, full: true },
    })
    mockContent(contentWith())
    const wrapper = await render()
    expect(wrapper.find('[data-test="untranslated"]').exists()).toBe(false)
    for (const text of ['未翻译', '收集', '已满']) expect(wrapper.text()).not.toContain(text)
    for (const text of ['复制', '清空']) expect(hasButton(wrapper, text)).toBe(false)
  })

  it('无响应 → 未就绪 + 刷新', async () => {
    const tabId = await openTab(REPO_URL)
    mockContent(contentMissing)
    const reload = vi.fn(async () => undefined)
    vi.spyOn(fakeBrowser.tabs, 'reload').mockImplementation(reload as never)
    const wrapper = await render()
    expect(stateText(wrapper)).toBe('未就绪')
    await button(wrapper, '刷新').trigger('click')
    expect(reload).toHaveBeenCalledWith(tabId)
  })

  it.each([
    [{ ...STATUS, active: true }, '已翻译'],
    [{ ...STATUS, active: false, excluded: true }, '已排除'],
    [{ ...STATUS, active: false, excluded: false }, '已停用'],
  ])('普通页不展示 GitHub 状态 %s', async (status) => {
    await openTab(REPO_URL)
    mockContent(contentWith(status))
    const wrapper = await render()
    expect(wrapper.find('[data-test="state"]').exists()).toBe(false)
    expect(wrapper.find('.popup-details').exists()).toBe(false)
  })

  it('未授权 → 授权按钮在点击时请求权限', async () => {
    mockPermission(false)
    await focusWindow()
    mockContent(contentWith())
    const request = vi.fn(async () => false)
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(request as never)
    const wrapper = await render()
    expect(stateText(wrapper)).toBe('未授权')

    await button(wrapper, '授权').trigger('click')
    expect(request).toHaveBeenCalledWith({
      origins: ['https://github.com/*', 'https://gist.github.com/*', 'https://www.githubstatus.com/*'],
    })
  })

  it('弹出页不再提供排除此页，已保存的排除路径保持不变', async () => {
    await openTab(`${REPO_URL}/issues`)
    await settingsItem.setValue({ ...ZH_SETTINGS, excludedPaths: ['/vuejs/core/issues'] })
    mockContent(contentWith())
    const wrapper = await render()
    expect(hasButton(wrapper, '排除此页')).toBe(false)
    expect(hasButton(wrapper, '取消排除')).toBe(false)
    expect((await getSettings()).excludedPaths).toEqual(['/vuejs/core/issues'])
  })

  it('已被规则排除的页面不在弹出页显示取消排除', async () => {
    await openTab(`${REPO_URL}/wiki`)
    await settingsItem.setValue({ ...ZH_SETTINGS, excludedPaths: ['/*/*/wiki'] })
    mockContent(contentWith({ ...STATUS, active: false, excluded: true }))
    const wrapper = await render()
    expect(wrapper.find('[data-test="state"]').exists()).toBe(false)
    expect(hasButton(wrapper, '取消排除')).toBe(false)
  })

  it('根路径不再出现排除按钮', async () => {
    await openTab('https://github.com/')
    mockContent(contentWith())
    const wrapper = await render()
    expect(hasButton(wrapper, '排除此页')).toBe(false)
  })

  describe('设置齿轮', () => {
    it('打开设置页并关闭弹出页', async () => {
      mockContent(contentWith())
      const open = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never)
      const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
      const wrapper = await render()
      await wrapper.get('[data-test="settings"]').trigger('click')
      await settle()
      expect(open).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(1)
    })

    it('打开失败时提示，不关闭弹出页', async () => {
      mockContent(contentWith())
      vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockRejectedValue(new Error('失败'))
      const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
      const wrapper = await render()
      await wrapper.get('[data-test="settings"]').trigger('click')
      await settle()
      expect(toastTexts(wrapper)).toEqual(['打开失败'])
      expect(close).not.toHaveBeenCalled()
    })
  })

  describe('布局', () => {
    it('依次为标题、总开关、当前页开关、页脚齿轮和提示区域', async () => {
      await openTab(`${REPO_URL}/issues`)
      mockContent(contentWith())
      const wrapper = await render()
      const children = [...wrapper.element.children]
      const footer = wrapper.get('footer')
      expect(children.map((item) => item.tagName)).toEqual(['HEADER', 'SECTION', 'SECTION', 'FOOTER', 'DIV'])
      expect(children[4]?.getAttribute('aria-live')).toBe('polite')
      expect(toastTexts(wrapper)).toEqual([])
      expect(wrapper.find('.popup-details').exists()).toBe(false)
      expect(footer.findAll('button, a').map((item) => item.attributes('aria-label') ?? item.text())).toEqual([
        '本站设置',
        '模型设置',
        '设置',
      ])
      expect(footer.get('[data-test="settings"] svg').attributes('aria-hidden')).toBe('true')
    })

    it('页脚有本站设置、模型设置和设置齿轮，没有外链', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      expect(wrapper.find('footer a').exists()).toBe(false)
      expect(wrapper.find('[data-test="repository"]').exists()).toBe(false)
      expect(wrapper.get('[data-test="wt-open-site-settings"]').text()).toBe('本站设置')
      expect(wrapper.get('[data-test="wt-open-model-settings"]').text()).toBe('模型设置')
      const gear = wrapper.get('[data-test="settings"]')
      expect(gear.attributes('aria-label')).toBe('设置')
      expect(gear.get('svg').attributes('viewBox')).toBe('0 0 24 24')
    })

    it('宽度 320px，弹出页更宽时铺满（右侧不留空白）', async () => {
      mockContent(contentWith())
      const wrapper = await render(true)
      const style = getComputedStyle(wrapper.get('main').element)
      expect(style.width).toBe('320px')
      expect(style.minWidth).toBe('100%')
    })

    it('GitHub 常规与语言在完整设置里，弹出页没有折叠设置', async () => {
      mockContent(contentWith())
      const popup = await render()
      expect(popup.find('.popup-details').exists()).toBe(false)
      renderOptions = true
      const wrapper = await render()
      renderOptions = false
      expect(headings(wrapper)).toContain('常规')
      expect(headings(wrapper)).toContain('语言')
      for (const title of ['常规', '语言']) {
        const found = section(wrapper, title)
        expect(found.attributes('aria-labelledby')).toBe(found.get('h2').attributes('id'))
      }
    })

    it('不重复：启用开关只在顶部；没有语言下拉、快捷键、排除路径、自定义词条、关于', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      expect(wrapper.findAll('label').filter((item) => item.text() === '启用')).toHaveLength(1)
      expect(wrapper.findAll('[role="switch"]')).toHaveLength(5)
      expect(wrapper.get('[data-test="wt-translate-page"]').element.tagName).toBe('BUTTON')
      expect(wrapper.get('[data-test="wt-popup-floating"] [role="switch"]').attributes('disabled')).toBeDefined()
      expect(wrapper.findAll('[role="combobox"]')).toHaveLength(0)
      expect(wrapper.find('select').exists()).toBe(false)
      expect(wrapper.find('textarea').exists()).toBe(false)
      for (const text of ['快捷键', '排除路径', '自定义词条', '关于']) expect(wrapper.text()).not.toContain(text)
    })

    it('设置读取前开关、外观按钮、语言下拉不可用，读取后可用', async () => {
      mockContent(contentWith())
      const wrapper = mount(required(App))
      // 读取前的界面语言取决于缓存：按控件类型查找，不按文案
      const disabled = (): boolean[] =>
        wrapper
          .findAll('[role="switch"], [data-test="theme-toggle"], [role="combobox"]')
          .filter((item) => item.element.closest('.popup-more, .popup-engines') === null)
          .map((item) => (item.element as HTMLButtonElement).disabled)
      expect(disabled()).toEqual([true, true])
      expect((wrapper.get('[data-test="wt-popup-floating"] [role="switch"]').element as HTMLButtonElement).disabled).toBe(true)
      expect((wrapper.get('[data-test="wt-popup-auto-interaction"] [role="switch"]').element as HTMLButtonElement).disabled).toBe(true)
      await settle()
      expect(disabled()).toEqual([false, false])
      expect((wrapper.get('[data-test="wt-popup-floating"] [role="switch"]').element as HTMLButtonElement).disabled).toBe(true)
      expect((wrapper.get('[data-test="wt-popup-auto-interaction"] [role="switch"]').element as HTMLButtonElement).disabled).toBe(true)
    })

    it('设置齿轮打开失败时提示显示在页面顶部，分区布局不变', async () => {
      await openTab(REPO_URL)
      mockContent(contentWith())
      vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockRejectedValue(new Error('失败'))
      const wrapper = await render()
      await wrapper.get('[data-test="settings"]').trigger('click')
      await settle()
      const children = [...wrapper.element.children]
      expect(children.map((item) => item.tagName)).toEqual(['HEADER', 'SECTION', 'SECTION', 'FOOTER', 'DIV'])
      expect(toastTexts(wrapper)).toEqual(['打开失败'])
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    })
  })

  describe('常规', () => {
    beforeEach(() => {
      renderOptions = true
    })
    afterEach(() => {
      renderOptions = false
    })
    it('只有时间本地化、翻译标题', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      expect(
        section(wrapper, '常规')
          .findAll('label')
          .map((item) => item.text()),
      ).toEqual(['时间本地化', '翻译标题'])
    })

    it.each([
      ['时间本地化', 'translateTime'],
      ['翻译标题', 'translateTitle'],
    ] as const)('%s 开关即时保存', async (label, key) => {
      mockContent(contentWith())
      const wrapper = await render()
      const toggle = switchOf(section(wrapper, '常规'), label)
      expect(toggle.attributes('aria-checked')).toBe('true')
      await toggle.trigger('click')
      await settle()
      expect((await getSettings())[key]).toBe(false)
      expect(toggle.attributes('aria-checked')).toBe('false')
    })

    it('反映已保存的设置', async () => {
      await settingsItem.setValue({ ...ZH_SETTINGS, translateTime: false })
      mockContent(contentWith())
      const wrapper = await render()
      expect(switchOf(section(wrapper, '常规'), '时间本地化').attributes('aria-checked')).toBe('false')
    })

    it('保存失败时在页面顶部提示，开关不变；再次保存成功时收起', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      const set = vi.spyOn(fakeBrowser.storage.sync, 'set').mockRejectedValue(new Error('配额'))
      await switchOf(section(wrapper, '常规'), '翻译标题').trigger('click')
      await settle()
      expect(toastTexts(wrapper)).toEqual(['保存失败'])
      expect(switchOf(section(wrapper, '常规'), '翻译标题').attributes('aria-checked')).toBe('true')
      set.mockRestore()
      await switchOf(section(wrapper, '常规'), '翻译标题').trigger('click')
      await settle()
      expect(toastTexts(wrapper)).toEqual([])
      expect(switchOf(section(wrapper, '常规'), '翻译标题').attributes('aria-checked')).toBe('false')
    })

    it('与顶部总开关共用设置：读取一次存储，各自写入都保留', async () => {
      mockContent(contentWith())
      const get = vi.spyOn(fakeBrowser.storage.sync, 'get')
      const wrapper = await render()
      const general = section(wrapper, '常规')
      // 完整设置里常规两项与弹出页总开关共用一份存储：本次只读一次，两处写入互不覆盖。总开关只在弹出页。
      expect(get).toHaveBeenCalledTimes(1)
      await switchOf(general, '时间本地化').trigger('click')
      await switchOf(general, '翻译标题').trigger('click')
      await settle()
      expect(await getSettings()).toMatchObject({ enabled: true, translateTime: false, translateTitle: false })
    })
  })

  describe('语言', () => {
    beforeEach(() => {
      renderOptions = true
    })
    afterEach(() => {
      renderOptions = false
    })
    it('选项与已保存的设置', async () => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-HK', 'en'])
      await settingsItem.setValue({ ...ZH_SETTINGS, language: 'zh-CN' })
      mockContent(contentWith())
      const wrapper = await render()
      // 「自动」括注识别结果，用界面语言书写；其余语言名用各自语言书写并标注 lang
      expect(optionLabels(wrapper, 'ui-language')).toEqual(['自动（繁体中文）', '简体中文', '繁體中文', 'English', '日本語', '한국어'])
      expect(optionLabels(wrapper, 'page-language')).toEqual(['自动（繁体中文）', '简体中文', '繁體中文'])
      expect(optionLangs(wrapper, 'ui-language')).toEqual([undefined, 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'])
      expect(optionLangs(wrapper, 'page-language')).toEqual([undefined, 'zh-CN', 'zh-TW'])
      for (const name of ['ui-language', 'page-language']) {
        expect(selectedLabel(wrapper, name)).toBe('简体中文')
        expect(shownLabel(wrapper, name)).toBe('简体中文')
      }
    })

    it('下拉（按钮与展开的列表）以标签为名', async () => {
      mockContent(contentWith())
      const wrapper = await render(true)
      const language = section(wrapper, '语言')
      for (const [name, label] of [
        ['ui-language', '界面语言'],
        ['page-language', 'GitHub 词典语言'],
      ] as const) {
        const button = select(wrapper, name)
        expect(language.get(`label[for="${button.attributes('id')}"]`).text()).toBe(label)
        await button.trigger('click')
        expect(wrapper.get(`#${CSS.escape(button.attributes('aria-controls') ?? '')}`).attributes('aria-label')).toBe(
          label,
        )
        await button.trigger('click')
      }
    })

    it('界面语言：写入设置，界面随之切换', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      await choose(wrapper, 'ui-language', 'English')
      await settle()
      expect((await getSettings()).uiLanguage).toBe('en')
      expect(shownLabel(wrapper, 'ui-language')).toBe('English')
      expect(headings(wrapper)).toContain('General')
      expect(headings(wrapper)).toContain('Language')
      expect(wrapper.get('h1').text()).toBe('Web Chinese Translator')
      expect(document.documentElement.lang).toBe('en')
    })

    it('翻译语言写入设置', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      await choose(wrapper, 'page-language', '繁體中文')
      await settle()
      expect((await getSettings()).language).toBe('zh-TW')
      expect(shownLabel(wrapper, 'page-language')).toBe('繁體中文')
    })

    it('保存失败时提示，下拉仍显示已保存的值（连续失败、跨下拉也一样）', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      const autoLabel = optionLabels(wrapper, 'page-language')[0]
      vi.spyOn(fakeBrowser.storage.sync, 'set').mockRejectedValue(new Error('配额'))
      await choose(wrapper, 'page-language', '繁體中文')
      await settle()
      expect(toastTexts(wrapper)).toEqual(['保存失败'])
      expect(shownLabel(wrapper, 'page-language')).toBe(autoLabel)
      await choose(wrapper, 'page-language', '简体中文')
      await settle()
      expect(shownLabel(wrapper, 'page-language')).toBe(autoLabel)
      expect(selectedLabel(wrapper, 'page-language')).toBe(autoLabel)
      await choose(wrapper, 'ui-language', 'English')
      await settle()
      expect(shownLabel(wrapper, 'ui-language')).toBe('简体中文')
      expect(document.documentElement.lang).toBe('zh-CN')
      expect(await getSettings()).toMatchObject({ uiLanguage: 'zh-CN', language: 'auto' })
      // 连续失败只留一条
      expect(toastTexts(wrapper)).toEqual(['保存失败'])
    })

    it('英文界面：「自动」括注用英文语言名', async () => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-TW', 'en'])
      await settingsItem.setValue({ ...ZH_SETTINGS, uiLanguage: 'en' })
      mockContent(contentWith())
      const wrapper = await render()
      expect(optionLabels(wrapper, 'ui-language')).toEqual([
        'Auto (Traditional Chinese)',
        '简体中文',
        '繁體中文',
        'English',
        '日本語',
        '한국어',
      ])
      expect(optionLabels(wrapper, 'page-language')).toEqual(['Auto (Traditional Chinese)', '简体中文', '繁體中文'])
    })

    it('非 Firefox 构建下 GitHub 词典语言带提示说明', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      const describedBy = select(wrapper, 'page-language').attributes('aria-describedby')
      expect(describedBy).toBe('page-language-hint')
      expect(wrapper.get(`#${CSS.escape(describedBy ?? '')}`).text()).toBe(
        '仅决定 GitHub 内置词典用简体还是繁体；其他网站和模型翻译跟随「翻译目标语言」。',
      )
    })
  })

  describe('外观', () => {
    it('按钮依次切换自动、浅色、深色，写入设置并应用到页面', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      const toggle = wrapper.get('[data-test="theme-toggle"]')
      expect(toggle.attributes('aria-label')).toBe('外观：自动')
      expect(document.documentElement.dataset.theme).toBeUndefined()

      for (const [theme, label] of [
        ['light', '外观：浅色'],
        ['dark', '外观：深色'],
        ['auto', '外观：自动'],
      ] as const) {
        await toggle.trigger('click')
        await settle()
        expect((await getSettings()).theme).toBe(theme)
        expect(toggle.attributes('aria-label')).toBe(label)
        expect(toggle.attributes('title')).toBe(label)
        expect(document.documentElement.dataset.theme).toBe(theme === 'auto' ? undefined : theme)
      }
    })

    it.each([
      ['en', ['Appearance: Auto', 'Appearance: Light', 'Appearance: Dark']],
      ['zh-TW', ['外觀：自動', '外觀：淺色', '外觀：深色']],
    ] as const)('%s 界面的外观名', async (uiLanguage, labels) => {
      await settingsItem.setValue({ ...ZH_SETTINGS, uiLanguage })
      mockContent(contentWith())
      const wrapper = await render()
      const toggle = wrapper.get('[data-test="theme-toggle"]')
      const seen = [toggle.attributes('aria-label')]
      for (let step = 1; step < labels.length; step += 1) {
        await toggle.trigger('click')
        await settle()
        seen.push(toggle.attributes('aria-label'))
      }
      expect(seen).toEqual(labels)
    })

    it('反映已保存的外观', async () => {
      await settingsItem.setValue({ ...ZH_SETTINGS, theme: 'dark' })
      mockContent(contentWith())
      const wrapper = await render()
      expect(wrapper.get('[data-test="theme-toggle"]').attributes('aria-label')).toBe('外观：深色')
      expect(document.documentElement.dataset.theme).toBe('dark')
    })

    it('保存失败时提示，外观不变', async () => {
      mockContent(contentWith())
      const wrapper = await render()
      vi.spyOn(fakeBrowser.storage.sync, 'set').mockRejectedValue(new Error('配额'))
      await wrapper.get('[data-test="theme-toggle"]').trigger('click')
      await settle()
      expect(toastTexts(wrapper)).toEqual(['保存失败'])
      expect(document.documentElement.dataset.theme).toBeUndefined()
    })
  })

  describe('界面语言', () => {
    it.each([
      ['en', 'Web Chinese Translator', 'Enable', 'Settings'],
      ['zh-TW', '網頁漢化助手', '啟用', '設定'],
    ] as const)('%s', async (uiLanguage, title, enable, settingsLabel) => {
      await settingsItem.setValue({ ...ZH_SETTINGS, uiLanguage })
      await openTab(REPO_URL)
      mockContent(contentWith())
      const wrapper = await render()
      expect(wrapper.get('h1').text()).toBe(title)
      const toggle = wrapper.get('[role="switch"]')
      expect(wrapper.get(`label[for="${toggle.attributes('id')}"]`).text()).toBe(enable)
      expect(wrapper.find('[data-test="state"]').exists()).toBe(false)
      expect(wrapper.find('.popup-details').exists()).toBe(false)
      expect(hasButton(wrapper, 'Rules')).toBe(false)
      expect(hasButton(wrapper, '規則')).toBe(false)
      expect(wrapper.find('[data-test="repository"]').exists()).toBe(false)
      expect(wrapper.get('[data-test="settings"]').attributes('aria-label')).toBe(settingsLabel)
      expect(document.documentElement.lang).toBe(uiLanguage)
    })
  })
})
