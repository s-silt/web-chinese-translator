// @vitest-environment-options { "url": "https://github.com/vuejs/core/issues" }
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TRANSLATABLE_ATTRIBUTES } from '../../../src/core/ignore'
import { createTranslator, type Translator, type TranslatorOptions } from '../../../src/core/translator'
import type { LocaleBundle } from '../../../src/core/types'
import { textOwnership } from '../../../src/shared/text-ownership'
import { $, settle, TEST_BUNDLE, testMatcher, texts } from './helpers'

const HOME = '/vuejs/core/issues'
let translator: Translator | undefined

function start(html: string, options: Partial<TranslatorOptions> = {}): Translator {
  document.body.innerHTML = html
  translator = createTranslator({ matcher: testMatcher(), host: window, ...options })
  translator.start()
  return translator
}

afterEach(() => {
  translator?.stop()
  translator = undefined
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  history.replaceState(null, '', HOME)
})

describe('文本节点', () => {
  it('翻译文本并保留首尾空白', () => {
    start('<p id="a">\n    Issues  \n</p><p id="b">Pull requests</p>')
    expect($('#a').textContent).toBe('\n    议题  \n')
    expect($('#b').textContent).toBe('拉取请求')
  })

  it('未命中、纯中文、纯数字保持原样', () => {
    start('<p id="a">Unknown words</p><p id="b">已是中文</p><p id="c">12345</p>')
    expect($('#a').textContent).toBe('Unknown words')
    expect($('#b').textContent).toBe('已是中文')
    expect($('#c').textContent).toBe('12345')
  })

  it('按当前页面类型使用 scoped 词条', () => {
    start('<button>Open</button>')
    expect($('button').textContent).toBe('未解决')
  })

  it('正则规则', () => {
    start('<span>12 comments</span>')
    expect($('span').textContent).toBe('12 条评论')
  })
})

describe('属性', () => {
  it('翻译可翻译属性并保留空白', () => {
    start(`<button aria-label="Copy" title=" Close " data-confirm="Are you sure?" data-disable-with="Saving…"></button>
      <input placeholder="Search"><select><optgroup label="Newest"></optgroup></select>`)
    const button = $('button')
    expect(button.getAttribute('aria-label')).toBe('复制')
    expect(button.getAttribute('title')).toBe(' 关闭 ')
    expect(button.getAttribute('data-confirm')).toBe('确定吗？')
    expect(button.getAttribute('data-disable-with')).toBe('保存中…')
    expect($('input').getAttribute('placeholder')).toBe('搜索')
    expect($('optgroup').getAttribute('label')).toBe('最新')
  })

  it('只翻译按钮类 input 的 value', () => {
    start(`<input id="s" type="submit" value="Submit"><input id="b" type="BUTTON" value="Cancel">
      <input id="r" type="reset" value="Close"><input id="t" type="text" value="Search"><input id="n" value="Search">`)
    expect($('#s').getAttribute('value')).toBe('提交')
    expect($('#b').getAttribute('value')).toBe('取消')
    expect($('#r').getAttribute('value')).toBe('关闭')
    expect($('#t').getAttribute('value')).toBe('Search')
    expect($('#n').getAttribute('value')).toBe('Search')
  })

  it('不处理其他属性', () => {
    start('<a href="Search" data-foo="Search" alt="Search">x</a>')
    const link = $('a')
    expect(link.getAttribute('href')).toBe('Search')
    expect(link.getAttribute('data-foo')).toBe('Search')
    expect(link.getAttribute('alt')).toBe('Search')
  })
})

