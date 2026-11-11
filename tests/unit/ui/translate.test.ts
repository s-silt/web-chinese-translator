import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { clearToasts, useToasts } from '../../../src/components/toast'
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from '../../../src/translation/config'
import { importSfc, required } from './sfc'
import { seedChineseUi, settle } from './helpers'

const App = await importSfc(() => import('../../../src/entrypoints/translate/App.vue'))

const copyMock = vi.hoisted(() => vi.fn(async (_text: string) => true))
vi.mock('../../../src/translation/clipboard', () => ({ copySelectionText: copyMock }))

enableAutoUnmount(afterEach)

const CONFIG: TranslationConfig = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  inputSourceLanguage: 'auto',
  inputTargetLanguage: 'en',
}

interface Sent {
  type: string
  text?: string
  sourceLanguage?: string
  targetLanguage?: string
  requestId?: string
  pageSession?: string
}

let sent: Sent[] = []
let translateReplies: ((message: Sent) => unknown)[] = []
let configReplies: (() => unknown)[] = []
let configReply: unknown = { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
let ports: { name: string; disconnect: ReturnType<typeof vi.fn> }[] = []

function installSendMessage(): void {
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
    const m = message as Sent
    sent.push(m)
    if (m.type === 'wt:get-config') {
      const next = configReplies.shift()
      return next === undefined ? configReply : next()
    }
    if (m.type === 'wt:translate-text') {
      const next = translateReplies.shift()
      return next === undefined ? { ok: false, error: 'x' } : next(m)
    }
    if (m.type === 'wt:cancel-assist') return { ok: true }
    return { ok: false, error: 'x' }
  })
}

async function render(): Promise<VueWrapper> {
  const wrapper = mount(required(App))
  await settle()
  return wrapper
}

function translateCalls(): Sent[] {
  return sent.filter((m) => m.type === 'wt:translate-text')
}

function cancelCalls(): Sent[] {
  return sent.filter((m) => m.type === 'wt:cancel-assist')
}

