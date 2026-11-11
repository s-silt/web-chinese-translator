import { beforeEach, describe, expect, it, vi } from 'vitest'
import { documentEditorInMainWorld } from '../../../src/translation/document-editor'

const TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function tokened(root: Element): void {
  root.setAttribute('data-wt-document-input', TOKEN)
}

function focus(element: Element): void {
  ;(element as HTMLElement).focus()
}

interface InlineNode {
  readonly is: (type: string, name?: string) => boolean
  readonly name?: string
  readonly data?: string
  getAttributes?: () => Iterable<unknown>
}

interface BlockNode {
  readonly is: (type: string, name?: string) => boolean
  readonly name: string
  getAttributes: () => Iterable<unknown>
  getChildren: () => Iterable<InlineNode>
}

function inline(text: string, formatted = false): InlineNode {
  return {
    is: (type: string) => type === '$text' || type === '$textProxy',
    name: '$text',
    data: text,
    getAttributes: formatted ? function* () { yield ['bold', {}] } : function* () {},
  }
}

function softBreak(): InlineNode {
  return {
    is: (type: string, name?: string) => (type === 'element' && name === 'softBreak') || type === 'softBreak',
    name: 'softBreak',
  }
}

function paragraph(text: string, formatted = false): BlockNode {
  const parts: InlineNode[] = []
  const segments = text.split('\n')
  segments.forEach((segment, index) => {
    if (index > 0) parts.push(softBreak())
    if (segment !== '') parts.push(inline(segment, formatted))
  })
  return {
    is: (type: string) => type === 'element',
    name: 'paragraph',
    getAttributes: function* () {},
    getChildren: () => parts,
  }
}

function ckEditorStub(
  root: HTMLElement,
  text: string,
  options: { formatted?: boolean; complex?: boolean; readOnly?: boolean; methodAttrs?: boolean } = {},
) {
  let blocks: BlockNode[] = options.complex === true
    ? [{ is: (t: string) => t === 'element', name: 'listItem', getAttributes: function* () {}, getChildren: () => [] }]
    : text.split('\n').map((line) => paragraph(line, options.formatted === true))
  if (options.methodAttrs === true) {
    const bind = (node: { getAttributes?: () => Iterable<unknown> } & Record<string, unknown>): void => {
      ;(node as Record<string, unknown>)._attrs = []
      node.getAttributes = function (this: { _attrs?: Iterable<unknown> }) {
        return this._attrs ?? []
      }
    }
    for (const block of blocks) {
      bind(block as never)
      for (const child of block.getChildren()) bind(child as never)
    }
  }
  const editor = {
    isReadOnly: options.readOnly === true,
    ui: { getEditableElement: () => root },
    editing: { view: { getDomRoot: () => root } },
    model: {
      document: { getRoot: () => ({ getChildren: () => blocks }) },
      change: (fn: (w: unknown) => void) => {
        const nextBlocks: BlockNode[] = []
        const writer = {
          remove: () => { nextBlocks.length = 0 },
          createRangeIn: () => ({}),
          createElement: () => ({ children: [] as InlineNode[] }),
          append: (holder: { children: InlineNode[] }, _parent: unknown) => {
            nextBlocks.push({
              is: (t: string) => t === 'element',
              name: 'paragraph',
              getAttributes: function* () {},
              getChildren: () => holder.children,
            })
            void _parent
          },
          appendText: (line: string, holder: { children: InlineNode[] }) => {
            holder.children.push(inline(line, false))
          },
          setSelection: () => undefined,
        }
        fn(writer)
        blocks = nextBlocks
      },
    },
  }
  ;(root as unknown as { ckeditorInstance?: unknown }).ckeditorInstance = editor
  return editor
}