describe('提示框可见文字 data-visible-text', () => {
  const custom = { 'Open pull request': '打开的拉取请求', 'Merged pull request': '已合并的拉取请求', Docs: '文档' }
  const tooltip = (id: string, text: string, extra = ''): string =>
    `<span id="${id}" role="tooltip" aria-label="${text}" data-visible-text="${text}" ${extra}></span>`

  it('与 aria-label 一起翻译；外部改写后重译；stop 后还原', async () => {
    const t = start(`<div id="__primerPortalRoot__">${tooltip('pr', 'Open pull request')}</div>`, {
      matcher: testMatcher({ custom }),
    })
    const pr = $('#pr')
    expect([pr.getAttribute('aria-label'), pr.getAttribute('data-visible-text')]).toEqual([
      '打开的拉取请求',
      '打开的拉取请求',
    ])
    pr.setAttribute('data-visible-text', 'Merged pull request')
    t.flush()
    expect(pr.getAttribute('data-visible-text')).toBe('已合并的拉取请求')
    t.stop()
    expect([pr.getAttribute('aria-label'), pr.getAttribute('data-visible-text')]).toEqual([
      'Open pull request',
      'Merged pull request',
    ])
  })

  it('文件树名称提示与忽略区域内的提示不翻译', () => {
    start(
      `${tooltip('dir', 'Docs', 'data-testid="Docs-directory-item-tooltip"')}
      ${tooltip('file', 'Docs', 'data-testid="Docs-item-tooltip"')}
      ${tooltip('settings', 'Settings', 'data-testid="Settings-directory-item-tooltip"')}
      <div class="markdown-body">${tooltip('md', 'Open pull request')}</div>`,
      { matcher: testMatcher({ custom }) },
    )
    const cases: readonly (readonly [string, string])[] = [
      ['#dir', 'Docs'],
      ['#file', 'Docs'],
      ['#settings', 'Settings'],
    ]
    for (const [id, name] of cases) {
      expect([$(id).getAttribute('aria-label'), $(id).getAttribute('data-visible-text')]).toEqual([name, name])
    }
    expect($('#md').getAttribute('data-visible-text')).toBe('Open pull request')
  })

  it('采集脚本使用同一属性清单', () => {
    expect(TRANSLATABLE_ATTRIBUTES).toContain('data-visible-text')
  })
})

describe('脚本原样显示的确认文字属性', () => {
  const custom = {
    'Are you sure you want to discard your unsaved changes?': '确定要放弃未保存的更改吗？',
    'You have unsaved changes. Are you sure you want to discard them?': '有未保存的更改，确定放弃吗？',
    'Changes you made will not be saved.': '所做的更改不会保存。',
    'Would you like to add a reaction instead?': '改为添加表情回应？',
  }

  it('confirm 文字、未保存提醒、表情回应建议都翻译；stop 后还原', () => {
    const t = start(
      `<button id="a" data-confirm-text="Are you sure you want to discard your unsaved changes?">Cancel</button>
      <button id="b" data-confirm-cancel-text="You have unsaved changes. Are you sure you want to discard them?">Cancel</button>
      <form id="c" data-warn-unsaved-changes="Changes you made will not be saved."></form>
      <div id="d" class="js-reaction-suggestion" data-reaction-markup="Would you like to add a reaction instead?"></div>`,
      { matcher: testMatcher({ custom }) },
    )
    expect($('#a').getAttribute('data-confirm-text')).toBe('确定要放弃未保存的更改吗？')
    expect($('#b').getAttribute('data-confirm-cancel-text')).toBe('有未保存的更改，确定放弃吗？')
    expect($('#c').getAttribute('data-warn-unsaved-changes')).toBe('所做的更改不会保存。')
    expect($('#d').getAttribute('data-reaction-markup')).toBe('改为添加表情回应？')
    t.stop()
    expect($('#c').getAttribute('data-warn-unsaved-changes')).toBe('Changes you made will not be saved.')
    expect($('#d').getAttribute('data-reaction-markup')).toBe('Would you like to add a reaction instead?')
  })

  it('外部改写后重译；未命中时按属性记入未翻译；空值不处理', () => {
    const t = start(
      '<form id="c" data-warn-unsaved-changes=""></form><button id="a" data-confirm-text="Discard?"></button>',
      {
        matcher: testMatcher({ custom }),
        collectUntranslated: true,
      },
    )
    expect($('#c').getAttribute('data-warn-unsaved-changes')).toBe('')
    expect(t.drainUntranslated()).toEqual([['Discard?', 'issues', 2, 1, 1]])
    $('#a').setAttribute('data-confirm-text', 'Are you sure you want to discard your unsaved changes?')
    t.flush()
    expect($('#a').getAttribute('data-confirm-text')).toBe('确定要放弃未保存的更改吗？')
  })
})

