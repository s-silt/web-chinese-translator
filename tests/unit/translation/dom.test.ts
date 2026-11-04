import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '../../../src/core/translator'
import { textOwnership } from '../../../src/shared/text-ownership'
import { testMatcher } from '../core/helpers'
import { createDomEngine, type AutoBatchApply, type AutoBatchOutcome, type DomEngine } from '../../../src/translation/dom'
import type { FailureInfo } from '../../../src/translation/failure'
import { splitLongText } from '../../../src/translation/sites'
import { fixedTranslationWith } from '../../../src/translation/dictionaries/index'
import commonTable from '../../../public/dictionaries/zh-CN/common.json'
import devinTable from '../../../public/dictionaries/zh-CN/devin.json'

const DEVIN_ENTRIES = { ...commonTable, ...devinTable }

interface Batch {
  texts: string[]
  apply: AutoBatchApply
}

let batches: Batch[]
let engine: DomEngine | undefined

class FakeIO {
  static instances: FakeIO[] = []
  readonly observed = new Set<Element>()
  private readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIO.instances.push(this)
  }
  static intersecting(el: Element): boolean {
    const rect = el.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
  }
  observe(el: Element): void {
    if (this.observed.has(el)) return
    this.observed.add(el)
    const entry = { isIntersecting: FakeIO.intersecting(el), target: el } as IntersectionObserverEntry
    queueMicrotask(() => this.callback([entry], this as never))
  }
  fire(el: Element, isIntersecting: boolean): void {
    this.callback([{ isIntersecting, target: el } as IntersectionObserverEntry], this as never)
  }
  unobserve(el: Element): void {
    this.observed.delete(el)
  }
  disconnect(): void {
    this.observed.clear()
  }
}

function stubGeometry(): void {
  FakeIO.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
  )
}

function makeEngine(options: { fixed?: boolean; auto?: boolean; debounceMs?: number; recordBudget?: number; autoBudget?: number }): DomEngine {
  return createDomEngine({
    targetLanguage: () => 'zh-CN',
    fixedEnabled: () => options.fixed === true,
    autoEnabled: () => options.auto === true,
    autoBudget: options.autoBudget,
    translateFixed: (text) => fixedTranslationWith(DEVIN_ENTRIES, text),
    debounceMs: options.debounceMs ?? 10,
    recordBudget: options.recordBudget,
    onAutoBatch(texts, apply) {
      batches.push({ texts: [...texts], apply })
    },
  })
}

async function settle(ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

beforeEach(() => {
  // 扫描与写入按 performance.now 切片：不伪造它，机器繁忙时首批会被切短，结果随真实耗时变化。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  document.body.textContent = ''
  batches = []
  stubGeometry()
})

afterEach(() => {
  engine?.dispose()
  engine = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('固定词库翻译', () => {
  it('连接中的属性被删除或外部改写后释放额度，恢复不覆盖页面的新值', async () => {
    document.body.innerHTML = '<nav><button id="a" title="Settings"></button><button id="b" aria-label="Settings"></button></nav>'
    engine = makeEngine({ fixed: true, recordBudget: 2 })
    engine.start()
    await settle(100)
    const a = document.querySelector('#a')!
    const b = document.querySelector('#b')!
    expect(a.getAttribute('title')).toBe('设置')
    expect(b.getAttribute('aria-label')).toBe('设置')
    document.querySelector('nav')!.insertAdjacentHTML('beforeend', '<button id="c">Settings</button>')
    await settle(100)
    expect(document.querySelector('#c')!.textContent).toBe('Settings')
    a.removeAttribute('title')
    b.setAttribute('aria-label', 'Page-owned custom label')
    await settle(100)
    document.querySelector('nav')!.insertAdjacentHTML('beforeend', '<button id="d">Settings</button>')
    await settle(100)
    expect(document.querySelector('#d')!.textContent).toBe('设置')
    engine.restore()
    expect(a.hasAttribute('title')).toBe(false)
    expect(b.getAttribute('aria-label')).toBe('Page-owned custom label')
    expect(document.querySelector('#d')!.textContent).toBe('Settings')
  })

  it('恢复记录达到预算后保留后续原文；移除节点后释放记录并恢复可复用的脱离节点', async () => {
    document.body.innerHTML = '<nav>' + '<button>Settings</button>'.repeat(5) + '</nav>'
    engine = makeEngine({ fixed: true, recordBudget: 4 })
    engine.start()
    await settle(200)
    const buttons = [...document.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['设置', '设置', '设置', '设置', 'Settings'])
    buttons[0]!.remove()
    buttons[1]!.remove()
    await settle(200)
    expect(buttons[0]!.textContent).toBe('Settings')
    expect(buttons[1]!.textContent).toBe('Settings')
    document.querySelector('nav')!.insertAdjacentHTML('beforeend', '<button id="new">Settings</button>')
    await settle(100)
    expect(document.querySelector('#new')!.textContent).toBe('设置')
    engine.restore()
    expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Settings', 'Settings', 'Settings', 'Settings',
    ])
  })

  it('透明文本及透明祖先的内容不进入自动翻译批次', async () => {
    document.body.innerHTML = '<p>Visible English paragraph.</p><p style="opacity:0">Invisible private paragraph.</p><div style="opacity:0"><p>Private text in an invisible ancestor.</p></div>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle(150)
    expect(batches.flatMap((batch) => batch.texts)).toEqual(['Visible English paragraph.'])
  })

  it('按钮文字翻译为中文并保留空白', async () => {
    document.body.innerHTML = '<nav><button>  Settings  </button></nav><p>Settings</p>'
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle()
    expect(document.querySelector('button')?.textContent).toBe('  设置  ')
    expect(document.querySelector('p')?.textContent).toBe('Settings')
  })

  it('动态插入的按钮也会翻译；title 属性一并处理', async () => {
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle()
    const button = document.createElement('button')
    button.textContent = 'Save'
    button.setAttribute('title', 'Settings')
    document.body.append(button)
    await settle()
    expect(button.textContent).toBe('保存')
    expect(button.getAttribute('title')).toBe('设置')
  })

  it('React 改写回英文会重新翻译一次，自己写中文不循环', async () => {
    document.body.innerHTML = '<button>Save</button>'
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle()
    const button = document.querySelector('button')!
    expect(button.textContent).toBe('保存')
    button.textContent = 'Cancel'
    await settle()
    expect(button.textContent).toBe('取消')
    await settle(100)
    expect(button.textContent).toBe('取消')
  })

  it('排除对话与代码区域', async () => {
    document.body.innerHTML =
      '<div class="prose"><button>Save</button></div><pre><button>Cancel</button></pre><div data-message-id="1"><button>Edit</button></div>'
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle()
    const buttons = document.querySelectorAll('button')
    expect(buttons[0]?.textContent).toBe('Save')
    expect(buttons[1]?.textContent).toBe('Cancel')
    expect(buttons[2]?.textContent).toBe('Edit')
  })

  it('同一时间片的词典文本集中写入后才读取新布局', async () => {
    document.body.innerHTML = '<nav>' + '<button>Settings</button>'.repeat(12) + '</nav>'
    const buttons = [...document.querySelectorAll('button')]
    const reads: number[] = []
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (this === document.documentElement) {
        reads.push(buttons.filter((button) => button.textContent === '设置').length)
        return 1000
      }
      return 0
    })
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle(200)
    expect(buttons.every((button) => button.textContent === '设置')).toBe(true)
    expect(new Set(reads)).toEqual(new Set([0, 12]))
    expect(batches).toHaveLength(0)
  })

  it('批量布局失败仅回退不安全项，并释放其预占容量给后续词条', async () => {
    document.body.innerHTML = '<nav><button id="bad">Settings</button><button id="good">Settings</button><button id="tail">Settings</button></nav>'
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.id === 'bad' && this.textContent === '设置' ? 1000 : 0
    })
    engine = makeEngine({ fixed: true, recordBudget: 2 })
    engine.start()
    await settle(400)
    expect(document.querySelector('#bad')!.textContent).toBe('Settings')
    expect(document.querySelector('#good')!.textContent).toBe('设置')
    expect(document.querySelector('#tail')!.textContent).toBe('设置')
    expect(engine.isCapped()).toBe(false)
    engine.restore()
    expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Settings', 'Settings', 'Settings'])
  })

  it.each(['source', 'parent'] as const)('提交前页面改变 %s 时丢弃暂存词条，恢复不覆盖页面内容', async (change) => {
    document.body.innerHTML = '<nav><button id="first">Settings</button><button>Cancel</button></nav><pre id="excluded"></pre>'
    const text = document.querySelector('#first')!.firstChild! as Text
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => true, autoEnabled: () => false,
      translateFixed(value) {
        if (value === 'Cancel') {
          if (change === 'source') text.data = 'Page-owned label'
          else document.querySelector('#excluded')!.append(text)
        }
        return fixedTranslationWith(DEVIN_ENTRIES, value)
      },
      onAutoBatch(texts, apply) { batches.push({ texts: [...texts], apply }) },
    })
    engine.start()
    await settle(200)
    expect(text.data).toBe(change === 'source' ? 'Page-owned label' : 'Settings')
    expect(document.querySelector('nav button:last-child')!.textContent).toBe('取消')
    engine.restore()
    expect(text.data).toBe(change === 'source' ? 'Page-owned label' : 'Settings')
  })

  it('逐项回退仍检查已接受词条，后续写入不能挤坏前项', async () => {
    document.body.innerHTML = '<nav style="display:flex"><button id="first">Settings</button><button id="second">Edit</button></nav>'
    const first = document.querySelector('#first')!
    const second = document.querySelector('#second')!
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this === first && first.textContent === '设置' && second.textContent === '编辑' ? 1000 : 0
    })
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle(200)
    expect(first.textContent).toBe('设置')
    expect(second.textContent).toBe('Edit')
    engine.restore()
    expect(first.textContent).toBe('Settings')
    expect(second.textContent).toBe('Edit')
  })

  it.each([
    'https://cursor.com/docs/agent/overview',
    'https://cursor.com/dashboard',
    'https://app.devin.ai/work/x',
    'https://gitlab.com/dashboard',
    'https://huggingface.co/models',
    'https://npmjs.com/package/test',
    'https://reddit.com/r/programming',
    'https://example.org/docs/agent/overview',
  ])('共享嵌套界面标签跨词典站点生效：%s', async (url) => {
    vi.stubGlobal('location', new URL(url))
    const label = (id: string) => `<a href=/docs/rules><div><span id=${id} class=_check-item-width>Settings</span></div></a>`
    document.body.innerHTML = label('nav') +
      '<a href=/docs/rules><div><span id=unmarked>Settings</span></div></a>' +
      '<p id=body>Settings</p>' +
      `<pre>${label('code')}</pre>` +
      `<div class=prose>${label('article')}</div>` +
      `<div data-message-id=user>${label('message')}</div>` +
      `<div contenteditable=true>${label('editor')}</div>`
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle(200)
    for (const id of ['nav', 'unmarked']) expect(document.getElementById(id)?.textContent).toBe('设置')
    for (const id of ['body', 'code', 'article', 'message', 'editor']) expect(document.getElementById(id)?.textContent).toBe('Settings')
    expect(batches).toHaveLength(0)
    engine.restore()
    for (const id of ['nav', 'unmarked']) expect(document.getElementById(id)?.textContent).toBe('Settings')
  })

  it('多层布局里的按钮、导航和标签页保留结构并支持动态插入与恢复', async () => {
    document.body.innerHTML = '<button id="nested"><svg aria-hidden="true"></svg><div><span id="button-label">Settings</span></div></button>' +
      '<nav><div><div><span id="nav-label">Settings</span></div></div></nav>' +
      '<div role="tab"><div><span id="tab-label">Settings</span></div></div>' +
      '<aside><div><span id="aside-label">Settings</span></div></aside>' +
      '<article><div><span id="article-label">Settings</span></div></article>' +
      '<div><span id="body-label">Settings</span></div>' +
      '<input value="Settings"><textarea>Settings</textarea>'
    const original = document.body.innerHTML
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle(200)
    for (const id of ['button-label', 'nav-label', 'tab-label', 'aside-label']) expect(document.getElementById(id)?.textContent).toBe('设置')
    for (const id of ['article-label', 'body-label']) expect(document.getElementById(id)?.textContent).toBe('Settings')
    expect(document.querySelector('#nested > svg')).not.toBeNull()
    expect(document.querySelector('input')?.value).toBe('Settings')
    expect(document.querySelector('textarea')?.value).toBe('Settings')
    const late = document.createElement('button')
    late.innerHTML = '<div><span>Cancel</span></div>'
    document.body.append(late)
    await settle(200)
    expect(late.textContent).toBe('取消')
    expect(batches).toHaveLength(0)
    late.remove()
    engine.restore()
    expect(document.body.innerHTML).toBe(original)
  })

  it('固定界面覆盖：列表导航、树项、标题、轻量可点容器与段落排版标签支持翻译、动态插入与恢复', async () => {
    document.body.innerHTML =
      '<nav><ul><li><div><svg id="nav-icon"></svg><p id="nav-p">General</p></div></li></ul></nav>' +
      '<button><svg id="btn-icon"></svg><p id="btn-p">Preferences</p></button>' +
      '<div role="navigation"><ul><li><span id="role-nav-span">Security</span></li></ul></div>' +
      '<div role="treeitem"><div><p id="treeitem-p">Knowledge</p></div></div>' +
      '<div class="cursor-pointer"><svg id="cp-icon"></svg><span id="cp-span">Settings</span></div>' +
      '<div style="cursor: pointer"><p id="sp-p">General</p></div>' +
      '<h4 id="h4-heading">Settings</h4>' +
      '<div role="heading" id="role-heading">Settings</div>'
    const original = document.body.innerHTML
    const navIcon = document.getElementById('nav-icon')!
    const btnIcon = document.getElementById('btn-icon')!
    const cpIcon = document.getElementById('cp-icon')!
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle(200)
    expect(document.getElementById('nav-p')?.textContent).toBe('常规')
    expect(document.getElementById('btn-p')?.textContent).toBe('偏好设置')
    expect(document.getElementById('role-nav-span')?.textContent).toBe('安全')
    expect(document.getElementById('treeitem-p')?.textContent).toBe('知识库')
    expect(document.getElementById('cp-span')?.textContent).toBe('设置')
    expect(document.getElementById('sp-p')?.textContent).toBe('常规')
    expect(document.getElementById('h4-heading')?.textContent).toBe('设置')
    expect(document.getElementById('role-heading')?.textContent).toBe('设置')
    expect(document.getElementById('nav-icon')).toBe(navIcon)
    expect(document.getElementById('btn-icon')).toBe(btnIcon)
    expect(document.getElementById('cp-icon')).toBe(cpIcon)

    const dynamic = document.createElement('div')
    dynamic.innerHTML =
      '<nav><ul><li><div><p id="dyn-nav-p">General</p></div></li></ul></nav>' +
      '<div class="cursor-pointer"><span id="dyn-cp-span">Preferences</span></div>'
    document.body.append(dynamic)
    await settle(200)
    expect(document.getElementById('dyn-nav-p')?.textContent).toBe('常规')
    expect(document.getElementById('dyn-cp-span')?.textContent).toBe('偏好设置')
    expect(batches).toHaveLength(0)

    dynamic.remove()
    engine.stop()
    engine.restore()
    expect(document.body.innerHTML).toBe(original)
  })

  it('固定界面覆盖：深层嵌套、启发式节点与字符上限及边界排除区域保持原文', async () => {
    const deepButton =
      '<button><div><div><div><div><div><span><span><span><span><span id="deep-btn">Settings</span></span></span></span></span></div></div></div></div></div></button>'
    const manyNodesInner = `<div>${'<span>a</span>'.repeat(17)}</div>`
    const overNodesPointer = `<div class="cursor-pointer"><span id="over-nodes-label">Settings</span>${manyNodesInner}</div>`
    const overCharsPointer = `<div class="cursor-pointer"><span id="over-chars-label">Settings</span><span>${'a'.repeat(200)}</span></div>`
    const semanticBigButton = `<button><span id="big-btn-label">Settings</span>${manyNodesInner}<span>${'a'.repeat(200)}</span></button>`
    document.body.innerHTML =
      deepButton +
      overNodesPointer +
      overCharsPointer +
      semanticBigButton +
      '<div id="icon-cp" class="cursor-pointer" aria-label="Settings" title="Preferences"><svg></svg></div>' +
      '<div><p id="plain-div-p">Settings</p></div>' +
      '<ul><li><span id="plain-li-span">Settings</span></li></ul>' +
      '<aside><p id="aside-p">Settings</p></aside>' +
      '<article><p id="article-p">Settings</p><div class="cursor-pointer"><span id="article-cp">Settings</span></div><nav><p id="article-nav-p">Settings</p></nav></article>' +
      '<blockquote><div class="cursor-pointer"><span id="blockquote-cp">Settings</span></div></blockquote>' +
      '<div role="article"><div class="cursor-pointer"><span id="role-article-cp">Settings</span></div></div>' +
      '<div class="prose"><button id="prose-btn">Settings</button><div class="cursor-pointer" id="prose-cp">Settings</div></div>' +
      '<div class="markdown"><button id="md-btn">Settings</button></div>' +
      '<div class="markdown-body"><div class="cursor-pointer" id="md-body-cp">Settings</div></div>' +
      '<div data-message-id="m1"><button id="msg-id-btn">Settings</button></div>' +
      '<div data-message-author-role="assistant"><div class="cursor-pointer" id="msg-role-cp">Settings</div></div>' +
      '<pre><button id="pre-btn">Settings</button></pre>' +
      '<code><span class="cursor-pointer" id="code-cp">Settings</span></code>' +
      '<div contenteditable="true"><button id="ce-btn">Settings</button></div>' +
      '<div data-sensitive><button id="sens-btn">Settings</button></div>' +
      '<div translate="no"><button id="tr-no-btn">Settings</button></div>' +
      '<div class="monaco-editor"><button id="monaco-btn">Settings</button></div>'
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle(300)
    expect(document.getElementById('deep-btn')?.textContent).toBe('设置')
    expect(document.getElementById('big-btn-label')?.textContent).toBe('设置')
    expect(document.getElementById('icon-cp')?.getAttribute('aria-label')).toBe('设置')
    expect(document.getElementById('icon-cp')?.getAttribute('title')).toBe('偏好设置')
    expect(document.getElementById('article-nav-p')?.textContent).toBe('设置')
    for (const id of [
      'over-nodes-label',
      'over-chars-label',
      'plain-div-p',
      'plain-li-span',
      'aside-p',
      'article-p',
      'article-cp',
      'blockquote-cp',
      'role-article-cp',
      'prose-btn',
      'prose-cp',
      'md-btn',
      'md-body-cp',
      'msg-id-btn',
      'msg-role-cp',
      'pre-btn',
      'code-cp',
      'ce-btn',
      'sens-btn',
      'tr-no-btn',
      'monaco-btn',
    ]) {
      expect(document.getElementById(id)?.textContent).toBe('Settings')
    }
    expect(batches).toHaveLength(0)
  })

  it('固定界面覆盖：动态添加 role 或 cursor-pointer 属性触发翻译并可恢复', async () => {
    document.body.innerHTML =
      '<div id="role-box"><span id="role-label">Settings</span></div>' +
      '<div id="pointer-box"><span id="pointer-label">General</span></div>'
    engine = makeEngine({ fixed: true })
    engine.start()
    await settle(150)
    const roleBox = document.getElementById('role-box')!
    const roleLabel = document.getElementById('role-label')!
    const pointerBox = document.getElementById('pointer-box')!
    const pointerLabel = document.getElementById('pointer-label')!
    expect(roleLabel.textContent).toBe('Settings')
    expect(pointerLabel.textContent).toBe('General')

    roleBox.setAttribute('role', 'button')
    await settle(150)
    expect(roleLabel.textContent).toBe('设置')
    expect(pointerLabel.textContent).toBe('General')

    engine.restore()
    expect(roleLabel.textContent).toBe('Settings')

    engine.start()
    pointerBox.classList.add('cursor-pointer')
    await settle(150)
    expect(pointerLabel.textContent).toBe('常规')
    engine.restore()
    expect(pointerLabel.textContent).toBe('General')
  })

  it('固定界面覆盖：安全表单属性翻译而输入值与受保护区域保持英文且不触发自动翻译', async () => {
    document.body.innerHTML =
      '<input id="safe-input" placeholder="Settings" title="Preferences" aria-label="Security" value="Settings">' +
      '<textarea id="safe-ta" placeholder="Settings">Settings</textarea>' +
      '<input id="pwd-input" type="password" placeholder="Settings" title="Settings" aria-label="Settings" value="Settings">' +
      '<input id="hid-input" type="hidden" placeholder="Settings" title="Settings" aria-label="Settings" value="Settings">' +
      '<pre><input id="pre-input" placeholder="Settings" title="Settings"></pre>' +
      '<div class="monaco-editor"><input id="editor-input" placeholder="Settings"></div>' +
      '<div data-sensitive><input id="sens-input" placeholder="Settings"></div>' +
      '<div class="prose"><input id="prose-input" placeholder="Settings" title="Settings"></div>'
    engine = makeEngine({ fixed: true, auto: true })
    engine.start()
    await settle(250)
    const safeInput = document.getElementById('safe-input') as HTMLInputElement
    const safeTa = document.getElementById('safe-ta') as HTMLTextAreaElement
    expect(safeInput.getAttribute('placeholder')).toBe('设置')
    expect(safeInput.getAttribute('title')).toBe('偏好设置')
    expect(safeInput.getAttribute('aria-label')).toBe('安全')
    expect(safeInput.value).toBe('Settings')
    expect(safeTa.getAttribute('placeholder')).toBe('设置')
    expect(safeTa.value).toBe('Settings')
    expect(safeTa.textContent).toBe('Settings')

    for (const id of ['pwd-input', 'hid-input', 'pre-input', 'editor-input', 'sens-input', 'prose-input']) {
      const el = document.getElementById(id) as HTMLInputElement
      expect(el.getAttribute('placeholder')).toBe('Settings')
      if (el.hasAttribute('title')) expect(el.getAttribute('title')).toBe('Settings')
      if (el.hasAttribute('aria-label')) expect(el.getAttribute('aria-label')).toBe('Settings')
    }

    const dynInput = document.createElement('input')
    dynInput.setAttribute('placeholder', 'Settings')
    dynInput.value = 'Settings'
    document.body.append(dynInput)
    await settle(150)
    expect(dynInput.getAttribute('placeholder')).toBe('设置')
    expect(dynInput.value).toBe('Settings')

    dynInput.setAttribute('placeholder', 'Preferences')
    await settle(150)
    expect(dynInput.getAttribute('placeholder')).toBe('偏好设置')
    expect(dynInput.value).toBe('Settings')

    const dynTa = document.createElement('textarea')
    dynTa.setAttribute('placeholder', 'Settings')
    dynTa.textContent = 'Settings'
    document.body.append(dynTa)
    await settle(150)
    expect(dynTa.getAttribute('placeholder')).toBe('设置')
    expect(dynTa.value).toBe('Settings')
    expect(dynTa.textContent).toBe('Settings')

    dynInput.setAttribute('placeholder', 'Page supplied hint')
    await settle(150)
    expect(batches).toHaveLength(0)

    engine.stop()
    engine.restore()
    expect(dynInput.getAttribute('placeholder')).toBe('Page supplied hint')
    expect(dynTa.getAttribute('placeholder')).toBe('Settings')
    expect(safeInput.getAttribute('placeholder')).toBe('Settings')
    expect(safeInput.getAttribute('title')).toBe('Preferences')
    expect(safeInput.getAttribute('aria-label')).toBe('Security')
    expect(safeTa.getAttribute('placeholder')).toBe('Settings')
  })
})

