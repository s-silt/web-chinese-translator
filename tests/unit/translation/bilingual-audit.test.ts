import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { translateTexts } from '../../../src/translation/provider'
import { CompletionCancelledError } from '../../../src/translation/transport'
import type { TranslationModelConfig } from '../../../src/translation/config'
import type { TranslationContext } from '../../../src/translation/reading-context'

const MOCK_CONFIG: TranslationModelConfig = {
  baseUrl: 'https://api.example.com/v1',
  model: 'mock-model',
  targetLanguage: 'zh-CN',
  sourceLanguage: 'auto',
}

function readDict(name: string): Record<string, string> {
  const file = resolve(import.meta.dirname, `../../../public/dictionaries/zh-CN/${name}.json`)
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
}

describe('双语场景样例核验（词库逐条核对 + 本地 Mock 上下文与请求校验）', () => {
  it('内置词库：常用界面词条 Settings / Cancel / Apply 符合界面语境', () => {
    const common = readDict('common')
    const devin = readDict('devin')
    const merged = { ...common, ...devin }
    expect(merged['Settings']).toBe('设置')
    expect(merged['Cancel']).toBe('取消')
    expect(merged['Apply']).toBe('应用')
  })

  it('语境区分：设置面板中的 Apply 与招聘页中的 Apply 各自携带不同 currentPage 上下文发送', async () => {
    const captured: Array<{ texts: string[]; currentPage: TranslationContext['currentPage'] }> = []
    const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      const userMsg = JSON.parse(body.messages[1]!.content) as (typeof captured)[number]
      captured.push(userMsg)
      const isJobs = userMsg.currentPage?.title?.includes('Careers') === true
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify([isJobs ? '申请职位' : '应用']) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const settingsCtx: TranslationContext = {
      currentPage: { site: 'app.example.com', title: 'Workspace Settings', heading: 'Display Preferences' },
      recentPages: [],
    }
    const jobsCtx: TranslationContext = {
      currentPage: { site: 'jobs.example.com', title: 'Careers - Senior Frontend Engineer', heading: 'Apply for this role' },
      recentPages: [],
    }

    const [settingsOut] = await translateTexts(MOCK_CONFIG, ['Apply'], 'sk-test', mockFetch, undefined, settingsCtx)
    const [jobsOut] = await translateTexts(MOCK_CONFIG, ['Apply'], 'sk-test', mockFetch, undefined, jobsCtx)

    expect(settingsOut).toBe('应用')
    expect(jobsOut).toBe('申请职位')
    expect(captured).toEqual([
      { texts: ['Apply'], ...settingsCtx },
      { texts: ['Apply'], ...jobsCtx },
    ])
  })

  it('输入翻译发送原文中的 Markdown 和换行，并指定源语言与目标语言', async () => {
    const source = '第一行\n第二行含 `code`'
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(['Line 1\nLine 2 with `code`']) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const inputConfig: TranslationModelConfig = {
      ...MOCK_CONFIG,
      targetLanguage: 'en',
      sourceLanguage: 'zh-CN',
    }
    const [translated] = await translateTexts(inputConfig, [source], 'sk-test', mockFetch)
    const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as { messages: { content: string }[] }
    expect(JSON.parse(body.messages[1]!.content)).toEqual([source])
    expect(body.messages[0]!.content).toContain('English')
    expect(body.messages[0]!.content).toContain('Simplified Chinese')
    expect(translated).toBe('Line 1\nLine 2 with `code`')
  })

  it('中止进行中的输入翻译会取消对应请求', async () => {
    const controller = new AbortController()
    const pendingFetch: typeof fetch = vi.fn((_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('Missing request signal')
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const pending = translateTexts(MOCK_CONFIG, ['Sample draft.'], '', pendingFetch, controller.signal)
    expect(pendingFetch).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(CompletionCancelledError)
  })
})