function deferred(): { promise: Promise<unknown>; resolve(value: unknown): void } {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(async () => {
  fakeBrowser.reset()
  sent = []
  translateReplies = []
  configReplies = []
  configReply = { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
  ports = []
  copyMock.mockReset()
  copyMock.mockResolvedValue(true)
  clearToasts()
  await seedChineseUi()
  vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation((({ name }: { name: string }) => {
    const port = { name, disconnect: vi.fn(), onDisconnect: { addListener: vi.fn() } }
    ports.push(port)
    return port
  }) as never)
  installSendMessage()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearToasts()
})

describe.skipIf(!App)('文本翻译窗口', () => {
  it('挂载后只读取配置，不自动发送翻译', async () => {
    const wrapper = await render()
    expect(sent.map((m) => m.type)).toEqual(['wt:get-config'])
    expect(translateCalls()).toHaveLength(0)
    wrapper.unmount()
  })

  it('点击翻译发送多行与 Markdown 原文，语言取窗口选择而非全局配置', async () => {
    translateReplies.push(() => ({ ok: true, texts: ['译文 **world**\n第二行'] }))
    const wrapper = await render()
    const markdown = 'Hello **world**\n\n- 第一项\n- 第二项\n\n`code` 与  空格  '
    await wrapper.get('[data-test="wt-text-input"]').setValue(markdown)
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(1)
    const call = translateCalls()[0]!
    expect(call.text).toBe(markdown)
    expect(call.sourceLanguage).toBe('auto')
    expect(call.targetLanguage).toBe('en')
    expect(call.requestId).toMatch(/^[a-zA-Z0-9-]{1,80}$/)
    expect(call.pageSession).toBeDefined()
    const result = wrapper.get('[data-test="wt-text-result"]')
    expect((result.element as HTMLTextAreaElement).value).toBe('译文 **world**\n第二行')
    expect(result.attributes('readonly')).toBeDefined()
    wrapper.unmount()
  })

  it('Ctrl+Enter 提交；输入法组字中的回车不提交', async () => {
    translateReplies.push(() => ({ ok: true, texts: ['译'] }))
    const wrapper = await render()
    const input = wrapper.get('[data-test="wt-text-input"]')
    await input.setValue('Hello')
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
    await settle()
    expect(translateCalls()).toHaveLength(0)
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true })
    await settle()
    expect(translateCalls()).toHaveLength(1)
    wrapper.unmount()
  })

  it('请求期间显示忙碌与取消；取消发送 wt:cancel-assist，迟到回复被忽略', async () => {
    const pending = deferred()
    translateReplies.push(() => pending.promise)
    const wrapper = await render()
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(1)
    const requestId = translateCalls()[0]!.requestId
    expect(wrapper.get('[data-test="wt-text-busy"]').text()).toContain('翻译中')
    expect((wrapper.get('[data-test="wt-text-translate"]').element as HTMLButtonElement).disabled).toBe(true)
    const cancel = wrapper.get('[data-test="wt-text-cancel"]')
    await cancel.trigger('click')
    await settle()
    expect(cancelCalls()).toEqual([{ type: 'wt:cancel-assist', requestId }])
    expect(wrapper.find('[data-test="wt-text-busy"]').exists()).toBe(false)
    expect((wrapper.get('[data-test="wt-text-translate"]').element as HTMLButtonElement).disabled).toBe(false)
    pending.resolve({ ok: true, texts: ['迟到的译文'] })
    await settle()
    expect((wrapper.get('[data-test="wt-text-result"]').element as HTMLTextAreaElement).value).toBe('')
    wrapper.unmount()
  })

  it('编辑输入、切换语言都会取消在途请求并清空结果', async () => {
    translateReplies.push(() => ({ ok: true, texts: ['第一版译文'] }))
    const wrapper = await render()
    const input = wrapper.get('[data-test="wt-text-input"]')
    await input.setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect((wrapper.get('[data-test="wt-text-result"]').element as HTMLTextAreaElement).value).toBe('第一版译文')

    const pending = deferred()
    translateReplies.push(() => pending.promise)
    await input.setValue('Hello again')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(2)
    await input.setValue('Hello edited')
    await settle()
    expect(cancelCalls()).toHaveLength(1)
    expect(cancelCalls()[0]!.requestId).toBe(translateCalls()[1]!.requestId)
    expect((wrapper.get('[data-test="wt-text-result"]').element as HTMLTextAreaElement).value).toBe('')
    pending.resolve({ ok: true, texts: ['不应出现'] })
    await settle()
    expect((wrapper.get('[data-test="wt-text-result"]').element as HTMLTextAreaElement).value).toBe('')

    const pending3 = deferred()
    translateReplies.push(() => pending3.promise)
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(3)
    await chooseLanguage(wrapper, 'wt-text-target', '日本語')
    await settle()
    expect(cancelCalls()).toHaveLength(2)
    expect(cancelCalls()[1]!.requestId).toBe(translateCalls()[2]!.requestId)
    pending3.resolve({ ok: true, texts: ['不应出现'] })
    await settle()
    expect((wrapper.get('[data-test="wt-text-result"]').element as HTMLTextAreaElement).value).toBe('')
    wrapper.unmount()
  })

  it('清空按钮清空输入、结果、错误与在途请求', async () => {
    translateReplies.push(() => ({ ok: false, error: '服务失败' }))
    const wrapper = await render()
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-test="wt-text-error"]').text()).toBe('服务失败')

    const pending = deferred()
    translateReplies.push(() => pending.promise)
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    await wrapper.get('[data-test="wt-text-clear"]').trigger('click')
    await settle()
    expect((wrapper.get('[data-test="wt-text-input"]').element as HTMLTextAreaElement).value).toBe('')
    expect((wrapper.get('[data-test="wt-text-result"]').element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.find('[data-test="wt-text-error"]').exists()).toBe(false)
    expect(cancelCalls()).toHaveLength(1)
    pending.resolve({ ok: true, texts: ['不应出现'] })
    await settle()
    wrapper.unmount()
  })

  it('超过 6000 字禁用翻译并显示可见说明，不截断、不发送', async () => {
    const wrapper = await render()
    const long = '字'.repeat(6001)
    await wrapper.get('[data-test="wt-text-input"]').setValue(long)
    await settle()
    expect(wrapper.get('[data-test="wt-text-count"]').text()).toContain('6001')
    expect(wrapper.get('[data-test="wt-text-count"]').classes()).toContain('is-danger')
    expect(wrapper.get('[data-test="wt-text-input"]').attributes('aria-invalid')).toBe('true')
    const hint = wrapper.get('[data-test="wt-text-submit-hint"]')
    expect(hint.text()).toContain('6000')
    expect(hint.attributes('id')).toBe('wt-text-submit-hint')
    expect(wrapper.find('[data-test="wt-text-error"]').exists()).toBe(false)
    const button = wrapper.get('[data-test="wt-text-translate"]')
    expect((button.element as HTMLButtonElement).disabled).toBe(true)
    expect(button.attributes('aria-describedby')).toBe('wt-text-submit-hint')
    await button.trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(0)
    expect((wrapper.get('[data-test="wt-text-input"]').element as HTMLTextAreaElement).value).toBe(long)

    await wrapper.get('[data-test="wt-text-input"]').setValue('字'.repeat(6000))
    await settle()
    expect(wrapper.get('[data-test="wt-text-input"]').attributes('aria-invalid')).toBeUndefined()
    expect((wrapper.get('[data-test="wt-text-translate"]').element as HTMLButtonElement).disabled).toBe(false)
    wrapper.unmount()
  })

  it('空文本与未配置模型禁用翻译并给出可见说明与操作', async () => {
    const wrapper = await render()
    const button = wrapper.get('[data-test="wt-text-translate"]')
    expect((button.element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.get('[data-test="wt-text-submit-hint"]').text()).toContain('粘贴')

    configReply = { ok: true, config: { ...CONFIG, baseUrl: '', model: '' }, hasKey: false, keyState: 'none' }
    const wrapper2 = await render()
    await wrapper2.get('[data-test="wt-text-input"]').setValue('Hello')
    await settle()
    expect(wrapper2.find('[data-test="wt-text-unconfigured"]').exists()).toBe(true)
    expect(wrapper2.get('[data-test="wt-text-configure"]').attributes('href')).toContain('options.html')
    const button2 = wrapper2.get('[data-test="wt-text-translate"]')
    expect((button2.element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper2.get('[data-test="wt-text-submit-hint"]').text()).toContain('未配置模型接口')
    await button2.trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(0)
    wrapper.unmount()
    wrapper2.unmount()
  })

  it('未配置时配置链接新窗口打开；窗口重新聚焦读到配置后草稿与语言选择保留', async () => {
    configReply = { ok: true, config: { ...CONFIG, baseUrl: '', model: '' }, hasKey: false, keyState: 'none' }
    const wrapper = await render()
    await wrapper.get('[data-test="wt-text-input"]').setValue('unsaved **draft**')
    await chooseLanguage(wrapper, 'wt-text-target', '日本語')
    const link = wrapper.get('[data-test="wt-text-configure"]')
    expect(link.attributes('href')).toContain('options.html')
    expect(link.attributes('href')).toContain('#wt-title')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')

    configReply = { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect((wrapper.get('[data-test="wt-text-input"]').element as HTMLTextAreaElement).value).toBe('unsaved **draft**')
    expect(wrapper.get('[data-test="wt-text-target"]').text()).toContain('日本語')
    expect(translateCalls()).toHaveLength(0)
    wrapper.unmount()
  })

  it('配置读取失败显示错误且不发送', async () => {
    configReply = { ok: false, error: '读取失败' }
    const wrapper = await render()
    expect(wrapper.get('[data-test="wt-text-load-error"]').text()).toContain('无法读取翻译设置')
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(0)
    wrapper.unmount()
  })

  it('窗口重新聚焦时重读配置：补齐模型后可翻译，语言选择不被覆盖', async () => {
    configReply = {
      ok: true,
      config: { ...CONFIG, baseUrl: '', model: '' },
      hasKey: false,
      keyState: 'none',
    }
    const wrapper = await render()
    expect(wrapper.find('[data-test="wt-text-unconfigured"]').exists()).toBe(true)
    await chooseLanguage(wrapper, 'wt-text-target', '日本語')
    configReply = { ok: true, config: { ...CONFIG, inputTargetLanguage: 'fr' }, hasKey: true, keyState: 'ready' }
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(wrapper.find('[data-test="wt-text-unconfigured"]').exists()).toBe(false)
    translateReplies.push(() => ({ ok: true, texts: ['訳'] }))
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(1)
    expect(translateCalls()[0]!.targetLanguage).toBe('ja')
    wrapper.unmount()
  })

  it('配置读取失败后重新聚焦读取成功则恢复', async () => {
    configReply = { ok: false, error: '读取失败' }
    const wrapper = await render()
    expect(wrapper.find('[data-test="wt-text-load-error"]').exists()).toBe(true)
    configReply = { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(wrapper.find('[data-test="wt-text-load-error"]').exists()).toBe(false)
    translateReplies.push(() => ({ ok: true, texts: ['译'] }))
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(1)
    wrapper.unmount()
  })

  it('复制结果成功与失败各有提示；无结果时不可复制', async () => {
    translateReplies.push(() => ({ ok: true, texts: ['译文'] }))
    const wrapper = await render()
    const copy = wrapper.get('[data-test="wt-text-copy"]')
    expect((copy.element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect((copy.element as HTMLButtonElement).disabled).toBe(false)
    await copy.trigger('click')
    await settle()
    expect(copyMock).toHaveBeenCalledWith('译文')
    expect(useToasts().value.at(-1)).toMatchObject({ tone: 'success', key: 'wtToolbarCopied' })

    copyMock.mockResolvedValue(false)
    await copy.trigger('click')
    await settle()
    expect(useToasts().value.at(-1)).toMatchObject({ tone: 'danger', key: 'wtToolbarCopyFailed' })
    wrapper.unmount()
  })

  it('模型设置链接指向选项页模型分区', async () => {
    const wrapper = await render()
    const link = wrapper.get('[data-test="wt-text-settings"]')
    expect(link.attributes('href')).toContain('options.html')
    expect(link.attributes('href')).toContain('#wt-title')
    wrapper.unmount()
  })

  it('默认源与目标语言取配置的输入语言', async () => {
    const wrapper = await render()
    expect(wrapper.get('[data-test="wt-text-source"]').text()).toContain('自动检测')
    expect(wrapper.get('[data-test="wt-text-target"]').text()).toContain('English')
    expect(translateCalls()).toHaveLength(0)
    wrapper.unmount()
  })

  it('加载失败可显式重试，重试不丢草稿与语言选择', async () => {
    configReply = { ok: false, error: '读取失败' }
    const wrapper = await render()
    expect(wrapper.get('[data-test="wt-text-load-error"]').text()).toContain('无法读取翻译设置')
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await chooseLanguage(wrapper, 'wt-text-target', '日本語')
    configReply = { ok: true, config: CONFIG, hasKey: true, keyState: 'ready' }
    await wrapper.get('[data-test="wt-text-reload"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="wt-text-load-error"]').exists()).toBe(false)
    expect((wrapper.get('[data-test="wt-text-input"]').element as HTMLTextAreaElement).value).toBe('Hello')
    translateReplies.push(() => ({ ok: true, texts: ['訳'] }))
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(1)
    expect(translateCalls()[0]!.targetLanguage).toBe('ja')
    wrapper.unmount()
  })

  it('配置重试进行中按钮禁用；过期读取结果被忽略，失败后恢复可点', async () => {
    configReply = { ok: false, error: '读取失败' }
    const wrapper = await render()
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    const stale = deferred()
    const latest = deferred()
    configReplies.push(() => stale.promise, () => latest.promise)
    await wrapper.get('[data-test="wt-text-reload"]').trigger('click')
    await settle()
    window.dispatchEvent(new Event('focus'))
    await settle()
    const reload = wrapper.get('[data-test="wt-text-reload"]')
    expect((reload.element as HTMLButtonElement).disabled).toBe(true)
    expect(reload.attributes('aria-busy')).toBe('true')

    latest.resolve({ ok: false, error: '仍失败' })
    await settle()
    expect((wrapper.get('[data-test="wt-text-reload"]').element as HTMLButtonElement).disabled).toBe(false)
    expect(wrapper.find('[data-test="wt-text-load-error"]').exists()).toBe(true)

    stale.resolve({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' })
    await settle()
    expect(wrapper.find('[data-test="wt-text-load-error"]').exists()).toBe(true)
    expect((wrapper.get('[data-test="wt-text-input"]').element as HTMLTextAreaElement).value).toBe('Hello')
    expect(translateCalls()).toHaveLength(0)
    wrapper.unmount()
  })

  it('过期的配置读取结果被忽略', async () => {
    const first = deferred()
    const second = deferred()
    configReplies.push(() => first.promise, () => second.promise)
    const wrapper = mount(required(App))
    await settle()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(sent.filter((m) => m.type === 'wt:get-config')).toHaveLength(2)
    second.resolve({ ok: true, config: CONFIG, hasKey: true, keyState: 'ready' })
    await settle()
    expect(wrapper.find('[data-test="wt-text-unconfigured"]').exists()).toBe(false)
    first.resolve({ ok: true, config: { ...CONFIG, baseUrl: '', model: '' }, hasKey: false, keyState: 'none' })
    await settle()
    expect(wrapper.find('[data-test="wt-text-unconfigured"]').exists()).toBe(false)
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    translateReplies.push(() => ({ ok: true, texts: ['译'] }))
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(1)
    wrapper.unmount()
  })

  it('请求错误后可重试，重试保留输入文本', async () => {
    translateReplies.push(
      () => ({ ok: false, error: '服务失败' }),
      () => ({ ok: true, texts: ['译文'] }),
    )
    const wrapper = await render()
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-test="wt-text-error"]').text()).toBe('服务失败')
    await wrapper.get('[data-test="wt-text-retry"]').trigger('click')
    await settle()
    expect(translateCalls()).toHaveLength(2)
    expect(translateCalls()[1]!.text).toBe('Hello')
    expect((wrapper.get('[data-test="wt-text-result"]').element as HTMLTextAreaElement).value).toBe('译文')
    expect(wrapper.find('[data-test="wt-text-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('成功后显示完成状态；忙碌为 polite、错误为唯一 assertive 实时区', async () => {
    translateReplies.push(() => ({ ok: true, texts: ['译'] }))
    const wrapper = await render()
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-test="wt-text-complete"]').text()).toContain('翻译完成')

    const pending = deferred()
    translateReplies.push(() => pending.promise)
    await wrapper.get('[data-test="wt-text-input"]').setValue('再来')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    const busy = wrapper.get('[data-test="wt-text-busy"]')
    expect(busy.attributes('role')).toBe('status')
    pending.resolve({ ok: false, error: '服务失败' })
    await settle()
    const alerts = wrapper.findAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(wrapper.get('[data-test="wt-text-error"]').element.closest('[role="alert"]')).toBe(alerts[0]!.element)
    wrapper.unmount()
  })

  it('清空后焦点回到输入框', async () => {
    const wrapper = mount(required(App), { attachTo: document.body })
    await settle()
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-clear"]').trigger('click')
    await settle()
    expect((document.activeElement as HTMLElement | null)?.dataset.test).toBe('wt-text-input')
    wrapper.unmount()
  })

  it('卸载时断开页面会话端口', async () => {
    translateReplies.push(() => ({ ok: true, texts: ['译'] }))
    const wrapper = await render()
    await wrapper.get('[data-test="wt-text-input"]').setValue('Hello')
    await wrapper.get('[data-test="wt-text-translate"]').trigger('click')
    await settle()
    expect(ports.length).toBeGreaterThan(0)
    wrapper.unmount()
    for (const port of ports) expect(port.disconnect).toHaveBeenCalled()
  })
})

async function chooseLanguage(wrapper: VueWrapper, testId: string, label: string): Promise<void> {
  const trigger = wrapper.get(`[data-test="${testId}"]`)
  await trigger.trigger('click')
  const id = trigger.attributes('aria-controls') ?? ''
  const option = wrapper
    .get(`#${CSS.escape(id)}`)
    .findAll('[role="option"]')
    .find((item) => item.text() === label)
  if (option === undefined) throw new Error(`未找到选项：${label}`)
  await option.trigger('click')
}
