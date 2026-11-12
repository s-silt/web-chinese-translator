import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translateMessage } from '../../../src/i18n'
import zhCN from '../../../src/i18n/zh-CN'
import zhTW from '../../../src/i18n/zh-TW'
import {
  isChatEditorCandidate,
  isChatPlainEditor,
  isSupportedChatUrl,
  readChatDraft,
  replaceChatDraftInMainWorld,
  type ChatReplacementStatus,
} from '../../../src/translation/chat-input'
import {
  isDiscordChatUrl,
  isDiscordPlainEditor,
  readDiscordDraft,
  replaceDiscordDraftInMainWorld,
  type DiscordReplacementStatus,
} from '../../../src/translation/discord-input'
import { createInputTranslation as createInputTranslationController } from '../../../src/translation/input-translation'
import * as clipboard from '../../../src/translation/clipboard'
import { isNativeVideoChatEditor, planNativeVideoChatDraft } from '../../../src/translation/video-chat-input'
import { getCapturedShadowRoot, installShadowRootCapture } from '../shared/shadow-roots'

vi.mock('../../../src/translation/clipboard', () => ({
  copySelectionText: vi.fn(async () => true),
}))

const activeInputWatchers: Array<ReturnType<typeof createInputTranslationController>> = []

function createInputTranslation(...args: Parameters<typeof createInputTranslationController>): ReturnType<typeof createInputTranslationController> {
  const watcher = createInputTranslationController(...args)
  activeInputWatchers.push(watcher)
  return watcher
}

let restoreShadowCapture: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  restoreShadowCapture = installShadowRootCapture()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 10, y: 10, width: 200, height: 32, top: 10, left: 10, right: 210, bottom: 42 }) as DOMRect,
  )
})

afterEach(() => {
  while (activeInputWatchers.length > 0) activeInputWatchers.pop()?.dispose()
  restoreShadowCapture?.()
  restoreShadowCapture = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function trustedBeforeInput(field: Element, isComposing = false): void {
  if (field instanceof HTMLElement) focusEditable(field)
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    composed: true,
    cancelable: true,
    inputType: 'insertText',
    data: '你',
    isComposing,
  })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  field.dispatchEvent(event)
}

function trustedInput(target: Element, value?: string, isComposing = false): void {
  if (target instanceof HTMLElement) focusEditable(target)
  if (value !== undefined) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value = value
    } else {
      target.textContent = value
    }
  }
  const event = new InputEvent('input', { bubbles: true, composed: true, isComposing })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function trustedComposition(target: Element, type: 'compositionstart' | 'compositionend'): void {
  if (target instanceof HTMLElement) focusEditable(target)
  const event = new CompositionEvent(type, { bubbles: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function trustedClick(target: Element): void {
  const event = new MouseEvent('click', { bubbles: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function popoverShadow(): ShadowRoot | undefined {
  return getCapturedShadowRoot(document.querySelector('[data-wt-root]'))
}

function requirePopoverButton(action: 'replace' | 'restore' | 'copy' | 'copy-original'): HTMLButtonElement {
  const button = popoverShadow()?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
  if (button === undefined || button === null) throw new Error(`missing popover ${action} button`)
  return button
}

function isPopoverOpen(): boolean {
  const host = document.querySelector<HTMLElement>('[data-wt-root]')
  return host !== null && host.style.display !== 'none'
}

describe('输入翻译触发、防抖、IME 与过滤规则', () => {
  it('初始草稿与仅聚焦不触发，非可信合成事件不触发，英文忽略，IME 结束后按默认 1000ms 空闲间隔只发最新值', async () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = '页面初始就有的草稿'
    document.body.append(input)

    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: texts.map((t) => `EN:${t}`),
    }))
    const cancel = vi.fn()
    const watcher = createInputTranslation({
      translate,
      cancel,
      t: (k) => zhCN[k],
    })

    input.focus()
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    input.value = '脚本合成输入'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    trustedInput(input, 'Purely English message')
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    trustedComposition(input, 'compositionstart')
    trustedInput(input, '正在拼音输入', true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    input.value = '第一版中文'
    trustedComposition(input, 'compositionend')
    await vi.advanceTimersByTimeAsync(300)
    trustedInput(input, '最终确认的中文草稿')
    await vi.advanceTimersByTimeAsync(990)
    expect(translate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(20)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['最终确认的中文草稿'])
    expect(input.value).toBe('EN:最终确认的中文草稿')
    expect(isPopoverOpen()).toBe(true)
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputRestoreHint)

    watcher.dispose()
  })

  it('敏感字段矩阵与复杂富文本编辑器均严格跳过', async () => {
    document.body.innerHTML = `
      <input id="pw" type="password" />
      <input id="ac" type="text" autocomplete="one-time-code" />
      <input id="tok" type="text" name="api_token" />
      <input id="cn-label" type="text" aria-label="请输入支付密码" />
      <input id="jp-label" type="text" placeholder="認証コードを入力" />
      <input id="ro" type="text" readonly />
      <div class="ProseMirror" contenteditable="true" id="pm"></div>
      <div data-lexical-editor="true" contenteditable="true" id="lex"></div>
      <div contenteditable="true" id="rich-child"><a href="https://example.com">@mention</a></div>
    `
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Translated'] }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    for (const id of ['pw', 'ac', 'tok', 'cn-label', 'jp-label', 'ro', 'pm', 'lex']) {
      const el = document.getElementById(id)!
      trustedInput(el, '需要翻译的中文内容')
    }
    const richChild = document.getElementById('rich-child')!
    richChild.append(document.createTextNode('需要翻译的中文内容'))
    trustedInput(richChild)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    expect(isPopoverOpen()).toBe(false)

    watcher.dispose()
  })

  it('网页搜索框（type=search）同样直接替换，网址、邮箱、数字等输入框不处理', async () => {
    document.body.innerHTML = `
      <input id="search" type="search" />
      <input id="url" type="url" />
      <input id="email" type="email" />
      <input id="num" type="number" />
    `
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: texts.map((t) => `EN:${t}`) }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    for (const id of ['url', 'email', 'num']) {
      trustedInput(document.getElementById(id)!, '需要翻译的中文内容')
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    trustedInput(document.getElementById('search')!, '搜索开源翻译工具')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate.mock.calls.map((call) => call[0])).toEqual([['搜索开源翻译工具']])
    expect(isPopoverOpen()).toBe(true)
    watcher.dispose()
  })
})

describe('直接替换、还原、失败复制与安全并发保护', () => {
  it('textarea 与普通 contenteditable 自动替换、触发 beforeinput/input 且绝不触发提交，支持还原并在被编辑后拒绝还原', async () => {
    const textarea = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(textarea, editable)

    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [`Hello: ${texts[0]}`],
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    const observedEvents: string[] = []
    textarea.addEventListener('beforeinput', () => observedEvents.push('beforeinput'))
    textarea.addEventListener('input', () => observedEvents.push('input'))
    textarea.addEventListener('keydown', () => observedEvents.push('keydown'))
    textarea.addEventListener('submit', () => observedEvents.push('submit'))

    trustedInput(textarea, '你好，请帮我检查这段代码')
    observedEvents.length = 0
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    const shadow = popoverShadow()!
    expect(shadow.querySelector('button[data-action="replace"]')).toBeNull()
    expect(textarea.value).toBe('Hello: 你好，请帮我检查这段代码')
    expect(document.activeElement).toBe(textarea)
    expect(observedEvents).toEqual(['beforeinput', 'input'])

    const restoreBtn = shadow.querySelector<HTMLButtonElement>('button[data-action="restore"]')!
    expect(restoreBtn).not.toBeNull()
    trustedClick(restoreBtn)
    expect(textarea.value).toBe('你好，请帮我检查这段代码')
    expect(document.activeElement).toBe(textarea)
    const statusRightAfterRestore = shadow.querySelector('[role="status"]')?.textContent
    const actionsRightAfterRestore = shadow.querySelector('.actions')?.children.length

    textarea.focus()
    expect(watcher.translateAndReplace()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(textarea.value).toBe('Hello: 你好，请帮我检查这段代码')

    textarea.value = 'Hello: 你好，用户又手动改了字'
    const restoreAfterEdit = shadow.querySelector<HTMLButtonElement>('button[data-action="restore"]')!
    trustedClick(restoreAfterEdit)
    expect(textarea.value).toBe('Hello: 你好，用户又手动改了字')
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputTextChanged)

    trustedInput(editable, '纯文本可编辑区域')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(editable.textContent).toBe('Hello: 纯文本可编辑区域')
    expect(document.activeElement).toBe(editable)

    watcher.dispose()
    expect(statusRightAfterRestore).toBe('')
    expect(actionsRightAfterRestore).toBe(0)
  })

  it('普通 contenteditable 多行结构（div/br 与空行）保留逻辑换行，替换与还原保持 BR 节点与文本值且不丢失首尾空白', async () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(editable)

    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [texts[0] === '你好\n\n世界' ? 'Hello\n\nWorld' : '  Line 1\nLine 2  '],
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    editable.innerHTML = '<div>你好</div><div><br></div><div>世界</div>'
    trustedInput(editable)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['你好\n\n世界'])

    const shadow = popoverShadow()!
    expect(editable.querySelectorAll('br')).toHaveLength(2)
    expect(editable.innerHTML).toBe('Hello<br><br>World')
    expect(document.activeElement).toBe(editable)

    trustedClick(shadow.querySelector<HTMLButtonElement>('button[data-action="restore"]')!)
    expect(editable.querySelectorAll('br')).toHaveLength(2)
    expect(editable.innerHTML).toBe('你好<br><br>世界')

    editable.innerHTML = '  你好<br>世界  '
    trustedInput(editable)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]?.[0]).toEqual(['  你好\n世界  '])

    expect(editable.innerHTML).toBe('  Line 1<br>Line 2  ')

    trustedClick(shadow.querySelector<HTMLButtonElement>('button[data-action="restore"]')!)
    expect(editable.innerHTML).toBe('  你好<br>世界  ')

    watcher.dispose()
  })

  it('动态资格复检：防抖中、请求在途、替换前或 beforeinput 中变为密码/只读/富文本/脱敏/移除时严禁发送或写入', async () => {
    const input = document.createElement('input')
    input.type = 'text'
    document.body.append(input)

    let pendingResolve: ((value: { ok: true; texts: string[] }) => void) | undefined
    const translate = vi.fn((texts: string[]) => {
      if (texts[0] === '在途变敏感' || texts[0] === '在途切换字段' || texts[0] === '回复后变密码' || texts[0] === '动态切换富文本类名') {
        return new Promise<{ ok: true; texts: string[] }>((resolve) => {
          pendingResolve = resolve
        })
      }
      return Promise.resolve({ ok: true as const, texts: [`EN:${texts[0]}`] })
    })
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    trustedInput(input, '防抖中变成密码')
    await vi.advanceTimersByTimeAsync(200)
    input.type = 'password'
    await vi.advanceTimersByTimeAsync(900)
    expect(translate).not.toHaveBeenCalled()
    expect(isPopoverOpen()).toBe(false)

    input.type = 'text'
    trustedInput(input, '在途变敏感')
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    input.setAttribute('aria-label', '请输入安全密码')
    pendingResolve?.({ ok: true, texts: ['Should not show'] })
    await Promise.resolve()
    expect(isPopoverOpen()).toBe(false)
    input.removeAttribute('aria-label')

    trustedInput(input, '回复后变密码')
    await vi.advanceTimersByTimeAsync(1000)
    expect(isPopoverOpen()).toBe(true)
    input.type = 'password'
    pendingResolve?.({ ok: true, texts: ['Should not write'] })
    await Promise.resolve()
    expect(input.value).toBe('回复后变密码')

    input.type = 'text'
    trustedInput(input, '拦截器变密码')
    input.addEventListener(
      'beforeinput',
      () => {
        input.type = 'password'
      },
      { once: true },
    )
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    const shadow = popoverShadow()!
    expect(input.value).toBe('拦截器变密码')
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)

    input.type = 'text'
    trustedInput(input, '拦截器移除节点')
    input.addEventListener(
      'beforeinput',
      () => {
        input.remove()
      },
      { once: true },
    )
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(input.value).toBe('拦截器移除节点')
    document.body.append(input)

    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(editable)
    trustedInput(editable, '动态切换富文本类名')
    await vi.advanceTimersByTimeAsync(1000)
    editable.classList.add('ProseMirror')
    pendingResolve?.({ ok: true, texts: ['Should not write'] })
    await Promise.resolve()
    expect(editable.textContent).toBe('动态切换富文本类名')

    const otherInput = document.createElement('input')
    otherInput.type = 'text'
    document.body.append(otherInput)
    trustedInput(input, '在途切换字段')
    await vi.advanceTimersByTimeAsync(1000)
    otherInput.focus()
    otherInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    watcher.dispose()
    pendingResolve?.({ ok: true, texts: ['Stale reply'] })
    await Promise.resolve()
    expect(document.querySelector('[data-wt-root]')).toBeNull()
  })

  it('替换前文本已被改动或 beforeinput 被阻止时拒绝替换，关闭后同一文本不再重复弹出', async () => {
    const input = document.createElement('input')
    input.type = 'text'
    document.body.append(input)

    let resolveTranslate: ((value: { ok: true; texts: string[] }) => void) | undefined
    const translate = vi.fn(() => new Promise<{ ok: true; texts: string[] }>((resolve) => {
      resolveTranslate = resolve
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    trustedInput(input, '原始中文一')
    await vi.advanceTimersByTimeAsync(1000)
    input.value = '悄然改变的中文'
    resolveTranslate?.({ ok: true, texts: ['English result'] })
    await Promise.resolve()
    expect(input.value).toBe('悄然改变的中文')
    expect(isPopoverOpen()).toBe(false)

    trustedInput(input, '测试阻止替换')
    input.addEventListener('beforeinput', (e) => e.preventDefault(), { once: true })
    await vi.advanceTimersByTimeAsync(1000)
    resolveTranslate?.({ ok: true, texts: ['English result'] })
    await Promise.resolve()
    const shadow = popoverShadow()!
    expect(input.value).toBe('测试阻止替换')
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)

    const closeBtn = shadow.querySelector<HTMLButtonElement>('button[data-action="close"]')!
    trustedClick(closeBtn)
    expect(isPopoverOpen()).toBe(false)

    watcher.dispose()
  })

  it('单行输入框遇到含换行的译文时不写入、不派发事件，原文保持不变', async () => {
    const input = document.createElement('input')
    input.type = 'text'
    document.body.append(input)
    const watcher = createInputTranslation({
      translate: vi.fn(async () => ({ ok: true as const, texts: ['Hello\nworld'] })),
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })
    try {
      trustedInput(input, '你好世界')
      const events: string[] = []
      input.addEventListener('beforeinput', () => events.push('beforeinput'))
      input.addEventListener('input', () => events.push('input'))
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      expect(input.value).toBe('你好世界')
      expect(events).toEqual([])
      expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)
      expect(popoverShadow()?.querySelector('button[data-action="copy-original"]')).toBeNull()
    } finally {
      watcher.dispose()
    }
  })

  it('页面在 input 事件里改写了写入内容：按已修改处理，提示可恢复并能复制原文，不提供还原', async () => {
    const area = document.createElement('textarea')
    document.body.append(area)
    const watcher = createInputTranslation({
      translate: vi.fn(async () => ({ ok: true as const, texts: ['Hello wonderful world'] })),
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })
    try {
      trustedInput(area, '你好世界啊')
      area.addEventListener('input', () => {
        area.value = area.value.slice(0, 12)
      })
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      expect(area.value).toBe('Hello wonder')
      expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplacePartial)
      expect(popoverShadow()?.querySelector('button[data-action="restore"]')).toBeNull()
      trustedClick(requirePopoverButton('copy-original'))
      await Promise.resolve()
      expect(clipboard.copySelectionText).toHaveBeenCalledWith('你好世界啊')
    } finally {
      watcher.dispose()
    }
  })

  it('页面在 input 事件里把内容改回原文：按未写入处理，不提示内容可能已改变', async () => {
    const area = document.createElement('textarea')
    document.body.append(area)
    const watcher = createInputTranslation({
      translate: vi.fn(async () => ({ ok: true as const, texts: ['English result'] })),
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })
    try {
      trustedInput(area, '原始中文')
      area.addEventListener('input', () => {
        area.value = '原始中文'
      })
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      expect(area.value).toBe('原始中文')
      expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)
      expect(popoverShadow()?.querySelector('button[data-action="copy-original"]')).toBeNull()
    } finally {
      watcher.dispose()
    }
  })
})

