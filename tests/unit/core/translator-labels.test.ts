// @vitest-environment-options { "url": "https://github.com/octocat/hello-world/issues" }
import { afterEach, describe, expect, it } from 'vitest'
import { createController, type Controller } from '../../../src/core/controller'
import { LABEL_SELECTORS, IGNORE_SELECTORS } from '../../../src/core/ignore'
import { createMatcher } from '../../../src/core/matcher'
import { createTranslator, type Translator, type TranslatorOptions } from '../../../src/core/translator'
import type { LocaleBundle, PageKey } from '../../../src/core/types'
import type { Settings } from '../../../src/shared/settings'
import { textOwnership } from '../../../src/shared/text-ownership'
import { $, settle } from './helpers'

/**
 * 标签区域（LABEL_SELECTORS）里的默认标签：夹具取自采集页面的真实结构（议题列表、议题与拉取请求侧栏、标签页、
 * 贡献页、标签选择器），内容换成中性占位。名称区域按名称表、说明区域按说明表与标签正则分开匹配
 */
const LABELS: Readonly<Record<string, string>> = {
  bug: '缺陷',
  documentation: '文档',
  enhancement: '改进',
  'good first issue': '适合新手的议题',
  'help wanted': '需要帮助',
  question: '疑问',
}

const LABEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'Something isn’t working': '有功能不正常',
  'Improvements or additions to documentation': '文档改进或补充',
  'Further information is requested': '需要更多信息',
  'Extra attention is needed': '需要额外关注',
}