describe('忽略区域', () => {
  it('IGNORE_TAGS 跳过子树，但处理元素自身属性', () => {
    start(`<textarea placeholder="Search">Issues</textarea><pre>Issues</pre><code title="Copy">Issues</code>
      <svg aria-label="Star"><title>Star</title><text>Issues</text></svg>`)
    expect($('textarea').getAttribute('placeholder')).toBe('搜索')
    expect($('textarea').textContent).toBe('Issues')
    expect($('pre').textContent).toBe('Issues')
    expect($('code').getAttribute('title')).toBe('复制')
    expect($('code').textContent).toBe('Issues')
    expect($('svg').getAttribute('aria-label')).toBe('星标')
    expect($('svg').textContent).toBe('StarIssues')
  })

  it('react-app 内的 JSON 数据不改动', () => {
    const json = '{"payload":{"title":"Issues","label":"Open"}}'
    start(`<react-app app-name="repo"><script type="application/json" data-target="react-app.embeddedData">${json}</script>
      <div data-target="react-app.reactRoot"><span>Issues</span></div></react-app>`)
    expect($('script').textContent).toBe(json)
    expect($('react-app span').textContent).toBe('议题')
  })

  it('IGNORE_SELECTORS 整块跳过（含属性）', () => {
    start(`<div class="markdown-body" title="Close"><p>Issues</p><button aria-label="Copy">Search</button></div>
      <p translate="no">Issues</p><p class="notranslate">Issues</p>
      <a data-hovercard-type="user" href="/u" aria-label="Settings">Settings</a><span>Issues</span>`)
    expect($('.markdown-body').getAttribute('title')).toBe('Close')
    expect($('.markdown-body p').textContent).toBe('Issues')
    expect($('.markdown-body button').getAttribute('aria-label')).toBe('Copy')
    expect($('[translate="no"]').textContent).toBe('Issues')
    expect($('.notranslate').textContent).toBe('Issues')
    expect($('a').textContent).toBe('Settings')
    expect($('a').getAttribute('aria-label')).toBe('Settings')
    expect($('span').textContent).toBe('议题')
  })

  it('页面词典的 ignore 只在对应页面生效', () => {
    start('<div class="issue-user-content"><span>Issues</span></div>')
    expect($('.issue-user-content span').textContent).toBe('Issues')
  })

  it('快速搜索叠加层：查询回显不翻译，输入时改写的文字也不翻译；占位符与同一弹层的建议照常', async () => {
    start(`<div role="dialog">
      <div class="inputOverlay__K9QHpO" aria-hidden="true" data-testid="quick-search-input-overlay"><span id="echo">Settings</span></div>
      <input type="text" role="combobox" placeholder="Search" value="Settings">
      <a role="option" href="/issues"><span id="option">Issues</span></a>
    </div>`)
    expect($('#echo').textContent).toBe('Settings')
    expect($('input').getAttribute('placeholder')).toBe('搜索')
    expect($('#option').textContent).toBe('议题')
    ;($('#echo').firstChild as Text).data = 'Issues'
    await settle()
    expect($('#echo').textContent).toBe('Issues')
  })

  it('head 内只处理标题', () => {
    document.head.innerHTML = '<meta name="description" content="Issues"><style>.Issues{}</style>'
    start('<p>Issues</p>')
    expect(document.head.querySelector('style')!.textContent).toBe('.Issues{}')
  })
})

