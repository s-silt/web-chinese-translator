import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTESTED, createRecordStore, type RecordStore } from '../../../src/core/records'
import { textOwnership } from '../../../src/shared/text-ownership'

/** 临时改 document.readyState；afterEach 删除覆盖，恢复原有的值 */
function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => state })
}

/** 同一父元素下依次排列的文本节点 */
function textsIn(...values: string[]): Text[] {
  const parent = document.createElement('p')
  const nodes = values.map((value) => document.createTextNode(value))
  parent.append(...nodes)
  return nodes
}

let records: RecordStore

beforeEach(() => {
  records = createRecordStore(() => 0)
})

afterEach(() => {
  Reflect.deleteProperty(document, 'readyState')
})

describe('textSource：文档解析中，解析器追加到已写入节点', () => {
  beforeEach(() => setReadyState('loading'))

  it('已译节点追加英文或空白：原文为记录的原文加追加部分，记录清除', () => {
    const [node] = textsIn('Edit') as [Text]
    records.writeText(node, 'Edit', '编辑')
    node.appendData(' file')
    expect(records.textSource(node)).toBe('Edit file')
    expect(records.hasText(node)).toBe(false)
    records.writeText(node, 'Edit file', '编辑文件')
    node.appendData('\n  ')
    expect(records.textSource(node)).toBe('Edit file\n  ')
  })

  it.each([
    ['连字符加数字', '-2'],
    ['数字', '123'],
    ['非 ASCII 字母', 'é'],
    ['组合附加符号', '\u0301'],
    ['下划线', '_'],
  ])('已译节点追加%s：按原文加追加部分重译，记录清除', (_, extra) => {
    const [node] = textsIn('Opened by octocat') as [Text]
    records.writeText(node, 'Opened by octocat', '由 octocat 打开')
    node.appendData(extra)
    expect(records.textSource(node)).toBe(`Opened by octocat${extra}`)
    expect(records.hasText(node)).toBe(false)
  })

  it('已译节点只追加标点、符号：返回 CONTESTED，显示不变，记录改为追加后的原文', () => {
    const [node] = textsIn('Edit') as [Text]
    records.writeText(node, 'Edit', '编辑')
    node.appendData('…')
    expect(records.textSource(node)).toBe(CONTESTED)
    expect(node.data).toBe('编辑…')
    expect(records.ownText(node)).toBe(true)
    expect(records.textSource(node)).toBe('Edit…')
    node.appendData(' →')
    expect(records.textSource(node)).toBe(CONTESTED)
    records.restoreText(node)
    expect(node.data).toBe('Edit… →')
    expect(records.hasText(node)).toBe(false)
  })

  it('译文以原文开头（双语词条）：追加部分接在译文之后，按追加处理', () => {
    const [node] = textsIn('Edit') as [Text]
    records.writeText(node, 'Edit', 'Edit 编辑')
    node.appendData(' file')
    expect(records.textSource(node)).toBe('Edit file')
    expect(records.hasText(node)).toBe(false)
  })

  it('置空的末节点：当前文字全是追加部分，原文为记录的原文加当前文字', () => {
    const [, last] = textsIn('Opened by ', 'octo') as [Text, Text]
    records.writeText(last, 'octo', '')
    last.appendData('cat')
    expect(records.textSource(last)).toBe('octocat')
    expect(records.hasText(last)).toBe(false)
    // 置空节点不显示文字，追加标点也按原文加追加部分处理
    records.writeText(last, 'octocat', '')
    last.appendData('!')
    expect(records.textSource(last)).toBe('octocat!')
  })

  it('置空的末节点：追加的文字以原文开头或等于原文也是追加，不按改回计数', () => {
    const [, last] = textsIn('Showing 5 of ', '1') as [Text, Text]
    records.writeText(last, '1', '')
    last.appendData('12')
    expect(records.textSource(last)).toBe('112')
    const [, other] = textsIn('Opened by ', '1') as [Text, Text]
    records.writeText(other, '1', '')
    other.appendData('1')
    expect(records.textSource(other)).toBe('11')
    expect(records.hasText(other)).toBe(false)
  })

  it('置空时是最后一个子节点：追加后同一任务内又插入兄弟，仍按追加处理', () => {
    const [, last] = textsIn('Opened by ', 'octo') as [Text, Text]
    records.writeText(last, 'octo', '')
    last.appendData('cat')
    last.after(document.createComment(' '), document.createTextNode(' (2)'))
    expect(records.textSource(last)).toBe('octocat')
    // 再次置空时已不是最后一个子节点：解析器不会再往其中追加
    records.writeText(last, 'octocat', '')
    last.data = 'hubot'
    expect(records.textSource(last)).toBe('hubot')
  })

  it('置空节点不是最后一个子节点：解析器不会追加，按外部改写或改回处理', () => {
    const [, middle] = textsIn('Opened by ', 'octocat', ' ') as [Text, Text, Text]
    records.writeText(middle, 'octocat', '')
    middle.data = 'octocat'
    expect(records.textSource(middle)).toBe('octocat')
    expect(records.hasText(middle)).toBe(true)
    middle.data = 'hubot'
    expect(records.textSource(middle)).toBe('hubot')
    expect(records.hasText(middle)).toBe(false)
  })

  it('译文是原文前缀、当前文字以原文开头（页面写回原文加后缀）：按外部改写处理，不拼接', () => {
    const [node] = textsIn('Webhooks') as [Text]
    records.writeText(node, 'Webhooks', 'Webhook')
    node.data = 'Webhooks (2)'
    expect(records.textSource(node)).toBe('Webhooks (2)')
    expect(records.hasText(node)).toBe(false)
  })

  it('不以译文开头：按外部改写处理', () => {
    const [node] = textsIn('Edit') as [Text]
    records.writeText(node, 'Edit', '编辑')
    node.data = 'Save'
    expect(records.textSource(node)).toBe('Save')
    expect(records.hasText(node)).toBe(false)
  })

  it('被改回原文仍按改回计数', () => {
    const [node] = textsIn('Edit') as [Text]
    records.writeText(node, 'Edit', '编辑')
    node.data = 'Edit'
    expect(records.textSource(node)).toBe('Edit')
    expect(records.hasText(node)).toBe(true)
  })
})

