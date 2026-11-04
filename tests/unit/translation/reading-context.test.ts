import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectPageContext,
  readSelectionRange,
  readVisibleContext,
  selectionContext,
  isPageContext,
} from '../../../src/translation/reading-context'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
  )
  vi.spyOn(performance, 'now').mockImplementation(() => 0)
})
afterEach(() => vi.restoreAllMocks())

describe('reading-context', () => {
  it('共享主机校验接受真实 IPv6 hostname 并拒绝路径、端口与凭据', () => {
    for (const site of ['[::1]', 'example.com', 'localhost']) {
      expect(isPageContext({ title: '', heading: '', site })).toBe(true)
    }
    for (const site of ['[::1]:8000', 'example.com/path', 'user@example.com']) {
      expect(isPageContext({ title: '', heading: '', site })).toBe(false)
    }
  })

  it('透明子树和透明祖先不进入上下文、标题或有效选区', () => {
    document.body.innerHTML = '<h1 style="opacity:0">Private heading</h1><h1>Visible heading</h1><p>Visible text<span style="opacity:0">Private child</span><span style="opacity:0"><span id="secret">Private descendant</span></span></p>'
    expect(readVisibleContext(document.body, 1200)).not.toContain('Private')
    expect(collectPageContext().heading).toBe('Visible heading')
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('#secret')!)
    expect(readSelectionRange(range)).toBeUndefined()
  })

  it('context 跳过 hidden/data-sensitive/code/editable 子树', () => {
    document.body.innerHTML =
      '<p>Visible paragraph here.</p><p hidden>hidden text</p><p data-sensitive>secret text</p><pre>code text</pre><p contenteditable="plaintext-only">edit text</p>'
    const text = readVisibleContext(document.body, 1200)
    expect(text).toContain('Visible paragraph here.')
    expect(text).not.toContain('hidden text')
    expect(text).not.toContain('secret text')
    expect(text).not.toContain('code text')
    expect(text).not.toContain('edit text')
  })

  it('selection 命中排除子树返回 undefined', () => {
    document.body.innerHTML = '<div><p>good text here</p><p data-sensitive>bad text</p></div>'
    const range = document.createRange()
    range.selectNodeContents(document.body.firstElementChild!)
    expect(readSelectionRange(range)).toBeUndefined()
  })

  it('collectPageContext 取可见 h1 跳过隐藏', () => {
    document.body.innerHTML = '<h1 hidden>Hidden Title</h1><h1>Visible Heading</h1>'
    const ctx = collectPageContext()
    expect(ctx.heading).toBe('Visible Heading')
  })

  it('超大单文本 context 以选中位置为中心且 ≤1200', () => {
    document.body.innerHTML = '<p id="p"></p>'
    const p = document.getElementById('p')!
    p.textContent = 'x'.repeat(4000)
    const node = p.firstChild as Text
    const range = document.createRange()
    range.setStart(node, 2000)
    range.setEnd(node, 2050)
    const ctx = selectionContext(range, 1200)
    expect(ctx.length).toBe(1200)
    const offset = 2000 - Math.floor(1200 / 2)
    expect(ctx).toBe('x'.repeat(50) + 'x'.repeat(1150))
    void offset
  })

  it('6000 字符接受、6001 拒绝', () => {
    document.body.innerHTML = '<p></p>'
    const p = document.body.firstElementChild!
    p.textContent = 'a'.repeat(6001)
    const node = p.firstChild as Text
    const ok = document.createRange()
    ok.setStart(node, 0)
    ok.setEnd(node, 6000)
    expect(readSelectionRange(ok, 6000)?.length).toBe(6000)
    const bad = document.createRange()
    bad.setStart(node, 0)
    bad.setEnd(node, 6001)
    expect(readSelectionRange(bad, 6000)).toBeUndefined()
  })

  it('200 检查上限计入被拒绝节点并中断', () => {
    const parts: string[] = ['<div>']
    for (let i = 0; i < 300; i++) parts.push(`<p hidden>skip ${i}</p>`)
    parts.push('<p>tail paragraph</p></div>')
    document.body.innerHTML = parts.join('')
    const text = readVisibleContext(document.body, 1200)
    expect(text).not.toContain('tail paragraph')
  })
})