describe('动态变化', () => {
  it('翻译新插入的元素与文本节点', async () => {
    start('<main></main>')
    const main = $('main')
    main.insertAdjacentHTML('beforeend', '<button aria-label="Copy">Search</button>')
    main.append(document.createTextNode(' Issues '))
    await settle()
    expect($('main button').textContent).toBe('搜索')
    expect($('main button').getAttribute('aria-label')).toBe('复制')
    expect(texts(main)).toEqual([' 议题 '])
  })

  it('插入到忽略区域内的内容不翻译', async () => {
    start('<div class="markdown-body"></div><pre></pre><textarea></textarea>')
    $('.markdown-body').insertAdjacentHTML('beforeend', '<p title="Copy">Issues</p>')
    $('pre').append('Issues')
    $('textarea').append('Issues')
    await settle()
    expect($('.markdown-body p').textContent).toBe('Issues')
    expect($('.markdown-body p').getAttribute('title')).toBe('Copy')
    expect($('pre').textContent).toBe('Issues')
    expect($('textarea').textContent).toBe('Issues')
  })

  it('外部改写文本后用新原文重译（模拟 React 重渲染）', async () => {
    start('<span>Issues</span>')
    const node = $('span').firstChild as Text
    expect(node.data).toBe('议题')
    node.data = 'Pull requests'
    await settle()
    expect(node.data).toBe('拉取请求')
    node.data = 'Not in dictionary'
    await settle()
    expect(node.data).toBe('Not in dictionary')
  })

  it('React 以 textContent 替换文本节点后重译', async () => {
    start('<span>Issues</span>')
    $('span').textContent = 'Search'
    await settle()
    expect($('span').textContent).toBe('搜索')
  })

  it('属性被外部改写后重译', async () => {
    start('<button aria-label="Copy"></button>')
    const button = $('button')
    button.setAttribute('aria-label', 'Copied!')
    await settle()
    expect(button.getAttribute('aria-label')).toBe('已复制！')
    button.setAttribute('aria-label', 'Copy')
    await settle()
    expect(button.getAttribute('aria-label')).toBe('复制')
    button.setAttribute('title', 'Close')
    await settle()
    expect(button.getAttribute('title')).toBe('关闭')
  })

  it('按钮 value 被改写后重译', async () => {
    start('<input type="submit" value="Submit">')
    $('input').setAttribute('value', 'Cancel')
    await settle()
    expect($('input').getAttribute('value')).toBe('取消')
  })

  it('自身写入不重复处理，回调次数有界', async () => {
    const t = start('<span>Issues</span><span id="b">Search</span>')
    const node = $('span').firstChild as Text
    await settle()
    const before = t.batches
    node.data = 'Pull requests'
    await settle()
    await settle()
    expect(node.data).toBe('拉取请求')
    // 一次外部改写 + 一次自身写入
    expect(t.batches - before).toBeLessThanOrEqual(2)
    const stable = t.batches
    await settle()
    expect(t.batches).toBe(stable)
  })

  it('flush 立即处理尚未回调的变动', () => {
    const t = start('<main></main>')
    $('main').append('Issues')
    t.flush()
    expect($('main').textContent).toBe('议题')
    t.flush()
  })
})

describe('与 React 共存', () => {
  it('不插入、删除、替换节点', () => {
    const html =
      '<div><span>Updated <!-- -->3<!-- --> days ago</span><b>Issues</b> Search<!-- --> <i title="Copy">x</i></div>'
    document.body.innerHTML = html
    const before = [...document.body.querySelectorAll('*')].map((el) => [...el.childNodes])
    translator = createTranslator({ matcher: testMatcher(), host: window })
    translator.start()
    const after = [...document.body.querySelectorAll('*')].map((el) => [...el.childNodes])
    expect(after).toHaveLength(before.length)
    after.forEach((children, i) => {
      expect(children).toHaveLength(before[i]!.length)
      children.forEach((child, j) => expect(child).toBe(before[i]![j]))
    })
  })

  it('React 持有节点引用后 removeChild / insertBefore 不报错', async () => {
    start('<p><span>Updated <!-- -->3<!-- --> days ago</span><b>Issues</b>Search</p>')
    const span = $('span')
    const [first, , middle, , last] = [...span.childNodes]
    const paragraph = $('p')
    const bold = $('b')
    const tail = paragraph.lastChild!
    expect(() => {
      span.removeChild(middle!)
      span.insertBefore(document.createTextNode('5'), last!)
      span.removeChild(first!)
      paragraph.insertBefore(document.createElement('hr'), bold)
      paragraph.removeChild(tail)
      paragraph.replaceChild(document.createTextNode('Close'), bold)
    }).not.toThrow()
    await settle()
    expect(paragraph.textContent).toContain('关闭')
  })
})