describe('自动翻译候选', () => {
  it('收集可见英文文本，去重后批量发送并按序回填', async () => {
    document.body.innerHTML = '<p>First sentence here.</p><p>Second sentence here.</p><p>First sentence here.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.texts).toEqual(['First sentence here.', 'Second sentence here.'])
    batches[0]?.apply(['第一句', '第二句'])
    const texts = [...document.querySelectorAll('p')].map((p) => p.textContent)
    expect(texts).toEqual(['第一句', '第二句', '第一句'])
  })

  it('隐藏、代码、输入、中文与纯 URL 不采集', async () => {
    document.body.innerHTML = [
      '<p hidden>Hidden text</p>',
      '<pre>Code text here</pre>',
      '<input value="Input text">',
      '<p>已经是中文</p>',
      '<p>https://example.com/page</p>',
      '<p>English text here</p>',
    ].join('')
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.texts).toEqual(['English text here'])
  })

  it('未开启自动翻译时不发请求', async () => {
    document.body.innerHTML = '<p>English text here</p>'
    engine = makeEngine({ auto: false })
    engine.start()
    await settle()
    expect(batches).toHaveLength(0)
  })

  it('在途结果回来时源文本已被站点改写则丢弃', async () => {
    document.body.innerHTML = '<p>English text here</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    const p = document.querySelector('p')!
    p.textContent = 'Site rewrote this'
    batches[0]?.apply(['译文'])
    expect(p.textContent).toBe('Site rewrote this')
  })

  it('restore 只还原自己写入的译文，不动站点新文本', async () => {
    document.body.innerHTML = '<p>English text here</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    batches[0]?.apply(['中文译文'])
    const p = document.querySelector('p')!
    expect(p.textContent).toBe('中文译文')
    engine.restore()
    expect(p.textContent).toBe('English text here')
    batches.length = 0
    p.textContent = '中文译文'
    engine.restore()
    expect(p.textContent).toBe('中文译文')
  })

  it('字符预算耗尽后不再发请求并报 capped', async () => {
    document.body.innerHTML = '<p>English text here</p><p>Another sentence.</p>'
    const capped = vi.fn()
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      autoBudget: 20,
      debounceMs: 10,
      onCapped: capped,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle()
    expect(batches.length).toBe(1)
    expect(batches[0]?.texts).toEqual(['English text here'])
    expect(engine.isCapped()).toBe(false)
    batches[0]?.apply(['译文'])
    await settle()
    expect(engine.isCapped()).toBe(true)
  })

  it('缓存提供的字符不计入预算：退还额度后继续发送', async () => {
    document.body.innerHTML = '<p>English text here</p><p>Another sentence.</p>'
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      autoBudget: 20,
      debounceMs: 10,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle()
    expect(batches[0]?.texts).toEqual(['English text here'])
    batches[0]?.apply(['译文'], undefined, 'English text here'.length)
    await settle()
    expect(engine.isCapped()).toBe(false)
    expect(batches[1]?.texts).toEqual(['Another sentence.'])
  })

  it('缓存退还不会和不合格项的退还重复计算', async () => {
    const first = 'English text here'
    document.body.innerHTML = `<p>${first}</p><p>Another sentence.</p>`
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      autoBudget: 40,
      debounceMs: 10,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle()
    expect(batches[0]?.texts).toHaveLength(2)
    // 上报的缓存字符多于实际可退部分时被钳制，已花费不会变成负数而放大预算。
    batches[0]?.apply(['译文', ''], undefined, 1000)
    await settle()
    expect(batches[1]?.texts).toEqual(['Another sentence.'])
    expect(engine.isCapped()).toBe(false)
  })

  it('4×500 段落按 1500 字符上限分批：先3后1且不误报 capped', async () => {
    const t = 'x'.repeat(499)
    document.body.innerHTML = `<p>${t}1</p><p>${t}2</p><p>${t}3</p><p>${t}4</p>`
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.texts).toHaveLength(3)
    batches[0]?.apply(['一', '二', '三'])
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1]?.texts).toHaveLength(1)
    expect(engine.isCapped()).toBe(false)
  })

  it('失效批次回调不暂停引擎，当前批次失败才暂停', async () => {
    document.body.innerHTML = '<p>First sentence one.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    engine.invalidate()
    batches[0]?.apply(undefined)
    expect(engine.isAutoPaused()).toBe(false)
    document.body.insertAdjacentHTML('beforeend', '<p>Second sentence two.</p>')
    await settle()
    expect(batches).toHaveLength(2)
    batches[1]?.apply(undefined)
    expect(engine.isAutoPaused()).toBe(true)
  })

  it('可见性观察初始不相交可见后才批量发送', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 2000, width: 10, height: 10, top: 2000, left: 0, right: 10, bottom: 2010 }) as DOMRect,
    )
    document.body.innerHTML = '<main><p id="a">Visible text candidate here.</p></main>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(0)
    const io = FakeIO.instances[0]
    expect(io).toBeDefined()
    expect(io!.observed.size).toBeGreaterThan(0)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
    )
    for (const el of [...io!.observed]) {
      io!.fire(el, true)
    }
    await settle(300)
    expect(batches.length).toBe(1)
    expect(batches[0]?.texts).toContain('Visible text candidate here.')
  })

  it('源文本在结果返回前被站点改写则不应用译文', async () => {
    document.body.innerHTML = '<p>English text here</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    const p = document.querySelector('p')!
    p.textContent = 'Site rewrote this'
    batches[0]?.apply(['译文'])
    expect(p.textContent).toBe('Site rewrote this')
  })

  it('重复相同文本节点去重一次请求', async () => {
    document.body.innerHTML = '<p>Same text here again.</p><p>Same text here again.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.texts).toEqual(['Same text here again.'])
  })
})

