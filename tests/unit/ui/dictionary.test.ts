import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { mount, flushPromises } from '@vue/test-utils'
import DictionarySection from '../../../src/entrypoints/options/DictionarySection.vue'
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from '../../../src/translation/config'
import { customDictionariesItem } from '../../../src/translation/custom-dictionaries'
import { BUILTIN_DICTIONARY_META, DICTIONARY_CATEGORIES } from '../../../src/translation/dictionaries/index'
import { useToasts } from '../../../src/components/toast'

const CONFIG: TranslationConfig = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
}

function replies(map: Record<string, (m: Record<string, unknown>) => unknown>): void {
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
    const m = message as Record<string, unknown>
    const handler = map[m.type as string]
    return handler !== undefined ? handler(m) : { ok: false, error: 'x' }
  })
}

beforeEach(async () => {
  fakeBrowser.reset()
  document.body.textContent = ''
  await customDictionariesItem.setValue([])
})

function mountSection() {
  replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }) })
  return mount(DictionarySection)
}

describe('DictionarySection', () => {
  it('渲染内置词典与自定义词典列表', async () => {
    await customDictionariesItem.setValue([
      { id: 'custom:a1b2c3d4', label: 'My dict', hosts: ['tools.example.com'], entries: { A: '甲' }, enabled: true },
    ])
    const patches: Array<Record<string, unknown>> = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:save-config': (m) => {
        const patch = m.patch as Partial<TranslationConfig>
        patches.push(patch as Record<string, unknown>)
        return { ok: true, config: { ...CONFIG, ...patch }, keyState: 'ready' }
      },
    })
    const wrapper = mount(DictionarySection)
    await flushPromises()
    const groups = wrapper.findAll('[data-test^="wt-dict-group-"]')
    expect(groups.map((g) => g.attributes('data-test'))).toEqual(
      DICTIONARY_CATEGORIES.map((category) => `wt-dict-group-${category}`),
    )
    expect(BUILTIN_DICTIONARY_META).toHaveLength(26)
    expect(wrapper.findAll('.wt-builtin-card')).toHaveLength(26)
    for (const meta of BUILTIN_DICTIONARY_META) {
      const switches = wrapper.findAll(`[data-test="wt-dict-${meta.id}"] [role="switch"]`)
      expect(switches).toHaveLength(1)
      const inGroup = wrapper.get(`[data-test="wt-dict-group-${meta.category}"] [data-test="wt-dict-${meta.id}"] [role="switch"]`)
      expect(inGroup.attributes('aria-checked')).toBe('true')
    }
    expect(wrapper.find('[data-test="wt-dict-group-ai-model"] [data-test="wt-dict-openrouter"] [role="switch"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="wt-dict-group-cloud"] [data-test="wt-dict-railway"] [role="switch"]').exists()).toBe(true)
    for (const retired of ['gitlab', 'reddit', 'chatgpt']) {
      expect(wrapper.find(`[data-test="wt-dict-${retired}"]`).exists()).toBe(false)
    }
    expect(wrapper.text()).not.toContain('GitLab')
    expect(wrapper.text()).not.toContain('Reddit')
    expect(wrapper.text()).not.toContain('ChatGPT')
    expect(wrapper.get('[data-test="wt-dict-devin"]').find('[role="switch"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="wt-dict-cursor"]').find('[role="switch"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="wt-custom-dict-custom:a1b2c3d4"]').text()).toContain('My dict')
    expect(wrapper.get('[data-test="wt-custom-dict-custom:a1b2c3d4"]').text()).toContain('tools.example.com')

    const openrouterSwitch = wrapper.get('[data-test="wt-dict-openrouter"]').find('[role="switch"]')
    await openrouterSwitch.trigger('click')
    await flushPromises()
    expect(patches).toEqual([{ disabledDictionaries: ['openrouter'] }])
    expect(openrouterSwitch.attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('新建表单缺名称与无效行计数提示且不保存', async () => {
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-test="wt-dict-new"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="wt-dict-entries"]').setValue('Settings = 设置\nbroken line\n= empty')
    await wrapper.get('[data-test="wt-dict-save"]').trigger('submit')
    await flushPromises()
    expect(useToasts().value.at(-1)?.key).toBe('wtDictionaryLimit')
    expect(await customDictionariesItem.getValue()).toHaveLength(0)
    await wrapper.get('[data-test="wt-dict-name"]').setValue('X')
    await wrapper.get('[data-test="wt-dict-hosts"]').setValue('tools.example.com')
    await wrapper.get('[data-test="wt-dict-save"]').trigger('submit')
    await flushPromises()
    expect(useToasts().value.at(-1)?.key).toBe('wtDictionaryInvalidLines')
    expect(useToasts().value.at(-1)?.params).toMatchObject({ count: 2 })
    expect(await customDictionariesItem.getValue()).toHaveLength(0)
    wrapper.unmount()
  })

  it('权限拒绝时不保存自定义词典开关与表单', async () => {
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => false)
    await customDictionariesItem.setValue([
      { id: 'custom:a1b2c3d4', label: 'D', hosts: ['tools.example.com'], entries: { A: '甲' }, enabled: false },
    ])
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-test="wt-dict-enabled-custom:a1b2c3d4"]').find('[role="switch"]').trigger('click')
    await flushPromises()
    expect((await customDictionariesItem.getValue())[0]?.enabled).toBe(false)
    expect(useToasts().value.at(-1)?.key).toBe('wtPermissionDenied')
    wrapper.unmount()
  })

  it('导入 JSON 填充新建表单', async () => {
    const wrapper = mountSection()
    await flushPromises()
    const file = new File(
      [JSON.stringify({ label: 'Imported', hosts: ['docs.example.com'], entries: { Deploy: '部署' } })],
      'd.json',
      { type: 'application/json' },
    )
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect((wrapper.get('[data-test="wt-dict-name"]').element as HTMLInputElement).value).toBe('Imported')
    expect((wrapper.get('[data-test="wt-dict-hosts"]').element as HTMLInputElement).value).toContain('docs.example.com')
    expect((wrapper.get('[data-test="wt-dict-entries"]').element as HTMLTextAreaElement).value).toContain('Deploy = 部署')
    wrapper.unmount()
  })
})