describe('相邻文本节点', () => {
  it('拼接整体匹配：译文写入第一个节点，其余置空', () => {
    start('<span>Updated <!-- -->3<!-- --> days ago</span>')
    const span = $('span')
    expect(texts(span)).toEqual(['3天前更新', '', ''])
    expect(span.childNodes).toHaveLength(5)
  })

  it('含用户名的拼接匹配', () => {
    start('<span>Opened by <!-- -->octocat</span>')
    expect(texts($('span'))).toEqual(['由 octocat 打开', ''])
  })

  it('组内任一节点被外部改写时用最新原文重算整组', async () => {
    start('<span>Updated <!-- -->3<!-- --> days ago</span>')
    const span = $('span')
    ;(span.childNodes[2] as Text).data = '5'
    await settle()
    expect(texts(span)).toEqual(['5天前更新', '', ''])
    ;(span.childNodes[4] as Text).data = ' day ago'
    await settle()
    expect(texts(span)).toEqual(['5天前更新', '', ''])
    translator!.stop()
    expect(texts(span)).toEqual(['Updated ', '5', ' day ago'])
  })

  it('整体未命中时逐个匹配', () => {
    start('<a>Issues<!-- -->546<!-- -->(546)</a>')
    expect(texts($('a'))).toEqual(['议题', '546', '(546)'])
  })

  it('插入元素拆分文本组后分别处理', async () => {
    start('<span>Edit<!-- --> <!-- -->file</span>')
    const span = $('span')
    expect(texts(span)).toEqual(['编辑文件', '', ''])
    span.insertBefore(document.createElement('hr'), span.childNodes[2]!)
    await settle()
    expect(texts(span)).toEqual(['编辑', ' ', '文件'])
  })

  it('移除元素合并文本组后整体匹配', async () => {
    start('<span>Edit<b>x</b> file</span>')
    const span = $('span')
    expect(texts(span)).toEqual(['编辑', ' 文件'])
    span.removeChild($('b'))
    await settle()
    expect(texts(span)).toEqual(['编辑文件', ''])
  })

  it('新插入的文本节点加入已有文本组', async () => {
    start('<span>Updated </span>')
    const span = $('span')
    span.append(document.createComment(' '), document.createTextNode('2 days ago'))
    await settle()
    expect(texts(span)).toEqual(['2天前更新', ''])
  })

  it('元素间隔的文本不合并', () => {
    start('<p>Edit <b>x</b> file</p>')
    expect(texts($('p'))).toEqual(['编辑 ', ' 文件'])
  })
})

describe('还原', () => {
  it('stop 还原全部文本、属性与时间元素', () => {
    const html = `<div title="Close"><span>Updated <!-- -->3<!-- --> days ago</span><input type="submit" value="Submit">
      <relative-time datetime="2020-01-01T00:00:00Z">Jan 1</relative-time><p>Issues</p></div>`
    document.body.innerHTML = html
    const before = document.body.innerHTML
    translator = createTranslator({ matcher: testMatcher(), host: window })
    translator.start()
    expect(document.body.innerHTML).not.toBe(before)
    translator.stop()
    expect(document.body.innerHTML).toBe(before)
    expect(translator.active).toBe(false)
  })

  it('stop 后不再处理变动，重新 start 再次翻译', async () => {
    const t = start('<main><p>Issues</p></main>')
    t.stop()
    $('main').insertAdjacentHTML('beforeend', '<span>Search</span>')
    await settle()
    expect($('main span').textContent).toBe('Search')
    expect($('main p').textContent).toBe('Issues')
    t.start()
    expect($('main span').textContent).toBe('搜索')
    expect($('main p').textContent).toBe('议题')
  })

  it('被外部改写的内容在还原时保留', async () => {
    const t = start('<span>Issues</span>')
    $('span').firstChild!.textContent = 'Something else'
    await settle()
    t.stop()
    expect($('span').textContent).toBe('Something else')
  })

  it('重复 start / stop 无副作用', () => {
    const t = start('<span>Issues</span>')
    t.start()
    expect($('span').textContent).toBe('议题')
    t.stop()
    t.stop()
    expect($('span').textContent).toBe('Issues')
    expect(t.translatedCount()).toBe(0)
  })
})

describe('统计', () => {
  it('translatedCount 统计已翻译的文本节点与属性', () => {
    const t = start(
      '<button aria-label="Copy" title="Close">Search</button><p>Unknown</p><span>Updated <!-- -->3 days ago</span>',
    )
    // 文本：Search、Updated 组首节点；属性：aria-label、title
    expect(t.translatedCount()).toBe(4)
  })

  it('pages 反映当前页面类型', () => {
    const t = createTranslator({ matcher: testMatcher(), host: window })
    expect(t.pages).toEqual(['common', 'repository', 'issues'])
    expect(t.features).toEqual({ translateTime: true, translateTitle: true, collectUntranslated: false })
  })
})

