import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { mount, flushPromises } from '@vue/test-utils'
import { mergeSettings } from '../../../src/shared/settings'
import { applyUiStyle, applyUiPreferences, PREFERENCES_CACHE_KEY } from '../../../src/components/ui-preferences'
import AppearanceSection from '../../../src/entrypoints/options/AppearanceSection.vue'

beforeEach(() => {
  fakeBrowser.reset()
  document.body.textContent = ''
  document.documentElement.removeAttribute('data-style')
  localStorage.clear()
})

describe('uiStyle 设置项', () => {
  it('非法值回落 classic', () => {
    expect(mergeSettings({ uiStyle: 'neon' }).uiStyle).toBe('classic')
    expect(mergeSettings({ uiStyle: 'cyber' }).uiStyle).toBe('cyber')
    expect(mergeSettings({ uiStyle: 'glass' }).uiStyle).toBe('glass')
    expect(mergeSettings(null).uiStyle).toBe('classic')
  })
})

describe('applyUiStyle / 缓存', () => {
  it('cyber/glass 写 data-style，classic 移除', () => {
    applyUiStyle('cyber')
    expect(document.documentElement.dataset.style).toBe('cyber')
    applyUiStyle('glass')
    expect(document.documentElement.dataset.style).toBe('glass')
    applyUiStyle('classic')
    expect(document.documentElement.dataset.style).toBeUndefined()
  })

  it('applyUiPreferences 缓存往返含 uiStyle', () => {
    applyUiPreferences({ uiLanguage: 'auto', theme: 'auto', uiStyle: 'cyber' })
    expect(document.documentElement.dataset.style).toBe('cyber')
    expect(JSON.parse(localStorage.getItem(PREFERENCES_CACHE_KEY) ?? '{}')).toMatchObject({ uiStyle: 'cyber' })
  })
})

describe('AppearanceSection', () => {
  it('两个选择器存在；改风格发出 updateSettings patch；cyber 下外观禁用', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    const wrapper = mount(AppearanceSection)
    await flushPromises()
    expect(wrapper.find('[data-test="wt-ui-style"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="wt-theme"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