describe('textSource：解析结束后', () => {
  it.each(['interactive', 'complete'] as const)('%s：追加也按外部改写处理，当前值成为新原文', (state) => {
    setReadyState(state)
    const [node] = textsIn('Edit') as [Text]
    records.writeText(node, 'Edit', '编辑')
    node.appendData(' file')
    expect(records.textSource(node)).toBe('编辑 file')
    expect(records.hasText(node)).toBe(false)
    const [, last] = textsIn('Opened by ', 'octo') as [Text, Text]
    records.writeText(last, 'octo', '')
    last.data = 'hubot'
    expect(records.textSource(last)).toBe('hubot')
  })

  it('置空的末节点被写回原文：按改回计数', () => {
    setReadyState('complete')
    const [, last] = textsIn('Opened by ', 'octo') as [Text, Text]
    records.writeText(last, 'octo', '')
    last.data = 'octo'
    expect(records.textSource(last)).toBe('octo')
    expect(records.hasText(last)).toBe(true)
  })
})

describe('文本所有权登记', () => {
  it('writeText 译文后 ownerOf 为 github；写回原文、restoreText、外部改写后均为 undefined', () => {
    setReadyState('complete')
    const ownership = textOwnership()
    const [node] = textsIn('Issues') as [Text]

    records.writeText(node, 'Issues', '议题')
    expect(ownership.ownerOf(node)).toBe('github')

    records.writeText(node, 'Issues', 'Issues')
    expect(ownership.ownerOf(node)).toBeUndefined()

    records.writeText(node, 'Issues', '议题')
    expect(ownership.ownerOf(node)).toBe('github')
    records.restoreText(node)
    expect(node.data).toBe('Issues')
    expect(ownership.ownerOf(node)).toBeUndefined()

    records.writeText(node, 'Issues', '议题')
    expect(ownership.ownerOf(node)).toBe('github')
    node.data = 'Pull requests'
    expect(records.textSource(node)).toBe('Pull requests')
    expect(ownership.ownerOf(node)).toBeUndefined()
  })

  it('web 所有权阻止 textSource、writeText、restoreText；页面外部改写后恢复处理', () => {
    setReadyState('complete')
    const ownership = textOwnership()
    const [node] = textsIn('Issues') as [Text]

    records.writeText(node, 'Issues', '议题')
    ownership.claim(node, 'web', '问题')
    node.data = '问题'

    expect(records.textSource(node)).toBe(CONTESTED)
    expect(records.ownText(node)).toBe(false)

    records.writeText(node, '问题', '被覆盖')
    expect(node.data).toBe('问题')
    expect(ownership.ownerOf(node)).toBe('web')
    expect(records.hasText(node)).toBe(false)

    records.restoreText(node)
    expect(node.data).toBe('问题')
    expect(ownership.ownerOf(node)).toBe('web')

    node.data = 'Pull requests'
    expect(ownership.ownerOf(node)).toBeUndefined()
    expect(records.textSource(node)).toBe('Pull requests')
    records.writeText(node, 'Pull requests', '拉取请求')
    expect(node.data).toBe('拉取请求')
    expect(ownership.ownerOf(node)).toBe('github')
  })

  it('clear 仅使当前 store 的脱离节点登记失效，不影响第二个 store 与 web 登记', () => {
    setReadyState('complete')
    const ownership = textOwnership()
    const otherStore = createRecordStore(() => 0)
    const [detached, otherNode, webNode] = textsIn('Issues', 'Pull requests', 'Settings') as [Text, Text, Text]

    records.writeText(detached, 'Issues', '议题')
    detached.remove()
    otherStore.writeText(otherNode, 'Pull requests', '拉取请求')
    ownership.claim(webNode, 'web', '设置')
    webNode.data = '设置'

    records.clear()
    expect(ownership.ownerOf(detached)).toBeUndefined()
    expect(ownership.ownerOf(otherNode)).toBe('github')
    expect(ownership.ownerOf(webNode)).toBe('web')

    const [fresh] = textsIn('Search') as [Text]
    records.writeText(fresh, 'Search', '搜索')
    expect(ownership.ownerOf(fresh)).toBe('github')
  })
})