describe('已译节点被追加文字（解析器分块到达）', () => {
  /** 只有文档解析中（loading）才按解析器追加处理；用完删除覆盖，恢复原有的 readyState */
  const setReadyState = (state: DocumentReadyState): void => {
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => state })
  }
  /** 模拟解析器把分块到达的文字追加到元素的最后一个子节点 */
  const append = (selector: string, text: string): void => ($(selector).lastChild as Text).appendData(text)
  /** 测试词典加上：数字译到句中的正则、kbd 句子 */
  const bundle: LocaleBundle = [
    ...TEST_BUNDLE,
    [
      'common',
      {
        regexp: [
          [/^Showing (\d+) of (\d+)$/, '显示 $1 个，共 $2 个'],
          [/^Press \/ to open (.+)$/, '按 / 打开 $1'],
          [/^Press \/ to search$/, '按 / 搜索'],
        ],
      },
    ],
  ]

  beforeEach(() => setReadyState('loading'))
  afterEach(() => {
    Reflect.deleteProperty(document, 'readyState')
  })

  it('追加英文：按原文加追加部分重译，停止后还原整段原文', async () => {
    start('<p>Edit</p><span>12 comment</span>')
    expect($('p').textContent).toBe('编辑')
    expect($('span').textContent).toBe('12 条评论')
    append('p', ' file')
    append('span', 's')
    await settle()
    expect($('p').textContent).toBe('编辑文件')
    expect($('span').textContent).toBe('12 条评论')
    translator!.stop()
    expect($('p').textContent).toBe('Edit file')
    expect($('span').textContent).toBe('12 comments')
  })

  it.each([
    ['Showing 5 of 1', '2', '显示 5 个，共 12 个'],
    ['Opened by octocat', '-2', '由 octocat-2 打开'],
    ['Opened by octocat', 'é', '由 octocaté 打开'],
  ])('追加数字、非 ASCII 字母：与整段一次到达相同，停止后还原（%s + %s）', async (source, extra, shown) => {
    start(`<span>${source}</span>`, { matcher: testMatcher({}, bundle) })
    append('span', extra)
    await settle()
    expect($('span').textContent).toBe(shown)
    translator!.stop()
    expect($('span').textContent).toBe(source + extra)
  })

  it('译文以原文开头（双语自定义词条）：追加英文按原文加追加部分重译，停止后还原', async () => {
    start('<p>Edit</p>', { matcher: testMatcher({ custom: { Edit: 'Edit 编辑' } }) })
    expect($('p').textContent).toBe('Edit 编辑')
    append('p', ' file')
    await settle()
    expect($('p').textContent).toBe('编辑文件')
    translator!.stop()
    expect($('p').textContent).toBe('Edit file')
  })

  it('追加标点：显示不改回英文，停止后还原整段原文', async () => {
    start('<p>Edit</p>')
    append('p', '…')
    await settle()
    expect($('p').textContent).toBe('编辑…')
    translator!.stop()
    expect($('p').textContent).toBe('Edit…')
  })

  it('依次追加标点与英文：按完整原文处理，停止后还原整段原文', async () => {
    start('<p>Edit</p>')
    append('p', ' (')
    await settle()
    expect($('p').textContent).toBe('编辑 (')
    append('p', 'beta)')
    await settle()
    // 测试词典没有「Edit (beta)」：与整段一次到达时相同，显示原文
    expect($('p').textContent).toBe('Edit (beta)')
    translator!.stop()
    expect($('p').textContent).toBe('Edit (beta)')
  })

  it('追加空白：保留首尾空白，停止后还原', async () => {
    start('<p>\n  Edit</p>')
    expect($('p').textContent).toBe('\n  编辑')
    append('p', '\n')
    await settle()
    expect($('p').textContent).toBe('\n  编辑\n')
    translator!.stop()
    expect($('p').textContent).toBe('\n  Edit\n')
  })

  it('标题被追加标点：显示不变，停止后还原整段原文', async () => {
    document.head.innerHTML = '<title>Issues</title>'
    start('')
    expect(document.title).toBe('议题')
    append('title', '…')
    await settle()
    expect(document.title).toBe('议题…')
    translator!.stop()
    expect(document.title).toBe('Issues…')
  })

  it('kbd 片段末段被追加标点：显示不改回英文，停止后还原整句原文', async () => {
    start('<p>Press <kbd>/</kbd> to search</p>', { matcher: testMatcher({}, bundle) })
    expect(texts($('p'))).toEqual(['按 ', ' 搜索'])
    append('p', '…')
    await settle()
    expect(texts($('p'))).toEqual(['按 ', ' 搜索…'])
    translator!.stop()
    expect($('p').textContent).toBe('Press / to search…')
  })

  it('文本组的置空末节点被追加：按整组原文重译，停止后还原', async () => {
    start('<p>Opened by <!-- -->octo</p><span>12 <!-- -->comment</span>')
    expect(texts($('p'))).toEqual(['由 octo 打开', ''])
    expect(texts($('span'))).toEqual(['12 条评论', ''])
    append('p', 'cat')
    append('span', 's')
    await settle()
    expect(texts($('p'))).toEqual(['由 octocat 打开', ''])
    expect(texts($('span'))).toEqual(['12 条评论', ''])
    translator!.stop()
    expect($('p').textContent).toBe('Opened by octocat')
    expect($('span').textContent).toBe('12 comments')
  })

  it('文本组的置空末节点被追加后，同一任务内又插入注释加文字、元素：仍按追加处理，停止后还原', async () => {
    start('<p id="a">Opened by <!-- -->octo</p><p id="b">Opened by <!-- -->octo</p>')
    append('#a', 'cat')
    $('#a').append(document.createComment(' '), ' (2)')
    append('#b', 'cat ')
    $('#b').append(document.createElement('b'))
    await settle()
    expect(texts($('#a'))).toEqual(['由 octocat (2) 打开', '', ''])
    expect(texts($('#b'))).toEqual(['由 octocat 打开 ', ''])
    translator!.stop()
    expect($('#a').textContent).toBe('Opened by octocat (2)')
    expect($('#b').textContent).toBe('Opened by octocat ')
  })

  it('文本组的置空末节点被追加的文字以原文开头或等于原文：仍按追加处理，停止后还原', async () => {
    start('<span>Showing <!-- -->5<!-- --> of <!-- -->1</span><p>Opened by <!-- -->1</p>', {
      matcher: testMatcher({}, bundle),
    })
    expect($('span').textContent).toBe('显示 5 个，共 1 个')
    append('span', '12')
    append('p', '1')
    await settle()
    expect($('span').textContent).toBe('显示 5 个，共 112 个')
    expect($('p').textContent).toBe('由 11 打开')
    translator!.stop()
    expect($('span').textContent).toBe('Showing 5 of 112')
    expect($('p').textContent).toBe('Opened by 11')
  })

  it('kbd 片段的置空末节点被追加：整句按完整原文重译，停止后还原', async () => {
    start('<p>Press <kbd>/</kbd> to open <!-- -->octo</p>', { matcher: testMatcher({}, bundle) })
    expect(texts($('p'))).toEqual(['按 ', ' 打开 octo', ''])
    append('p', 'cat')
    await settle()
    expect($('p').textContent).toBe('按 / 打开 octocat')
    translator!.stop()
    expect($('p').textContent).toBe('Press / to open octocat')
  })

  it('kbd 片段的置空末节点被追加后，同一任务内又插入兄弟：整句按完整原文重译，停止后还原', async () => {
    start('<p>Press <kbd>/</kbd> to open <!-- -->octo</p>', { matcher: testMatcher({}, bundle) })
    append('p', 'cat')
    $('p').append(document.createComment(' '), ' now')
    await settle()
    expect($('p').textContent).toBe('按 / 打开 octocat now')
    translator!.stop()
    expect($('p').textContent).toBe('Press / to open octocat now')
  })

  it('置空节点不是最后一个子节点：被改写时按新原文处理，不拼接', async () => {
    start('<p>Opened by <!-- -->octocat<!-- --></p>')
    ;($('p').childNodes[2] as Text).data = 'hubot'
    await settle()
    expect($('p').textContent).toBe('由 hubot 打开')
    translator!.stop()
    expect($('p').textContent).toBe('Opened by hubot')
  })

  it('解析结束后 React 改写置空节点：按新原文重译，不拼接', async () => {
    setReadyState('complete')
    start('<p>Opened by <!-- -->octocat</p>')
    ;($('p').lastChild as Text).data = 'hubot'
    await settle()
    expect($('p').textContent).toBe('由 hubot 打开')
    translator!.stop()
    expect($('p').textContent).toBe('Opened by hubot')
  })

  it.each(['loading', 'complete'] as const)(
    '译文是原文前缀：页面改写为原文加后缀时按新原文处理（%s）',
    async (state) => {
      setReadyState(state)
      start('<p>Webhooks</p>', { matcher: testMatcher({ custom: { Webhooks: 'Webhook' } }) })
      expect($('p').textContent).toBe('Webhook')
      ;($('p').firstChild as Text).data = 'Webhooks (2)'
      await settle()
      expect($('p').textContent).toBe('Webhooks (2)')
      translator!.stop()
      expect($('p').textContent).toBe('Webhooks (2)')
    },
  )
})

