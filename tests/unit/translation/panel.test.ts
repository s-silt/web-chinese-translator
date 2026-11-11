import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../../../src/i18n/en'
import ja from '../../../src/i18n/ja'
import ko from '../../../src/i18n/ko'
import zhCN from '../../../src/i18n/zh-CN'
import zhTW from '../../../src/i18n/zh-TW'
import type { FloatingCallbacks, FloatingLabels, FloatingView } from '../../../src/translation/floating'
import { createTranslationPanel, type PanelLabels, type TranslationPanel } from '../../../src/translation/panel'
import type { Messages } from '../../../src/i18n'
import { installShadowRootCapture, requireCapturedShadowRoot } from '../shared/shadow-roots'

let panel: TranslationPanel | undefined
let restoreShadowCapture: (() => void) | undefined

function host(): HTMLElement {
  return document.documentElement.querySelector('[data-wt-root]') as HTMLElement
}

function shadow(): ShadowRoot {
  return requireCapturedShadowRoot(host())
}

beforeEach(() => {
  document.body.textContent = ''
  for (const el of document.documentElement.querySelectorAll('[data-wt-root]')) el.remove()
  restoreShadowCapture = installShadowRootCapture()
})

afterEach(() => {
  panel?.dispose()
  panel = undefined
  restoreShadowCapture?.()
  restoreShadowCapture = undefined
})

