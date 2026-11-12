import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  ParagraphNode,
  createEditor,
  type SerializedParagraphNode,
} from 'lexical'
import { registerRichText } from '@lexical/rich-text'
import Quill from 'quill'
import { createEditor as createRoosterEditor, exportContent } from 'roosterjs'
import { afterEach, describe, expect, it } from 'vitest'
import { readChatDraft, replaceChatDraftInMainWorld } from '../../../src/translation/chat-input'

const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function setPageUrl(url: string): void {
  const happy = (window as Window & { happyDOM?: { setURL(next: string): void } }).happyDOM
  if (happy === undefined) throw new Error('happyDOM.setURL unavailable')
  happy.setURL(url)
}

function bindFiber(host: HTMLElement, value: unknown): void {
  ;(host as unknown as Record<string, unknown>).__reactFiber$fixture = {
    memoizedState: { memoizedState: value, next: null },
    return: null,
  }
}

class BidiParagraphNode extends ParagraphNode {
  static override getType(): string {
    return 'bidi-paragraph'
  }

  static override clone(node: BidiParagraphNode): BidiParagraphNode {
    return new BidiParagraphNode(node.__key)
  }

  static override importJSON(serializedNode: SerializedParagraphNode): BidiParagraphNode {
    return new BidiParagraphNode().updateFromJSON(serializedNode)
  }

  override exportJSON(): SerializedParagraphNode {
    return {
      ...super.exportJSON(),
      type: 'paragraph',
    }
  }
}

afterEach(() => {
  document.body.textContent = ''
  setPageUrl('about:blank')
})