describe('自动翻译失败重试', () => {
  function retryEngine(random: () => number = () => 0.5, autoBudget?: number): DomEngine {
    return createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      debounceMs: 10,
      autoBudget,
      random,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
  }

  function failBatch(index: number, failure: FailureInfo): AutoBatchOutcome {
    const { apply } = batches[index]!
    return apply(undefined, failure)
  }

  async function firstBatch(random?: () => number, autoBudget?: number): Promise<void> {
    document.body.innerHTML = '<p>English text here.</p>'
    engine = retryEngine(random, autoBudget)
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
  }

  it('后台重启（disconnected）退避后原样重发：不计尝试、不拆分、不暂停', async () => {
    await firstBatch(() => 0)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(failBatch(attempt, { code: 'disconnected' })).toBe('retrying')
      expect(engine!.isAutoPaused()).toBe(false)
      await settle(999)
      expect(batches).toHaveLength(attempt + 1)
      await settle(1)
      expect(batches).toHaveLength(attempt + 2)
      expect(batches[attempt + 1]!.texts).toEqual(['English text here.'])
    }
    batches[5]!.apply(['译文'])
    await settle()
    expect(document.querySelector('p')?.textContent).toBe('译文')
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('后台重启不占用普通失败的尝试次数', async () => {
    await firstBatch(() => 0)
    const codes = ['server', 'disconnected', 'disconnected', 'disconnected', 'server'] as const
    for (const [index, code] of codes.entries()) {
      expect(failBatch(index, { code })).toBe('retrying')
      await settle(1000)
    }
    expect(failBatch(5, { code: 'server' })).toBe('paused')
  })

  it('后台一直不恢复时重试有界，额度用尽才暂停；继续后额度重新计算', async () => {
    await firstBatch(() => 0)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(failBatch(attempt, { code: 'disconnected' })).toBe('retrying')
      await settle(1000)
    }
    expect(failBatch(5, { code: 'disconnected' })).toBe('paused')
    expect(engine!.isAutoPaused()).toBe(true)
    await settle(60_000)
    expect(batches).toHaveLength(6)
    engine!.resumeAuto()
    await settle()
    expect(batches).toHaveLength(7)
    expect(failBatch(6, { code: 'disconnected' })).toBe('retrying')
  })

  it('成功一次后后台重启额度重新计算', async () => {
    await firstBatch(() => 0)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      failBatch(attempt, { code: 'disconnected' })
      await settle(1000)
    }
    batches[5]!.apply(['译文'])
    await settle()
    document.body.insertAdjacentHTML('beforeend', '<p>Another english sentence.</p>')
    await settle()
    expect(batches).toHaveLength(7)
    for (let attempt = 6; attempt < 11; attempt += 1) {
      expect(failBatch(attempt, { code: 'disconnected' })).toBe('retrying')
      await settle(1000)
    }
    expect(batches).toHaveLength(12)
  })

  it.each(['timeout', 'server', 'network', 'rate_limited'] as const)(
    '%s 先退避重试，耗尽三次尝试后才暂停',
    async (code) => {
      await firstBatch(() => 0.5)
      expect(failBatch(0,{ code })).toBe('retrying')
      expect(engine!.isAutoPaused()).toBe(false)
      await settle(499)
      expect(batches).toHaveLength(1)
      await settle(1)
      expect(batches).toHaveLength(2)
      expect(batches[1]!.texts).toEqual(['English text here.'])
      expect(failBatch(1,{ code })).toBe('retrying')
      await settle(999)
      expect(batches).toHaveLength(2)
      await settle(1)
      expect(batches).toHaveLength(3)
      expect(failBatch(2,{ code })).toBe('paused')
      expect(engine!.isAutoPaused()).toBe(true)
      await settle(60_000)
      expect(batches).toHaveLength(3)
    },
  )

  it.each(['auth', 'not_found', 'unknown'] as const)('%s 不重试，立即暂停', async (code) => {
    await firstBatch()
    expect(failBatch(0,{ code })).toBe('paused')
    expect(engine!.isAutoPaused()).toBe(true)
    await settle(60_000)
    expect(batches).toHaveLength(1)
  })

  it('Retry-After 优先于退避，等待期间新内容也不发送', async () => {
    await firstBatch(() => 0)
    failBatch(0,{ code: 'rate_limited', retryAfterMs: 10_000 })
    document.body.insertAdjacentHTML('beforeend', '<p>Newly added paragraph.</p>')
    await settle(9_990)
    expect(batches).toHaveLength(1)
    await settle(20)
    expect(batches).toHaveLength(2)
    expect(batches[1]!.texts).toEqual(expect.arrayContaining(['English text here.', 'Newly added paragraph.']))
    batches[1]!.apply(['译文一', '译文二'])
    await settle()
    expect(engine!.isAutoPaused()).toBe(false)
    expect(document.body.textContent).not.toContain('English')
  })

  it('成功后清零失败计数，再次失败重新计算尝试次数', async () => {
    await firstBatch(() => 0)
    failBatch(0,{ code: 'server' })
    await settle()
    failBatch(1,{ code: 'server' })
    await settle()
    batches[2]!.apply(['译文'])
    document.body.insertAdjacentHTML('beforeend', '<p>Another paragraph here.</p>')
    await settle()
    expect(failBatch(3,{ code: 'server' })).toBe('retrying')
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it.each(['queue_full', 'queue_timeout'] as const)('%s 没有 Retry-After 时也至少等待 1 秒并按次数退避', async (code) => {
    await firstBatch(() => 0.999)
    failBatch(0, { code })
    await settle(990)
    expect(batches).toHaveLength(1)
    await settle(20)
    expect(batches).toHaveLength(2)
    failBatch(1, { code })
    await settle(1990)
    expect(batches).toHaveLength(2)
    await settle(20)
    expect(batches).toHaveLength(3)
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('随机值为 0 时 queue_full 也不会立刻重发', async () => {
    await firstBatch(() => 0)
    failBatch(0, { code: 'queue_full' })
    await settle(990)
    expect(batches).toHaveLength(1)
  })

  it.each(['queue_paused', 'queue_full', 'queue_timeout'] as const)('%s 是背压：不计入尝试次数也不暂停', async (code) => {
    await firstBatch(() => 0)
    for (let index = 0; index < 8; index += 1) {
      expect(failBatch(index,{ code, retryAfterMs: 1000 })).toBe('retrying')
      await settle(1000)
      expect(batches).toHaveLength(index + 2)
    }
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('内部取消静默重排：不暂停、不计次，也不影响其后的真实失败计数', async () => {
    await firstBatch(() => 0)
    for (let index = 0; index < 6; index += 1) {
      expect(failBatch(index,{ code: 'cancelled' })).toBe('dropped')
      expect(engine!.isAutoPaused()).toBe(false)
      await settle(1000)
      expect(batches).toHaveLength(index + 2)
    }
    expect(failBatch(6,{ code: 'server' })).toBe('retrying')
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('取消后已滚出视口的节点转为延后，不再发送', async () => {
    await firstBatch(() => 0)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 2000, width: 10, height: 10, top: 2000, left: 0, right: 10, bottom: 2010 }) as DOMRect,
    )
    failBatch(0,{ code: 'cancelled' })
    await settle(2000)
    expect(batches).toHaveLength(1)
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('失效批次的失败回调被忽略', async () => {
    await firstBatch()
    engine!.invalidate()
    expect(failBatch(0,{ code: 'auth' })).toBe('stale')
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('重试前节点被站点改写则不再发送旧文本', async () => {
    await firstBatch(() => 0)
    failBatch(0,{ code: 'server' })
    document.querySelector('p')!.textContent = 'Site rewrote this paragraph.'
    await settle(100)
    expect(batches.flatMap((batch) => batch.texts).filter((text) => text === 'English text here.')).toHaveLength(1)
    expect(batches.at(-1)!.texts).toEqual(['Site rewrote this paragraph.'])
  })

  it('失败批次退还字符额度，重试不会把页面耗到上限', async () => {
    const text = 'English text here.'
    await firstBatch(() => 0, text.length)
    failBatch(0,{ code: 'server' })
    await settle()
    expect(engine!.isCapped()).toBe(false)
    expect(batches).toHaveLength(2)
    failBatch(1,{ code: 'server' })
    await settle()
    failBatch(2,{ code: 'auth' })
    expect(engine!.isAutoPaused()).toBe(true)
    engine!.resumeAuto()
    await settle()
    expect(engine!.isCapped()).toBe(false)
    expect(batches).toHaveLength(4)
  })

  it('手动恢复清除退避并立即重发', async () => {
    await firstBatch(() => 0)
    failBatch(0,{ code: 'auth' })
    engine!.resumeAuto()
    await settle()
    expect(batches).toHaveLength(2)
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('导航清除退避与失败计数', async () => {
    vi.stubGlobal('location', new URL('https://app.devin.ai/work'))
    await firstBatch(() => 0.999)
    failBatch(0,{ code: 'rate_limited', retryAfterMs: 60_000 })
    vi.stubGlobal('location', new URL('https://app.devin.ai/other'))
    engine!.start()
    await settle()
    expect(batches).toHaveLength(2)
  })

  it.each(['invalidate', 'navigate'])('释放预扣后忽略旧回包且不放大预算：%s', async (mode) => {
    const text = 'English text here.'
    await firstBatch(() => 0, text.length)
    if (mode === 'navigate') vi.stubGlobal('location', new URL('https://example.org/next-review-page'))
    else engine!.invalidate()
    engine!.start()
    await settle()
    expect(batches).toHaveLength(2)
    const staleApply = batches[0]!.apply.bind(batches[0])
    expect(staleApply(undefined, { code: 'cancelled' })).toBe('stale')
    batches[1]!.apply(['译文'])
    await settle()
    document.body.insertAdjacentHTML('beforeend', '<p>New words here.</p>')
    await settle()
    expect(batches).toHaveLength(2)
    expect(engine!.isCapped()).toBe(true)
  })
})

describe('批次拆分与逐条回退', () => {
  function splitEngine(): DomEngine {
    return createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      debounceMs: 10,
      random: () => 0,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
  }

  async function start(count: number): Promise<string[]> {
    const texts = Array.from({ length: count }, (_, index) => `Sentence number ${index}.`)
    document.body.innerHTML = texts.map((text) => `<p>${text}</p>`).join('')
    engine = splitEngine()
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    return texts
  }

  const translate = (texts: readonly string[]): string[] => texts.map((text) => `译：${text}`)
  const last = (): Batch => batches.at(-1)!
  const rejectBatch = ({ apply }: Batch, failure: FailureInfo): AutoBatchOutcome => apply(undefined, failure)

  it.each(['timeout', 'bad_output'] as const)('%s 把批次拆半重发，不暂停', async (code) => {
    const texts = await start(4)
    expect(rejectBatch(last(), { code })).toBe('retrying')
    await settle()
    expect(batches[1]!.texts).toEqual(texts.slice(0, 2))
    expect(batches[1]!.apply(translate(batches[1]!.texts))).toBe('applied')
    await settle()
    expect(batches[2]!.texts).toEqual(texts.slice(2))
    batches[2]!.apply(translate(batches[2]!.texts))
    await settle()
    expect(batches).toHaveLength(3)
    expect(engine!.isAutoPaused()).toBe(false)
    expect([...document.querySelectorAll('p')].every((p) => p.textContent?.startsWith('译：'))).toBe(true)
  })

  it('条数错误一路拆到单条：只有坏条目保留原文，其余写入且页面继续', async () => {
    const texts = await start(4)
    const poison = texts[0]!
    const failOrApply = (batch: Batch): AutoBatchOutcome =>
      batch.texts.includes(poison) ? rejectBatch(batch, { code: 'bad_output' }) : batch.apply(translate(batch.texts))
    expect(failOrApply(last())).toBe('retrying')
    await settle()
    expect(last().texts).toEqual([poison, texts[1]])
    expect(failOrApply(last())).toBe('retrying')
    await settle()
    expect(last().texts).toEqual([poison])
    expect(failOrApply(last())).toBe('skipped')
    await settle()
    expect(last().texts).toEqual([texts[1]])
    failOrApply(last())
    await settle()
    expect(last().texts).toEqual(texts.slice(2))
    failOrApply(last())
    await settle()
    const paragraphs = [...document.querySelectorAll('p')].map((p) => p.textContent)
    expect(paragraphs).toEqual([poison, ...translate(texts.slice(1))])
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('放弃的条目不被重新扫描重发；原文变化或手动恢复后可再次尝试', async () => {
    const [source] = await start(1)
    rejectBatch(last(), { code: 'bad_output' })
    await settle()
    expect(rejectBatch(last(), { code: 'bad_output' })).toBe('skipped')
    expect(engine!.isAutoPaused()).toBe(false)
    const sent = batches.length
    window.dispatchEvent(new Event('resize'))
    await settle(1000)
    expect(batches).toHaveLength(sent)
    document.querySelector('p')!.textContent = 'The site rewrote this.'
    await settle()
    expect(last().texts).toEqual(['The site rewrote this.'])
    last().apply(['译文'])
    await settle()
    document.querySelector('p')!.textContent = source!
    await settle()
    rejectBatch(last(), { code: 'bad_output' })
    await settle()
    rejectBatch(last(), { code: 'bad_output' })
    const before = batches.length
    engine!.resumeAuto()
    await settle()
    expect(batches).toHaveLength(before + 1)
    expect(last().texts).toEqual([source])
  })

  it('部分有效的结果立即写入，只重发不合格的条目并退还其额度', async () => {
    const texts = await start(3)
    expect(last().apply(['甲', '', '丙'])).toBe('applied')
    await settle()
    expect(document.querySelectorAll('p')[0]?.textContent).toBe('甲')
    expect(document.querySelectorAll('p')[2]?.textContent).toBe('丙')
    expect(last().texts).toEqual([texts[1]])
    expect(rejectBatch(last(), { code: 'bad_output' })).toBe('skipped')
    await settle()
    expect(batches).toHaveLength(2)
    expect(document.querySelectorAll('p')[1]?.textContent).toBe(texts[1])
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('全部结果都不合格按格式错误处理', async () => {
    const texts = await start(2)
    expect(last().apply(['', '  '])).toBe('retrying')
    await settle()
    expect(last().texts).toEqual([texts[0]])
  })

  it('同一原始批次的子请求数有上限，用尽后其余条目保留原文', async () => {
    await start(20)
    // 上限按原始批次计算，所以 20 条必须都在同一个原始批次里。
    expect(batches[0]!.texts).toHaveLength(20)
    const multiItemFails = (batch: Batch): void => {
      if (batch.texts.length > 1) rejectBatch(batch, { code: 'bad_output' })
      else batch.apply(translate(batch.texts))
    }
    for (let handled = 0; handled < batches.length; handled += 1) {
      multiItemFails(batches[handled]!)
      await settle()
    }
    expect(batches.length).toBeLessThanOrEqual(17)
    expect(engine!.isAutoPaused()).toBe(false)
    const paragraphs = [...document.querySelectorAll('p')]
    expect(paragraphs.some((p) => p.textContent?.startsWith('译：'))).toBe(true)
    expect(paragraphs.some((p) => p.textContent?.startsWith('Sentence'))).toBe(true)
    await settle(60_000)
    expect(batches.length).toBeLessThanOrEqual(17)
  })

  it('持续输出不合格（接口配置错误）连续失败 8 次后暂停整页', async () => {
    await start(20)
    let outcome: AutoBatchOutcome = 'retrying'
    let handled = 0
    while (outcome !== 'paused' && handled < batches.length) {
      outcome = rejectBatch(batches[handled]!, { code: 'bad_output' })
      handled += 1
      await settle()
    }
    expect(outcome).toBe('paused')
    expect(batches).toHaveLength(8)
    expect(engine!.isAutoPaused()).toBe(true)
    await settle(60_000)
    expect(batches).toHaveLength(8)
  })

  it('整批全部超时、没有任何成功才暂停', async () => {
    await start(2)
    const outcomes: AutoBatchOutcome[] = []
    for (let handled = 0; handled < batches.length; handled += 1) {
      outcomes.push(rejectBatch(batches[handled]!, { code: 'timeout' }))
      await settle(60_000)
    }
    expect(outcomes.at(-1)).toBe('paused')
    expect(outcomes.slice(0, -1)).not.toContain('paused')
    expect(batches).toHaveLength(5)
  })

  it('单条反复超时但同批其他条目成功时只放弃该条', async () => {
    const texts = await start(2)
    rejectBatch(last(), { code: 'timeout' })
    await settle(60_000)
    expect(last().texts).toEqual([texts[0]])
    rejectBatch(last(), { code: 'timeout' })
    await settle(60_000)
    expect(last().texts).toEqual([texts[0]])
    expect(rejectBatch(last(), { code: 'timeout' })).toBe('skipped')
    expect(engine!.isAutoPaused()).toBe(false)
    await settle(60_000)
    expect(last().texts).toEqual([texts[1]])
    last().apply(['译文'])
    await settle(60_000)
    expect(engine!.isAutoPaused()).toBe(false)
    expect(document.querySelectorAll('p')[0]?.textContent).toBe(texts[0])
  })

  it('超时收缩字符上限，成功后缓慢回升，长文本仍可单独成批', async () => {
    await start(1)
    rejectBatch(last(), { code: 'timeout' })
    await settle(60_000)
    last().apply(['译文'])
    await settle()
    // 1500 减半为 750，成功后回升到 850
    const paragraph = 'y'.repeat(200)
    for (let index = 0; index < 6; index += 1) {
      document.body.insertAdjacentHTML('beforeend', `<p>${paragraph}${index}</p>`)
    }
    await settle()
    expect(last().texts).toHaveLength(4)
    last().apply(translate(last().texts))
    await settle()
    expect(last().texts).toHaveLength(2)
    last().apply(translate(last().texts))
    await settle()
    document.body.insertAdjacentHTML('beforeend', `<p>${'z'.repeat(1400)}</p>`)
    await settle()
    expect(last().texts).toHaveLength(1)
    expect(rejectBatch(last(), { code: 'timeout' })).toBe('retrying')
    await settle(60_000)
    expect(rejectBatch(last(), { code: 'timeout' })).toBe('retrying')
    await settle(60_000)
    expect(last().texts[0]).toHaveLength(1400)
  })

  it.each(['queue_full', 'queue_timeout', 'disconnected'] as const)('%s 不拆分批次也不收缩字符上限', async (code) => {
    await start(4)
    const sent = [...last().texts]
    expect(sent).toHaveLength(4)
    rejectBatch(last(), { code })
    await settle(60_000)
    expect(batches).toHaveLength(2)
    expect(last().texts).toEqual(sent)
    last().apply(translate(last().texts))
    await settle()
    const paragraph = 'y'.repeat(300)
    for (let index = 0; index < 6; index += 1) {
      document.body.insertAdjacentHTML('beforeend', `<p>${paragraph}${index}</p>`)
    }
    await settle()
    // 上限未收缩：1500 字符可容纳 4 段（收缩为 750 时只有 2 段）
    expect(last().texts).toHaveLength(4)
  })

  it('子批次排队超时不消耗尝试次数，也不增加子请求数', async () => {
    await start(2)
    rejectBatch(last(), { code: 'timeout' })
    await settle(60_000)
    const child = [...last().texts]
    expect(child).toHaveLength(1)
    for (let index = 0; index < 20; index += 1) {
      expect(rejectBatch(last(), { code: 'queue_timeout' })).toBe('retrying')
      await settle(60_000)
      expect(last().texts).toEqual(child)
    }
    expect(rejectBatch(last(), { code: 'timeout' })).toBe('retrying')
    await settle(60_000)
    expect(last().texts).toEqual(child)
    expect(rejectBatch(last(), { code: 'timeout' })).toBe('skipped')
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('超时重发遵守退避与 Retry-After', async () => {
    await start(2)
    rejectBatch(last(), { code: 'timeout', retryAfterMs: 5000 })
    await settle(4990)
    expect(batches).toHaveLength(1)
    await settle(20)
    expect(batches).toHaveLength(2)
  })

  it('子批次遇到瞬时失败按尝试次数重发原样，耗尽后暂停', async () => {
    const texts = await start(4)
    rejectBatch(last(), { code: 'bad_output' })
    await settle()
    expect(rejectBatch(last(), { code: 'server' })).toBe('retrying')
    await settle(60_000)
    expect(last().texts).toEqual(texts.slice(0, 2))
    expect(rejectBatch(last(), { code: 'server' })).toBe('retrying')
    await settle(60_000)
    expect(last().texts).toEqual(texts.slice(0, 2))
    expect(rejectBatch(last(), { code: 'server' })).toBe('paused')
    const sent = batches.length
    await settle(60_000)
    expect(batches).toHaveLength(sent)
  })

  it('子批次取消后原样重发；已滚出视口的条目转为延后', async () => {
    const texts = await start(4)
    rejectBatch(last(), { code: 'bad_output' })
    await settle()
    expect(rejectBatch(last(), { code: 'cancelled' })).toBe('dropped')
    await settle(1000)
    expect(last().texts).toEqual(texts.slice(0, 2))
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 2000, width: 10, height: 10, top: 2000, left: 0, right: 10, bottom: 2010 }) as DOMRect,
    )
    const sent = batches.length
    rejectBatch(last(), { code: 'cancelled' })
    await settle(2000)
    expect(batches).toHaveLength(sent)
    expect(engine!.isAutoPaused()).toBe(false)
  })

  it('invalidate 清空待发的拆分批次', async () => {
    await start(4)
    const stale = last()
    rejectBatch(stale, { code: 'bad_output' })
    engine!.invalidate()
    await settle(60_000)
    const texts = batches.slice(1).flatMap((batch) => batch.texts)
    expect(texts).toEqual([])
  })

  it('拆分重发不把字符额度耗到上限', async () => {
    const text = 'Sentence number 0.'
    document.body.innerHTML = `<p>${text}</p><p>Sentence number 1.</p>`
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      debounceMs: 10,
      autoBudget: text.length * 2,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle()
    rejectBatch(last(), { code: 'bad_output' })
    await settle()
    last().apply(['甲'])
    await settle()
    expect(engine.isCapped()).toBe(false)
    expect(last().texts).toEqual(['Sentence number 1.'])
  })
})

describe('自动翻译生命周期细节', () => {
  it('#section 变更不丢弃在途批次', async () => {
    vi.stubGlobal('location', new URL('https://app.devin.ai/work'))
    document.body.innerHTML = '<p id="a">English text here.</p><p id="b">Another english paragraph.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches.length).toBeGreaterThan(0)
    const batch = batches[0]!
    vi.stubGlobal('location', new URL('https://app.devin.ai/work#section'))
    batch.apply(['译文A', '译文B'])
    await settle()
    expect(document.querySelector('#a')?.textContent).toBe('译文A')
    expect(document.querySelector('#b')?.textContent).toBe('译文B')
    document.body.insertAdjacentHTML('beforeend', '<p id="c">Third english paragraph.</p>')
    await settle(200)
    const later = batches.at(-1)!
    later.apply(['译文C'])
    await settle()
    expect(document.querySelector('#c')?.textContent).toBe('译文C')
  })

  it('暂停后幂等 start 不恢复，仅 resumeAuto 恢复', async () => {
    vi.stubGlobal('location', new URL('https://app.devin.ai/work'))
    document.body.innerHTML = '<p>English text here.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches.length).toBe(1)
    batches[0]!.apply(undefined)
    expect(engine.isAutoPaused()).toBe(true)
    const count = batches.length
    engine.start()
    engine.start()
    await settle(300)
    expect(batches.length).toBe(count)
    expect(engine.isAutoPaused()).toBe(true)
    engine.resumeAuto()
    await settle(200)
    expect(batches.length).toBeGreaterThan(count)
  })

  it('start 期间的在途批次仍可完成', async () => {
    vi.stubGlobal('location', new URL('https://app.devin.ai/work'))
    document.body.innerHTML = '<p>English text here.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    const batch = batches[0]!
    engine.start()
    engine.start()
    batch.apply(['译文'])
    await settle()
    expect(document.querySelector('p')?.textContent).toBe('译文')
  })
})

describe('自动翻译阶段B', () => {
  it('超出观察上限的离屏节点经滚动回填后才翻译', async () => {
    const heads = Array.from({ length: 1250 }, (_, i) => `<p id="n${i}">Offscreen entry ${i}.</p>`).join('')
    document.body.innerHTML = `<main>${heads}</main>`
    const view = { current: 'head' as 'head' | 'tail' }
    const visibleId = (): string => (view.current === 'head' ? 'n0' : 'n1249')
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const el = this as HTMLElement
      const on = el.id === visibleId() || el.tagName === 'MAIN' || el.tagName === 'BODY'
      const top = on ? 0 : 5000
      return { x: 0, y: top, width: 10, height: 10, top, left: 0, right: 10, bottom: top + 10 } as DOMRect
    })
    engine = makeEngine({ auto: true })
    engine.start()
    await settle(800)
    const io = FakeIO.instances[0]
    expect(io!.observed.size).toBeLessThanOrEqual(1000)
    const sent = (): string[] => batches.flatMap((batch) => batch.texts)
    expect(sent()).toContain('Offscreen entry 0.')
    expect(sent()).not.toContain('Offscreen entry 1249.')
    for (const batch of batches) batch.apply(batch.texts.map(() => '译文'))
    await settle(200)
    view.current = 'tail'
    window.dispatchEvent(new Event('scroll'))
    await settle(1000)
    for (const batch of batches) {
      if (batch.texts.includes('Offscreen entry 1249.')) batch.apply(batch.texts.map(() => '译文'))
    }
    expect(sent().filter((t) => t === 'Offscreen entry 1249.')).toHaveLength(1)
    expect(document.querySelector('#n1249')?.textContent).toBe('译文')
    expect(sent().filter((t) => t === 'Offscreen entry 0.')).toHaveLength(1)
  })

  it('自动请求裁剪首尾空白，写回保留原始空白', async () => {
    document.body.innerHTML = '<p>  English text here.\n </p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches.length).toBe(1)
    expect(batches[0]?.texts).toEqual(['English text here.'])
    batches[0]!.apply(['译文'])
    await settle()
    expect(document.querySelector('p')?.textContent).toBe('  译文\n ')
  })

  it('记录数上限后暂停，释放槽位可继续', async () => {
    document.body.innerHTML = '<p id="a">Alpha sentence here.</p><p id="b">Bravo sentence here.</p><p id="c">Charlie sentence here.</p>'
    let notified = 0
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      debounceMs: 10,
      recordBudget: 2,
      onCapped() {
        notified += 1
      },
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle(500)
    for (const batch of batches) batch.apply(batch.texts.map(() => '译'))
    await settle(200)
    expect(engine.isCapped()).toBe(true)
    expect(notified).toBe(1)
    const sent = batches.flatMap((batch) => batch.texts)
    expect(sent.length).toBeLessThanOrEqual(2)
    document.querySelector('#a')?.remove()
    await settle(600)
    expect(engine.isCapped()).toBe(false)
    const last = batches.at(-1)
    if (last !== undefined) last.apply(last.texts.map(() => '译'))
    await settle(200)
    const all = batches.flatMap((batch) => batch.texts)
    expect(all).toContain('Charlie sentence here.')
    expect(notified).toBe(1)
  })

  it('隐藏节点不发送，切换 open 后恰好一次请求', async () => {
    document.body.innerHTML = '<details id="d" hidden><p id="h">Hidden revealable sentence.</p></details>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle(600)
    expect(batches.flatMap((batch) => batch.texts)).not.toContain('Hidden revealable sentence.')
    const details = document.querySelector('#d')!
    details.removeAttribute('hidden')
    details.setAttribute('open', '')
    details.dispatchEvent(new Event('toggle'))
    await settle(600)
    const sent = batches.flatMap((batch) => batch.texts).filter((t) => t === 'Hidden revealable sentence.')
    expect(sent.length).toBe(1)
    engine.dispose()
    details.dispatchEvent(new Event('toggle'))
    window.dispatchEvent(new Event('scroll'))
    await settle(600)
    expect(batches.flatMap((batch) => batch.texts).filter((t) => t === 'Hidden revealable sentence.').length).toBe(1)
  })
})

describe('上限语义', () => {
  function cappedEngine(options: { recordBudget?: number; autoBudget?: number; fixed?: boolean; notify: () => void }): DomEngine {
    return createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => options.fixed === true,
      autoEnabled: () => true,
      translateFixed: (text) => fixedTranslationWith(DEVIN_ENTRIES, text),
      debounceMs: 10,
      recordBudget: options.recordBudget,
      autoBudget: options.autoBudget,
      onCapped: options.notify,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
  }

  it('显式恢复释放记录数上限，字符上限不释放', async () => {
    document.body.innerHTML = '<p id="a">Alpha sentence here.</p><p id="b">Bravo sentence here.</p>'
    let notified = 0
    engine = cappedEngine({ recordBudget: 1, notify: () => { notified += 1 } })
    engine.start()
    await settle(500)
    for (const batch of batches) batch.apply(batch.texts.map(() => '译'))
    await settle(400)
    expect(engine.isCapped()).toBe(true)
    expect(notified).toBe(1)
    engine.restore()
    expect(engine.isCapped()).toBe(false)
    expect(notified).toBe(1)
  })

  it('字符预算上限在恢复后仍然成立', async () => {
    document.body.innerHTML = '<p>Alpha sentence here.</p><p>Bravo sentence here.</p>'
    let notified = 0
    engine = cappedEngine({ autoBudget: 25, notify: () => { notified += 1 } })
    engine.start()
    await settle(500)
    for (const batch of batches) batch.apply(batch.texts.map(() => '译'))
    await settle(400)
    expect(engine.isCapped()).toBe(true)
    expect(notified).toBe(1)
    const count = batches.length
    engine.restore()
    expect(engine.isCapped()).toBe(true)
    engine.start()
    await settle(400)
    expect(batches.length).toBe(count)
  })

  it('在途批次的预扣不造成假上限，也不吞掉之后真实上限的提示', async () => {
    const text = 'Alpha sentence here.'
    document.body.innerHTML = `<p>${text}</p>`
    let notified = 0
    engine = cappedEngine({ autoBudget: text.length, notify: () => { notified += 1 } })
    engine.start()
    await settle(500)
    expect(batches).toHaveLength(1)
    document.body.insertAdjacentHTML('beforeend', '<p>Bravo sentence here.</p>')
    await settle(400)
    expect(engine.isCapped()).toBe(false)
    expect(notified).toBe(0)
    batches[0]!.apply(['译'], undefined, text.length)
    await settle(400)
    expect(batches[1]?.texts).toEqual(['Bravo sentence here.'])
    batches[1]!.apply(['译'])
    await settle(100)
    document.body.insertAdjacentHTML('beforeend', '<p>Charlie sentence.</p>')
    await settle(400)
    expect(engine.isCapped()).toBe(true)
    expect(notified).toBe(1)
    expect(batches).toHaveLength(2)
  })

  it('上限释放后再次真实触顶会重新提示', async () => {
    document.body.innerHTML = '<p>Alpha sentence here.</p><p>Bravo sentence here.</p>'
    let notified = 0
    const released = vi.fn()
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      debounceMs: 10,
      autoBudget: 25,
      onCapped: () => { notified += 1 },
      onCapReleased: released,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle(500)
    batches[0]!.apply(['译'])
    await settle(400)
    expect(engine.isBudgetCapped()).toBe(true)
    expect(notified).toBe(1)
    expect(engine.extendBudget()).toBe(true)
    expect(released).toHaveBeenCalledTimes(1)
    expect(engine.isCapped()).toBe(false)
    await settle(500)
    expect(batches[1]?.texts).toEqual(['Bravo sentence here.'])
    batches[1]!.apply(['译'])
    await settle(100)
    document.body.insertAdjacentHTML('beforeend', '<p>Charlie sentence here.</p>')
    await settle(400)
    expect(engine.isBudgetCapped()).toBe(true)
    expect(notified).toBe(2)
  })

  it('记录数上限不能靠追加额度释放', async () => {
    document.body.innerHTML = '<p>Alpha sentence here.</p><p>Bravo sentence here.</p>'
    engine = cappedEngine({ recordBudget: 1, notify: () => undefined })
    engine.start()
    await settle(500)
    for (const batch of batches) batch.apply(batch.texts.map(() => '译'))
    await settle(400)
    expect(engine.isCapped()).toBe(true)
    expect(engine.isBudgetCapped()).toBe(false)
    expect(engine.extendBudget()).toBe(false)
    expect(engine.isCapped()).toBe(true)
  })

  it('重置额度后可重新翻译；追加的额度不累积，迟到回包不能退款', async () => {
    const text = 'Alpha sentence here.'
    document.body.innerHTML = `<p id="a">${text}</p>`
    let notified = 0
    engine = cappedEngine({ autoBudget: text.length, notify: () => { notified += 1 } })
    engine.start()
    await settle(500)
    batches[0]!.apply(['译'])
    await settle(100)
    document.body.insertAdjacentHTML('beforeend', '<p>Bravo sentence here.</p>')
    await settle(400)
    expect(engine.isCapped()).toBe(true)
    engine.restore()
    expect(engine.isCapped()).toBe(true)
    engine.resetBudget()
    expect(engine.isCapped()).toBe(false)
    engine.start()
    await settle(500)
    expect(batches).toHaveLength(2)
    expect(batches[1]!.texts).toEqual([text])
    engine.restore()
    engine.resetBudget()
    expect(batches[1]!.apply(['译'], undefined, text.length)).toBe('stale')
    engine.start()
    await settle(500)
    batches[2]!.apply(['译'])
    await settle(100)
    document.body.insertAdjacentHTML('beforeend', '<p>Charlie sentence here.</p>')
    await settle(400)
    expect(engine.isBudgetCapped()).toBe(true)
    expect(notified).toBe(2)
    expect(batches).toHaveLength(3)
  })

  it('无可译属性的控件不触发记录上限', async () => {
    document.body.innerHTML = '<p>Alpha sentence here.</p>'
    let notified = 0
    engine = cappedEngine({ recordBudget: 1, fixed: true, notify: () => { notified += 1 } })
    engine.start()
    await settle(500)
    for (const batch of batches) batch.apply(batch.texts.map(() => '译'))
    await settle(400)
    document.body.insertAdjacentHTML('beforeend', '<nav><button id="x" title="Not-In-Dictionary-XYZ"></button></nav>')
    await settle(400)
    expect(document.querySelector('#x')?.getAttribute('title')).toBe('Not-In-Dictionary-XYZ')
    expect(engine.isCapped()).toBe(false)
    expect(notified).toBe(0)
  })

  it('记录数拒绝不能替换或释放字符上限', async () => {
    document.body.innerHTML = '<p id="a">Alpha text.</p>'
    let notified = 0
    engine = cappedEngine({ recordBudget: 2, autoBudget: 11, fixed: true, notify: () => { notified += 1 } })
    engine.start()
    await settle(500)
    batches[0]!.apply(['译'])
    await settle(100)
    document.body.insertAdjacentHTML('beforeend', '<p id="late">Delta queued words.</p>')
    await settle(400)
    expect(engine.isBudgetCapped()).toBe(true)
    expect(notified).toBe(1)
    document.body.insertAdjacentHTML('beforeend', '<nav><button id="fx" title="Settings"></button><button id="fy" title="Settings"></button></nav>')
    await settle(400)
    expect(document.querySelector('#fx')?.getAttribute('title')).toBe('设置')
    expect(document.querySelector('#fy')?.getAttribute('title')).toBe('Settings')
    expect(engine.isBudgetCapped()).toBe(true)
    expect(notified).toBe(1)
    document.querySelector('#a')?.remove()
    await settle(600)
    expect(engine.isBudgetCapped()).toBe(true)
    expect(document.querySelector('#late')?.textContent).toBe('Delta queued words.')
    expect(batches).toHaveLength(1)
    expect(notified).toBe(1)
  })

  it('固定词库引擎释放文本记录后补齐被据写的节点', async () => {
    document.body.innerHTML = '<nav><button id="a">Settings</button><button id="b">Settings</button></nav>'
    let notified = 0
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => true,
      autoEnabled: () => false,
      translateFixed: (text) => fixedTranslationWith(DEVIN_ENTRIES, text),
      debounceMs: 10,
      recordBudget: 1,
      onCapped() {
        notified += 1
      },
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle(300)
    expect(document.querySelector('#a')?.textContent).toBe('设置')
    expect(document.querySelector('#b')?.textContent).toBe('Settings')
    expect(engine.isCapped()).toBe(true)
    expect(batches).toHaveLength(0)
    document.querySelector('#a')?.remove()
    await settle(600)
    expect(engine.isCapped()).toBe(false)
    expect(document.querySelector('#b')?.textContent).toBe('设置')
    expect(batches).toHaveLength(0)
    expect(notified).toBe(1)
  })

  it('属性归属释放后补齐被据写的第二个控件', async () => {
    document.body.innerHTML = '<nav><button id="a" title="Settings"></button><button id="b" title="Settings"></button></nav>'
    let notified = 0
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => true,
      autoEnabled: () => false,
      translateFixed: (text) => fixedTranslationWith(DEVIN_ENTRIES, text),
      debounceMs: 10,
      recordBudget: 1,
      onCapped() {
        notified += 1
      },
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
    engine.start()
    await settle(300)
    const a = document.querySelector('#a')!
    const b = document.querySelector('#b')!
    expect(a.getAttribute('title')).toBe('设置')
    expect(b.getAttribute('title')).toBe('Settings')
    expect(engine.isCapped()).toBe(true)
    a.setAttribute('title', 'Not-In-Dictionary-XYZ')
    await settle(600)
    expect(engine.isCapped()).toBe(false)
    expect(b.getAttribute('title')).toBe('设置')
    expect(a.getAttribute('title')).toBe('Not-In-Dictionary-XYZ')
    expect(batches).toHaveLength(0)
    expect(notified).toBe(1)
  })

  it('布局拒绝后同源不再请求，源变更可重试', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return (this.textContent?.length ?? 0) * 5
    })
    document.body.innerHTML = '<button id="b">Apply changes now please.</button>'
    const longResult = '译文译文译文译文译文译文译文译文译文译文译文译文译文译文译文译文'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle(600)
    expect(batches.length).toBe(1)
    batches[0]!.apply([longResult])
    await settle(200)
    expect(document.querySelector('#b')?.textContent).toBe('Apply changes now please.')
    engine.start()
    await settle(400)
    const button = document.querySelector('#b')!
    button.setAttribute('class', 'mutated')
    await settle(500)
    expect(batches.length).toBe(1)
    button.firstChild!.nodeValue = 'Apply changes immediately today.'
    await settle(600)
    expect(batches.length).toBe(2)
    batches[1]!.apply(['译文'])
    await settle()
    expect(button.textContent).toBe('译文')
  })

  it('词典预占被布局拒绝后不清空在途长段落', async () => {
    const source = Array.from({ length: 90 }, (_, index) =>
      `Long paragraph sentence ${index} has enough English words for chunking. `,
    ).join('').trim()
    document.body.innerHTML = `<p id="long">${source}</p>`
    let notices = 0
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.id.startsWith('bad') && this.textContent === '设置' ? 1000 : 0
    })
    engine = createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => true,
      autoEnabled: () => true,
      translateFixed: (text) => fixedTranslationWith(DEVIN_ENTRIES, text),
      recordBudget: 2,
      autoBudget: 30000,
      debounceMs: 10,
      onCapped() { notices += 1 },
      onAutoBatch(texts, apply) { batches.push({ texts: [...texts], apply }) },
    })
    engine.start()
    await settle(300)
    expect(batches).toHaveLength(1)
    const firstChunk = batches[0]!.texts[0]!
    expect(firstChunk.length).toBeGreaterThan(1000)
    document.body.insertAdjacentHTML('beforeend',
      '<nav><button id="bad1">Settings</button><button id="bad2">Settings</button></nav><p id="other">Another English paragraph waiting for translation.</p>',
    )
    await settle(200)
    // 顺序交付所有批次，避免只看下一批而漏掉排队顺序的变化。
    for (let index = 0; index < 20 && index < batches.length; index += 1) {
      const batch = batches[index]!
      batch.apply(batch.texts.map(() => '译文'))
      await settle(100)
    }
    expect(document.querySelector('#long')!.textContent).not.toBe(source)
    expect(batches.flatMap((batch) => batch.texts)).toContain('Another English paragraph waiting for translation.')
    const firstChunkRequests = batches.reduce((count, batch) =>
      count + batch.texts.filter((text) => text === firstChunk).length, 0,
    )
    expect({ notices, firstChunkRequests }).toEqual({ notices: 0, firstChunkRequests: 1 })
  })

  it('字符额度上限不阻止释放预占后的词典翻译', async () => {
    document.body.innerHTML = '<p>Alpha sentence here.</p>'
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.id === 'bad' && this.textContent === '设置' ? 1000 : 0
    })
    engine = makeEngine({ fixed: true, auto: true, recordBudget: 1, autoBudget: 1 })
    engine.start()
    await settle(300)
    expect(engine.isBudgetCapped()).toBe(true)
    expect(batches).toHaveLength(0)
    document.body.insertAdjacentHTML('beforeend',
      '<nav><button id="bad">Settings</button><button id="good">Settings</button></nav>',
    )
    await settle(400)
    expect(document.querySelector('#bad')!.textContent).toBe('Settings')
    expect(engine.isBudgetCapped()).toBe(true)
    expect(document.querySelector('#good')!.textContent).toBe('设置')
  })
})

describe('长文本分段与失败段统计', () => {
  /** 约 3700 字符：切成 3 段，每段独立成批。 */
  const LONG = Array.from({ length: 100 }, (_, index) => `Sentence number ${index} of a long article body.`).join(' ')
  const CHUNKS = splitLongText(LONG).chunks
  const translate = (texts: readonly string[]): string[] => texts.map((text) => `译：${text}`)
  const WHOLE = translate(CHUNKS).join('')
  const BAD: FailureInfo = { code: 'bad_output' }
  const reject = ({ apply }: Batch, failure: FailureInfo = BAD): AutoBatchOutcome => apply(undefined, failure)

  function longEngine(extra: { autoBudget?: number; onFailedChanged?: () => void } = {}): DomEngine {
    return createDomEngine({
      targetLanguage: () => 'zh-CN',
      fixedEnabled: () => false,
      autoEnabled: () => true,
      debounceMs: 10,
      random: () => 0,
      autoBudget: extra.autoBudget,
      onFailedChanged: extra.onFailedChanged,
      onAutoBatch(texts, apply) {
        batches.push({ texts: [...texts], apply })
      },
    })
  }

  async function startPage(html: string, extra: Parameters<typeof longEngine>[0] = {}): Promise<void> {
    document.body.innerHTML = html
    engine = longEngine(extra)
    engine.start()
    await settle()
  }

  it.each([[-1, true], [0, false]] as const)('分段取消只退还未完成预扣，额度偏移 %s', async (offset, capped) => {
    await startPage(`<p>${LONG}</p>`, { autoBudget: LONG.length + CHUNKS[0]!.length + offset })
    batches[0]!.apply(translate(batches[0]!.texts))
    await settle()
    const late = batches[1]!
    engine!.invalidate()
    engine!.start()
    expect(late.apply(translate(late.texts))).toBe('stale')
    await settle(200)
    expect(document.querySelector('p')!.textContent).toBe(LONG)
    expect(engine!.isBudgetCapped()).toBe(capped)
    expect(batches).toHaveLength(capped ? 2 : 3)
  })

  it('分段在途时移动到新父元素，旧结果不阻塞新位置的续译', async () => {
    await startPage(`<div id="old"><p>${LONG}</p></div><div id="new"></div>`)
    const node = document.querySelector('#old p')!.firstChild!
    const target = document.querySelector('#new')!
    const old = batches[0]!
    target.append(node)
    // 先处理页面搬动触发的扫描/清理，之后旧请求才回包。
    await settle(200)
    expect(batches).toHaveLength(1)
    old.apply(translate(old.texts))
    await settle(200)
    expect(batches).toHaveLength(2)
    expect(target.textContent).toBe(LONG)
    await answerAll(1)
    expect(target.textContent).toBe(WHOLE)
    expect(document.querySelector('#old')!.textContent).toBe('')
    expect(engine!.failedCount()).toBe(0)
    engine!.restore()
    expect(target.textContent).toBe(LONG)
    expect(document.querySelector('#old')!.textContent).toBe('')
  })

  /** 依次成功回复尚未回复的批次，直到不再有新批次。 */
  async function answerAll(from = 0, cached = false): Promise<void> {
    for (let index = from; index < batches.length; index += 1) {
      const { texts, apply } = batches[index]!
      apply(translate(texts), undefined, cached ? texts.join('').length : 0)
      await settle()
    }
  }

  /** 让一段连续失败到被放弃。 */
  async function failUntilGivenUp(): Promise<void> {
    reject(batches.at(-1)!)
    await settle()
    expect(reject(batches.at(-1)!)).toBe('skipped')
    await settle()
  }

  it('前提：测试文本确实超长且切成多段', () => {
    expect(LONG.length).toBeGreaterThan(1500)
    expect(CHUNKS.length).toBe(3)
  })

  it('超长文本分段发送，全部到齐才写回，保留首尾空白；恢复还原全文', async () => {
    await startPage(`<p>  ${LONG}  </p>`)
    const p = document.querySelector('p')!
    const original = p.textContent
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual([CHUNKS[0]])
    batches[0]!.apply(translate(batches[0]!.texts))
    await settle()
    expect(p.textContent).toBe(original)
    expect(batches[1]!.texts).toEqual([CHUNKS[1]])
    batches[1]!.apply(translate(batches[1]!.texts))
    await settle()
    expect(p.textContent).toBe(original)
    await answerAll(2)
    expect(batches.flatMap((batch) => batch.texts)).toEqual(CHUNKS)
    expect(batches.every((batch) => batch.texts.join('').length <= 1500)).toBe(true)
    expect(p.textContent).toBe(`  ${WHOLE}  `)
    expect(engine!.failedCount()).toBe(0)
    engine!.restore()
    expect(p.textContent).toBe(original)
  })

  it('分段进行中重新扫描不重开一轮', async () => {
    await startPage(`<p>${LONG}</p>`)
    window.dispatchEvent(new Event('resize'))
    await settle(1000)
    expect(batches).toHaveLength(1)
    batches[0]!.apply(translate(batches[0]!.texts))
    window.dispatchEvent(new Event('resize'))
    await settle(1000)
    await answerAll(1)
    expect(batches.flatMap((batch) => batch.texts)).toEqual(CHUNKS)
    expect(document.querySelector('p')!.textContent).toBe(WHOLE)
  })

  it('一段失败：保留原文、计入失败、其余分段不再发送、重新扫描不重发', async () => {
    const changed = vi.fn()
    await startPage(`<p>${LONG}</p>`, { onFailedChanged: changed })
    batches[0]!.apply(translate(batches[0]!.texts))
    await settle()
    expect(batches[1]!.texts).toEqual([CHUNKS[1]])
    await failUntilGivenUp()
    expect(batches.flatMap((batch) => batch.texts)).toEqual([CHUNKS[0], CHUNKS[1], CHUNKS[1]])
    expect(document.querySelector('p')!.textContent).toBe(LONG)
    expect(engine!.failedCount()).toBe(1)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(engine!.isAutoPaused()).toBe(false)
    const sent = batches.length
    window.dispatchEvent(new Event('resize'))
    await settle(1000)
    expect(batches).toHaveLength(sent)
  })

  it('普通短文本被放弃也计入失败', async () => {
    await startPage('<p>Poison sentence.</p><p>Good sentence.</p>')
    batches[0]!.apply(['', '好句子'])
    await settle()
    expect(batches[1]!.texts).toEqual(['Poison sentence.'])
    reject(batches[1]!)
    await settle()
    expect(engine!.failedCount()).toBe(1)
    expect(document.querySelectorAll('p')[1]!.textContent).toBe('好句子')
  })

  it('全部重试只重发失败段，已译内容不重发；成功后清零，再失败再计入', async () => {
    await startPage(`<p id="long">${LONG}</p><p id="short">Short tail paragraph.</p>`)
    batches[0]!.apply(translate(batches[0]!.texts))
    await settle()
    await failUntilGivenUp()
    expect(engine!.failedCount()).toBe(1)
    expect(batches.at(-1)!.texts).toEqual(['Short tail paragraph.'])
    await answerAll(batches.length - 1)
    expect(document.querySelector('#short')!.textContent).toBe('译：Short tail paragraph.')
    const before = batches.length
    expect(engine!.retryFailed()).toBe(true)
    expect(engine!.failedCount()).toBe(0)
    await settle()
    expect(batches).toHaveLength(before + 1)
    expect(batches.at(-1)!.texts).toEqual([CHUNKS[0]])
    batches.at(-1)!.apply(translate(batches.at(-1)!.texts))
    await settle()
    await failUntilGivenUp()
    expect(engine!.failedCount()).toBe(1)
    expect(engine!.retryFailed()).toBe(true)
    await settle()
    await answerAll(batches.length - 1)
    expect(engine!.failedCount()).toBe(0)
    expect(document.querySelector('#long')!.textContent).toBe(WHOLE)
    expect(batches.flatMap((batch) => batch.texts).filter((text) => text === 'Short tail paragraph.')).toHaveLength(1)
  })

  it('全部重试不重置额度：放不下时进入可追加的字符上限', async () => {
    await startPage(`<p>${LONG}</p>`, { autoBudget: LONG.length + CHUNKS[0]!.length - 1 })
    batches[0]!.apply(translate(batches[0]!.texts))
    await settle()
    await failUntilGivenUp()
    expect(engine!.retryFailed()).toBe(true)
    await settle()
    expect(engine!.isBudgetCapped()).toBe(true)
    const sent = batches.length
    expect(engine!.extendBudget()).toBe(true)
    await settle(100)
    expect(batches).toHaveLength(sent + 1)
    expect(batches.at(-1)!.texts).toEqual([CHUNKS[0]])
  })

  it('暂停或上限时 retryFailed 不动作并保留失败记录', async () => {
    await startPage(`<p>${LONG}</p>`)
    batches[0]!.apply(translate(batches[0]!.texts))
    await settle()
    await failUntilGivenUp()
    engine!.pauseAuto()
    expect(engine!.retryFailed()).toBe(false)
    expect(engine!.failedCount()).toBe(1)
  })

  it('恢复原文、作废、继续都清除失败记录', async () => {
    const giveUp = async (): Promise<void> => {
      await settle()
      reject(batches.at(-1)!)
      await settle()
      reject(batches.at(-1)!)
      await settle()
      expect(engine!.failedCount()).toBe(1)
    }
    await startPage('<p>Poison sentence.</p>')
    await giveUp()
    engine!.restore()
    expect(engine!.failedCount()).toBe(0)
    engine!.start()
    await giveUp()
    engine!.invalidate()
    expect(engine!.failedCount()).toBe(0)
    await settle()
    document.querySelector('p')!.setAttribute('class', 'rescan')
    await giveUp()
    engine!.pauseAuto()
    engine!.resumeAuto()
    expect(engine!.failedCount()).toBe(0)
  })

  it('导航清除失败记录', async () => {
    vi.stubGlobal('location', new URL('https://example.com/a'))
    await startPage('<p>Poison sentence.</p>')
    reject(batches.at(-1)!)
    await settle()
    reject(batches.at(-1)!)
    await settle()
    expect(engine!.failedCount()).toBe(1)
    vi.stubGlobal('location', new URL('https://example.com/b'))
    engine!.start()
    expect(engine!.failedCount()).toBe(0)
  })

  it('失败节点被移除或原文变化后不再计数', async () => {
    const changed = vi.fn()
    await startPage('<p id="a">Poison sentence.</p><p id="b">Another poison.</p>', { onFailedChanged: changed })
    batches[0]!.apply(['', ''])
    await settle()
    for (let round = 0; round < 4; round += 1) {
      reject(batches.at(-1)!)
      await settle()
    }
    expect(engine!.failedCount()).toBe(2)
    changed.mockClear()
    document.querySelector('#a')!.remove()
    await settle()
    expect(changed).toHaveBeenCalled()
    expect(engine!.failedCount()).toBe(1)
    document.querySelector('#b')!.firstChild!.nodeValue = 'Rewritten by the site.'
    await settle()
    expect(engine!.failedCount()).toBe(0)
  })

  it('额度结算：分段按字符计费，缓存命中退款', async () => {
    const tail = 'A'.repeat(500)
    const budget = LONG.length + 400
    await startPage(`<p>${LONG}</p><p>${tail}</p>`, { autoBudget: budget })
    await answerAll()
    await settle()
    expect(document.querySelector('p')!.textContent).toBe(WHOLE)
    expect(engine!.isBudgetCapped()).toBe(true)
    engine!.dispose()
    batches = []
    await startPage(`<p>${LONG}</p><p>${tail}</p>`, { autoBudget: budget })
    await answerAll(0, true)
    await settle()
    expect(engine!.isCapped()).toBe(false)
    expect(document.querySelectorAll('p')[1]!.textContent).toBe(`译：${tail}`)
  })

  it('剩余额度放不下：进入字符上限而不是静默跳过', async () => {
    await startPage(`<p>${'B'.repeat(1000)}</p><p>${LONG}</p>`, { autoBudget: LONG.length + 500 })
    await answerAll()
    await settle()
    expect(engine!.isBudgetCapped()).toBe(true)
    expect(engine!.failedCount()).toBe(0)
    expect(document.querySelectorAll('p')[1]!.textContent).toBe(LONG)
  })

  it('比整份额度还长：计入失败，不卡住页面其余内容', async () => {
    await startPage(`<p>${LONG}</p><p>Short tail paragraph.</p>`, { autoBudget: 2000 })
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual(['Short tail paragraph.'])
    expect(engine!.failedCount()).toBe(1)
    expect(engine!.isCapped()).toBe(false)
    expect(document.querySelector('p')!.textContent).toBe(LONG)
  })

  it('分段期间原文变化：作废旧分段，只翻译新内容', async () => {
    await startPage(`<p>${LONG}</p>`)
    batches[0]!.apply(translate(batches[0]!.texts))
    document.querySelector('p')!.firstChild!.nodeValue = 'The site rewrote this.'
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1]!.texts).toEqual(['The site rewrote this.'])
    batches[1]!.apply(['译文'])
    await settle()
    expect(document.querySelector('p')!.textContent).toBe('译文')
  })

  it('分段期间暂停：继续后从头分段且只写一次', async () => {
    await startPage(`<p>${LONG}</p>`)
    batches[0]!.apply(translate(batches[0]!.texts))
    await settle()
    expect(reject(batches[1]!, { code: 'auth' })).toBe('paused')
    await settle()
    expect(engine!.isAutoPaused()).toBe(true)
    expect(engine!.failedCount()).toBe(0)
    const sent = batches.length
    engine!.resumeAuto()
    await settle()
    expect(batches).toHaveLength(sent + 1)
    expect(batches.at(-1)!.texts).toEqual([CHUNKS[0]])
    await answerAll(sent)
    expect(document.querySelector('p')!.textContent).toBe(WHOLE)
  })

  it('布局拒绝长文本译文：回滚原文，不计失败也不重复请求', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return (this.textContent?.length ?? 0) * 5
    })
    await startPage(`<button>${LONG}</button>`)
    await answerAll()
    const button = document.querySelector('button')!
    expect(button.textContent).toBe(LONG)
    expect(engine!.failedCount()).toBe(0)
    const sent = batches.length
    button.setAttribute('class', 'mutated')
    await settle(500)
    expect(batches).toHaveLength(sent)
  })
})

