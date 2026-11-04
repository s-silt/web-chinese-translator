import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistance } from '../../../src/translation/assistance'
import {
  TRANSLATION_CONFIG_CHANGED_ERROR,
  TRANSLATION_PERMISSION_REMOVED_ERROR,
} from '../../../src/translation/messages'
import { createTranslationPanel } from '../../../src/translation/panel'
import { getCapturedShadowRoot, installShadowRootCapture } from '../shared/shadow-roots'

const sent: {
  type: string
  requestId?: string
  texts?: string[]
  manualSelectionId?: string
  input?: { text?: string; requestedIntent?: string }
}[] = []
const deferred = new Map<string, (v: unknown) => void>()
let restoreShadowCapture: (() => void) | undefined

vi.mock('../../../src/translation/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/translation/client')>()
  return {
    ...actual,
    sendTranslationMessage: vi.fn(
      (message: {
        type: string
        requestId?: string
        texts?: string[]
        manualSelectionId?: string
        input?: { text?: string; requestedIntent?: string }
      }) => {
        sent.push(message)
        if (message.type === 'wt:cancel-assist') return Promise.resolve({ ok: true })
        return new Promise((resolve) => {
          if (message.requestId !== undefined) deferred.set(message.requestId, resolve)
        })
      },
    ),
  }
})

const ANCHOR = { left: 0, top: 0, right: 10, bottom: 10 }

let panel: ReturnType<typeof createTranslationPanel> | undefined

function start(pageId = 'p1'): ReturnType<typeof createAssistance> {
  panel = createTranslationPanel()
  return createAssistance({
    panel,
    enabled: () => true,
    configured: () => true,
    smart: () => true,
    pageId: () => pageId,
  })
}

function rootShadow(): ShadowRoot | undefined {
  return getCapturedShadowRoot(document.querySelector('[data-wt-root]'))
}

beforeEach(() => {
  sent.length = 0
  deferred.clear()
  document.body.innerHTML = ''
  restoreShadowCapture = installShadowRootCapture()
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }] as never,
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
  )
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }) as DOMRect,
  )
})
afterEach(() => {
  panel?.dispose()
  restoreShadowCapture?.()
  restoreShadowCapture = undefined
  vi.restoreAllMocks()
})

