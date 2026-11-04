import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearApiKey,
  credentialOrigin,
  readApiKey,
  readCustomHeaders,
  readStoredApiKey,
  readStoredCustomHeaders,
  validateApiKey,
  writeApiKey,
  writeStoredApiKey,
  writeStoredCustomHeaders,
} from '../../../src/translation/secrets'

const DB = 'web-translator-secrets'

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

const ORIGIN_A = 'https://api-a.example.com/v1'
const ORIGIN_B = 'https://api-b.example.com/v1'

beforeEach(deleteDb)

describe('密钥存储', () => {
  it('写入/读取/覆盖/删除绑定密钥', async () => {
    expect(await readStoredApiKey()).toBeUndefined()
    await writeApiKey('sk-one', ORIGIN_A)
    expect(await readStoredApiKey()).toEqual({ key: 'sk-one', origin: credentialOrigin(ORIGIN_A) })
    await writeApiKey('sk-two', ORIGIN_A)
    expect(await readApiKey(ORIGIN_A)).toBe('sk-two')
    await clearApiKey()
    expect(await readStoredApiKey()).toBeUndefined()
  })

  it('不同 origin 拒绝读取；同 origin 路径变更保留', async () => {
    await writeApiKey('sk-a', ORIGIN_A)
    await expect(readApiKey(ORIGIN_B)).rejects.toThrow('接口来源已改变')
    expect(await readApiKey('https://api-a.example.com/v2/path')).toBe('sk-a')
  })

  it('旧版字符串记录读取时报错，不静默发送', async () => {
    await writeStoredApiKey('sk-legacy')
    await expect(readApiKey(ORIGIN_A)).rejects.toThrow('旧版密钥')
    await expect(readApiKey(ORIGIN_B)).rejects.toThrow('旧版密钥')
  })

  it('validateApiKey 拒绝空白、空格与超长', () => {
    expect(() => validateApiKey('')).toThrow()
    expect(() => validateApiKey('has space')).toThrow()
    expect(() => validateApiKey('x'.repeat(513))).toThrow()
    expect(validateApiKey('  sk-ok  ')).toBe('sk-ok')
  })

  it('空接口写入拒绝', async () => {
    await expect(writeApiKey('sk-x', '')).rejects.toThrow('请先配置接口地址')
    expect(await readStoredApiKey()).toBeUndefined()
  })
})

describe('自定义请求头存储', () => {
  const REV_1 = '11111111-1111-4111-8111-111111111111'
  const REV_2 = '22222222-2222-4222-8222-222222222222'

  it('写入、读取、同源不同路径复用、不同来源或修订号拒绝，空修订号直接返回空对象，删除返回 undefined', async () => {
    expect(await readStoredCustomHeaders()).toBeUndefined()
    await writeStoredCustomHeaders({
      headers: { 'x-api-key': 'secret-header' },
      origin: credentialOrigin(ORIGIN_A),
      revision: REV_1,
    })
    expect(await readStoredCustomHeaders()).toEqual({
      headers: { 'x-api-key': 'secret-header' },
      origin: 'https://api-a.example.com',
      revision: REV_1,
    })
    expect(await readCustomHeaders(ORIGIN_A, REV_1)).toEqual({ 'x-api-key': 'secret-header' })
    expect(await readCustomHeaders('https://api-a.example.com/v2/responses', REV_1)).toEqual({
      'x-api-key': 'secret-header',
    })
    await expect(readCustomHeaders(ORIGIN_B, REV_1)).rejects.toThrow('自定义请求头与当前接口不匹配')
    await expect(readCustomHeaders(ORIGIN_A, REV_2)).rejects.toThrow('自定义请求头与当前接口不匹配')
    expect(await readCustomHeaders(ORIGIN_A, '')).toEqual({})

    await writeStoredCustomHeaders(undefined)
    expect(await readStoredCustomHeaders()).toBeUndefined()
    await expect(readCustomHeaders(ORIGIN_A, REV_1)).rejects.toThrow('自定义请求头与当前接口不匹配')
  })
})
