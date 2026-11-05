import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
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
})