it('review5 长文本进入模型批次而不是整段漏翻', async () => {
  const source = Array.from({ length: 100 }, (_, index) => `Sentence ${index} in a long article.`).join(' ')
  document.body.innerHTML = `<p>${source}</p>`
  engine = makeEngine({ auto: true })
  engine.start()
  await settle(200)
  expect(batches).toHaveLength(1)
  expect(batches[0]!.texts.every((text) => text.length <= 1500)).toBe(true)
  expect(document.querySelector('p')!.textContent).toBe(source)
})

it('review5 失败记录和已译记录共享上限，移除节点释放容量', async () => {
  const long = 'A very long untranslatable paragraph. '.repeat(100)
  document.body.innerHTML = '<p id="good">Good sentence.</p>' + `<p class="failed">${long}</p>`.repeat(3)
  engine = makeEngine({ auto: true, recordBudget: 2, autoBudget: 1800 })
  engine.start()
  await settle(200)
  expect(batches).toHaveLength(1)
  batches[0]!.apply(['好句子'])
  await settle(200)
  expect(engine.failedCount()).toBe(1)
  expect(engine.isCapped()).toBe(true)
  expect(engine.isBudgetCapped()).toBe(false)
  for (const node of document.querySelectorAll('.failed')) node.remove()
  document.body.insertAdjacentHTML('beforeend', '<p id="tail">Short tail sentence.</p>')
  await settle(300)
  expect(engine.failedCount()).toBe(0)
  expect(batches).toHaveLength(2)
  expect(batches[1]!.texts).toEqual(['Short tail sentence.'])
  batches[1]!.apply(['尾部短句'])
  await settle(100)
  expect(document.querySelector('#tail')!.textContent).toBe('尾部短句')
})

