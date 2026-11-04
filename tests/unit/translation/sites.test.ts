import { describe, expect, it } from 'vitest'
import {
  isModelCandidateText,
  joinTranslatedChunks,
  MAX_MODEL_TEXT,
  splitLongText,
  type LongTextChunks,
} from '../../../src/translation/sites'

describe('isModelCandidateText', () => {
  it('接受普通英文文本', () => {
    expect(isModelCandidateText('Deploy failed with exit code 1', 'zh-CN')).toBe(true)
  })

  it('拒绝空串、纯 URL、纯中文', () => {
    expect(isModelCandidateText('   ', 'zh-CN')).toBe(false)
    expect(isModelCandidateText('https://example.com/a/b', 'zh-CN')).toBe(false)
    expect(isModelCandidateText('已经翻译过的文字', 'zh-CN')).toBe(false)
  })

  it('超长文本仍是候选，由引擎分段', () => {
    expect(isModelCandidateText('x'.repeat(1501), 'zh-CN')).toBe(true)
  })
})

describe('splitLongText', () => {
  const rebuilt = ({ chunks, separators }: LongTextChunks): string =>
    chunks.reduce((joined, chunk, index) => joined + (separators[index - 1] ?? '') + chunk)

  it('未超限不切分，只去掉首尾空白', () => {
    expect(splitLongText('  Short text.  ')).toEqual({ chunks: ['Short text.'], separators: [] })
    expect(splitLongText('x'.repeat(MAX_MODEL_TEXT)).chunks).toHaveLength(1)
  })

  it('优先在句末切分，分段不超限且拼回原文', () => {
    const text = Array.from({ length: 200 }, (_, index) => `Sentence number ${index} of the article.`).join(' ')
    const result = splitLongText(text)
    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.separators).toHaveLength(result.chunks.length - 1)
    for (const chunk of result.chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_MODEL_TEXT)
    for (const chunk of result.chunks.slice(0, -1)) expect(chunk.endsWith('.')).toBe(true)
    expect(rebuilt(result)).toBe(text)
  })

  it('句子超长时在空白处切分，没有空白时硬切且不拆代理对', () => {
    const words = 'word '.repeat(10).trim()
    const spaced = splitLongText(words, 12)
    expect(spaced.chunks.every((chunk) => chunk.length <= 12 && !chunk.includes('wor '))).toBe(true)
    expect(rebuilt(spaced)).toBe(words)
    const emoji = `a${'😀'.repeat(10)}`
    const hard = splitLongText(emoji, 4)
    expect(rebuilt(hard)).toBe(emoji)
    expect(hard.separators.every((separator) => separator === '')).toBe(true)
    expect(hard.chunks.every((chunk) => chunk.length <= 4 && !/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(chunk))).toBe(true)
  })

  it('换行优先于句中空白并被保留', () => {
    const text = `${'a '.repeat(10)}end\n\nnext part here`
    const result = splitLongText(text, 30)
    expect(result.chunks[0]).toBe(`${'a '.repeat(10)}end`)
    expect(result.separators[0]).toBe('\n\n')
  })

  it.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('非法分段上限 %s 不进入循环', (limit) => {
    expect(() => splitLongText('a😀long text', limit)).toThrow(RangeError)
  })
})

describe('joinTranslatedChunks', () => {
  it('中文相邻去掉单词间空格，换行保留，西文之间保留原分隔', () => {
    expect(joinTranslatedChunks([], [], 'zh-CN')).toBe('')
    expect(joinTranslatedChunks(['第一句。', '第二句。'], [' '], 'zh-CN')).toBe('第一句。第二句。')
    expect(joinTranslatedChunks(['第一段。', '第二段。'], ['\n\n'], 'zh-CN')).toBe('第一段。\n\n第二段。')
    expect(joinTranslatedChunks(['Kubernetes', 'pod'], [' '], 'zh-CN')).toBe('Kubernetes pod')
    expect(joinTranslatedChunks(['集群', '节点'], [' '], 'zh-CN')).toBe('集群节点')
    expect(joinTranslatedChunks(['클러스터', '노드'], [' '], 'ko')).toBe('클러스터 노드')
    expect(joinTranslatedChunks(['Settings', 'page'], [' '], 'en')).toBe('Settings page')
    expect(joinTranslatedChunks(['只有一段'], [], 'zh-CN')).toBe('只有一段')
  })
})

describe('isModelCandidateText 目标语言', () => {
  it('ja 目标：含假名跳过、纯汉字仍是候选', () => {
    expect(isModelCandidateText('こんにちは', 'ja')).toBe(false)
    expect(isModelCandidateText('设置页面', 'ja')).toBe(true)
    expect(isModelCandidateText('設定', 'ja')).toBe(true)
  })
  it('en 目标：纯 ASCII 跳过、含非 ASCII 字母仍是候选', () => {
    expect(isModelCandidateText('Einstellungen', 'en')).toBe(false)
    expect(isModelCandidateText('Paramètres', 'en')).toBe(true)
    expect(isModelCandidateText('设置', 'en')).toBe(true)
  })
  it('ko 目标：谚文跳过', () => {
    expect(isModelCandidateText('설정', 'ko')).toBe(false)
    expect(isModelCandidateText('Settings', 'ko')).toBe(true)
  })
  it('非字母文本不是候选', () => {
    expect(isModelCandidateText('123 456', 'en')).toBe(false)
    expect(isModelCandidateText('123', 'zh-CN')).toBe(false)
  })
})

describe('isModelCandidateText 显式源语言', () => {
  it('中到英、日到中、简到繁可以入队，源与目标相同不入队，URL 仍拒绝', () => {
    expect(isModelCandidateText('部署失败', 'en', 'zh-CN')).toBe(true)
    expect(isModelCandidateText('デプロイに失敗しました', 'zh-CN', 'ja')).toBe(true)
    expect(isModelCandidateText('设定页面', 'zh-TW', 'zh-CN')).toBe(true)
    expect(isModelCandidateText('Settings page', 'en', 'en')).toBe(false)
    expect(isModelCandidateText('部署失败', 'zh-CN', 'zh-CN')).toBe(false)
    expect(isModelCandidateText('https://example.com/a/b', 'en', 'zh-CN')).toBe(false)
  })
})