describe('暂停状态条', () => {
  it('等待指示只跟随翻译请求，结果、错误和关闭均清除忙碌状态', () => {
    panel = createTranslationPanel()
    for (const complete of [
      () => panel!.showSelectionResult('Synthetic source', ['Synthetic result']),
      () => panel!.showError('Synthetic failure'),
      () => panel!.close(),
    ]) {
      panel.showSelection('Synthetic source')
      const element = shadow().querySelector('.panel')!
      expect(element.getAttribute('aria-busy')).toBe('true')
      expect(element.querySelector('.wt-progress')?.getAttribute('aria-hidden')).toBe('true')
      complete()
      expect(element.getAttribute('aria-busy')).toBe('false')
    }
  })

  it('错误原因默认折叠、按文字显示，同类更新保留展开状态', () => {
    panel = createTranslationPanel()
    const message = '<img src=x onerror=alert(1)> 凭证无效或没有访问权限'
    panel.showError(message)
    const details = shadow().querySelector('.panel-error-details') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('查看原因')
    expect(details.querySelector('.error-reason')?.textContent).toBe(message)
    expect(details.querySelector('img')).toBeNull()
    panel.showPauseStatus(message, true, undefined, 'error')
    const notice = shadow().querySelector('.notice-error-details') as HTMLDetailsElement
    expect(notice.open).toBe(false)
    expect(notice.querySelector('.error-reason')?.textContent).toBe(message)
    expect(notice.querySelector('img')).toBeNull()
    notice.open = true
    panel.showPauseStatus('2 段翻译失败', true, undefined, 'error')
    expect(notice.open).toBe(true)
    panel.hidePauseStatus()
    expect(notice.open).toBe(false)
    expect(notice.hidden).toBe(true)
    panel.showNotice('请配置模型')
    expect(details.hidden).toBe(true)
    expect(details.querySelector('.error-reason')?.textContent).toBe('')
  })

  it('关闭失败气泡只隐藏提示，同类计数变化不弹回；恢复后新的失败可提示', () => {
    panel = createTranslationPanel()
    const resume = vi.fn()
    panel.setOnResume(resume)
    panel.showPauseStatus('1 段失败', true, undefined, 'error')
    expect(shadow().querySelector('.pause-reason')?.textContent).toBe('翻译失败')
    expect(shadow().querySelector('.notice-link')?.textContent).toBe('点击重试')
    trustedClick(shadow().querySelector('.notice-close')!)
    expect(resume).not.toHaveBeenCalled()
    expect((shadow().querySelector('.pause-status') as HTMLElement).style.display).toBe('none')
    panel.showPauseStatus('2 段失败', true, undefined, 'error')
    expect((shadow().querySelector('.pause-status') as HTMLElement).style.display).toBe('none')
    panel.hidePauseStatus()
    panel.showPauseStatus('3 段失败', true, undefined, 'error')
    expect((shadow().querySelector('.pause-status') as HTMLElement).style.display).not.toBe('none')
    const retry = shadow().querySelector('.pause-resume') as HTMLButtonElement
    retry.click()
    expect(resume).not.toHaveBeenCalled()
    trustedClick(retry)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('失败卡片重试使用独立回调，成功卡片保留只翻译及折叠原文', () => {
    panel = createTranslationPanel()
    const literal = vi.fn()
    const retry = vi.fn()
    panel.setOnLiteral(literal)
    panel.setOnRetry(retry)
    panel.showError('network failure')
    const action = shadow().querySelector('.panel-actions button') as HTMLButtonElement
    expect(action.textContent).toBe('点击重试')
    action.click()
    expect(retry).not.toHaveBeenCalled()
    trustedClick(action)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(literal).not.toHaveBeenCalled()
    panel.showAssist('source', { decision: 'show', intent: 'define', translation: '', explanation: 'meaning' })
    expect((shadow().querySelector('details.panel-source') as HTMLDetailsElement).open).toBe(false)
    const more = shadow().querySelector('details.panel-more') as HTMLDetailsElement
    expect(more.open).toBe(false)
    more.open = true
    const translate = [...more.querySelectorAll('button')].find((button) => button.textContent === '只翻译')!
    trustedClick(translate)
    expect(literal).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  function chip(): HTMLElement {
    return shadow().querySelector('.pause-status') as HTMLElement
  }

  function resumeButton(): HTMLButtonElement {
    return shadow().querySelector('.pause-resume') as HTMLButtonElement
  }

  it('显示原因和继续按钮，且不打开卡片', () => {
    panel = createTranslationPanel()
    panel.showPauseStatus('凭证无效或没有访问权限', true)
    expect(host().style.display).toBe('block')
    expect(chip().style.display).not.toBe('none')
    expect(chip().textContent).toContain('翻译已暂停')
    expect(chip().querySelector('.notice-speech')?.getAttribute('title')).toBe('凭证无效或没有访问权限')
    expect(resumeButton().querySelector('.notice-link')?.textContent).toBe('继续翻译')
    expect(resumeButton().style.display).not.toBe('none')
    expect(panel.isOpen()).toBe(false)
    expect((shadow().querySelector('.panel') as HTMLElement).style.display).toBe('none')
    expect((shadow().querySelector('.hint') as HTMLElement).style.display).toBe('none')
  })

  it('滚动、点击页面、Escape 和关闭卡片都不会让它消失', () => {
    panel = createTranslationPanel()
    panel.showPauseStatus('原因', true)
    panel.showError('划词失败')
    document.dispatchEvent(new Event('scroll'))
    expect(panel.isOpen()).toBe(false)
    expect(chip().style.display).not.toBe('none')
    panel.showError('划词失败')
    document.dispatchEvent(new Event('pointerdown'))
    expect(panel.isOpen()).toBe(false)
    panel.showError('划词失败')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    panel.close()
    expect(host().style.display).toBe('block')
    expect(chip().style.display).not.toBe('none')
    expect(chip().querySelector('.notice-speech')?.getAttribute('title')).toBe('原因')
  })

  it('点击继续调用回调并移除状态条', () => {
    panel = createTranslationPanel()
    let resumed = 0
    panel.setOnResume(() => {
      resumed += 1
    })
    panel.showPauseStatus('原因', true)
    trustedClick(resumeButton())
    expect(resumed).toBe(1)
    expect(chip().style.display).toBe('none')
    expect(host().style.display).toBe('none')
  })

  it('回调里再次暂停时状态条保留新原因', () => {
    panel = createTranslationPanel()
    const current = panel
    current.setOnResume(() => {
      current.showPauseStatus('新原因', true)
    })
    current.showPauseStatus('原因', true)
    trustedClick(resumeButton())
    expect(chip().style.display).not.toBe('none')
    expect(chip().querySelector('.notice-speech')?.getAttribute('title')).toBe('新原因')
  })

  it('不可继续时禁用动作且隐藏链接；隐藏后面板仍可正常打开', () => {
    panel = createTranslationPanel()
    panel.showPauseStatus('本页处理已达上限', false)
    expect(resumeButton().disabled).toBe(true)
    expect((resumeButton().querySelector('.notice-link') as HTMLElement).hidden).toBe(true)
    panel.hidePauseStatus()
    expect(host().style.display).toBe('none')
    panel.showError('划词失败')
    expect(host().style.display).toBe('block')
    expect(chip().style.display).toBe('none')
  })

  it('可指定按钮文案，之后的暂停状态恢复默认文案', () => {
    panel = createTranslationPanel()
    panel.showPauseStatus('Page limit', true, 'Resume translation')
    expect(resumeButton().querySelector('.notice-link')?.textContent).toBe('Resume translation')
    panel.showPauseStatus('原因', true)
    expect(resumeButton().querySelector('.notice-link')?.textContent).toBe('继续翻译')
  })

  it('普通提示不再带继续按钮', () => {
    panel = createTranslationPanel()
    panel.showNotice('本页处理已达上限')
    expect(shadow().querySelector('.panel-actions')?.childElementCount).toBe(0)
  })

  it('恶意原因只作为文本呈现', () => {
    panel = createTranslationPanel()
    panel.showPauseStatus('<img src=x onerror=alert(1)>', true)
    expect(chip().querySelector('.notice-speech')?.getAttribute('title')).toBe('<img src=x onerror=alert(1)>')
    expect(chip().querySelector('img:not(.notice-mascot), [onerror]')).toBeNull()
    expect((chip().querySelector('.notice-mascot') as HTMLImageElement).hidden).toBe(true)
  })

  it('dispose 后从页面移除', () => {
    panel = createTranslationPanel()
    panel.showPauseStatus('原因', true)
    panel.dispose()
    panel = undefined
    expect(document.documentElement.querySelector('[data-wt-root]')).toBeNull()
  })
})

describe('面板状态机', () => {
  it('hint 与卡片互斥；showHint 不显示卡片', () => {
    panel = createTranslationPanel()
    panel.showSelectionResult('src', ['译文'])
    expect(panel.isOpen()).toBe(true)
    panel.showHint({ left: 10, top: 10, right: 50, bottom: 20 }, () => undefined)
    expect(panel.isOpen()).toBe(true)
    const s = shadow()
    expect((s.querySelector('.hint') as HTMLElement).style.display).not.toBe('none')
    expect((s.querySelector('.panel') as HTMLElement).style.display).toBe('none')
    expect(s.querySelector('.panel-body')?.textContent).toBe('')
  })

  it('关闭后 hidden 且 isOpen 为 false', () => {
    panel = createTranslationPanel()
    panel.showError('请求超时')
    expect(panel.isOpen()).toBe(true)
    panel.close()
    expect(panel.isOpen()).toBe(false)
    expect(host().style.display).toBe('none')
  })

  it('恶意译文只作为文本呈现', () => {
    panel = createTranslationPanel()
    panel.showAssist('src', {
      decision: 'show',
      intent: 'translate',
      translation: '<img src=x onerror=alert(1)>',
      explanation: '',
    })
    expect(shadow().querySelector('.panel-body img, [onerror]')).toBeNull()
    expect(shadow().textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('assist 卡含只翻译与本页不再提示按钮', () => {
    panel = createTranslationPanel()
    panel.showAssist('src', {
      decision: 'show',
      intent: 'define',
      translation: '',
      explanation: '释义',
    })
    const buttons = [...shadow().querySelectorAll('.panel-actions button')].map((b) => b.textContent)
    expect(buttons).toContain('只翻译')
    expect(buttons).toContain('本页不再主动提示')
    expect(shadow().querySelector('.panel-title')?.textContent).toBe('释义')
  })

  it('containsEvent 仅命中宿主路径', () => {
    panel = createTranslationPanel()
    panel.showError('x')
    const h = host()
    const inside = { composedPath: () => [h] } as unknown as Event
    const outside = { composedPath: () => [document.body] } as unknown as Event
    expect(panel.containsEvent(inside)).toBe(true)
    expect(panel.containsEvent(outside)).toBe(false)
  })
})

describe('原生弹层内的暂停条', () => {
  afterEach(() => vi.restoreAllMocks())

  function modalFixture(): { dlg: HTMLDialogElement; input: HTMLInputElement } {
    const dlg = document.createElement('dialog')
    const input = document.createElement('input')
    dlg.append(input)
    document.body.append(dlg)
    dlg.showModal()
    const bound = dlg.matches.bind(dlg)
    vi.spyOn(dlg, 'matches').mockImplementation((selector) =>
      selector === ':modal' ? dlg.open : bound(selector))
    input.focus()
    return { dlg, input }
  }

  function nativeClose(dlg: HTMLDialogElement): void {
    dlg.open = false
    dlg.dispatchEvent(new Event('close'))
  }

  function chip(): HTMLElement {
    return shadow().querySelector('.pause-status') as HTMLElement
  }

  function resumeButton(): HTMLButtonElement {
    return shadow().querySelector('.pause-resume') as HTMLButtonElement
  }

  it('仅暂停条时原生关闭会把宿主移回根节点且暂停条仍可继续', () => {
    const { dlg } = modalFixture()
    panel = createTranslationPanel()
    let closed = 0
    let resumed = 0
    panel.setOnClose(() => {
      closed += 1
    })
    panel.setOnResume(() => {
      resumed += 1
    })
    panel.showPauseStatus('原因', true)
    const h = host()
    expect(h.parentElement).toBe(dlg)
    nativeClose(dlg)
    expect(h.parentElement).toBe(document.documentElement)
    expect(h.getAttribute('popover')).toBeNull()
    expect(chip().style.display).not.toBe('none')
    expect(closed).toBe(0)
    trustedClick(resumeButton())
    expect(resumed).toBe(1)
    expect(h.style.display).toBe('none')
  })

  it('卡片关闭后弹层内暂停条保留，原生关闭才回到根节点', () => {
    const { dlg } = modalFixture()
    panel = createTranslationPanel()
    let closed = 0
    let resumed = 0
    panel.setOnClose(() => {
      closed += 1
    })
    panel.setOnResume(() => {
      resumed += 1
    })
    panel.showPauseStatus('原因', true)
    panel.showSelectionResult('src', ['译文'])
    const h = host()
    expect(h.parentElement).toBe(dlg)
    ;(shadow().querySelector('.panel-close') as HTMLButtonElement).click()
    expect(dlg.open).toBe(true)
    expect(h.parentElement).toBe(dlg)
    expect(chip().style.display).not.toBe('none')
    expect(closed).toBe(1)
    nativeClose(dlg)
    expect(h.parentElement).toBe(document.documentElement)
    expect(closed).toBe(1)
    trustedClick(resumeButton())
    expect(resumed).toBe(1)
    expect(h.style.display).toBe('none')
  })

  it('弹层内隐藏暂停条后完全脱离弹层并移除 popover', () => {
    const { dlg } = modalFixture()
    panel = createTranslationPanel()
    panel.showPauseStatus('原因', true)
    const h = host()
    expect(h.parentElement).toBe(dlg)
    panel.hidePauseStatus()
    expect(h.parentElement).toBe(document.documentElement)
    expect(h.getAttribute('popover')).toBeNull()
    expect(h.style.display).toBe('none')
    expect(() => panel?.dispose()).not.toThrow()
  })
})


function labelsFrom(messages: Messages): PanelLabels {
  return {
    translate: messages.wtPanelTranslate,
    define: messages.wtPanelDefine,
    explain: messages.wtPanelExplain,
    none: messages.wtPanelNone,
    result: messages.wtPanelResult,
    close: messages.wtPanelClose,
    literal: messages.wtPanelLiteral,
    dismiss: messages.wtPanelDismiss,
    hint: messages.wtPanelHint,
    source: messages.wtPanelSource,
    loading: messages.wtPanelLoading,
    resume: messages.wtPanelResume,
    toolbar: messages.wtModeToolbar,
    toolbarTranslate: messages.wtToolbarTranslate,
    toolbarDefine: messages.wtToolbarDefine,
    toolbarExplain: messages.wtToolbarExplain,
    copy: messages.wtToolbarCopy,
    copied: messages.wtToolbarCopied,
    copyFailed: messages.wtToolbarCopyFailed,
    configureHint: messages.wtAssistConfigure,
    failed: messages.wtRetryBubbleTitle,
    retry: messages.wtRetryBubbleAction,
    paused: messages.wtPausedBubbleTitle,
    limit: messages.wtLimitBubbleTitle,
    more: messages.wtMoreActions,
  }
}

describe('卡片文案', () => {
  it('showAssist 后 setLabels 切换日语和韩语，原文与答案不变', () => {
    panel = createTranslationPanel()
    const source = '原文'
    const answer = '原文'
    panel.showAssist(source, { decision: 'show', intent: 'explain', translation: '', explanation: answer })
    panel.setLabels(labelsFrom(ja))
    const root = shadow()
    expect(root.querySelector('.panel-title')?.textContent).toBe(ja.wtPanelExplain)
    expect(root.querySelector('.panel-close')?.getAttribute('aria-label')).toBe(ja.wtPanelClose)
    const buttons = [...root.querySelectorAll('.panel-actions button')].map((button) => button.textContent)
    expect(buttons).toContain(ja.wtPanelLiteral)
    expect(buttons).toContain(ja.wtPanelDismiss)
    expect(root.querySelector('.panel-source > summary')?.textContent).toBe(ja.wtPanelSource)
    expect(root.querySelector('.panel-target')?.textContent).toBe(answer)
    expect(root.querySelector('.panel-source')?.textContent).toContain(source)
    panel.setLabels(labelsFrom(ko))
    expect(root.querySelector('.panel-title')?.textContent).toBe(ko.wtPanelExplain)
    expect(root.querySelector('.panel-close')?.getAttribute('aria-label')).toBe(ko.wtPanelClose)
    expect(root.querySelector('.panel-source > summary')?.textContent).toBe(ko.wtPanelSource)
    expect(root.querySelector('.panel-target')?.textContent).toBe(answer)
    expect(root.querySelector('.panel-source')?.textContent).toContain(source)
  })

  it('loading 跟随语言；服务端错误不回退，隐藏卡片不被打开', () => {
    panel = createTranslationPanel()
    panel.showSelection('source text')
    expect(shadow().querySelector('.panel-status')?.textContent).toBe('翻译中')
    panel.setLabels(labelsFrom(ja))
    expect(shadow().querySelector('.panel-status')?.textContent).toBe(ja.wtPanelLoading)
    panel.showError('upstream failed')
    panel.setLabels(labelsFrom(ko))
    expect(shadow().querySelector('.panel')?.getAttribute('title')).toBe('upstream failed')
    expect(shadow().querySelector('.panel-title')?.textContent).toBe(ko.wtRetryBubbleTitle)
    expect(shadow().querySelector('.panel-actions')?.textContent).toBe(ko.wtRetryBubbleAction)
    panel.close()
    panel.setLabels(labelsFrom(ja))
    expect(panel.isOpen()).toBe(false)
    expect(host().style.display).toBe('none')
  })

  it('自定义 actionLabel 在 setLabels 后保留，未指定时跟随 resume', () => {
    panel = createTranslationPanel()
    panel.showPauseStatus('reason', true, 'Custom action')
    panel.setLabels(labelsFrom(ja))
    expect(shadow().querySelector('.notice-link')?.textContent).toBe('Custom action')
    panel.showPauseStatus('reason', true)
    panel.setLabels(labelsFrom(ko))
    expect(shadow().querySelector('.notice-link')?.textContent).toBe(ko.wtPanelResume)
  })
})

describe('界面风格', () => {
  it('setStyle 在三个元素上设置/移除 data-style', () => {
    panel = createTranslationPanel()
    panel.showSelection('src')
    panel.setStyle('glass')
    const root = shadow()
    for (const sel of ['.panel', '.hint', '.pause-status']) {
      const el = root.querySelector(sel)
      expect(el).not.toBeNull()
      expect(el?.getAttribute('data-style')).toBe('glass')
    }
    panel.setStyle('classic')
    for (const sel of ['.panel', '.hint', '.pause-status']) {
      const el = root.querySelector(sel)
      expect(el).not.toBeNull()
      expect(el?.hasAttribute('data-style')).toBe(false)
    }
  })

  it('setPreferences 写 host 的 style/theme/lang 与 important color-scheme，partial setStyle 不重置', () => {
    panel = createTranslationPanel()
    panel.showSelection('src')
    panel.setPreferences({ uiStyle: 'glass', theme: 'dark', language: 'zh-TW' })
    expect(host().dataset.style).toBe('glass')
    expect(host().dataset.theme).toBe('dark')
    expect(host().lang).toBe('zh-TW')
    expect(host().style.getPropertyValue('color-scheme')).toBe('dark')
    expect(host().style.getPropertyPriority('color-scheme')).toBe('important')
    expect(host().style.getPropertyValue('direction')).toBe('ltr')

    panel.setPreferences({ uiStyle: 'cyber', theme: 'light', language: 'en' })
    expect(host().dataset.style).toBe('cyber')
    expect(host().dataset.theme).toBe('light')
    expect(host().lang).toBe('en')
    expect(host().style.getPropertyValue('color-scheme')).toBe('dark')

    panel.setStyle('classic')
    expect(host().dataset.theme).toBe('light')
    expect(host().lang).toBe('en')

    panel.setPreferences({ uiStyle: 'classic', theme: 'auto', language: 'zh-CN' })
    expect(host().hasAttribute('data-style')).toBe(false)
    expect(host().hasAttribute('data-theme')).toBe(false)
    expect(host().lang).toBe('zh-CN')
    expect(host().style.getPropertyValue('color-scheme')).toBe('light dark')
  })
})

const ANCHOR = { left: 10, top: 10, right: 40, bottom: 24 }

function trustedClick(element: Element): void {
  element.dispatchEvent(Object.assign(new MouseEvent('click', { bubbles: true }), { isTrusted: true }))
}

describe('选择工具栏', () => {
  function toolbar(): HTMLElement {
    return shadow().querySelector('.selection-toolbar') as HTMLElement
  }

  function action(name: string): HTMLButtonElement {
    return shadow().querySelector(`[data-action="${name}"]`) as HTMLButtonElement
  }

  it('显示四个动作和关闭，未配置时禁用模型按钮', () => {
    panel = createTranslationPanel()
    const actions: string[] = []
    panel.showToolbar(ANCHOR, false, (item) => {
      actions.push(item)
    })
    expect(panel.isOpen()).toBe(true)
    expect(toolbar().getAttribute('role')).toBe('toolbar')
    expect(toolbar().style.display).not.toBe('none')
    expect(action('translate').disabled).toBe(true)
    expect(action('define').disabled).toBe(true)
    expect(action('explain').disabled).toBe(true)
    expect(action('copy').disabled).toBe(false)
    expect(action('copy').textContent).toBe('复制')
    expect(action('translate').title).toBe('请先配置模型')
    expect(action('define').title).toBe('请先配置模型')
    expect(action('explain').title).toBe('请先配置模型')
    expect(shadow().querySelector('.toolbar-close')?.getAttribute('aria-label')).toBe('关闭')
    action('copy').click()
    expect(actions).toEqual([])
    trustedClick(action('translate'))
    expect(actions).toEqual([])
    trustedClick(action('copy'))
    expect(actions).toEqual(['copy'])
  })

  it('受信点击触发动作；复制结果只在工具栏状态更新，下一选区复原', () => {
    panel = createTranslationPanel()
    const actions: string[] = []
    panel.showToolbar(ANCHOR, true, (item) => {
      actions.push(item)
    })
    expect(action('translate').disabled).toBe(false)
    expect(action('translate').title).toBe('')
    trustedClick(action('define'))
    expect(actions).toEqual(['define'])
    panel.setToolbarCopyResult(true)
    expect(action('copy').textContent).toBe('已复制')
    expect(shadow().querySelector('.toolbar-announcement')?.textContent).toBe('已复制')
    panel.showToolbar(ANCHOR, true, (item) => {
      actions.push(item)
    })
    expect(action('copy').textContent).toBe('复制')
    panel.setToolbarCopyResult(false)
    expect(action('copy').textContent).toBe('复制失败')
    panel.close()
    expect(action('copy').textContent).toBe('复制')
    expect(shadow().querySelector('.toolbar-announcement')?.textContent).toBe('')
    panel.setToolbarCopyResult(true)
    expect(action('copy').textContent).toBe('复制')
    expect(shadow().querySelector('.toolbar-announcement')?.textContent).toBe('')
  })

  it('不自动抢焦点；focusToolbar 只在工具栏状态成功', () => {
    panel = createTranslationPanel()
    expect(panel.focusToolbar()).toBe(false)
    panel.showToolbar(ANCHOR, true, () => undefined)
    expect(shadow().activeElement).not.toBe(action('translate'))
    expect(panel.focusToolbar()).toBe(true)
    expect(shadow().activeElement).toBe(action('translate'))
    action('translate').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(shadow().activeElement).toBe(action('define'))
    panel.close()
    expect(panel.focusToolbar()).toBe(false)
    panel.showToolbar(ANCHOR, false, () => undefined)
    expect(panel.focusToolbar()).toBe(true)
    expect(shadow().activeElement).toBe(action('copy'))
    action('copy').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(shadow().activeElement).toBe(shadow().querySelector('.toolbar-close'))
    ;(shadow().querySelector('.toolbar-close') as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    )
    expect(shadow().activeElement).toBe(action('copy'))
  })

  it('setStyle 纳入工具栏，Escape 关闭', () => {
    panel = createTranslationPanel()
    panel.setStyle('cyber')
    panel.showToolbar(ANCHOR, true, () => undefined)
    expect(toolbar().getAttribute('data-style')).toBe('cyber')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(panel.isOpen()).toBe(false)
  })

  it('工具栏显示期间 setLabels 把复制反馈从中文更新到英文且不触发动作', () => {
    panel = createTranslationPanel()
    const actions: string[] = []
    panel.showToolbar(ANCHOR, false, (item) => actions.push(item))
    panel.setToolbarCopyResult(true)
    expect(action('copy').textContent).toBe('已复制')
    panel.setLabels(labelsFrom(en))
    expect(action('copy').textContent).toBe(en.wtToolbarCopied)
    expect(shadow().querySelector('.toolbar-announcement')?.textContent).toBe(en.wtToolbarCopied)
    expect(action('translate').title).toBe(en.wtAssistConfigure)
    expect(action('define').title).toBe(en.wtAssistConfigure)
    expect(action('explain').title).toBe(en.wtAssistConfigure)
    expect(actions).toEqual([])
    for (const messages of [zhCN, zhTW, ja, ko]) {
      panel.setLabels(labelsFrom(messages))
      expect(action('translate').title).toBe(messages.wtAssistConfigure)
      expect(action('copy').textContent).toBe(messages.wtToolbarCopied)
    }
    expect(actions).toEqual([])
  })

  it.each(['panel', 'toolbar'] as const)('外部滚动和外点关闭 %s', (surface) => {
    panel = createTranslationPanel()
    const open = (): void => {
      if (surface === 'panel') panel?.showError('划词失败')
      else panel?.showToolbar(ANCHOR, true, () => undefined)
    }
    open()
    expect(panel.isOpen()).toBe(true)
    document.dispatchEvent(new Event('scroll'))
    expect(panel.isOpen()).toBe(false)
    open()
    document.dispatchEvent(new Event('pointerdown'))
    expect(panel.isOpen()).toBe(false)
  })
})

function floatingView(visible = true): FloatingView {
  return {
    visible,
    hostname: 'example.com',
    fixedOn: false,
    autoEnabled: false,
    configured: true,
    restored: false,
    canRestore: true,
    resumable: false,
    busy: false,
    checking: false,
    error: '',
  }
}

function floatingLabels(): FloatingLabels {
  return {
    title: '标题',
    open: '打开',
    expand: '展开',
    close: '关闭',
    move: '移动',
    translatePage: '翻译本页',
    enable: '开启',
    disable: '关闭自动',
    fold: '收起',
    disclosure: '说明',
    consent: '同意',
    confirm: '确认',
    cancel: '取消',
    restore: '恢复',
    resume: '继续',
    settings: '设置',
    textTranslate: '文本翻译',
    configure: '请先配置模型',
    fixedOn: '词库',
    modelOn: '模型开',
    modelOff: '模型关',
    pageOn: '本页开',
    restored: '已恢复',
    paused: '已暂停',
    loading: '加载',
    positionFailed: '位置失败',
  }
}

function floatingCallbacks(): FloatingCallbacks {
  return {
    imageUrl: '/icon/48.png',
    readPosition: async () => ({ side: 'right', ratio: 0.5, collapsed: false }),
    writePosition: async () => undefined,
    onOpen: () => undefined,
    onAction: () => undefined,
  }
}

function floatingButton(): HTMLButtonElement {
  return shadow().querySelector('.floating-entry') as HTMLButtonElement
}

describe('悬浮入口与面板', () => {
  it('气泡被卡片遮挡时释放自动收起，重新可见后保持展开', async () => {
    const floating = await import('../../../src/translation/floating')
    const original = floating.createFloatingEntry
    const notices: boolean[] = []
    const factory = vi.spyOn(floating, 'createFloatingEntry').mockImplementation((...args) => {
      const entry = original(...args)
      const set = entry.setNoticeVisible
      entry.setNoticeVisible = (visible) => {
        notices.push(visible)
        set(visible)
      }
      return entry
    })
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('panel')) return new DOMRect(0, 0, 5000, 5000)
      if (this.classList.contains('pause-status')) return new DOMRect(0, 0, 176, 80)
      return originalRect.call(this)
    })
    const frames = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    try {
      panel = createTranslationPanel()
      panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
      panel.showSelection('A selected sentence.')
      panel.showPauseStatus('凭证无效', true, undefined, 'error')
      await frames()
      expect((shadow().querySelector('.pause-status') as HTMLElement).style.display).toBe('none')
      expect(notices.at(-1)).toBe(false)
      panel.close()
      await frames()
      expect((shadow().querySelector('.pause-status') as HTMLElement).style.display).not.toBe('none')
      expect(notices.at(-1)).toBe(true)
    } finally {
      bounds.mockRestore()
      factory.mockRestore()
    }
  })

  it('仅入口可见时卡片、提示、工具栏和暂停条都不渲染', () => {
    panel = createTranslationPanel()
    panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
    expect(host().style.display).toBe('block')
    for (const selector of ['.panel', '.hint', '.selection-toolbar', '.pause-status']) {
      expect((shadow().querySelector(selector) as HTMLElement).style.display, selector).toBe('none')
    }
    expect((shadow().querySelector('.floating-menu') as HTMLElement).hidden).toBe(true)
    expect(shadow().querySelector('.floating-consent')).toBeNull()
  })

  it('菜单和工具栏互斥，仅入口时 isOpen 为 false，关闭保留入口', () => {
    panel = createTranslationPanel()
    let closed = 0
    panel.setOnClose(() => {
      closed += 1
    })
    panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
    expect(panel.isOpen()).toBe(false)
    expect(host().style.display).toBe('block')
    trustedClick(floatingButton())
    expect(panel.isOpen()).toBe(true)
    expect((shadow().querySelector('.floating-menu') as HTMLElement).hidden).toBe(false)
    panel.showToolbar(ANCHOR, true, () => undefined)
    expect((shadow().querySelector('.floating-menu') as HTMLElement).hidden).toBe(true)
    expect((shadow().querySelector('.selection-toolbar') as HTMLElement).style.display).not.toBe('none')
    expect(panel.isOpen()).toBe(true)
    expect(closed).toBe(0)
    trustedClick(floatingButton())
    expect((shadow().querySelector('.selection-toolbar') as HTMLElement).style.display).toBe('none')
    expect((shadow().querySelector('.floating-menu') as HTMLElement).hidden).toBe(false)
    expect(closed).toBe(1)
    panel.close()
    expect(panel.isOpen()).toBe(false)
    expect(floatingButton()).not.toBeNull()
    expect(host().style.display).toBe('block')
    expect(closed).toBe(1)
  })

  it('未配置工具栏显示整行提示并指向它', () => {
    panel = createTranslationPanel()
    panel.showToolbar(ANCHOR, false, () => undefined)
    const hint = shadow().querySelector('.toolbar-configure-hint') as HTMLParagraphElement
    const toolbar = shadow().querySelector('.selection-toolbar') as HTMLElement
    const copy = shadow().querySelector('[data-action="copy"]') as HTMLButtonElement
    expect(hint.hidden).toBe(false)
    expect(hint.getAttribute('role')).toBe('status')
    expect(hint.textContent).toBe('请先配置模型')
    expect(toolbar.getAttribute('aria-describedby')).toBe(hint.id)
    expect(copy.getAttribute('aria-describedby')).toBe(hint.id)
    panel.showToolbar(ANCHOR, true, () => undefined)
    expect(hint.hidden).toBe(true)
    expect(toolbar.hasAttribute('aria-describedby')).toBe(false)
    expect(copy.hasAttribute('aria-describedby')).toBe(false)
  })

  it('焦点进入原生弹层后关闭或移除，宿主回到根节点', async () => {
    panel = createTranslationPanel()
    panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
    expect(host().parentElement).toBe(document.documentElement)
    const dlg = document.createElement('dialog')
    const input = document.createElement('input')
    dlg.append(input)
    document.body.append(dlg)
    dlg.showModal()
    const bound = dlg.matches.bind(dlg)
    vi.spyOn(dlg, 'matches').mockImplementation((selector) => (selector === ':modal' ? dlg.open : bound(selector)))
    input.focus()
    expect(host().parentElement).toBe(dlg)
    dlg.open = false
    dlg.dispatchEvent(new Event('close'))
    expect(host().parentElement).toBe(document.documentElement)
    expect(floatingButton()).not.toBeNull()

    const removed = document.createElement('dialog')
    const removedInput = document.createElement('input')
    removed.append(removedInput)
    document.body.append(removed)
    removed.showModal()
    const removedBound = removed.matches.bind(removed)
    vi.spyOn(removed, 'matches').mockImplementation((selector) =>
      selector === ':modal' ? removed.open : removedBound(selector),
    )
    removedInput.focus()
    expect(host().parentElement).toBe(removed)
    trustedClick(floatingButton())
    expect(panel.isOpen()).toBe(true)
    removed.remove()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host().parentElement).toBe(document.documentElement)
    expect(panel.isOpen()).toBe(false)
    expect(floatingButton()).not.toBeNull()
  })

  it('dispose 卸下悬浮入口新增的监听和观察器', () => {
    const docAdd = vi.spyOn(document, 'addEventListener')
    const docRemove = vi.spyOn(document, 'removeEventListener')
    const winAdd = vi.spyOn(window, 'addEventListener')
    const winRemove = vi.spyOn(window, 'removeEventListener')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const dlg = document.createElement('dialog')
    const input = document.createElement('input')
    dlg.append(input)
    document.body.append(dlg)
    dlg.showModal()
    const bound = dlg.matches.bind(dlg)
    vi.spyOn(dlg, 'matches').mockImplementation((selector) => (selector === ':modal' ? dlg.open : bound(selector)))
    input.focus()
    panel = createTranslationPanel()
    panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
    expect(host().parentElement).toBe(dlg)
    panel.dispose()
    panel = undefined
    const added = docAdd.mock.calls.map((call) => String(call[0]))
    const removed = docRemove.mock.calls.map((call) => String(call[0]))
    for (const type of new Set(added)) {
      expect(removed.filter((item) => item === type).length).toBeGreaterThanOrEqual(added.filter((item) => item === type).length)
    }
    const addedWindow = winAdd.mock.calls.map((call) => String(call[0]))
    const removedWindow = winRemove.mock.calls.map((call) => String(call[0]))
    for (const type of new Set(addedWindow)) {
      expect(removedWindow.filter((item) => item === type).length).toBeGreaterThanOrEqual(
        addedWindow.filter((item) => item === type).length,
      )
    }
    expect(disconnect).toHaveBeenCalled()
    dlg.remove()
  })
})

describe('结果卡片复制', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function copyButton(): HTMLButtonElement | null {
    return shadow().querySelector('.panel-actions button.panel-copy[data-action="copy-result"]')
  }

  it('结果卡片出现复制按钮并以 answer 文本调用 handler', () => {
    panel = createTranslationPanel()
    const copied: string[] = []
    panel.setOnCopyResult((text) => {
      copied.push(text)
    })
    panel.showSelectionResult('Hello\nWorld', ['你好', '世界'])
    const button = copyButton()
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('复制')
    button?.click()
    expect(copied).toEqual(['你好\n世界'])
  })

  it('showAssist 时复制的是 answer（translation 非空用 translation，否则 explanation）', () => {
    panel = createTranslationPanel()
    const copied: string[] = []
    panel.setOnCopyResult((text) => {
      copied.push(text)
    })
    panel.showAssist('src', {
      decision: 'show',
      intent: 'translate',
      translation: '目标译文',
      explanation: '补充解释',
    })
    const actionButtons = [...shadow().querySelectorAll('.panel-actions button')]
    expect(actionButtons[0]).toBe(copyButton())
    expect(actionButtons[1]?.textContent).toBe('只翻译')
    copyButton()?.click()
    expect(copied).toEqual(['目标译文'])

    panel.showAssist('src', {
      decision: 'show',
      intent: 'explain',
      translation: '',
      explanation: '仅有解释',
    })
    copyButton()?.click()
    expect(copied).toEqual(['目标译文', '仅有解释'])
  })

  it('showError/showNotice 不出现按钮', () => {
    panel = createTranslationPanel()
    panel.showSelection('loading source')
    expect(copyButton()).toBeNull()
    panel.showError('请求超时')
    expect(copyButton()).toBeNull()
    panel.showNotice('本页处理已达上限')
    expect(copyButton()).toBeNull()
  })

  it('setCopyResultFeedback(true/false) 的文字与 1500ms 恢复', () => {
    vi.useFakeTimers()
    panel = createTranslationPanel()
    panel.showSelectionResult('src', ['译文'])
    const statusEl = shadow().querySelector('.panel-status') as HTMLElement
    const live = shadow().querySelector('.panel .panel-announcement') as HTMLElement
    // 没点过复制时的反馈不生效（迟到反馈不能落到新结果上）
    panel.setCopyResultFeedback(true)
    expect(copyButton()?.textContent).toBe('复制')
    copyButton()?.click()
    panel.setCopyResultFeedback(true)
    expect(copyButton()?.textContent).toBe('已复制')
    // 可见反馈只在按钮上；状态区不重复显示，读屏通过隐藏 live 区域得到消息
    expect(statusEl.style.display).toBe('none')
    expect(live.textContent).toBe('已复制')
    vi.advanceTimersByTime(1499)
    expect(copyButton()?.textContent).toBe('已复制')
    vi.advanceTimersByTime(1)
    expect(copyButton()?.textContent).toBe('复制')
    expect(live.textContent).toBe('')
    expect(statusEl.style.display).toBe('none')

    copyButton()?.click()
    panel.setCopyResultFeedback(false)
    expect(copyButton()?.textContent).toBe('复制失败')
    expect(live.textContent).toBe('复制失败')
    vi.advanceTimersByTime(1500)
    expect(copyButton()?.textContent).toBe('复制')
    expect(live.textContent).toBe('')
    expect(statusEl.style.display).toBe('none')
  })

  it('反馈期间 showError 后计时器到期不清除错误信息', () => {
    vi.useFakeTimers()
    panel = createTranslationPanel()
    panel.showSelectionResult('src', ['译文'])
    const statusEl = shadow().querySelector('.panel-status') as HTMLElement
    copyButton()?.click()
    panel.setCopyResultFeedback(true)
    panel.showError('x')
    vi.advanceTimersByTime(1500)
    expect(shadow().querySelector('.panel')?.getAttribute('title')).toBe('x')
    expect(shadow().querySelector('.panel-title')?.textContent).toBe('翻译失败')
    expect(statusEl.style.display).toBe('none')
    expect((shadow().querySelector('.panel .panel-announcement') as HTMLElement).textContent).toBe('')
  })

  it('close 后再调用 setCopyResultFeedback 不抛错且无文字变化', () => {
    panel = createTranslationPanel()
    panel.showSelectionResult('src', ['译文'])
    panel.close()
    expect(() => panel?.setCopyResultFeedback(true)).not.toThrow()
    expect(copyButton()).toBeNull()
    expect(shadow().querySelector('.panel-status')?.textContent).toBe('')
    expect(shadow().textContent).not.toContain('已复制')
  })

  it('页面隐藏复位复制反馈，隐藏与恢复期间不再产生新反馈', () => {
    vi.useFakeTimers()
    const setHidden = (value: boolean): void => {
      Object.defineProperty(document, 'hidden', { value, configurable: true })
    }
    try {
      panel = createTranslationPanel()
      panel.showSelectionResult('src', ['译文'])
      const live = shadow().querySelector('.panel .panel-announcement') as HTMLElement
      copyButton()?.click()
      panel.setCopyResultFeedback(true)
      expect(copyButton()?.textContent).toBe('已复制')
      setHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(copyButton()?.textContent).toBe('复制')
      expect(live.textContent).toBe('')
      panel.setCopyResultFeedback(true)
      expect(copyButton()?.textContent).toBe('复制')
      setHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
      panel.setCopyResultFeedback(true)
      expect(copyButton()?.textContent).toBe('复制')
      expect(live.textContent).toBe('')
      vi.advanceTimersByTime(2000)
      expect(copyButton()?.textContent).toBe('复制')
    } finally {
      setHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
      vi.useRealTimers()
    }
  })
})

describe('焦点归还与提示键盘', () => {
  it('工具栏唤起后外部指针按下关闭且不抢回页面焦点', () => {
    const pageButton = document.createElement('button')
    document.body.append(pageButton)
    try {
      pageButton.focus()
      panel = createTranslationPanel()
      panel.showToolbar(ANCHOR, true, () => undefined)
      expect(panel.focusToolbar()).toBe(true)
      const outside = document.createElement('button')
      document.body.append(outside)
      try {
        outside.focus()
        outside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        expect(panel.isOpen()).toBe(false)
        expect(document.activeElement).toBe(outside)
      } finally {
        outside.remove()
      }
    } finally {
      pageButton.remove()
    }
  })

  it('返回目标已脱离文档时关闭不报错也不聚焦', () => {
    const pageButton = document.createElement('button')
    document.body.append(pageButton)
    try {
      pageButton.focus()
      panel = createTranslationPanel()
      panel.showToolbar(ANCHOR, true, () => undefined)
      expect(panel.focusToolbar()).toBe(true)
      pageButton.remove()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(panel.isOpen()).toBe(false)
      expect(document.activeElement).not.toBe(pageButton)
    } finally {
      pageButton.remove()
    }
  })

  it('提示键盘激活展开卡片并聚焦关闭钮，鼠标点击不抢焦点', () => {
    panel = createTranslationPanel()
    let opened = 0
    panel.showHint(ANCHOR, () => {
      opened += 1
    })
    const hintEl = shadow().querySelector('.hint') as HTMLButtonElement
    hintEl.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(opened).toBe(1)
    expect((shadow().querySelector('.panel') as HTMLElement).style.display).toBe('')
    expect(shadow().activeElement).not.toBe(shadow().querySelector('.panel-close'))

    panel.showHint(ANCHOR, () => {
      opened += 1
    })
    hintEl.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    expect(opened).toBe(2)
    expect(shadow().activeElement).toBe(shadow().querySelector('.panel-close'))
  })

  it('悬浮菜单 Escape 把焦点还给入口而不是旧页面按钮', () => {
    const pageButton = document.createElement('button')
    document.body.append(pageButton)
    try {
      pageButton.focus()
      panel = createTranslationPanel()
      panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
      trustedClick(floatingButton())
      expect((shadow().querySelector('.floating-menu') as HTMLElement).hidden).toBe(false)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(shadow().activeElement).toBe(floatingButton())
      expect(document.activeElement).not.toBe(pageButton)
    } finally {
      pageButton.remove()
    }
  })
})

describe('页面隐藏生命周期', () => {
  function setHidden(value: boolean): void {
    Object.defineProperty(document, 'hidden', { value, configurable: true })
  }

  it('隐藏取消暂停定位 rAF（含 pauseShown），恢复后重新定位，dispose 清空', () => {
    const pending = new Set<number>()
    const callbacks = new Map<number, FrameRequestCallback>()
    let nextId = 0
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++nextId
      pending.add(id)
      callbacks.set(id, callback)
      return id
    })
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      pending.delete(id)
      callbacks.delete(id)
    })
    try {
      panel = createTranslationPanel()
      panel.showPauseStatus('paused', true)
      expect(pending.size).toBeGreaterThan(0)
      setHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(pending.size).toBe(0)
      setHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(pending.size).toBeGreaterThan(0)
      panel.dispose()
      panel = undefined
      expect(pending.size).toBe(0)
    } finally {
      setHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
      rafSpy.mockRestore()
      cafSpy.mockRestore()
    }
  })

  it('Shift+Escape 与输入法合成中的 Escape 不关闭，普通 Escape 关闭并归还页面焦点', () => {
    const pageButton = document.createElement('button')
    document.body.append(pageButton)
    pageButton.focus()
    try {
      panel = createTranslationPanel()
      panel.showToolbar(ANCHOR, true, () => undefined)
      expect(panel.focusToolbar()).toBe(true)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true }))
      expect(panel.isOpen()).toBe(true)
      const composing = new KeyboardEvent('keydown', { key: 'Escape' })
      Object.defineProperty(composing, 'isComposing', { value: true, configurable: true })
      document.dispatchEvent(composing)
      expect(panel.isOpen()).toBe(true)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(panel.isOpen()).toBe(false)
      expect(document.activeElement).toBe(pageButton)
    } finally {
      pageButton.remove()
    }
  })
})