describe('行内单元翻译', () => {
  it('带行内格式的段落合并为一个占位请求并回填各文本节点', async () => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual(['Click <1>here</1> to <2>continue</2>.'])
    batches[0]!.apply(['点击<1>这里</1>以<2>继续</2>。'])
    await settle()
    const p = document.body.firstElementChild!
    expect(p.querySelector('a')!.textContent).toBe('这里')
    expect(p.querySelector('b')!.textContent).toBe('继续')
    expect(p.textContent).toBe('点击 这里 以 继续。')
    engine.restore()
    expect(p.textContent).toBe('Click here to continue.')
    expect(p.querySelector('a')!.textContent).toBe('here')
  })

  it('首节点在行内元素里的段落仍作为一个请求发出', async () => {
    // 锚点节点位于 <a> 内：liveEntry 的父元素判断必须以 block 为准
    document.body.innerHTML = '<p><a href="#">Docs</a> and more details.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual(['<1>Docs</1> and more details.'])
    batches[0]!.apply(['<1>文档</1>与更多细节。'])
    await settle()
    expect(document.body.firstElementChild!.textContent).toBe('文档 与更多细节。')
  })

  it('回复缺占位标签 → 成员退回逐节点路径重新排队', async () => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches[0]!.texts).toEqual(['Click <1>here</1> to <2>continue</2>.'])
    batches[0]!.apply(['点击这里以继续。'])
    await settle()
    // 单元解析失败：成员各自逐节点重排，不再成单元
    expect(batches.length).toBeGreaterThanOrEqual(2)
    const fragments = batches.slice(1).flatMap((batch) => batch.texts)
    expect(fragments).toContain('Click')
    expect(fragments).toContain('here')
    expect(fragments).toContain('continue')
    expect(fragments.every((text) => !text.includes('</'))).toBe(true)
  })

  it('code 文本不变（独立占位不参与写回）', async () => {
    document.body.innerHTML = '<p>Run <code>npm i</code> now please.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches[0]!.texts).toEqual(['Run <1/> now please.'])
    batches[0]!.apply(['运行<1/>现在请。'])
    await settle()
    expect(document.querySelector('code')!.textContent).toBe('npm i')
    expect(document.body.firstElementChild!.textContent).toBe('运行 npm i 现在请。')
  })

  it('在途期间成员被外部改动 → 结果丢弃，成员按逐节点重排', async () => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    // 在途：改动 a 内文本节点
    const anchor = document.querySelector('a')!.firstChild as Text
    anchor.nodeValue = 'CHANGED'
    batches[0]!.apply(['点击<1>这里</1>以<2>继续</2>。'])
    await settle()
    // 结果被丢弃：成员保持改动后的值，未被译文覆盖
    expect(anchor.nodeValue).toBe('CHANGED')
    expect(document.querySelector('b')!.textContent).toBe('continue')
  })

  it('成员布局校验失败 → 已写成员还原、不计失败、下一轮逐节点请求不含被拒节点', async () => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    // <a> 是 constrained 元素：写后 scrollWidth 骤增触发布局拒绝（第二个成员失败）
    const a = document.querySelector('a')!
    Object.defineProperty(a, 'scrollWidth', {
      configurable: true,
      get: () => (a.textContent === '这里' ? 9999 : 10),
    })
    Object.defineProperty(a, 'clientWidth', { configurable: true, get: () => 10 })
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    batches[0]!.apply(['点击<1>这里</1>以<2>继续</2>。'])
    const p = document.body.firstElementChild!
    // 整单元还原：已写成员恢复原文，不计失败（断言发生在回退批次写回之前）
    expect(p.textContent).toBe('Click here to continue.')
    expect(engine.failedCount()).toBe(0)
    // 下一轮：成员按逐节点路径重新排队，被拒的 'here' 由 rejected 挡住
    await settle(300)
    const fragments = batches.slice(1).flatMap((batch) => batch.texts)
    expect(fragments).toContain('Click')
    expect(fragments).toContain('continue')
    expect(fragments).not.toContain('here')
  })

  it('open shadow root 内的文本被扫描翻译，closed shadow 静默跳过', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>Shadow paragraph text here.</p>'
    const closedHost = document.createElement('div')
    document.body.appendChild(closedHost)
    closedHost.attachShadow({ mode: 'closed' }).innerHTML = '<p>Hidden text node</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toContain('Shadow paragraph text here.')
    expect(batches[0]!.texts.join(' ')).not.toContain('Hidden text node')
    batches[0]!.apply(['影子段落译文。'])
    await settle()
    expect(shadow.querySelector('p')!.textContent).toBe('影子段落译文。')
    // shadow 内新增节点触发重扫
    shadow.innerHTML += '<p>New shadow text.</p>'
    await settle(300)
    expect(batches.slice(1).flatMap((batch) => batch.texts)).toContain('New shadow text.')
  })
})