function cm6Stub(
  root: HTMLElement,
  text: string,
  options: { readOnly?: boolean; viaChain?: boolean; viaTile?: boolean; chainDepth?: number } = {},
) {
  const content = document.createElement('div')
  content.className = 'cm-content'
  content.contentEditable = 'true'
  root.append(content)
  let doc = text
  const view = {
    dom: root,
    contentDOM: content,
    editable: options.readOnly !== true,
    state: {
      readOnly: options.readOnly === true,
      doc: {
        toString: () => doc,
        get length() { return doc.length },
      },
    },
    dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
      if (spec.changes !== undefined) {
        doc = spec.changes.insert
      }
    },
  }
  if (options.viaTile === true) {
    ;(content as unknown as { cmTile?: unknown }).cmTile = { dom: content, view, parent: null }
  } else if (options.viaChain === true) {
    const depth = options.chainDepth ?? 1
    let node: Record<string, unknown> = { view, parent: undefined }
    for (let index = 1; index < depth; index += 1) {
      node = { view: { dom: document.createElement('div') }, parent: node }
    }
    ;(content as unknown as { cmView?: unknown }).cmView = node
  } else {
    ;(window as unknown as { cmEditorView?: unknown }).cmEditorView = view
  }
  return view
}

function cm5Stub(root: HTMLElement, text: string, options: { readOnly?: boolean } = {}) {
  let value = text
  const cm = {
    getWrapperElement: () => root,
    getValue: () => value,
    getOption: (name: string) => (name === 'readOnly' ? options.readOnly === true : undefined),
    posFromIndex: (index: number) => ({ line: 0, ch: index }),
    replaceRange: (next: string) => { value = next },
  }
  ;(root as unknown as { CodeMirror?: unknown }).CodeMirror = cm
  return cm
}

function tinyStub(root: HTMLElement, text: string, html = '') {
  const calls: string[] = []
  let currentText = text
  const decode = (value: string): string =>
    value
      .replace(/^<p>/, '')
      .replace(/<\/p>$/, '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  const editor = {
    getBody: () => root,
    getDoc: () => document,
    readonly: false,
    getContent: ({ format }: { format: string }) => (format === 'text' ? currentText : html),
    setContent: (value: string) => {
      calls.push(value)
      currentText = decode(value)
    },
    undoManager: { transact: (fn: () => void) => fn() },
    fire: () => undefined,
    save: () => undefined,
  }
  ;(window as unknown as { tinymce?: unknown }).tinymce = { editors: [editor] }
  return { editor, calls }
}

