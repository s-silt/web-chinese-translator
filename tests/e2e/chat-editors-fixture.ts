import * as esbuild from 'esbuild'

const FIXTURE_SOURCE = `
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

window.__chatModelText = ''
window.__sentDrafts = window.__sentDrafts || []

const editor = new Editor({
  element: document.getElementById('editor-mount'),
  extensions: [StarterKit],
  content: '<p></p>',
  editorProps: {
    attributes: {
      id: 'chat-editor',
      role: 'textbox',
      style: 'min-height:72px;border:1px solid #888;padding:8px',
    },
  },
  onUpdate({ editor: current }) {
    window.__chatModelText = current.state.doc.textBetween(0, current.state.doc.content.size, '\\n', '\\n')
  },
})

document.getElementById('fixture-send').addEventListener('click', () => {
  window.__sentDrafts.push(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\\n', '\\n'))
})
`

const LEXICAL_FIXTURE = `
import { createRoot } from 'react-dom/client'
import { memo, useEffect, useRef, useState } from 'react'
import {
  $createParagraphNode,
  $getRoot,
  createEditor,
} from 'lexical'
import { registerRichText } from '@lexical/rich-text'

const EditorHost = memo(function EditorHost({ editor }) {
  const ref = useRef(null)
  useEffect(() => {
    const node = ref.current
    if (node === null) return undefined
    editor.setRootElement(node)
    editor.update(() => {
      const paragraph = $createParagraphNode()
      const root = $getRoot()
      root.clear()
      root.append(paragraph)
      paragraph.selectEnd()
    })
    Object.defineProperty(window, '__chatModelText', { configurable: true, get: () => editor.getEditorState().read(() => $getRoot().getTextContent()) })
    return () => {
      editor.setRootElement(null)
    }
  }, [editor])
  return <div id="chat-editor" role="textbox" contentEditable={true} suppressContentEditableWarning={true} ref={ref} />
})

function App() {
  const [editor] = useState(() => {
    const instance = createEditor({
      namespace: 'fixture',
      nodes: [],
      onError(error) { throw error },
    })
    registerRichText(instance)
    return instance
  })
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  useEffect(() => {
    draftRef.current = draft
    window.__chatDraftState = draft
  }, [draft])
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const text = $getRoot().getTextContent()
        setDraft(text)
        window.__chatModelJson = editorState.toJSON()
      })
    })
  }, [editor])
  useEffect(() => {
    const button = document.getElementById('fixture-send')
    const onSend = () => {
      window.__sentDrafts = window.__sentDrafts || []
      window.__sentDrafts.push(draftRef.current)
    }
    button?.addEventListener('click', onSend)
    return () => button?.removeEventListener('click', onSend)
  }, [])
  return <EditorHost editor={editor} />
}

window.__sentDrafts = []
window.__chatModelText = ''
window.__chatDraftState = ''
createRoot(document.getElementById('react-root')).render(<App />)
`

const QUILL_FIXTURE = `
import { createRoot } from 'react-dom/client'
import Quill from 'quill'
import { memo, useEffect, useRef, useState } from 'react'

const EditorHost = memo(function EditorHost({ onReady, onDraft }) {
  const ref = useRef(null)
  useEffect(() => {
    const node = ref.current
    if (node === null) return undefined
    const quill = new Quill(node, { modules: { toolbar: false }, theme: null })
    Object.defineProperty(window, '__chatModelText', { configurable: true, get: () => quill.getText().slice(0, -1) })
    quill.root.id = 'chat-editor'
    quill.root.setAttribute('role', 'textbox')
    const publish = () => {
      const text = quill.getText().slice(0, -1)
      onDraft(text)
      window.__chatQuillText = quill.getText()
      window.__chatQuillContents = quill.getContents()
    }
    quill.on('text-change', publish)
    publish()
    onReady(quill)
    return () => {
      quill.off('text-change', publish)
    }
  }, [onDraft, onReady])
  return <div ref={ref} />
})

function App() {
  const [quill, setQuill] = useState(null)
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const readyRef = useRef(setQuill)
  const draftSink = useRef(setDraft)
  useEffect(() => {
    draftRef.current = draft
    window.__chatDraftState = draft
  }, [draft])
  useEffect(() => {
    const button = document.getElementById('fixture-send')
    const onSend = () => {
      window.__sentDrafts = window.__sentDrafts || []
      window.__sentDrafts.push(draftRef.current)
    }
    button?.addEventListener('click', onSend)
    return () => button?.removeEventListener('click', onSend)
  }, [])
  void quill
  return <EditorHost onReady={readyRef.current} onDraft={draftSink.current} />
}

window.__sentDrafts = []
window.__chatModelText = ''
window.__chatDraftState = ''
createRoot(document.getElementById('react-root')).render(<App />)
`