function setPageUrl(url: string): void {
  const happy = (window as Window & { happyDOM?: { setURL(next: string): void } }).happyDOM
  if (happy === undefined) throw new Error('happyDOM.setURL unavailable')
  happy.setURL(url)
}

function mountSlate(lines: readonly string[]): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('data-slate-editor', 'true')
  root.setAttribute('contenteditable', 'true')
  root.setAttribute('role', 'textbox')
  root.setAttribute('aria-label', 'Message')
  for (const line of lines) {
    const block = document.createElement('div')
    block.setAttribute('data-slate-node', 'element')
    if (line === '') {
      const zero = document.createElement('span')
      zero.setAttribute('data-slate-zero-width', 'n')
      zero.setAttribute('contenteditable', 'false')
      zero.append(document.createTextNode('\uFEFF'), document.createElement('br'))
      block.append(zero)
    } else {
      const text = document.createElement('span')
      text.setAttribute('data-slate-node', 'text')
      const leaf = document.createElement('span')
      leaf.setAttribute('data-slate-leaf', 'true')
      const stringNode = document.createElement('span')
      stringNode.setAttribute('data-slate-string', 'true')
      stringNode.textContent = line
      leaf.append(stringNode)
      text.append(leaf)
      block.append(text)
    }
    root.append(block)
  }
  document.body.append(root)
  return root
}

function writeSlateText(root: HTMLElement, text: string): void {
  const blocks = [...root.querySelectorAll(':scope > [data-slate-node="element"]')]
  const first = blocks[0]
  if (!(first instanceof HTMLElement)) return
  for (const extra of blocks.slice(1)) extra.remove()
  const stringNode = document.createElement('span')
  stringNode.setAttribute('data-slate-string', 'true')
  stringNode.textContent = text
  first.replaceChildren(stringNode)
}

describe('Discord 纯文本草稿', () => {
  afterEach(() => {
    setPageUrl('about:blank')
  })

  it.each(['animation', 'timeout'] as const)('切换目标后重新聚焦同一草稿，%s 收尾仍使旧还原记录失效', async (completion) => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate(['原始草稿'])
    const outside = document.createElement('button')
    document.body.append(outside)
    const replaceDiscordInput = vi.fn(async (request: { text: string }) => {
      writeSlateText(field, request.text)
      return 'ok' as const
    })
    const watcher = createInputTranslation({
      translate: vi.fn(async () => ({ ok: true as const, texts: ['Translated draft'] })),
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      replaceDiscordInput,
    })
    try {
      focusEditable(field)
      expect(watcher.translateAndReplace()).toBe(true)
      await vi.advanceTimersByTimeAsync(300)
      expect(readDiscordDraft(field)).toBe('Translated draft')
      expect(requirePopoverButton('restore')).not.toBeNull()
      const popover = popoverShadow()!.querySelector<HTMLElement>('.popover')!
      let finishAnimation: () => void = () => undefined
      const finished = new Promise<void>((resolve) => { finishAnimation = resolve })
      Object.defineProperty(popover, 'getAnimations', {
        value: () => [{ animationName: 'wt-surface-exit', finished }],
      })
      outside.focus()
      await vi.advanceTimersByTimeAsync(20)
      expect(popover.hasAttribute('data-wt-closing')).toBe(true)
      field.focus()
      if (completion === 'animation') finishAnimation()
      await vi.advanceTimersByTimeAsync(200)
      expect(isPopoverOpen()).toBe(false)
      expect(popover.querySelector('button[data-action="restore"]')).toBeNull()
      expect(readDiscordDraft(field)).toBe('Translated draft')
      expect(replaceDiscordInput).toHaveBeenCalledTimes(1)
    } finally {
      watcher.dispose()
    }
  })

  it.each(['内容改变', '主动关闭'] as const)('淡出重入前%s后不恢复旧撤销记录', async (invalidation) => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate(['原始草稿'])
    const outside = document.createElement('button')
    document.body.append(outside)
    const replaceDiscordInput = vi.fn(async (request: { text: string }) => {
      writeSlateText(field, request.text)
      return 'ok' as const
    })
    const watcher = createInputTranslation({
      translate: vi.fn(async () => ({ ok: true as const, texts: ['Translated draft'] })),
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      replaceDiscordInput,
    })
    try {
      focusEditable(field)
      expect(watcher.translateAndReplace()).toBe(true)
      await vi.advanceTimersByTimeAsync(300)
      expect(requirePopoverButton('restore')).not.toBeNull()
      const popover = popoverShadow()!.querySelector<HTMLElement>('.popover')!
      Object.defineProperty(popover, 'getAnimations', {
        value: () => [{ animationName: 'wt-surface-exit', finished: new Promise<void>(() => undefined) }],
      })
      if (invalidation === '主动关闭') trustedClick(popover.querySelector('button[data-action="close"]')!)
      outside.focus()
      await vi.advanceTimersByTimeAsync(20)
      if (invalidation === '内容改变') writeSlateText(field, 'Changed draft')
      field.focus()
      await vi.advanceTimersByTimeAsync(200)
      expect(isPopoverOpen()).toBe(false)
      expect(popover.querySelector('button[data-action="restore"]')).toBeNull()
      expect(readDiscordDraft(field)).toBe(invalidation === '内容改变' ? 'Changed draft' : 'Translated draft')
      expect(replaceDiscordInput).toHaveBeenCalledTimes(1)
    } finally {
      watcher.dispose()
    }
  })

  it('只接受三个 Discord 主机的 https /channels/ 路径', () => {
    expect(isDiscordChatUrl('https://discord.com/channels/@me/1')).toBe(true)
    expect(isDiscordChatUrl('https://canary.discord.com/channels/a')).toBe(true)
    expect(isDiscordChatUrl('https://ptb.discord.com/channels/a')).toBe(true)
    expect(isDiscordChatUrl('https://DISCORD.COM/channels/x')).toBe(true)
    for (const url of [
      'https://discord.com/login',
      'https://discord.com/channels',
      'http://discord.com/channels/1',
      'https://evil-discord.com/channels/1',
      'https://discord.com.evil/channels/1',
      'https://sub.discord.com/channels/1',
      'https://notdiscord.com/channels/1',
      'notaurl',
    ]) {
      expect(isDiscordChatUrl(url)).toBe(false)
    }
  })

  it('读取多行、空行、零宽占位和行内格式，并拒绝复杂结构', () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const root = mountSlate(['  你好  ', '', '世界'])
    const formatted = root.querySelector('[data-slate-string="true"]')
    if (!(formatted instanceof HTMLElement)) throw new Error('missing slate string')
    formatted.textContent = ''
    const strong = document.createElement('strong')
    strong.textContent = '你'
    formatted.append(strong, document.createTextNode('好  '))
    expect(readDiscordDraft(root)).toBe('你好  \n\n世界')
    expect(isDiscordPlainEditor(root)).toBe(true)

    const locked = document.createElement('span')
    locked.setAttribute('contenteditable', 'false')
    locked.textContent = '锁'
    root.append(locked)
    expect(isDiscordPlainEditor(root)).toBe(false)
    locked.remove()

    const mention = document.createElement('a')
    mention.textContent = '@someone'
    root.append(mention)
    expect(isDiscordPlainEditor(root)).toBe(false)
    mention.remove()

    const voidNode = document.createElement('span')
    voidNode.setAttribute('data-slate-void', 'true')
    root.append(voidNode)
    expect(isDiscordPlainEditor(root)).toBe(false)
    voidNode.remove()

    const nested = document.createElement('div')
    nested.setAttribute('data-slate-node', 'element')
    root.querySelector('[data-slate-node="element"]')?.append(nested)
    expect(isDiscordPlainEditor(root)).toBe(false)

    const empty = mountSlate([''])
    const placeholder = document.createElement('span')
    placeholder.setAttribute('data-slate-placeholder', 'true')
    placeholder.setAttribute('contenteditable', 'false')
    placeholder.textContent = '输入消息'
    empty.querySelector('[data-slate-node="element"]')?.append(placeholder)
    expect(isDiscordPlainEditor(empty)).toBe(true)
    expect(readDiscordDraft(empty)).toBe('')
  })

  it('Discord 网页纯文本草稿请求翻译并安全回落复制，其他主机、ProseMirror、提及和 void 不请求', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate(['水水水水水水'])
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['水水水水水水'])
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputEditorUnsupported)

    translate.mockClear()
    for (const url of ['https://evil-discord.com/channels/@me/1', 'https://chat.example/channels/1']) {
      setPageUrl(url)
      const foreign = mountSlate(['需要翻译的中文内容'])
      trustedInput(foreign)
    }
    setPageUrl('https://discord.com/channels/@me/1')
    const prose = document.createElement('div')
    prose.className = 'ProseMirror'
    prose.setAttribute('contenteditable', 'true')
    prose.textContent = '需要翻译的中文内容'
    document.body.append(prose)
    trustedInput(prose)
    const mentionHost = mountSlate(['你好'])
    const anchor = document.createElement('a')
    anchor.textContent = '@someone'
    mentionHost.append(anchor)
    trustedInput(mentionHost)
    const voidHost = mountSlate(['你好'])
    const voidNode = document.createElement('span')
    voidNode.setAttribute('data-slate-void', 'true')
    voidHost.append(voidNode)
    trustedInput(voidHost)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    setPageUrl('https://discord.com/channels/@me/1')
    const empty = mountSlate([''])
    const emptyPlaceholder = document.createElement('span')
    emptyPlaceholder.setAttribute('data-slate-placeholder', 'true')
    emptyPlaceholder.setAttribute('contenteditable', 'false')
    emptyPlaceholder.textContent = '输入消息'
    empty.querySelector('[data-slate-node="element"]')?.append(emptyPlaceholder)
    trustedInput(empty)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    const withPlaceholder = mountSlate(['只要用户正文'])
    const inlinePlaceholder = document.createElement('span')
    inlinePlaceholder.setAttribute('data-slate-placeholder', 'true')
    inlinePlaceholder.setAttribute('contenteditable', 'false')
    inlinePlaceholder.textContent = '输入消息'
    withPlaceholder.querySelector('[data-slate-node="element"]')?.append(inlinePlaceholder)
    trustedInput(withPlaceholder)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['只要用户正文'])
    watcher.dispose()
  })

  it('无回调时只保留复制；输入法期间不请求，须等 compositionend 才开始请求', async () => {
    setPageUrl('https://ptb.discord.com/channels/1/2')
    const field = mountSlate(['水水水水水水'])
    const translate = vi.fn(async (_texts: string[]) => ({ ok: true as const, texts: ['Hello'] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedComposition(field, 'compositionstart')
    trustedInput(field, undefined, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    trustedComposition(field, 'compositionend')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)

    const shadow = popoverShadow()!
    await vi.advanceTimersByTimeAsync(0)
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputEditorUnsupported)
    expect(shadow.querySelector('button[data-action="copy"]')).not.toBeNull()
    expect(readDiscordDraft(field)).toBe('水水水水水水')
    watcher.dispose()

    translate.mockClear()
    const again = mountSlate(['另一段中文'])
    const second = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedComposition(again, 'compositionstart')
    trustedInput(again)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    trustedComposition(again, 'compositionend')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['另一段中文'])
    second.dispose()
  })

  it('Discord 吞掉原生 compositionend 后派发的不可信副本可结束已开始的合成，但不能凭空触发请求', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate(['你好'])
    field.focus()
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })

    const untrustedEnd = (): void => {
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
    }

    untrustedEnd()
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    trustedComposition(field, 'compositionstart')
    trustedBeforeInput(field, true)
    trustedInput(field, undefined, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    const other = mountSlate(['别处的中文'])
    other.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    untrustedEnd()
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['你好'])
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputEditorUnsupported)
    watcher.dispose()
  })

  it('普通 textarea 在可信合成开始且有焦点时接受不可信 compositionend，无先行合成、异框或失焦时不放行', async () => {
    const input = document.createElement('textarea')
    const other = document.createElement('textarea')
    document.body.append(input, other)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })

    const untrustedEnd = (target: Element, data = '伪造事件数据'): void => {
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data }))
    }

    // (a) 没有先行可信 compositionstart 时不可信 compositionend 不触发请求
    input.value = '未开始合成的中文'
    input.focus()
    untrustedEnd(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    // 开启可信合成
    trustedComposition(input, 'compositionstart')
    trustedInput(input, '正在拼音', true)

    // (b) 在 A 输入框合成、对 B 输入框派发不可信 compositionend 不结束 A 的合成
    other.value = '别的框里的中文'
    untrustedEnd(other)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    // (c) 输入框失去焦点时（焦点移到 other，此时 activeField 未建立，composingField 仍在 input）不放行
    other.focus()
    expect(document.activeElement).toBe(other)
    untrustedEnd(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    // 重新聚焦 A 输入框后，不可信 compositionend 结束合成并在 650ms 后按实时草稿请求一次
    input.focus()
    untrustedEnd(input)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['正在拼音'])
    watcher.dispose()
  })

  it('通用 contenteditable 在可信合成开启后遇到不可信 compositionend 时按实时草稿触发一次翻译', async () => {
    setPageUrl('https://web.telegram.org/k/')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(editable)
    editable.focus()
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })

    trustedComposition(editable, 'compositionstart')
    trustedInput(editable, '电报网页版实时草稿', true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    editable.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: '被忽略的事件数据' }))
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['电报网页版实时草稿'])
    watcher.dispose()
  })

  it('自动替换等待 DOM 落地后才显示还原，编辑、合成、超时和 dispose 会去掉标记且旧回复不改草稿', async () => {
    setPageUrl('https://canary.discord.com/channels/9')
    const field = mountSlate(['水水水水水水'])
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Hello'] }))
    let resolveReplace: (status: DiscordReplacementStatus) => void = () => undefined
    const replaceDiscordInput = vi.fn(() => new Promise<DiscordReplacementStatus>((resolve) => {
      resolveReplace = resolve
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput,
    })
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await Promise.resolve()
    const token = field.getAttribute('data-wt-discord-input')
    expect(token).toMatch(/^[a-f0-9-]{36}$/i)
    expect(replaceDiscordInput).toHaveBeenCalledTimes(1)
    const stringNode = field.querySelector('[data-slate-string="true"]')
    if (!(stringNode instanceof HTMLElement)) throw new Error('missing string')
    stringNode.textContent = '新的中文草稿'
    trustedInput(field)
    expect(field.getAttribute('data-wt-discord-input')).toBeNull()
    resolveReplace('ok')
    await Promise.resolve()
    await Promise.resolve()
    expect(readDiscordDraft(field)).toBe('新的中文草稿')
    watcher.dispose()

    const restored = mountSlate(['水水水水水水'])
    const late = vi.fn(async () => 'ok' as const)
    const composing = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput: late,
    })
    trustedInput(restored)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(late).toHaveBeenCalledTimes(1)
    trustedComposition(restored, 'compositionstart')
    expect(isPopoverOpen()).toBe(false)
    await vi.advanceTimersByTimeAsync(400)
    expect(late).toHaveBeenCalledTimes(1)
    expect(restored.getAttribute('data-wt-discord-input')).toBeNull()
    composing.dispose()

    const stalled = mountSlate(['水水水水水水'])
    const hanging = vi.fn(() => new Promise<DiscordReplacementStatus>(() => undefined))
    const stalledWatcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput: hanging,
    })
    trustedInput(stalled)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(stalled.getAttribute('data-wt-discord-input')).not.toBeNull()
    stalledWatcher.dispose()
    expect(stalled.getAttribute('data-wt-discord-input')).toBeNull()

    const timeoutField = mountSlate(['水水水水水水'])
    const timeoutWatcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput: hanging,
    })
    trustedInput(timeoutField)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5000)
    await Promise.resolve()
    expect(timeoutField.getAttribute('data-wt-discord-input')).toBeNull()
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)
    expect(popoverShadow()?.querySelector('button[data-action="copy"]')).not.toBeNull()
    expect(readDiscordDraft(timeoutField)).toBe('水水水水水水')
    timeoutWatcher.dispose()
  })

  it('桥返回 changed、unsupported 或延迟写入时，DOM 未落地不算成功，落地后可还原', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate(['水水水水水水'])
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Hello'] }))
    const changed = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput: async () => 'changed',
    })
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputTextChanged)
    expect(popoverShadow()?.querySelector('button[data-action="copy"]')).not.toBeNull()
    expect(readDiscordDraft(field)).toBe('水水水水水水')
    changed.dispose()

    const unsupportedField = mountSlate(['水水水水水水'])
    const unsupported = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput: async () => 'unsupported',
    })
    trustedInput(unsupportedField)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputEditorUnsupported)
    expect(popoverShadow()?.querySelector('button[data-action="copy"]')).not.toBeNull()
    expect(readDiscordDraft(unsupportedField)).toBe('水水水水水水')
    unsupported.dispose()

    const live = mountSlate(['水水水水水水'])
    const replaceDiscordInput = vi.fn(async (request: { text: string }) => {
      setTimeout(() => writeSlateText(live, request.text), 30)
      return 'ok' as const
    })
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput,
    })
    trustedInput(live)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(80)
    await Promise.resolve()
    expect(readDiscordDraft(live)).toBe('Hello')
    expect(popoverShadow()?.querySelector('button[data-action="restore"]')).not.toBeNull()
    replaceDiscordInput.mockImplementation(async (request: { text: string }) => {
      writeSlateText(live, request.text)
      return 'ok'
    })
    trustedClick(requirePopoverButton('restore'))
    await vi.advanceTimersByTimeAsync(0)
    expect(readDiscordDraft(live)).toBe('水水水水水水')
    watcher.dispose()
  })

  it('桥已部分写入再报 failed/unsupported 或 DOM 未落地时提示替换未完成并可复制原文', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Hello'] }))
    const copy = vi.mocked(clipboard.copySelectionText)
    for (const status of ['failed', 'unsupported', 'ok'] as const) {
      copy.mockClear()
      const field = mountSlate(['水水水水水水'])
      const watcher = createInputTranslation({
        translate,
        cancel: () => undefined,
        t: (k) => zhCN[k],
        replaceDiscordInput: async () => {
          writeSlateText(field, 'Hel')
          return status
        },
      })
      trustedInput(field)
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
        await vi.advanceTimersByTimeAsync(400)
      await Promise.resolve()
      expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplacePartial)
      trustedClick(requirePopoverButton('copy-original'))
      await Promise.resolve()
      expect(copy).toHaveBeenCalledWith('水水水水水水')
      watcher.dispose()
    }

    const untouched = mountSlate(['水水水水水水'])
    const keep = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput: async () => 'failed',
    })
    trustedInput(untouched)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)
    expect(popoverShadow()?.querySelector('button[data-action="copy-original"]')).toBeNull()
    keep.dispose()

    for (const status of ['failed', 'unsupported', 'ok'] as const) {
      copy.mockClear()
      const field = mountSlate(['水水水水水水'])
      let phase: 'replace' | 'restore' = 'replace'
      const watcher = createInputTranslation({
        translate,
        cancel: () => undefined,
        t: (k) => zhCN[k],
        replaceDiscordInput: async (request) => {
          if (phase === 'replace') {
            writeSlateText(field, request.text)
            return 'ok'
          }
          writeSlateText(field, '水水')
          return status
        },
      })
      trustedInput(field)
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
        await vi.advanceTimersByTimeAsync(0)
      expect(readDiscordDraft(field)).toBe('Hello')
      phase = 'restore'
      trustedClick(requirePopoverButton('restore'))
      await vi.advanceTimersByTimeAsync(400)
      await Promise.resolve()
      expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplacePartial)
      expect(popoverShadow()?.querySelector('button[data-action="restore"]')).toBeNull()
      trustedClick(requirePopoverButton('copy-original'))
      await Promise.resolve()
      expect(copy).toHaveBeenCalledWith('水水水水水水')
      watcher.dispose()
    }
  })

  it('原生 compositionend 被吞且未重发时，后续可信非合成 keydown 结束合成并重新取样', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    const key = (init: KeyboardEventInit & { keyCode?: number }, trusted = true): void => {
      const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, ...init })
      if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
      if (trusted) Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
      input.dispatchEvent(event)
    }
    trustedComposition(input, 'compositionstart')
    trustedInput(input, '你好', true)
    key({ key: 'Enter', isComposing: true, keyCode: 229 })
    key({ key: 'Process', keyCode: 229 })
    key({ key: 'a', isComposing: false, keyCode: 229 })
    key({ key: 'a' }, false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    key({ key: 'ArrowRight' })
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['你好'])
    watcher.dispose()
  })

  it('序列化后的主世界函数不捕获模块绑定，只使用最近且模型匹配的 editor', () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const source = replaceDiscordDraftInMainWorld.toString()
    expect(source.includes('isDiscordChatUrl')).toBe(false)
    expect(source.includes('readDiscordDraft')).toBe(false)
    expect(source.includes('DISCORD_HOSTS')).toBe(false)
    const isolated = new Function(`return (${source})`)() as typeof replaceDiscordDraftInMainWorld
    const root = mountSlate(['你好'])
    const placeholder = document.createElement('span')
    placeholder.setAttribute('data-slate-placeholder', 'true')
    placeholder.setAttribute('contenteditable', 'false')
    placeholder.textContent = '输入消息'
    root.querySelector('[data-slate-node="element"]')?.append(placeholder)
    const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    root.setAttribute('data-wt-discord-input', elementId)
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    expect(readDiscordDraft(root)).toBe('你好')
    expect(isolated({ elementId: 'bad', expectedText: '你好', text: 'Hello' })).toBe('failed')
    expect(isolated({ elementId, expectedText: '不匹配', text: 'Hello' })).toBe('changed')

    const calls = { spoof: 0, real: 0 }
    const makeEditor = (text: string, mark: 'spoof' | 'real') => {
      const editor = {
        children: [{ children: [{ text }] }],
        selection: null as unknown,
        apply(this: { selection: unknown }, operation: { newProperties: unknown }) {
          if (mark === 'spoof') calls.spoof += 1
          this.selection = operation.newProperties
        },
        insertText(this: { children: Array<{ children: Array<{ text: string }> }> }, next: string) {
          if (mark === 'real') calls.real += 1
          else calls.spoof += 1
          this.children = [{ children: [{ text: next }] }]
        },
      }
      return editor
    }
    const spoof = makeEditor('别的文本', 'spoof')
    const real = makeEditor('你好', 'real')
    const parent = {
      memoizedProps: {},
      memoizedState: { memoizedState: { current: real }, next: null },
      dependencies: null,
      return: null,
    }
    const fiber = { memoizedProps: { editor: spoof }, memoizedState: null, dependencies: null, return: parent }
    ;(root as unknown as Record<string, unknown>)['__reactFiber$unit'] = fiber
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('ok')
    expect(calls).toEqual({ spoof: 0, real: 1 })
    expect(real.children[0]?.children[0]?.text).toBe('Hello')
    expect(readDiscordDraft(root)).toBe('你好')
    root.removeAttribute('data-wt-discord-input')

    const multiline = mountSlate(['你', '', '好'])
    multiline.setAttribute('data-wt-discord-input', elementId)
    const blank = {
      children: [
        { children: [{ text: '你' }] },
        { children: [{ text: '' }] },
        { children: [{ text: '好' }] },
      ],
      selection: null as unknown,
      apply() { return undefined },
      insertText(next: string) {
        this.children = [{ children: [{ text: next }] }]
      },
    }
    ;(multiline as unknown as Record<string, unknown>)['__reactFiber$unit'] = {
      memoizedProps: { editor: blank },
      return: null,
    }
    expect(isolated({ elementId, expectedText: '你\n\n好', text: 'Line\n\nTwo' })).toBe('ok')
    expect(blank.children).toEqual([{ children: [{ text: 'Line\n\nTwo' }] }])

    const dup = mountSlate(['你好'])
    dup.setAttribute('data-wt-discord-input', elementId)
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('failed')
  })

  it('beforeinput 等到下一宏任务再读 Slate 已提交草稿，随后的 input 与 dispose 只保留一次', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate([''])
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedBeforeInput(field)
    queueMicrotask(() => writeSlateText(field, '真正提交的中文'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(translate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['真正提交的中文'])

    trustedBeforeInput(field)
    writeSlateText(field, '第二次提交的中文')
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]?.[0]).toEqual(['第二次提交的中文'])

    trustedBeforeInput(field)
    queueMicrotask(() => writeSlateText(field, '停止后不该发送'))
    watcher.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('合成期间的 beforeinput 不取样，compositionend 之后才读最新草稿', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate([''])
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedComposition(field, 'compositionstart')
    trustedBeforeInput(field, false)
    queueMicrotask(() => writeSlateText(field, '预编辑中文'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    trustedComposition(field, 'compositionend')
    queueMicrotask(() => writeSlateText(field, '最终确认中文'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['最终确认中文'])
    watcher.dispose()

    const composing = mountSlate([''])
    const second = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedBeforeInput(composing, true)
    queueMicrotask(() => writeSlateText(composing, '未结束的中文'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    trustedComposition(composing, 'compositionend')
    queueMicrotask(() => writeSlateText(composing, '合成结束后的中文'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]?.[0]).toEqual(['合成结束后的中文'])
    second.dispose()
  })

  it('新的 beforeinput 立刻取消在途请求，旧回复不能显示，新草稿单独请求', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const field = mountSlate(['旧的中文草稿'])
    let resolveOld: (value: { ok: true; texts: string[] }) => void = () => undefined
    const cancel = vi.fn()
    const translate = vi.fn((texts: string[]) => {
      if (texts[0] === '旧的中文草稿') {
        return new Promise<{ ok: true; texts: string[] }>((resolve) => {
          resolveOld = resolve
        })
      }
      return Promise.resolve({ ok: true as const, texts: ['NEW'] })
    })
    const watcher = createInputTranslation({ translate, cancel, t: (k) => zhCN[k] })
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtPanelLoading)

    trustedBeforeInput(field)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(isPopoverOpen()).toBe(false)
    queueMicrotask(() => writeSlateText(field, '新的中文草稿'))
    resolveOld({ ok: true, texts: ['OLD'] })
    await Promise.resolve()
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent ?? '').not.toBe('OLD')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]?.[0]).toEqual(['新的中文草稿'])
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputEditorUnsupported)
    watcher.dispose()
  })
})