describe('documentEditorInMainWorld', () => {
  it('CKEditor5 软换行仅预览，禁止重建成段落', () => {
    const root = document.createElement('div')
    root.className = 'ck-editor__editable'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    const editor = ckEditorStub(root, 'first\nsecond')
    editor.model.document.getRoot = () => ({ getChildren: () => [paragraph('first\nsecond')] })
    const change = vi.spyOn(editor.model, 'change')
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok', text: 'first\nsecond', canReplace: false,
    })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'first\nsecond', text: 'next' }).status).not.toBe('ok')
    expect(change).not.toHaveBeenCalled()
  })

  it.each(['<p>first</p><p>second</p>', '<div>first<br>second</div>', '<p>first</p>second'])('TinyMCE 无法精确还原的结构仅预览：%s', (html) => {
    const root = document.createElement('div')
    root.className = 'mce-content-body'
    root.contentEditable = 'true'
    root.innerHTML = html
    document.body.append(root)
    tokened(root)
    const { calls } = tinyStub(root, 'first\nsecond', html)
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok', text: 'first\nsecond', canReplace: false,
    })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'first\nsecond', text: 'next' }).status).not.toBe('ok')
    expect(calls).toEqual([])
    expect(root.innerHTML).toBe(html)
  })

  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as unknown as { tinymce?: unknown }).tinymce
    delete (window as unknown as { cmEditorView?: unknown }).cmEditorView
  })

  it('函数源码脱离模块闭包序列化后仍可在全局环境执行', () => {
    const revived = new Function(
      'request',
      `return (${documentEditorInMainWorld.toString()})(request)`,
    ) as (request: Parameters<typeof documentEditorInMainWorld>[0]) => ReturnType<typeof documentEditorInMainWorld>
    const root = document.createElement('div')
    root.className = 'ck-editor__editable'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    ckEditorStub(root, '序列化\n读取')
    focus(root)
    expect(revived({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok',
      text: '序列化\n读取',
      canReplace: true,
    })
  })

  it('rejects malformed requests and missing tokens', () => {
    expect(documentEditorInMainWorld({ elementId: '', action: 'read' })).toEqual({ status: 'failed' })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
    const root = document.createElement('div')
    document.body.append(root)
    tokened(root)
    tokened(root) // duplicate attribute impossible; add second element instead
    const second = document.createElement('div')
    second.setAttribute('data-wt-document-input', TOKEN)
    document.body.append(second)
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
  })

  it('rejects unfocused, sensitive, disconnected and oversized candidates', () => {
    const root = document.createElement('div')
    root.className = 'cm-editor'
    cm6Stub(root, 'hello')
    document.body.append(root)
    tokened(root)
    // 未聚焦
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toMatchObject({ status: 'ok' })
    // 敏感字段
    root.setAttribute('aria-label', 'password verification code')
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
    root.removeAttribute('aria-label')
    // 断开连接
    root.remove()
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
    // 超长
    const big = document.createElement('div')
    big.className = 'cm-editor'
    cm6Stub(big, 'x'.repeat(6001))
    document.body.append(big)
    big.setAttribute('data-wt-document-input', 'cccccccc-cccc-4ccc-8ddd-eeeeeeeeeeee')
    focus(big)
    expect(
      documentEditorInMainWorld({ elementId: 'cccccccc-cccc-4ccc-8ddd-eeeeeeeeeeee', action: 'read' }),
    ).toEqual({ status: 'unsupported' })
  })

  it('CKEditor5 plain model reads and writes through the model API', () => {
    const root = document.createElement('div')
    root.className = 'ck-editor__editable'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    ckEditorStub(root, '第一行\n第二行')
    focus(root)
    const read = documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })
    expect(read).toEqual({ status: 'ok', text: '第一行\n第二行', canReplace: true })
    const write = documentEditorInMainWorld({
      elementId: TOKEN,
      action: 'replace',
      expectedText: '第一行\n第二行',
      text: 'new\ntext',
    })
    expect(write.status).toBe('ok')
    const after = documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })
    expect(after).toMatchObject({ status: 'ok', text: 'new\ntext' })
  })

  it('CKEditor5 formatted text previews without replace; complex model is unsupported', () => {
    const root = document.createElement('div')
    root.className = 'ck-editor__editable'
    document.body.append(root)
    tokened(root)
    ckEditorStub(root, 'styled', { formatted: true })
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok',
      text: 'styled',
      canReplace: false,
    })
    const complex = document.createElement('div')
    complex.className = 'ck-editor__editable'
    document.body.append(complex)
    complex.setAttribute('data-wt-document-input', 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    ckEditorStub(complex, 'list', { complex: true })
    focus(complex)
    expect(
      documentEditorInMainWorld({ elementId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', action: 'read' }),
    ).toEqual({ status: 'unsupported' })
  })

  it('CKEditor5 实例方法 getAttributes 保持 this 绑定，纯文本仍可替换', () => {
    const root = document.createElement('div')
    root.className = 'ck-editor__editable'
    document.body.append(root)
    tokened(root)
    ckEditorStub(root, '第一段\n第二段', { methodAttrs: true })
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok',
      text: '第一段\n第二段',
      canReplace: true,
    })
  })

  it('CKEditor5 readonly is denied', () => {
    const root = document.createElement('div')
    root.className = 'ck-editor__editable'
    document.body.append(root)
    tokened(root)
    ckEditorStub(root, 'locked', { readOnly: true })
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
  })

  it('CodeMirror6 reads the full document and writes exact markdown', () => {
    const root = document.createElement('div')
    root.className = 'cm-editor'
    document.body.append(root)
    tokened(root)
    cm6Stub(root, '# Title\n\n- a\n- b\n\n```\ncode\n```')
    focus(root)
    const read = documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })
    expect(read).toEqual({
      status: 'ok',
      text: '# Title\n\n- a\n- b\n\n```\ncode\n```',
      canReplace: true,
    })
    const write = documentEditorInMainWorld({
      elementId: TOKEN,
      action: 'replace',
      expectedText: '# Title\n\n- a\n- b\n\n```\ncode\n```',
      text: 'changed\n\ntext',
    })
    expect(write.status).toBe('ok')
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toMatchObject({
      status: 'ok',
      text: 'changed\n\ntext',
    })
  })

  it('CodeMirror6 returns changed when the document was edited', () => {
    const root = document.createElement('div')
    root.className = 'cm-editor'
    document.body.append(root)
    tokened(root)
    const view = cm6Stub(root, 'before')
    focus(root)
    view.state.doc.toString = () => 'edited'
    const result = documentEditorInMainWorld({
      elementId: TOKEN,
      action: 'replace',
      expectedText: 'before',
      text: 'next',
    })
    expect(result).toEqual({ status: 'changed' })
  })

  it('CodeMirror5 reads getValue and replaces via replaceRange', () => {
    const root = document.createElement('div')
    root.className = 'CodeMirror'
    document.body.append(root)
    tokened(root)
    cm5Stub(root, 'cm5 text\nline2')
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok',
      text: 'cm5 text\nline2',
      canReplace: true,
    })
    expect(
      documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'cm5 text\nline2', text: 'new' }),
    ).toEqual({ status: 'ok', text: 'new', canReplace: true })
  })

  it('CodeMirror5 18000 字译文可写入并可还原，18001 expected 拒绝且不写入', () => {
    const root = document.createElement('div')
    root.className = 'CodeMirror'
    root.tabIndex = 0
    document.body.append(root)
    tokened(root)
    const cm = cm5Stub(root, 'original')
    focus(root)
    const translated = 't'.repeat(18000)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'original', text: translated })).toEqual({ status: 'ok', text: translated, canReplace: true })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: translated, text: 'original' })).toEqual({ status: 'ok', text: 'original', canReplace: true })
    expect(cm.getValue()).toBe('original')

    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'x'.repeat(18001), text: 'y' })).toEqual({ status: 'failed' })
    expect(cm.getValue()).toBe('original')
    cm.replaceRange('new draft')
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'original', text: 'overwrite' })).toEqual({ status: 'changed' })
    expect(cm.getValue()).toBe('new draft')
  })

  it('TinyMCE 规范化后的实际内容作为替换结果返回', () => {
    const root = document.createElement('body')
    root.className = 'mce-content-body'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    const { editor } = tinyStub(root, 'original', '<p>original</p>')
    const setContent = editor.setContent
    editor.setContent = (html) => setContent(html.replace(/<br><\/p>$/, '</p>'))
    focus(root)
    const result = documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'original', text: 'translated\n' })
    expect(result).toEqual({ status: 'ok', text: 'translated', canReplace: true })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'translated', text: 'original' })).toEqual({ status: 'ok', text: 'original', canReplace: true })
  })

  it('TinyMCE same-origin frame escapes text and marks formatting preview-only', () => {
    const root = document.createElement('body')
    root.className = 'mce-content-body'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    const { calls } = tinyStub(root, 'plain', '<p>plain</p>')
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok',
      text: 'plain',
      canReplace: true,
    })
    const write = documentEditorInMainWorld({
      elementId: TOKEN,
      action: 'replace',
      expectedText: 'plain',
      text: 'a<b>&\nc',
    })
    expect(write.status).toBe('ok')
    expect(calls[0]).toBe('<p>a&lt;b&gt;&amp;<br>c</p>')
  })

  it('TinyMCE 6 起没有 tinymce.editors：经 tinymce.get() 找到实例后可读取、替换并还原', () => {
    const root = document.createElement('body')
    root.className = 'mce-content-body'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    const { editor, calls } = tinyStub(root, 'original', '<p>original</p>')
    const dispatched: string[] = []
    const fired: string[] = []
    Object.assign(editor, {
      dispatch: (name: string) => { dispatched.push(name) },
      fire: (name: string) => { fired.push(name) },
    })
    ;(window as unknown as { tinymce?: unknown }).tinymce = { get: () => [editor] }
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok',
      text: 'original',
      canReplace: true,
    })
    expect(
      documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'original', text: 'translated' }),
    ).toEqual({ status: 'ok', text: 'translated', canReplace: true })
    expect(
      documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'translated', text: 'original' }),
    ).toEqual({ status: 'ok', text: 'original', canReplace: true })
    expect(calls).toEqual(['<p>translated</p>', '<p>original</p>'])
    expect(dispatched).toEqual(['input', 'change', 'input', 'change'])
    expect(fired).toEqual([])
  })

  it('TinyMCE 的 get() 抛错或返回非数组时按不支持处理', () => {
    const root = document.createElement('body')
    root.className = 'mce-content-body'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    tinyStub(root, 'original', '<p>original</p>')
    focus(root)
    ;(window as unknown as { tinymce?: unknown }).tinymce = { get: () => { throw new Error('x') } }
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
    ;(window as unknown as { tinymce?: unknown }).tinymce = { get: () => null }
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
  })

  it.each([
    ['连续空格', 'A.  B'],
    ['制表符', 'A\tB'],
    ['行首空格', '一\n  二'],
    ['行尾空格', '一 \n二'],
  ])('TinyMCE 译文含会被 HTML 折叠的空白（%s）时不写入，原文保持不变', (_name, text) => {
    const root = document.createElement('body')
    root.className = 'mce-content-body'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    const { editor, calls } = tinyStub(root, 'original', '<p>original</p>')
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'original', text })).toEqual({
      status: 'unsupported',
    })
    expect(calls).toEqual([])
    expect(editor.getContent({ format: 'text' })).toBe('original')
  })

  it('TinyMCE 译文含不间断空格与换行时照常写入', () => {
    const root = document.createElement('body')
    root.className = 'mce-content-body'
    root.contentEditable = 'true'
    document.body.append(root)
    tokened(root)
    const { calls } = tinyStub(root, 'original', '<p>original</p>')
    focus(root)
    expect(
      documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'original', text: 'A\u00a0 B\nC' }).status,
    ).toBe('ok')
    expect(calls).toEqual(['<p>A\u00a0 B<br>C</p>'])
  })

  it('TinyMCE formatted markup previews but cannot replace', () => {
    const root = document.createElement('body')
    root.className = 'mce-content-body'
    document.body.append(root)
    tokened(root)
    const inner = document.createElement('p')
    inner.innerHTML = 'x<strong>y</strong>'
    root.append(inner)
    tinyStub(root, 'xy', '<p>x<strong>y</strong></p>')
    focus(root)
    const read = documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })
    expect(read).toEqual({ status: 'ok', text: 'xy', canReplace: false })
    expect(
      documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'xy', text: 'z' }),
    ).toEqual({ status: 'unsupported' })
  })

  it('CodeMirror6 经 cmView.view 与 parent 链解析（无 window.cmEditorView）', () => {
    delete (window as unknown as { cmEditorView?: unknown }).cmEditorView
    const root = document.createElement('div')
    root.className = 'cm-editor'
    document.body.append(root)
    tokened(root)
    cm6Stub(root, 'chain text', { viaChain: true })
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok',
      text: 'chain text',
      canReplace: true,
    })
    const deep = document.createElement('div')
    deep.className = 'cm-editor'
    document.body.append(deep)
    deep.setAttribute('data-wt-document-input', 'dddddddd-dddd-4ccc-8ddd-eeeeeeeeeeee')
    cm6Stub(deep, 'deep chain', { viaChain: true, chainDepth: 4 })
    focus(deep)
    expect(
      documentEditorInMainWorld({ elementId: 'dddddddd-dddd-4ccc-8ddd-eeeeeeeeeeee', action: 'read' }),
    ).toMatchObject({ status: 'ok', text: 'deep chain' })
  })

  it('CodeMirror6 cmTile 实例精确替换、还原，并拒绝过期文本', () => {
    const root = document.createElement('div')
    root.className = 'cm-editor'
    document.body.append(root)
    tokened(root)
    const view = cm6Stub(root, '你好\n第二行', { viaTile: true })
    focus(view.contentDOM)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({
      status: 'ok', text: '你好\n第二行', canReplace: true,
    })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: '你好\n第二行', text: 'Hello\nWorld' })).toEqual({
      status: 'ok', text: 'Hello\nWorld', canReplace: true,
    })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'Hello\nWorld', text: '你好\n第二行' }).status).toBe('ok')
    view.dispatch({ changes: { from: 0, to: 6, insert: '用户继续编辑' } })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: '你好\n第二行', text: 'stale' })).toEqual({ status: 'changed' })
    expect(view.state.doc.toString()).toBe('用户继续编辑')
  })

  it.each(['root', 'content', 'tile-dom', 'readonly', 'noneditable'] as const)('CodeMirror6 cmTile 拒绝 %s 不匹配或不可写实例', (kind) => {
    const root = document.createElement('div')
    root.className = 'cm-editor'
    document.body.append(root)
    tokened(root)
    const view = cm6Stub(root, '保持原文', { viaTile: true })
    const content = view.contentDOM
    focus(content)
    if (kind === 'root') view.dom = document.createElement('div')
    if (kind === 'content') view.contentDOM = document.createElement('div')
    if (kind === 'tile-dom') (content as unknown as { cmTile: { dom: Element } }).cmTile.dom = document.createElement('div')
    if (kind === 'readonly') view.state.readOnly = true
    if (kind === 'noneditable') content.contentEditable = 'false'
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: '保持原文', text: 'rejected' })).toEqual({ status: 'unsupported' })
    expect(view.state.doc.toString()).toBe('保持原文')
  })

  it('CodeMirror5 readOnly 为 nocursor 等未知真值时拒绝', () => {
    const root = document.createElement('div')
    root.className = 'CodeMirror'
    document.body.append(root)
    tokened(root)
    const cm = cm5Stub(root, 'locked')
    ;(cm as { getOption: (name: string) => unknown }).getOption = () => 'nocursor'
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
  })

  it.each(['ck', 'tiny', 'cm5', 'cm6'] as const)('%s treats literal unsupported as document text', (kind) => {
    const root = document.createElement(kind === 'tiny' ? 'body' : 'div')
    root.className = { ck: 'ck-editor__editable', tiny: 'mce-content-body', cm5: 'CodeMirror', cm6: 'cm-editor' }[kind]
    root.contentEditable = 'true'
    root.tabIndex = 0
    document.body.append(root)
    tokened(root)
    if (kind === 'ck') ckEditorStub(root, 'unsupported')
    else if (kind === 'tiny') tinyStub(root, 'unsupported', '<p>unsupported</p>')
    else if (kind === 'cm5') cm5Stub(root, 'unsupported')
    else cm6Stub(root, 'unsupported')
    focus(root)
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'ok', text: 'unsupported', canReplace: true })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'unsupported', text: 'new' })).toEqual({ status: 'ok', text: 'new', canReplace: true })
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'replace', expectedText: 'new', text: 'unsupported' })).toEqual({ status: 'ok', text: 'unsupported', canReplace: true })
  })

  it('unknown editors are unsupported', () => {
    const root = document.createElement('div')
    root.className = 'mce-content-body'
    document.body.append(root)
    tokened(root)
    focus(root)
    // 没有 tinymce.editors 匹配项
    ;(window as unknown as { tinymce?: unknown }).tinymce = { editors: [] }
    expect(documentEditorInMainWorld({ elementId: TOKEN, action: 'read' })).toEqual({ status: 'unsupported' })
  })
})
