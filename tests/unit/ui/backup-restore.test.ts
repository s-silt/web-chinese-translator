import { flushPromises, mount } from '@vue/test-utils'
import { isProxy } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import ToolsSection from '../../../src/entrypoints/options/ToolsSection.vue'
import { DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import { exportConfigBackup } from '../../../src/translation/config-backup'
import type { TranslationConfigPatch } from '../../../src/translation/messages'
import { emptyUsageStats } from '../../../src/translation/usage-stats'

const backup = {
  ...DEFAULT_TRANSLATION_CONFIG, baseUrl: 'https://model.fixture.test/v1', model: 'offline',
  selectionPopupEnabled: true, displayMode: 'bilingual' as const, promptGlossary: [{ source: 'ID', target: '标识' }],
}

beforeEach(() => fakeBrowser.reset())

describe('全新安装恢复备份', () => {
  it.each([false, true])('先预览，用户明确授权（%s）后分别恢复可用设置', async granted => {
    let allowed = false
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => allowed)
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async ({ origins }) => {
      // Chrome 的原生类型校验将 Vue Proxy 数组视为普通对象。
      if (isProxy(origins)) throw new TypeError('Expected native array')
      allowed = granted
      return allowed
    })
    const saved: TranslationConfigPatch[] = []
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const { type, patch } = message as { type: string; patch: TranslationConfigPatch }
      if (type === 'wt:get-usage-stats') return { ok: true, usageStats: emptyUsageStats() }
      if (type === 'wt:get-cache-stats') return { ok: true, cacheStats: { entries: 0, expired: 0, approxBytes: 0, hosts: [] } }
      if (type === 'wt:save-config') {
        if (!allowed && (patch.baseUrl || patch.selectionPopupEnabled)) return { ok: false, error: '未授权' }
        saved.push(patch)
      }
      return { ok: true, config: { ...DEFAULT_TRANSLATION_CONFIG, ...patch }, keyState: 'none' }
    })
    const wrapper = mount(ToolsSection)
    try {
      await flushPromises()
      const input = wrapper.get('[data-test="wt-backup-file"]')
      Object.defineProperty(input.element, 'files', { value: [new File([exportConfigBackup(backup)], 'settings.json')] })
      await input.trigger('change')
      await flushPromises()
      expect(wrapper.get('[data-test="wt-backup-preview"]').text()).toContain('https://model.fixture.test/*')
      expect(saved).toHaveLength(0)
      expect(request).not.toHaveBeenCalled()
      await wrapper.get('[data-test="wt-backup-confirm"]').trigger('click')
      await flushPromises()
      expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://model.fixture.test/*', 'http://*/*', 'https://*/*'] })
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({ displayMode: 'bilingual', promptGlossary: backup.promptGlossary })
      if (granted) {
        expect(saved[0]).toMatchObject({ baseUrl: backup.baseUrl, model: backup.model, selectionPopupEnabled: true })
      } else {
        expect(saved[0]).not.toHaveProperty('baseUrl')
        expect(saved[0]).not.toHaveProperty('selectionPopupEnabled')
        expect(wrapper.get('[data-test="wt-backup-partial"]').text()).toContain('https://model.fixture.test/*')
      }
    } finally {
      wrapper.unmount()
    }
  })
})
