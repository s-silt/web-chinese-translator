import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import TranslationSection from '../../../src/entrypoints/options/TranslationSection.vue'
import { connectionKindFromReply } from '../../../src/entrypoints/options/connection-status'
import TranslationControls from '../../../src/entrypoints/popup/TranslationControls.vue'
import PageStatusCard from '../../../src/entrypoints/popup/PageStatusCard.vue'
import { provideTranslationControls, WT_STATE_MESSAGE } from '../../../src/entrypoints/popup/useTranslationControls'
import { STATUS_POLL_MS } from '../../../src/entrypoints/popup/usePopup'
import en from '../../../src/i18n/en'
import { settingsItem, DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from '../../../src/translation/config'
import { EXCLUDED_LIMIT_ERROR } from '../../../src/translation/page-policy'
import { requestOptionsKey } from '../../../src/translation/request-options'
import { clearToasts, useToasts } from '../../../src/components/toast'

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

async function availableModels(wrapper: VueWrapper): Promise<string[]> {
  const input = wrapper.get('[data-test="wt-model-input"]')
  if (input.attributes('aria-expanded') === 'true') await input.trigger('keydown', { key: 'Escape' })
  await wrapper.get('[data-test="wt-model-menu"]').trigger('click')
  return wrapper.findAll('[data-test="wt-model-options"] [role="option"]').map((option) => option.text())
}

beforeEach(() => {
  fakeBrowser.reset()
  localStorage.removeItem('gcn:popup-more-open')
  document.body.textContent = ''
})

describe('选项页真实挂载', () => {
  it('自动弹窗一击保存且重载保留，不覆盖连接草稿或弹成功提示', async () => {
    clearToasts()
    let current = { ...CONFIG }
    const patches: unknown[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: current, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        patches.push(message.patch)
        current = { ...current, ...(message.patch as Partial<TranslationConfig>) }
        return { ok: true, config: current, hasKey: true, keyState: 'ready' }
      },
    })
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.find('input').setValue('https://draft.example.com/v1')
    await wrapper.get('[data-test="wt-auto-interaction"] [role="switch"]').trigger('click')
    await flushPromises()
    expect(patches).toEqual([{ autoInteractionEnabled: false }])
    expect(wrapper.get('[data-test="wt-auto-interaction"] [role="switch"]').attributes('aria-checked')).toBe('false')
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('https://draft.example.com/v1')
    expect(useToasts().value).toEqual([])
    wrapper.unmount()
    const reloaded = mount(TranslationSection)
    await flushPromises()
    expect(reloaded.get('[data-test="wt-auto-interaction"] [role="switch"]').attributes('aria-checked')).toBe('false')
    reloaded.unmount()
    const popup = mount(TranslationControls)
    await flushPromises()
    await flushPromises()
    expect(popup.get('[data-test="wt-popup-auto-interaction"] [role="switch"]').attributes('aria-checked')).toBe('false')
    await popup.get('[data-test="wt-popup-auto-interaction"] [role="switch"]').trigger('click')
    await flushPromises()
    expect(patches).toEqual([{ autoInteractionEnabled: false }, { autoInteractionEnabled: true }])
    expect(popup.get('[data-test="wt-popup-auto-interaction"] [role="switch"]').attributes('aria-checked')).toBe('true')
    popup.unmount()
  })

  it('排除列表保存期间拒绝第二次增删，且不申请网站权限', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => { release = resolve })
    const saved: Record<string, unknown>[] = []
    const initial = { ...CONFIG, excludedHosts: ['existing.example'] }
    replies({
      'wt:get-config': () => ({ ok: true, config: initial, keyState: 'ready' }),
      'wt:set-site-excluded': (message) => { saved.push(message); return pending },
    })
    const permission = vi.spyOn(fakeBrowser.permissions, 'request')
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.get('[data-test="wt-excluded-input"]').setValue('private.example')
    await wrapper.get('[data-test="wt-excluded-add"]').trigger('click')
    await wrapper.get('[data-test="wt-excluded-add"]').trigger('click')
    await wrapper.get('[data-test="wt-excluded-remove"]').trigger('click')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toEqual({ type: 'wt:set-site-excluded', host: 'private.example', excluded: true })
    expect(wrapper.get('[data-test="wt-excluded-add"]').attributes('disabled')).toBeDefined()
    release({ ok: true, config: { ...initial, excludedHosts: ['existing.example', 'private.example'] }, keyState: 'ready' })
    await flushPromises()
    expect(wrapper.findAll('[data-test="wt-excluded-host"]').map((row) => row.text())).toEqual([
      'existing.example', 'private.example',
    ])
    expect(wrapper.get('[data-test="wt-excluded-add"]').attributes('disabled')).toBeUndefined()
    expect(permission).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('两个设置窗口只发送单站点操作并采用最新列表', async () => {
    const calls: Record<string, unknown>[] = []
    const configs = [
      { ...CONFIG, excludedHosts: ['a.example'] },
      { ...CONFIG, excludedHosts: ['a.example', 'b.example'] },
      { ...CONFIG, excludedHosts: ['b.example'] },
    ]
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:set-site-excluded': (message) => {
        calls.push(message)
        return { ok: true, config: configs[calls.length - 1], keyState: 'ready' }
      },
    })
    const first = mount(TranslationSection)
    const second = mount(TranslationSection)
    try {
      await flushPromises()
      await first.get('[data-test="wt-excluded-input"]').setValue('a.example')
      await first.get('[data-test="wt-excluded-add"]').trigger('click')
      await flushPromises()
      await second.get('[data-test="wt-excluded-input"]').setValue('b.example')
      await second.get('[data-test="wt-excluded-add"]').trigger('click')
      await flushPromises()
      expect(second.findAll('[data-test="wt-excluded-host"]').map((row) => row.text())).toEqual(['a.example', 'b.example'])
      await first.get('[data-test="wt-excluded-remove"]').trigger('click')
      await flushPromises()
      expect(calls).toEqual([
        { type: 'wt:set-site-excluded', host: 'a.example', excluded: true },
        { type: 'wt:set-site-excluded', host: 'b.example', excluded: true },
        { type: 'wt:set-site-excluded', host: 'a.example', excluded: false },
      ])
      expect(first.findAll('[data-test="wt-excluded-host"]').map((row) => row.text())).toEqual(['b.example'])
    } finally {
      first.unmount()
      second.unmount()
    }
  })

  it('保存并连接使用统一截止时间并忽略迟到回复', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:test': () => pending,
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await vi.advanceTimersByTimeAsync(0)
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await vi.advanceTimersByTimeAsync(0)
      expect(wrapper.get('[data-test="wt-save"]').attributes('disabled')).toBeDefined()
      await vi.advanceTimersByTimeAsync(31_000)
      expect(wrapper.get('[data-test="wt-save"]').attributes('disabled')).toBeDefined()
      await vi.advanceTimersByTimeAsync(19_000)
      expect(wrapper.get('[data-test="wt-save"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.text()).toContain('后台响应超时，请重试')
      release({ ok: true, texts: ['ok'] })
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
      expect(wrapper.text()).toContain('后台响应超时，请重试')
      expect(wrapper.text()).not.toContain(en.wtSavedOk)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('模式切换回复不覆盖未保存的接口/密钥草稿', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (m) => {
        saved.push(m)
        return { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
      },
      'wt:test': () => ({ ok: true, texts: ['ok'] }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.find('input').setValue('https://draft.example.com/v1')
    const inputs = wrapper.findAll('input')
    await inputs[1]?.setValue('sk-draft')
    await inputs[2]?.setValue('draft-model')
    await wrapper.find('[data-test="wt-assist-mode"]').trigger('click')
    const option = wrapper.findAll('[role="option"]').find((o) => o.text() === en.wtModeSelection)
    await option?.trigger('click')
    await flushPromises()
    expect(saved[0]?.patch).toEqual({
      selectionPopupEnabled: true,
      selectionToolbarEnabled: false,
      proactiveAssistEnabled: false,
    })
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('https://draft.example.com/v1')
    expect((inputs[2]?.element as HTMLInputElement).value).toBe('draft-model')
    expect((inputs[1]?.element as HTMLInputElement).value).toBe('sk-draft')
  })

  it('smart 选择后直接保存，没有确认或取消弹窗', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        return { ok: true, config: { ...CONFIG, ...(message.patch as object) }, hasKey: true, keyState: 'ready' }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.find('[data-test="wt-assist-mode"]').trigger('click')
    const smart = wrapper.findAll('[role="option"]').find((o) => o.text() === en.wtModeSmart)
    await smart?.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="wt-smart-confirm"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="wt-smart-cancel"]').exists()).toBe(false)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.patch).toEqual({ selectionPopupEnabled: true, selectionToolbarEnabled: false, proactiveAssistEnabled: true })
    const select = wrapper.find('[data-test="wt-assist-mode"]')
    expect(select.text()).toContain(en.wtModeSmart)
    wrapper.unmount()
  })

  it('密钥状态不可用仍显示删除并可清除', async () => {
    let cleared = false
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'unavailable' }),
      'wt:clear-key': () => {
        cleared = true
        return { ok: true, hasKey: false, keyState: 'none' }
      },
    })
    const wrapper = mount(TranslationSection)
    await flushPromises()
    const del = wrapper.find('[data-test="wt-delete-key"]')
    expect(del.exists()).toBe(true)
    await del.trigger('click')
    await flushPromises()
    expect(cleared).toBe(true)
    expect(wrapper.find('[data-test="wt-delete-key"]').exists()).toBe(false)
  })

  it('清除翻译缓存发送消息，期间禁用按钮并提示结果', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => { release = resolve })
    const calls: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:clear-cache': (message) => { calls.push(message); return pending },
    })
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.get('[data-test="wt-clear-cache"]').trigger('click')
    expect(wrapper.get('[data-test="wt-clear-cache"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="wt-clear-cache"]').trigger('click')
    release({ ok: true })
    await flushPromises()
    expect(calls).toEqual([{ type: 'wt:clear-cache' }])
    expect(wrapper.get('.wt-status').text()).toBe(en.wtClearCacheDone)
    expect(wrapper.get('.wt-status').classes()).not.toContain('wt-status-error')
    expect(wrapper.get('[data-test="wt-clear-cache"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('清除翻译缓存失败时显示本地化错误', async () => {
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:clear-cache': () => ({ ok: false, error: '清除失败' }),
    })
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.get('[data-test="wt-clear-cache"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.wt-status').text()).toBe(en.wtClearCacheFailed)
    expect(wrapper.get('.wt-status').classes()).toContain('wt-status-error')
    wrapper.unmount()
  })

  it('空密钥保存不携带 apiKey 字段', async () => {
    const saves: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (m) => {
        saves.push(m)
        return { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
      },
      'wt:test': () => ({ ok: true, texts: ['ok'] }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.find('[data-test="wt-save"]').trigger('click')
    await flushPromises()
    expect(saves).toHaveLength(1)
    expect('apiKey' in saves[0]!).toBe(false)
  })

  it('源语言下拉发送精确补丁，失败保持原显示，无密钥仍可重发', async () => {
    const saves: Record<string, unknown>[] = []
    let fail = true
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'none' }),
      'wt:save-config': (message) => {
        saves.push(message)
        if (fail) return { ok: false, error: '保存失败' }
        return { ok: true, config: { ...CONFIG, sourceLanguage: 'ja' }, keyState: 'none' }
      },
    })
    const wrapper = mount(TranslationSection)
    await flushPromises()
    const shown = (): string =>
      wrapper
        .get('[data-test="wt-source-language"]')
        .findAll('.ui-select-label')
        .filter((node) => !node.classes().includes('ui-select-sizer'))
        .map((node) => node.text())
        .join('')
    expect(shown()).toBe(en.wtSourceAuto)
    const choose = async (label: string): Promise<void> => {
      const button = wrapper.get('[data-test="wt-source-language"]')
      await button.trigger('click')
      const option = [...button.element.parentElement!.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent?.includes(label),
      )
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
    }
    await choose('日本語')
    expect(saves).toEqual([{ type: 'wt:save-config', patch: { sourceLanguage: 'ja' } }])
    expect(shown()).toBe(en.wtSourceAuto)
    expect(wrapper.text()).toContain('保存失败')
    fail = false
    await choose('日本語')
    expect(saves).toEqual([
      { type: 'wt:save-config', patch: { sourceLanguage: 'ja' } },
      { type: 'wt:save-config', patch: { sourceLanguage: 'ja' } },
    ])
    expect(shown()).toBe('日本語')
    wrapper.unmount()
  })

  it('加载失败后无法写入', async () => {
    let saved = false
    replies({
      'wt:get-config': () => ({ ok: false, error: 'x' }),
      'wt:save-config': () => {
        saved = true
        return { ok: true }
      },
    })
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.find('[data-test="wt-save"]').trigger('click')
    await flushPromises()
    expect(saved).toBe(false)
  })

  const fiftyHosts = Array.from({ length: 50 }, (_, i) => `site${i}.example`)
  it.each([
    ['已存在', ['private.example'], 'private.example', ['private.example']],
    ['数量上限', fiftyHosts, 'new.example', [...fiftyHosts.slice(1), 'new.example']],
  ] as const)('旧窗口排除判断必须交给后台：%s', async (_name, hosts, added, finalHosts) => {
    const initial = { ...CONFIG, excludedHosts: [...hosts] }
    const calls: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: initial, keyState: 'ready' }),
      'wt:set-site-excluded': (message) => {
        calls.push(message)
        return {
          ok: true,
          config: { ...CONFIG, excludedHosts: calls.length === 1 ? [...hosts].slice(1) : [...finalHosts] },
          keyState: 'ready',
        }
      },
    })
    const a = mount(TranslationSection)
    const b = mount(TranslationSection)
    try {
      await flushPromises()
      await b.findAll('[data-test="wt-excluded-remove"]')[0]!.trigger('click')
      await flushPromises()
      expect(a.findAll('[data-test="wt-excluded-host"]').map((row) => row.text())).toEqual([...hosts])
      await a.get('[data-test="wt-excluded-input"]').setValue(added)
      await a.get('[data-test="wt-excluded-add"]').trigger('click')
      await flushPromises()
      expect(calls).toEqual([
        { type: 'wt:set-site-excluded', host: hosts[0], excluded: false },
        { type: 'wt:set-site-excluded', host: added, excluded: true },
      ])
      expect(a.findAll('[data-test="wt-excluded-host"]').map((row) => row.text())).toEqual([...finalHosts])
    } finally {
      a.unmount()
      b.unmount()
    }
  })

  it.each([
    { hosts: ['private.example'] },
    { hosts: Array.from({ length: 50 }, (_, i) => `site${i}.example`) },
  ])('已排除网站再次添加也由后台幂等处理（$hosts.length 项）', async ({ hosts }) => {
    const saved: Record<string, unknown>[] = []
    const config = { ...CONFIG, excludedHosts: hosts }
    replies({
      'wt:get-config': () => ({ ok: true, config, keyState: 'ready' }),
      'wt:set-site-excluded': (message) => { saved.push(message); return { ok: true, config, keyState: 'ready' } },
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-excluded-input"]').setValue(hosts[0]!)
      await wrapper.get('[data-test="wt-excluded-add"]').trigger('click')
      await flushPromises()
      expect(saved).toEqual([{ type: 'wt:set-site-excluded', host: hosts[0], excluded: true }])
      expect(wrapper.findAll('[data-test="wt-excluded-host"]').map((row) => row.text())).toEqual(hosts)
    } finally { wrapper.unmount() }
  })

  it.each([49, 50])('后台上限回复统一显示本地化文案（本地 %i 项）', async (count) => {
    const hosts = fiftyHosts.slice(0, count)
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: { ...CONFIG, excludedHosts: hosts }, keyState: 'ready' }),
      'wt:set-site-excluded': (message) => {
        saved.push(message)
        return { ok: false, error: EXCLUDED_LIMIT_ERROR }
      },
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-excluded-input"]').setValue('new.example')
      await wrapper.get('[data-test="wt-excluded-add"]').trigger('click')
      await flushPromises()
      expect(saved).toEqual([{ type: 'wt:set-site-excluded', host: 'new.example', excluded: true }])
      expect(wrapper.text()).toContain(en.wtExcludedLimit)
      expect(wrapper.text()).not.toContain(EXCLUDED_LIMIT_ERROR)
    } finally { wrapper.unmount() }
  })

  it('补丁回归_额外读取失败不能用旧列表拦住添加', async () => {
    let reads = 0
    const saves: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ++reads === 1
        ? { ok: true, config: { ...CONFIG, excludedHosts: ['private.example'] }, keyState: 'ready' }
        : { ok: false, error: '临时读取失败' },
      'wt:set-site-excluded': (message) => {
        saves.push(message)
        return { ok: true, config: { ...CONFIG, excludedHosts: ['private.example'] }, keyState: 'ready' }
      },
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-excluded-input"]').setValue('private.example')
      await wrapper.get('[data-test="wt-excluded-add"]').trigger('click')
      await flushPromises()
      expect(saves).toEqual([{ type: 'wt:set-site-excluded', host: 'private.example', excluded: true }])
    } finally { wrapper.unmount() }
  })

  it('网站运行范围切换模式，并用原子消息增删域名', async () => {
    const saves: Record<string, unknown>[] = []
    let mode: 'all' | 'include' | 'exclude' = 'all'
    let hosts: string[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: { ...CONFIG, siteScopeMode: mode, siteScopeHosts: hosts }, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saves.push(message)
        mode = (message.patch as { siteScopeMode: typeof mode }).siteScopeMode
        return { ok: true, config: { ...CONFIG, siteScopeMode: mode, siteScopeHosts: hosts }, keyState: 'ready' }
      },
      'wt:set-site-scope-host': (message) => {
        saves.push(message)
        const host = message.host as string
        hosts = message.listed === true ? [host] : hosts.filter((item) => item !== host)
        return { ok: true, config: { ...CONFIG, siteScopeMode: mode, siteScopeHosts: hosts }, keyState: 'ready' }
      },
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      expect(wrapper.get('#wt-site-scope-label').attributes('id')).toBe('wt-site-scope-label')
      expect(wrapper.get('[data-test="wt-site-scope-mode"]').attributes('aria-labelledby')).toBe('wt-site-scope-label')
      expect(wrapper.find('[data-test="wt-scope-empty"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="wt-scope-input"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="wt-scope-add"]').exists()).toBe(false)
      const select = wrapper.get('[data-test="wt-site-scope-mode"]')
      await select.trigger('click')
      const option = [...select.element.parentElement!.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent?.includes(en.wtScopeInclude),
      )
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
      expect(saves[0]).toEqual({ type: 'wt:save-config', patch: { siteScopeMode: 'include' } })
      expect(wrapper.get('[data-test="wt-scope-empty"]').text()).toBe(en.wtScopeEmptyInclude)
      expect(wrapper.text()).toContain(en.wtScopeHost)
      expect(wrapper.get('[data-test="wt-scope-input"]').attributes('placeholder')).toBe('example.org')
      await wrapper.get('[data-test="wt-scope-input"]').setValue('*.bad')
      await wrapper.get('[data-test="wt-scope-add"]').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain(en.wtScopeInvalid)
      expect(saves).toHaveLength(1)
      await wrapper.get('[data-test="wt-scope-input"]').setValue('docs.example')
      await wrapper.get('[data-test="wt-scope-add"]').trigger('click')
      await flushPromises()
      expect(saves.at(-1)).toEqual({ type: 'wt:set-site-scope-host', host: 'docs.example', listed: true })
      expect(wrapper.get('[data-test="wt-scope-host"]').text()).toBe('docs.example')
      await wrapper.get('[data-test="wt-scope-remove"]').trigger('click')
      await flushPromises()
      expect(saves.at(-1)).toEqual({ type: 'wt:set-site-scope-host', host: 'docs.example', listed: false })
      expect(wrapper.get('[data-test="wt-scope-empty"]').text()).toBe(en.wtScopeEmptyInclude)
    } finally {
      wrapper.unmount()
    }
  })

  it('添加或切换模式失败时不伪显示，输入保留', async () => {
    replies({
      'wt:get-config': () => ({
        ok: true,
        config: { ...CONFIG, siteScopeMode: 'include', siteScopeHosts: [] },
        keyState: 'ready',
      }),
      'wt:save-config': () => ({ ok: false, error: '保存失败' }),
      'wt:set-site-scope-host': () => ({ ok: false, error: '保存失败' }),
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      const select = wrapper.get('[data-test="wt-site-scope-mode"]')
      await select.trigger('click')
      const option = [...select.element.parentElement!.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent?.includes(en.wtScopeExclude),
      )
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
      expect(wrapper.get('[data-test="wt-scope-empty"]').text()).toBe(en.wtScopeEmptyInclude)
      await wrapper.get('[data-test="wt-scope-input"]').setValue('docs.example')
      await wrapper.get('[data-test="wt-scope-add"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="wt-scope-host"]').exists()).toBe(false)
      expect((wrapper.get('[data-test="wt-scope-input"]').element as HTMLInputElement).value).toBe('docs.example')
    } finally {
      wrapper.unmount()
    }
  })

  it('切到 all 隐藏编辑器但不丢掉已存名单', async () => {
    let mode: 'all' | 'include' | 'exclude' = 'include'
    const hosts = ['docs.example']
    replies({
      'wt:get-config': () => ({ ok: true, config: { ...CONFIG, siteScopeMode: mode, siteScopeHosts: hosts }, keyState: 'ready' }),
      'wt:save-config': (message) => {
        mode = (message.patch as { siteScopeMode: typeof mode }).siteScopeMode
        return { ok: true, config: { ...CONFIG, siteScopeMode: mode, siteScopeHosts: hosts }, keyState: 'ready' }
      },
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      expect(wrapper.get('[data-test="wt-scope-host"]').text()).toBe('docs.example')
      const select = wrapper.get('[data-test="wt-site-scope-mode"]')
      await select.trigger('click')
      const all = [...select.element.parentElement!.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent?.includes(en.wtScopeAll),
      )
      all?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
      expect(wrapper.find('[data-test="wt-scope-host"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="wt-scope-input"]').exists()).toBe(false)
      await select.trigger('click')
      const include = [...select.element.parentElement!.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent?.includes(en.wtScopeInclude),
      )
      include?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
      expect(wrapper.get('[data-test="wt-scope-host"]').text()).toBe('docs.example')
    } finally {
      wrapper.unmount()
    }
  })

  it('高级接口设置：默认折叠，协议切换更新预览与占位符，合法保存携带完整补丁、请求头与 expectedOptionsKey，留空保留而 {} 清空，无关开关不覆盖草稿', async () => {
    const rev1 = '11111111-1111-4111-8111-111111111111'
    let current: TranslationConfig = { ...CONFIG }
    let headersState: 'none' | 'ready' = 'none'
    const saves: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: current, hasKey: true, keyState: 'ready', customHeadersState: headersState }),
      'wt:save-config': (message) => {
        saves.push(message)
        const patch = message.patch as Partial<TranslationConfig>
        const suppliedHeaders = message.customHeaders as Record<string, string> | undefined
        if (suppliedHeaders !== undefined) {
          const hasEntries = Object.keys(suppliedHeaders).length > 0
          headersState = hasEntries ? 'ready' : 'none'
          current = {
            ...current,
            ...patch,
            customHeadersRevision: hasEntries ? rev1 : '',
          }
        } else {
          current = { ...current, ...patch }
        }
        return {
          ok: true,
          config: current,
          hasKey: true,
          keyState: 'ready',
          customHeadersState: headersState,
        }
      },
      'wt:test': () => ({ ok: true, texts: ['ok'] }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      const advanced = wrapper.get('[data-test="wt-advanced"]').element as HTMLDetailsElement
      expect(advanced.open).toBe(false)
      expect(wrapper.get('[data-test="wt-endpoint-preview"]').text()).toContain('https://api.example.com/v1/chat/completions')
      expect(wrapper.get('[data-test="wt-request-params"]').attributes('placeholder')).toContain('reasoning_effort')

      const apiSelect = wrapper.get('[data-test="wt-api-type"]')
      await apiSelect.trigger('click')
      const responsesOpt = [...apiSelect.element.parentElement!.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent?.includes(en.wtApiResponses),
      )
      responsesOpt?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
      expect(wrapper.get('[data-test="wt-endpoint-preview"]').text()).toContain('https://api.example.com/v1/responses')
      expect(wrapper.get('[data-test="wt-request-params"]').attributes('placeholder')).toContain('"reasoning"')

      await wrapper.get('[data-test="wt-temperature"]').setValue('0')
      await wrapper.get('[data-test="wt-request-params"]').setValue('{"reasoning":{"effort":"medium"}}')
      await wrapper.get('[data-test="wt-custom-headers"]').setValue('{"X-Api-Key":" header-secret "}')

      // 无关悬浮入口切换不覆盖未保存的协议与高级草稿
      await wrapper.get('[data-test="wt-floating-toggle"] [role="switch"]').trigger('click')
      await flushPromises()
      expect(saves).toHaveLength(1)
      expect(saves[0]?.patch).toEqual({ floatingButtonEnabled: false })
      expect(wrapper.get('[data-test="wt-endpoint-preview"]').text()).toContain('https://api.example.com/v1/responses')
      expect((wrapper.get('[data-test="wt-temperature"]').element as HTMLInputElement).value).toBe('0')
      expect((wrapper.get('[data-test="wt-request-params"]').element as HTMLTextAreaElement).value).toBe(
        '{"reasoning":{"effort":"medium"}}',
      )
      expect((wrapper.get('[data-test="wt-custom-headers"]').element as HTMLTextAreaElement).value).toBe(
        '{"X-Api-Key":" header-secret "}',
      )

      saves.length = 0
      const baselineOptionsKey = requestOptionsKey( CONFIG )
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()
      expect(saves).toHaveLength(1)
      expect(saves[0]).toEqual({
        type: 'wt:save-config',
        patch: {
          baseUrl: 'https://api.example.com/v1',
          model: 'm',
          apiType: 'responses',
          temperature: 0,
          requestParams: { reasoning: { effort: 'medium' } },
        },
        customHeaders: { 'x-api-key': 'header-secret' },
        expectedConnection: {
          baseUrl: 'https://api.example.com/v1',
          model: 'm',
          requestOptionsKey: baselineOptionsKey,
        },
      })
      expect((wrapper.get('[data-test="wt-custom-headers"]').element as HTMLTextAreaElement).value).toBe('')
      expect(wrapper.text()).toContain(en.wtCustomHeadersSaved)

      // 留空再次保存省略 customHeaders 字段并携带更新后的 expectedOptionsKey
      saves.length = 0
      const updatedOptionsKey = requestOptionsKey(current)
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()
      expect(saves).toHaveLength(1)
      expect('customHeaders' in saves[0]!).toBe(false)
      expect(saves[0]?.expectedConnection).toEqual({
        baseUrl: 'https://api.example.com/v1',
        model: 'm',
        requestOptionsKey: updatedOptionsKey,
      })

      // 填写 {} 保存显式清空请求头
      saves.length = 0
      await wrapper.get('[data-test="wt-custom-headers"]').setValue('{}')
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()
      expect(saves).toHaveLength(1)
      expect(saves[0]?.customHeaders).toEqual({})
      expect(wrapper.text()).not.toContain(en.wtCustomHeadersSaved)
    } finally {
      wrapper.unmount()
    }
  })

  it.each([
    ['temperature', '3', '{"reasoning_effort":"low"}', '', en.wtTemperatureInvalid],
    ['requestParams', '0.5', '{malformed', '', en.wtRequestParamsInvalid],
    ['requestParams', '0.5', 'null', '', en.wtRequestParamsInvalid],
    ['requestParams', '0.5', '[1]', '', en.wtRequestParamsInvalid],
    ['requestParams', '0.5', '{"model":"override"}', '', en.wtRequestParamsInvalid],
    ['customHeaders', '0.5', '', '{"Authorization":"Bearer x"}', en.wtCustomHeadersInvalid],
    ['customHeaders', '0.5', '', '{"X-Token":RAW_HEADER_PARSE_MARKER', en.wtCustomHeadersInvalid],
  ] as const)(
    '高级设置校验失败（%s: %s / %s / %s）不申请权限、不保存、不测试，自动展开高级设置并保留草稿',
    async (field, tempVal, paramsVal, headersVal, expectedMessage) => {
      const saves: unknown[] = []
      let tested = false
      replies({
        'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
        'wt:save-config': (message) => {
          saves.push(message)
          return { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
        },
        'wt:test': () => {
          tested = true
          return { ok: true, texts: ['ok'] }
        },
      })
      const permission = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
      const wrapper = mount(TranslationSection)
      try {
        await flushPromises()
        const advanced = wrapper.get('[data-test="wt-advanced"]').element as HTMLDetailsElement
        expect(advanced.open).toBe(false)
        await wrapper.get('[data-test="wt-temperature"]').setValue(tempVal)
        await wrapper.get('[data-test="wt-request-params"]').setValue(paramsVal)
        await wrapper.get('[data-test="wt-custom-headers"]').setValue(headersVal)
        await wrapper.get('[data-test="wt-save"]').trigger('click')
        await flushPromises()

        expect(permission).not.toHaveBeenCalled()
        expect(saves).toEqual([])
        expect(tested).toBe(false)
        expect(advanced.open).toBe(true)
        expect(wrapper.get('.wt-status').text()).toBe(expectedMessage)
        expect(wrapper.get('.wt-status').text()).not.toContain('RAW_HEADER_PARSE_MARKER')
        const targetSelector =
          field === 'temperature'
            ? '[data-test="wt-temperature"]'
            : field === 'requestParams'
              ? '[data-test="wt-request-params"]'
              : '[data-test="wt-custom-headers"]'
        expect(wrapper.get(targetSelector).attributes('aria-invalid')).toBe('true')
        expect((wrapper.get('[data-test="wt-temperature"]').element as HTMLInputElement).value).toBe(tempVal)
        expect((wrapper.get('[data-test="wt-request-params"]').element as HTMLTextAreaElement).value).toBe(paramsVal)
        expect((wrapper.get('[data-test="wt-custom-headers"]').element as HTMLTextAreaElement).value).toBe(headersVal)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('温度输入框 validity.badInput 为 true 时不按空值静默保存', async () => {
    const saves: unknown[] = []
    let tested = false
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saves.push(message)
        return { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
      },
      'wt:test': () => {
        tested = true
        return { ok: true, texts: ['ok'] }
      },
    })
    const permission = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    const input = wrapper.get('[data-test="wt-temperature"]').element as HTMLInputElement
    try {
      await flushPromises()
      const advanced = wrapper.get('[data-test="wt-advanced"]').element as HTMLDetailsElement
      expect(advanced.open).toBe(false)
      input.value = ''
      Object.defineProperty(input, 'validity', {
        get: () => ({ badInput: true }),
        configurable: true,
      })
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()

      expect(permission).not.toHaveBeenCalled()
      expect(saves).toEqual([])
      expect(tested).toBe(false)
      expect(advanced.open).toBe(true)
      expect(wrapper.get('.wt-status').text()).toBe(en.wtTemperatureInvalid)
      expect(wrapper.get('[data-test="wt-temperature"]').attributes('aria-invalid')).toBe('true')
    } finally {
      Reflect.deleteProperty(input, 'validity')
      wrapper.unmount()
    }
  })

  it('保存中清除旧成功提示；已提交警告保留且更新 CAS，清空凭据草稿后可重试', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: 'en' })
    const warning = '已保存，但站点脚本更新失败，请重试保存'
    const committed = {
      ...CONFIG,
      temperature: 0.5,
      customHeadersRevision: '11111111-1111-4111-8111-111111111111',
    }
    const saves: Record<string, unknown>[] = []
    let tests = 0
    let release!: (value: unknown) => void
    const pending = new Promise<unknown>((resolve) => { release = resolve })
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready', hasKey: true }),
      'wt:save-config': (message) => {
        saves.push(message)
        if (saves.length === 2) return pending
        return {
          ok: true,
          config: saves.length === 1 ? CONFIG : committed,
          keyState: 'ready',
          hasKey: true,
          customHeadersState: saves.length === 1 ? 'none' : 'ready',
        }
      },
      'wt:test': () => {
        tests += 1
        return { ok: true, texts: ['ok'] }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()
      expect(wrapper.get('.wt-status').text()).toBe(en.wtSavedOk)
      expect(tests).toBe(1)
      await wrapper.get('[data-test="wt-temperature"]').setValue('0.5')
      await wrapper.get('input[type="password"]').setValue('sk-fixture')
      await wrapper.get('[data-test="wt-custom-headers"]').setValue('{"X-Fixture":"synthetic"}')
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()
      expect(wrapper.text()).not.toContain(en.wtSavedOk)
      expect(wrapper.get('[data-test="wt-save"]').attributes('disabled')).toBeDefined()
      release({ ok: true, config: committed, keyState: 'ready', hasKey: true, customHeadersState: 'ready', warning })
      await flushPromises()
      expect(wrapper.get('.wt-status').text()).toBe(warning)
      expect(tests).toBe(1)
      expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('')
      expect((wrapper.get('[data-test="wt-custom-headers"]').element as HTMLTextAreaElement).value).toBe('')
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()
      expect(saves[2]?.expectedConnection).toMatchObject({ requestOptionsKey: requestOptionsKey(committed) })
      expect(saves[2]).not.toHaveProperty('apiKey')
      expect(saves[2]).not.toHaveProperty('customHeaders')
      expect(tests).toBe(2)
      expect(wrapper.get('.wt-status').text()).toBe(en.wtSavedOk)
    } finally {
      wrapper.unmount()
    }
  })

  it('悬浮入口同步警告清除本分区的旧成功提示，不再弹成功 toast', async () => {
    clearToasts()
    let saves = 0
    const warning = '已保存，但站点脚本更新失败，请重试保存'
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready', hasKey: true }),
      'wt:save-config': () => {
        saves += 1
        return {
          ok: true,
          config: { ...CONFIG, floatingButtonEnabled: saves === 1 },
          keyState: 'ready',
          hasKey: true,
          ...(saves === 2 ? { warning } : {}),
        }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-floating-toggle"] [role="switch"]').trigger('click')
      await flushPromises()
      expect(useToasts().value).toEqual([])
      await wrapper.get('[data-test="wt-floating-toggle"] [role="switch"]').trigger('click')
      await flushPromises()
      expect(saves).toBe(2)
      expect(wrapper.get('.wt-status').text()).toBe(warning)
      expect(useToasts().value).toEqual([])
    } finally {
      wrapper.unmount()
      clearToasts()
    }
  })

  it('获取模型先请求权限再发 wt:list-models，不触发保存或测试，不自动修改模型值，选项填充且支持手动输入不在列表中的值', async () => {
    const sent: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({
        ok: true,
        config: { ...CONFIG, baseUrl: 'https://api.example.com/v1', model: '' },
        keyState: 'ready',
      }),
      'wt:list-models': (message) => {
        sent.push(message)
        return { ok: true, models: ['gpt-4o'] }
      },
      'wt:save-config': (message) => {
        sent.push(message)
        return { ok: true, config: CONFIG, keyState: 'ready' }
      },
      'wt:test': (message) => {
        sent.push(message)
        return { ok: true, texts: ['ok'] }
      },
    })
    const permSpy = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      expect(permSpy).toHaveBeenCalledTimes(1)
      expect(permSpy).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        type: 'wt:list-models',
        baseUrl: 'https://api.example.com/v1',
      })
      expect('apiKey' in sent[0]!).toBe(false)
      expect('customHeaders' in sent[0]!).toBe(false)
      // 即使只返回 1 个模型，也不自动改动 model 输入框
      const modelInput = wrapper.get('[data-test="wt-model-input"]').element as HTMLInputElement
      expect(modelInput.value).toBe('')
      expect(modelInput.getAttribute('role')).toBe('combobox')
      expect(await availableModels(wrapper)).toEqual(['gpt-4o'])
      expect(wrapper.get('#wt-model-status').text()).toBe(en.wtModelsLoaded.replace('{count}', '1'))

      // 用户可手动填写不在列表中的模型值，且保留模型候选
      await wrapper.get('[data-test="wt-model-input"]').setValue('custom-manual-model')
      expect(modelInput.value).toBe('custom-manual-model')
      expect(await availableModels(wrapper)).toEqual(['gpt-4o'])
    } finally {
      wrapper.unmount()
    }
  })

  it('获取模型失败（401/权限拒绝）保留全部草稿，非法自定义头展开高级设置且不发权限或网络请求', async () => {
    const sent: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'none' }),
      'wt:list-models': (message) => {
        sent.push(message)
        return { ok: false, error: '凭证无效或没有访问权限', code: 'auth' }
      },
    })
    const permSpy = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.find('input').setValue('https://draft.example.com/v1')
      await wrapper.get('input[type="password"]').setValue('sk-draft-401')
      await wrapper.get('[data-test="wt-model-input"]').setValue('keep-my-model')
      await wrapper.get('[data-test="wt-temperature"]').setValue('not-validated-on-fetch')
      await wrapper.get('[data-test="wt-request-params"]').setValue('{invalid-json-ignored-by-fetch')

      // 非法自定义请求头在发起权限与消息前拦截并展开高级设置
      await wrapper.get('[data-test="wt-custom-headers"]').setValue('{bad-json')
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      expect(permSpy).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
      expect((wrapper.get('[data-test="wt-advanced"]').element as HTMLDetailsElement).open).toBe(true)
      expect(wrapper.get('[data-test="wt-custom-headers"]').attributes('aria-invalid')).toBe('true')
      expect(wrapper.get('#wt-model-status').text()).toBe(en.wtCustomHeadersInvalid)

      // 修正自定义请求头后发起请求，401 错误保留全部草稿
      await wrapper.get('[data-test="wt-custom-headers"]').setValue('{"X-Draft":"ok"}')
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      expect(permSpy).toHaveBeenCalledWith({ origins: ['https://draft.example.com/*'] })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        type: 'wt:list-models',
        baseUrl: 'https://draft.example.com/v1',
        apiKey: 'sk-draft-401',
        customHeaders: { 'x-draft': 'ok' },
      })
      expect(wrapper.get('#wt-model-status').text()).toBe('凭证无效或没有访问权限')
      expect((wrapper.find('input').element as HTMLInputElement).value).toBe('https://draft.example.com/v1')
      expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('sk-draft-401')
      expect((wrapper.get('[data-test="wt-model-input"]').element as HTMLInputElement).value).toBe('keep-my-model')
      expect((wrapper.get('[data-test="wt-custom-headers"]').element as HTMLTextAreaElement).value).toBe(
        '{"X-Draft":"ok"}',
      )
    } finally {
      wrapper.unmount()
    }
  })

  it('在途修改 URL/key/header、点击取消或卸载组件时发送 wt:cancel-models 且旧回复不回填', async () => {
    const sent: Record<string, unknown>[] = []
    const resolvers: Array<(value: unknown) => void> = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:list-models': (message) => {
        sent.push(message)
        return new Promise((resolve) => {
          resolvers.push(resolve)
        })
      },
      'wt:cancel-models': (message) => {
        sent.push(message)
        return { ok: true }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      // 第一次点击获取模型（在途）
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      expect(wrapper.get('[data-test="wt-fetch-models"]').text()).toBe(en.wtModelsCancel)
      expect(wrapper.get('#wt-model-status').text()).toBe(en.wtModelsLoading)
      expect(wrapper.get('[data-test="wt-save"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-test="wt-delete-key"]').attributes('disabled')).toBeDefined()
      const firstId = (sent[0] as { requestId: string }).requestId

      // 在途修改 baseUrl：立刻发送 cancel-models，旧请求返回后不能回填
      await wrapper.find('input').setValue('https://second.example.com/v1')
      await flushPromises()
      expect(sent.at(-1)).toEqual({ type: 'wt:cancel-models', requestId: firstId })
      expect(wrapper.get('[data-test="wt-fetch-models"]').text()).toBe(en.wtModelsFetch)
      resolvers[0]!({ ok: true, models: ['stale-model'] })
      await flushPromises()
      expect(wrapper.find('[data-test="wt-model-menu"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(0)

      // 在途修改 apiKey 与 customHeadersDraft 同样取消且旧请求返回后不回填
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      const keyEditId = (sent.at(-1) as { requestId: string }).requestId
      await wrapper.get('input[type="password"]').setValue('sk-new-draft')
      await flushPromises()
      expect(sent.at(-1)).toEqual({ type: 'wt:cancel-models', requestId: keyEditId })
      resolvers[1]!({ ok: true, models: ['stale-key-model'] })
      await flushPromises()
      expect(wrapper.find('[data-test="wt-model-menu"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(0)

      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      const headerEditId = (sent.at(-1) as { requestId: string }).requestId
      await wrapper.get('[data-test="wt-custom-headers"]').setValue('{"X-Test":"1"}')
      await flushPromises()
      expect(sent.at(-1)).toEqual({ type: 'wt:cancel-models', requestId: headerEditId })
      resolvers[2]!({ ok: true, models: ['stale-header-model'] })
      await flushPromises()
      expect(wrapper.find('[data-test="wt-model-menu"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(0)

      // 点击取消按钮取消
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      const secondId = (sent.at(-1) as { requestId: string }).requestId
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      expect(sent.at(-1)).toEqual({ type: 'wt:cancel-models', requestId: secondId })
      expect(wrapper.find('#wt-model-status').exists()).toBe(false)
      resolvers[3]!({ ok: true, models: ['cancelled-model'] })
      await flushPromises()
      expect(wrapper.find('[data-test="wt-model-menu"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(0)

      // 在途卸载组件：发送 cancel-models 且迟到回复不抛错不更新
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      const thirdId = (sent.at(-1) as { requestId: string }).requestId
      wrapper.unmount()
      await flushPromises()
      expect(sent.at(-1)).toEqual({ type: 'wt:cancel-models', requestId: thirdId })
      resolvers[4]!({ ok: true, models: ['unmounted-model'] })
      await flushPromises()
    } finally {
      wrapper.unmount()
    }
  })

  it.each([
    ['权限拒绝返回 false', async (): Promise<boolean> => false],
    [
      '权限同步抛错',
      (): Promise<boolean> => {
        throw new Error('synthetic permission failure')
      },
    ],
  ] as const)('获取模型时 %s 正常结束获取状态且保留输入', async (_label, requestImpl) => {
    const sent: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'none' }),
      'wt:list-models': (message) => {
        sent.push(message)
        return { ok: true, models: ['gpt-4o'] }
      },
      'wt:save-config': (message) => {
        sent.push(message)
        return { ok: true, config: CONFIG, keyState: 'none' }
      },
      'wt:test': (message) => {
        sent.push(message)
        return { ok: true, texts: ['ok'] }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(requestImpl)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-model-input"]').setValue('keep-my-model')
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      expect(sent).toHaveLength(0)
      expect(wrapper.get('#wt-model-status').text()).toBe(en.wtPermissionDenied)
      expect(wrapper.get('[data-test="wt-fetch-models"]').text()).toBe(en.wtModelsFetch)
      expect(wrapper.get('[data-test="wt-fetch-models"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.get('[data-test="wt-save"]').attributes('disabled')).toBeUndefined()
      expect((wrapper.get('[data-test="wt-model-input"]').element as HTMLInputElement).value).toBe('keep-my-model')
    } finally {
      wrapper.unmount()
    }
  })

  it('使用已保存密钥获取模型后删除密钥会清空模型候选与提示但保留手填模型', async () => {
    const sent: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:list-models': (message) => {
        sent.push(message)
        return { ok: true, models: ['stored-key-model'] }
      },
      'wt:clear-key': (message) => {
        sent.push(message)
        return { ok: true, hasKey: false, keyState: 'none' }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-model-input"]').setValue('keep-my-model')
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      expect(await availableModels(wrapper)).toEqual([
        'stored-key-model',
      ])
      expect(wrapper.get('#wt-model-status').text()).toBe(en.wtModelsLoaded.replace('{count}', '1'))

      await wrapper.get('[data-test="wt-delete-key"]').trigger('click')
      await flushPromises()
      expect(sent.at(-1)).toEqual({ type: 'wt:clear-key' })
      expect(wrapper.find('[data-test="wt-model-menu"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(0)
      expect(wrapper.find('#wt-model-status').exists()).toBe(false)
      expect((wrapper.get('[data-test="wt-model-input"]').element as HTMLInputElement).value).toBe('keep-my-model')
    } finally {
      wrapper.unmount()
    }
  })

  it('分区切换保留连接和高级草稿、已获取模型列表，且不保存配置', async () => {
    const save = vi.fn(() => ({ ok: true, config: CONFIG }))
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:list-models': () => ({ ok: true, models: ['offered-model'] }),
      'wt:save-config': save,
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => false)
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection, { props: { view: 'model' }, attachTo: document.body })
    try {
      await flushPromises()
      await wrapper.get('input[aria-labelledby="wt-base-url-label"]').setValue('https://draft.example/v1')
      await wrapper.get('input[aria-labelledby="wt-api-key-label"]').setValue('synthetic-draft-key')
      await wrapper.get('[data-test="wt-model-input"]').setValue('draft-model')
      await wrapper.get('[data-test="wt-custom-headers"]').setValue('{"X-Test":"draft"}')
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      await flushPromises()
      expect(await availableModels(wrapper)).toEqual(['offered-model'])
      await wrapper.setProps({ view: 'general' })
      expect(wrapper.get('[data-test="wt-general-view"]').isVisible()).toBe(true)
      expect(wrapper.get('[data-test="wt-model-view"]').isVisible()).toBe(false)
      await wrapper.setProps({ view: 'sites' })
      expect(wrapper.get('[data-test="wt-sites-view"]').isVisible()).toBe(true)
      expect(wrapper.get('[data-test="wt-site-auto-details"]').element.tagName).toBe('DIV')
      await wrapper.setProps({ view: 'model' })
      expect((wrapper.get('input[aria-labelledby="wt-base-url-label"]').element as HTMLInputElement).value).toBe('https://draft.example/v1')
      expect((wrapper.get('input[aria-labelledby="wt-api-key-label"]').element as HTMLInputElement).value).toBe('synthetic-draft-key')
      expect((wrapper.get('[data-test="wt-model-input"]').element as HTMLInputElement).value).toBe('draft-model')
      expect((wrapper.get('[data-test="wt-custom-headers"]').element as HTMLTextAreaElement).value).toBe('{"X-Test":"draft"}')
      expect(await availableModels(wrapper)).toEqual(['offered-model'])
      expect(save).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('模型候选支持筛选、点击和键盘选择，Escape和Tab不覆盖手填', async () => {
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:list-models': () => ({ ok: true, models: ['fixture-model-a', 'fixture-model-b'] }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      const input = wrapper.get('[data-test="wt-model-input"]')
      expect(await availableModels(wrapper)).toEqual(['fixture-model-a', 'fixture-model-b'])
      expect((input.element as HTMLInputElement).value).toBe(CONFIG.model)
      await input.setValue('MODEL-B')
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]').map((n) => n.text())).toEqual(['fixture-model-b'])
      await wrapper.get('[data-test="wt-model-options"] [role="option"]').trigger('click')
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-b')
      expect(input.attributes('aria-expanded')).toBe('false')
      await input.trigger('keydown', { key: 'ArrowDown' })
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]').map((n) => n.text())).toEqual(['fixture-model-a', 'fixture-model-b'])
      await input.trigger('keydown', { key: 'Enter' })
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-a')
      await input.trigger('keydown', { key: 'ArrowDown', altKey: true })
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(2)
      await input.trigger('keydown', { key: 'ArrowUp', altKey: true })
      expect(input.attributes('aria-expanded')).toBe('false')
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-a')
      await input.setValue('fixture-model-')
      await input.trigger('keydown', { key: 'ArrowDown' })
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-')
      await input.trigger('keydown', { key: 'Enter', isComposing: true })
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-')
      await input.trigger('keydown', { key: 'Escape' })
      expect(input.attributes('aria-expanded')).toBe('false')
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-')
      await input.trigger('keydown', { key: 'ArrowDown' })
      await input.trigger('keydown', { key: 'Enter' })
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-a')
      await input.setValue('fixture-model-')
      await input.trigger('keydown', { key: 'ArrowDown' })
      await input.trigger('keydown', { key: 'Tab' })
      expect((input.element as HTMLInputElement).value).toBe('fixture-model-')
      expect(input.attributes('aria-expanded')).toBe('false')
      await input.setValue('custom-manual-model')
      expect(await availableModels(wrapper)).toEqual(['fixture-model-a', 'fixture-model-b'])
      expect((input.element as HTMLInputElement).value).toBe('custom-manual-model')
      await wrapper.get('input[aria-labelledby="wt-base-url-label"]').setValue('https://other.example/v1')
      expect(wrapper.find('[data-test="wt-model-menu"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(0)
      expect((input.element as HTMLInputElement).value).toBe('custom-manual-model')
    } finally { wrapper.unmount() }
  })

  it('模型候选限制同时渲染的数量，仍可筛选并选中后面的模型', async () => {
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, keyState: 'ready' }),
      'wt:list-models': () => ({
        ok: true,
        models: [...Array.from({ length: 130 }, (_, i) => 'model-' + i), 'z-last-model'],
      }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-fetch-models"]').trigger('click')
      await flushPromises()
      const input = wrapper.get('[data-test="wt-model-input"]')
      expect(await availableModels(wrapper)).toHaveLength(100)
      expect(wrapper.text()).toContain(en.wtModelsMore)
      await input.setValue('z-last')
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]').map((n) => n.text())).toEqual(['z-last-model'])
      await wrapper.get('[data-test="wt-model-options"] [role="option"]').trigger('click')
      expect((input.element as HTMLInputElement).value).toBe('z-last-model')
      expect(input.attributes('aria-expanded')).toBe('false')
      expect(wrapper.findAll('[data-test="wt-model-options"] [role="option"]')).toHaveLength(0)
    } finally { wrapper.unmount() }
  })

  it.each(['denied', 'exception'] as const)('悬浮显示偏好不申请全站权限；显式授权%s可恢复操作', async (outcome) => {
    clearToasts()
    let current = { ...CONFIG, floatingButtonEnabled: false }
    const patches: unknown[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: current }),
      'wt:save-config': (m) => {
        patches.push(m.patch)
        current = { ...current, floatingButtonEnabled: true }
        return { ok: true, config: current }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => false)
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => {
      if (outcome === 'exception') throw new Error('synthetic permission failure')
      return false
    })
    const wrapper = mount(TranslationSection, { props: { view: 'general' } })
    try {
      await flushPromises()
      await wrapper.get('[data-test="wt-floating-toggle"] [role="switch"]').trigger('click')
      await flushPromises()
      expect(patches).toEqual([{ floatingButtonEnabled: true }])
      expect(request).not.toHaveBeenCalled()
      await wrapper.get('[data-test="wt-floating-grant"]').trigger('click')
      await flushPromises()
      expect(request).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] })
      expect(wrapper.get('.wt-status').text()).toBe(en.wtPermissionDenied)
      expect(wrapper.get('[data-test="wt-floating-grant"]').attributes('disabled')).toBeUndefined()
      expect(patches).toHaveLength(1)
    } finally {
      wrapper.unmount()
      clearToasts()
    }
  })
})

