import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  parseDictionaryJson,
  parseEntryLines,
  sanitizeCustomDictionaries,
  serializeDictionary,
  serializeEntryLines,
} from '../../../src/translation/custom-dictionaries'

describe('sanitizeCustomDictionaries', () => {
  it('丢弃非法项、超限截断、非法 id 丢弃', () => {
    const result = sanitizeCustomDictionaries([
      { id: 'custom:abcd1234', label: 'Good', hosts: ['Example.COM', 'https://app.example.com/x'], entries: { A: '甲' }, enabled: true },
      { id: 'not-an-id', label: 'bad', hosts: ['x.com'], entries: { A: '甲' }, enabled: true },
      'garbage',
      { id: 'custom:dup1', label: 'x', hosts: ['bad host!'], entries: { '': '空' } },
      { id: 'custom:dup1', label: 'x', hosts: [], entries: {} },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'custom:abcd1234', enabled: true, hosts: ['example.com', 'app.example.com'], entries: { A: '甲' } })
    expect(result[1]).toMatchObject({ id: 'custom:dup1', hosts: [], entries: {} })
    const over = sanitizeCustomDictionaries(
      Array.from({ length: 25 }, (_, i) => ({ id: `custom:i${i.toString().padStart(4, '0')}`, label: 'x', hosts: [], entries: {} })),
    )
    expect(over).toHaveLength(LIMITS.dictionaries)
  })

  it('超长的键值对丢弃', () => {
    const result = sanitizeCustomDictionaries([
      { id: 'custom:a1b2c3', label: 'x', hosts: [], entries: { ['k'.repeat(300)]: 'v', ok: '好' }, enabled: false },
    ])
    expect(result[0]?.entries).toEqual({ ok: '好' })
  })
})

describe('parseEntryLines / serializeEntryLines', () => {
  it('支持 `原文 = 译文` 与 `原文<TAB>译文`，空行忽略、非法行进 invalid', () => {
    const { entries, invalid } = parseEntryLines('Settings = 设置\nCancel\t取消\n\n= bad\nNoValue =\nbroken line')
    expect(entries).toEqual({ Settings: '设置', Cancel: '取消' })
    expect(invalid).toHaveLength(3)
  })

  it('序列化往返一致', () => {
    const entries = { Settings: '设置', Cancel: '取消' }
    expect(parseEntryLines(serializeEntryLines(entries)).entries).toEqual(entries)
  })
})

describe('parseDictionaryJson / serializeDictionary', () => {
  it('接受完整形状与纯词条对象', () => {
    const full = parseDictionaryJson('{"label":"My","hosts":["example.com"],"entries":{"A":"甲"},"enabled":true}')
    expect(full).toMatchObject({ label: 'My', hosts: ['example.com'], entries: { A: '甲' }, enabled: true })
    const bare = parseDictionaryJson('{"A":"甲"}')
    expect(bare).toMatchObject({ label: '', hosts: [], entries: { A: '甲' } })
    expect(parseDictionaryJson('[]')).toBeUndefined()
    expect(parseDictionaryJson('{"a":1}')).toBeUndefined()
  })

  it('导出的 JSON 可重新解析', () => {
    const d = { id: 'custom:a1b2c3', label: 'My', hosts: ['example.com'], entries: { A: '甲' }, enabled: true }
    expect(parseDictionaryJson(serializeDictionary(d))).toMatchObject({ label: 'My', entries: { A: '甲' }, enabled: true })
  })

  it('拒绝单标签主机与公共后缀，保留具体站点', () => {
    const draft = parseDictionaryJson(
      '{"hosts":["com","co.uk","github.io","localhost","com.vn","CO.UK.","https://com/",' +
        '"example.com","app.example.com","example.co.uk","user.github.io","a.co.uk"],"entries":{"a":"b"}}',
    )
    expect(draft?.hosts).toEqual(['example.com', 'app.example.com', 'example.co.uk', 'user.github.io', 'a.co.uk'])
    const stored = sanitizeCustomDictionaries([
      { id: 'custom:a1b2c3', label: 'x', hosts: ['com', 'co.uk', 'com.vn', 'example.com'], entries: { a: 'b' }, enabled: true },
    ])
    expect(stored[0]?.hosts).toEqual(['example.com'])
  })
})