describe('ChatGPT Claude Telegram 纯文本草稿', () => {
  afterEach(() => {
    setPageUrl('about:blank')
  })

  it('只接受三个 https 主机，Telegram 仅 /a 与 /k，拒绝仿冒和登录路径', () => {
    expect(isSupportedChatUrl('https://chatgpt.com/c/fixture')).toBe(true)
    expect(isSupportedChatUrl('https://CHATGPT.COM/')).toBe(true)
    expect(isSupportedChatUrl('https://claude.ai/chat/fixture')).toBe(true)
    expect(isSupportedChatUrl('https://web.telegram.org/a')).toBe(true)
    expect(isSupportedChatUrl('https://web.telegram.org/a/')).toBe(true)
    expect(isSupportedChatUrl('https://web.telegram.org/k')).toBe(true)
    expect(isSupportedChatUrl('https://web.telegram.org/k/1')).toBe(true)
    expect(isSupportedChatUrl('https://web.whatsapp.com/')).toBe(true)
    expect(isSupportedChatUrl('https://app.slack.com/client/T/C')).toBe(true)
    expect(isSupportedChatUrl('https://acme.enterprise.slack.com/messages/C')).toBe(true)
    expect(isSupportedChatUrl('https://teams.microsoft.com/v2/')).toBe(true)
    expect(isSupportedChatUrl('https://teams.live.com/')).toBe(true)
    expect(isSupportedChatUrl('https://teams.cloud.microsoft/v2/')).toBe(true)
    for (const url of [
      'https://chat.openai.com/',
      'https://www.chatgpt.com/',
      'https://chatgpt.com.evil/',
      'https://sub.chatgpt.com/',
      'http://chatgpt.com/c/1',
      'https://claude.ai.evil/chat',
      'https://web.telegram.org/',
      'https://web.telegram.org/z',
      'https://web.telegram.org/ab',
      'https://chatgpt.com/login',
      'https://claude.ai/settings',
      'https://claude.ai/accounts/1',
      'https://web.telegram.org/a/billing',
      'https://web.whatsapp.com/settings',
      'http://web.whatsapp.com/',
      'https://web.whatsapp.com.evil/',
      'https://slack.com/client/T',
      'https://app.slack.com/',
      'https://app.slack.com/ssb/redirect',
      'https://notslack.com/client/T',
      'https://app.slack.com.evil/client/T',
      'https://teams.microsoft.com.evil/v2/',
      'https://teams.microsoft.com/login',
      'notaurl',
    ]) {
      expect(isSupportedChatUrl(url)).toBe(false)
    }
  })

  it('读取段落、空行、trailingBreak 和字面 HTML 文本，并拒绝复杂结构', () => {
    setPageUrl('https://chatgpt.com/c/1')
    const root = mountChat(['  你好  ', '', '世界'])
    const first = root.querySelector('p')
    if (!(first instanceof HTMLElement)) throw new Error('missing paragraph')
    first.textContent = ''
    const strong = document.createElement('strong')
    strong.textContent = '你'
    first.append(strong, document.createTextNode('好  '))
    expect(readChatDraft(root)).toBe('你好  \n\n世界')
    expect(isChatPlainEditor(root)).toBe(true)
    const literal = mountChat(['<b>不是标签</b>'])
    expect(readChatDraft(literal)).toBe('<b>不是标签</b>')
    const trailing = document.createElement('br')
    trailing.className = 'ProseMirror-trailingBreak'
    literal.querySelector('p')?.append(trailing)
    expect(readChatDraft(literal)).toBe('<b>不是标签</b>')
    const emptyLegacy = mountChat(['x'])
    emptyLegacy.innerHTML = '<p><br></p>'
    expect(readChatDraft(emptyLegacy)).toBe('')
    const emptyTrailing = mountChat(['x'])
    emptyTrailing.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>'
    expect(readChatDraft(emptyTrailing)).toBe('')
    const hardBreakPad = mountChat(['x'])
    hardBreakPad.innerHTML = '<p><br><br class="ProseMirror-trailingBreak"></p><p>你好</p>'
    expect(readChatDraft(hardBreakPad)).toBe('\n\n你好')

    const link = document.createElement('a')
    link.textContent = 'x'
    root.append(link)
    expect(isChatPlainEditor(root)).toBe(false)
    link.remove()
    const image = document.createElement('img')
    root.append(image)
    expect(isChatPlainEditor(root)).toBe(false)
  })

  it('ProseMirror 只在 beforeinput 后读取该字段草稿，其他主机仍不请求', async () => {
    setPageUrl('https://claude.ai/chat/1')
    const field = mountChat(['需要翻译的中文内容'])
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedBeforeInput(field)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(translate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['需要翻译的中文内容'])
    watcher.dispose()

    translate.mockClear()
    setPageUrl('https://example.com/chat')
    const foreign = mountChat(['需要翻译的中文内容'])
    const blocked = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedBeforeInput(foreign)
    trustedInput(foreign)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    blocked.dispose()
  })

  it('无回调或模型不支持时只复制并保留草稿；复杂化后不走原生写入；输入和 dispose 清掉标记', async () => {
    setPageUrl('https://web.telegram.org/k/1')
    const field = mountChat(['需要翻译的中文内容'])
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Hello'] }))
    const missing = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    trustedBeforeInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputEditorUnsupported)
    expect(popoverShadow()?.querySelector('button[data-action="copy"]')).not.toBeNull()
    expect(readChatDraft(field)).toBe('需要翻译的中文内容')
    missing.dispose()

    const unsupportedField = mountChat(['需要翻译的中文内容'])
    const unsupported = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceChatInput: async () => 'unsupported',
    })
    trustedBeforeInput(unsupportedField)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(popoverShadow()?.querySelector('button[data-action="copy"]')).not.toBeNull()
    expect(readChatDraft(unsupportedField)).toBe('需要翻译的中文内容')
    unsupported.dispose()

    const live = mountChat(['需要翻译的中文内容'])
    const htmlBefore = live.innerHTML
    const replaceChatInput = vi.fn(async () => 'ok' as const)
    let resolveComplex!: (reply: { ok: true; texts: string[] }) => void
    const complex = createInputTranslation({
      translate: () => new Promise(resolve => { resolveComplex = resolve }),
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceChatInput,
    })
    trustedBeforeInput(live)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    live.append(document.createElement('a'))
    resolveComplex({ ok: true, texts: ['Hello'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(replaceChatInput).not.toHaveBeenCalled()
    expect(live.innerHTML).toBe(`${htmlBefore}<a></a>`)
    expect(isPopoverOpen()).toBe(false)
    complex.dispose()

    const pending = mountChat(['需要翻译的中文内容'])
    let resolveReplace: (status: ChatReplacementStatus) => void = () => undefined
    const hanging = vi.fn(() => new Promise<ChatReplacementStatus>((resolve) => {
      resolveReplace = resolve
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceChatInput: hanging,
    })
    trustedBeforeInput(pending)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await Promise.resolve()
    const token = pending.getAttribute('data-wt-chat-input')
    expect(token).toMatch(/^[a-f0-9-]{36}$/i)
    expect(pending.hasAttribute('data-wt-discord-input')).toBe(false)
    pending.querySelector('p')!.textContent = '新的中文草稿'
    trustedInput(pending)
    expect(pending.getAttribute('data-wt-chat-input')).toBeNull()
    resolveReplace('ok')
    await Promise.resolve()
    expect(readChatDraft(pending)).toBe('新的中文草稿')
    watcher.dispose()

    const disposed = mountChat(['需要翻译的中文内容'])
    const stalled = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceChatInput: () => new Promise<ChatReplacementStatus>(() => undefined),
    })
    trustedBeforeInput(disposed)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed.getAttribute('data-wt-chat-input')).not.toBeNull()
    stalled.dispose()
    expect(disposed.getAttribute('data-wt-chat-input')).toBeNull()
  })

  it('序列化后的主世界函数只用绑定的 EditorView，按模型换行且不读 pmViewDesc', () => {
    setPageUrl('https://chatgpt.com/c/1')
    const source = replaceChatDraftInMainWorld.toString()
    expect(source.includes('isSupportedChatUrl')).toBe(false)
    expect(source.includes('CHAT_HOSTS')).toBe(false)
    expect(source.includes('pmViewDesc')).toBe(false)
    const isolated = new Function(`return (${source})`)() as typeof replaceChatDraftInMainWorld
    const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const root = mountChat(['你好'])
    root.setAttribute('data-wt-chat-input', elementId)
    const decoy = document.createElement('div')
    decoy.className = 'ProseMirror'
    ;(root as unknown as { pmViewDesc?: unknown }).pmViewDesc = { view: { dom: decoy } }
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    expect(readChatDraft(root)).toBe('你好')

    let current = '你好'
    let dispatched = 0
    const view = {
      dom: root,
      editable: true,
      composing: false,
      dispatch(transaction: { applyText?: string }) {
        dispatched += 1
        if (typeof transaction.applyText === 'string') current = transaction.applyText
      },
      get state() {
        return chatState(current)
      },
    }
    ;(root as unknown as { editor?: unknown }).editor = { view }
    expect(isolated({ elementId, expectedText: '别的', text: 'Hello' })).toBe('changed')
    expect(dispatched).toBe(0)
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('ok')
    expect(current).toBe('Hello')
    expect(dispatched).toBe(1)

    current = '你好'
    view.composing = true
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('failed')
    expect(current).toBe('你好')
    view.composing = false
    root.removeAttribute('data-wt-chat-input')

    const mention = mountChat(['你好'])
    mention.setAttribute('data-wt-chat-input', elementId)
    ;(mention as unknown as { editor?: unknown }).editor = {
      view: {
        dom: mention,
        editable: true,
        composing: false,
        dispatch() { throw new Error('should not dispatch') },
        state: chatState('你好', 'mention'),
      },
    }
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    expect(readChatDraft(mention)).toBe('你好')
    mention.removeAttribute('data-wt-chat-input')

    const multiline = mountChat(['你', '', '好'])
    multiline.setAttribute('data-wt-chat-input', elementId)
    let multilineText = '你\n\n好'
    ;(multiline as unknown as { editor?: unknown }).editor = {
      view: {
        dom: multiline,
        editable: true,
        dispatch(transaction: { applyText?: string }) {
          if (typeof transaction.applyText === 'string') multilineText = transaction.applyText
        },
        get state() { return chatState(multilineText) },
      },
    }
    expect(isolated({ elementId, expectedText: '你\n\n好', text: 'Line\r\n\r\nTwo' })).toBe('ok')
    expect(multilineText).toBe('Line\n\nTwo')
    expect(readChatDraft(multiline)).toBe('你\n\n好')
    multiline.removeAttribute('data-wt-chat-input')

    const hardBreakModel = mountChat(['x'])
    hardBreakModel.innerHTML = '<p><br><br class="ProseMirror-trailingBreak"></p><p>你好</p>'
    hardBreakModel.setAttribute('data-wt-chat-input', elementId)
    let hardBreakText = '\n\n你好'
    ;(hardBreakModel as unknown as { editor?: unknown }).editor = {
      view: {
        dom: hardBreakModel,
        editable: true,
        composing: false,
        dispatch(transaction: { applyText?: string }) {
          if (typeof transaction.applyText === 'string') hardBreakText = transaction.applyText
        },
        get state() { return chatState(hardBreakText) },
      },
    }
    expect(isolated({ elementId, expectedText: '\n\n你好', text: 'Hello' })).toBe('ok')
    expect(hardBreakText).toBe('Hello')
  })

  it('pending 替换时可信 beforeinput 在 DOM 仍是旧草稿时立刻撤标记，旧回复不能覆盖新请求状态', async () => {
    setPageUrl('https://chatgpt.com/c/1')
    const field = mountChat(['旧草稿中文'])
    const translate = vi.fn(async (_texts: string[]) => ({ ok: true as const, texts: ['English'] }))
    let resolveReplace: (status: ChatReplacementStatus) => void = () => undefined
    const replaceChatInput = vi.fn(() => new Promise<ChatReplacementStatus>((resolve) => {
      if (replaceChatInput.mock.calls.length === 1) resolveReplace = resolve
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceChatInput,
    })
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtPanelLoading)
    await Promise.resolve()
    expect(field.getAttribute('data-wt-chat-input')).toMatch(/^[a-f0-9-]{36}$/i)

    trustedBeforeInput(field)
    expect(field.getAttribute('data-wt-chat-input')).toBeNull()
    queueMicrotask(() => writeChatText(field, '新的中文草稿'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]?.[0]).toEqual(['新的中文草稿'])
    const previewAfterNew = popoverShadow()?.querySelector('[role="status"]')?.textContent
    expect(previewAfterNew).toBe(zhCN.wtPanelLoading)
    resolveReplace('changed')
    await Promise.resolve()
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(previewAfterNew)
    expect(readChatDraft(field)).toBe('新的中文草稿')
    watcher.dispose()
  })
})