describe('封闭 Shadow DOM 与内部交互回归', () => {
  it('host.shadowRoot 为 null，宿主与文档拿不到译文与开关，内部事件、复制与焦点正常', () => {
    panel = createTranslationPanel()
    const copied: string[] = []
    panel.setOnCopyResult((text) => {
      copied.push(text)
    })
    panel.setFloating(floatingView(), floatingLabels(), floatingCallbacks())
    panel.showAssist('source text', {
      decision: 'show',
      intent: 'translate',
      translation: '封闭译文内容',
      explanation: '封闭解释说明',
    })

    const h = host()
    expect(h.shadowRoot).toBeNull()
    expect(h.querySelector('.panel-target')).toBeNull()
    expect(h.querySelector('.floating-auto')).toBeNull()
    expect(document.querySelector('.panel-target')).toBeNull()
    expect(document.querySelector('.floating-auto')).toBeNull()
    expect(h.textContent).toBe('')

    const target = shadow().querySelector('.panel-target') as HTMLElement
    expect(target.textContent).toBe('封闭译文内容')

    let seenContains: boolean | undefined
    const capture = (event: Event): void => {
      seenContains = panel?.containsEvent(event)
    }
    document.addEventListener('pointerdown', capture, true)
    try {
      target.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }))
    } finally {
      document.removeEventListener('pointerdown', capture, true)
    }
    expect(seenContains).toBe(true)
    expect(panel.isOpen()).toBe(true)

    const copyBtn = shadow().querySelector('.panel-copy') as HTMLButtonElement
    copyBtn.click()
    panel.setCopyResultFeedback(true)
    expect(copied).toEqual(['封闭译文内容'])
    expect(copyBtn.textContent).toBe('已复制')

    trustedClick(floatingButton())
    const primary = shadow().querySelector('.floating-auto') as HTMLButtonElement
    trustedClick(primary)
    expect(primary.getAttribute('role')).toBe('switch')
    expect(primary.getAttribute('aria-checked')).toBe('false')
    expect(primary.disabled).toBe(false)
    expect(h.querySelector('.floating-auto')).toBeNull()
    expect(document.querySelector('.floating-auto')).toBeNull()

    panel.showToolbar(ANCHOR, true, () => undefined)
    expect(panel.focusToolbar()).toBe(true)
    const translateBtn = shadow().querySelector('[data-action="translate"]') as HTMLButtonElement
    const defineBtn = shadow().querySelector('[data-action="define"]') as HTMLButtonElement
    expect(shadow().activeElement).toBe(translateBtn)
    expect(document.activeElement).toBe(h)
    translateBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, composed: true }))
    expect(shadow().activeElement).toBe(defineBtn)
  })
})