describe('行内单元快照生命周期', () => {
  it('在途期间成员换父/隐藏 → 旧结果不写入；恢复合法结构后重新请求当前内容', async () => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches[0]!.texts).toEqual(['Click <1>here</1> to <2>continue</2>.'])
    // 在途：把 a 文本搬进 code（code 不透出 → 结构变化）
    const a = document.querySelector('a')!
    const moved = a.firstChild as Text
    a.removeChild(moved)
    const code = document.createElement('code')
    code.appendChild(moved)
    document.querySelector('p')!.appendChild(code)
    batches[0]!.apply(['点击<1>这里</1>以<2>继续</2>。'])
    await settle()
    // 旧结果被丢弃：任何成员都没被写入
    expect(moved.nodeValue).toBe('here')
    expect(document.querySelector('a')!.textContent).toBe('')
    // 恢复合法结构：搬回 a、移除 code → 重扫后重新请求当前内容
    code.remove()
    a.appendChild(moved)
    engine.restore()
    engine.start()
    await settle()
    const last = batches.at(-1)!
    expect(last.texts[0]).toContain('here')
    expect(last.texts[0]).not.toContain('code')
    last.apply(['重新<1>译过</1>的<2>内容</2>。'])
    expect(document.querySelector('a')!.textContent).toBe('译过')
  })

  it('recordBudget=2、5成员unit → 退回逐节点路径、恰好保留2个译文、正确封顶', async () => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    engine = makeEngine({ auto: true, recordBudget: 2 })
    engine.start()
    await settle()
    // 单元成本 5 > slots 2 → drop + 逐节点 fallback，不出现以单元反复零延迟重试
    const allTexts = batches.flatMap((b) => b.texts)
    expect(allTexts.every((t) => !t.includes('</'))).toBe(true)
    // 应用前 2 条后预算耗尽封顶；failedCount 为 0
    for (const batch of batches.splice(0)) {
      if (engine.isCapped()) break
      batch.apply(batch.texts.map(() => '译'))
    }
    await settle(200)
    expect(engine.isCapped()).toBe(true)
    expect(engine.failedCount()).toBe(0)
    const nodes: Text[] = []
    const walker = document.createTreeWalker(document.body.firstElementChild!, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) nodes.push(n as Text)
    const translated = nodes.filter((node) => node.nodeValue?.trim() === '译')
    expect(translated).toHaveLength(2)
  })
})