function mountChat(paragraphs: readonly string[]): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ProseMirror'
  root.setAttribute('contenteditable', 'true')
  for (const paragraph of paragraphs) {
    const block = document.createElement('p')
    if (paragraph === '') {
      const trailing = document.createElement('br')
      trailing.className = 'ProseMirror-trailingBreak'
      block.append(trailing)
    } else {
      block.append(document.createTextNode(paragraph))
    }
    root.append(block)
  }
  document.body.append(root)
  return root
}

function writeChatText(root: HTMLElement, text: string): void {
  const first = root.querySelector(':scope > p')
  if (!(first instanceof HTMLElement)) return
  for (const extra of [...root.children].slice(1)) extra.remove()
  first.replaceChildren(document.createTextNode(text))
}

function chatState(text: string, extra?: string) {
  const lines = text.split('\n')
  const doc = {
    content: { size: Math.max(text.length, 1) },
    textBetween() { return text },
    descendants(callback: (node: { type: { name: string } }) => boolean | void) {
      callback({ type: { name: 'doc' } })
      callback({ type: { name: 'paragraph' } })
      if (extra !== undefined) callback({ type: { name: extra } })
      for (let index = 0; index < lines.length; index += 1) {
        if (index > 0) callback({ type: { name: 'hard_break' } })
        const line = lines[index] ?? ''
        if (line !== '') callback({ type: { name: 'text' } })
      }
    },
  }
  return {
    doc,
    schema: {
      text(value: string) { return { kind: 'text', value } },
      nodes: {
        paragraph: {
          create(_attrs: null, content: ReadonlyArray<{ kind: string; value?: string }>) {
            return { kind: 'paragraph', content }
          },
        },
        hard_break: { create() { return { kind: 'hard_break' } } },
      },
    },
    tr: {
      replaceWith(_from: number, _to: number, paragraph: { content: ReadonlyArray<{ kind: string; value?: string }> }) {
        let next = ''
        for (const node of paragraph.content) {
          if (node.kind === 'hard_break') next += '\n'
          else if (node.kind === 'text') next += node.value ?? ''
        }
        return { applyText: next }
      },
    },
  }
}

function focusEditable(field: HTMLElement): void {
  field.focus()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
}

