import { normalizeBaseUrl } from './config'
import { normalizeCustomHeaders } from './request-options'

const SECRETS_DB = 'web-translator-secrets'
const SECRETS_STORE = 'secrets'
const API_KEY_RECORD = 'apiKey'
const CUSTOM_HEADERS_RECORD = 'customHeaders'
const DB_VERSION = 1
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function unavailable(): Error {
  return new Error('IndexedDB 不可用')
}

function indexedDbFactory(): IDBFactory | null {
  if (typeof indexedDB === 'undefined' || indexedDB === null) return null
  return indexedDB
}

function openSecrets(): Promise<IDBDatabase> {
  const factory = indexedDbFactory()
  if (factory === null) return Promise.reject(unavailable())
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : unavailable())
    }
    let request: IDBOpenDBRequest
    try {
      request = factory.open(SECRETS_DB, DB_VERSION)
    } catch (error) {
      fail(error)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SECRETS_STORE)) db.createObjectStore(SECRETS_STORE)
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      fail(request.error ?? unavailable())
    }
    request.onblocked = () => {
      fail(unavailable())
    }
  })
}

function waitTransaction<T>(db: IDBDatabase, transaction: IDBTransaction, read: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      db.close()
      settle()
    }
    transaction.oncomplete = () => {
      try {
        const value = read()
        finish(() => {
          resolve(value)
        })
      } catch (error) {
        finish(() => {
          reject(error instanceof Error ? error : unavailable())
        })
      }
    }
    transaction.onerror = (event) => {
      event.preventDefault()
      finish(() => {
        reject(transaction.error ?? unavailable())
      })
    }
    transaction.onabort = () => {
      finish(() => {
        reject(transaction.error ?? unavailable())
      })
    }
  })
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  return openSecrets().then((db) => {
    try {
      const transaction = db.transaction(SECRETS_STORE, mode)
      const read = run(transaction.objectStore(SECRETS_STORE))
      return waitTransaction(db, transaction, read)
    } catch (error) {
      db.close()
      return Promise.reject(error instanceof Error ? error : unavailable())
    }
  })
}

export interface BoundApiKey {
  readonly key: string
  readonly origin: string
}

export type StoredApiKey = BoundApiKey | string | undefined

export function readStoredApiKey(): Promise<StoredApiKey> {
  return withStore('readonly', (store) => {
    const request = store.get(API_KEY_RECORD)
    return () => {
      const value: unknown = request.result
      if (value === undefined || value === '') return undefined
      if (typeof value === 'string') return value
      if (
        typeof value === 'object' &&
        value !== null &&
        'key' in value &&
        typeof (value as BoundApiKey).key === 'string' &&
        (value as BoundApiKey).key !== '' &&
        'origin' in value &&
        typeof (value as BoundApiKey).origin === 'string' &&
        (value as BoundApiKey).origin !== ''
      ) {
        return { key: (value as BoundApiKey).key, origin: (value as BoundApiKey).origin }
      }
      throw new Error('无法读取已保存的密钥')
    }
  })
}

export function writeStoredApiKey(value: StoredApiKey): Promise<void> {
  return withStore<void>('readwrite', (store) => {
    if (value === undefined) store.delete(API_KEY_RECORD)
    else store.put(value, API_KEY_RECORD)
    return () => undefined
  })
}

export function credentialOrigin(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  return normalized === '' ? '' : new URL(normalized).origin
}

export interface BoundCustomHeaders {
  readonly headers: Readonly<Record<string, string>>
  readonly origin: string
  readonly revision: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function readStoredCustomHeaders(): Promise<BoundCustomHeaders | undefined> {
  return withStore('readonly', (store) => {
    const request = store.get(CUSTOM_HEADERS_RECORD)
    return () => {
      const value: unknown = request.result
      if (value === undefined) return undefined
      if (
        !isPlainRecord(value) ||
        typeof value.origin !== 'string' ||
        value.origin === '' ||
        typeof value.revision !== 'string' ||
        !UUID_PATTERN.test(value.revision) ||
        !isPlainRecord(value.headers)
      ) {
        throw new Error('无法读取已保存的请求头')
      }
      const rawHeaders = value.headers
      const headers = normalizeCustomHeaders(rawHeaders)
      const rawKeys = Object.keys(rawHeaders)
      const normalizedKeys = Object.keys(headers)
      if (
        normalizedKeys.length === 0 ||
        rawKeys.length !== normalizedKeys.length ||
        !normalizedKeys.every((key, index) => rawKeys[index] === key && rawHeaders[key] === headers[key])
      ) {
        throw new Error('无法读取已保存的请求头')
      }
      return { headers, origin: value.origin, revision: value.revision }
    }
  })
}

export function writeStoredCustomHeaders(value: BoundCustomHeaders | undefined): Promise<void> {
  return withStore<void>('readwrite', (store) => {
    if (value === undefined) store.delete(CUSTOM_HEADERS_RECORD)
    else store.put(value, CUSTOM_HEADERS_RECORD)
    return () => undefined
  })
}

export async function readCustomHeaders(baseUrl: string, revision: string): Promise<Readonly<Record<string, string>>> {
  if (revision === '') return {}
  const stored = await readStoredCustomHeaders()
  const origin = credentialOrigin(baseUrl)
  if (stored === undefined || stored.revision !== revision || origin === '' || stored.origin !== origin) {
    throw new Error('自定义请求头与当前接口不匹配，请重新填写或清空')
  }
  return stored.headers
}

export function validateApiKey(value: string): string {
  const key = value.trim()
  if (key.length < 1 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('API Key 须为 1–512 个可打印英文字符，不能包含空格')
  }
  return key
}

export async function readApiKey(baseUrl: string): Promise<string> {
  const value = await readStoredApiKey()
  if (value === undefined) return ''
  if (typeof value === 'string') throw new Error('旧版密钥需要重新输入后使用')
  if (value.origin !== credentialOrigin(baseUrl)) {
    throw new Error('接口来源已改变，请重新输入或删除旧密钥')
  }
  return value.key
}

export function writeApiKey(value: string, baseUrl: string): Promise<void> {
  const origin = credentialOrigin(baseUrl)
  if (origin === '') return Promise.reject(new Error('请先配置接口地址'))
  return writeStoredApiKey({ key: validateApiKey(value), origin })
}

export function clearApiKey(): Promise<void> {
  return writeStoredApiKey(undefined)
}