describe('assistance', () => {
  it.each(['define', 'explain'] as const)('%s 失败重试保留原意图且生成新请求，取消后不重放', async (intent) => {
    const assist = start()
    assist.select('technical term', ANCHOR, 'mouse', () => true, intent)
    const first = sent.at(-1)!
    deferred.get(first.requestId!)!({ ok: false, error: 'network failure' })
    await Promise.resolve()
    assist.repeatRequest()
    const retry = sent.at(-1)!
    expect(retry.type).toBe('wt:assist')
    expect(retry.input).toMatchObject({ text: 'technical term', requestedIntent: intent })
    expect(retry.requestId).not.toBe(first.requestId)
    assist.cancel()
    const count = sent.length
    assist.repeatRequest()
    expect(sent).toHaveLength(count)
  })

  it('手动翻译重试保留票据，页面身份变化后不重放', async () => {
    let pageId = 'page-one'
    panel = createTranslationPanel()
    const assist = createAssistance({ panel, enabled: () => true, configured: () => true, smart: () => true, pageId: () => pageId })
    assist.literal('manual source', ANCHOR, () => true, 'manual-ticket')
    const first = sent.at(-1)!
    deferred.get(first.requestId!)!({ ok: false, error: 'network failure' })
    await Promise.resolve()
    assist.repeatRequest()
    expect(sent.at(-1)).toMatchObject({ type: 'wt:translate', texts: ['manual source'], manualSelectionId: 'manual-ticket' })
    expect(sent.at(-1)?.requestId).not.toBe(first.requestId)
    pageId = 'page-two'
    const count = sent.length
    assist.repeatRequest()
    expect(sent).toHaveLength(count)
  })

  it('A 迟到失败不覆盖已成功的 B', async () => {
    const assist = start()
    assist.literal('first text', ANCHOR)
    const idA = sent.at(-1)!.requestId!
    assist.literal('second text', ANCHOR)
    const idB = sent.at(-1)!.requestId!
    deferred.get(idB)!({ ok: true, texts: ['译文B'] })
    await Promise.resolve()
    deferred.get(idA)!({ ok: false, error: '失败A' })
    await Promise.resolve()
    expect(rootShadow()?.textContent).toContain('译文B')
    expect(rootShadow()?.textContent).not.toContain('失败A')
  })

  it('选区失效后请求返回关闭加载面板', async () => {
    document.body.innerHTML = '<p>source text here</p>'
    const p = document.querySelector('p')!
    const sel = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(p)
    sel.removeAllRanges()
    sel.addRange(range)
    const assist = start()
    assist.literal('source text here', ANCHOR)
    const id = sent.at(-1)!.requestId!
    p.textContent = 'changed content'
    deferred.get(id)!({ ok: true, texts: ['译文'] })
    await Promise.resolve()
    expect(panel!.isOpen()).toBe(false)
  })

  it('revisit 智能候选发射 wt:assist 并在点击后展示答案', async () => {
    document.body.innerHTML = '<main><p>candidate paragraph content here</p></main>'
    const el = document.querySelector('p')!
    const assist = start()
    assist.revisit({ text: 'candidate paragraph content here', anchor: ANCHOR, dwellMs: 4000, visits: 2, element: el })
    const id = sent.at(-1)!.requestId!
    expect(sent.at(-1)!.type).toBe('wt:assist')
    deferred.get(id)!({
      ok: true,
      result: { decision: 'show', intent: 'translate', translation: '候选答案', explanation: '' },
    })
    await Promise.resolve()
    const hint = rootShadow()?.querySelector('.hint') as HTMLElement | null
    expect(hint).not.toBeNull()
    hint?.click()
    await Promise.resolve()
    expect(rootShadow()?.textContent).toContain('候选答案')
  })

  it('pageId 变化后旧响应被忽略', async () => {
    let page = 'page-a'
    panel = createTranslationPanel()
    const assist = createAssistance({
      panel,
      enabled: () => true,
      configured: () => true,
      smart: () => true,
      pageId: () => page,
    })
    assist.literal('old text', ANCHOR)
    const id = sent.at(-1)!.requestId!
    page = 'page-b'
    deferred.get(id)!({ ok: true, texts: ['旧译文'] })
    await Promise.resolve()
    expect(rootShadow()?.textContent ?? '').not.toContain('旧译文')
  })

  it('发送前源失效不发请求', () => {
    const assist = start()
    assist.select('stale text', ANCHOR, 'mouse', () => false)
    expect(sent.filter((m) => m.type === 'wt:assist')).toHaveLength(0)
    void assist
  })

  it('revisit 点击后 repeatLiteral 发送候选原文', async () => {
    document.body.innerHTML = '<main><p>candidate paragraph content here</p></main>'
    const el = document.querySelector('p')!
    const assist = start()
    assist.revisit({ text: 'candidate paragraph content here', anchor: ANCHOR, dwellMs: 4000, visits: 2, element: el })
    const id = sent.at(-1)!.requestId!
    deferred.get(id)!({
      ok: true,
      result: { decision: 'show', intent: 'translate', translation: '候选答案', explanation: '' },
    })
    await Promise.resolve()
    const hint = rootShadow()?.querySelector('.hint') as HTMLElement | null
    hint?.click()
    await Promise.resolve()
    panel!.setOnLiteral(() => assist.repeatLiteral())
    const literalBtn = [...(rootShadow()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '只翻译',
    ) as HTMLElement | undefined
    expect(literalBtn).toBeDefined()
    literalBtn!.dispatchEvent(Object.assign(new MouseEvent('click', { bubbles: true }), { isTrusted: true }))
    await Promise.resolve()
    const translate = sent.filter((m) => m.type === 'wt:translate').at(-1)
    expect(translate?.texts).toEqual(['candidate paragraph content here'])
  })

  it('显式释义只把 requestedIntent 传给 assist 请求', () => {
    const assist = start()
    assist.select('term', ANCHOR, 'mouse', () => true, 'define')
    const message = sent.filter((item) => item.type === 'wt:assist').at(-1)
    expect(message?.input).toMatchObject({ text: 'term', requestedIntent: 'define' })
    sent.length = 0
    assist.select('passage', ANCHOR, 'keyboard', () => true)
    const implicit = sent.filter((item) => item.type === 'wt:assist').at(-1)
    expect(implicit?.input).toMatchObject({ text: 'passage' })
    expect(implicit?.input).not.toHaveProperty('requestedIntent')
  })

  it('message 回调把配置错误显示为日语', () => {
    panel = createTranslationPanel()
    const assist = createAssistance({
      panel,
      enabled: () => true,
      configured: () => false,
      smart: () => false,
      pageId: () => 'p',
      message: (key) => (key === 'wtAssistConfigure' ? 'モデルを設定してください' : key),
    })
    assist.literal('source text')
    expect(rootShadow()?.querySelector('.panel-status')?.textContent).toBe(
      'モデルを設定してください',
    )
  })

  it('literal 携带 manualSelectionId 且 repeatLiteral 保留该 ticket，普通 select/revisit/cancel 清空旧 ticket', () => {
    const assist = start()
    assist.literal('manual source', undefined, undefined, 'ticket-manual-1')
    expect(sent.filter((m) => m.type === 'wt:translate').at(-1)?.manualSelectionId).toBe('ticket-manual-1')

    document.body.innerHTML = '<main><p>ignored revisit while panel open</p></main>'
    const ignoredEl = document.querySelector('p')!
    expect(panel!.isOpen()).toBe(true)
    assist.revisit({
      text: 'ignored revisit while panel open',
      anchor: ANCHOR,
      dwellMs: 4000,
      visits: 2,
      element: ignoredEl,
    })

    assist.repeatLiteral()
    expect(sent.filter((m) => m.type === 'wt:translate').at(-1)?.manualSelectionId).toBe('ticket-manual-1')

    assist.select('normal selection', ANCHOR, 'mouse', () => true)
    assist.repeatLiteral()
    const afterSelect = sent.filter((m) => m.type === 'wt:translate').at(-1)
    expect(afterSelect?.texts).toEqual(['normal selection'])
    expect(afterSelect).not.toHaveProperty('manualSelectionId')

    assist.literal('manual source 2', undefined, undefined, 'ticket-manual-2')
    expect(sent.filter((m) => m.type === 'wt:translate').at(-1)?.manualSelectionId).toBe('ticket-manual-2')
    panel!.close()
    document.body.innerHTML = '<main><p>revisit paragraph content here</p></main>'
    const el = document.querySelector('p')!
    assist.revisit({ text: 'revisit paragraph content here', anchor: ANCHOR, dwellMs: 4000, visits: 2, element: el })
    assist.repeatLiteral()
    const afterRevisit = sent.filter((m) => m.type === 'wt:translate').at(-1)
    expect(afterRevisit?.texts).toEqual(['revisit paragraph content here'])
    expect(afterRevisit).not.toHaveProperty('manualSelectionId')

    assist.literal('manual source 3', undefined, undefined, 'ticket-manual-3')
    assist.cancel()
    assist.literal('plain literal', ANCHOR, () => true)
    const afterCancel = sent.filter((m) => m.type === 'wt:translate').at(-1)
    expect(afterCancel?.texts).toEqual(['plain literal'])
    expect(afterCancel).not.toHaveProperty('manualSelectionId')
  })

  it('手动授权票据 cancelled 时显示对应原因或重新选中文案且不提供重试按钮；普通网络错误仍可重试', async () => {
    const assist = start()
    for (const [ticket, error, expectedText] of [
      [
        'ticket-perm',
        TRANSLATION_PERMISSION_REMOVED_ERROR,
        '网站或模型接口的访问权限已撤销，请重新授权后再翻译。',
      ],
      [
        'ticket-config',
        TRANSLATION_CONFIG_CHANGED_ERROR,
        '翻译设置已变化，请确认设置后重新发起翻译。',
      ],
      [
        'ticket-expired',
        '已取消',
        '请重新选中文字，再通过右键菜单或快捷键翻译。',
      ],
    ] as const) {
      assist.literal('manual source', undefined, () => true, ticket)
      const id = sent.at(-1)!.requestId!
      deferred.get(id)!({ ok: false, code: 'cancelled', error })
      await Promise.resolve()
      expect(rootShadow()?.querySelector('.panel-status')?.textContent).toBe(expectedText)
      expect(rootShadow()?.querySelectorAll('.panel-actions button')).toHaveLength(0)
    }

    assist.literal('manual source retryable', undefined, () => true, 'ticket-net')
    const idNet = sent.at(-1)!.requestId!
    deferred.get(idNet)!({ ok: false, error: '无法连接翻译服务' })
    await Promise.resolve()
    expect(rootShadow()?.querySelector('.panel')?.getAttribute('title')).toBe('无法连接翻译服务')
    expect(rootShadow()?.querySelector('.panel-title')?.textContent).toBe('翻译失败')
    expect(rootShadow()?.querySelectorAll('.panel-actions button')).toHaveLength(1)
  })

  it.each(['literal', 'select'] as const)(
    '在途请求变为未配置后 %s 取消旧请求，仅显式调用提示配置',
    async (mode) => {
      let configured = true
      panel = createTranslationPanel()
      const assist = createAssistance({
        panel,
        enabled: () => true,
        configured: () => configured,
        smart: () => true,
        pageId: () => 'p1',
      })
      assist.literal('old manual text', ANCHOR, () => true, 'ticket-old')
      const oldId = sent.at(-1)!.requestId!
      configured = false
      if (mode === 'literal') {
        assist.literal('new text', ANCHOR, () => true, 'ticket-new')
      } else {
        assist.select('new text', ANCHOR, 'mouse', () => true)
      }
      expect(sent.map((m) => m.type)).toEqual(['wt:translate', 'wt:cancel-assist'])
      expect(sent[1]?.requestId).toBe(oldId)
      const expected = mode === 'literal' ? '请在扩展设置中配置模型' : ''
      expect(rootShadow()?.querySelector('.panel-status')?.textContent).toBe(expected)
      expect(panel.isOpen()).toBe(mode === 'literal')
      expect(rootShadow()?.querySelectorAll('.panel-actions button')).toHaveLength(0)
      deferred.get(oldId)!({ ok: true, texts: ['旧译文'] })
      await Promise.resolve()
      expect(rootShadow()?.querySelector('.panel-status')?.textContent).toBe(expected)
      expect(rootShadow()?.textContent ?? '').not.toContain('旧译文')
      expect(rootShadow()?.querySelectorAll('.panel-actions button')).toHaveLength(0)
    },
  )
})