describe('直接替换', () => {
  it('自动弹窗偏好关闭时仍按配置时间请求，只替换返回时仍聚焦的快照', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    let resolveReply: (value: { ok: true; texts: string[] }) => void = () => undefined
    const translate = vi.fn((_texts: string[], _id: string, manual?: boolean) => new Promise<{ ok: true; texts: string[] }>((resolve) => {
      resolveReply = resolve
      expect(manual).toBeUndefined()
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      autoPreview: () => false,
    })
    focusEditable(input)
    input.value = '请检查这段代码'
    trustedInput(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    resolveReply({ ok: true, texts: ['Please review this code.'] })
    await Promise.resolve()
    await Promise.resolve()
    expect(input.value).toBe('Please review this code.')
    watcher.dispose()
  })

  it('自动检测下字形像目标语言的草稿（无重音法语 → 英语、简体 → 繁体）：自动翻译跳过，内部主动调用仍遵循写入守卫', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    let target: 'en' | 'zh-TW' = 'en'
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`T:${texts[0]}`] }))
    const watcher = createInputTranslation({
      translate,
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      targetLanguage: () => target,
    })
    focusEditable(input)
    input.value = 'Bonjour le monde'
    trustedInput(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    expect(watcher.translateAndReplace()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('T:Bonjour le monde')

    target = 'zh-TW'
    input.value = '你好'
    trustedInput(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    expect(watcher.translateAndReplace()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(input.value).toBe('T:你好')
    watcher.dispose()
  })

  it('在途重复调用不重复请求，自动写入后同一快照不重复翻译', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    let resolveReply: (value: { ok: true; texts: string[] }) => void = () => undefined
    const translate = vi.fn(() => new Promise<{ ok: true; texts: string[] }>((resolve) => {
      resolveReply = resolve
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      autoPreview: () => true,
    })
    focusEditable(input)
    input.value = '请检查这段代码'
    trustedInput(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    expect(watcher.translateAndReplace()).toBe(true)
    expect(translate).toHaveBeenCalledTimes(1)
    resolveReply({ ok: true, texts: ['Please review this code.'] })
    await Promise.resolve()
    await Promise.resolve()
    expect(input.value).toBe('Please review this code.')

    const cached = document.createElement('textarea')
    document.body.append(cached)
    const cachedTranslate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const cachedWatcher = createInputTranslation({
      translate: cachedTranslate,
      cancel: vi.fn(),
      t: (key) => zhCN[key],
    })
    focusEditable(cached)
    cached.value = '另一段中文'
    trustedInput(cached)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(cachedTranslate).toHaveBeenCalledTimes(1)
    expect(cached.value).toBe('EN:另一段中文')
    expect(cachedWatcher.translateAndReplace()).toBe(false)
    expect(cachedTranslate).toHaveBeenCalledTimes(1)
    expect(cached.value).toBe('EN:另一段中文')
    watcher.dispose()
    cachedWatcher.dispose()
  })

  it('合成、改字、敏感、只读、失焦和卸载都会取消过期的直接写入', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    let resolveReply: ((value: { ok: true; texts: string[] }) => void) | undefined
    const translate = vi.fn(() => new Promise<{ ok: true; texts: string[] }>((resolve) => {
      resolveReply = resolve
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      autoPreview: () => false,
    })
    focusEditable(input)
    trustedComposition(input, 'compositionstart')
    input.value = '选字中的中文'
    expect(watcher.translateAndReplace()).toBe(false)
    expect(translate).not.toHaveBeenCalled()
    trustedComposition(input, 'compositionend')

    input.value = '请检查这段代码'
    expect(watcher.translateAndReplace()).toBe(true)
    const first = resolveReply
    input.value = '已经改过'
    trustedInput(input)
    first?.({ ok: true, texts: ['stale'] })
    await Promise.resolve()
    expect(input.value).toBe('已经改过')

    const password = document.createElement('input')
    password.type = 'password'
    document.body.append(password)
    focusEditable(password)
    password.value = '密码中文'
    expect(watcher.translateAndReplace()).toBe(false)

    const readonly = document.createElement('textarea')
    readonly.readOnly = true
    document.body.append(readonly)
    focusEditable(readonly)
    readonly.value = '只读中文'
    expect(watcher.translateAndReplace()).toBe(false)

    focusEditable(input)
    input.value = '失焦前的中文'
    expect(watcher.translateAndReplace()).toBe(true)
    const pending = resolveReply
    input.blur()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    pending?.({ ok: true, texts: ['blurred'] })
    await Promise.resolve()
    await Promise.resolve()
    expect(input.value).toBe('失焦前的中文')

    focusEditable(input)
    input.value = '卸载前的中文'
    expect(watcher.translateAndReplace()).toBe(true)
    const late = resolveReply
    watcher.dispose()
    late?.({ ok: true, texts: ['disposed'] })
    await Promise.resolve()
    expect(input.value).toBe('卸载前的中文')
  })

  it('托管编辑器内部主动调用只调用一次模型桥，还原仍然可用；含汉字的日文结果不会再次替换', async () => {
    setPageUrl('https://chatgpt.com/c/1')
    const field = mountChat(['请检查这段代码'])
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Revisa este código.'] }))
    const replaceChatInput = vi.fn(async () => 'ok' as const)
    const watcher = createInputTranslation({
      translate,
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      autoPreview: () => false,
      replaceChatInput,
    })
    focusEditable(field)
    expect(watcher.translateAndReplace()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(20)
    expect(translate).toHaveBeenCalledTimes(1)
    expect(replaceChatInput).toHaveBeenCalledTimes(1)
    writeChatText(field, 'Revisa este código.')
    await vi.advanceTimersByTimeAsync(300)
    expect(readChatDraft(field)).toBe('Revisa este código.')
    const restore = requirePopoverButton('restore')
    trustedClick(restore)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    expect(replaceChatInput).toHaveBeenCalledTimes(2)

    const han = mountChat(['另一段中文'])
    const hanTranslate = vi.fn(async () => ({ ok: true as const, texts: ['東京'] }))
    const hanReplace = vi.fn(async (request: { text: string }) => {
      writeChatText(han, request.text)
      return 'ok' as const
    })
    const hanWatcher = createInputTranslation({
      translate: hanTranslate,
      cancel: vi.fn(),
      t: (key) => zhCN[key],
      autoPreview: () => false,
      replaceChatInput: hanReplace,
    })
    focusEditable(han)
    expect(hanWatcher.translateAndReplace()).toBe(true)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    writeChatText(han, '東京')
    expect(hanWatcher.translateAndReplace()).toBe(false)
    expect(hanTranslate).toHaveBeenCalledTimes(1)
    expect(hanReplace).toHaveBeenCalledTimes(1)
    watcher.dispose()
    hanWatcher.dispose()
  })
})

describe('WhatsApp Slack Teams 纯文本草稿', () => {
  const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  afterEach(() => {
    setPageUrl('about:blank')
  })

  function mountManaged(url: string, html: string, marker?: 'lexical' | 'quill'): HTMLElement {
    setPageUrl(url)
    const root = document.createElement('div')
    root.setAttribute('contenteditable', 'true')
    if (marker === 'lexical') root.setAttribute('data-lexical-editor', 'true')
    if (marker === 'quill') root.className = 'ql-editor'
    root.innerHTML = html
    document.body.append(root)
    return root
  }

  it('框架选择器在已允许主机上生效，主机回退只覆盖三个新站点', () => {
    const lexical = mountManaged('https://chatgpt.com/c/1', '<p>你好</p>', 'lexical')
    expect(isChatEditorCandidate(lexical)).toBe(true)
    expect(isChatPlainEditor(lexical)).toBe(true)
    const plain = document.createElement('div')
    plain.setAttribute('contenteditable', 'true')
    plain.innerHTML = '<p>你好</p>'
    document.body.append(plain)
    expect(isChatEditorCandidate(plain)).toBe(false)
    const foreign = mountManaged('https://example.com/', '<p>你好</p>', 'quill')
    expect(isChatEditorCandidate(foreign)).toBe(false)
    const whatsapp = mountManaged('https://web.whatsapp.com/', '<p>你好</p>')
    expect(isChatEditorCandidate(whatsapp)).toBe(true)
    expect(isChatPlainEditor(whatsapp)).toBe(true)
    const slack = mountManaged('https://app.slack.com/client/T/C', '<p>你好</p>')
    expect(isChatPlainEditor(slack)).toBe(true)
    const teams = mountManaged('https://teams.microsoft.com/v2/', '<div>你好</div>')
    expect(isChatPlainEditor(teams)).toBe(true)
    const nested = mountManaged('https://teams.live.com/', '<div>hello<div>world</div></div>')
    expect(isChatPlainEditor(nested)).toBe(false)
    expect(readChatDraft(nested)).toBe('')
    const native = document.createElement('textarea')
    document.body.append(native)
    expect(isChatEditorCandidate(native)).toBe(false)
  })

  it('Lexical、Quill、Rooster 的 DOM 读法互不套用', () => {
    const lexical = mountManaged(
      'https://web.whatsapp.com/',
      '<p>第一行<br data-lexical-managed-linebreak="true"></p><p><br data-lexical-managed-linebreak="true"></p><p>第三行<br data-lexical-managed-linebreak="true"></p>',
    )
    expect(readChatDraft(lexical)).toBe('第一行\n\n\n\n第三行')
    lexical.innerHTML = '<p>a<br>b<br data-lexical-managed-linebreak="true"></p>'
    expect(readChatDraft(lexical)).toBe('a\nb')
    lexical.innerHTML = '<p><br><br data-lexical-managed-linebreak="true"></p>'
    expect(readChatDraft(lexical)).toBe('\n')
    lexical.innerHTML = '<p><br data-lexical-managed-linebreak="true"></p>'
    expect(readChatDraft(lexical)).toBe('')
    lexical.innerHTML = '<p>  你好  </p>'
    expect(readChatDraft(lexical)).toBe('  你好  ')
    const image = document.createElement('img')
    image.setAttribute('data-lexical-managed-linebreak', 'true')
    lexical.querySelector('p')?.append(image)
    expect(isChatPlainEditor(lexical)).toBe(false)

    const quill = mountManaged('https://app.slack.com/client/T/C', '<p>  a </p><p><br></p>')
    expect(readChatDraft(quill)).toBe('  a \n')
    quill.innerHTML = '<p>a<br>b</p><p><br></p>'
    expect(readChatDraft(quill)).toBe('a\nb\n')

    const rooster = mountManaged('https://teams.microsoft.com/v2/', '<div>第一行</div><div><br></div><div>第三行<br></div><div><br></div>')
    expect(readChatDraft(rooster)).toBe('第一行\n\n第三行\n')
    rooster.innerHTML = '<div><br></div>'
    expect(readChatDraft(rooster)).toBe('')
    rooster.innerHTML = '<div>hello<br>there</div>'
    expect(readChatDraft(rooster)).toBe('hello\nthere')
  })

  it('beforeinput 每个新编辑器只发起一次请求，合成期间不请求', async () => {
    for (const site of [
      { url: 'https://web.whatsapp.com/', html: '<p>需要翻译的中文内容</p>' },
      { url: 'https://app.slack.com/messages/C', html: '<p>需要翻译的中文内容</p>' },
      { url: 'https://teams.cloud.microsoft/v2/', html: '<div>需要翻译的中文内容</div>' },
    ]) {
      const field = mountManaged(site.url, site.html)
      const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
      const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (key) => zhCN[key] })
      trustedBeforeInput(field)
      await vi.advanceTimersByTimeAsync(0)
      trustedBeforeInput(field)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(999)
      expect(translate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(translate).toHaveBeenCalledTimes(1)
      watcher.dispose()

      const composingField = mountManaged(site.url, site.html)
      const composingTranslate = vi.fn(async () => ({ ok: true as const, texts: ['Hello'] }))
      const composing = createInputTranslation({ translate: composingTranslate, cancel: () => undefined, t: (key) => zhCN[key] })
      trustedBeforeInput(composingField, true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(composingTranslate).not.toHaveBeenCalled()
      trustedComposition(composingField, 'compositionend')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      expect(composingTranslate).toHaveBeenCalledTimes(1)
      composing.dispose()
    }
  })

  it('序列化主世界按模型写入，拒绝坏根、变更、只读、合成和复杂节点', () => {
    const source = replaceChatDraftInMainWorld.toString()
    expect(source.includes('isSupportedChatUrl')).toBe(false)
    expect(source.includes('web.whatsapp.com')).toBe(true)
    expect(source.includes('formatContentModel')).toBe(true)
    expect(source.includes('history-push')).toBe(true)
    const isolated = new Function(`return (${source})`)() as typeof replaceChatDraftInMainWorld

    setPageUrl('https://chatgpt.com/c/1')
    const lexical = mountManaged('https://chatgpt.com/c/1', '<p>你好</p>', 'lexical')
    lexical.setAttribute('data-wt-chat-input', elementId)
    let lexicalJson: unknown = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: '你好', mode: 'normal' }] }] } }
    let lexicalWrites = 0
    let editable = true
    let composing = false
    const lexicalEditor = {
      getRootElement: () => lexical,
      getEditorState: () => ({ toJSON: () => lexicalJson }),
      parseEditorState(serialized: string) { return JSON.parse(serialized) as unknown },
      setEditorState(state: unknown) { lexicalWrites += 1; lexicalJson = state },
      isEditable: () => editable,
      isComposing: () => composing,
      focus() { return undefined },
    }
    ;(lexical as unknown as { __lexicalEditor?: unknown }).__lexicalEditor = lexicalEditor
    const otherLexicalRoot = document.createElement('div')
    const lexicalRootSpy = vi.spyOn(lexicalEditor, 'getRootElement').mockReturnValue(otherLexicalRoot)
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    expect(lexicalWrites).toBe(0)
    lexicalRootSpy.mockRestore()
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('ok')
    expect(lexicalWrites).toBe(1)
    expect(isolated({ elementId, expectedText: '别的', text: 'Hello' })).toBe('changed')
    lexicalJson = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'mention', text: '你好' }] }] } }
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    lexicalJson = { root: { type: 'element', children: [] } }
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    lexicalJson = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: '你好', mode: 'normal' }] }] } }
    editable = false
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('failed')
    editable = true
    composing = true
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('failed')
    expect(lexicalWrites).toBe(1)
    composing = false
    editable = true
    for (const target of ['ok', 'changed', 'unsupported', 'failed'] as const) {
      lexical.innerHTML = '<p>你好</p>'
      lexicalJson = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: '你好', mode: 'normal' }] }] } }
      const writesBefore = lexicalWrites
      expect(isolated({ elementId, expectedText: '你好', text: target })).toBe('ok')
      expect(lexicalWrites).toBe(writesBefore + 1)
      const stored = lexicalJson as { root: { children: { children: { type: string; text?: string }[] }[] } }
      const storedText = stored.root.children[0]?.children.filter((child) => child.type === 'text').map((child) => child.text ?? '').join('')
      expect(storedText).toBe(target)
    }

    lexical.removeAttribute('data-wt-chat-input')

    setPageUrl('https://app.slack.com/client/T/C')
    const quillRoot = mountManaged('https://app.slack.com/client/T/C', '<p>你好</p>', 'quill')
    quillRoot.setAttribute('data-wt-chat-input', elementId)
    let quillText = '你好\n'
    let quillOps: unknown[] = [{ insert: '你好\n' }]
    let quillWrites = 0
    let enabled = true
    const quill = {
      root: quillRoot,
      getContents: () => ({ ops: quillOps }),
      getText: () => quillText,
      setText(value: string, source: string) {
        expect(source).toBe('user')
        quillWrites += 1
        quillText = value
        quillOps = [{ insert: value }]
      },
      isEnabled: () => enabled,
      setSelection() { return undefined },
    }
    const quillParent = document.createElement('div')
    quillParent.append(quillRoot)
    document.body.append(quillParent)
    ;(quillParent as unknown as { __quill?: unknown }).__quill = quill
    expect(isolated({ elementId, expectedText: '你好', text: 'Line\r\n\r\nTwo\n' })).toBe('ok')
    expect(quillText).toBe('Line\n\nTwo\n\n')
    expect(quillWrites).toBe(1)
    quillOps = [{ insert: '你好\n', attributes: { bold: true } }]
    quillText = '你好\n'
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    quillOps = [{ insert: '你好\n' }]
    enabled = false
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('failed')
    expect(quillWrites).toBe(1)
    quillText = '你好\n'
    quillOps = [{ insert: '你好\n' }]
    enabled = true
    const quillWritesBeforeRewrite = quillWrites
    quill.setText = (value: string, source: string) => {
      expect(source).toBe('user')
      expect(value).toBe('Hello\n')
      quillWrites += 1
      quillText = 'ok\n'
      quillOps = [{ insert: 'ok\n' }]
    }
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('failed')
    expect(quillText).toBe('ok\n')
    expect(quillWrites).toBe(quillWritesBeforeRewrite + 1)

    quillRoot.removeAttribute('data-wt-chat-input')

    setPageUrl('https://teams.microsoft.com/v2/')
    const roosterRoot = mountManaged('https://teams.microsoft.com/v2/', '<div>你好</div>')
    roosterRoot.setAttribute('data-wt-chat-input', elementId)
    let roosterModel: { blockGroupType: string; blocks: unknown[] } = {
      blockGroupType: 'Document',
      blocks: [{ blockType: 'Paragraph', format: {}, segments: [{ segmentType: 'Text', text: '你好', format: {} }] }],
    }
    let roosterWrites = 0
    let disposed = false
    const rooster = {
      getCore: () => ({ physicalRoot: roosterRoot }),
      getContentModelCopy: () => roosterModel,
      formatContentModel(formatter: (model: { blocks: unknown[] }) => boolean) {
        const live = { blockGroupType: roosterModel.blockGroupType, blocks: roosterModel.blocks }
        const accepted = formatter(live)
        if (accepted) {
          roosterWrites += 1
          roosterModel = live
        }
        return accepted
      },
      isDisposed: () => disposed,
    }
    ;(roosterRoot as unknown as { editor?: unknown }).editor = { _editor: rooster }
    const otherRoosterRoot = document.createElement('div')
    const roosterCoreSpy = vi.spyOn(rooster, 'getCore').mockReturnValue({ physicalRoot: otherRoosterRoot })
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    expect(roosterWrites).toBe(0)
    roosterCoreSpy.mockRestore()
    expect(isolated({ elementId, expectedText: '你好', text: '第一行\n\n第三行\n' })).toBe('ok')
    expect(roosterWrites).toBe(1)
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('changed')
    roosterModel = {
      blockGroupType: 'Document',
      blocks: [{ blockType: 'Paragraph', format: {}, segments: [{ segmentType: 'Text', text: '你好', format: { link: 'https://example.com' } }] }],
    }
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    roosterModel = {
      blockGroupType: 'Document',
      blocks: [{ blockType: 'Paragraph', format: {}, segments: [{ segmentType: 'Text', text: '你好', format: {} }] }],
    }
    disposed = true
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('failed')
    expect(roosterWrites).toBe(1)
    disposed = false
    roosterModel = {
      blockGroupType: 'Document',
      blocks: [{ blockType: 'Paragraph', format: {}, segments: [{ segmentType: 'Text', text: '你好', format: {}, data: { type: 'mention' } }] }],
    }
    const roosterWritesBeforeData = roosterWrites
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    expect(roosterWrites).toBe(roosterWritesBeforeData)
    delete (roosterRoot as unknown as { editor?: unknown }).editor
    expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
    expect(roosterWrites).toBe(roosterWritesBeforeData)

    roosterRoot.removeAttribute('data-wt-chat-input')
    const quillContainer = document.createElement('div')
    quillContainer.className = 'ql-container'
    const foundEditor = mountManaged('https://app.slack.com/client/T/C', '<p>你好</p>', 'quill')
    quillContainer.append(foundEditor)
    document.body.append(quillContainer)
    foundEditor.setAttribute('data-wt-chat-input', elementId)
    const wrongFindRoot = document.createElement('div')
    let findRoot: HTMLElement = wrongFindRoot
    let foundText = '你好\n'
    let foundOps: unknown[] = [{ insert: '你好\n' }]
    let foundWrites = 0
    const previousQuill = (globalThis as unknown as { Quill?: unknown }).Quill
    ;(globalThis as unknown as { Quill: { find(container: Element, bubble: boolean): unknown } }).Quill = {
      find(container: Element, bubble: boolean) {
        expect(container).toBe(quillContainer)
        expect(bubble).toBe(true)
        return {
          get root() { return findRoot },
          getContents: () => ({ ops: foundOps }),
          getText: () => foundText,
          setText(value: string, source: string) {
            expect(source).toBe('user')
            foundWrites += 1
            foundText = value
            foundOps = [{ insert: value }]
          },
          isEnabled: () => true,
          setSelection() { return undefined },
        }
      },
    }
    try {
      expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('unsupported')
      expect(foundWrites).toBe(0)
      findRoot = foundEditor
      foundText = '你好\n'
      foundOps = [{ insert: '你好\n' }]
      expect(isolated({ elementId, expectedText: '你好', text: 'Hello' })).toBe('ok')
      expect(foundText).toBe('Hello\n')
      expect(foundWrites).toBe(1)
    } finally {
      if (previousQuill === undefined) delete (globalThis as unknown as { Quill?: unknown }).Quill
      else (globalThis as unknown as { Quill?: unknown }).Quill = previousQuill
    }
  })

  it('WhatsApp 托管编辑器吞掉原生 compositionend 后派发的不可信副本可结束已开始的合成，但不能凭空触发请求', async () => {
    const field = mountManaged('https://web.whatsapp.com/', '<p>你好世界</p>', 'lexical')
    field.focus()
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })

    const untrustedEnd = (): void => {
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
    }

    untrustedEnd()
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    trustedComposition(field, 'compositionstart')
    trustedInput(field, undefined, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    untrustedEnd()
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['你好世界'])
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputEditorUnsupported)
    watcher.dispose()
  })
})