describe('行内单元快照失效矩阵', () => {
  it.each(['display', 'translate', 'reorder'])('在途期间 %s 变化 → 旧回包不得改任何成员', async (mode) => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches[0]!.texts).toEqual(['Click <1>here</1> to <2>continue</2>.'])
    const p = document.querySelector('p')!
    const a = p.querySelector('a')!
    const b = p.querySelector('b')!
    if (mode === 'display') a.style.display = 'none'
    else if (mode === 'translate') a.setAttribute('translate', 'no')
    else p.insertBefore(b, a)
    batches[0]!.apply(['点击<1>这里</1>以<2>继续</2>。'])
    await settle()
    // 旧结果不得写入任何成员
    expect(a.textContent).toBe('here')
    expect(b.textContent).toBe('continue')
    if (mode !== 'reorder') {
      // display/translate 后 a 成员冻结/排除 → 后续请求不得包含 here 原文
      const later = batches.slice(1).flatMap((b) => b.texts).join(' ')
      expect(later).not.toContain('here')
    }
  })

  it('bad_output 两次耗尽单元 → failedCount 为成员数；retryFailed 走逐节点', async () => {
    document.body.innerHTML = '<p>Click <a href="#">here</a> to <b>continue</b>.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual(['Click <1>here</1> to <2>continue</2>.'])
    const sendFirst = batches[0]!.apply
    sendFirst(undefined, { code: 'bad_output' })
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1]!.texts).toEqual(batches[0]!.texts)
    const sendSecond = batches[1]!.apply
    sendSecond(undefined, { code: 'bad_output' })
    await settle()
    expect(engine.failedCount()).toBe(5)
    expect(document.querySelector('p')!.textContent).toBe('Click here to continue.')
    expect(engine.retryFailed()).toBe(true)
    await settle()
    expect(engine.failedCount()).toBe(0)
    expect(batches.at(-1)!.texts).toEqual(['Click', 'here', 'to', 'continue'])
  })

  it('整批第二成员布局挤坏第一成员 → 整单元回滚、failedCount=0', async () => {
    document.body.innerHTML = '<p><a id="first">First</a><b id="second">Second</b> tail.</p>'
    const first = document.querySelector('#first')!
    Object.defineProperty(first, 'clientWidth', { get: () => 10 })
    // 第一成员自身译文不溢出；写入第二成员后才挤坏第一成员。
    Object.defineProperty(first, 'scrollWidth', {
      get: () => document.querySelector('#second')!.textContent === '第二' ? 9999 : 10,
    })
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual(['<1>First</1><2>Second</2> tail.'])
    batches[0]!.apply(['<1>第一</1><2>第二</2>结尾。'])
    // 立即验证整单元回滚；不让后续 fallback 回包掩盖写入结果。
    expect(document.querySelector('p')!.textContent).toBe('FirstSecond tail.')
    expect(engine.failedCount()).toBe(0)
  })
})

