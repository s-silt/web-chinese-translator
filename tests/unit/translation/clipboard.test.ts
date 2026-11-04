import { afterEach, describe, expect, it, vi } from 'vitest'
import { copySelectionText } from '../../../src/translation/clipboard'

const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (execCommandDescriptor === undefined) Reflect.deleteProperty(document, 'execCommand')
  else Object.defineProperty(document, 'execCommand', execCommandDescriptor)
})

describe('copySelectionText', () => {
  it('优先使用 clipboard.writeText', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copySelectionText('copied text')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('copied text')
  })

  it('writeText 失败时用 copy 事件写入剪贴板', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied')
        }),
      },
    })
    const seen: string[] = []
    const exec = vi.fn((command: string) => {
      if (command !== 'copy') return false
      const event = new Event('copy')
      Object.defineProperty(event, 'clipboardData', {
        value: {
          setData: (type: string, value: string) => {
            seen.push(`${type}:${value}`)
          },
        },
      })
      document.dispatchEvent(event)
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    await expect(copySelectionText('plain text')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    expect(seen).toEqual(['text/plain:plain text'])
  })

  it('execCommand 返回 true 却不派 copy 事件时失败', async () => {
    vi.stubGlobal('navigator', {})
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true })
    await expect(copySelectionText('missing event')).resolves.toBe(false)
  })

  it('clipboardData 为 null 时失败且不 preventDefault', async () => {
    vi.stubGlobal('navigator', {})
    const event = new ClipboardEvent('copy')
    Object.defineProperty(event, 'clipboardData', { configurable: true, value: null })
    const prevent = vi.spyOn(event, 'preventDefault')
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        document.dispatchEvent(event)
        return true
      },
    })
    await expect(copySelectionText('empty data')).resolves.toBe(false)
    expect(prevent).not.toHaveBeenCalled()
  })

  it.each([
    ['返回 false', () => false],
    ['抛出', () => {
      throw new Error('blocked')
    }],
  ])('execCommand %s 时失败', async (_name, run) => {
    vi.stubGlobal('navigator', {})
    Object.defineProperty(document, 'execCommand', { configurable: true, value: run })
    await expect(copySelectionText('rejected')).resolves.toBe(false)
  })

  it('成功写入后移除 copy 监听', async () => {
    vi.stubGlobal('navigator', {})
    const setData = vi.fn()
    const dispatchCopy = (): void => {
      const event = new ClipboardEvent('copy')
      Object.defineProperty(event, 'clipboardData', { configurable: true, value: { setData } })
      document.dispatchEvent(event)
    }
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        dispatchCopy()
        return true
      },
    })
    await expect(copySelectionText('kept')).resolves.toBe(true)
    expect(setData).toHaveBeenCalledTimes(1)
    expect(setData).toHaveBeenCalledWith('text/plain', 'kept')
    dispatchCopy()
    expect(setData).toHaveBeenCalledTimes(1)
  })
})