describe('弹出页站点控制', () => {
  function tabAndStatus(url: string, status: unknown): void {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [{ id: 9, url }] as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => status)
  }

  it('WT_STATE_MESSAGE 映射完整且对应有效英文文案', () => {
    expect(WT_STATE_MESSAGE.inactive).toBe('wtAutoInactive')
    expect(WT_STATE_MESSAGE['master-off']).toBe('wtMasterOff')
    expect(WT_STATE_MESSAGE['out-of-scope']).toBe('wtScopeBlocked')
    for (const key of Object.values(WT_STATE_MESSAGE)) {
      expect(en[key]).toBeTruthy()
    }
  })

  it('localhost:1234 按正确 pattern 请求权限且并发确认只请求一次', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('http://localhost:1234/x', { ok: true, status: { supported: true, fixed: false, auto: false, paused: false, capped: false, failed: 0, error: '' } })
    replies({
      'wt:get-config': () => ({ ok: true, config: { ...CONFIG } }),
      'wt:set-site-auto': () => ({ ok: true, config: { ...CONFIG, autoOrigins: ['http://localhost:1234'] } }),
    })
    let release!: (v: boolean) => void
    const gate = new Promise<boolean>((r) => {
      release = r
    })
    const req = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => await gate)
    const wrapper = mount(TranslationControls)
    await flushPromises()
    await flushPromises()
    const toggle = wrapper.get('[data-test="wt-auto"] [role="switch"]')
    await toggle.trigger('click')
    await toggle.trigger('click')
    expect(wrapper.find('[data-test="wt-confirm"]').exists()).toBe(false)
    expect(req).toHaveBeenCalledTimes(1)
    expect(req).toHaveBeenCalledWith({ origins: ['http://localhost/*'] })
    expect((toggle.element as HTMLButtonElement).disabled).toBe(true)
    release(true)
    await flushPromises()
    wrapper.unmount()
  })

  it('总开关关闭时不显示失败数量与已移除的站点状态控件', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    tabAndStatus('https://app.devin.ai/work', { ok: true, status: { supported: true, fixed: false, auto: true, paused: false, capped: false, failed: 2, error: '' } })
    replies({
      'wt:get-config': () => ({ ok: true, config: { ...CONFIG, autoOrigins: ['https://app.devin.ai'] } }),
    })
    const wrapper = mount(TranslationControls)
    await flushPromises()
    await flushPromises()
    for (const removed of ['wt-state', 'wt-origin', 'wt-restore', 'wt-resume', 'wt-failed', 'wt-retry-failed', 'wt-data-hint']) {
      expect(wrapper.find(`[data-test="${removed}"]`).exists()).toBe(false)
    }
    wrapper.unmount()
  })

  it('单页翻译上限：默认约 5 万字，选择后写入 pageCharLimit', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message.patch as Record<string, unknown>)
        return { ok: true, config: { ...CONFIG, ...(message.patch as object) }, hasKey: true, keyState: 'ready' }
      },
    })
    const wrapper = mount(TranslationSection)
    await flushPromises()
    const select = wrapper.get('[data-test="wt-page-limit"]')
    expect(select.text()).toContain(en.wtPageLimitChars.replace('{count}', '5'))
    await select.trigger('click')
    const unlimited = wrapper.findAll('[role="option"]').find((option) => option.text() === en.wtPageLimitUnlimited)
    await unlimited?.trigger('click')
    await flushPromises()
    expect(saved).toEqual([{ pageCharLimit: 0 }])
    wrapper.unmount()
  })

  it('选择工具栏写入三布尔，确认智能陪读时显式关闭工具栏', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        const patch = message.patch as Record<string, unknown>
        return {
          ok: true,
          config: { ...CONFIG, ...patch },
          hasKey: true,
          keyState: 'ready',
        }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await wrapper.find('[data-test="wt-site-scope-mode"]').trigger('click')
    const include = wrapper.findAll('[role="option"]').find((option) => option.text() === en.wtScopeInclude)
    await include?.trigger('click')
    await flushPromises()
    expect(wrapper.find('.wt-scope-field').exists()).toBe(true)
    saved.length = 0
    await wrapper.find('[data-test="wt-assist-mode"]').trigger('click')
    const toolbar = wrapper.findAll('[role="option"]').find((option) => option.text() === en.wtModeToolbar)
    await toolbar?.trigger('click')
    await flushPromises()
    expect(saved[0]?.patch).toEqual({
      selectionPopupEnabled: true,
      selectionToolbarEnabled: true,
      proactiveAssistEnabled: false,
    })
    expect(wrapper.text()).toContain(en.wtToolbarHint)
    await wrapper.find('[data-test="wt-assist-mode"]').trigger('click')
    const smart = wrapper.findAll('[role="option"]').find((option) => option.text() === en.wtModeSmart)
    await smart?.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="wt-smart-confirm"]').exists()).toBe(false)
    expect(saved.at(-1)?.patch).toEqual({
      selectionPopupEnabled: true,
      selectionToolbarEnabled: false,
      proactiveAssistEnabled: true,
    })
    wrapper.unmount()
  })

  function assistLabel(wrapper: ReturnType<typeof mount>): string {
    return wrapper
      .get('[data-test="wt-assist-mode"]')
      .findAll('.ui-select-label')
      .filter((node) => !node.classes().includes('ui-select-sizer'))
      .map((node) => node.text())
      .join('')
  }

  async function chooseAssist(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
    await wrapper.find('[data-test="wt-assist-mode"]').trigger('click')
    const option = wrapper.findAll('[role="option"]').find((item) => item.text() === label)
    await option?.trigger('click')
    await flushPromises()
  }

  it.each([
    ['selection', en.wtModeSelection, true, false, false, CONFIG],
    ['off', en.wtModeOff, false, false, false, { ...CONFIG, selectionPopupEnabled: true, selectionToolbarEnabled: false, proactiveAssistEnabled: false }],
  ] as const)('%s 写入 (%s)', async (_name, label, selection, toolbar, proactive, initial) => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: initial, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        const patch = message.patch as Record<string, unknown>
        return { ok: true, config: { ...initial, ...patch }, hasKey: true, keyState: 'ready' }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await chooseAssist(wrapper, label)
    expect(saved[0]?.patch).toEqual({
      selectionPopupEnabled: selection,
      selectionToolbarEnabled: toolbar,
      proactiveAssistEnabled: proactive,
    })
    expect(assistLabel(wrapper)).toBe(label)
    wrapper.unmount()
  })

  it('工具栏权限被拒时保持旧模式且不保存', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        return { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => false)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await chooseAssist(wrapper, en.wtModeToolbar)
    expect(saved).toEqual([])
    expect(assistLabel(wrapper)).toBe(en.wtModeOff)
    expect(wrapper.text()).not.toContain(en.wtSavedOk)
    wrapper.unmount()
  })

  it('工具栏保存被拒时下拉保持旧值且不显示成功', async () => {
    const saved: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:save-config': (message) => {
        saved.push(message)
        return { ok: false, error: '保存失败' }
      },
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    await flushPromises()
    await chooseAssist(wrapper, en.wtModeToolbar)
    expect(saved).toEqual([{
      type: 'wt:save-config',
      patch: {
        selectionPopupEnabled: true,
        selectionToolbarEnabled: true,
        proactiveAssistEnabled: false,
      },
    }])
    expect(assistLabel(wrapper)).toBe(en.wtModeOff)
    expect(wrapper.text()).toContain('保存失败')
    expect(wrapper.text()).not.toContain(en.wtSavedOk)
    wrapper.unmount()
  })

  it('不支持的当前页也可切换全局悬浮开关，不申请全站权限', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('chrome://extensions/', undefined)
    let current = { ...CONFIG, floatingButtonEnabled: false }
    const patches: unknown[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: current }),
      'wt:save-config': (m) => {
        patches.push(m.patch)
        current = { ...current, floatingButtonEnabled: true }
        return { ok: true, config: current }
      },
    })
    const permission = vi.spyOn(fakeBrowser.permissions, 'request')
    const wrapper = mount(TranslationControls)
    await flushPromises()
    await flushPromises()
    await wrapper.get('[data-test="wt-popup-floating"] button').trigger('click')
    await flushPromises()
    await flushPromises()
    expect(patches).toEqual([{ floatingButtonEnabled: true }])
    expect(wrapper.get('[data-test="wt-popup-floating"] button').attributes('aria-checked')).toBe('true')
    expect(permission).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  function mountStatusCard() {
    const Host = defineComponent({
      name: 'StatusHost',
      setup() {
        provideTranslationControls()
        return () => h(PageStatusCard)
      },
    })
    return mount(Host)
  }

  it('排除本站发送 wt:set-site-excluded 并提示成功', async () => {
    clearToasts()
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/path', {
      ok: true,
      status: { supported: true, fixed: false, auto: false, paused: false, capped: false, failed: 0, error: '' },
    })
    let current = { ...CONFIG }
    replies({
      'wt:get-config': () => ({ ok: true, config: current }),
      'wt:set-site-excluded': (message) => {
        current = {
          ...current,
          excludedHosts: message.excluded === true ? [String(message.host)] : [],
        }
        return { ok: true, config: current }
      },
    })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.get('[data-test="wt-exclude-site"]').text()).toBe(en.wtExcludeSite)
    await wrapper.get('[data-test="wt-exclude-site"]').trigger('click')
    await flushPromises()
    expect(useToasts().value.map((toast) => ({ key: toast.key, params: toast.params }))).toEqual([
      { key: 'wtSiteExcluded', params: { host: 'example.com' } },
    ])
    expect(wrapper.get('[data-test="wt-exclude-site"]').text()).toBe(en.includePage)
    wrapper.unmount()
    clearToasts()
  })

  it('达到单页上限时说明原因，并可跳到设置调整上限', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/', {
      ok: true,
      status: { supported: true, fixed: false, auto: false, paused: false, capped: true, budgetCapped: true, failed: 0, error: '' },
    })
    replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never)
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.get('[data-test="wt-capped-note"]').text()).toContain(en.wtCappedNote)
    expect(wrapper.get('[data-test="wt-translate-page"]').text()).toBe(en.wtResume)
    await wrapper.get('[data-test="wt-capped-settings"]').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({ url: expect.stringMatching(/options\.html#wt-general-title$/) })
    expect(close).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('敏感页面显示说明并禁用翻译本页', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://accounts.google.com/', {
      ok: true,
      status: { supported: true, fixed: false, auto: false, paused: false, capped: false, failed: 0, error: '' },
    })
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG }),
    })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.text()).toContain(en.wtSensitivePage)
    expect(wrapper.get('[data-test="wt-page-state"]').text()).toBe(en.wtSensitiveSkipped)
    expect(wrapper.get('[data-test="wt-translate-page"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it.each([
    ['翻译本页', { auto: false, paused: false }, 'wtTranslatePage', 'wt:translate-page'],
    ['已翻译时恢复原文', { auto: true, paused: false }, 'wtRestore', 'restore'],
    ['暂停时继续翻译（可恢复与可继续同时成立）', { auto: false, paused: true }, 'wtResume', 'resume'],
  ] as const)('主按钮：%s', async (_name, flags, label, expected) => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/', {
      ok: true,
      status: { supported: true, fixed: false, capped: false, failed: 0, error: '', ...flags },
    })
    const sent: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: { ...CONFIG, autoOrigins: ['https://example.com'] } }),
      'wt:page-action': (message) => {
        sent.push(message)
        return { ok: true }
      },
      'wt:translate-page': (message) => {
        sent.push(message)
        return { ok: true }
      },
    })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    const primary = wrapper.get('[data-test="wt-translate-page"]')
    expect(primary.text()).toBe(en[label])
    await primary.trigger('click')
    await flushPromises()
    expect(sent.map((m) => (m.type === 'wt:page-action' ? m.action : m.type))).toEqual([expected])
    wrapper.unmount()
    clearToasts()
  })

  it('手动翻译本页（未开本站自动翻译）有失败段时可全部重试', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/', {
      ok: true,
      status: { supported: true, fixed: false, auto: true, paused: false, capped: false, failed: 3, error: '' },
    })
    const sent: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG }),
      'wt:page-action': (message) => {
        sent.push(message)
        return { ok: true }
      },
    })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.get('[data-test="wt-failed"]').text()).toBe(en.wtFailedCount.replace('{count}', '3'))
    await wrapper.get('[data-test="wt-retry-failed"]').trigger('click')
    await flushPromises()
    expect(sent.map((m) => m.action)).toEqual(['retry-failed'])
    wrapper.unmount()
  })

  it.each([
    ['暂停', { paused: true, capped: false, budgetCapped: false }, 'wtFailedRetryWithResume'],
    ['额度上限', { paused: false, capped: true, budgetCapped: true }, 'wtFailedRetryWithResume'],
    ['记录数上限', { paused: false, capped: true, budgetCapped: false }, 'wtFailedNoRetry'],
  ] as const)('%s时仍显示失败段数并说明如何处理', async (_name, flags, hint) => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/', {
      ok: true,
      status: { supported: true, fixed: false, auto: false, failed: 2, error: '', ...flags },
    })
    replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('[data-test="wt-failed"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="wt-retry-failed"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="wt-failed-hint"]').text()).toBe(en[hint])
    wrapper.unmount()
  })

  it('总开关关闭时状态卡说明原因', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    tabAndStatus('https://example.com/', {
      ok: true,
      status: { supported: true, fixed: false, auto: false, paused: false, capped: false, failed: 0, error: '' },
    })
    replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.get('.popup-card-note').text()).toBe(en.wtMasterOff)
    expect(wrapper.get('[data-test="wt-translate-page"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('敏感页面已手动翻译时仍可恢复原文', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://accounts.google.com/', {
      ok: true,
      status: { supported: true, fixed: false, auto: true, paused: false, capped: false, failed: 0, error: '' },
    })
    const sent: Record<string, unknown>[] = []
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG }),
      'wt:page-action': (message) => {
        sent.push(message)
        return { ok: true }
      },
    })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    const primary = wrapper.get('[data-test="wt-translate-page"]')
    expect(primary.text()).toBe(en.wtRestore)
    expect(primary.attributes('disabled')).toBeUndefined()
    await primary.trigger('click')
    await flushPromises()
    expect(sent.map((m) => m.action)).toEqual(['restore'])
    wrapper.unmount()
    clearToasts()
  })

  it('更多功能折叠状态写入 localStorage，无值时默认展开', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/', {
      ok: true,
      status: { supported: true, fixed: false, auto: false, paused: false, capped: false, failed: 0, error: '' },
    })
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG }),
    })
    const first = mount(TranslationControls)
    await flushPromises()
    const details = first.get('.popup-more').element as HTMLDetailsElement
    expect(details.open).toBe(true)
    details.open = false
    await first.get('.popup-more').trigger('toggle')
    expect(localStorage.getItem('gcn:popup-more-open')).toBe('false')
    first.unmount()
    const second = mount(TranslationControls)
    await flushPromises()
    expect((second.get('.popup-more').element as HTMLDetailsElement).open).toBe(false)
    second.unmount()
  })

  it('模型预设只填写 Base URL 与 chat-completions，自定义清空并聚焦', async () => {
    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
    })
    const wrapper = mount(TranslationSection, { attachTo: document.body })
    try {
      await flushPromises()
      const base = wrapper.find('input').element as HTMLInputElement
      expect(wrapper.get('[data-test="wt-preset-openai"]').attributes('aria-pressed')).toBe('false')
      await wrapper.get('[data-test="wt-preset-deepseek"]').trigger('click')
      await flushPromises()
      expect(base.value).toBe('https://api.deepseek.com')
      expect(wrapper.get('[data-test="wt-preset-deepseek"]').attributes('aria-pressed')).toBe('true')
      expect((wrapper.findAll('input')[2]?.element as HTMLInputElement).value).toBe('m')
      expect((wrapper.findAll('input')[1]?.element as HTMLInputElement).value).toBe('')
      await wrapper.get('[data-test="wt-preset-custom"]').trigger('click')
      await flushPromises()
      expect(base.value).toBe('')
      expect(wrapper.get('[data-test="wt-preset-custom"]').attributes('aria-pressed')).toBe('true')
      expect(document.activeElement).toBe(base)
    } finally {
      wrapper.unmount()
    }
  })

  it('连接状态映射 auth、timeout，成功时显示延迟', async () => {
    expect(connectionKindFromReply({ ok: false, error: '密钥无效', code: 'auth' })).toBe('auth')
    expect(connectionKindFromReply({ ok: false, error: '超时', code: 'timeout' })).toBe('timeout')
    expect(connectionKindFromReply({ ok: false, error: '排队超时', code: 'queue_timeout' })).toBe('timeout')
    expect(connectionKindFromReply({ ok: true, texts: ['ok'] })).toBe('ok')

    replies({
      'wt:get-config': () => ({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }),
      'wt:test': () => ({ ok: true, texts: ['ok'] }),
    })
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      expect(wrapper.get('[data-test="wt-connection"]').text()).toBe(en.wtConnUntested)
      await wrapper.get('[data-test="wt-test-connection"]').trigger('click')
      await flushPromises()
      const toast = useToasts().value.find((item) => item.key === 'wtConnectedMs')
      expect(toast?.params?.ms).toEqual(expect.any(Number))
      expect(wrapper.get('[data-test="wt-connection"]').text()).toBe(
        en.wtConnOkMs.replace('{ms}', String(toast?.params?.ms)),
      )
    } finally {
      wrapper.unmount()
      clearToasts()
    }
  })

  const ACTIVE_STATUS = {
    supported: true,
    fixed: false,
    auto: true,
    paused: false,
    capped: false,
    failed: 0,
    error: '',
  }

  function progressStatus(progress: unknown, flags: Record<string, unknown> = {}): unknown {
    return { ok: true, status: { ...ACTIVE_STATUS, ...flags, progress } }
  }

  it('模型翻译进度：额度进度条与已用/已译/在途文字', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/', progressStatus({ spent: 12000, budget: 20000, translated: 3, queued: 2 }))
    replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    const meter = wrapper.get('[data-test="wt-progress"] .popup-card-meter')
    expect(meter.attributes('role')).toBe('progressbar')
    expect(meter.attributes('aria-label')).toBe(en.wtProgressLabel)
    expect(meter.attributes('aria-valuemin')).toBe('0')
    expect(meter.attributes('aria-valuemax')).toBe('20000')
    expect(meter.attributes('aria-valuenow')).toBe('12000')
    expect(wrapper.get('[data-test="wt-progress-text"]').text()).toBe(
      '12K / 20K characters used · 3 translated · 2 in progress',
    )
    wrapper.unmount()
  })

  it('模型翻译进度：不限额度时无进度条', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    tabAndStatus('https://example.com/', progressStatus({ spent: 1500, budget: 0, translated: 0, queued: 1 }))
    replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('.popup-card-meter').exists()).toBe(false)
    expect(wrapper.get('[data-test="wt-progress-text"]').text()).toBe(
      '1.5K characters used (no limit) · 1 in progress',
    )
    wrapper.unmount()
  })

  it.each([
    ['无翻译活动', {}, { spent: 0, budget: 20000, translated: 0, queued: 0 }, {}],
    ['敏感页', { url: 'https://accounts.google.com/' }, { spent: 12000, budget: 20000, translated: 3, queued: 2 }, {}],
    [
      '范围外',
      { url: 'https://example.com/' },
      { spent: 12000, budget: 20000, translated: 3, queued: 2 },
      { config: { ...CONFIG, siteScopeMode: 'include' as const, siteScopeHosts: ['other.example'] } },
    ],
    ['总开关关闭', { url: 'https://example.com/', disabled: true }, { spent: 12000, budget: 20000, translated: 3, queued: 2 }, {}],
    [
      '无自动/暂停/上限状态',
      { url: 'https://example.com/' },
      { spent: 12000, budget: 20000, translated: 3, queued: 2 },
      { flags: { auto: false, paused: false, capped: false } },
    ],
  ] as const)('进度不显示：%s', async (_name, setup, progress, extra) => {
    const { url = 'https://example.com/', disabled = false } = setup as { url?: string; disabled?: boolean }
    const { config = CONFIG, flags = {} } = extra as { config?: TranslationConfig; flags?: Record<string, unknown> }
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: !disabled })
    tabAndStatus(url, progressStatus(progress, flags))
    replies({ 'wt:get-config': () => ({ ok: true, config }) })
    const wrapper = mountStatusCard()
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('[data-test="wt-progress"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('状态卡每 1.5 秒轮询页面状态，进度文字随之更新；卸载后停止', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await settingsItem.setValue(DEFAULT_SETTINGS)
      let spent = 100
      const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({
        ok: true,
        status: {
          ...ACTIVE_STATUS,
          progress: { spent, budget: 20000, translated: 1, queued: 0 },
        },
      }))
      vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(
        async () => [{ id: 9, url: 'https://example.com/' }] as never,
      )
      replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
      const wrapper = mountStatusCard()
      await flushPromises()
      await flushPromises()
      expect(wrapper.get('[data-test="wt-progress-text"]').text()).toBe('100 / 20K characters used · 1 translated')

      spent = 24000
      vi.advanceTimersByTime(STATUS_POLL_MS)
      await flushPromises()
      await flushPromises()
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(wrapper.get('[data-test="wt-progress-text"]').text()).toBe('24K / 20K characters used · 1 translated')

      const calls = send.mock.calls.length
      wrapper.unmount()
      vi.advanceTimersByTime(STATUS_POLL_MS * 3)
      await flushPromises()
      expect(send.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('轮询请求未返回时不重叠发起', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await settingsItem.setValue(DEFAULT_SETTINGS)
      const reply = progressStatus({ spent: 100, budget: 20000, translated: 1, queued: 0 })
      let release!: (value: unknown) => void
      const gate = new Promise((resolve) => {
        release = resolve
      })
      const send = vi
        .spyOn(fakeBrowser.tabs, 'sendMessage')
        .mockImplementationOnce(async () => reply)
        .mockImplementation(() => gate)
      vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(
        async () => [{ id: 9, url: 'https://example.com/' }] as never,
      )
      replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
      const wrapper = mountStatusCard()
      await flushPromises()
      await flushPromises()
      expect(send).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(STATUS_POLL_MS)
      await flushPromises()
      expect(send).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(STATUS_POLL_MS)
      await flushPromises()
      expect(send).toHaveBeenCalledTimes(2)

      release(reply)
      await flushPromises()
      vi.advanceTimersByTime(STATUS_POLL_MS)
      await flushPromises()
      expect(send).toHaveBeenCalledTimes(3)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('轮询超时不清空状态：进度与徽章保持，恢复后更新', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await settingsItem.setValue(DEFAULT_SETTINGS)
      let spent = 100
      let fail = false
      vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => {
        if (fail) throw new Error('timeout')
        return {
          ok: true,
          status: { ...ACTIVE_STATUS, progress: { spent, budget: 20000, translated: 1, queued: 0 } },
        }
      })
      vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(
        async () => [{ id: 9, url: 'https://example.com/' }] as never,
      )
      replies({ 'wt:get-config': () => ({ ok: true, config: CONFIG }) })
      const wrapper = mountStatusCard()
      await flushPromises()
      await flushPromises()
      const badge = wrapper.get('[data-test="wt-page-state"]').text()
      expect(wrapper.get('[data-test="wt-progress-text"]').text()).toBe('100 / 20K characters used · 1 translated')

      fail = true
      vi.advanceTimersByTime(STATUS_POLL_MS)
      await flushPromises()
      await flushPromises()
      expect(wrapper.get('[data-test="wt-progress-text"]').text()).toBe('100 / 20K characters used · 1 translated')
      expect(wrapper.get('[data-test="wt-page-state"]').text()).toBe(badge)

      fail = false
      spent = 5000
      vi.advanceTimersByTime(STATUS_POLL_MS)
      await flushPromises()
      await flushPromises()
      expect(wrapper.get('[data-test="wt-progress-text"]').text()).toBe('5K / 20K characters used · 1 translated')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('连接测试按钮与未保存改动', () => {
  it('保存并连接后「测试连接」可用', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    let stored: TranslationConfig = { ...DEFAULT_TRANSLATION_CONFIG }
    replies({
      'wt:get-config': () => ({ ok: true, config: stored, hasKey: false, keyState: 'none' }),
      'wt:save-config': (message) => {
        stored = { ...stored, ...(message.patch as Partial<TranslationConfig>) }
        return { ok: true, config: stored, hasKey: true, keyState: 'ready' }
      },
      'wt:test': () => ({ ok: true, texts: ['ok'] }),
    })
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
    const wrapper = mount(TranslationSection)
    try {
      await flushPromises()
      await wrapper.get('input[placeholder="https://api.example.com/v1"]').setValue('https://api.example.com/v1')
      await wrapper.get('input[type="password"]').setValue('sk-fixture')
      await wrapper.get('[data-test="wt-model-input"]').setValue('m')
      await wrapper.get('[data-test="wt-save"]').trigger('click')
      await flushPromises()
      await flushPromises()
      expect(wrapper.get('.wt-status').text()).toBe(en.wtSavedOk)
      const button = wrapper.get('[data-test="wt-test-connection"]')
      expect(button.attributes('title')).toBeUndefined()
      expect(button.attributes('disabled')).toBeUndefined()
    } finally {
      wrapper.unmount()
      clearToasts()
    }
  })
})