describe('Shadow 单元与排除', () => {
  function shadowPara(): { host: HTMLElement; getP: () => HTMLElement | null } {
    const host = document.createElement('div')
    host.id = 'sh'
    document.body.appendChild(host)
    host.attachShadow({ mode: 'open' })
    const p = document.createElement('p')
    p.innerHTML = 'Shadow <b>bold</b> text here.'
    host.shadowRoot!.appendChild(p)
    return { host, getP: () => host.shadowRoot!.querySelector('p') }
  }

  it('restore → start 重译 → shadow 内新增 p 产生新请求', async () => {
    const { host, getP } = shadowPara()
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(getP()!.textContent).toContain('Shadow')
    batches[0]!.apply(['影子<1>粗体</1>文字。'])
    await settle()
    expect(getP()!.textContent).toBe('影子 粗体 文字。')
    engine.restore()
    expect(getP()!.textContent).toBe('Shadow bold text here.')
    engine.start()
    await settle()
    batches.at(-1)!.apply(['再译<1>一次</1>内容。'])
    const more = document.createElement('p')
    more.textContent = 'Brand new shadow line.'
    host.shadowRoot!.appendChild(more)
    await settle()
    const texts = batches.at(-1)!.texts.join(' ')
    expect(texts).toContain('Brand new shadow line.')
  })

  it.each(['data-sensitive', 'aria-hidden'])('host 在途加 %s → 旧回包不写、新增也不发；移除后 start 重扫可发', async (attr) => {
    const { host, getP } = shadowPara()
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches.length).toBe(1)
    if (attr === 'data-sensitive') host.dataset.sensitive = ''
    else host.setAttribute('aria-hidden', 'true')
    batches[0]!.apply(['影子<1>粗体</1>文字。'])
    await settle()
    expect(getP()!.textContent).toBe('Shadow bold text here.')
    const more = document.createElement('p')
    more.textContent = 'Excluded host new line.'
    host.shadowRoot!.appendChild(more)
    await settle()
    expect(batches.length).toBe(1)
    host.removeAttribute('data-sensitive')
    host.removeAttribute('aria-hidden')
    engine.start()
    await settle()
    expect(batches.at(-1)!.texts.join(' ')).toContain('Excluded host new line.')
  })
})

describe('行内单元收口', () => {
  it('单元请求 bad_output 后离屏，回到视口会再发一次', async () => {
    document.body.innerHTML = '<p>Click <b>here</b> now.</p>'
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual(['Click <1>here</1> now.'])
    const sendA = batches[0]!.apply
    sendA(undefined, { code: 'bad_output' })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 2000, width: 10, height: 10, top: 2000, left: 0, right: 10, bottom: 2010 }) as DOMRect,
    )
    await settle()
    expect(batches).toHaveLength(1)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
    )
    const p = document.querySelector('p')!
    FakeIO.instances[0]!.fire(p, true)
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1]!.texts).toEqual(['Click <1>here</1> now.'])
  })

  it('被拒的链接文本在后续单元里变成不透明占位，安全文本仍可译', async () => {
    document.body.innerHTML = '<p>Open <a href="#">Bad</a> link now.</p>'
    const a = document.querySelector('a')!
    Object.defineProperty(a, 'clientWidth', { configurable: true, get: () => 10 })
    Object.defineProperty(a, 'scrollWidth', {
      configurable: true,
      get: () => (a.textContent === 'Bad' ? 10 : 9999),
    })
    engine = makeEngine({ auto: true })
    engine.start()
    await settle()
    expect(batches[0]!.texts).toEqual(['Open <1>Bad</1> link now.'])
    batches[0]!.apply(['打开<1>坏掉</1>链接现在。'])
    const extra = document.createElement('b')
    extra.textContent = 'Please continue safely.'
    document.querySelector('p')!.append(extra)
    await settle(300)
    const batch = batches.find((item) => item.texts.some((text) => text.includes('/>') && text.includes('Please continue safely.')))
    expect(batch).toBeDefined()
    const source = batch!.texts.find((text) => text.includes('Please continue safely.'))!
    expect(source).not.toContain('Bad')
    const translated = source.replace('Please continue safely.', '请安全继续阅读。')
    batch!.apply(batch!.texts.map((text) => text === source ? translated : ''))
    expect(extra.textContent).toBe('请安全继续阅读。')
    expect(a.textContent).toBe('Bad')
  })

  it('两个同文单元共用请求，失败后词典占一位时只回填放得下的单元', async () => {
    document.body.innerHTML = '<p id="a">Click <b>here</b> now.</p><p id="b">Click <b>here</b> now.</p>'
    engine = makeEngine({ auto: true, fixed: true, recordBudget: 6 })
    engine.start()
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.texts).toEqual(['Click <1>here</1> now.'])
    document.body.insertAdjacentHTML('beforeend', '<button id="fixed">Settings</button>')
    await settle(200)
    expect(document.querySelector('#fixed')!.textContent).toBe('设置')
    const sendA = batches[0]!.apply
    sendA(undefined, { code: 'bad_output' })
    await settle()
    const retry = batches.at(-1)!
    expect(retry).not.toBe(batches[0])
    expect(retry.texts).toEqual(['Click <1>here</1> now.'])
    retry.apply(['点击<1>这里</1>现在。'])
    expect(document.querySelector('#a')!.textContent).toContain('这里')
    expect(document.querySelector('#b')!.textContent).toBe('Click here now.')
    expect(document.querySelector('#fixed')!.textContent).toBe('设置')
    expect(engine!.failedCount()).toBe(0)
    expect(engine!.isCapped()).toBe(false)
  })
})

it('原GitHub词典已经处理的文本不应重复发送模型', async () => {
 document.body.innerHTML='<p id="legacy-label">Issues</p><p id="model-body">This explanation is only used in a controlled fixture.</p>'
 const legacy=createTranslator({matcher:testMatcher(),host:window})
 try {
  legacy.start()
  expect(document.querySelector('#legacy-label')?.textContent).toBe('议题')
  engine=createDomEngine({targetLanguage:()=> 'ja',fixedEnabled:()=>false,autoEnabled:()=>true,translateFixed:()=>undefined,debounceMs:10,onAutoBatch(texts,apply){batches.push({texts:[...texts],apply})}})
  engine.start();await settle(160)
  const sent=batches.flatMap(batch=>batch.texts)
  expect(sent).toContain('This explanation is only used in a controlled fixture.')
  expect(sent).not.toContain('议题')
 } finally {engine?.dispose();engine=undefined;legacy.stop()}
})

it('两个引擎处理后恢复必须回到网站原文而不是词典中间译文', async () => {
 document.body.innerHTML='<p id="legacy-label">Issues</p><p id="model-body">This explanation is only used in a controlled fixture.</p>'
 const legacy=createTranslator({matcher:testMatcher(),host:window})
 try {
  legacy.start()
  expect(document.querySelector('#legacy-label')?.textContent).toBe('议题')
  engine=createDomEngine({targetLanguage:()=> 'ja',fixedEnabled:()=>false,autoEnabled:()=>true,translateFixed:()=>undefined,debounceMs:10,onAutoBatch(texts,apply){batches.push({texts:[...texts],apply})}})
  engine.start();await settle(160)
  const first=batches[0]
  expect(first).toBeDefined()
  first!.apply(first!.texts.map(text=>text==='议题'?'チケット':'この説明はテスト専用です。'))
  await settle(160)
  expect(document.querySelector('#model-body')?.textContent).toBe('この説明はテスト専用です。')
  engine.restore();legacy.stop()
  expect(document.querySelector('#legacy-label')?.textContent).toBe('Issues')
  expect(document.querySelector('#model-body')?.textContent).toBe('This explanation is only used in a controlled fixture.')
 } finally {engine?.dispose();engine=undefined;legacy.stop()}
})

it('github 所有的节点既不进自动批次也不被固定词典改写，节点文字改变后重新进入批次', async () => {
  document.body.innerHTML = '<nav><button id="claimed">Settings</button></nav>'
  const node = document.querySelector('#claimed')!.firstChild as Text
  textOwnership().claim(node, 'github', node.data)
  engine = makeEngine({ auto: true, fixed: true })
  engine.start()
  await settle()
  expect(node.data).toBe('Settings')
  expect(batches).toHaveLength(0)

  node.data = 'Updated button description text.'
  await settle()
  expect(batches.flatMap((batch) => batch.texts)).toContain('Updated button description text.')
})

it('web 引擎先译出的文本（含带英文译文）不被 GitHub 引擎覆盖或串改原文，页面改写后 GitHub 引擎可接手', async () => {
  document.body.innerHTML = '<p id="model-body">This explanation is only used in a controlled fixture.</p>'
  engine = createDomEngine({
    targetLanguage: () => 'zh-CN',
    fixedEnabled: () => false,
    autoEnabled: () => true,
    translateFixed: () => undefined,
    debounceMs: 10,
    onAutoBatch(texts, apply) {
      batches.push({ texts: [...texts], apply })
    },
  })
  const legacy = createTranslator({ matcher: testMatcher(), host: window })
  try {
    engine.start()
    await settle(160)
    expect(batches).toHaveLength(1)
    // 译文故意设为命中 GitHub 词典的英文词条 Open，验证不靠译文不含拉丁字母避让
    batches[0]!.apply(['Open'])
    await settle(160)
    const node = document.querySelector('#model-body')!.firstChild as Text
    expect(node.data).toBe('Open')
    expect(textOwnership().ownerOf(node)).toBe('web')

    legacy.start()
    expect(node.data).toBe('Open')
    expect(textOwnership().ownerOf(node)).toBe('web')

    legacy.stop()
    expect(node.data).toBe('Open')
    expect(textOwnership().ownerOf(node)).toBe('web')

    engine.restore()
    expect(node.data).toBe('This explanation is only used in a controlled fixture.')

    legacy.start()
    node.data = 'Issues'
    legacy.flush()
    expect(node.data).toBe('议题')
  } finally {
    engine?.dispose()
    engine = undefined
    legacy.stop()
  }
})

it('脱离 DOM 的节点在 GitHub 引擎 stop 后重挂载，不再阻塞通用引擎翻译', async () => {
  document.body.innerHTML = '<p id="moved">Issues</p>'
  const el = document.querySelector('#moved')!
  const node = el.firstChild as Text
  const legacy = createTranslator({
    matcher: testMatcher({ custom: { Issues: 'Translated issue sentence for model.' } }),
    host: window,
  })
  try {
    legacy.start()
    expect(node.data).toBe('Translated issue sentence for model.')
    expect(textOwnership().ownerOf(node)).toBe('github')

    el.remove()
    legacy.stop()
    expect(textOwnership().ownerOf(node)).toBeUndefined()

    document.body.append(el)
    engine = makeEngine({ auto: true })
    engine.start()
    await settle(160)
    expect(batches.flatMap((batch) => batch.texts)).toContain('Translated issue sentence for model.')
  } finally {
    engine?.dispose()
    engine = undefined
    legacy.stop()
  }
})
