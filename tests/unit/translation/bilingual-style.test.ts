import { describe, expect, it } from 'vitest'
import { BILINGUAL_STYLE_ATTR, ensureBilingualStyle } from '../../../src/translation/bilingual'

describe.each(['document', 'shadow'] as const)('双语样式表 %s', (kind) => {
  it('共存旧表与同名页面样式；再次附加不重复，移除新版表后能重新安装', () => {
    const doc = document
    const shadow = kind === 'shadow' ? doc.body.appendChild(doc.createElement('div')).attachShadow({ mode: 'open' }) : undefined
    const container = shadow ?? doc.head
    const target = (shadow ?? doc.body).appendChild(doc.createElement('p'))
    const old = container.appendChild(doc.createElement('style'))
    old.setAttribute(BILINGUAL_STYLE_ATTR, '1')
    old.textContent = '[data-wt-bilingual="1"] { display: block; }'
    const pageStyle = container.appendChild(doc.createElement('style'))
    pageStyle.setAttribute(BILINGUAL_STYLE_ATTR, '1')
    pageStyle.textContent = 'p { margin: 2px; }'

    const sheets = () => [...container.querySelectorAll('style')]
    ensureBilingualStyle(target)
    ensureBilingualStyle(target)
    expect(sheets()).toHaveLength(3)
    const current = sheets()[2]!
    expect(current.textContent).toContain('data-wt-bilingual-variant="underline"')
    expect(old.textContent).toBe('[data-wt-bilingual="1"] { display: block; }')
    expect(pageStyle.textContent).toBe('p { margin: 2px; }')

    current.remove()
    const reinserted = container.appendChild(current.cloneNode(true) as HTMLStyleElement)
    ensureBilingualStyle(target)
    expect(sheets()).toEqual([old, pageStyle, reinserted])
    reinserted.remove()
    ensureBilingualStyle(target)
    expect(sheets()).toHaveLength(3)
    expect(sheets()[2]!.textContent).toBe(current.textContent)
  })
})
