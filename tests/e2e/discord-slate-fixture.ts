import * as esbuild from 'esbuild'

const FIXTURE_SOURCE = `
import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createEditor, Node } from 'slate'
import { Editable, Slate, withReact } from 'slate-react'

const SENTINEL = 'CHAT_HISTORY_SENTINEL'

function modelText(editor) {
  return editor.children.map((node) => Node.string(node)).join('\\n')
}

function App() {
  const editor = useMemo(() => withReact(createEditor()), [])
  const [value, setValue] = useState(() => [{ type: 'paragraph', children: [{ text: '' }] }])
  window.__renderCount = (window.__renderCount || 0) + 1
  window.__discordModelText = modelText(editor)
  window.__sentDrafts = window.__sentDrafts || []
  return (
    <div>
      <p id="history">{SENTINEL}</p>
      <Slate
        editor={editor}
        value={value}
        onChange={(next) => {
          window.__discordModelText = modelText(editor)
          setValue(next)
        }}
      >
        <Editable
          id="discord-editor"
          role="textbox"
          aria-label="Message"
          placeholder="输入消息"
          style={{ minHeight: '72px', border: '1px solid #888', padding: '8px' }}
        />
      </Slate>
      <div style={{ marginTop: 200 }}>
        <button id="fixture-send" type="button" onClick={() => { window.__sentDrafts.push(modelText(editor)) }}>Send</button>
        <button id="outside" type="button">Outside</button>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
`

export async function bundleDiscordSlateFixture(): Promise<string> {
  const built = await esbuild.build({
    stdin: {
      contents: FIXTURE_SOURCE,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  const code = built.outputFiles[0]?.text
  if (code === undefined || code.length === 0) throw new Error('empty discord slate fixture')
  return code
}
