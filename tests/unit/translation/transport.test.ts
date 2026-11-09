import { describe, expect, it } from 'vitest'
import { unwrapFence } from '../../../src/translation/transport'

describe('unwrapFence', () => {
  it('剥掉 ``` 与 ```json 围栏，返回内部 JSON', () => {
    expect(unwrapFence('```json\n["你好"]\n```')).toBe('["你好"]')
    expect(unwrapFence('```\n{"a":1}\n```')).toBe('{"a":1}')
    expect(unwrapFence('  ```json\n[1]\n```  ')).toBe('[1]')
    expect(unwrapFence('```json   \n[1]\n```')).toBe('[1]')
    expect(unwrapFence('```\r\n[1]\r\n```')).toBe('[1]')
  })

  it('非围栏、非 json 标签、未闭合围栏原样返回', () => {
    expect(unwrapFence('plain text')).toBe('plain text')
    expect(unwrapFence('```rust\ncode\n```')).toBe('```rust\ncode\n```')
    expect(unwrapFence('```JSON\n[1]\n```')).toBe('```JSON\n[1]\n```')
    expect(unwrapFence('```\n[1]\n``')).toBe('```\n[1]\n``')
    expect(unwrapFence('```')).toBe('```')
    expect(unwrapFence('``````')).toBe('``````')
  })

  it('围栏内含空行与反引号仍按首尾围栏剥离', () => {
    expect(unwrapFence('```\n\n\n[1]\n\n\n```')).toBe('[1]')
    expect(unwrapFence('```\nuse `code` here\n```')).toBe('use `code` here')
    expect(unwrapFence('```\n```inner```\n```')).toBe('```inner```')
  })

  it('未闭合围栏后跟超长空白不回溯（ReDoS 回归）', () => {
    const hostile = '```\n' + '\n'.repeat(500_000) + 'x'
    const started = performance.now()
    expect(unwrapFence(hostile)).toBe(hostile)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('闭合围栏内超长空白也保持线性耗时', () => {
    const fenced = '```\n' + '\n'.repeat(200_000) + '```'
    const started = performance.now()
    expect(unwrapFence(fenced)).toBe('')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('开头围栏行的超长空白同样线性耗时', () => {
    const hostile = '```' + ' '.repeat(500_000) + '\n```'
    const started = performance.now()
    expect(unwrapFence(hostile)).toBe('')
    expect(performance.now() - started).toBeLessThan(500)
  })
})