const BUNDLE: LocaleBundle = [
  [
    'common',
    {
      static: { Issues: '议题', 'Sample text': '示例文字' },
      // 说明提示（忽略区域根）的无障碍名称由属性规则改写（语言包见 common-ui/labels.ts）
      attributeRules: [
        ['[class*="labelDescriptionTooltip__"]', 'aria-label', /^Further information is requested$/, '需要更多信息'],
      ],
      labels: LABELS,
      labelDescriptions: LABEL_DESCRIPTIONS,
      labelRegexp: [[/^Pull requests that update ([\w.#+ -]{1,40}) code$/, '更新 $1 代码的拉取请求']],
    },
  ],
  ['issues', { ignore: ['ul[role="group"]:not(:has([data-loading]))'] }],
]

/** 繁体：切换语言用 */
const TW_BUNDLE: LocaleBundle = [
  ['common', { static: { Issues: '議題' }, labels: { bug: '錯誤', documentation: '說明文件', question: '疑問' } }],
]

const ISSUES: readonly PageKey[] = ['common', 'repository', 'issues']

/** React 标签令牌（议题列表、侧栏、项目看板）：TokenTextContainer 是忽略区域根，文字在 prc-Text 里 */
const TOKEN = (name: string, id: string): string =>
  '<span class="prc-Token-TokenBase-te5-F prc-Token-IssueLabel-2IazM IssueLabelToken__0H-m6r">' +
  `<span class="prc-Token-TokenTextContainer-cOUaD"><span class="prc-Text-Text-9mHv3" data-component="Text" id="${id}">` +
  `${name}</span></span></span>`

/** 议题列表：标签令牌包在筛选按钮里 */
const LIST = (name: string, id: string): string =>
  `<button type="button" class="filterLink__Cq0Hs1" id="${id}-button">${TOKEN(name, id)}</button>`

/** React 侧栏：标签链接里是令牌与屏幕阅读器读的说明，链接后是说明提示（带同一说明的 aria-label） */
const SIDEBAR =
  '<a class="labelLink__AJlImc prc-Link-Link-9ZwDx" href="/octocat/hello-world/issues?q=label%3Aquestion" ' +
  `aria-describedby="side-desc side-tip">${TOKEN('question', 'side-name')}` +
  '<span class="sr-only" id="side-desc">Further information is requested</span></a>' +
  '<span class="labelDescriptionTooltip__3yeDxA prc-TooltipV2-Tooltip-tLeuB" data-component="Tooltip" ' +
  'aria-label="Further information is requested" role="tooltip" aria-hidden="true" id="side-tip" popover="auto">' +
  'Further information is requested</span>'

/** 经典侧栏（拉取请求页）：名称套在 css-truncate-target 里，前后有换行缩进；说明在 tool-tip 里 */
const CLASSIC =
  '<div class="js-issue-labels d-flex flex-wrap">\n' +
  '  <a id="label-1a2b3c" href="/octocat/hello-world/issues?q=label%3Abug" data-name="bug" ' +
  'class="IssueLabel hx_IssueLabel width-fit mb-1 mr-1" aria-describedby="tooltip-1">\n' +
  '    <span class="css-truncate css-truncate-target width-fit" id="classic-name">bug</span>\n' +
  '  </a>\n' +
  '  <tool-tip id="tooltip-1" for="label-1a2b3c" popover="manual" data-direction="s" data-type="description" ' +
  'class="sr-only position-absolute" role="tooltip">Something isn’t working</tool-tip>\n' +
  '</div>'

/** 经典时间线：名称是链接的直接文字，前后有换行缩进 */
const TIMELINE =
  'added <a id="label-4d5e6f" href="/octocat/hello-world/issues?q=label%3Aenhancement" data-name="enhancement" ' +
  'class="IssueLabel hx_IssueLabel d-inline-block v-align-middle">\n  enhancement\n</a> label'

/** 标签页列表行：屏幕阅读器读的行标题、标签链接（忽略区域根，令牌套在三层元素里）、说明 */
const ROW = (name: string, description: string, id: string): string =>
  `<li data-label-id="${id}" role="listitem" aria-label="${name}. 1 open issues1 open issues.">` +
  '<div class="container__mDVuhO sr-only" data-listview-item-title-container="true">' +
  `<h4 class="heading__fzQskI"><span id="${id}-title">${name}</span></h4></div>` +
  '<div class="container__W45oI6 labelRowDescription__BiyOt7"><div class="default__oxxQZ0">' +
  `<a aria-label="${name}" href="/octocat/hello-world/issues?q=label%3A1" id="${id}-link">${TOKEN(name, `${id}-name`)}</a>` +
  ` </div><div class="default__oxxQZ0 labelRowDescriptionItemDescription__btj1EZ" id="${id}-desc">${description}</div>` +
  '</div></li>'

const LABELS_PAGE = `<ul data-listview-component="items-list">${ROW('documentation', 'Improvements or additions to documentation', 'doc')}${ROW('scope: vapor', 'related to vapor mode', 'custom')}</ul>`

/** 贡献页：span.IssueLabel 里是标签链接与说明两段 */
const CONTRIB =
  '<span class="d-inline-block IssueLabel v-align-text-top" id="contrib">\n' +
  '  <a id="label-c1" class="IssueLabel hx_IssueLabel" href="/octocat/hello-world/issues?q=label%3A%22help+wanted%22">\n' +
  '    help wanted\n' +
  '</a>\n' +
  '  <tool-tip id="tooltip-c1" for="label-c1" popover="manual" data-type="description" ' +
  'class="sr-only position-absolute" role="tooltip">Extra attention is needed</tool-tip>\n' +
  '</span>'

/** 标签选择器：名称在 labelNameText__ 里，说明不在标签区域里 */
const PICKER =
  '<ul role="listbox"><li role="option"><span class="labelNameText__xVR7LL" id="picker">enhancement</span>' +
  '<span class="prc-ActionList-Description-dtt0n" id="picker-desc">Improvements or additions to documentation</span>' +
  '</li></ul>'

let translator: Translator | undefined
let controller: Controller | undefined

function start(html: string, options: Partial<TranslatorOptions> = {}): Translator {
  document.body.innerHTML = html
  translator = createTranslator({
    matcher: createMatcher(BUNDLE),
    host: window,
    collectUntranslated: true,
    resolvePages: () => ISSUES,
    ...options,
  })
  translator.start()
  return translator
}

const text = (selector: string): string => $(selector).textContent ?? ''
/** 首个子节点（文本） */
const textNode = (selector: string): Text => $(selector).firstChild as Text
/** 未翻译记录里的原文 */
const misses = (t: Translator): string[] => t.drainUntranslated().map(([source]) => source)

afterEach(() => {
  translator?.stop()
  translator = undefined
  controller?.dispose()
  controller = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'readyState')
  history.replaceState(null, '', '/octocat/hello-world/issues')
})

describe('标签区域选择器', () => {
  it('都在全局忽略列表里', () => {
    for (const selector of LABEL_SELECTORS) expect(IGNORE_SELECTORS, selector).toContain(selector)
  })
})

describe('初次遍历', () => {
  it('议题列表、侧栏、经典标签、时间线、标签页、贡献页、标签选择器里的默认标签名与说明都译出；stop 后还原', () => {
    const t = start(
      `${LIST('bug', 'list')}${SIDEBAR}${CLASSIC}<p id="timeline">${TIMELINE}</p>${LABELS_PAGE}${CONTRIB}${PICKER}`,
    )
    expect(text('#list')).toBe('缺陷')
    expect(text('#side-name')).toBe('疑问')
    expect(text('#side-desc')).toBe('需要更多信息')
    expect(text('#side-tip')).toBe('需要更多信息')
    expect($('#side-tip').getAttribute('aria-label')).toBe('需要更多信息')
    expect(text('#classic-name')).toBe('缺陷')
    expect(text('tool-tip[for="label-1a2b3c"]')).toBe('有功能不正常')
    // 换行缩进照原文保留
    expect(text('#label-4d5e6f')).toBe('\n  改进\n')
    // 标签页：令牌（套在标签链接里）、说明；屏幕阅读器读的行标题不在标签区域里（React 读它的文字拼行的无障碍名称）
    expect(text('#doc-title')).toBe('documentation')
    expect(text('#doc-name')).toBe('文档')
    expect(text('#doc-desc')).toBe('文档改进或补充')
    // 贡献页：一个区域根里的名称与说明分别判断
    expect(text('#label-c1')).toBe('\n    需要帮助\n')
    expect(text('#tooltip-c1')).toBe('需要额外关注')
    expect(text('#picker')).toBe('改进')
    t.stop()
    expect(text('#list')).toBe('bug')
    expect(text('#side-desc')).toBe('Further information is requested')
    expect($('#side-tip').getAttribute('aria-label')).toBe('Further information is requested')
    expect(text('#classic-name')).toBe('bug')
    expect(text('#label-4d5e6f')).toBe('\n  enhancement\n')
    expect(text('#doc-title')).toBe('documentation')
    expect(text('#doc-name')).toBe('documentation')
    expect(text('#label-c1')).toBe('\n    help wanted\n')
    expect(text('#tooltip-c1')).toBe('Extra attention is needed')
    expect(text('#picker')).toBe('enhancement')
  })

  it('自定义标签名、带表情、分成多段、大小写不同的保持原文，不记未翻译', () => {
    const t = start(
      `${LIST('scope: vapor', 'custom')}${LIST('🐞 bug', 'emoji')}${LIST('Bug', 'case')}` +
        '<a class="IssueLabel" id="segments" href="/octocat/hello-world/labels/1"><g-emoji alias="bug">🐞</g-emoji> bug</a>' +
        '<span class="IssueLabel" id="two"><span>bug</span><span>question</span></span>' +
        `${LABELS_PAGE}<tool-tip for="label-9" id="custom-tip">related to vapor mode</tool-tip>`,
    )
    expect(text('#custom')).toBe('scope: vapor')
    expect(text('#emoji')).toBe('🐞 bug')
    expect(text('#case')).toBe('Bug')
    expect(text('#segments')).toBe('🐞 bug')
    expect(text('#two')).toBe('bugquestion')
    expect(text('#custom-name')).toBe('scope: vapor')
    expect(text('#custom-title')).toBe('scope: vapor')
    expect(text('#custom-desc')).toBe('related to vapor mode')
    expect(text('#custom-tip')).toBe('related to vapor mode')
    // 只记了标签页列表行的无障碍名称（不在标签区域里，测试词典没有规则）
    expect(misses(t).every((source) => source.endsWith('1 open issues1 open issues.'))).toBe(true)
  })

  it('区域外同样的文字不受影响：照常查词典，没有词条时保持原文并记未翻译', () => {
    const t = start(
      `<p id="outside">bug</p><a class="Link--primary" href="/octocat/hello-world/tree/main/documentation" id="dir">documentation</a>${PICKER}`,
    )
    expect(text('#outside')).toBe('bug')
    expect(text('#dir')).toBe('documentation')
    // 标签选择器里的说明不在标签区域里（另由 static 翻译）
    expect(text('#picker-desc')).toBe('Improvements or additions to documentation')
    expect(text('#picker')).toBe('改进')
    expect(misses(t).sort()).toEqual(['Improvements or additions to documentation', 'bug', 'documentation'])
  })

  it('嵌在其他忽略区域里、隔着其他忽略区域、退出标记、跳过标签、可编辑区域里的都不翻译', () => {
    start(
      '<div class="markdown-body"><span class="IssueLabel" id="markdown">bug</span></div>' +
        '<span class="IssueLabel" id="mention"><span class="user-mention">bug</span></span>' +
        '<span class="IssueLabel" translate="no" id="no">bug</span>' +
        '<span class="IssueLabel notranslate" id="notranslate">bug</span>' +
        '<span class="IssueLabel" data-gcn-ignore id="gcn">bug</span>' +
        '<div translate="no"><span class="IssueLabel" id="outer-no">bug</span></div>' +
        '<span class="IssueLabel" id="inner-no"><span translate="no">bug</span></span>' +
        '<span class="IssueLabel" id="nested-no"><span class="IssueLabel notranslate">bug</span></span>' +
        '<span class="IssueLabel" id="code"><code>bug</code></span>' +
        `<div contenteditable="true">${TOKEN('bug', 'editable')}</div>`,
    )
    for (const id of ['markdown', 'mention', 'no', 'notranslate', 'gcn', 'outer-no', 'inner-no', 'nested-no', 'code']) {
      expect(text(`#${id}`), id).toBe('bug')
    }
    expect(text('#editable')).toBe('bug')
  })

  it('标签表为空时不判断标签区域', () => {
    document.body.innerHTML = LIST('bug', 'list')
    translator = createTranslator({
      matcher: createMatcher([['common', { static: { Issues: '议题' } }]]),
      host: window,
      resolvePages: () => ISSUES,
    })
    translator.start()
    expect(text('#list')).toBe('bug')
  })
})

describe('标签正则（Dependabot 生态标签的说明）', () => {
  /** 生态标签：名称是生态名（不在标签表里），说明按生态名生成 */
  const ECOSYSTEM =
    `<ul data-listview-component="items-list">${ROW('javascript', 'Pull requests that update Javascript code', 'js')}` +
    `${ROW('ci', 'Pull requests that update docs', 'other')}</ul>` +
    '<a id="label-e1" class="IssueLabel" href="/octocat/hello-world/labels/javascript">javascript</a>' +
    '<tool-tip id="tooltip-e1" for="label-e1" class="sr-only" role="tooltip">Pull requests that update javascript code</tool-tip>'

  it('标签区域里命中的说明译出，生态名保持原文；区域外同样的文字照常查词典，没有词条时保持原文并记未翻译', () => {
    const t = start(`${ECOSYSTEM}<p id="outside">Pull requests that update Javascript code</p>`)
    expect(text('#js-desc')).toBe('更新 Javascript 代码的拉取请求')
    expect(text('#tooltip-e1')).toBe('更新 javascript 代码的拉取请求')
    expect(text('#js-name')).toBe('javascript')
    expect(text('#label-e1')).toBe('javascript')
    expect(text('#other-desc')).toBe('Pull requests that update docs')
    expect(text('#outside')).toBe('Pull requests that update Javascript code')
    const recorded = misses(t)
    expect(recorded).toContain('Pull requests that update Javascript code')
    expect(recorded).not.toContain('Pull requests that update docs')
    expect(recorded).not.toContain('javascript')
    t.stop()
    expect(text('#js-desc')).toBe('Pull requests that update Javascript code')
    expect(text('#tooltip-e1')).toBe('Pull requests that update javascript code')
  })

  it('说明被改写：改为生态说明时译出，改为其他文字时写回页面的文字', async () => {
    start(ECOSYSTEM)
    textNode('#other-desc').data = 'Pull requests that update Ruby code'
    await settle()
    expect(text('#other-desc')).toBe('更新 Ruby 代码的拉取请求')
    textNode('#js-desc').data = 'Sample text'
    await settle()
    expect(text('#js-desc')).toBe('Sample text')
  })
})

describe('名称与说明分开匹配', () => {
  it('名称区域只查名称表，说明区域只查说明表与标签正则：自定义名称恰好是默认说明、自定义说明恰好是默认标签名的都保持原文，不记未翻译', () => {
    const t = start(
      // 名称区域：令牌、经典标签、标签选择器
      `${LIST('Extra attention is needed', 'name-desc')}${LIST('Pull requests that update Ruby code', 'name-rule')}` +
        '<a id="label-n1" class="IssueLabel" href="/octocat/hello-world/labels/1">Something isn’t working</a>' +
        // 说明区域：经典提示、侧栏屏幕阅读器说明、标签页说明
        '<tool-tip id="tip-name" for="label-n1" class="sr-only" role="tooltip">documentation</tool-tip>' +
        '<a class="labelLink__AJlImc" href="/octocat/hello-world/issues?q=label%3Aa11y">' +
        `${TOKEN('a11y', 'side-custom')}<span class="sr-only" id="side-custom-desc">question</span></a>` +
        `<ul data-listview-component="items-list">${ROW('docs', 'bug', 'row')}</ul>` +
        // 贡献页：一个区域根里名称、说明各按各的表
        '<span class="d-inline-block IssueLabel" id="contrib-swap">' +
        '<a id="label-c9" class="IssueLabel hx_IssueLabel" href="/octocat/hello-world/labels/9">Further information is requested</a>' +
        '<tool-tip id="tooltip-c9" for="label-c9" class="sr-only" role="tooltip">help wanted</tool-tip></span>' +
        CONTRIB,
    )
    expect(text('#name-desc')).toBe('Extra attention is needed')
    expect(text('#name-rule')).toBe('Pull requests that update Ruby code')
    expect(text('#label-n1')).toBe('Something isn’t working')
    expect(text('#tip-name')).toBe('documentation')
    expect(text('#side-custom-desc')).toBe('question')
    expect(text('#row-desc')).toBe('bug')
    expect(text('#label-c9')).toBe('Further information is requested')
    expect(text('#tooltip-c9')).toBe('help wanted')
    // 默认标签照常
    expect(text('#label-c1')).toBe('\n    需要帮助\n')
    expect(text('#tooltip-c1')).toBe('需要额外关注')
    expect(misses(t).every((source) => source.endsWith('1 open issues1 open issues.'))).toBe(true)
  })

  it('改写后按所在区域重新判断：说明区域里的文字改成默认说明时译出，改成默认标签名时写回页面的文字', async () => {
    start('<tool-tip id="tip" for="label-t1" class="sr-only" role="tooltip">Something isn’t working</tool-tip>')
    expect(text('#tip')).toBe('有功能不正常')
    textNode('#tip').data = 'bug'
    await settle()
    expect(text('#tip')).toBe('bug')
    textNode('#tip').data = 'Further information is requested'
    await settle()
    expect(text('#tip')).toBe('需要更多信息')
  })
})

describe('React 重渲染', () => {
  it('文字被改写：改为默认标签时翻译，改为自定义标签时保持原文，改回原文时重译', async () => {
    const t = start(LIST('bug', 'list'))
    const node = textNode('#list')
    node.data = 'question'
    await settle()
    expect(text('#list')).toBe('疑问')
    node.data = 'scope: vapor'
    await settle()
    expect(text('#list')).toBe('scope: vapor')
    node.data = 'bug'
    await settle()
    expect(text('#list')).toBe('缺陷')
    // 页面把原文写回：重译
    node.data = 'bug'
    await settle()
    expect(text('#list')).toBe('缺陷')
    expect(misses(t)).toEqual([])
    t.stop()
    expect(text('#list')).toBe('bug')
  })

  it('标签元素整个换掉：令牌里的文字元素、筛选按钮里的令牌、标签页链接里的令牌、贡献页链接的文字', async () => {
    start(`${LIST('bug', 'list')}<div id="host">${LIST('enhancement', 'old')}</div>${LABELS_PAGE}${CONTRIB}`)
    $('#list').parentElement!.innerHTML = '<span class="prc-Text-Text-9mHv3" id="list-new">enhancement</span>'
    $('#host').innerHTML = LIST('documentation', 'list2')
    await settle()
    expect(text('#list-new')).toBe('改进')
    expect(text('#list2')).toBe('文档')
    $('#doc-link').innerHTML = TOKEN('question', 'doc-new')
    $('#label-c1').textContent = 'good first issue'
    await settle()
    expect(text('#doc-new')).toBe('疑问')
    expect(text('#label-c1')).toBe('适合新手的议题')
    expect(text('#tooltip-c1')).toBe('需要额外关注')
  })

  it('新插入标签：列表新行、贡献页区域根里新加的标签链接', async () => {
    start(`<ul id="rows"></ul>${CONTRIB}`)
    $('#rows').insertAdjacentHTML('beforeend', `<li>${LIST('help wanted', 'new-row')}</li>`)
    $('#contrib').insertAdjacentHTML(
      'beforeend',
      '<a id="label-c2" class="IssueLabel hx_IssueLabel" href="/octocat/hello-world/labels/2">question</a>',
    )
    await settle()
    expect(text('#new-row')).toBe('需要帮助')
    expect(text('#label-c2')).toBe('疑问')
    expect(text('#label-c1')).toBe('\n    需要帮助\n')
  })

  it('标签表里没有的文字写进已译的标签：写回页面的文字', async () => {
    start(LIST('bug', 'list'))
    $('#list').parentElement!.innerHTML = '<span class="prc-Text-Text-9mHv3" id="list-new">Sample text</span>'
    await settle()
    expect(text('#list-new')).toBe('Sample text')
  })

  it('已译的标签里追加文字、元素（区域变成多段）：写回原文；再变回一段时照常翻译', async () => {
    const t = start(`${LIST('bug', 'text')}${LIST('question', 'emoji')}${LIST('help wanted', 'image')}${CONTRIB}`)
    const emoji = document.createElement('g-emoji')
    emoji.textContent = '🐞'
    $('#text').append(' (archived)')
    $('#emoji').prepend(emoji, ' ')
    $('#image').insertAdjacentHTML('beforeend', ' <img class="emoji" alt=":octocat:" src="/octocat.png">')
    $('#label-c1').insertAdjacentHTML('beforeend', '<g-emoji alias="sparkles">✨</g-emoji>')
    await settle()
    expect(text('#text')).toBe('bug (archived)')
    expect(text('#emoji')).toBe('🐞 question')
    expect(text('#image')).toBe('help wanted ')
    expect(text('#label-c1')).toBe('\n    help wanted\n✨')
    // 同一区域根里的其他标签区域照常
    expect(text('#tooltip-c1')).toBe('需要额外关注')
    $('#image img').remove()
    $('#emoji g-emoji').remove()
    await settle()
    expect(text('#image')).toBe('需要帮助 ')
    expect(text('#emoji')).toBe(' 疑问')
    expect(misses(t)).toEqual([])
    t.stop()
    expect(text('#image')).toBe('help wanted ')
  })
})

describe('只有图标的元素（已存档令牌的存档图标）', () => {
  /** 已存档的 React 标签令牌：文字容器里先是包着存档图标（svg）的元素，再是文字 */
  const ARCHIVED = (name: string, id: string): string =>
    '<span class="prc-Token-TokenBase-te5-F prc-Token-IssueLabel-2IazM IssueLabelToken__0H-m6r">' +
    '<span class="prc-Token-TokenTextContainer-cOUaD"><span class="archivedIcon__6ud3yr">' +
    '<svg aria-label="Archived" role="img" class="octicon octicon-archive" viewBox="0 0 16 16" width="12" height="12">' +
    '<path d="M0 2.75"></path></svg></span>' +
    `<span class="prc-Text-Text-9mHv3" data-component="Text" id="${id}">${name}</span></span></span>`

  it('不算一段：已存档的默认标签译出，自定义标签保持原文；图片表情、空元素仍算一段', () => {
    const t = start(
      `${ARCHIVED('question', 'archived')}${ARCHIVED('scope: vapor', 'archived-custom')}` +
        '<span class="IssueLabel" id="classic"><svg class="octicon" viewBox="0 0 16 16"><title>Archived</title></svg> bug</span>' +
        '<span class="IssueLabel" id="image"><img class="emoji" alt=":octocat:" src="/octocat.png"> bug</span>' +
        '<span class="IssueLabel" id="swatch"><span class="color-dot"></span>bug</span>',
    )
    expect(text('#archived')).toBe('疑问')
    // 图标的无障碍名称在忽略区域里，不处理
    expect($('#archived').parentElement!.querySelector('svg')!.getAttribute('aria-label')).toBe('Archived')
    expect(text('#archived-custom')).toBe('scope: vapor')
    expect(text('#classic')).toBe('Archived 缺陷')
    expect(text('#image')).toBe(' bug')
    expect(text('#swatch')).toBe('bug')
    expect(misses(t)).toEqual([])
    t.stop()
    expect(text('#archived')).toBe('question')
    expect(text('#classic')).toBe('Archived bug')
  })

  it('译后插入、移除图标：照常翻译', async () => {
    start(`${LIST('bug', 'list')}`)
    $('#list').insertAdjacentHTML(
      'beforebegin',
      '<span class="archivedIcon__6ud3yr"><svg aria-label="Archived"></svg></span>',
    )
    await settle()
    expect(text('#list')).toBe('缺陷')
  })
})

describe('元素因类名变化进入或离开标签区域（类名变化不观察，随同一处的变动或下次遍历生效）', () => {
  /** 令牌外壳里的文字元素：类名决定是否标签区域 */
  const SHELL = (id: string, className: string): string =>
    `<span class="prc-Token-TokenBase-te5-F prc-Token-IssueLabel-2IazM"><span class="${className}" id="${id}">bug</span></span>`

  it('进入：随文字改写、子节点替换译出；只改类名时下次遍历译出', async () => {
    const t = start(`${SHELL('a', 'plain')}${SHELL('b', 'plain')}${SHELL('c', 'plain')}`)
    for (const id of ['a', 'b', 'c']) expect(text(`#${id}`)).toBe('bug')
    $('#a').className = 'prc-Token-TokenTextContainer-cOUaD'
    textNode('#a').data = 'question'
    $('#b').className = 'prc-Token-TokenTextContainer-cOUaD'
    $('#b').innerHTML = '<span>documentation</span>'
    $('#c').className = 'prc-Token-TokenTextContainer-cOUaD'
    await settle()
    expect(text('#a')).toBe('疑问')
    expect(text('#b')).toBe('文档')
    expect(text('#c')).toBe('bug')
    t.setMatcher(createMatcher(BUNDLE))
    expect(text('#c')).toBe('缺陷')
  })

  it('离开：随文字改写按普通文字处理（不查标签表）；只改类名时下次遍历还原', async () => {
    const t = start(
      `${SHELL('a', 'prc-Token-TokenTextContainer-cOUaD')}${SHELL('b', 'prc-Token-TokenTextContainer-cOUaD')}`,
    )
    expect(text('#a')).toBe('缺陷')
    expect(text('#b')).toBe('缺陷')
    $('#a').className = 'plain'
    textNode('#a').data = 'question'
    $('#b').className = 'plain'
    await settle()
    expect(text('#a')).toBe('question')
    t.setMatcher(createMatcher(BUNDLE))
    expect(text('#b')).toBe('bug')
    expect(misses(t)).toEqual(['question', 'bug'])
  })
})

describe('先译后忽略', () => {
  it('标签区域根的属性变化：区域内的标签译文不当作误写还原（同一批变动里写回，不等下一批）', () => {
    const t = start(`${CLASSIC}${LABELS_PAGE}`)
    $('#label-1a2b3c').setAttribute('title', 'Sample text')
    $('#doc-link').setAttribute('aria-label', 'Sample text')
    t.flush()
    expect(text('#classic-name')).toBe('缺陷')
    expect(text('#doc-name')).toBe('文档')
    expect($('#label-1a2b3c').getAttribute('title')).toBe('Sample text')
  })

  it('所在区域后来命中其他忽略规则（依赖子节点）：标签译文还原', async () => {
    start(`<ul role="group" id="g"><li data-loading="true">Sample text</li><li>${TOKEN('bug', 'grouped')}</li></ul>`)
    expect(text('#grouped')).toBe('缺陷')
    $('#g [data-loading]').remove()
    await settle()
    expect(text('#grouped')).toBe('bug')
  })

  it('译后加上退出标记（区域根、祖先、区域里的包装、嵌套的标签区域）：还原原文，之后改写的文字也不翻译', async () => {
    start(
      `<div id="wrap">${LIST('bug', 'ancestor')}</div>${LIST('bug', 'root')}${LIST('bug', 'inner')}` +
        `<span class="IssueLabel" id="classic">bug</span>${LABELS_PAGE}`,
    )
    expect(text('#doc-name')).toBe('文档')
    $('#wrap').setAttribute('translate', 'no')
    $('#root').parentElement!.setAttribute('translate', 'no')
    $('#inner').setAttribute('translate', 'no')
    $('#classic').setAttribute('data-gcn-ignore', '')
    // 标签页：标签链接（区域根）里的令牌文字容器
    $('#doc-name').parentElement!.setAttribute('translate', 'no')
    await settle()
    for (const id of ['ancestor', 'root', 'inner', 'classic']) expect(text(`#${id}`), id).toBe('bug')
    expect(text('#doc-name')).toBe('documentation')
    textNode('#root').data = 'question'
    await settle()
    expect(text('#root')).toBe('question')
  })
})

describe('停用、换词典、切换语言、排除页面', () => {
  it('换词典：按新标签表重译；新词典没有标签表时还原；自定义词条不参与标签区域', () => {
    const t = start(`${LIST('bug', 'list')}${LIST('scope: vapor', 'custom')}<p id="outside">bug</p>`)
    t.setMatcher(createMatcher(BUNDLE, { custom: { bug: '程序缺陷', 'scope: vapor': '范围' } }))
    expect(text('#list')).toBe('缺陷')
    expect(text('#custom')).toBe('scope: vapor')
    // 区域外照常按自定义词条翻译
    expect(text('#outside')).toBe('程序缺陷')
    t.setMatcher(createMatcher([['common', { static: { Issues: '议题' } }]]))
    expect(text('#list')).toBe('bug')
    t.setLocale(createMatcher(TW_BUNDLE), 'zh-TW')
    expect(text('#list')).toBe('錯誤')
  })

  it('控制器：总开关关闭、切换语言、进入排除路径时还原或重译', async () => {
    const settings: Settings = {
      enabled: true,
      translateTime: true,
      translateTitle: true,
      excludedPaths: [],
      language: 'auto',
      uiLanguage: 'auto',
      theme: 'auto',
  uiStyle: 'classic',
    }
    document.body.innerHTML = `${LIST('bug', 'list')}${SIDEBAR}<main></main>`
    const c = createController({
      bundle: BUNDLE,
      settings,
      customEntries: {},
      isPathExcluded: (pathname, patterns) => patterns.some((pattern) => pathname.startsWith(pattern)),
      host: window,
    })
    controller = c
    expect(text('#list')).toBe('缺陷')
    c.updateSettings({ ...settings, enabled: false })
    expect(text('#list')).toBe('bug')
    expect(text('#side-tip')).toBe('Further information is requested')
    c.updateSettings({ ...settings, excludedPaths: ['/octocat/hello-world/settings'] })
    expect(text('#list')).toBe('缺陷')
    c.updateLocale(TW_BUNDLE, 'zh-TW')
    expect(text('#list')).toBe('錯誤')
    history.pushState(null, '', '/octocat/hello-world/settings')
    $('main').append(document.createElement('i'))
    await settle()
    expect(c.translator.active).toBe(false)
    expect(text('#list')).toBe('bug')
    expect(text('#side-name')).toBe('question')
  })
})

describe('文档解析中', () => {
  /** 只有 readyState 为 loading 时才按解析器追加处理 */
  function parsing(): void {
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' })
  }

  it('解析器在译文后追加文字：按原文加追加部分判断，不是默认标签时写回原文', async () => {
    start(`${LIST('bug', 'appended')}${LIST('good first', 'partial')}`)
    parsing()
    expect(text('#appended')).toBe('缺陷')
    textNode('#appended').appendData(' report')
    textNode('#partial').appendData(' issue')
    await settle()
    expect(text('#appended')).toBe('bug report')
    expect(text('#partial')).toBe('适合新手的议题')
  })

  it('解析器在译文后只追加符号、标点：整段不是默认标签，写回原文；停用后不变', async () => {
    const t = start(
      '<a class="IssueLabel" id="symbol" href="/octocat/hello-world/labels/1">bug</a>' +
        '<a class="IssueLabel" id="mark" href="/octocat/hello-world/labels/2">question</a>',
    )
    parsing()
    expect(text('#symbol')).toBe('缺陷')
    textNode('#symbol').appendData(' 🐛')
    textNode('#mark').appendData('?')
    await settle()
    expect(text('#symbol')).toBe('bug 🐛')
    expect(text('#mark')).toBe('question?')
    t.stop()
    expect(text('#symbol')).toBe('bug 🐛')
    expect(text('#mark')).toBe('question?')
  })

  it('解析器在已译的标签里追加元素（区域变成多段）：写回原文', async () => {
    start('<a class="IssueLabel" id="split" href="/octocat/hello-world/labels/1">bug </a>')
    parsing()
    expect(text('#split')).toBe('缺陷 ')
    $('#split').insertAdjacentHTML('beforeend', '<g-emoji alias="beetle">🐞</g-emoji>')
    await settle()
    expect(text('#split')).toBe('bug 🐞')
  })

  it('标签区域内含 web 所有权节点时整块跳过且 stop 不还原，页面改写后恢复翻译', async () => {
    document.body.innerHTML = `${LIST('bug', 'web-label')}${CONTRIB}`
    const webNode = textNode('#web-label')
    const contribName = textNode('#label-c1')
    textOwnership().claim(webNode, 'web', 'bug')
    textOwnership().claim(contribName, 'web', '\n    help wanted\n')

    translator = createTranslator({
      matcher: createMatcher(BUNDLE),
      host: window,
      resolvePages: () => ISSUES,
    })
    translator.start()

    expect(text('#web-label')).toBe('bug')
    expect(text('#label-c1')).toBe('\n    help wanted\n')
    expect(text('#tooltip-c1')).toBe('Extra attention is needed')

    webNode.data = 'question'
    await settle()
    expect(text('#web-label')).toBe('疑问')

    translator.stop()
    expect(text('#label-c1')).toBe('\n    help wanted\n')
    expect(textOwnership().ownerOf(contribName)).toBe('web')
  })
})
