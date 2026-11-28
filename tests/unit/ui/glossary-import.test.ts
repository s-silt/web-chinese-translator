import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { clearToasts, useToasts } from '../../../src/components/toast'
import ToolsSection from '../../../src/entrypoints/options/ToolsSection.vue'
import { DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import type { TranslationMessage, TranslationReply } from '../../../src/translation/messages'
import { MAX_PROMPT_GLOSSARY, type PromptGlossaryEntry } from '../../../src/translation/preferences-extra'
import { emptyUsageStats } from '../../../src/translation/usage-stats'

type Save = Extract<TranslationMessage, { type: 'wt:save-config' }>

async function openImporter(
  read: () => PromptGlossaryEntry[],
  save: (message: Save) => Promise<TranslationReply<'wt:save-config'>>,
) {
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (raw: unknown) => {
    const message = raw as TranslationMessage
    if (message.type === 'wt:get-config') return { ok: true, config: { ...DEFAULT_TRANSLATION_CONFIG, promptGlossary: read() }, keyState: 'none' }
    if (message.type === 'wt:get-usage-stats') return { ok: true, usageStats: emptyUsageStats() }
    if (message.type === 'wt:get-cache-stats') return { ok: true, cacheStats: { entries: 0, expired: 0, approxBytes: 0, hosts: [] } }
    if (message.type === 'wt:save-config') return save(message)
    throw new Error(message.type)
  })
  const wrapper = mount(ToolsSection)
  await flushPromises()
  await wrapper.get('[data-test="wt-glossary-bulk-toggle"]').trigger('click')
  return {
    wrapper,
    input: wrapper.get<HTMLTextAreaElement>('[data-test="wt-glossary-bulk-input"]'),
    submit: wrapper.get('[data-test="wt-glossary-bulk-import"]'),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  clearToasts()
  fakeBrowser.reset()
})

describe('批量导入术语', () => {
  it('拒绝部分无效或合并后超过上限的草稿', async () => {
    const full = Array.from({ length: MAX_PROMPT_GLOSSARY }, (_, i) => ({ source: String(i), target: '目标' }))
    const save = vi.fn()
    const { wrapper, input, submit } = await openImporter(() => full, save)
    try {
      for (const [draft, key] of [
        ['new = 好\ninvalid', 'wtGlossaryInvalidLine'],
        ['# note', 'wtGlossaryEmpty'],
        ['5 = 覆盖\nnew = 新增', 'wtGlossaryLimit'],
      ] as const) {
        await input.setValue(draft)
        await submit.trigger('click')
        expect(input.element.value).toBe(draft)
        expect(useToasts().value.at(-1)?.key).toBe(key)
      }
      expect(save).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('在冲突时保留输入，重试时合并其他窗口的术语，保存过程中保留新草稿', async () => {
    let current = [{ source: 'local', target: '本地' }]
    const incoming = [{ source: 'remote', target: '其他窗口' }]
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const save = vi.fn(async (message: Save): Promise<TranslationReply<'wt:save-config'>> => {
      if (save.mock.calls.length === 1) {
        current = incoming
        return { ok: false, code: 'glossary-conflict', error: 'conflict' }
      }
      await pending
      return { ok: true, config: { ...DEFAULT_TRANSLATION_CONFIG, ...message.patch }, keyState: 'none' }
    })
    const { wrapper, input, submit } = await openImporter(() => current, save)
    try {
      const draft = 'Token = 词元'
      await input.setValue(draft)
      await submit.trigger('click')
      await flushPromises()
      expect(save.mock.calls[0]?.[0].expectedGlossary).toEqual([{ source: 'local', target: '本地' }])
      expect(wrapper.get('[data-test="wt-glossary-list"]').text()).toContain('其他窗口')
      expect(useToasts().value.at(-1)?.key).toBe('wtGlossaryConflict')
      expect(input.element.value).toBe(draft)
      await submit.trigger('click')
      await flushPromises()
      expect(save.mock.calls[1]?.[0]).toMatchObject({
        expectedGlossary: incoming, patch: { promptGlossary: [...incoming, { source: 'Token', target: '词元' }] },
      })
      expect(submit.attributes('disabled')).toBeDefined()
      await input.setValue('draft = 继续编辑')
      finish()
      await flushPromises()
      expect(wrapper.get('[data-test="wt-glossary-bulk-input"]').element).toBe(input.element)
      expect(input.element.value).toBe('draft = 继续编辑')
      expect(useToasts().value.at(-1)).toMatchObject({ key: 'wtGlossaryImported', params: { count: 1 } })
    } finally {
      finish()
      wrapper.unmount()
    }
  })
})