const ROOSTER_FIXTURE = `
import { createRoot } from 'react-dom/client'
import { createEditor, exportContent } from 'roosterjs'
import { memo, useEffect, useRef, useState } from 'react'

const EditorHost = memo(function EditorHost({ onReady, onDraft }) {
  const ref = useRef(null)
  useEffect(() => {
    const node = ref.current
    if (node === null) return undefined
    let current
    const observerPlugin = {
      getName: () => 'DraftObserver',
      initialize(editor) {
        current = editor
        onReady(editor)
      },
      dispose() {},
      onPluginEvent(event) {
        if ((event.eventType !== 'input' && event.eventType !== 'contentChanged') || current === undefined) return
        const text = exportContent(current, 'PlainText').replace(/\\r\\n?/g, '\\n')
        onDraft(text)
      },
    }
    const editor = createEditor(node, [observerPlugin])
    Object.defineProperty(window, '__chatModelText', { configurable: true, get: () => exportContent(editor, 'PlainText').replace(/\\r\\n?/g, '\\n') })
    node.id = 'chat-editor'
    node.setAttribute('role', 'textbox')
    if (current === undefined) onReady(editor)
    return () => {
      editor.dispose()
    }
  }, [onDraft, onReady])
  return <div ref={ref} />
})

function App() {
  const [editor, setEditor] = useState(null)
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const readyRef = useRef(setEditor)
  const draftSink = useRef(setDraft)
  useEffect(() => {
    draftRef.current = draft
    window.__chatDraftState = draft
  }, [draft])
  useEffect(() => {
    const button = document.getElementById('fixture-send')
    const onSend = () => {
      window.__sentDrafts = window.__sentDrafts || []
      window.__sentDrafts.push(draftRef.current)
    }
    button?.addEventListener('click', onSend)
    return () => button?.removeEventListener('click', onSend)
  }, [])
  void editor
  return <EditorHost onReady={readyRef.current} onDraft={draftSink.current} />
}

window.__sentDrafts = []
window.__chatModelText = ''
window.__chatDraftState = ''
createRoot(document.getElementById('react-root')).render(<App />)
`

async function bundleFixture(contents: string): Promise<string> {
  const built = await esbuild.build({
    stdin: {
      contents,
      resolveDir: process.cwd(),
      loader: 'tsx',
      sourcefile: 'managed-chat-fixture.tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
  })
  const code = built.outputFiles[0]?.text
  if (code === undefined || code.length === 0) throw new Error('empty managed chat fixture')
  return code
}

export async function bundleManagedChatFixture(kind: 'lexical' | 'quill' | 'rooster'): Promise<string> {
  if (kind === 'lexical') return bundleFixture(LEXICAL_FIXTURE)
  if (kind === 'quill') return bundleFixture(QUILL_FIXTURE)
  return bundleFixture(ROOSTER_FIXTURE)
}

export async function bundleProseMirrorFixture(): Promise<string> {
  const built = await esbuild.build({
    stdin: {
      contents: FIXTURE_SOURCE,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
  })
  const code = built.outputFiles[0]?.text
  if (code === undefined || code.length === 0) throw new Error('empty prose mirror fixture')
  return code
}

const DANMAKU_FIXTURE = `
import { createApp, ref, h } from 'vue'
window.__sentDrafts = []
const draft = ref('')
window.__chatDraftState = ''
window.__trustedInputCount = 0
createApp({
  setup() {
    const onInput = (event) => {
      if (event.isTrusted) window.__trustedInputCount += 1
      draft.value = event.target.value
      window.__chatDraftState = draft.value
    }
    const send = () => { window.__sentDrafts.push(draft.value) }
    return () => [
      h('input', { class: 'bpx-player-dm-input', id: 'chat-editor', value: draft.value, onInput }),
      h('button', { id: 'fixture-send', onClick: send }, 'Send'),
    ]
  },
}).mount('#vue-root')
Object.defineProperty(window, '__chatModelText', {
  configurable: true,
  get: () => draft.value,
})
`

export async function bundleDanmakuFixture(): Promise<string> {
  const built = await esbuild.build({
    stdin: {
      contents: DANMAKU_FIXTURE,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
  })
  const code = built.outputFiles[0]?.text
  if (code === undefined || code.length === 0) throw new Error('empty danmaku fixture')
  return code
}

