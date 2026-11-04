import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  afterModelMutations,
  currentRevision,
  invalidateModelState,
  modelSnapshot,
  serializeMutation,
} from '../../../src/translation/model-state'
import { translationConfigItem, DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'

let apiKeyStore: { key: string; origin: string } | undefined
let customHeadersStore:
  | { headers: Readonly<Record<string, string>>; origin: string; revision: string }
  | undefined
vi.mock('../../../src/translation/secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/translation/secrets')>()
  return {
    ...actual,
    readApiKey: vi.fn(async (baseUrl: string) => {
      if (apiKeyStore === undefined) return ''
      if (apiKeyStore.origin !== actual.credentialOrigin(baseUrl)) throw new Error('接口来源已改变')
      return apiKeyStore.key
    }),
    readCustomHeaders: vi.fn(async (baseUrl: string, revision: string) => {
      if (revision === '') return {}
      if (
        customHeadersStore === undefined ||
        customHeadersStore.revision !== revision ||
        customHeadersStore.origin !== actual.credentialOrigin(baseUrl)
      ) {
        throw new Error('自定义请求头与当前接口不匹配')
      }
      return customHeadersStore.headers
    }),
  }
})

const CONFIG = { ...DEFAULT_TRANSLATION_CONFIG, baseUrl: 'https://api.example.com/v1', model: 'm' }

beforeEach(() => {
  fakeBrowser.reset()
  apiKeyStore = { key: 'sk-a', origin: 'https://api.example.com' }
  customHeadersStore = undefined
})

describe('modelSnapshot 一致性', () => {
  it('快照读到匹配的 config+key 对', async () => {
    await translationConfigItem.setValue(CONFIG)
    const snap = await modelSnapshot()
    expect(snap.config.baseUrl).toBe(CONFIG.baseUrl)
    expect(snap.apiKey).toBe('sk-a')
    expect(snap.revision).toBe(currentRevision())
  })

  it('旧快照在并发保存后 revision 过期', async () => {
    await translationConfigItem.setValue(CONFIG)
    const before = await modelSnapshot()
    await serializeMutation(async () => {
      await translationConfigItem.setValue({ ...CONFIG, model: 'm2' })
      apiKeyStore = { key: 'sk-b', origin: 'https://api.example.com' }
    }, () => undefined)
    const after = await modelSnapshot()
    expect(before.revision).not.toBe(after.revision)
    expect(after.apiKey).toBe('sk-b')
    expect(after.config.model).toBe('m2')
  })

  it('串行变更期间启动的快照等到一致尾后返回', async () => {
    await translationConfigItem.setValue(CONFIG)
    const slow = serializeMutation(async () => {
      await new Promise((r) => setTimeout(r, 30))
      apiKeyStore = { key: 'sk-c', origin: 'https://api.example.com' }
    }, () => undefined)
    const snap = await modelSnapshot()
    await slow
    expect(snap.apiKey).toBe('sk-c')
    expect(snap.revision).toBe(currentRevision())
  })

  it('afterModelMutations 等待全部变更完成', async () => {
    let done = false
    const task = serializeMutation(async () => {
      await new Promise((r) => setTimeout(r, 30))
      done = true
    }, () => undefined)
    await afterModelMutations()
    await task
    expect(done).toBe(true)
  })

  it('不传 invalidate 的变更仍然串行，但不让旧快照失效', async () => {
    await translationConfigItem.setValue(CONFIG)
    const before = await modelSnapshot()
    const slow = serializeMutation(async () => {
      await new Promise((r) => setTimeout(r, 30))
      apiKeyStore = { key: 'sk-d', origin: 'https://api.example.com' }
    })
    const during = await modelSnapshot()
    await slow
    expect(during.apiKey).toBe('sk-d')
    expect(during.revision).toBe(before.revision)
    expect(currentRevision()).toBe(before.revision)
  })

  it('invalidateModelState 使旧 revision 立即失效', async () => {
    await translationConfigItem.setValue(CONFIG)
    const snap = await modelSnapshot()
    invalidateModelState(() => undefined)
    expect(snap.revision).not.toBe(currentRevision())
  })

  it('无活动请求头修订号或空接口地址时不读取自定义请求头；串行变更保证配置修订号与私有请求头一致', async () => {
    const secrets = await import('../../../src/translation/secrets')
    const rev1 = '11111111-1111-4111-8111-111111111111'
    const rev2 = '22222222-2222-4222-8222-222222222222'
    vi.mocked(secrets.readCustomHeaders).mockClear()
    await translationConfigItem.setValue(CONFIG)
    const initial = await modelSnapshot()
    expect(initial.customHeaders).toEqual({})
    expect(secrets.readCustomHeaders).not.toHaveBeenCalled()

    await translationConfigItem.setValue({
      ...DEFAULT_TRANSLATION_CONFIG,
      baseUrl: '',
      model: '',
      customHeadersRevision: rev1,
    })
    const throwIfCalled = vi.mocked(secrets.readCustomHeaders).mockImplementationOnce(async () => {
      throw new Error('should not be called')
    })
    try {
      const emptyBaseSnap = await modelSnapshot()
      expect(emptyBaseSnap.apiKey).toBe('')
      expect(emptyBaseSnap.customHeaders).toEqual({})
      expect(throwIfCalled).not.toHaveBeenCalled()
    } finally {
      throwIfCalled.mockRestore()
    }

    customHeadersStore = {
      headers: { 'x-token': 'one' },
      origin: 'https://api.example.com',
      revision: rev1,
    }
    await translationConfigItem.setValue({ ...CONFIG, customHeadersRevision: rev1 })
    const slow = serializeMutation(async () => {
      customHeadersStore = {
        headers: { 'x-token': 'two' },
        origin: 'https://api.example.com',
        revision: rev2,
      }
      await new Promise((r) => setTimeout(r, 30))
      await translationConfigItem.setValue({ ...CONFIG, customHeadersRevision: rev2 })
    }, () => undefined)
    const after = await modelSnapshot()
    await slow
    expect(after.config.customHeadersRevision).toBe(rev2)
    expect(after.customHeaders).toEqual({ 'x-token': 'two' })
    expect(after.revision).toBe(currentRevision())
  })
})