describe('文本所有权与候选组避让', () => {
  it('web 所有的单节点不被 GitHub 引擎覆盖，stop 不还原，页面改写后恢复翻译', async () => {
    document.body.innerHTML = '<p id="web">Open</p><p id="gh">Issues</p>'
    const webNode = $('#web').firstChild as Text
    textOwnership().claim(webNode, 'web', 'Open')

    const t = createTranslator({ matcher: testMatcher(), host: window })
    translator = t
    t.start()
    expect($('#web').textContent).toBe('Open')
    expect($('#gh').textContent).toBe('议题')
    expect(textOwnership().ownerOf(webNode)).toBe('web')

    webNode.data = 'Pull requests'
    await settle()
    expect($('#web').textContent).toBe('拉取请求')
    expect(textOwnership().ownerOf(webNode)).toBe('github')

    textOwnership().claim(webNode, 'web', '拉取请求')
    t.stop()
    expect($('#web').textContent).toBe('拉取请求')
    expect($('#gh').textContent).toBe('Issues')
  })

  it('含 web 成员的相邻文本组、合并区域、kbd 片段整组跳过，页面改写后相邻文本组恢复翻译', async () => {
    const bundle: LocaleBundle = [
      ...TEST_BUNDLE,
      [
        'common',
        {
          static: { 'Edit / file': '按 / 编辑文件', 'Edit file': '编辑文件', Edit: '编辑', file: '文件' },
          mergeText: ['.merge-box'],
        },
      ],
    ]
    document.body.innerHTML =
      '<span id="run">Edit<!-- --> <!-- -->file</span>' +
      '<div id="merge" class="merge-box"><b>Edit </b><i>file</i></div>' +
      '<p id="kbd">Edit <kbd>/</kbd> file</p>'

    const runTail = $('#run').lastChild as Text
    const mergeTail = $('#merge i').firstChild as Text
    const kbdTail = $('#kbd').lastChild as Text
    textOwnership().claim(runTail, 'web', 'file')
    textOwnership().claim(mergeTail, 'web', 'file')
    textOwnership().claim(kbdTail, 'web', ' file')

    translator = createTranslator({ matcher: testMatcher({}, bundle), host: window })
    translator.start()

    expect(texts($('#run'))).toEqual(['Edit', ' ', 'file'])
    expect($('#merge').textContent).toBe('Edit file')
    expect(texts($('#kbd'))).toEqual(['Edit ', ' file'])

    // 页面改写释放 web 所有权后，整组恢复翻译
    runTail.data = 'changed'
    await settle()
    expect(textOwnership().ownerOf(runTail)).not.toBe('web')
    runTail.data = 'file'
    await settle()
    expect(texts($('#run'))).toEqual(['编辑文件', '', ''])
  })

  it('脱离 DOM 的节点在 stop 后其 github 所有权失效', () => {
    const t = start('<p id="gone">Issues</p>')
    const node = $('#gone').firstChild as Text
    expect(textOwnership().ownerOf(node)).toBe('github')

    $('#gone').remove()
    t.stop()
    expect(node.data).toBe('议题')
    expect(textOwnership().ownerOf(node)).toBeUndefined()
  })
})
