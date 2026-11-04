import { describe, expect, it } from 'vitest'
import { inlineUnitFor, parseInlineResult, type InlineUnit } from '../../../src/translation/inline-units'
import { MAX_MODEL_TEXT } from '../../../src/translation/sites'

const noExclude = { isExcluded: (): false => false }

function para(html: string): { text: () => Text; root: HTMLElement } {
  document.body.innerHTML = html
  const root = document.body.firstElementChild as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) if ((n.nodeValue ?? '').trim() !== '') texts.push(n as Text)
  return { text: () => texts[0]!, root }
}

describe('inlineUnitFor 序列化', () => {
  it('嵌套 a>strong：成对标签可嵌套', () => {
    const { text } = para('<p>Click <a>x<strong>y</strong>z</a>.</p>')
    const unit = inlineUnitFor(text(), noExclude)!
    expect(unit.template).toBe('Click <1>x<2>y</2>z</1>.')
    expect(unit.nodes).toHaveLength(5)
  })

  it('code 变独立占位，文本不进 nodes', () => {
    const { text } = para('<p>Run <code>npm i</code> now please.</p>')
    const unit = inlineUnitFor(text(), noExclude)!
    expect(unit.template).toBe('Run <1/> now please.')
    expect(unit.nodes).toHaveLength(2)
  })

  it('空白节点原样写入模板，不计入 nodes', () => {
    const { text } = para('<p> a <b>b</b> </p>')
    const unit = inlineUnitFor(text(), noExclude)!
    expect(unit.template).toBe(' a <1>b</1> ')
    expect(unit.nodes).toHaveLength(2)
  })

  it('单个文本节点不成单元', () => {
    const { root } = para('<p><a>only</a></p>')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    expect(inlineUnitFor(walker.nextNode() as Text, noExclude)).toBeUndefined()
  })

  it('块内出现非行内元素（div）不成单元', () => {
    document.body.innerHTML = '<p>Click <div>block</div></p>'
    const walker = document.createTreeWalker(document.body.firstElementChild!, NodeFilter.SHOW_TEXT)
    expect(inlineUnitFor(walker.nextNode() as Text, noExclude)).toBeUndefined()
  })

  it('冻结节点（isFrozen）变独立占位，文本不发送、不计入 nodes', () => {
    document.body.innerHTML = '<p>Already <a>translated</a> and <b>fresh</b> text.</p>'
    const p = document.body.firstElementChild!
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) texts.push(n as Text)
    const frozen = texts.find((t) => t.nodeValue === 'translated')!
    const unit = inlineUnitFor(texts[0]!, {
      isExcluded: () => false,
      isFrozen: (t) => t === frozen,
    })!
    expect(unit.template).toBe('Already <1><2/></1> and <3>fresh</3> text.')
    expect(unit.nodes).toHaveLength(4)
    expect(unit.sources).not.toContain('translated')
    const segs = parseInlineResult('已<1><2/></1>和<3>新</3>文字。', unit)!
    expect(segs).toHaveLength(4)
  })

  it('冻结后剩余节点 < 2 → undefined', () => {
    document.body.innerHTML = '<p><a>x</a> only</p>'
    const p = document.body.firstElementChild!
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) texts.push(n as Text)
    expect(inlineUnitFor(texts[0]!, { isExcluded: () => false, isFrozen: (t) => t === texts[1] })).toBeUndefined()
  })

  it('超过 MAX_MODEL_TEXT 不成单元', () => {
    const { text } = para(`<p>${'x'.repeat(MAX_MODEL_TEXT - 5)} <a>y</a></p>`)
    expect(inlineUnitFor(text(), noExclude)).toBeUndefined()
  })
})

describe('inlineUnitFor 界限', () => {
  it('递归深度超限 → undefined', () => {
    let inner = 'x'
    for (let i = 0; i < 40; i += 1) inner = `<span>${inner}</span>`
    document.body.innerHTML = `<p>${inner} and tail</p>`
    const walker = document.createTreeWalker(document.body.firstElementChild!, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode() as Text
    expect(inlineUnitFor(node, noExclude)).toBeUndefined()
  })

  it('累计节点超 200 → undefined', () => {
    const spans = Array.from({ length: 210 }, (_, i) => `<a>w${i}</a>`).join(' ')
    document.body.innerHTML = `<p>text ${spans}</p>`
    const walker = document.createTreeWalker(document.body.firstElementChild!, NodeFilter.SHOW_TEXT)
    expect(inlineUnitFor(walker.nextNode() as Text, noExclude)).toBeUndefined()
  })
})

describe('parseInlineResult', () => {
  const unit = (): InlineUnit => {
    const { text } = para('<p>Click <a>here</a> to <b>continue</b>.</p>')
    return inlineUnitFor(text(), noExclude)!
  }

  it('正确回填到各文本节点', () => {
    const segs = parseInlineResult('点击<1>这里</1>以<2>继续</2>。', unit())!
    expect(segs).toEqual(['点击', '这里', '以', '继续', '。'])
  })

  it('标签缺失/重复/嵌套错/未知标签 → undefined', () => {
    const u = unit()
    expect(parseInlineResult('点击<1>这里</1>以继续。', u)).toBeUndefined()
    expect(parseInlineResult('点击<1>这里</1><1>再</1>以<2>继续</2>。', u)).toBeUndefined()
    expect(parseInlineResult('点击<1>这里<2>继续</1></2>。', u)).toBeUndefined()
    expect(parseInlineResult('点击<1>这里</1>以<9>继续</9>。', u)).toBeUndefined()
  })

  it('独立占位缺失 → undefined', () => {
    const { text } = para('<p>Run <code>x</code> now please.</p>')
    const u = inlineUnitFor(text(), noExclude)!
    expect(parseInlineResult('运行<1/>现在请。', u)).toEqual(['运行', '现在请。'])
    expect(parseInlineResult('运行现在请。', u)).toBeUndefined()
  })

  it('标签顺序调换 → undefined（不允许移动占位，真实 DOM 不会移动）', () => {
    const { text } = para('<p>先点<a>这里</a><b>继续</b></p>')
    const u = inlineUnitFor(text(), noExclude)!
    expect(parseInlineResult('<2>继续</2>之前先点<1>这里</1>', u)).toBeUndefined()
  })

  it('自闭合标签被挪动位置 → undefined', () => {
    const { text } = para('<p>Run <a>x</a> <code>y</code> now.</p>')
    const u = inlineUnitFor(text(), noExclude)!
    expect(parseInlineResult('运行<2/>现在<1>是</1>。', u)).toBeUndefined()
  })
})
