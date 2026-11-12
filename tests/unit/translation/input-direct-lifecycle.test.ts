import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInputTranslation } from '../../../src/translation/input-translation'
import { createDocumentInputTranslation } from '../../../src/translation/document-input'
import type { DocumentEditorRequest, DocumentEditorResult } from '../../../src/translation/document-editor'
import { getCapturedShadowRoot, installShadowRootCapture } from '../shared/shadow-roots'

let releaseShadow: () => void
const watchers: Array<{ dispose(): void }> = []

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  releaseShadow = installShadowRootCapture()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, width: 200, height: 50, top: 10, bottom: 60, left: 10, right: 210, toJSON: () => ({}) })
})

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.dispose()
  releaseShadow()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function trusted(target: EventTarget, event: Event): void {
  Object.defineProperty(event, 'isTrusted', { value: true })
  target.dispatchEvent(event)
}

function panel(): ShadowRoot | undefined {
  return getCapturedShadowRoot(document.querySelector('[data-wt-root]'))
}

function click(action: string): void {
  const button = panel()?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
  expect(button).toBeTruthy()
  trusted(button!, new MouseEvent('click', { bubbles: true, composed: true }))
}

function fixture(kind: 'plain' | 'document') {
  const root = document.createElement('div')
  const field = kind === 'plain' ? document.createElement('textarea') : document.createElement('div')
  if (field instanceof HTMLTextAreaElement) root.append(field)
  else {
    root.className = 'cm-editor'
    field.className = 'cm-content'
    field.contentEditable = 'true'
    field.tabIndex = 0
    root.append(field)
  }
  const other = document.createElement('input')
  document.body.append(root, other)
  field.focus()
  let model = ''
  let held: ((value: { ok: true; texts: string[] }) => void) | undefined
  let hold = false
  let output = 'Translated draft'
  const translate = vi.fn(async (_texts: string[], _request: string) => {
    if (hold) return await new Promise<{ ok: true; texts: string[] }>(resolve => { held = resolve })
    return { ok: true as const, texts: [output] }
  })
  const cancel = vi.fn()
  const editor = vi.fn(async (request: DocumentEditorRequest): Promise<DocumentEditorResult> => {
    if (request.action === 'read') return { status: 'ok', text: model, canReplace: true }
    if (request.expectedText !== model) return { status: 'changed' }
    model = request.text ?? ''
    field.textContent = model
    return { status: 'ok', text: model, canReplace: true }
  })
  const watcher = kind === 'plain'
    ? createInputTranslation({ translate, cancel, t: key => key, autoReplaceDelayMs: () => 700 })
    : createDocumentInputTranslation({ translate, cancel, t: key => key, enabled: () => true, editor, autoReplaceDelayMs: () => 700 })
  watchers.push(watcher)
  const read = () => field instanceof HTMLTextAreaElement ? field.value : model
  const set = (value: string) => {
    model = value
    if (field instanceof HTMLTextAreaElement) field.value = value
    else field.textContent = value
  }
  const type = (value: string, inputType = 'insertText') => {
    set(value)
    trusted(field, new InputEvent('input', { bubbles: true, composed: true, inputType }))
  }
  return { field, root, other, translate, cancel, editor, read, set, type,
    output: (text: string) => { output = text },
    hold: () => { hold = true }, release: () => held?.({ ok: true, texts: ['Late translation'] }) }
}