describe('真实 Lexical Quill Rooster 模型', () => {
  it('Lexical DOM 与 getTextContent 一致，且 fiber 上的实例能写入', () => {
    setPageUrl('https://web.whatsapp.com/')
    const parent = document.createElement('div')
    const root = document.createElement('div')
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('data-lexical-editor', 'true')
    root.setAttribute('data-wt-chat-input', elementId)
    parent.append(root)
    document.body.append(parent)
    const editor = createEditor({ namespace: 'fixture', nodes: [], onError(error) { throw error } })
    registerRichText(editor)
    editor.setRootElement(root)
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('第一行'))
      paragraph.append($createLineBreakNode())
      paragraph.append($createLineBreakNode())
      paragraph.append($createTextNode('第三行'))
      paragraph.append($createLineBreakNode())
      $getRoot().clear()
      $getRoot().append(paragraph)
    }, { discrete: true })
    let model = ''
    editor.getEditorState().read(() => {
      model = $getRoot().getTextContent()
    })
    expect(model).toBe('第一行\n\n第三行\n')
    expect(readChatDraft(root)).toBe(model)
    delete (root as unknown as { __lexicalEditor?: unknown }).__lexicalEditor
    bindFiber(parent, editor)
    expect(replaceChatDraftInMainWorld({ elementId, expectedText: model, text: 'Please review this code.' })).toBe('ok')
    editor.getEditorState().read(() => {
      model = $getRoot().getTextContent()
    })
    expect(model).toBe('Please review this code.')
    expect(readChatDraft(root)).toBe('Please review this code.')
  })

  it('WhatsApp bidi-paragraph 导致 toJSON 抛 #130 时仍能按 _nodeMap 替换单行与多行草稿，含 tab 节点返回 unsupported 且不改写草稿', () => {
    setPageUrl('https://web.whatsapp.com/')
    const parent = document.createElement('div')
    const root = document.createElement('div')
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('data-lexical-editor', 'true')
    root.setAttribute('data-wt-chat-input', elementId)
    parent.append(root)
    document.body.append(parent)
    const editor = createEditor({
      namespace: 'whatsapp',
      nodes: [BidiParagraphNode],
      onError(error) {
        throw error
      },
    })
    registerRichText(editor)
    editor.setRootElement(root)
    editor.update(() => {
      const paragraph = new BidiParagraphNode()
      paragraph.append($createTextNode('需要翻译的中文草稿'))
      $getRoot().clear()
      $getRoot().append(paragraph)
    }, { discrete: true })

    expect(() => editor.getEditorState().toJSON()).toThrow()
    expect(readChatDraft(root)).toBe('需要翻译的中文草稿')
    delete (root as unknown as { __lexicalEditor?: unknown }).__lexicalEditor
    bindFiber(parent, editor)

    expect(replaceChatDraftInMainWorld({
      elementId,
      expectedText: '需要翻译的中文草稿',
      text: 'First line\n\nThird line',
    })).toBe('ok')
    let model = ''
    editor.getEditorState().read(() => {
      model = $getRoot().getTextContent()
    })
    expect(model).toBe('First line\n\nThird line')
    expect(readChatDraft(root)).toBe('First line\n\nThird line')

    editor.update(() => {
      const first = new BidiParagraphNode()
      first.append($createTextNode('第一段'))
      first.append($createLineBreakNode())
      first.append($createTextNode('第二行'))
      const second = new BidiParagraphNode()
      second.append($createTextNode('第二段'))
      $getRoot().clear()
      $getRoot().append(first, second)
    }, { discrete: true })
    expect(() => editor.getEditorState().toJSON()).toThrow()
    expect(readChatDraft(root)).toBe('第一段\n第二行\n\n第二段')
    expect(replaceChatDraftInMainWorld({
      elementId,
      expectedText: '第一段\n第二行\n\n第二段',
      text: 'Paragraph one\nLine two\n\nParagraph two',
    })).toBe('ok')
    editor.getEditorState().read(() => {
      model = $getRoot().getTextContent()
    })
    expect(model).toBe('Paragraph one\nLine two\n\nParagraph two')
    expect(readChatDraft(root)).toBe('Paragraph one\nLine two\n\nParagraph two')

    editor.update(() => {
      const paragraph = new BidiParagraphNode()
      paragraph.append($createTextNode('前置中文'))
      paragraph.append($createTabNode())
      paragraph.append($createTextNode('后置中文'))
      $getRoot().clear()
      $getRoot().append(paragraph)
    }, { discrete: true })
    expect(() => editor.getEditorState().toJSON()).toThrow()
    const draftWithTab = readChatDraft(root)
    expect(draftWithTab).toBe('前置中文\t后置中文')
    expect(replaceChatDraftInMainWorld({
      elementId,
      expectedText: draftWithTab,
      text: 'Should not replace',
    })).toBe('unsupported')
    editor.getEditorState().read(() => {
      model = $getRoot().getTextContent()
    })
    expect(model).toBe('前置中文\t后置中文')
    expect(readChatDraft(root)).toBe('前置中文\t后置中文')
  })

  it('Quill 只去掉模型末尾一个换行，fiber 实例写入保留尾部空行', () => {
    setPageUrl('https://app.slack.com/client/T/C')
    const parent = document.createElement('div')
    const mount = document.createElement('div')
    parent.append(mount)
    document.body.append(parent)
    const quill = new Quill(mount, { modules: { toolbar: false }, theme: null as unknown as string })
    quill.root.setAttribute('data-wt-chat-input', elementId)
    quill.setText('  a \n\n', 'user')
    expect(quill.getText()).toBe('  a \n\n')
    expect(readChatDraft(quill.root)).toBe('  a \n')
    delete (mount as unknown as { __quill?: unknown }).__quill
    const quillParent = quill.root.parentElement
    if (quillParent !== null) delete (quillParent as unknown as { __quill?: unknown }).__quill
    bindFiber(parent, quill)
    expect(replaceChatDraftInMainWorld({
      elementId,
      expectedText: '  a \n',
      text: '第一行\n\n第三行\n',
    })).toBe('ok')
    expect(quill.getText()).toBe('第一行\n\n第三行\n\n')
    expect(quill.getText().slice(0, -1)).toBe('第一行\n\n第三行\n')
    expect(readChatDraft(quill.root)).toBe('第一行\n\n第三行\n')
    expect(quill.root.querySelector('b')).toBeNull()
  })

  it('Rooster clean 模型按段末 BR 规则规范化，且不把文本写成元素', () => {
    setPageUrl('https://teams.microsoft.com/v2/')
    const parent = document.createElement('div')
    const root = document.createElement('div')
    parent.append(root)
    document.body.append(parent)
    const editor = createRoosterEditor(root)
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('data-wt-chat-input', elementId)
    editor.formatContentModel((model) => {
      model.blocks = [
        { blockType: 'Paragraph', format: {}, segments: [{ segmentType: 'Text', text: '你好', format: {} }] },
      ]
      return true
    }, { apiName: 'probe', changeSource: 'probe' })
    expect(readChatDraft(root)).toBe('你好')
    expect(exportContent(editor, 'PlainText').replace(/\r\n?/g, '\n')).toBe('你好')
    bindFiber(parent, editor)
    expect(replaceChatDraftInMainWorld({
      elementId,
      expectedText: '你好',
      text: '<b>不是标签</b>\n\n第三行\n',
    })).toBe('ok')
    const exported = exportContent(editor, 'PlainText').replace(/\r\n?/g, '\n')
    expect(exported).toBe('<b>不是标签</b>\n\n第三行\n')
    expect(readChatDraft(root)).toBe('<b>不是标签</b>\n\n第三行\n')
    expect(root.querySelector('b')).toBeNull()
  })

  it('Twitter/X Draft.js 模型：支持标准 ContentState/EditorState 静态方法、打包剥离静态方法后的 _onPaste 回退、useState 钩子与 @提及 实体，拒绝复杂块与外框实例', () => {
    setPageUrl('https://x.com/home')

    interface FakeDraftBlock {
      getKey(): string
      getType(): string
      getText(): string
      getLength(): number
      getData(): { size: number }
      getInlineStyleAt(offset: number): { size: number }
      getEntityAt(offset: number): string | null
    }

    function renderDraftDom(root: HTMLElement, lines: readonly string[]): void {
      const contents = document.createElement('div')
      contents.setAttribute('data-contents', 'true')
      lines.forEach((line, index) => {
        const block = document.createElement('div')
        block.setAttribute('data-block', 'true')
        block.setAttribute('data-editor', 'tw1')
        block.setAttribute('data-offset-key', `b${index}-0-0`)
        const inner = document.createElement('div')
        inner.className = 'public-DraftStyleDefault-block public-DraftStyleDefault-ltr'
        inner.setAttribute('data-offset-key', `b${index}-0-0`)
        const spanWrap = document.createElement('span')
        spanWrap.setAttribute('data-offset-key', `b${index}-0-0`)
        if (line === '') {
          const br = document.createElement('br')
          br.setAttribute('data-text', 'true')
          spanWrap.append(br)
        } else {
          const leaf = document.createElement('span')
          leaf.setAttribute('data-text', 'true')
          leaf.textContent = line
          spanWrap.append(leaf)
        }
        inner.append(spanWrap)
        block.append(inner)
        contents.append(block)
      })
      root.replaceChildren(contents)
    }

    function createDraftModel(
      initialText: string,
      options: {
        stripConstructorStatics?: boolean
        blockType?: string
        inlineStyled?: boolean
        entityType?: string
      } = {},
    ) {
      let currentLines = initialText.split('\n')
      interface FakeSelectionState extends Record<string, unknown> {
        merge(patch: Record<string, unknown>): FakeSelectionState
      }

      let currentSelection: FakeSelectionState = {
        anchorKey: 'b0',
        anchorOffset: 0,
        focusKey: 'b0',
        focusOffset: 0,
        isBackward: false,
        hasFocus: true,
        merge(patch: Record<string, unknown>) {
          return { ...this, ...patch }
        },
      }

      class FakeContentState {
        readonly lines: readonly string[]
        constructor(lines: readonly string[]) {
          this.lines = lines
        }
        static createFromText(text: string, delimiter = '\n') {
          return new FakeContentState(text.split(delimiter))
        }
        getPlainText(delimiter = '\n'): string {
          return this.lines.join(delimiter)
        }
        getBlocksAsArray(): FakeDraftBlock[] {
          return this.lines.map((line, idx) => ({
            getKey: () => `b${idx}`,
            getType: () => options.blockType ?? 'unstyled',
            getText: () => line,
            getLength: () => line.length,
            getData: () => ({ size: 0 }),
            getInlineStyleAt: () => ({ size: options.inlineStyled === true ? 1 : 0 }),
            getEntityAt: (offset: number) => (options.entityType !== undefined && offset === 0 ? 'ent-1' : null),
          }))
        }
        getEntity(key: string) {
          if (key === 'ent-1' && options.entityType !== undefined) {
            return { getType: () => options.entityType }
          }
          return undefined
        }
      }

      class FakeEditorState {
        readonly content: FakeContentState
        readonly selection: FakeSelectionState
        constructor(content: FakeContentState, selection: FakeSelectionState = currentSelection) {
          this.content = content
          this.selection = selection
        }
        static push(_state: FakeEditorState, content: FakeContentState) {
          return new FakeEditorState(content, currentSelection)
        }
        static moveFocusToEnd(state: FakeEditorState) {
          const lastIdx = Math.max(0, state.content.lines.length - 1)
          const lastLine = state.content.lines[lastIdx] ?? ''
          return new FakeEditorState(
            state.content,
            currentSelection.merge({
              anchorKey: `b${lastIdx}`,
              anchorOffset: lastLine.length,
              focusKey: `b${lastIdx}`,
              focusOffset: lastLine.length,
            }),
          )
        }
        getCurrentContent() {
          return this.content
        }
        getSelection() {
          return this.selection
        }
        getImmutable() {
          return {
            merge: (patch: { selection?: FakeSelectionState }) => {
              if (patch.selection !== undefined) currentSelection = patch.selection
              return new FakeContentState(currentLines)
            },
          }
        }
        isInCompositionMode() {
          return false
        }
      }

      if (options.stripConstructorStatics === true) {
        delete (FakeContentState as { createFromText?: unknown }).createFromText
        delete (FakeEditorState as { push?: unknown }).push
      }

      let latestState = new FakeEditorState(new FakeContentState(currentLines))
      return {
        get state() {
          return latestState
        },
        setState(next: FakeEditorState, root: HTMLElement) {
          latestState = next
          currentLines = [...next.content.lines]
          currentSelection = next.selection
          renderDraftDom(root, currentLines)
        },
        pasteReplace(pastedText: string, root: HTMLElement) {
          const startKey = String(currentSelection.anchorKey ?? '')
          const endKey = String(currentSelection.focusKey ?? '')
          const lastIdx = currentLines.length - 1
          const lastLine = currentLines[lastIdx] ?? ''
          if (
            startKey === 'b0' &&
            currentSelection.anchorOffset === 0 &&
            endKey === `b${lastIdx}` &&
            currentSelection.focusOffset === lastLine.length
          ) {
            currentLines = pastedText.split('\n')
            latestState = new FakeEditorState(new FakeContentState(currentLines), currentSelection)
            renderDraftDom(root, currentLines)
          }
        },
      }
    }

    const wrapper = document.createElement('div')
    wrapper.className = 'DraftEditor-root'
    const placeholder = document.createElement('div')
    placeholder.className = 'public-DraftEditorPlaceholder-root'
    placeholder.textContent = 'Post your reply'
    const container = document.createElement('div')
    container.className = 'DraftEditor-editorContainer'
    const root = document.createElement('div')
    root.className = 'notranslate public-DraftEditor-content'
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('role', 'textbox')
    root.setAttribute('data-testid', 'tweetTextarea_0')
    root.setAttribute('data-wt-chat-input', elementId)
    container.append(root)
    wrapper.append(placeholder, container)
    document.body.append(wrapper)

    // 1. 标准 Draft.js 类组件实例（带多行与空行）
    const model1 = createDraftModel('第一行\n\n第三行')
    renderDraftDom(root, ['第一行', '', '第三行'])
    expect(readChatDraft(root)).toBe('第一行\n\n第三行')

    const foreignRoot = document.createElement('div')
    foreignRoot.className = 'public-DraftEditor-content'
    const foreignDraftInstance = {
      editor: foreignRoot,
      _latestEditorState: model1.state,
      update() {
        throw new Error('foreign editor should not be called')
      },
    }
    const realDraftInstance = {
      editor: root,
      editorContainer: container,
      get _latestEditorState() {
        return model1.state
      },
      props: {
        get editorState() {
          return model1.state
        },
        readOnly: false,
      },
      update(nextState: typeof model1.state) {
        model1.setState(nextState, root)
      },
    }
    ;(root as unknown as Record<string, unknown>).__reactFiber$tw = {
      stateNode: foreignDraftInstance,
      return: {
        stateNode: realDraftInstance,
        return: null,
      },
    }

    expect(
      replaceChatDraftInMainWorld({
        elementId,
        expectedText: '第一行\n\n第三行',
        text: 'Line one\n\nLine three',
      }),
    ).toBe('ok')
    expect(model1.state.getCurrentContent().getPlainText()).toBe('Line one\n\nLine three')
    expect(readChatDraft(root)).toBe('Line one\n\nLine three')

    // 2. 打包剥离静态方法后走 SelectionState 全选 + _onPaste 回退
    const model2 = createDraftModel('需要替换的回复草稿', { stripConstructorStatics: true })
    renderDraftDom(root, ['需要替换的回复草稿'])
    const bundledInstance = {
      refs: { editor: root, editorContainer: container },
      get _latestEditorState() {
        return model2.state
      },
      update(nextState: typeof model2.state) {
        model2.setState(nextState, root)
      },
      _onPaste(event: { clipboardData: { getData(type: string): string } }) {
        model2.pasteReplace(event.clipboardData.getData('text/plain'), root)
      },
    }
    ;(root as unknown as Record<string, unknown>).__reactFiber$tw = {
      stateNode: bundledInstance,
      return: null,
    }
    expect(
      replaceChatDraftInMainWorld({
        elementId,
        expectedText: '需要替换的回复草稿',
        text: 'Translated reply\nSecond line',
      }),
    ).toBe('ok')
    expect(model2.state.getCurrentContent().getPlainText()).toBe('Translated reply\nSecond line')
    expect(readChatDraft(root)).toBe('Translated reply\nSecond line')

    // 3. @mention 实体允许替换，但 LINK 实体、内联样式或代码块安全返回 unsupported
    const mentionModel = createDraftModel('@elonmusk 请问这个问题怎么修？', { entityType: 'MENTION' })
    renderDraftDom(root, ['@elonmusk 请问这个问题怎么修？'])
    ;(root as unknown as Record<string, unknown>).__reactFiber$tw = {
      memoizedState: {
        memoizedState: mentionModel.state,
        queue: {
          dispatch(nextState: typeof mentionModel.state) {
            mentionModel.setState(nextState, root)
          },
        },
        next: null,
      },
      return: null,
    }
    expect(
      replaceChatDraftInMainWorld({
        elementId,
        expectedText: '@elonmusk 请问这个问题怎么修？',
        text: '@elonmusk How can this issue be fixed?',
      }),
    ).toBe('ok')
    expect(readChatDraft(root)).toBe('@elonmusk How can this issue be fixed?')

    for (const unsafeOpts of [
      { entityType: 'LINK' },
      { inlineStyled: true },
      { blockType: 'code-block' },
    ] as const) {
      const unsafeModel = createDraftModel('不改写的富文本', unsafeOpts)
      renderDraftDom(root, ['不改写的富文本'])
      ;(root as unknown as Record<string, unknown>).__reactFiber$tw = {
        stateNode: {
          editor: root,
          _latestEditorState: unsafeModel.state,
          update(nextState: typeof unsafeModel.state) {
            unsafeModel.setState(nextState, root)
          },
        },
        return: null,
      }
      expect(
        replaceChatDraftInMainWorld({
          elementId,
          expectedText: '不改写的富文本',
          text: 'Should not write',
        }),
      ).toBe('unsupported')
      expect(readChatDraft(root)).toBe('不改写的富文本')
    }
  })

  it('Reddit 开放 ShadowRoot 内 Lexical 与无 hard_break 的 ProseMirror 多段落替换', () => {
    setPageUrl('https://www.reddit.com/r/programming/comments/1/')
    const shadowHost = document.createElement('shreddit-composer')
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' })
    const root = document.createElement('div')
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('data-lexical-editor', 'true')
    root.setAttribute('data-wt-chat-input', elementId)
    shadowRoot.append(root)
    document.body.append(shadowHost)

    const editor = createEditor({ namespace: 'reddit', nodes: [], onError(error) { throw error } })
    registerRichText(editor)
    editor.setRootElement(root)
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('开放影子树里的中文评论'))
      $getRoot().clear()
      $getRoot().append(paragraph)
    }, { discrete: true })
    delete (root as unknown as { __lexicalEditor?: unknown }).__lexicalEditor
    bindFiber(shadowHost, editor)

    expect(readChatDraft(root)).toBe('开放影子树里的中文评论')
    expect(
      replaceChatDraftInMainWorld({
        elementId,
        expectedText: '开放影子树里的中文评论',
        text: 'Comment inside open shadow root',
      }),
    ).toBe('ok')
    expect(readChatDraft(root)).toBe('Comment inside open shadow root')
    root.removeAttribute('data-wt-chat-input')

    // Bluesky / Grok 等无 hard_break 节点的 ProseMirror schema 走多段落替换
    setPageUrl('https://bsky.app/profile/test')
    const pmRoot = document.createElement('div')
    pmRoot.className = 'ProseMirror'
    pmRoot.setAttribute('contenteditable', 'true')
    pmRoot.setAttribute('data-wt-chat-input', elementId)
    pmRoot.innerHTML = '<p>第一行</p><p>第二行</p>'
    document.body.append(pmRoot)

    let pmDocLines = ['第一行', '第二行']
    ;(pmRoot as unknown as { editor?: unknown }).editor = {
      view: {
        dom: pmRoot,
        editable: true,
        composing: false,
        dispatch(tr: { lines: string[] }) {
          pmDocLines = tr.lines
        },
        get state() {
          const text = pmDocLines.join('\n')
          return {
            doc: {
              content: { size: text.length + 2 },
              textBetween: () => text,
              descendants(cb: (node: { type: { name: string } }) => boolean | void) {
                cb({ type: { name: 'doc' } })
                for (const line of pmDocLines) {
                  cb({ type: { name: 'paragraph' } })
                  if (line !== '') cb({ type: { name: 'text' } })
                }
              },
            },
            schema: {
              text: (value: string) => ({ kind: 'text', value }),
              nodes: {
                paragraph: {
                  create: (_attrs: null, content: ReadonlyArray<{ value?: string }>) => ({
                    kind: 'paragraph',
                    text: content.map((c) => c.value ?? '').join(''),
                  }),
                },
              },
            },
            tr: {
              replaceWith(_from: number, _to: number, content: unknown) {
                const list = Array.isArray(content) ? content : [content]
                return { lines: list.map((item) => (item as { text: string }).text) }
              },
            },
          }
        },
      },
    }
    expect(readChatDraft(pmRoot)).toBe('第一行\n第二行')
    expect(
      replaceChatDraftInMainWorld({
        elementId,
        expectedText: '第一行\n第二行',
        text: 'First paragraph\nSecond paragraph',
      }),
    ).toBe('ok')
    expect(pmDocLines).toEqual(['First paragraph', 'Second paragraph'])
  })
})