describe('视频站点输入框 YouTube Bilibili', () => {
  function mountYtComment(text = '请检查这段代码'): HTMLElement {
    const root = document.createElement('div')
    root.id = 'contenteditable-root'
    root.setAttribute('contenteditable', 'true')
    const p = document.createElement('p')
    const span = document.createElement('span')
    span.className = 'style-scope yt-formatted-string'
    span.textContent = text
    p.append(span)
    root.append(p)
    document.body.append(root)
    return root
  }

  function mountShadowBili(hostAttrs: Record<string, string> = {}): { host: HTMLElement; field: HTMLElement } {
    const host = document.createElement('bili-comment-rich-textarea')
    for (const [k, v] of Object.entries(hostAttrs)) host.setAttribute(k, v)
    const shadow = host.attachShadow({ mode: 'open' })
    const wrap = document.createElement('div')
    wrap.id = 'input'
    const inner = document.createElement('div')
    inner.className = 'brt-root'
    const field = document.createElement('div')
    field.className = 'brt-editor'
    field.setAttribute('contenteditable', 'true')
    const p = document.createElement('p')
    const span = document.createElement('span')
    span.textContent = '请检查这段代码'
    p.append(span)
    field.append(p)
    inner.append(field)
    wrap.append(inner)
    shadow.append(wrap)
    document.body.append(host)
    return { host, field }
  }

  it('YouTube 评论纯文本结构接受并触发翻译', async () => {
    setPageUrl('https://www.youtube.com/watch?v=fixture')
    const field = mountYtComment()
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: texts.map((t) => `EN:${t}`) }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    focusEditable(field)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledWith(['请检查这段代码'], expect.any(String), undefined)
    watcher.dispose()
  })

  it('识别 .brt-editor 但拒绝伪造主机与其他主机', () => {
    setPageUrl('https://www.bilibili.com/video/BV1')
    const { field } = mountShadowBili()
    expect(isNativeVideoChatEditor(field)).toBe(true)
    setPageUrl('https://www.youtube.com/watch?v=x')
    expect(isNativeVideoChatEditor(mountYtComment())).toBe(true)
    expect(isNativeVideoChatEditor(field)).toBe(false)
    setPageUrl('https://www.youtube.com.evil/watch')
    expect(isNativeVideoChatEditor(mountYtComment())).toBe(false)
    setPageUrl('https://evil.com/')
    expect(isNativeVideoChatEditor(field)).toBe(false)
  })

  it('mentions 图片嵌套 contenteditable 与隐藏子节点拒绝', () => {
    setPageUrl('https://www.youtube.com/watch?v=fixture')
    const field = mountYtComment()
    const img = document.createElement('img')
    field.append(img)
    expect(isNativeVideoChatEditor(field)).toBe(false)
    img.remove()
    const mention = document.createElement('span')
    mention.className = 'mention'
    field.append(mention)
    expect(isNativeVideoChatEditor(field)).toBe(false)
    mention.remove()
    const nested = document.createElement('span')
    nested.setAttribute('contenteditable', 'true')
    field.append(nested)
    expect(isNativeVideoChatEditor(field)).toBe(false)
  })

  it('openShadow Bili 深层焦点与事件触发翻译', async () => {
    setPageUrl('https://www.bilibili.com/video/BV1')
    const { field } = mountShadowBili()
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`JA:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    field.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledWith(['请检查这段代码'], expect.any(String), undefined)
    watcher.dispose()
  })

  it('shadow 宿主 hidden/data-sensitive/aria-readonly 与本地敏感标签均不请求', async () => {
    setPageUrl('https://www.bilibili.com/video/BV1')
    for (const attrs of [{ hidden: '' }, { 'data-sensitive': '' }, { 'aria-readonly': 'true' }] as Array<Record<string, string>>) {
      const { field } = mountShadowBili(attrs)
      const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`JA:${texts[0]}`] }))
      const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
      field.focus()
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      trustedInput(field)
      await vi.advanceTimersByTimeAsync(1000)
      expect(translate).not.toHaveBeenCalled()
      watcher.dispose()
    }
    const { host, field } = mountShadowBili()
    const label = document.createElement('span')
    label.id = 'secret-label'
    label.textContent = 'API密钥'
    host.shadowRoot!.prepend(label)
    field.setAttribute('aria-labelledby', 'secret-label')
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`JA:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    field.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    watcher.dispose()
  })

  it('execCommand insertText 成功替换且 Restore 仍可恢复', async () => {
    setPageUrl('https://www.youtube.com/watch?v=fixture')
    const field = mountYtComment()
    const calls: string[] = []
    const exec = (...args: unknown[]): boolean => {
      calls.push(String(args[0]))
      if (args[0] === 'insertText') { field.querySelector('span')!.textContent = String(args[2]); trustedInput(field); return true }
      return false
    }
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`JA:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    focusEditable(field)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(calls).toContain('insertText')
    expect(field.textContent).toBe('JA:请检查这段代码')
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    const shadow = popoverShadow()
    const restore = shadow?.querySelector<HTMLButtonElement>('button[data-action="restore"]')
    expect(restore).not.toBeNull()
    trustedClick(restore!)
    await vi.advanceTimersByTimeAsync(1000)
    expect(field.textContent).toBe('请检查这段代码')
    expect(translate).toHaveBeenCalledTimes(1)
    watcher.dispose()
    delete (document as unknown as { execCommand?: unknown }).execCommand
  })

  it('execCommand false 保留原文且不二次请求', async () => {
    setPageUrl('https://www.youtube.com/watch?v=fixture')
    const field = mountYtComment()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`JA:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    focusEditable(field)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(field.textContent).toBe('请检查这段代码')
    expect(translate).toHaveBeenCalledTimes(1)
    watcher.dispose()
    delete (document as unknown as { execCommand?: unknown }).execCommand
  })

  it('planNativeVideoChatDraft 规划换行、末尾空行、HTML 字面文本、CRLF 与行数上限', () => {
    expect(planNativeVideoChatDraft('a\n\nb\n\n')).toEqual({
      lines: ['a', '', 'b'],
      trailingBreaks: 1,
    })
    expect(planNativeVideoChatDraft('a\n\n\n')).toEqual({
      lines: ['a'],
      trailingBreaks: 2,
    })
    expect(planNativeVideoChatDraft('\na')).toEqual({
      lines: ['', 'a'],
      trailingBreaks: 0,
    })
    expect(planNativeVideoChatDraft('a\n')).toBeUndefined()
    expect(planNativeVideoChatDraft('')).toBeUndefined()
    expect(planNativeVideoChatDraft('\n\n')).toBeUndefined()
    expect(planNativeVideoChatDraft('<b>x</b>')).toEqual({
      lines: ['<b>x</b>'],
      trailingBreaks: 0,
    })
    expect(planNativeVideoChatDraft(Array.from({ length: 128 }, () => 'a').join('\n'))).toEqual({
      lines: Array.from({ length: 128 }, () => 'a'),
      trailingBreaks: 0,
    })
    expect(planNativeVideoChatDraft(Array.from({ length: 129 }, () => 'a').join('\n'))).toBeUndefined()
    expect(planNativeVideoChatDraft(`${Array.from({ length: 127 }, () => 'a').join('\n')}\n\n\n`)).toBeUndefined()
    expect(planNativeVideoChatDraft('a\r\n\r\nb\r\n\r\n')).toEqual({
      lines: ['a', '', 'b'],
      trailingBreaks: 1,
    })
    expect(planNativeVideoChatDraft('a\r\n\r\n\r\n')).toEqual({
      lines: ['a'],
      trailingBreaks: 2,
    })
    expect(planNativeVideoChatDraft('\r\na')).toEqual({
      lines: ['', 'a'],
      trailingBreaks: 0,
    })
    expect(planNativeVideoChatDraft('a\r\n')).toBeUndefined()
  })

  it('未支持的目标末尾单 LF 在替换前拒绝，不调用 execCommand，保留原文并出现 Copy', async () => {
    setPageUrl('https://www.youtube.com/watch?v=fixture')
    const field = mountYtComment('请保留换行')
    const execSpy = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execSpy })
    const beforeInputSpy = vi.fn()
    field.addEventListener('beforeinput', beforeInputSpy)
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['改行を保持してください。\n'] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    focusEditable(field)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(execSpy).not.toHaveBeenCalled()
    expect(beforeInputSpy).not.toHaveBeenCalled()
    expect(field.textContent).toBe('请保留换行')
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)
    expect(requirePopoverButton('copy')).not.toBeNull()
    expect(popoverShadow()?.querySelector('button[data-action="copy-original"]')).toBeNull()
    expect(popoverShadow()?.querySelector('button[data-action="restore"]')).toBeNull()
    watcher.dispose()
    delete (document as unknown as { execCommand?: unknown }).execCommand
  })

  it('原生写完读回不匹配时只调用一次 undo，恢复原文并报错而非成功', async () => {
    setPageUrl('https://www.youtube.com/watch?v=fixture')
    const field = mountYtComment('请检查这段代码')
    const calls: string[] = []
    const exec = (...args: unknown[]): boolean => {
      const cmd = String(args[0])
      calls.push(cmd)
      if (cmd === 'insertText') {
        field.querySelector('span')!.textContent = '被宿主篡改的不一致内容'
        trustedInput(field)
        return true
      }
      if (cmd === 'undo') {
        field.querySelector('span')!.textContent = '请检查这段代码'
        trustedInput(field)
        return true
      }
      return false
    }
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['このコードを確認してください。'] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    focusEditable(field)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(calls).toEqual(['insertText', 'undo'])
    expect(field.textContent).toBe('请检查这段代码')
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplaceFailed)
    expect(requirePopoverButton('copy')).not.toBeNull()
    expect(popoverShadow()?.querySelector('button[data-action="restore"]')).toBeNull()
    expect(popoverShadow()?.querySelector('button[data-action="copy-original"]')).toBeNull()
    watcher.dispose()
    delete (document as unknown as { execCommand?: unknown }).execCommand
  })

  it('undo 失败留下部分草稿时显示 wtInputReplacePartial 与 copy-original，点击复制的是原文', async () => {
    setPageUrl('https://www.youtube.com/watch?v=fixture')
    const field = mountYtComment('第一行\n\n第三行')
    const calls: string[] = []
    const exec = (...args: unknown[]): boolean => {
      const cmd = String(args[0])
      calls.push(cmd)
      if (cmd === 'delete') {
        field.querySelector('span')!.textContent = ''
        trustedInput(field)
        return true
      }
      if (cmd === 'insertText') {
        field.querySelector('span')!.textContent = `${field.querySelector('span')!.textContent ?? ''}${String(args[2])}`
        trustedInput(field)
        return true
      }
      if (cmd === 'insertLineBreak') {
        return false
      }
      if (cmd === 'undo') {
        return false
      }
      return false
    }
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    const copySpy = vi.spyOn(clipboard, 'copySelectionText').mockResolvedValue(true)
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['一行目\n\n三行目'] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (k) => zhCN[k] })
    focusEditable(field)
    trustedInput(field)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(calls).toEqual(['delete', 'insertText', 'insertLineBreak', 'undo'])
    expect(field.textContent).toBe('一行目')
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplacePartial)
    expect(popoverShadow()?.querySelector('button[data-action="restore"]')).toBeNull()
    expect(requirePopoverButton('copy')).not.toBeNull()
    const copyOriginalBtn = requirePopoverButton('copy-original')
    expect(copyOriginalBtn.textContent).toBe(zhCN.wtInputCopyOriginal)
    trustedClick(copyOriginalBtn)
    await Promise.resolve()
    expect(copySpy).toHaveBeenCalledTimes(1)
    expect(copySpy).toHaveBeenCalledWith('第一行\n第三行')
    expect(copyOriginalBtn.textContent).toBe(zhCN.wtToolbarCopied)
    await vi.advanceTimersByTimeAsync(1500)
    expect(copyOriginalBtn.textContent).toBe(zhCN.wtInputCopyOriginal)

    let failRestore = false
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (...args: unknown[]): boolean => {
        const cmd = String(args[0])
        if (cmd === 'insertText') {
          field.querySelector('span')!.textContent = failRestore ? '半途而废的还原' : String(args[2])
          trustedInput(field)
          return true
        }
        if (cmd === 'undo') return false
        return false
      },
    })
    field.querySelector('span')!.textContent = '第二轮原始中文'
    trustedInput(field)
    translate.mockResolvedValueOnce({ ok: true as const, texts: ['Second round translated'] })
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(field.textContent).toBe('Second round translated')
    failRestore = true
    copySpy.mockClear()
    trustedClick(requirePopoverButton('restore'))
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputReplacePartial)
    trustedClick(requirePopoverButton('copy-original'))
    await Promise.resolve()
    expect(copySpy).toHaveBeenCalledWith('第二轮原始中文')

    const unsafeField = document.createElement('div')
    unsafeField.id = 'contenteditable-root'
    unsafeField.setAttribute('contenteditable', 'true')
    const hiddenDiv = document.createElement('div')
    hiddenDiv.textContent = '隐藏文本'
    unsafeField.append(hiddenDiv, document.createTextNode('请检查这段代码'))
    document.body.append(unsafeField)
    const origGetComputedStyle = window.getComputedStyle.bind(window)
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el === hiddenDiv) return { display: 'none', visibility: 'visible' } as CSSStyleDeclaration
      return origGetComputedStyle(el)
    })
    expect(isNativeVideoChatEditor(unsafeField)).toBe(false)
    translate.mockClear()
    focusEditable(unsafeField)
    trustedInput(unsafeField)
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    styleSpy.mockRestore()

    watcher.dispose()
    delete (document as unknown as { execCommand?: unknown }).execCommand
  })
})

