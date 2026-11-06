import { enableAutoUnmount, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { clearToasts } from '../../../src/components/toast'
import zhCN from '../../../src/i18n/zh-CN'
import { EXPORT_FILE_NAME } from '../../../src/shared/custom-entries'
import { REPOSITORY_URL } from '../../../src/shared/extension'
import {
  customEntriesItem,
  getCustomEntries,
  getSettings,
  settingsItem,
  updateSettings,
} from '../../../src/shared/settings'
import { mockVersion, seedChineseUi, settle, ZH_SETTINGS } from './helpers'
import { importSfc, required } from './sfc'

const App = await importSfc(() => import('../../../src/entrypoints/options/App.vue'))

enableAutoUnmount(afterEach)

async function render(): Promise<VueWrapper> {
  const wrapper = mount(required(App), { attachTo: document.body })
  await settle()
  return wrapper
}

function section(wrapper: VueWrapper, title: string): DOMWrapper<Element> {
  const found = wrapper.findAll('section').find((item) => item.find('h2').text().replace(/（GitHub）$/, '') === title)
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

function button(scope: VueWrapper | DOMWrapper<Element>, text: string): DOMWrapper<HTMLButtonElement> {
  const found = scope.findAll('button').find((item) => item.text() === text)
  if (!found) throw new Error(`未找到按钮：${text}`)
  return found as DOMWrapper<HTMLButtonElement>
}

function textareaValue(wrapper: VueWrapper): string {
  return (section(wrapper, '排除路径').get('textarea').element as HTMLTextAreaElement).value
}

async function chooseFile(wrapper: VueWrapper, content: string): Promise<void> {
  const input = wrapper.get('[data-test="import-file"]')
  Object.defineProperty(input.element, 'files', {
    value: [new File([content], 'entries.json', { type: 'application/json' })],
    configurable: true,
  })
  await input.trigger('change')
  await settle()
}

/** 先聚焦再点击：模拟键盘操作（Chromium 点击按钮时也会聚焦） */
async function pressButton(scope: DOMWrapper<Element>, selector: string): Promise<void> {
  const target = scope.get<HTMLButtonElement>(selector)
  target.element.focus()
  await target.trigger('click')
  await settle()
}

describe.skipIf(!App)('设置页组件', () => {
  beforeEach(async () => {
    window.history.replaceState(null, '', window.location.pathname)
    fakeBrowser.reset()
    await seedChineseUi()
    mockVersion('1.2.3')
  })

  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname)
    delete document.documentElement.dataset.theme
    clearToasts()
    vi.restoreAllMocks()
  })

  describe('布局', () => {
    it('默认常用设置；分区保留单实例及原有控件', async () => {
      const wrapper = await render()
      expect(wrapper.get('h1').text()).toBe('网页汉化助手')
      expect(headings(wrapper)).toEqual(['基础界面词库', '常用设置', '常规', '语言', '排除路径（GitHub）', '自定义词条（GitHub）', '外观', '关于'])
      expect(wrapper.get('[data-test="wt-general-view"]').isVisible()).toBe(true)
      expect(wrapper.get('[data-test="wt-model-view"]').isVisible()).toBe(false)
      expect(wrapper.get('[data-test="wt-sites-view"]').isVisible()).toBe(false)
      expect(wrapper.findAll('[role="switch"]')).toHaveLength(32)
      expect(wrapper.get('[data-test="wt-video-subtitles-toggle"] [role="switch"]').attributes('aria-checked')).toBe('false')
      expect(wrapper.get('[data-test="wt-input-translation-toggle"] [role="switch"]').attributes('aria-checked')).toBe('false')
      expect(wrapper.get('[data-test="wt-dict-devin"]').find('[role="switch"]').exists()).toBe(true)
      expect(wrapper.get('[data-test="wt-dict-cursor"]').find('[role="switch"]').exists()).toBe(true)
      // 接口协议、模型、源语言、目标语言、输入目标语言、辅助模式、单页上限、网站运行范围，外观里的界面风格与主题，加上 GitHub 界面语言与词典语言里实际渲染的下拉
      expect(wrapper.find('[data-test="ui-language"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="page-language"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="wt-page-limit"]').exists()).toBe(true)
      expect(wrapper.findAll('[role="combobox"]')).toHaveLength(12)
      expect(wrapper.find('[data-test="wt-assist-mode"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="wt-shortcuts"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('输入翻译快捷键在自动弹窗关闭时仍可直接替换')
    })

    it('标题后紧跟版本号（不在标题内）', async () => {
      const wrapper = await render()
      const title = wrapper.get('h1')
      const version = wrapper.get('[data-test="version"]')
      expect(title.text()).toBe('网页汉化助手')
      expect(version.text()).toBe('v1.2.3')
      expect(title.element.nextElementSibling).toBe(wrapper.get('.options-subtitle').element)
      expect(wrapper.get('.options-subtitle').element.nextElementSibling).toBe(version.element)
    })

    it('关于：GitHub 存储库地址，在新标签页打开', async () => {
      const wrapper = await render()
      const about = section(wrapper, '关于')
      expect(about.findAll('dt').map((item) => item.text())).toEqual(['GitHub 汉化上游'])
      const link = about.get('dd a')
      expect(link.attributes('href')).toBe(REPOSITORY_URL)
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toBe('noreferrer')
      expect(link.text()).toBe(REPOSITORY_URL.replace('https://', ''))
    })

    it.each([
      ['en', 'Web Chinese Translator', ['Built-in UI glossary', 'General settings', 'General', 'Language', 'Excluded paths (GitHub)', 'Custom entries (GitHub)', 'Appearance', 'About'], 'Upstream (github-chinese)'],
      ['zh-TW', '網頁漢化助手', ['基礎介面詞庫', '常用設定', '一般', '語言', '排除路徑（GitHub）', '自訂詞條（GitHub）', '外觀', '關於'], 'GitHub 漢化上游'],
    ] as const)('界面语言随设置（如在弹出页修改）切换：%s', async (uiLanguage, title, sections, repository) => {
      const wrapper = await render()
      await updateSettings({ uiLanguage })
      await settle()
      expect(wrapper.get('h1').text()).toBe(title)
      expect(headings(wrapper)).toEqual(sections)
      expect(wrapper.get('dt').text()).toBe(repository)
      expect(document.documentElement.lang).toBe(uiLanguage)
    })

    it('外观随设置', async () => {
      await settingsItem.setValue({ ...ZH_SETTINGS, theme: 'dark' })
      await render()
      expect(document.documentElement.dataset.theme).toBe('dark')
      await updateSettings({ theme: 'light' })
      await settle()
      expect(document.documentElement.dataset.theme).toBe('light')
    })

    it('导航与hash只切换显示，保持唯一TranslationSection实例', async () => {
      const wrapper = await render()
      const element = wrapper.getComponent({ name: 'TranslationSection' }).element
      expect(wrapper.get('[data-test="nav-wt-general-title"]').attributes('aria-current')).toBe('page')
      expect(wrapper.get('[data-test="wt-general-view"]').isVisible()).toBe(true)
      await wrapper.get('[data-test="nav-wt-title"]').trigger('click')
      await settle()
      expect(window.location.hash).toBe('#wt-title')
      expect(wrapper.get('[data-test="wt-model-view"]').isVisible()).toBe(true)
      expect(wrapper.get('[data-test="wt-general-view"]').isVisible()).toBe(false)
      await wrapper.get('[data-test="nav-wt-dictionary-title"]').trigger('click')
      await settle()
      expect(wrapper.get('[data-test="wt-sites-view"]').isVisible()).toBe(true)
      expect(wrapper.get('section[aria-labelledby="wt-dictionary-title"]').isVisible()).toBe(true)
      window.location.hash = '#appearance-title'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await settle()
      expect(wrapper.get('[data-test="nav-appearance-title"]').attributes('aria-current')).toBe('page')
      expect(wrapper.get('.wt-settings-sections').isVisible()).toBe(false)
      expect(wrapper.get('section[aria-labelledby="appearance-title"]').isVisible()).toBe(true)
      expect(wrapper.findAllComponents({ name: 'TranslationSection' })).toHaveLength(1)
      expect(wrapper.getComponent({ name: 'TranslationSection' }).element).toBe(element)
    })

    it('模型深链接直接显示连接设置，未知hash退回常用', async () => {
      window.history.replaceState(null, '', window.location.pathname + '#wt-title')
      const wrapper = await render()
      expect(wrapper.get('[data-test="wt-model-view"]').isVisible()).toBe(true)
      expect(wrapper.get('[data-test="nav-wt-title"]').attributes('aria-current')).toBe('page')
      window.location.hash = '#unknown'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await settle()
      expect(wrapper.get('[data-test="wt-general-view"]').isVisible()).toBe(true)
      expect(wrapper.get('[data-test="nav-wt-general-title"]').attributes('aria-current')).toBe('page')
    })

    it.each([
      ['page-unavailable', 'wtPageUnavailable'],
      ['disabled', 'wtPageDisabled'],
      ['untrusted-notice', undefined],
    ] as const)('只显示白名单入口提示：%s', async (notice, key) => {
      window.history.replaceState(null, '', window.location.pathname + '?notice=' + encodeURIComponent(notice))
      const wrapper = await render()
      if (key === undefined) {
        expect(wrapper.find('[data-test="wt-page-notice"]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain(notice)
      } else {
        expect(wrapper.get('[data-test="wt-page-notice"]').text()).toContain(zhCN[key])
        await wrapper.get('[data-test="wt-notice-dismiss"]').trigger('click')
        await settle()
        expect(wrapper.find('[data-test="wt-page-notice"]').exists()).toBe(false)
      }
    })
  })

  describe('排除路径', () => {
    beforeEach(() => {
      window.history.replaceState(null, '', window.location.pathname + '#github-title')
    })

    it('每行一条，保存后提示已保存', async () => {
      const wrapper = await render()
      const textarea = section(wrapper, '排除路径').get('textarea')
      await textarea.setValue('/settings\n\n/*/*/wiki')
      await button(section(wrapper, '排除路径'), '保存').trigger('click')
      await settle()
      expect((await getSettings()).excludedPaths).toEqual(['/settings', '/*/*/wiki'])
      expect(toastTexts(wrapper)).toEqual(['已保存'])
    })

    it('格式错误时不保存：标记文本框并提示；再输入时清除', async () => {
      const wrapper = await render()
      const textarea = section(wrapper, '排除路径').get('textarea')
      await textarea.setValue('settings')
      await button(section(wrapper, '排除路径'), '保存').trigger('click')
      await settle()
      expect(toastTexts(wrapper)).toEqual(['格式错误'])
      expect(textarea.attributes('aria-invalid')).toBe('true')
      expect((await getSettings()).excludedPaths).toEqual([])
      await textarea.setValue('/settings')
      expect(textarea.attributes('aria-invalid')).toBe('false')
      expect(toastTexts(wrapper)).toEqual([])
    })

    it('显示已有规则；文本框以分区标题为名', async () => {
      await settingsItem.setValue({ ...ZH_SETTINGS, excludedPaths: ['/settings'] })
      const wrapper = await render()
      const excluded = section(wrapper, '排除路径')
      expect(textareaValue(wrapper)).toBe('/settings')
      expect(excluded.get('textarea').attributes('aria-labelledby')).toBe(excluded.get('h2').attributes('id'))
    })

    it('保存后，弹出页排除此页、取消排除时文本框随之更新', async () => {
      const wrapper = await render()
      await section(wrapper, '排除路径').get('textarea').setValue('/settings')
      await button(section(wrapper, '排除路径'), '保存').trigger('click')
      await settle()

      await updateSettings({ excludedPaths: ['/settings', '/vuejs/core/issues'] })
      await settle()
      expect(textareaValue(wrapper)).toBe('/settings\n/vuejs/core/issues')

      await updateSettings({ excludedPaths: ['/settings'] })
      await settle()
      expect(textareaValue(wrapper)).toBe('/settings')
    })

    it('有未保存的输入时，弹出页排除此页不覆盖文本框', async () => {
      const wrapper = await render()
      await section(wrapper, '排除路径').get('textarea').setValue('/draft')
      await updateSettings({ excludedPaths: ['/vuejs/core/issues'] })
      await settle()
      expect(textareaValue(wrapper)).toBe('/draft')
    })
  })

  describe('自定义词条', () => {
    beforeEach(() => {
      window.history.replaceState(null, '', window.location.pathname + '#github-title')
    })

    it('读取失败时列表处显示加载失败，不弹提示', async () => {
      vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('存储不可用'))
      const wrapper = await render()
      expect(section(wrapper, '自定义词条').get('[data-test="entries-empty"]').text()).toBe('加载失败')
      expect(toastTexts(wrapper)).toEqual([])
    })

    it('空时显示暂无词条，导出不可用', async () => {
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      expect(entries.get('[data-test="entries-empty"]').text()).toBe('暂无词条')
      expect(button(entries, '导出').element.disabled).toBe(true)
    })

    it('添加词条', async () => {
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      const add = button(entries, '添加')
      expect(add.element.disabled).toBe(true)

      await entries.get('form input[aria-label="原文"]').setValue('Pull requests')
      await entries.get('form input[aria-label="译文"]').setValue('拉取请求')
      expect(add.element.disabled).toBe(false)
      await entries.get('form').trigger('submit')
      await settle()

      expect(await getCustomEntries()).toEqual({ 'Pull requests': '拉取请求' })
      expect(entries.findAll('tbody tr')).toHaveLength(1)
      expect((entries.get('form input[aria-label="原文"]').element as HTMLInputElement).value).toBe('')
    })

    it('原文重复时提示已存在', async () => {
      await customEntriesItem.setValue({ Code: '代码' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      await entries.get('form input[aria-label="原文"]').setValue('Code')
      await entries.get('form input[aria-label="译文"]').setValue('源码')
      await entries.get('form').trigger('submit')
      await settle()
      expect(toastTexts(wrapper)).toEqual(['已存在'])
      expect(await getCustomEntries()).toEqual({ Code: '代码' })
    })

    it('行内编辑原文与译文', async () => {
      await customEntriesItem.setValue({ Code: '代码' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')

      const target = entries.get('tbody input[aria-label="译文"]')
      await target.setValue('  源码  ')
      await settle()
      expect(await getCustomEntries()).toEqual({ Code: '源码' })
      expect((target.element as HTMLInputElement).value).toBe('源码')

      await entries.get('tbody input[aria-label="原文"]').setValue('Source')
      await settle()
      expect(await getCustomEntries()).toEqual({ Source: '源码' })
    })

    it('行内编辑无效时恢复原值', async () => {
      await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      const firstTarget = entries.get('tbody input[aria-label="译文"]')
      await firstTarget.setValue('  ')
      await settle()
      expect((firstTarget.element as HTMLInputElement).value).toBe('议题')
      expect(toastTexts(wrapper)).toEqual(['格式错误'])

      const firstSource = entries.get('tbody input[aria-label="原文"]')
      await firstSource.setValue('Code')
      await settle()
      expect((firstSource.element as HTMLInputElement).value).toBe('Issues')
      expect(toastTexts(wrapper)).toEqual(['已存在'])
      expect(await getCustomEntries()).toEqual({ Code: '代码', Issues: '议题' })
    })

    it('删除词条', async () => {
      await customEntriesItem.setValue({ Code: '代码' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      const remove = entries.get('button[aria-label="删除 Code"]')
      expect(remove.text()).toBe('删除')
      await remove.trigger('click')
      await settle()
      expect(await getCustomEntries()).toEqual({})
      expect(entries.get('[data-test="entries-empty"]').text()).toBe('暂无词条')
    })

    it('改原文：同一行就地更新，焦点与同一行里未提交的输入都保留', async () => {
      await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      const row = entries.get('tr[data-index="1"]').element
      const sourceInput = row.querySelector<HTMLInputElement>('input[aria-label="原文"]')!
      const targetInput = row.querySelector<HTMLInputElement>('input[aria-label="译文"]')!

      // 改原文后按 Tab：保存还没完成时已进入同一行的译文框并开始输入
      sourceInput.focus()
      sourceInput.value = 'Source code'
      sourceInput.dispatchEvent(new Event('change'))
      targetInput.focus()
      targetInput.value = '源码'
      targetInput.dispatchEvent(new Event('input'))
      await settle()

      expect(await getCustomEntries()).toEqual({ 'Source code': '代码', Issues: '议题' })
      expect(row.isConnected).toBe(true)
      expect(document.activeElement).toBe(targetInput)
      expect(targetInput.value).toBe('源码')
      expect(sourceInput.value).toBe('Source code')
      expect(row.querySelector('button')?.getAttribute('aria-label')).toBe('删除 Source code')
    })

    it('改原文保存失败：恢复原文，仍是同一行', async () => {
      await customEntriesItem.setValue({ Code: '代码' })
      const wrapper = await render()
      const row = section(wrapper, '自定义词条').get('tr[data-index="0"]').element
      const sourceInput = row.querySelector<HTMLInputElement>('input[aria-label="原文"]')!
      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('存储不可用'))
      sourceInput.value = 'Source code'
      sourceInput.dispatchEvent(new Event('change'))
      await settle()
      expect(toastTexts(wrapper)).toEqual(['保存失败'])
      expect(sourceInput.value).toBe('Code')
      expect(await getCustomEntries()).toEqual({ Code: '代码' })

      sourceInput.value = 'Source code'
      sourceInput.dispatchEvent(new Event('change'))
      await settle()
      expect(await getCustomEntries()).toEqual({ 'Source code': '代码' })
      expect(row.isConnected).toBe(true)
    })

    it('用键盘删除：焦点移到原位置这一条（原来的下一条）的删除按钮；删掉末条时移到上一条', async () => {
      await customEntriesItem.setValue({ Code: '代码', Issues: '议题', Wiki: '维基' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')

      await pressButton(entries, 'button[aria-label="删除 Issues"]')
      expect(document.activeElement?.getAttribute('aria-label')).toBe('删除 Code')

      await pressButton(entries, 'button[aria-label="删除 Code"]')
      expect(document.activeElement?.getAttribute('aria-label')).toBe('删除 Wiki')
    })

    it('删空：焦点移到添加表单；搜索结果删空时移到搜索框', async () => {
      await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')

      await entries.get('input[type="search"]').setValue('议')
      await pressButton(entries, 'button[aria-label="删除 Issues"]')
      expect(document.activeElement).toBe(entries.get('input[type="search"]').element)

      await entries.get('input[type="search"]').setValue('')
      await pressButton(entries, 'button[aria-label="删除 Code"]')
      expect(document.activeElement).toBe(entries.get('form input[aria-label="原文"]').element)
    })

    it('点击删除、按钮没有获得焦点（如 Firefox）时不移动焦点', async () => {
      await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
      const wrapper = await render()
      const focusedBefore = document.activeElement
      expect(focusedBefore).toBe(wrapper.get('#github-title').element)
      await section(wrapper, '自定义词条').get('button[aria-label="删除 Issues"]').trigger('click')
      await settle()
      expect(await getCustomEntries()).toEqual({ Code: '代码' })
      expect(document.activeElement).toBe(focusedBefore)
    })

    it('搜索', async () => {
      await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      const search = entries.get('input[type="search"]')

      await search.setValue('议')
      expect(entries.findAll('tbody tr')).toHaveLength(1)
      expect((entries.get('tbody input[aria-label="原文"]').element as HTMLInputElement).value).toBe('Issues')

      await search.setValue('none')
      expect(entries.get('[data-test="entries-empty"]').text()).toBe('未找到')
    })

    it('导入按钮直接打开文件选择框', async () => {
      const wrapper = await render()
      const entries = section(wrapper, '自定义词条')
      const click = vi
        .spyOn(entries.get('[data-test="import-file"]').element as HTMLInputElement, 'click')
        .mockImplementation(() => undefined)
      const create = vi.spyOn(fakeBrowser.tabs, 'create')
      await button(entries, '导入').trigger('click')
      expect(click).toHaveBeenCalledTimes(1)
      expect(create).not.toHaveBeenCalled()
    })

    it('导入 JSON 后提示条数', async () => {
      await customEntriesItem.setValue({ Code: '代码' })
      const wrapper = await render()
      await chooseFile(wrapper, '{"Issues": "议题", "Wiki": "维基"}')
      expect(toastTexts(wrapper)).toEqual(['已导入 2 条'])
      expect(await getCustomEntries()).toEqual({ Code: '代码', Issues: '议题', Wiki: '维基' })
      expect((wrapper.get('[data-test="import-file"]').element as HTMLInputElement).value).toBe('')
    })

    it('导入格式错误', async () => {
      const wrapper = await render()
      await chooseFile(wrapper, '["Code"]')
      expect(toastTexts(wrapper)).toEqual(['格式错误'])
      expect(await getCustomEntries()).toEqual({})
    })

    it('导出 JSON', async () => {
      await customEntriesItem.setValue({ Code: '代码' })
      let blob: Blob | undefined
      vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
        blob = value as Blob
        return 'blob:export'
      })
      const download = vi.fn()
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        download(this.download)
      })
      const wrapper = await render()
      await button(section(wrapper, '自定义词条'), '导出').trigger('click')
      expect(download).toHaveBeenCalledWith(EXPORT_FILE_NAME)
      expect(JSON.parse((await blob?.text()) ?? '')).toEqual({ Code: '代码' })
    })

    it('其他页面修改词条时列表同步', async () => {
      const wrapper = await render()
      await customEntriesItem.setValue({ Wiki: '维基' })
      await settle()
      const entries = section(wrapper, '自定义词条')
      expect(entries.findAll('tbody tr')).toHaveLength(1)
      expect((entries.get('tbody input[aria-label="原文"]').element as HTMLInputElement).value).toBe('Wiki')
    })

    describe('长列表（限高、虚拟列表）', () => {
      /** 列表框可视高度 440；行高按渲染后实测的 tr 高度 50（与估计值 44 不同）：可见 10 行 */
      const HEIGHT = 440
      const ROW = 50

      /** count 条词条；列表里新添加的在前：第 i 行是 Sample text {count - 1 - i} */
      function manyEntries(count: number): Record<string, string> {
        return Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`Sample text ${index}`, `示例文字 ${index}`]),
        )
      }

      function range(start: number, end: number): number[] {
        return Array.from({ length: end - start }, (_, offset) => start + offset)
      }

      function viewportOf(wrapper: VueWrapper): HTMLElement {
        const viewport = section(wrapper, '自定义词条').get('table').element.parentElement
        if (!viewport) throw new Error('未找到列表框')
        return viewport
      }

      /** 已渲染的数据行的序号 */
      function rendered(wrapper: VueWrapper): number[] {
        return section(wrapper, '自定义词条')
          .findAll('tbody tr[data-index]')
          .map((row) => Number(row.attributes('data-index')))
      }

      function inputAt(wrapper: VueWrapper, index: number, label: '原文' | '译文'): HTMLInputElement {
        const input = section(wrapper, '自定义词条').get(`tr[data-index="${index}"] input[aria-label="${label}"]`)
        return input.element as HTMLInputElement
      }

      async function scrollList(wrapper: VueWrapper, top: number): Promise<void> {
        const viewport = viewportOf(wrapper)
        viewport.scrollTop = top
        viewport.dispatchEvent(new Event('scroll'))
        await nextTick()
      }

      /** 在第 index 行的译文框里输入（未提交） */
      async function typeTarget(wrapper: VueWrapper, index: number, value: string): Promise<HTMLInputElement> {
        const element = inputAt(wrapper, index, '译文')
        element.focus()
        element.value = value
        element.dispatchEvent(new Event('input'))
        await nextTick()
        return element
      }

      beforeEach(async () => {
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('entries-viewport') ? HEIGHT : 0
        })
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
          return new DOMRect(0, 0, 0, this.matches('tr[data-index]') ? ROW : 0)
        })
        await customEntriesItem.setValue(manyEntries(200))
      })

      it('只渲染可视范围内的行（行高按实测），其余用占位撑开；表格标出总行数与各行序号，占位对读屏隐藏', async () => {
        const wrapper = await render()
        const entries = section(wrapper, '自定义词条')
        // 可见 10 行，下方多渲染 6 行
        expect(rendered(wrapper)).toEqual(range(0, 16))
        expect(inputAt(wrapper, 0, '原文').value).toBe('Sample text 199')
        expect(entries.get('table').attributes('aria-rowcount')).toBe('201')
        expect(entries.get('thead tr').attributes('aria-rowindex')).toBe('1')
        expect(entries.get('tr[data-index="0"]').attributes('aria-rowindex')).toBe('2')
        const gaps = entries.findAll('tbody tr.entries-gap')
        expect(gaps).toHaveLength(1)
        expect(gaps[0]!.attributes('aria-hidden')).toBe('true')
        expect(gaps[0]!.get('td').attributes('style')).toContain(`height: ${184 * ROW}px`)
      })

      it('列表框限高、框内滚动、不做滚动锚定；表头固定在顶部，键盘切换焦点时滚动留出表头高度', async () => {
        const wrapper = await render()
        const viewport = getComputedStyle(viewportOf(wrapper))
        const head = getComputedStyle(section(wrapper, '自定义词条').get('th').element)
        expect(viewport.maxHeight).toMatch(/^min\(480px, /)
        expect(viewport.overflowY).toBe('auto')
        expect(viewport.overflowAnchor).toBe('none')
        expect(head.position).toBe('sticky')
        expect(head.top).toBe('0px')
        expect(viewport.scrollPaddingTop).toBe(head.height)
      })

      it('滚动时换成对应的行', async () => {
        const wrapper = await render()
        await scrollList(wrapper, 100 * ROW)
        expect(rendered(wrapper)).toEqual(range(94, 116))
        expect(inputAt(wrapper, 100, '原文').value).toBe('Sample text 99')
        expect(section(wrapper, '自定义词条').get('tr[data-index="100"]').attributes('aria-rowindex')).toBe('102')
      })

      it('搜索、添加、导入成功后滚回顶部；添加失败、导入失败、删除词条时位置不变', async () => {
        const wrapper = await render()
        const entries = section(wrapper, '自定义词条')

        await scrollList(wrapper, 100 * ROW)
        await entries.get('input[type="search"]').setValue('Sample text')
        expect(viewportOf(wrapper).scrollTop).toBe(0)
        expect(rendered(wrapper)[0]).toBe(0)
        await entries.get('input[type="search"]').setValue('')

        await scrollList(wrapper, 100 * ROW)
        await entries.get('form input[aria-label="原文"]').setValue('Sample text 5')
        await entries.get('form input[aria-label="译文"]').setValue('示例')
        await entries.get('form').trigger('submit')
        await settle()
        expect(toastTexts(wrapper)).toEqual(['已存在'])
        expect(viewportOf(wrapper).scrollTop).toBe(100 * ROW)

        await entries.get('tr[data-index="100"] button').trigger('click')
        await settle()
        expect((await getCustomEntries())['Sample text 99']).toBeUndefined()
        expect(viewportOf(wrapper).scrollTop).toBe(100 * ROW)
        expect(rendered(wrapper)).toEqual(range(94, 116))

        await entries.get('form input[aria-label="原文"]').setValue('Code')
        await entries.get('form input[aria-label="译文"]').setValue('代码')
        await entries.get('form').trigger('submit')
        await settle()
        expect(viewportOf(wrapper).scrollTop).toBe(0)
        expect(inputAt(wrapper, 0, '原文').value).toBe('Code')

        await scrollList(wrapper, 100 * ROW)
        await chooseFile(wrapper, '["Code"]')
        expect(viewportOf(wrapper).scrollTop).toBe(100 * ROW)
        await chooseFile(wrapper, '{"Issues": "议题"}')
        expect(viewportOf(wrapper).scrollTop).toBe(0)
        expect(inputAt(wrapper, 0, '原文').value).toBe('Issues')
      })

      it('编辑中的行滚出可视范围后连同相邻的行仍在原处，未提交的修改保留并照常提交；失焦后移除', async () => {
        const wrapper = await render()
        const element = await typeTarget(wrapper, 1, '示例')

        await scrollList(wrapper, 100 * ROW)
        expect(rendered(wrapper)).toEqual([0, 1, 2, ...range(94, 116)])
        expect(element.isConnected).toBe(true)
        expect(element.value).toBe('示例')

        element.dispatchEvent(new Event('change'))
        await settle()
        expect((await getCustomEntries())['Sample text 198']).toBe('示例')

        element.blur()
        await nextTick()
        expect(rendered(wrapper)).toEqual(range(94, 116))
      })

      it('编辑中的行在范围下方时一次滚到它下方：这一行不被移动，焦点与未提交的修改保留', async () => {
        const wrapper = await render()
        await scrollList(wrapper, 100 * ROW)
        const element = await typeTarget(wrapper, 100, '未提交')
        await scrollList(wrapper, 0)
        expect(rendered(wrapper)).toEqual([...range(0, 16), 99, 100, 101])

        await scrollList(wrapper, 150 * ROW)
        expect(rendered(wrapper)).toEqual([99, 100, 101, ...range(144, 166)])
        expect(element.isConnected).toBe(true)
        expect(document.activeElement).toBe(element)
        expect(element.value).toBe('未提交')
      })

      it('焦点在范围外的行内移动（如 Tab 到同一行的译文框）：这一行不在焦点移过去之前被移除', async () => {
        const wrapper = await render()
        const sourceInput = inputAt(wrapper, 1, '原文')
        const targetInput = inputAt(wrapper, 1, '译文')
        sourceInput.focus()
        await scrollList(wrapper, 100 * ROW)

        // 浏览器在 focusout 之后、聚焦新元素之前运行微任务，Vue 在此时更新
        sourceInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: targetInput }))
        await nextTick()
        expect(targetInput.isConnected).toBe(true)
        targetInput.focus()
        await nextTick()
        expect(rendered(wrapper)).toEqual([0, 1, 2, ...range(94, 116)])
      })

      it('焦点行在范围外时用键盘删除：原位置这一条保留渲染，焦点移到它的删除按钮', async () => {
        const wrapper = await render()
        const entries = section(wrapper, '自定义词条')
        entries.get<HTMLButtonElement>('tr[data-index="1"] button').element.focus()
        await scrollList(wrapper, 100 * ROW)

        await pressButton(entries, 'tr[data-index="1"] button')
        expect((await getCustomEntries())['Sample text 198']).toBeUndefined()
        expect(document.activeElement?.getAttribute('aria-label')).toBe('删除 Sample text 197')
        expect(document.activeElement?.closest('tr')?.dataset.index).toBe('1')
      })

      it('编辑中途其他页面添加了词条（排在最前）：编辑中的行仍保留，序号随之变，修改不丢', async () => {
        const wrapper = await render()
        const element = await typeTarget(wrapper, 1, '示例')
        await scrollList(wrapper, 100 * ROW)

        await customEntriesItem.setValue({ ...manyEntries(200), Wiki: '维基' })
        await settle()
        expect(element.isConnected).toBe(true)
        expect(element.value).toBe('示例')
        expect(element.closest('tr')?.dataset.index).toBe('2')
      })
    })
  })
})