describe.each(['plain', 'document'] as const)('automatic direct input lifecycle: %s', kind => {
  it.each(['', 'Already English', '1 2 3'])('ignores non-candidate drafts without a visible error: %j', async value => {
    const f = fixture(kind)
    f.type(value)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.translate).not.toHaveBeenCalled()
    const host = document.querySelector<HTMLElement>('[data-wt-root]')
    expect(host === null || host.style.display === 'none').toBe(true)
    expect(f.read()).toBe(value)
  })
  it.each(['', '   '])('ends loading without replacing when the model returns an empty translation: %j', async output => {
    const f = fixture(kind)
    f.output(output)
    f.type('不能清空的中文')
    await vi.advanceTimersByTimeAsync(700)
    expect(f.read()).toBe('不能清空的中文')
    expect(panel()?.querySelector('.popover')?.getAttribute('aria-busy')).toBe('false')
    expect(panel()?.querySelector('[role="status"]')?.classList.contains('is-error')).toBe(true)
  })
  it('waits for the configured idle interval, writes once, restores exact text without requesting translation', async () => {
    const f = fixture(kind)
    f.type('先输入中文')
    await vi.advanceTimersByTimeAsync(500)
    expect(f.translate).not.toHaveBeenCalled()
    f.type('  最终中文\n第二行  ')
    await vi.advanceTimersByTimeAsync(699)
    expect(f.translate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.translate).toHaveBeenCalledTimes(1)
    expect(f.read()).toBe('Translated draft')
    expect(document.activeElement).toBe(f.field)
    expect(panel()?.querySelector('[role="status"]')?.textContent).toBe('wtInputRestoreHint')
    const replace = panel()?.querySelector<HTMLButtonElement>('[data-action="replace"]')
    expect(replace === null || replace === undefined || replace.style.display === 'none').toBe(true)
    click('restore')
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.read()).toBe('  最终中文\n第二行  ')
    expect(f.translate).toHaveBeenCalledTimes(1)
    expect(panel()?.querySelector('[role="status"]')?.textContent).toBe('')
  })

  it.each(['edit', 'target', 'blur', 'close'] as const)('rejects a late response after %s', async action => {
    const f = fixture(kind)
    f.hold()
    f.type('等待处理的中文')
    await vi.advanceTimersByTimeAsync(700)
    expect(f.translate).toHaveBeenCalledTimes(1)
    if (action === 'edit') f.type('继续输入后的中文')
    if (action === 'target') {
      f.other.focus()
      trusted(f.other, new FocusEvent('focusin', { bubbles: true, composed: true }))
    }
    if (action === 'blur') window.dispatchEvent(new Event('blur'))
    if (action === 'close') click('close')
    f.release()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.read()).toBe(action === 'edit' ? '继续输入后的中文' : '等待处理的中文')
    expect(f.cancel).toHaveBeenCalledTimes(1)
    if (action === 'target') expect(document.activeElement).toBe(f.other)
  })

  it('invalidates the previous restore record when trusted editing returns to the same inserted text', async () => {
    const f = fixture(kind)
    f.type('编辑前的中文')
    await vi.advanceTimersByTimeAsync(700)
    const oldRestore = panel()?.querySelector<HTMLButtonElement>('[data-action="restore"]')
    expect(oldRestore).toBeTruthy()
    f.type('Translated draft')
    trusted(oldRestore!, new MouseEvent('click', { bubbles: true, composed: true }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.read()).toBe('Translated draft')
    expect(f.translate).toHaveBeenCalledTimes(1)
  })

  it('does not translate native undo back into the translated value', async () => {
    const f = fixture(kind)
    f.type('撤销前中文')
    await vi.advanceTimersByTimeAsync(700)
    f.type('撤销前中文', 'historyUndo')
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.read()).toBe('撤销前中文')
    expect(f.translate).toHaveBeenCalledTimes(1)
  })

  it('holds composition until the same editor receives compositionend', async () => {
    const f = fixture(kind)
    trusted(f.field, new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
    f.set('合成中的中文')
    trusted(f.field, new InputEvent('input', { bubbles: true, composed: true, isComposing: true }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.translate).not.toHaveBeenCalled()
    if (kind === 'document') {
      trusted(f.other, new CompositionEvent('compositionend', { bubbles: true, composed: true }))
      await vi.advanceTimersByTimeAsync(800)
      expect(f.translate).not.toHaveBeenCalled()
    }
    trusted(f.field, new CompositionEvent('compositionend', { bubbles: true, composed: true }))
    await vi.advanceTimersByTimeAsync(700)
    expect(f.read()).toBe('Translated draft')
    expect(f.translate).toHaveBeenCalledTimes(1)
  })
})

it('does not retranslate a managed editor undo when the editor consumes beforeinput', async () => {
  const happy = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM
  happy.setURL('https://discord.com/channels/@me/fixture')
  try {
    const field = document.createElement('div')
    field.contentEditable = 'true'
    field.setAttribute('data-slate-editor', 'true')
    field.setAttribute('role', 'textbox')
    field.innerHTML = '<div data-slate-node="element"><span data-slate-string="true">原始中文草稿</span></div>'
    document.body.append(field)
    field.focus()
    const textNode = field.querySelector('[data-slate-string]')!
    const translate = vi.fn(async () => ({ ok: true as const, texts: ['Translated draft'] }))
    watchers.push(createInputTranslation({
      translate, cancel: vi.fn(), t: key => key, autoReplaceDelayMs: () => 700,
      replaceDiscordInput: async request => { textNode.textContent = request.text; return 'ok' },
    }))
    trusted(field, new InputEvent('input', { bubbles: true, composed: true }))
    await vi.advanceTimersByTimeAsync(700)
    expect(textNode.textContent).toBe('Translated draft')
    trusted(field, new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'historyUndo' }))
    textNode.textContent = '原始中文草稿'
    await vi.advanceTimersByTimeAsync(1500)
    expect(textNode.textContent).toBe('原始中文草稿')
    expect(translate).toHaveBeenCalledTimes(1)
  } finally { happy.setURL('about:blank') }
})

it('does not refocus or restore a managed draft after it blurs during the bridge reply', async () => {
  const happy = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM
  happy.setURL('https://discord.com/channels/@me/fixture')
  try {
    const field = document.createElement('div')
    field.contentEditable = 'true'
    field.setAttribute('data-slate-editor', 'true')
    field.setAttribute('role', 'textbox')
    field.innerHTML = '<div data-slate-node="element"><span data-slate-string="true">原始中文草稿</span></div>'
    document.body.append(field)
    field.focus()
    const textNode = field.querySelector('[data-slate-string]')!
    let finish: ((value: 'ok') => void) | undefined
    const bridge = vi.fn(async (request: { text: string }) => {
      textNode.textContent = request.text
      return await new Promise<'ok'>(resolve => { finish = resolve })
    })
    watchers.push(createInputTranslation({
      translate: async () => ({ ok: true, texts: ['Translated draft'] }),
      cancel: vi.fn(), t: key => key, autoReplaceDelayMs: () => 700,
      replaceDiscordInput: bridge,
    }))
    trusted(field, new InputEvent('input', { bubbles: true, composed: true }))
    await vi.advanceTimersByTimeAsync(700)
    expect(bridge).toHaveBeenCalledTimes(1)
    field.blur()
    await Promise.resolve()
    finish?.('ok')
    await vi.advanceTimersByTimeAsync(100)
    expect(document.activeElement).not.toBe(field)
    expect(field.hasAttribute('data-wt-discord-input')).toBe(false)
    const host = document.querySelector<HTMLElement>('[data-wt-root]')
    expect(host === null || host.style.display === 'none').toBe(true)
    expect(textNode.textContent).toBe('Translated draft')
  } finally { happy.setURL('about:blank') }
})
