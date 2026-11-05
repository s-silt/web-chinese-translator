import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { mount, flushPromises } from '@vue/test-utils'
import TranslationSection from '../../../src/entrypoints/options/TranslationSection.vue'
import en from '../../../src/i18n/en'
import zhCN from '../../../src/i18n/zh-CN'
import { clearToasts, useToasts } from '../../../src/components/toast'
import { applyUiPreferences } from '../../../src/components/ui-preferences'
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from '../../../src/translation/config'

const CONFIG: TranslationConfig = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
}

function replies(map: Record<string, (message: Record<string, unknown>) => unknown>): void {
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
    const body = message as Record<string, unknown>
    const handler = map[body.type as string]
    return handler !== undefined ? handler(body) : { ok: false, error: 'x' }
  })
}

function floatingSwitch(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('[data-test="wt-floating-toggle"] [role="switch"]')
}

beforeEach(() => {
  fakeBrowser.reset()
  clearToasts()
  applyUiPreferences({ uiLanguage: 'auto', theme: 'auto', uiStyle: 'classic' })
  document.body.textContent = ''
})

describe('悬浮入口选项', () => {
  it('默认显示悬浮入口，显式授权不改写配置', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        return { ok: true, config: CONFIG, keyState: 'ready' }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => false)
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      expect(wrapper.text()).toContain(en.wtTargetLanguageHint)
      expect(wrapper.text()).toContain(en.wtFloatingHint)
      expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('true')
      expect(request).not.toHaveBeenCalled()
      expect(saved).toHaveLength(0)
      await wrapper.get('[data-test="wt-floating-grant"]').trigger('click')
      await flushPromises()
      expect(request).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] })
      expect(saved).toHaveLength(0)
      expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('true')
      expect(wrapper.get('[data-test="wt-floating-grant"]').text()).toBe(en.wtFloatingGranted)
      expect(wrapper.get('[data-test="wt-floating-grant"]').attributes('disabled')).toBeDefined()
    } finally {
      wrapper.unmount()
    }
  })

  it('拒绝全站权限不改写显示偏好，授权按钮恢复可用', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        return { ok: true, config: CONFIG, keyState: 'ready' }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => false)
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => false)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-floating-grant"]').trigger('click')
      await flushPromises()
      expect(saved).toHaveLength(0)
      expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('true')
      expect(wrapper.get('[role="status"]').text()).toBe(en.wtPermissionDenied)
      expect(wrapper.get('[data-test="wt-floating-grant"]').attributes('disabled')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })

  it('关闭不申请也不撤销权限', async () => {
    const saved: Record<string, unknown>[] = []
    const initial = { ...CONFIG, floatingButtonEnabled: true }
    replies({
      'wt:get-config': () => ({ ok: true, config: initial, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        const patch = message.patch as Record<string, unknown>
        return { ok: true, config: { ...initial, ...patch }, keyState: 'ready' }
      },
    })
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const remove = vi.spyOn(fakeBrowser.permissions, 'remove').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('true')
    await floatingSwitch(wrapper).trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(saved.map((message) => message.patch)).toEqual([{ floatingButtonEnabled: false }])
    expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('保存失败时开关保持已存储的值', async () => {
    const initial = { ...CONFIG, floatingButtonEnabled: false }
    replies({
      'wt:get-config': () => ({ ok: true, config: initial, keyState: 'ready' }),
      'wt:save-config': () => ({ ok: false, error: 'nope' }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await floatingSwitch(wrapper).trigger('click')
    await flushPromises()
    expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('false')
    expect(useToasts().value.map((toast) => toast.key)).toContain('saveFailed')
    wrapper.unmount()
  })

  it('保存完成前不提前拨动开关', async () => {
    const initial = { ...CONFIG, floatingButtonEnabled: false }
    let release: (value: unknown) => void = () => undefined
    const pending = new Promise((resolve) => {
      release = resolve
    })
    replies({
      'wt:get-config': () => ({ ok: true, config: initial, keyState: 'ready' }),
      'wt:save-config': () => pending,
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await floatingSwitch(wrapper).trigger('click')
    await flushPromises()
    expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('false')
    release({ ok: true, config: { ...initial, floatingButtonEnabled: true }, keyState: 'ready' })
    await flushPromises()
    expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('悬浮开关和工具栏模式互不改写', async () => {
    const saved: Record<string, unknown>[] = []
    let current: TranslationConfig = { ...CONFIG, floatingButtonEnabled: false }
    replies({
      'wt:get-config': () => ({ ok: true, config: current, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        const patch = message.patch as Partial<TranslationConfig>
        current = { ...current, ...patch }
        return { ok: true, config: current, keyState: 'ready' }
      },
    })
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await floatingSwitch(wrapper).trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    await wrapper.find('[data-test="wt-assist-mode"]').trigger('click')
    const toolbar = wrapper.findAll('[role="option"]').find((option) => option.text() === en.wtModeToolbar)
    await toolbar?.trigger('click')
    await flushPromises()
    expect(saved.map((message) => message.patch)).toEqual([
      { floatingButtonEnabled: true },
      { selectionPopupEnabled: true, selectionToolbarEnabled: true, proactiveAssistEnabled: false },
    ])
    expect(floatingSwitch(wrapper).attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })
})

describe('快捷键展示与管理', () => {
  it('commands.getAll 返回三项时渲染三行，空 shortcut 显示未设置，点击管理调用 tabs.create', async () => {
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
    })
    vi.spyOn(fakeBrowser.commands, 'getAll').mockResolvedValue([
      { name: 'toggle-page-translation', shortcut: 'Alt+T' },
      { name: 'translate-selection', shortcut: '' },
      { name: 'translate-input', shortcut: 'Alt+Y' },
      { name: '_execute_action', shortcut: 'Alt+A' },
    ] as never)
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    const block = wrapper.get('[data-test="wt-shortcuts"]')
    const items = block.findAll('.wt-shortcut-list > li')
    expect(items).toHaveLength(3)
    expect(items[0]!.text()).toContain(en.wtCmdTogglePage)
    expect(items[0]!.get('kbd').text()).toBe('Alt+T')
    expect(items[1]!.text()).toContain(en.wtCmdTranslateSelection)
    expect(items[1]!.get('kbd').text()).toBe(en.wtShortcutUnset)
    expect(items[2]!.text()).toContain(en.wtCmdTranslateInput)
    expect(items[2]!.get('kbd').text()).toBe('Alt+Y')
    await wrapper.get('[data-test="wt-shortcuts-manage"]').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' })
    wrapper.unmount()
  })

  it('commands.getAll 不存在时整块不渲染', async () => {
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
    })
    const original = fakeBrowser.commands
    Object.defineProperty(fakeBrowser, 'commands', { value: undefined, configurable: true, writable: true })
    try {
      const wrapper = mount(TranslationSection)
      await flushPromises()
      expect(wrapper.find('[data-test="wt-shortcuts"]').exists()).toBe(false)
      wrapper.unmount()
    } finally {
      Object.defineProperty(fakeBrowser, 'commands', { value: original, configurable: true, writable: true })
    }
  })

  it('切换 uiLanguage 为 en 后两行标签变为英文文案', async () => {
    applyUiPreferences({ uiLanguage: 'zh-CN', theme: 'auto', uiStyle: 'classic' })
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
    })
    vi.spyOn(fakeBrowser.commands, 'getAll').mockResolvedValue([
      { name: 'toggle-page-translation', shortcut: 'Alt+T' },
      { name: 'translate-selection', shortcut: 'Alt+S' },
      { name: 'translate-input', shortcut: 'Alt+Y' },
    ] as never)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    const items = wrapper.get('[data-test="wt-shortcuts"]').findAll('.wt-shortcut-list > li > span')
    expect(items.map((item) => item.text())).toEqual([zhCN.wtCmdTogglePage, zhCN.wtCmdTranslateSelection, zhCN.wtCmdTranslateInput])
    applyUiPreferences({ uiLanguage: 'en', theme: 'auto', uiStyle: 'classic' })
    await flushPromises()
    expect(items.map((item) => item.text())).toEqual([en.wtCmdTogglePage, en.wtCmdTranslateSelection, en.wtCmdTranslateInput])
    wrapper.unmount()
  })

  it('切换语言同步更新接口类型、请求地址预览和高级设置标签，无关回复省略 customHeadersState 时保留已保存状态', async () => {
    applyUiPreferences({ uiLanguage: 'zh-CN', theme: 'auto', uiStyle: 'classic' })
    replies({
      'wt:get-config': () => ({
        ok: true,
        config: {
          ...CONFIG,
          customHeadersRevision: '11111111-1111-4111-8111-111111111111',
        },
        keyState: 'ready',
        customHeadersState: 'ready',
      }),
      'wt:save-config': (message) => ({
        ok: true,
        config: {
          ...CONFIG,
          customHeadersRevision: '11111111-1111-4111-8111-111111111111',
          ...(message.patch as Partial<TranslationConfig>),
        },
        keyState: 'ready',
      }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      expect(wrapper.text()).toContain(zhCN.wtApiType)
      expect(wrapper.get('[data-test="wt-endpoint-preview"]').text()).toContain(zhCN.wtEndpointPreview)
      expect(wrapper.get('[data-test="wt-advanced"]').text()).toContain(zhCN.wtAdvanced)
      expect(wrapper.text()).toContain(zhCN.wtCustomHeadersSaved)

      await floatingSwitch(wrapper).trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain(zhCN.wtCustomHeadersSaved)

      applyUiPreferences({ uiLanguage: 'en', theme: 'auto', uiStyle: 'classic' })
      await flushPromises()
      expect(wrapper.text()).toContain(en.wtApiType)
      expect(wrapper.get('[data-test="wt-endpoint-preview"]').text()).toContain(en.wtEndpointPreview)
      expect(wrapper.get('[data-test="wt-advanced"]').text()).toContain(en.wtAdvanced)
      expect(wrapper.text()).toContain(en.wtCustomHeadersSaved)
    } finally {
      wrapper.unmount()
    }
  })
})

describe('视频字幕与输入翻译开关与权限', () => {
  it('默认关闭并展示功能说明与限制，启用时申请全站权限，拒绝时不保存，关闭时不申请权限', async () => {
    applyUiPreferences({ uiLanguage: 'zh-CN', theme: 'auto', uiStyle: 'classic' })
    const saved: Record<string, unknown>[] = []
    let current: TranslationConfig = { ...CONFIG }
    replies({
      'wt:get-config': () => ({ ok: true, config: current, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        current = { ...current, ...(message.patch as Partial<TranslationConfig>) }
        return { ok: true, config: current, keyState: 'ready' }
      },
    })
    let denyNextRequest = true
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => {
      if (denyNextRequest) {
        denyNextRequest = false
        return false
      }
      return true
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      expect(wrapper.text()).toContain(zhCN.wtVideoSubtitles)
      expect(wrapper.text()).toContain(zhCN.wtVideoSubtitlesHint)
      expect(wrapper.text()).toContain(zhCN.wtInputTranslation)
      expect(wrapper.text()).toContain(zhCN.wtInputTranslationHint)

      const subToggle = wrapper.get('[data-test="wt-video-subtitles-toggle"] [role="switch"]')
      const inToggle = wrapper.get('[data-test="wt-input-translation-toggle"] [role="switch"]')
      expect(subToggle.attributes('aria-checked')).toBe('false')
      expect(inToggle.attributes('aria-checked')).toBe('false')

      await subToggle.trigger('click')
      await flushPromises()
      expect(request).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] })
      expect(saved).toHaveLength(0)
      expect(subToggle.attributes('aria-checked')).toBe('false')
      expect(wrapper.get('[role="status"]').text()).toBe(zhCN.wtPermissionDenied)

      await subToggle.trigger('click')
      await flushPromises()
      expect(subToggle.attributes('aria-checked')).toBe('true')
      expect(saved.at(-1)?.patch).toEqual({ videoSubtitlesEnabled: true })

      await inToggle.trigger('click')
      await flushPromises()
      expect(inToggle.attributes('aria-checked')).toBe('true')
      expect(saved.at(-1)?.patch).toEqual({ inputTranslationEnabled: true })

      request.mockClear()
      await subToggle.trigger('click')
      await flushPromises()
      expect(request).not.toHaveBeenCalled()
      expect(subToggle.attributes('aria-checked')).toBe('false')
      expect(saved.at(-1)?.patch).toEqual({ videoSubtitlesEnabled: false })
    } finally {
      wrapper.unmount()
    }
  })
})
