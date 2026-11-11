import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentInputTranslation } from '../../../src/translation/document-input'
import type { DocumentEditorRequest, DocumentEditorResult } from '../../../src/translation/document-editor'
import type { TranslationReply } from '../../../src/translation/messages'
import type { SourceLanguage, TargetLanguage } from '../../../src/translation/target-language'
import type { SurfacePreferences } from '../../../src/translation/ui-surface'
import { getCapturedShadowRoot, installShadowRootCapture } from '../shared/shadow-roots'

let restoreShadowCapture: (() => void) | undefined

function trustedClick(target: Element): void {
  const event = new MouseEvent('click', { bubbles: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function trustedInput(target: Element): void {
  const event = new InputEvent('input', { bubbles: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function trustedKeydown(target: EventTarget, init: KeyboardEventInit = {}, composing = false): void {
  const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  if (composing) Object.defineProperty(event, 'isComposing', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function trustedEvent(target: EventTarget, type: string): void {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function trustedFocusIn(target: Element): void {
  const event = new FocusEvent('focusin', { bubbles: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true, configurable: true })
  target.dispatchEvent(event)
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function popoverShadow(): ShadowRoot | undefined {
  return getCapturedShadowRoot(document.querySelector('[data-wt-root]'))
}

function isPopoverOpen(): boolean {
  const host = document.querySelector<HTMLElement>('[data-wt-root]')
  return host !== null && host.style.display !== 'none'
}

function requireButton(action: string): HTMLButtonElement {
  const button = popoverShadow()?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
  if (button === null || button === undefined) throw new Error(`missing ${action}`)
  return button
}

function statusText(): string {
  return popoverShadow()?.querySelector('[role="status"]')?.textContent ?? ''
}

interface Harness {
  watcher: ReturnType<typeof createDocumentInputTranslation>
  editorCalls: DocumentEditorRequest[]
  translateCalls: string[][]
  cancelCalls: string[]
  setRead: (result: DocumentEditorResult | (() => DocumentEditorResult | Promise<DocumentEditorResult>)) => void
  setReplace: (result: DocumentEditorResult) => void
  setTranslate: (reply: TranslationReply<'wt:translate'> | (() => TranslationReply<'wt:translate'>)) => void
}

function setup(
  options: {
    enabled?: boolean
    root?: HTMLElement
    appearance?: () => SurfacePreferences
    iconUrl?: string
    sourceLanguage?: () => SourceLanguage
    targetLanguage?: () => TargetLanguage
  } = {},
): Harness {
  const editorCalls: DocumentEditorRequest[] = []
  const translateCalls: string[][] = []
  const cancelCalls: string[] = []
  let readResult: DocumentEditorResult | (() => DocumentEditorResult | Promise<DocumentEditorResult>) = {
    status: 'ok',
    text: '源文本',
    canReplace: true,
  }
  let replaceResult: DocumentEditorResult = { status: 'ok', text: '译文', canReplace: true }
  let translateReply: TranslationReply<'wt:translate'> | (() => TranslationReply<'wt:translate'>) = {
    ok: true,
    texts: ['译文'],
  }
  const watcher = createDocumentInputTranslation({
    enabled: () => options.enabled !== false,
    translate: async (texts) => {
      translateCalls.push([...texts])
      return typeof translateReply === 'function' ? translateReply() : translateReply
    },
    cancel: (id) => {
      cancelCalls.push(id)
    },
    editor: async (request) => {
      editorCalls.push(request)
      if (request.action !== 'read') return replaceResult
      return typeof readResult === 'function' ? readResult() : readResult
    },
    t: (key) => key,
    ...(options.appearance !== undefined ? { appearance: options.appearance } : {}),
    ...(options.iconUrl !== undefined ? { iconUrl: options.iconUrl } : {}),
    ...(options.sourceLanguage !== undefined ? { sourceLanguage: options.sourceLanguage } : {}),
    ...(options.targetLanguage !== undefined ? { targetLanguage: options.targetLanguage } : {}),
  })
  activeWatchers.push(watcher)
  return {
    watcher,
    editorCalls,
    translateCalls,
    cancelCalls,
    setRead: (result) => { readResult = result },
    setReplace: (result) => { replaceResult = result },
    setTranslate: (reply) => { translateReply = reply },
  }
}

function makeEditorRoot(): { root: HTMLElement; editable: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'cm-editor'
  const editable = document.createElement('div')
  editable.className = 'cm-content'
  editable.contentEditable = 'true'
  editable.tabIndex = 0
  root.append(editable)
  document.body.append(root)
  editable.focus()
  return { root, editable }
}

const activeWatchers: Array<{ dispose(): void }> = []

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.querySelectorAll('[data-wt-root]').forEach((node) => node.remove())
  restoreShadowCapture = installShadowRootCapture()
})

afterEach(() => {
  while (activeWatchers.length > 0) activeWatchers.pop()?.dispose()
  restoreShadowCapture?.()
  restoreShadowCapture = undefined
  vi.restoreAllMocks()
})

describe('createDocumentInputTranslation', () => {
  it('译文换行归一化后写回，还原仍匹配实际写入内容', async () => {
    makeEditorRoot()
    const { watcher, editorCalls, setTranslate, setReplace } = setup()
    setTranslate({ ok: true, texts: ['First\r\nSecond\rThird'] })
    setReplace({ status: 'ok', text: 'First\nSecond\nThird', canReplace: true })
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    expect(editorCalls.filter((call) => call.action === 'replace')[0]).toMatchObject({
      expectedText: '源文本', text: 'First\nSecond\nThird',
    })
    setReplace({ status: 'ok', text: '源文本', canReplace: true })
    trustedClick(requireButton('restore'))
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(editorCalls.filter((call) => call.action === 'replace')[1]).toMatchObject({
      expectedText: 'First\nSecond\nThird', text: '源文本',
    })
  })

  it('没有候选编辑器或桥接不支持时返回 false', async () => {
    const plain = document.createElement('div')
    document.body.append(plain)
    plain.focus()
    const { watcher } = setup()
    await expect(watcher.translate()).resolves.toBe(false)
    watcher.dispose()

    const { editable } = makeEditorRoot()
    const unsupported = setup()
    unsupported.setRead({ status: 'unsupported' })
    await expect(unsupported.watcher.translate()).resolves.toBe(false)
    expect(isPopoverOpen()).toBe(false)
    unsupported.watcher.dispose()
    void editable
  })

  it('enabled 为 false 时不响应', async () => {
    makeEditorRoot()
    const { watcher, editorCalls } = setup({ enabled: false })
    await expect(watcher.translate()).resolves.toBe(false)
    expect(editorCalls).toHaveLength(0)
    watcher.dispose()
  })

  it('读模型→翻译→预览；Replace 回写后可还原原文并释放令牌', async () => {
    const { root } = makeEditorRoot()
    const { watcher, editorCalls, translateCalls, setReplace } = setup()
    await expect(watcher.translate()).resolves.toBe(true)
    expect(translateCalls).toEqual([['源文本']])
    expect(statusText()).toBe('译文')
    const readCall = editorCalls.find((call) => call.action === 'read')
    expect(readCall?.elementId).toMatch(/^[a-f0-9-]{36}$/)
    expect(document.querySelector(`[data-wt-document-input="${readCall?.elementId}"]`)).not.toBeNull()
    const panel = popoverShadow()?.querySelector('.popover')
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-modal')).toBe('false')
    expect(panel?.getAttribute('aria-labelledby')).toBe('wt-document-input-title')
    expect(popoverShadow()?.getElementById('wt-document-input-title')?.textContent).toBe('wtInputTranslation · wtSourceAuto → English')
    expect(requireButton('replace').style.display).toBe('')
    expect(requireButton('restore').style.display).toBe('none')
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    expect(requireButton('replace').style.display).toBe('none')
    expect(isPopoverOpen()).toBe(true)
    expect(root.getAttribute('data-wt-document-input')).not.toBeNull()
    const writes = editorCalls.filter((call) => call.action === 'replace')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.expectedText).toBe('源文本')
    expect(writes[0]?.text).toBe('译文')

    setReplace({ status: 'ok', text: '源文本', canReplace: true })
    trustedClick(requireButton('restore'))
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    const afterRestore = editorCalls.filter((call) => call.action === 'replace')
    expect(afterRestore).toHaveLength(2)
    expect(afterRestore[1]?.expectedText).toBe('译文')
    expect(afterRestore[1]?.text).toBe('源文本')
    expect(translateCalls).toEqual([['源文本']])
    expect(root.getAttribute('data-wt-document-input')).toBeNull()
    watcher.dispose()
  })

  it('还原使用桥接返回的实际写入文本作为 expectedText', async () => {
    makeEditorRoot()
    const { watcher, editorCalls, setReplace } = setup()
    await watcher.translate()
    setReplace({ status: 'ok', text: 'normalized', canReplace: true })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    setReplace({ status: 'ok', text: '源文本', canReplace: true })
    trustedClick(requireButton('restore'))
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    const writes = editorCalls.filter((call) => call.action === 'replace')
    expect(writes).toHaveLength(2)
    expect(writes[1]?.expectedText).toBe('normalized')
    expect(writes[1]?.text).toBe('源文本')
    watcher.dispose()
  })

  it('替换成功后可信输入关闭会话；旧还原按钮不再触发桥接调用', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls } = setup()
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    const writesBefore = editorCalls.filter((call) => call.action === 'replace').length
    trustedInput(editable)
    expect(isPopoverOpen()).toBe(false)
    const staleRestore = requireButton('restore')
    trustedClick(staleRestore)
    await Promise.resolve()
    await Promise.resolve()
    expect(editorCalls.filter((call) => call.action === 'replace')).toHaveLength(writesBefore)
    watcher.dispose()
  })

  it('还原挂起期间可信输入到达，迟到的 ok/failed 都被忽略', async () => {
    for (const late of [
      { status: 'ok', text: '译文', canReplace: true },
      { status: 'failed' },
    ] as DocumentEditorResult[]) {
      const { editable } = makeEditorRoot()
      let resolveWrite: ((value: DocumentEditorResult) => void) | undefined
      let writeCount = 0
      const watcher = createDocumentInputTranslation({
        enabled: () => true,
        translate: async () => ({ ok: true, texts: ['译文'] }),
        cancel: () => undefined,
        editor: (request) => {
          if (request.action === 'read') {
            return Promise.resolve({ status: 'ok', text: '源文本', canReplace: true })
          }
          writeCount += 1
          if (writeCount === 1) return Promise.resolve({ status: 'ok', text: '译文', canReplace: true })
          return new Promise<DocumentEditorResult>((resolve) => {
            resolveWrite = resolve
          })
        },
        t: (key) => key,
      })
      activeWatchers.push(watcher)
      await watcher.translate()
      trustedClick(requireButton('replace'))
      await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
      trustedClick(requireButton('restore'))
      await vi.waitFor(() => expect(writeCount).toBe(2))
      trustedInput(editable)
      expect(isPopoverOpen()).toBe(false)
      resolveWrite?.(late)
      await Promise.resolve()
      await Promise.resolve()
      expect(isPopoverOpen()).toBe(false)
      watcher.dispose()
    }
  })

  it('还原时桥接报 changed：解除写入控件、保留复制原文且不误关', async () => {
    makeEditorRoot()
    const { watcher, setReplace } = setup()
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    setReplace({ status: 'changed' })
    trustedClick(requireButton('restore'))
    await vi.waitFor(() => expect(statusText()).toBe('wtInputTextChanged'))
    expect(requireButton('replace').style.display).toBe('none')
    expect(requireButton('restore').style.display).toBe('none')
    expect(requireButton('copy-original').style.display).toBe('')
    expect(isPopoverOpen()).toBe(true)
    watcher.dispose()
  })

  it('还原前 enabled 变为 false 直接关闭会话不写入', async () => {
    makeEditorRoot()
    let enabled = true
    const replaceCalls: DocumentEditorRequest[] = []
    const watcher = createDocumentInputTranslation({
      enabled: () => enabled,
      translate: async () => ({ ok: true, texts: ['译文'] }),
      cancel: () => undefined,
      editor: async (request) => {
        if (request.action === 'replace') replaceCalls.push(request)
        return request.action === 'read'
          ? { status: 'ok', text: '源文本', canReplace: true }
          : { status: 'ok', text: '译文', canReplace: true }
      },
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    enabled = false
    trustedClick(requireButton('restore'))
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(replaceCalls).toHaveLength(1)
    watcher.dispose()
  })

  it('还原时编辑器根节点已断开：不写入并提示内容变化', async () => {
    const { root } = makeEditorRoot()
    const { watcher, editorCalls } = setup()
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    root.remove()
    const writesBefore = editorCalls.filter((call) => call.action === 'replace').length
    trustedClick(requireButton('restore'))
    await vi.waitFor(() => expect(statusText()).toBe('wtInputTextChanged'))
    expect(editorCalls.filter((call) => call.action === 'replace')).toHaveLength(writesBefore)
    watcher.dispose()
  })

  it('canReplace=false 时不显示 Replace 并给出提示', async () => {
    makeEditorRoot()
    const { watcher, setRead } = setup()
    setRead({ status: 'ok', text: '源文本', canReplace: false })
    await watcher.translate()
    expect(requireButton('replace').style.display).toBe('none')
    expect(popoverShadow()?.textContent).toContain('wtInputEditorUnsupported')
    watcher.dispose()
  })

  it('翻译失败显示错误且仍接管会话', async () => {
    makeEditorRoot()
    const { watcher, setTranslate } = setup()
    setTranslate({ ok: false, error: '模型不可用' })
    await expect(watcher.translate()).resolves.toBe(true)
    expect(statusText()).toBe('模型不可用')
    watcher.dispose()
  })

  it('替换返回 changed/failed 时显示对应错误且保留原文', async () => {
    makeEditorRoot()
    const { watcher, setReplace } = setup()
    await watcher.translate()
    setReplace({ status: 'changed' })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(statusText()).toBe('wtInputTextChanged'))
    await watcher.translate()
    setReplace({ status: 'failed' })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(statusText()).toBe('wtInputReplacePartial'))
    watcher.dispose()
  })

  it('预览期间可信输入使会话失效并关闭浮层', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, cancelCalls } = setup()
    await watcher.translate()
    expect(isPopoverOpen()).toBe(true)
    trustedInput(editable)
    expect(isPopoverOpen()).toBe(false)
    // 翻译已完成，无在途请求可取消；再次触发输入不应残留会话
    expect(cancelCalls).toEqual([])
    watcher.dispose()
  })

  it('dispose 清理宿主与令牌', async () => {
    const { root } = makeEditorRoot()
    const { watcher, editorCalls } = setup()
    await watcher.translate()
    const token = editorCalls[0]?.elementId
    watcher.dispose()
    expect(document.querySelector('[data-wt-root]')).toBeNull()
    expect(root.getAttribute('data-wt-document-input')).toBeNull()
    void token
  })

  it('翻译请求 reject 时显示可读错误且返回 true', async () => {
    makeEditorRoot()
    const watcher = createDocumentInputTranslation({
      enabled: () => true,
      translate: async () => {
        throw new Error('channel closed')
      },
      cancel: () => undefined,
      editor: async (request) =>
        request.action === 'read' ? { status: 'ok', text: '源文本', canReplace: true } : { status: 'ok', text: '', canReplace: true },
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    await expect(watcher.translate()).resolves.toBe(true)
    expect(statusText()).toBe('wtInputReplaceFailed')
    watcher.dispose()
  })

  it('读完成后 enabled 变为 false 不发起模型调用', async () => {
    makeEditorRoot()
    let enabled = true
    let resolveRead: (value: DocumentEditorResult) => void = () => undefined
    const translateCalls: string[][] = []
    const watcher = createDocumentInputTranslation({
      enabled: () => enabled,
      translate: async (texts) => {
        translateCalls.push([...texts])
        return { ok: true, texts: ['译文'] }
      },
      cancel: () => undefined,
      editor: (request) =>
        request.action === 'read'
          ? new Promise<DocumentEditorResult>((resolve) => {
              resolveRead = resolve
            })
          : Promise.resolve({ status: 'ok', text: '', canReplace: true }),
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    const pending = watcher.translate()
    await Promise.resolve()
    enabled = false
    resolveRead({ status: 'ok', text: '源文本', canReplace: true })
    await expect(pending).resolves.toBe(true)
    expect(translateCalls).toEqual([])
    expect(isPopoverOpen()).toBe(false)
    watcher.dispose()
  })

  it('翻译返回后 enabled 变为 false 不展示结果', async () => {
    makeEditorRoot()
    let enabled = true
    let resolveTranslate: (value: TranslationReply<'wt:translate'>) => void = () => undefined
    const watcher = createDocumentInputTranslation({
      enabled: () => enabled,
      translate: () =>
        new Promise<TranslationReply<'wt:translate'>>((resolve) => {
          resolveTranslate = resolve
        }),
      cancel: () => undefined,
      editor: async (request) =>
        request.action === 'read'
          ? { status: 'ok', text: '源文本', canReplace: true }
          : { status: 'ok', text: '', canReplace: true },
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    const pending = watcher.translate()
    await vi.waitFor(() => expect(statusText()).toBe('wtPanelLoading'))
    enabled = false
    resolveTranslate({ ok: true, texts: ['译文'] })
    await expect(pending).resolves.toBe(true)
    expect(isPopoverOpen()).toBe(false)
    watcher.dispose()
  })

  it('替换挂起期间可信输入到达，迟到的 ok/failed 都被忽略', async () => {
    const { editable } = makeEditorRoot()
    let resolveReplace: (value: DocumentEditorResult) => void = () => undefined
    const watcher = createDocumentInputTranslation({
      enabled: () => true,
      translate: async () => ({ ok: true, texts: ['译文'] }),
      cancel: () => undefined,
      editor: (request) => {
        if (request.action === 'read') {
          return Promise.resolve({ status: 'ok', text: '源文本', canReplace: true })
        }
        return new Promise<DocumentEditorResult>((resolve) => {
          resolveReplace = resolve
        })
      },
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('replace').disabled).toBe(true))
    expect(popoverShadow()?.querySelector('.popover')?.getAttribute('aria-busy')).toBe('true')
    trustedInput(editable)
    expect(isPopoverOpen()).toBe(false)
    resolveReplace({ status: 'ok', text: '译文', canReplace: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(isPopoverOpen()).toBe(false)
    watcher.dispose()
  })

  it('预览后 enabled 变为 false 点击 Replace 不发起写入', async () => {
    makeEditorRoot()
    let enabled = true
    const replaceCalls: DocumentEditorRequest[] = []
    const watcher = createDocumentInputTranslation({
      enabled: () => enabled,
      translate: async () => ({ ok: true, texts: ['译文'] }),
      cancel: () => undefined,
      editor: async (request) => {
        if (request.action === 'replace') replaceCalls.push(request)
        return request.action === 'read'
          ? { status: 'ok', text: '源文本', canReplace: true }
          : { status: 'ok', text: '译文', canReplace: true }
      },
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    await watcher.translate()
    enabled = false
    trustedClick(requireButton('replace'))
    await Promise.resolve()
    await Promise.resolve()
    expect(replaceCalls).toHaveLength(0)
    expect(isPopoverOpen()).toBe(false)
    watcher.dispose()
  })

  it('Escape 在面板内关闭会话并把焦点还给编辑器', async () => {
    const { root, editable } = makeEditorRoot()
    const { watcher, editorCalls } = setup()
    await watcher.translate()
    const closeButton = popoverShadow()?.querySelector<HTMLButtonElement>('button[data-action="close"]')
    expect(closeButton).toBeDefined()
    closeButton!.focus()
    trustedKeydown(closeButton!, { key: 'Escape' })
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(document.activeElement).toBe(editable)
    expect(root.getAttribute('data-wt-document-input')).toBeNull()
    void editorCalls
    watcher.dispose()
  })

  it('可信关闭按钮点击同样还原焦点到编辑器', async () => {
    const { editable } = makeEditorRoot()
    const { watcher } = setup()
    await watcher.translate()
    const closeButton = popoverShadow()?.querySelector<HTMLButtonElement>('button[data-action="close"]')
    expect(closeButton).toBeDefined()
    closeButton!.focus()
    trustedClick(closeButton!)
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(document.activeElement).toBe(editable)
    watcher.dispose()
  })

  it('焦点移出面板或窗口失焦使会话失效时不重夺焦点', async () => {
    const { editable } = makeEditorRoot()
    const outside = document.createElement('button')
    document.body.append(outside)
    const { watcher } = setup()
    await watcher.translate()
    expect(isPopoverOpen()).toBe(true)

    outside.focus()
    trustedFocusIn(outside)
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(document.activeElement).toBe(outside)

    editable.focus()
    await watcher.translate()
    expect(isPopoverOpen()).toBe(true)
    outside.focus()
    window.dispatchEvent(new Event('blur'))
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(document.activeElement).toBe(outside)
    watcher.dispose()
  })

  it('Escape 忽略未信任事件、输入法合成与修饰键', async () => {
    makeEditorRoot()
    const { watcher } = setup()
    await watcher.translate()
    expect(isPopoverOpen()).toBe(true)

    const untrusted = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })
    document.dispatchEvent(untrusted)
    expect(isPopoverOpen()).toBe(true)

    trustedKeydown(document, { key: 'Escape' }, true)
    expect(isPopoverOpen()).toBe(true)

    trustedKeydown(document, { key: 'Escape', ctrlKey: true })
    expect(isPopoverOpen()).toBe(true)

    trustedKeydown(document, { key: 'Escape' })
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    watcher.dispose()
  })

  it('页面隐藏取消在途读取并关闭会话，迟到结果不再出现', async () => {
    const { root } = makeEditorRoot()
    let resolveRead: ((value: DocumentEditorResult) => void) | undefined
    const cancelCalls: string[] = []
    const watcher = createDocumentInputTranslation({
      enabled: () => true,
      translate: async () => ({ ok: true, texts: ['译文'] }),
      cancel: (id) => {
        cancelCalls.push(id)
      },
      editor: (request) =>
        request.action === 'read'
          ? new Promise<DocumentEditorResult>((resolve) => {
              resolveRead = resolve
            })
          : Promise.resolve({ status: 'ok', text: '', canReplace: true }),
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    try {
      const pending = watcher.translate()
      await Promise.resolve()
      setDocumentHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(cancelCalls).toHaveLength(1)
      expect(isPopoverOpen()).toBe(false)
      expect(root.getAttribute('data-wt-document-input')).toBeNull()
      resolveRead?.({ status: 'ok', text: '源文本', canReplace: true })
      await expect(pending).resolves.toBe(true)
      expect(isPopoverOpen()).toBe(false)
    } finally {
      setDocumentHidden(false)
      watcher.dispose()
    }
  })

  it('页面隐藏取消在途翻译请求，迟到回复不再展示', async () => {
    makeEditorRoot()
    let resolveTranslate: ((value: TranslationReply<'wt:translate'>) => void) | undefined
    let translateStarted = false
    const cancelCalls: string[] = []
    const watcher = createDocumentInputTranslation({
      enabled: () => true,
      translate: () => {
        translateStarted = true
        return new Promise<TranslationReply<'wt:translate'>>((resolve) => {
          resolveTranslate = resolve
        })
      },
      cancel: (id) => {
        cancelCalls.push(id)
      },
      editor: async (request) =>
        request.action === 'read'
          ? { status: 'ok', text: '源文本', canReplace: true }
          : { status: 'ok', text: '', canReplace: true },
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    try {
      const pending = watcher.translate()
      await vi.waitFor(() => expect(translateStarted).toBe(true))
      setDocumentHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(cancelCalls).toHaveLength(1)
      expect(isPopoverOpen()).toBe(false)
      resolveTranslate?.({ ok: true, texts: ['译文'] })
      await expect(pending).resolves.toBe(true)
      expect(isPopoverOpen()).toBe(false)
    } finally {
      setDocumentHidden(false)
      watcher.dispose()
    }
  })

  it('复制在途时会话关闭，迟到的剪贴板结果不再反馈', async () => {
    const { editable } = makeEditorRoot()
    const { watcher } = setup()
    await watcher.translate()
    const copyButton = requireButton('copy')
    expect(copyButton.textContent).toBe('wtToolbarCopy')

    const pending = deferred<boolean>()
    const writeText = vi.fn(() => pending.promise)
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      trustedClick(copyButton)
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('译文'))
      trustedInput(editable)
      expect(isPopoverOpen()).toBe(false)
      pending.resolve(true)
      await Promise.resolve()
      await Promise.resolve()
      expect(copyButton.textContent).toBe('wtToolbarCopy')
    } finally {
      if (originalClipboard === undefined) {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard
      } else {
        Object.defineProperty(navigator, 'clipboard', originalClipboard)
      }
      watcher.dispose()
    }
  })

  it('加载期间窗口失焦会话完全失效并释放令牌', async () => {
    const { root } = makeEditorRoot()
    let resolveRead: (value: DocumentEditorResult) => void = () => undefined
    const watcher = createDocumentInputTranslation({
      enabled: () => true,
      translate: async () => ({ ok: true, texts: ['译文'] }),
      cancel: () => undefined,
      editor: (request) =>
        request.action === 'read'
          ? new Promise<DocumentEditorResult>((resolve) => {
              resolveRead = resolve
            })
          : Promise.resolve({ status: 'ok', text: '', canReplace: true }),
      t: (key) => key,
    })
    activeWatchers.push(watcher)
    const pending = watcher.translate()
    await Promise.resolve()
    window.dispatchEvent(new Event('blur'))
    resolveRead({ status: 'ok', text: '源文本', canReplace: true })
    await expect(pending).resolves.toBe(true)
    expect(isPopoverOpen()).toBe(false)
    expect(root.getAttribute('data-wt-document-input')).toBeNull()
    watcher.dispose()
  })

  it('应用外观偏好、图标、对话框语义与源→目标标题', async () => {
    makeEditorRoot()
    const { watcher } = setup({
      appearance: () => ({ uiStyle: 'glass', theme: 'dark', language: 'zh-TW' }),
      iconUrl: 'chrome-extension://test/icon.png',
      sourceLanguage: () => 'ja',
      targetLanguage: () => 'ko',
    })
    await watcher.translate()
    const host = document.querySelector<HTMLElement>('[data-wt-root]')!
    expect(host.dataset.style).toBe('glass')
    expect(host.dataset.theme).toBe('dark')
    expect(host.lang).toBe('zh-TW')
    expect(host.style.getPropertyValue('color-scheme')).toBe('dark')
    expect(host.style.getPropertyPriority('color-scheme')).toBe('important')

    const shadow = popoverShadow()!
    const panel = shadow.querySelector('.popover')!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('false')
    expect(panel.getAttribute('aria-labelledby')).toBe('wt-document-input-title')

    const logo = shadow.querySelector<HTMLImageElement>('.input-logo')!
    expect(logo).not.toBeNull()
    expect(logo.getAttribute('src')).toBe('chrome-extension://test/icon.png')
    expect(logo.getAttribute('alt')).toBe('')

    expect(shadow.getElementById('wt-document-input-title')?.textContent).toBe('wtInputTranslation · 日本語 → 한국어')
    watcher.dispose()
  })

  it('提示区分预览、已替换还原与不可替换', async () => {
    makeEditorRoot()
    const hint = (): string => popoverShadow()?.querySelector('.auto-hint')?.textContent ?? ''
    const { watcher, setReplace } = setup()
    await watcher.translate()
    expect(hint()).toBe('wtInputPreviewHint')
    setReplace({ status: 'ok', text: '译文', canReplace: true })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(hint()).toBe('wtInputRestoreHint'))
    watcher.dispose()

    makeEditorRoot()
    const unsupported = setup()
    unsupported.setRead({ status: 'ok', text: '源文本', canReplace: false })
    await unsupported.watcher.translate()
    expect(hint()).toBe('wtInputEditorUnsupported')
    unsupported.watcher.dispose()
  })

  it('旧预览的延迟复制完成不会在新预览显示已复制', async () => {
    const { editable } = makeEditorRoot()
    const { watcher } = setup()
    await watcher.translate()
    const copyButton = requireButton('copy')
    expect(copyButton.textContent).toBe('wtToolbarCopy')

    const pending = deferred<boolean>()
    const writeText = vi.fn(() => pending.promise)
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      trustedClick(copyButton)
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('译文'))
      trustedInput(editable)
      expect(isPopoverOpen()).toBe(false)
      await watcher.translate()
      expect(isPopoverOpen()).toBe(true)
      expect(copyButton.textContent).toBe('wtToolbarCopy')
      pending.resolve(true)
      await Promise.resolve()
      await Promise.resolve()
      expect(copyButton.textContent).toBe('wtToolbarCopy')
    } finally {
      if (originalClipboard === undefined) {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard
      } else {
        Object.defineProperty(navigator, 'clipboard', originalClipboard)
      }
      watcher.dispose()
    }
  })

  it('编辑器内的按键未派发 input 时复读内容：已变化则会话失效，旧替换不再可用', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead } = setup()
    await watcher.translate()
    expect(requireButton('replace').style.display).toBe('')
    setRead({ status: 'ok', text: '源文', canReplace: true })
    trustedKeydown(editable, { key: 'Backspace' })
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(editorCalls.filter((call) => call.action === 'read')).toHaveLength(2)
    expect(editorCalls.filter((call) => call.action === 'replace')).toHaveLength(0)
    watcher.dispose()
  })

  it('按键后内容未变则保留预览；修饰键、纯导航键与编辑器外的按键不触发复读', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls } = setup()
    const reads = (): number => editorCalls.filter((call) => call.action === 'read').length
    await watcher.translate()
    trustedKeydown(editable, { key: 'F8' })
    await vi.waitFor(() => expect(reads()).toBe(2))
    expect(isPopoverOpen()).toBe(true)
    expect(requireButton('replace').style.display).toBe('')
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) trustedKeydown(editable, { key })
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      trustedKeydown(editable, { key })
      trustedKeydown(editable, { key, shiftKey: true })
    }
    trustedKeydown(document.body, { key: 'Backspace' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(reads()).toBe(2)
    expect(isPopoverOpen()).toBe(true)
    trustedKeydown(editable, { key: 'ArrowUp', altKey: true })
    await vi.waitFor(() => expect(reads()).toBe(3))
    trustedKeydown(editable, { key: 'End', ctrlKey: true })
    await vi.waitFor(() => expect(reads()).toBe(4))
    watcher.dispose()
  })

  it.each(['paste', 'cut', 'drop'])('替换后的 %s 经复读发现内容变化，旧的还原记录失效且不写回', async (type) => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead } = setup()
    const reads = (): number => editorCalls.filter((call) => call.action === 'read').length
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    setRead({ status: 'ok', text: '译文', canReplace: true })
    trustedEvent(editable, type)
    await vi.waitFor(() => expect(reads()).toBe(2))
    expect(requireButton('restore').style.display).toBe('')
    setRead({ status: 'ok', text: '译文已改', canReplace: true })
    trustedEvent(editable, type)
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(editorCalls.filter((call) => call.action === 'replace')).toHaveLength(1)
    watcher.dispose()
  })

  it('复读失败：焦点已离开编辑器时不下结论，焦点仍在编辑器时会话失效', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead } = setup()
    const reads = (): number => editorCalls.filter((call) => call.action === 'read').length
    await watcher.translate()
    setRead({ status: 'unsupported' })
    editable.blur()
    trustedKeydown(editable, { key: 'Backspace' })
    await vi.waitFor(() => expect(reads()).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(isPopoverOpen()).toBe(true)
    editable.focus()
    trustedKeydown(editable, { key: 'Backspace' })
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(reads()).toBe(3)
    watcher.dispose()
  })

  it('复读在途时发生了写入：过期的复读结果被丢弃，不误伤刚建立的还原记录', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead } = setup()
    const reads = (): number => editorCalls.filter((call) => call.action === 'read').length
    await watcher.translate()
    const pending = deferred<DocumentEditorResult>()
    setRead(() => pending.promise)
    trustedKeydown(editable, { key: 'F8' })
    await vi.waitFor(() => expect(reads()).toBe(2))
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    pending.resolve({ status: 'ok', text: '译文', canReplace: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(isPopoverOpen()).toBe(true)
    expect(requireButton('restore').style.display).toBe('')
    watcher.dispose()
  })

  it('取得原文快照之前的按键在快照返回后补一次复读', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead } = setup()
    const first = deferred<DocumentEditorResult>()
    let calls = 0
    setRead(() => {
      calls += 1
      return calls === 1 ? first.promise : { status: 'ok', text: '源文本后来改了', canReplace: true }
    })
    const started = watcher.translate()
    await vi.waitFor(() => expect(editorCalls).toHaveLength(1))
    trustedKeydown(editable, { key: 'Backspace' })
    first.resolve({ status: 'ok', text: '源文本', canReplace: true })
    await started
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    expect(calls).toBe(2)
    watcher.dispose()
  })

  it('译文就绪后再次触发：不重新翻译，焦点移入面板的首个可用操作；焦点在面板内时再触发保持不变', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, translateCalls } = setup()
    await watcher.translate()
    const keyHint = popoverShadow()?.querySelector<HTMLElement>('[data-action="key-hint"]')
    expect(keyHint?.textContent).toBe('wtInputPanelKeyHint')
    expect(popoverShadow()?.querySelector('.popover')?.getAttribute('aria-describedby')).toBe(keyHint?.id)
    expect(requireButton('replace').classList.contains('is-key-focus')).toBe(false)
    await expect(watcher.translate()).resolves.toBe(true)
    expect(popoverShadow()?.activeElement).toBe(requireButton('replace'))
    expect(requireButton('replace').classList.contains('is-key-focus')).toBe(true)
    await expect(watcher.translate()).resolves.toBe(true)
    expect(isPopoverOpen()).toBe(true)
    expect(translateCalls).toHaveLength(1)
    expect(editorCalls).toHaveLength(1)
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    editable.focus()
    expect(requireButton('replace').classList.contains('is-key-focus')).toBe(false)
    await expect(watcher.translate()).resolves.toBe(true)
    expect(popoverShadow()?.activeElement).toBe(requireButton('restore'))
    expect(requireButton('restore').classList.contains('is-key-focus')).toBe(true)
    expect(translateCalls).toHaveLength(1)
    watcher.dispose()
  })

  it('仅预览时再次触发聚焦复制；出错状态下再次触发照常重新翻译', async () => {
    makeEditorRoot()
    const preview = setup()
    preview.setRead({ status: 'ok', text: '源文本', canReplace: false })
    await preview.watcher.translate()
    await expect(preview.watcher.translate()).resolves.toBe(true)
    expect(popoverShadow()?.activeElement).toBe(requireButton('copy'))
    expect(preview.translateCalls).toHaveLength(1)
    preview.watcher.dispose()

    document.body.innerHTML = ''
    const { editable } = makeEditorRoot()
    const failing = setup()
    await failing.watcher.translate()
    failing.setReplace({ status: 'changed' })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(statusText()).toBe('wtInputTextChanged'))
    expect(popoverShadow()?.querySelector<HTMLElement>('[data-action="key-hint"]')?.style.display).toBe('none')
    editable.focus()
    await expect(failing.watcher.translate()).resolves.toBe(true)
    expect(failing.translateCalls).toHaveLength(2)
    failing.watcher.dispose()
  })

  it('替换返回 unsupported（未写入）时退回仅预览：保留译文与复制，不提示内容可能已改变', async () => {
    makeEditorRoot()
    const { watcher, setReplace } = setup()
    await watcher.translate()
    setReplace({ status: 'unsupported' })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('replace').style.display).toBe('none'))
    const status = popoverShadow()?.querySelector('[role="status"]')
    expect(status?.textContent).toBe('译文')
    expect(status?.className).toBe('status')
    expect(requireButton('restore').style.display).toBe('none')
    expect(requireButton('copy').style.display).toBe('')
    expect(requireButton('copy-original').style.display).toBe('')
    expect(popoverShadow()?.querySelector('[data-action="hint"]')?.textContent).toBe('wtInputEditorUnsupported')
    watcher.dispose()
  })

  it('还原返回 unsupported 时仍给出可恢复原文的说明', async () => {
    makeEditorRoot()
    const { watcher, setReplace } = setup()
    await watcher.translate()
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('restore').style.display).toBe(''))
    setReplace({ status: 'unsupported' })
    trustedClick(requireButton('restore'))
    await vi.waitFor(() => expect(statusText()).toBe('wtInputReplacePartial'))
    expect(requireButton('copy-original').style.display).toBe('')
    watcher.dispose()
  })

  it('替换失败并显示恢复说明后，编辑器内的按键不再复读，也不会关掉带复制原文的面板', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead, setReplace } = setup()
    const reads = (): number => editorCalls.filter((call) => call.action === 'read').length
    await watcher.translate()
    setReplace({ status: 'failed' })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(statusText()).toBe('wtInputReplacePartial'))
    setRead({ status: 'ok', text: '部分写入的内容', canReplace: true })
    trustedKeydown(editable, { key: 'c', ctrlKey: true })
    trustedEvent(editable, 'paste')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(reads()).toBe(1)
    expect(isPopoverOpen()).toBe(true)
    expect(statusText()).toBe('wtInputReplacePartial')
    expect(requireButton('copy-original').style.display).toBe('')
    watcher.dispose()
  })

  it('替换成功但不可还原时，复读按实际写入的文本比对', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead, setReplace } = setup()
    const reads = (): number => editorCalls.filter((call) => call.action === 'read').length
    await watcher.translate()
    setReplace({ status: 'ok', text: '实际写入', canReplace: false })
    trustedClick(requireButton('replace'))
    await vi.waitFor(() => expect(requireButton('replace').style.display).toBe('none'))
    expect(requireButton('restore').style.display).toBe('none')
    setRead({ status: 'ok', text: '实际写入', canReplace: false })
    trustedKeydown(editable, { key: 'c', ctrlKey: true })
    await vi.waitFor(() => expect(reads()).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(isPopoverOpen()).toBe(true)
    setRead({ status: 'ok', text: '实际写入后又改了', canReplace: false })
    trustedKeydown(editable, { key: 'Backspace' })
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    watcher.dispose()
  })

  it('旧会话仍在途的复读不阻塞新会话的复读，迟到后也不影响新会话', async () => {
    const { editable } = makeEditorRoot()
    const { watcher, editorCalls, setRead } = setup()
    const reads = (): number => editorCalls.filter((call) => call.action === 'read').length
    await watcher.translate()
    const stale = deferred<DocumentEditorResult>()
    setRead(() => stale.promise)
    trustedKeydown(editable, { key: 'F8' })
    await vi.waitFor(() => expect(reads()).toBe(2))
    trustedInput(editable)
    expect(isPopoverOpen()).toBe(false)
    setRead({ status: 'ok', text: '源文本', canReplace: true })
    await watcher.translate()
    expect(isPopoverOpen()).toBe(true)
    trustedKeydown(editable, { key: 'F8' })
    await vi.waitFor(() => expect(reads()).toBe(4))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(isPopoverOpen()).toBe(true)
    stale.resolve({ status: 'ok', text: '旧会话读到的别的内容', canReplace: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(isPopoverOpen()).toBe(true)
    setRead({ status: 'ok', text: '源文本被改了', canReplace: true })
    trustedKeydown(editable, { key: 'Backspace' })
    await vi.waitFor(() => expect(isPopoverOpen()).toBe(false))
    watcher.dispose()
  })
})
