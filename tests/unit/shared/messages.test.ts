import {
  isAcknowledged,
  isBackgroundMessage,
  isContentMessage,
  isContentStatus,
  isGitHubPageReply,
  isGitHubPageState,
} from '../../../src/shared/messages'

const STATUS = {
  active: true,
  excluded: false,
  pages: ['common', 'repository'],
  translatedCount: 12,
}

describe('isContentMessage', () => {
  it.each(['gcn:get-status', 'gcn:custom-entries-changed'])('%s 合法', (type) => {
    expect(isContentMessage({ type })).toBe(true)
  })

  it.each([
    null,
    undefined,
    'gcn:get-status',
    {},
    { type: 1 },
    { type: 'gcn:other' },
    { type: 'gcn:get-untranslated' },
    { type: 'gcn:flush-untranslated' },
    { type: 'gcn:untranslated-cleared', epoch: 1 },
    { type: 'gcn:clear-untranslated' },
  ])('%j 非法', (value) => {
    expect(isContentMessage(value)).toBe(false)
  })
})

describe('isContentStatus', () => {
  it('完整状态合法', () => {
    expect(isContentStatus(STATUS)).toBe(true)
  })

  it.each([
    ['null', null],
    ['数组', [STATUS]],
    ['active 非布尔', { ...STATUS, active: 'yes' }],
    ['excluded 缺失', { ...STATUS, excluded: undefined }],
    ['pages 非数组', { ...STATUS, pages: 'common' }],
    ['pages 含非字符串', { ...STATUS, pages: ['common', 1] }],
    ['计数为负', { ...STATUS, translatedCount: -1 }],
    ['计数非整数', { ...STATUS, translatedCount: 1.5 }],
    ['计数为字符串', { ...STATUS, translatedCount: '3' }],
  ])('%s → 非法', (_name, value) => {
    expect(isContentStatus(value)).toBe(false)
  })
})

describe('isBackgroundMessage', () => {
  it('词条已保存合法', () => {
    expect(isBackgroundMessage({ type: 'gcn:custom-entries-saved' })).toBe(true)
  })

  it('注入词典脚本：只认已知语言', () => {
    expect(isBackgroundMessage({ type: 'gcn:inject-locale', locale: 'zh-CN' })).toBe(true)
    expect(isBackgroundMessage({ type: 'gcn:inject-locale', locale: 'zh-TW' })).toBe(true)
    expect(isBackgroundMessage({ type: 'gcn:inject-locale', locale: 'en' })).toBe(false)
    expect(isBackgroundMessage({ type: 'gcn:inject-locale', locale: '../../popup.js' })).toBe(false)
    expect(isBackgroundMessage({ type: 'gcn:inject-locale' })).toBe(false)
  })

  it.each([
    ['null', null],
    ['数组', [{ type: 'gcn:custom-entries-saved' }]],
    ['未知类型', { type: 'gcn:get-status' }],
    ['旧版未翻译上报', { type: 'gcn:report-untranslated', items: [['Open issues', 'issues', 1, 2, 1]] }],
    ['旧版未翻译清空', { type: 'gcn:clear-untranslated' }],
  ])('%s → 非法', (_name, value) => {
    expect(isBackgroundMessage(value)).toBe(false)
  })
})

describe('gcn:page-translation', () => {
  const url = 'https://github.com/vuejs/core/issues'

  it('合法动作与 GitHub 地址通过', () => {
    for (const action of ['status', 'restore', 'resume']) {
      expect(isContentMessage({ type: 'gcn:page-translation', action, url })).toBe(true)
    }
  })

  it('非法 action 或 url 拒绝', () => {
    expect(isContentMessage({ type: 'gcn:page-translation', action: 'pause', url })).toBe(false)
    expect(isContentMessage({ type: 'gcn:page-translation', action: 'retry-failed', url })).toBe(false)
    expect(isContentMessage({ type: 'gcn:page-translation', url })).toBe(false)
    expect(isContentMessage({ type: 'gcn:page-translation', action: 'restore' })).toBe(false)
    expect(isContentMessage({ type: 'gcn:page-translation', action: 'restore', url: 'https://example.com/a' })).toBe(false)
    expect(isContentMessage({ type: 'gcn:page-translation', action: 'restore', url: 'http://github.com/vuejs/core' })).toBe(false)
    expect(isContentMessage({ type: 'gcn:page-translation', action: 'restore', url: 1 })).toBe(false)
  })

  it('回复缺 active/paused 或伪布尔拒绝', () => {
    expect(isGitHubPageState({ active: true, paused: false })).toBe(true)
    expect(isGitHubPageReply({ ok: true, active: false, paused: true })).toBe(true)
    expect(isGitHubPageReply({ ok: true, active: true })).toBe(false)
    expect(isGitHubPageReply({ ok: true, paused: false })).toBe(false)
    expect(isGitHubPageReply({ active: true, paused: false })).toBe(false)
    expect(isGitHubPageReply({ ok: true, active: 'true', paused: false })).toBe(false)
    expect(isGitHubPageReply({ ok: true, active: 1, paused: 0 })).toBe(false)
    expect(isGitHubPageReply({ ok: 'true', active: true, paused: false })).toBe(false)
    expect(isGitHubPageState({ active: 'yes', paused: false })).toBe(false)
  })
})

describe('isAcknowledged', () => {
  it('只有 ok 为 true 才算确认', () => {
    expect(isAcknowledged({ ok: true })).toBe(true)
    expect(isAcknowledged({ ok: false })).toBe(false)
    expect(isAcknowledged({ ok: 'true' })).toBe(false)
    expect(isAcknowledged(undefined)).toBe(false)
    expect(isAcknowledged(true)).toBe(false)
  })
})
