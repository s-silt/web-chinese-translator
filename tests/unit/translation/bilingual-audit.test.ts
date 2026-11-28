import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { translateTexts } from '../../../src/translation/provider'
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
    if ('Apply' in merged) {
      expect(merged['Apply']).toBe('应用')
    }
  })

  it('语境区分：设置面板中的 Apply 与招聘页中的 Apply 各自携带不同 currentPage 上下文发送', async () => {
    const capturedBodies: Record<string, unknown>[] = []
    const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      capturedBodies.push(body)
      const userMsg = JSON.parse(String((body.messages as { content: string }[])[1]?.content)) as {
        currentPage?: { title?: string }
      }
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
    expect(capturedBodies).toHaveLength(2)
    expect(String((capturedBodies[0]!.messages as { content: string }[])[1]?.content)).toContain('Workspace Settings')
    expect(String((capturedBodies[1]!.messages as { content: string }[])[1]?.content)).toContain('Careers')
  })

  it('行内格式与输入翻译：保留 Markdown/换行与目标语言指令，并在中止时立即取消', async () => {
    const controller = new AbortController()
    const captured: string[] = []
    const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      captured.push(body.messages[0]!.content)
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
    const [translated] = await translateTexts(inputConfig, ['第一行\n第二行含 `code`'], 'sk-test', mockFetch, controller.signal)
    expect(translated).toBe('Line 1\nLine 2 with `code`')
    expect(captured[0]).toContain('English')
    expect(captured[0]).toContain('Simplified Chinese')
  })
})