describe('输入不再提供替换快捷键', () => {
  afterEach(() => {
    setPageUrl('about:blank')
  })

  function dispatchTab(
    target: EventTarget,
    init: KeyboardEventInit & { keyCode?: number } = {},
    trusted = true,
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    })
    if (init.keyCode !== undefined) {
      Object.defineProperty(event, 'keyCode', { value: init.keyCode })
    }
    if (trusted) {
      Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
    }
    target.dispatchEvent(event)
    return event
  }

  it('普通 textarea 直接替换后 Tab 保持原生行为，浮层没有替换按钮或快捷键提示', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [`Translated: ${texts[0]}`],
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    textarea.focus()
    trustedInput(textarea, '需要替换的中文草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    expect(popoverShadow()?.querySelector('[aria-keyshortcuts]')).toBeNull()

    const bubbleSpy = vi.fn()
    textarea.addEventListener('keydown', bubbleSpy)

    const tabEvent = dispatchTab(textarea)
    expect(tabEvent.defaultPrevented).toBe(false)
    expect(bubbleSpy).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('Translated: 需要替换的中文草稿')
    expect(popoverShadow()?.querySelector('button[data-action="replace"]')).toBeNull()
    expect(requirePopoverButton('restore')).not.toBeNull()

    watcher.dispose()
  })

  it('Discord 与 WhatsApp 自动写回一次，Tab 不拦截且不追加写回', async () => {
    setPageUrl('https://discord.com/channels/@me/1')
    const discordField = mountSlate(['需要翻译的中文'])
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Hello Discord'] }))
    const replaceDiscordInput = vi.fn(async (request: { text: string }) => {
      writeSlateText(discordField, request.text)
      return 'ok' as const
    })
    const discordWatcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceDiscordInput,
    })

    discordField.focus()
    trustedInput(discordField)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    const discordTab = dispatchTab(discordField)
    expect(discordTab.defaultPrevented).toBe(false)
    expect(replaceDiscordInput).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
    await Promise.resolve()
    expect(readDiscordDraft(discordField)).toBe('Hello Discord')
    expect(requirePopoverButton('restore')).not.toBeNull()
    discordWatcher.dispose()

    setPageUrl('https://web.whatsapp.com/')
    const waField = document.createElement('div')
    waField.setAttribute('contenteditable', 'true')
    waField.setAttribute('data-lexical-editor', 'true')
    waField.innerHTML = '<p>需要翻译的中文</p>'
    document.body.append(waField)
    const waTranslate = vi.fn(async () => ({ ok: true as const, texts: ['Hello WhatsApp'] }))
    const replaceChatInput = vi.fn(async (request: { text: string }) => {
      waField.innerHTML = `<p>${request.text}</p>`
      return 'ok' as const
    })
    const waWatcher = createInputTranslation({
      translate: waTranslate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceChatInput,
    })

    waField.focus()
    trustedInput(waField)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    const waTab = dispatchTab(waField)
    expect(waTab.defaultPrevented).toBe(false)
    expect(replaceChatInput).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
    await Promise.resolve()
    expect(readChatDraft(waField)).toBe('Hello WhatsApp')
    expect(requirePopoverButton('restore')).not.toBeNull()
    waWatcher.dispose()
  })

  it('加载中、已替换和报错状态均不拦截 Tab 或修改草稿', async () => {
    const textarea = document.createElement('textarea')
    const other = document.createElement('textarea')
    document.body.append(textarea, other)
    let resolveTranslate!: (reply: { ok: true; texts: string[] } | { ok: false; error: string }) => void
    const translate = vi.fn(() => new Promise<{ ok: true; texts: string[] } | { ok: false; error: string }>(resolve => { resolveTranslate = resolve }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: key => zhCN[key] })
    trustedInput(textarea, '初始中文草稿')
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatchTab(textarea).defaultPrevented).toBe(false)
    expect(textarea.value).toBe('初始中文草稿')
    resolveTranslate({ ok: true, texts: ['Translated draft'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(textarea.value).toBe('Translated draft')
    for (const init of [{}, { shiftKey: true }, { ctrlKey: true }, { isComposing: true }, { repeat: true }]) {
      expect(dispatchTab(textarea, init).defaultPrevented).toBe(false)
      expect(textarea.value).toBe('Translated draft')
    }
    expect(dispatchTab(textarea, {}, false).defaultPrevented).toBe(false)
    expect(dispatchTab(other).defaultPrevented).toBe(false)
    expect(translate).toHaveBeenCalledTimes(1)
    trustedInput(textarea, '报错中文草稿')
    await vi.advanceTimersByTimeAsync(1000)
    resolveTranslate({ ok: false, error: '服务异常' })
    await vi.advanceTimersByTimeAsync(0)
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe('服务异常')
    expect(dispatchTab(textarea).defaultPrevented).toBe(false)
    expect(textarea.value).toBe('报错中文草稿')
    watcher.dispose()
  })

  it('旧替换键配置不再抢占 Tab 或 Ctrl+Enter，也不展示快捷键提示', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    let replaceKey = 'Ctrl+Enter'
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`Translated: ${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: key => zhCN[key], replaceKey: () => replaceKey })
    for (const key of ['Ctrl+Enter', '']) {
      replaceKey = key
      trustedInput(textarea, `旧配置草稿${key}`)
      await vi.advanceTimersByTimeAsync(500)
      expect(dispatchTab(textarea).defaultPrevented).toBe(false)
      expect(dispatchTab(textarea, { key: 'Enter', ctrlKey: true }).defaultPrevented).toBe(false)
      expect(textarea.value).toBe(`旧配置草稿${key}`)
      await vi.advanceTimersByTimeAsync(500)
      expect(textarea.value).toBe(`Translated: 旧配置草稿${key}`)
      expect(popoverShadow()?.querySelector('[aria-keyshortcuts]')).toBeNull()
      expect(popoverShadow()?.querySelector('button[data-action="replace"]')).toBeNull()
    }
    expect(translate).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('多语言输入翻译：目标为 zh-CN 时翻译英文草稿并跳过中文，浮层标题显示 源语言 → 目标语言', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    let sourceLang: 'auto' | 'en' | 'zh-CN' = 'auto'
    let targetLang: 'zh-CN' | 'en' = 'zh-CN'
    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [`ZH:${texts[0]}`],
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k, params) => translateMessage('zh-CN', k, params),
      sourceLanguage: () => sourceLang,
      targetLanguage: () => targetLang,
    })

    textarea.focus()
    // 目标为 zh-CN 时，中文草稿已是目标语言，不触发
    trustedInput(textarea, '已经是中文草稿')
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    // 英文草稿在目标为 zh-CN 时触发翻译
    trustedInput(textarea, 'Please review this pull request')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['Please review this pull request'])
    expect(popoverShadow()?.querySelector('.title')?.textContent).toBe(
      `${zhCN.wtInputTranslation} · ${zhCN.wtSourceAuto} → 简体中文`,
    )

    // 指定源语言 en → zh-CN 时标题显示 English → 简体中文
    sourceLang = 'en'
    trustedInput(textarea, 'Another English draft')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(popoverShadow()?.querySelector('.title')?.textContent).toBe(
      `${zhCN.wtInputTranslation} · English → 简体中文`,
    )

    // source === target 时不触发
    targetLang = 'en'
    translate.mockClear()
    trustedInput(textarea, 'Same language draft')
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()

    watcher.dispose()
  })
})

describe('停止输入后自动替换（replaceMode = auto）', () => {
  it('完整等待配置的 1000ms 才请求，期间再次输入会重新计时且不显示预览倒计时', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: key => zhCN[key], autoReplaceDelayMs: () => 1000 })
    trustedInput(textarea, '第一版中文')
    await vi.advanceTimersByTimeAsync(800)
    expect(translate).not.toHaveBeenCalled()
    expect(isPopoverOpen()).toBe(false)
    trustedInput(textarea, '第二版中文')
    await vi.advanceTimersByTimeAsync(999)
    expect(translate).not.toHaveBeenCalled()
    expect(textarea.value).toBe('第二版中文')
    await vi.advanceTimersByTimeAsync(1)
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate).toHaveBeenCalledWith(['第二版中文'], expect.any(String), undefined)
    expect(textarea.value).toBe('EN:第二版中文')
    expect(requirePopoverButton('restore')).not.toBeNull()
    expect(popoverShadow()?.querySelector('[data-action="auto-hint"]')).toBeNull()
    expect(popoverShadow()?.querySelector('[data-action="replace"]')).toBeNull()
    watcher.dispose()
  })

  it('译文返回晚于 delay 时立即替换；delay 小于 600ms 时按 delay 防抖', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    let delayMs = 1000
    let resolveSlow: ((reply: { ok: true; texts: string[] }) => void) | undefined
    const translate = vi.fn(
      (texts: string[]) =>
        new Promise<{ ok: true; texts: string[] }>((resolve) => {
          resolveSlow = () => resolve({ ok: true, texts: [`EN:${texts[0]}`] })
        }),
    )
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceMode: () => 'auto',
      autoReplaceDelayMs: () => delayMs,
    })

    focusEditable(textarea)
    trustedInput(textarea, '慢速翻译草稿')
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(1)

    // 再过 600ms（总计 1200ms > 1000ms）译文才返回，应立即替换
    await vi.advanceTimersByTimeAsync(1000)
    resolveSlow?.({ ok: true, texts: ['EN:慢速翻译草稿'] })
    await Promise.resolve()
    expect(textarea.value).toBe('EN:慢速翻译草稿')

    // delay = 500ms 时防抖取 500ms
    delayMs = 500
    trustedInput(textarea, '五百毫秒草稿')
    await vi.advanceTimersByTimeAsync(499)
    expect(translate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(translate).toHaveBeenCalledTimes(2)
    resolveSlow?.({ ok: true, texts: ['EN:五百毫秒草稿'] })
    await Promise.resolve()
    expect(textarea.value).toBe('EN:五百毫秒草稿')

    watcher.dispose()
  })

  it('等待中失焦、点关闭、按 Escape、合成开始或内容变化均放弃自动替换且不报错', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    let finish!: () => void
    const translate = vi.fn((texts: string[]) => new Promise<{ ok: true; texts: string[] }>(resolve => { finish = () => resolve({ ok: true, texts: [`EN:${texts[0]}`] }) }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceMode: () => 'auto',
      autoReplaceDelayMs: () => 1000,
    })

    // 1. 等待中失焦
    focusEditable(textarea)
    trustedInput(textarea, '失焦测试')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    textarea.blur()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(textarea.value).toBe('失焦测试')

    // 2. 等待中点浮层关闭按钮
    focusEditable(textarea)
    trustedInput(textarea, '点关闭测试')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    const closeBtn = popoverShadow()!.querySelector<HTMLButtonElement>('button[data-action="close"]')!
    trustedClick(closeBtn)
    finish()
    expect(isPopoverOpen()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(textarea.value).toBe('点关闭测试')

    // 3. 等待中按 Escape 关闭浮层
    trustedInput(textarea, '按Esc测试')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(isPopoverOpen()).toBe(true)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })
    Object.defineProperty(esc, 'isTrusted', { value: true, configurable: true })
    textarea.dispatchEvent(esc)
    finish()
    expect(isPopoverOpen()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(textarea.value).toBe('按Esc测试')

    // 4. 等待中合成开始
    trustedInput(textarea, '合成开始测试')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    trustedComposition(textarea, 'compositionstart')
    finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(textarea.value).toBe('合成开始测试')
    trustedComposition(textarea, 'compositionend')
    await vi.advanceTimersByTimeAsync(1100)
    await Promise.resolve()

    // 5. 等待中内容被脚本静默修改（不触发 input 事件）→ 放弃自动替换且不报错
    trustedInput(textarea, '内容静默变化测试')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    textarea.value = '内容已被静默改掉'
    finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(textarea.value).toBe('内容已被静默改掉')
    expect(popoverShadow()?.querySelector('.status.is-error')).toBeNull()

    watcher.dispose()
  })

  it('等待中按 Tab 不提前替换，配置时间到期才写回且不重复', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [`EN:${texts[0]}`],
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceMode: () => 'auto',
      autoReplaceDelayMs: () => 2000,
    })

    let inputCount = 0
    textarea.addEventListener('input', () => {
      inputCount += 1
    })

    focusEditable(textarea)
    trustedInput(textarea, '提前按键草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(textarea.value).toBe('提前按键草稿')

    inputCount = 0
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true, cancelable: true })
    Object.defineProperty(tab, 'isTrusted', { value: true, configurable: true })
    textarea.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(textarea.value).toBe('提前按键草稿')
    expect(inputCount).toBe(0)

    // 再过 2000ms，原计时器已清理，不会二次写入
    await vi.advanceTimersByTimeAsync(2000)
    expect(inputCount).toBe(1)
    expect(textarea.value).toBe('EN:提前按键草稿')

    watcher.dispose()
  })

  it('还原原文后不会自动替换同一原文，继续编辑后按当前目标语言重新请求', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    let targetLang: 'en' | 'es' = 'en'
    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [targetLang === 'es' ? `Hola ${texts[0]}` : `Hello ${texts[0]}`],
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      targetLanguage: () => targetLang,
      replaceMode: () => 'auto',
      autoReplaceDelayMs: () => 1000,
    })

    focusEditable(textarea)
    trustedInput(textarea, '需要还原的草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(400)
    expect(textarea.value).toBe('Hello 需要还原的草稿')

    // 点击「还原原文」
    try {
      const restoreBtn = requirePopoverButton('restore')
      trustedClick(restoreBtn)
      expect(textarea.value).toBe('需要还原的草稿')

      // 等待超过 2s，甚至触发不改内容的 input 事件，都不会再次自动替换同一段原文
      await vi.advanceTimersByTimeAsync(2000)
      trustedInput(textarea)
      await vi.advanceTimersByTimeAsync(2000)
      expect(textarea.value).toBe('需要还原的草稿')
      expect(translate).toHaveBeenCalledTimes(1)
      expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe('')
      expect(popoverShadow()?.querySelector('.actions')?.children.length).toBe(0)
      expect(isPopoverOpen()).toBe(false)

      // 用户再次编辑后正常自动替换，且目标语言为 es 时译文不会再次触发翻译
      targetLang = 'es'
      trustedInput(textarea, '修改后的草稿')
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(400)
      expect(textarea.value).toBe('Hola 修改后的草稿')
      expect(translate).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(2000)
      expect(translate).toHaveBeenCalledTimes(2)
      expect(textarea.value).toBe('Hola 修改后的草稿')
    } finally {
      watcher.dispose()
    }
  })

  it('自动弹窗偏好开关不影响输入翻译的直接替换', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    let autoPreview = false
    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [`EN:${texts[0]}`],
    }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      autoPreview: () => autoPreview,
      autoReplaceDelayMs: () => 1000,
    })

    focusEditable(textarea)
    trustedInput(textarea, '自动弹窗关闭时的草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(400)
    expect(translate).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('EN:自动弹窗关闭时的草稿')

    autoPreview = true
    trustedInput(textarea, '自动弹窗开启时的草稿')
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).toHaveBeenCalledTimes(2)
    expect(textarea.value).toBe('EN:自动弹窗开启时的草稿')
    expect(popoverShadow()?.querySelector('[data-action="auto-hint"]')).toBeNull()
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputRestoreHint)

    watcher.dispose()
  })

  it('还原立即清空浮层且旧操作失效；失焦后相同原文不复发，编辑与主动翻译可继续', async () => {
    const copy = vi.mocked(clipboard.copySelectionText)
    copy.mockClear()

    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    const plainTranslate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [`EN:${texts[0]}`],
    }))
    const plainWatcher = createInputTranslation({
      translate: plainTranslate,
      cancel: vi.fn(),
      t: (k) => zhCN[k],
    })

    try {
      focusEditable(textarea)
      trustedInput(textarea, '需要还原的普通草稿')
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
        expect(textarea.value).toBe('EN:需要还原的普通草稿')

      const plainShadow = popoverShadow()!
      const plainPopover = plainShadow.querySelector<HTMLElement>('.popover')!
      expect(plainShadow.querySelector('button[data-action="copy"]')).toBeNull()
      const plainRestoreBtn = requirePopoverButton('restore')
      let finishPlainFade: () => void = () => undefined
      const plainFadeDone = new Promise<void>((resolve) => {
        finishPlainFade = resolve
      })
      Object.defineProperty(plainPopover, 'getAnimations', {
        configurable: true,
        value: () => [{ animationName: 'wt-surface-exit', finished: plainFadeDone }],
      })

      plainRestoreBtn.focus()
      expect(document.activeElement).toBe(document.querySelector('[data-wt-root]'))
      trustedClick(plainRestoreBtn)

      expect(textarea.value).toBe('需要还原的普通草稿')
      expect(document.activeElement).toBe(textarea)
      expect(plainPopover.hasAttribute('data-wt-closing')).toBe(true)
      expect(plainShadow.querySelector('[role="status"]')?.textContent).toBe('')
      expect(plainShadow.querySelector('.actions')?.children.length).toBe(0)
      trustedClick(plainRestoreBtn)
      await Promise.resolve()
      expect(copy).not.toHaveBeenCalled()
      expect(textarea.value).toBe('需要还原的普通草稿')

      finishPlainFade()
      await vi.advanceTimersByTimeAsync(150)
      await Promise.resolve()
      expect(isPopoverOpen()).toBe(false)

      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()
      textarea.focus()
      outside.remove()
      trustedInput(textarea)
      const tabAfterRestore = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true, cancelable: true })
      Object.defineProperty(tabAfterRestore, 'isTrusted', { value: true, configurable: true })
      textarea.dispatchEvent(tabAfterRestore)
      expect(tabAfterRestore.defaultPrevented).toBe(false)
      await vi.advanceTimersByTimeAsync(2000)
      expect(plainTranslate).toHaveBeenCalledTimes(1)
      expect(textarea.value).toBe('需要还原的普通草稿')
      expect(isPopoverOpen()).toBe(false)

      expect(plainWatcher.translateAndReplace()).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      expect(plainTranslate).toHaveBeenCalledTimes(2)
      expect(textarea.value).toBe('EN:需要还原的普通草稿')
      delete (plainPopover as { getAnimations?: unknown }).getAnimations
      trustedClick(requirePopoverButton('restore'))
      expect(textarea.value).toBe('需要还原的普通草稿')
      expect(isPopoverOpen()).toBe(false)

      trustedInput(textarea, '继续编辑后的普通草稿')
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      expect(plainTranslate).toHaveBeenCalledTimes(3)
      expect(plainShadow.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputRestoreHint)
    } finally {
      plainWatcher.dispose()
    }

    setPageUrl('https://discord.com/channels/@me/1')
    const discordField = mountSlate(['需要还原的托管草稿'])
    const discordTranslate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: [`Managed:${texts[0]}`],
    }))
    const replaceDiscordInput = vi.fn(async (request: { text: string }) => {
      writeSlateText(discordField, request.text)
      return 'ok' as const
    })
    const discordWatcher = createInputTranslation({
      translate: discordTranslate,
      cancel: vi.fn(),
      t: (k) => zhCN[k],
      replaceDiscordInput,
    })

    try {
      focusEditable(discordField)
      trustedInput(discordField)
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
        await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
      expect(readDiscordDraft(discordField)).toBe('Managed:需要还原的托管草稿')

      const discordShadow = popoverShadow()!
      const discordPopover = discordShadow.querySelector<HTMLElement>('.popover')!
      expect(discordShadow.querySelector('button[data-action="copy"]')).toBeNull()
      const discordRestoreBtn = requirePopoverButton('restore')
      let finishDiscordFade: () => void = () => undefined
      const discordFadeDone = new Promise<void>((resolve) => {
        finishDiscordFade = resolve
      })
      Object.defineProperty(discordPopover, 'getAnimations', {
        configurable: true,
        value: () => [{ animationName: 'wt-surface-exit', finished: discordFadeDone }],
      })

      discordRestoreBtn.focus()
      trustedClick(discordRestoreBtn)
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()

      expect(readDiscordDraft(discordField)).toBe('需要还原的托管草稿')
      expect(document.activeElement).toBe(discordField)
      expect(discordPopover.hasAttribute('data-wt-closing')).toBe(true)
      expect(discordShadow.querySelector('[role="status"]')?.textContent).toBe('')
      expect(discordShadow.querySelector('.actions')?.children.length).toBe(0)
      trustedClick(discordRestoreBtn)
      await Promise.resolve()
      expect(copy).not.toHaveBeenCalled()
      expect(replaceDiscordInput).toHaveBeenCalledTimes(2)

      finishDiscordFade()
      await vi.advanceTimersByTimeAsync(150)
      await Promise.resolve()
      expect(isPopoverOpen()).toBe(false)

      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()
      discordField.focus()
      outside.remove()
      trustedBeforeInput(discordField)
      trustedInput(discordField)
      await vi.advanceTimersByTimeAsync(2000)
      expect(discordTranslate).toHaveBeenCalledTimes(1)
      expect(replaceDiscordInput).toHaveBeenCalledTimes(2)
      expect(isPopoverOpen()).toBe(false)

      focusEditable(discordField)
      expect(discordWatcher.translateAndReplace()).toBe(true)
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
      expect(discordTranslate).toHaveBeenCalledTimes(2)
      expect(replaceDiscordInput).toHaveBeenCalledTimes(3)
      expect(readDiscordDraft(discordField)).toBe('Managed:需要还原的托管草稿')
      delete (discordPopover as { getAnimations?: unknown }).getAnimations
      trustedClick(requirePopoverButton('restore'))
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
      expect(readDiscordDraft(discordField)).toBe('需要还原的托管草稿')
      expect(isPopoverOpen()).toBe(false)

      writeSlateText(discordField, '继续编辑后的托管草稿')
      trustedBeforeInput(discordField)
      trustedInput(discordField)
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      expect(discordTranslate).toHaveBeenCalledTimes(3)
      expect(discordShadow.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputRestoreHint)
    } finally {
      discordWatcher.dispose()
      setPageUrl('about:blank')
    }
  })
})




describe('文档编辑器根节点不走普通输入路径', () => {
  it('TinyMCE/CKEditor 可编辑根返回 false，不发网络请求也不改 DOM', async () => {
    document.body.innerHTML = `
      <div id="tinymce" class="mce-content-body" contenteditable="true"><p>你好</p></div>
      <div class="ck-editor__editable ck-content" contenteditable="true" role="textbox"><p>第二行</p></div>
    `
    const tinymceBody = document.getElementById('tinymce') as HTMLElement
    const ckEditable = document.querySelector<HTMLElement>('.ck-editor__editable')!
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: texts.map((t) => `EN:${t}`) }))
    const watcher = createInputTranslation({ translate, cancel: vi.fn(), t: (key) => zhCN[key] })

    focusEditable(tinymceBody)
    expect(watcher.translateAndReplace()).toBe(false)
    focusEditable(ckEditable)
    expect(watcher.translateAndReplace()).toBe(false)
    trustedInput(tinymceBody, '你好\n新行')
    trustedInput(ckEditable, '第二行\n新行')
    const afterTyping = document.body.innerHTML
    await vi.advanceTimersByTimeAsync(1000)
    expect(translate).not.toHaveBeenCalled()
    expect(isPopoverOpen()).toBe(false)
    expect(document.body.innerHTML).toBe(afterTyping)
    watcher.dispose()
  })
})

describe('外观、标题、焦点与生命周期', () => {
  it('应用外观偏好、图标、对话框语义与源→目标标题', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhTW[k],
      appearance: () => ({ uiStyle: 'glass', theme: 'dark', language: 'zh-TW' }),
      iconUrl: 'chrome-extension://test/icon.png',
      sourceLanguage: () => 'ja',
      targetLanguage: () => 'ko',
    })
    focusEditable(input)
    trustedInput(input, 'こんにちは')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    const host = document.querySelector<HTMLElement>('[data-wt-root]')!
    expect(host.dataset.style).toBe('glass')
    expect(host.dataset.theme).toBe('dark')
    expect(host.lang).toBe('zh-TW')
    expect(host.style.getPropertyValue('color-scheme')).toBe('dark')
    expect(host.style.getPropertyPriority('color-scheme')).toBe('important')

    const shadow = popoverShadow()!
    const popover = shadow.querySelector('.popover')!
    expect(popover.getAttribute('role')).toBe('dialog')
    expect(popover.getAttribute('aria-modal')).toBe('false')
    expect(popover.getAttribute('aria-labelledby')).toBe('wt-input-title')

    const logo = shadow.querySelector<HTMLImageElement>('.input-logo')!
    expect(logo).not.toBeNull()
    expect(logo.getAttribute('src')).toBe('chrome-extension://test/icon.png')
    expect(logo.getAttribute('alt')).toBe('')

    expect(shadow.querySelector('#wt-input-title')!.textContent).toBe(`${zhTW.wtInputTranslation} · 日本語 → 한국어`)
    watcher.dispose()
  })

  it('普通输入完成后仅显示还原状态，不显示旧手动提示', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    focusEditable(input)
    trustedInput(input, '手动提示草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    const hint = popoverShadow()?.querySelector('.auto-hint')
    expect(hint).toBeNull()
    expect(input.value).toBe('EN:手动提示草稿')
    expect(popoverShadow()?.querySelector('[role="status"]')?.textContent).toBe(zhCN.wtInputRestoreHint)
    watcher.dispose()
  })

  it('自动替换后不显示旧预览倒计时，也不延迟结果', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
      replaceMode: () => 'auto',
      autoReplaceDelayMs: () => 1000,
    })
    focusEditable(input)
    trustedInput(input, '自动替换草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    const hint = popoverShadow()?.querySelector('.auto-hint')
    expect(hint).toBeNull()
    expect(input.value).toBe('EN:自动替换草稿')
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.resolve()
    expect(input.value).toBe('EN:自动替换草稿')
    watcher.dispose()
  })

  it('浮层持有焦点时关闭归还输入框，焦点不在浮层时不强制聚焦', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    focusEditable(input)
    const focusSpy = vi.spyOn(input, 'focus')
    trustedInput(input, '焦点返回草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(isPopoverOpen()).toBe(true)
    const host = document.querySelector<HTMLElement>('[data-wt-root]')!
    const closeBtn = popoverShadow()!.querySelector<HTMLButtonElement>('button[data-action="close"]')!
    closeBtn.focus()
    expect(document.activeElement).toBe(host)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true })
    Object.defineProperty(esc, 'isTrusted', { value: true, configurable: true })
    closeBtn.dispatchEvent(esc)
    expect(isPopoverOpen()).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(focusSpy).toHaveBeenCalled()

    focusSpy.mockClear()
    trustedInput(input, '再次焦点草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(isPopoverOpen()).toBe(true)
    expect(document.activeElement).toBe(input)
    const closeBtn2 = popoverShadow()!.querySelector<HTMLButtonElement>('button[data-action="close"]')!
    focusSpy.mockClear()
    trustedClick(closeBtn2)
    expect(isPopoverOpen()).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(focusSpy).not.toHaveBeenCalled()
    watcher.dispose()
  })

  it('旧失败提示的延迟复制完成不会在新提示显示已复制', async () => {
    const input = document.createElement('input')
    document.body.append(input)
    let resolveCopy: ((value: boolean) => void) | undefined
    const copyGate = new Promise<boolean>((resolve) => {
      resolveCopy = resolve
    })
    vi.mocked(clipboard.copySelectionText).mockImplementationOnce(() => copyGate)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:\n${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k] })
    focusEditable(input)
    trustedInput(input, '第一段草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    const copyBtn = popoverShadow()!.querySelector<HTMLButtonElement>('button[data-action="copy"]')!
    expect(copyBtn.textContent).toBe(zhCN.wtToolbarCopy)
    trustedClick(copyBtn)
    trustedInput(input, '第二段全新草稿')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    resolveCopy?.(true)
    await Promise.resolve()
    await Promise.resolve()
    const copyBtn2 = popoverShadow()!.querySelector<HTMLButtonElement>('button[data-action="copy"]')!
    expect(copyBtn2.textContent).toBe(zhCN.wtToolbarCopy)
    watcher.dispose()
  })

  it('页面隐藏取消防抖与在途请求，迟到结果不渲染', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    let resolveTranslate: ((value: { ok: true; texts: string[] }) => void) | undefined
    const translate = vi.fn(
      (_texts: string[]) =>
        new Promise<{ ok: true; texts: string[] }>((resolve) => {
          resolveTranslate = resolve
        }),
    )
    const cancel = vi.fn()
    const watcher = createInputTranslation({ translate, cancel, t: (k) => zhCN[k] })
    const setHidden = (value: boolean): void => {
      Object.defineProperty(document, 'hidden', { value, configurable: true })
    }
    try {
      focusEditable(input)
      trustedInput(input, '隐藏防抖草稿')
      setHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.resolve()
      expect(translate).not.toHaveBeenCalled()

      setHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
      trustedInput(input, '在途隐藏草稿')
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
      expect(translate).toHaveBeenCalledTimes(1)
      setHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(cancel).toHaveBeenCalledTimes(1)
      resolveTranslate?.({ ok: true, texts: ['EN:在途隐藏草稿'] })
      await Promise.resolve()
      await Promise.resolve()
      setHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(isPopoverOpen()).toBe(false)
    } finally {
      setHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
      watcher.dispose()
    }
  })

  it('隐藏页面取消已排队的自动替换，恢复可见后也不覆盖草稿', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    const translate = vi.fn(async (texts: string[]) => ({ ok: true as const, texts: [`EN:${texts[0]}`] }))
    const watcher = createInputTranslation({ translate, cancel: () => undefined, t: (k) => zhCN[k], replaceMode: () => 'auto', autoReplaceDelayMs: () => 1000 })
    const hidden = (value: boolean): void => { Object.defineProperty(document, 'hidden', { value, configurable: true }) }
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    try {
      focusEditable(input)
      trustedInput(input, '待替换草稿')
      await vi.advanceTimersByTimeAsync(600)
      await Promise.resolve()
      expect(translate).not.toHaveBeenCalled()
      expect(input.value).toBe('待替换草稿')
      hidden(true)
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(isPopoverOpen()).toBe(false)
      hidden(false)
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(input.value).toBe('待替换草稿')
      expect(translate).not.toHaveBeenCalled()
      expect(isPopoverOpen()).toBe(false)
    } finally {
      hidden(false)
      visibility.mockRestore()
      watcher.dispose()
    }
  })
})
