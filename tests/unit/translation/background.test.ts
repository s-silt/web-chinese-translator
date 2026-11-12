import { customDictionariesItem } from '../../../src/translation/custom-dictionaries'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import type { Browser } from 'wxt/browser'
import { installTranslationBackground } from '../../../src/translation/background'
import { replaceChatDraftInMainWorld } from '../../../src/translation/chat-input'
import { replaceDiscordDraftInMainWorld } from '../../../src/translation/discord-input'
import {
  isContentTranslationMessage,
  isTranslationMessage,
  isTranslationReply,
  NO_SELECTION_ERROR,
  NOTHING_TO_TOGGLE_ERROR,
  SENSITIVE_FRAME_ERROR,
  TRANSLATION_CONFIG_CHANGED_ERROR,
  TRANSLATION_PERMISSION_REMOVED_ERROR,
} from '../../../src/translation/messages'
import {
  AutomaticPausedError,
  automaticPauseRemainingMs,
  clearAutomaticPause,
  describeFailure,
  pauseAutomaticTasks,
  scheduleModelTask,
} from '../../../src/translation/scheduler'
import { translationConfigItem, DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import { requestOptionsKey } from '../../../src/translation/request-options'
import { settingsItem, DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { fakeContentScripts } from '../shared/fake-scripting'
import {
  clearPersistentTranslations,
  readPersistentTranslations,
  writePersistentTranslations,
} from '../../../src/translation/persistent-cache'
import { writeApiKey } from '../../../src/translation/secrets'
import { mergeFixedEntries } from '../../../src/translation/dictionaries/entries'
import { BUILTIN_DICTIONARY_META } from '../../../src/translation/dictionaries/index'
import { SITE_SCOPE_BLOCKED_ERROR, SITE_SCOPE_INVALID_ERROR, SITE_SCOPE_LIMIT_ERROR } from '../../../src/translation/site-scope'
import {
  clearManualPages, getManualPageGrant, putManualPageGrant, revokeManualPageGrant,
} from '../../../src/translation/manual-page'
import { readFileSync } from 'node:fs'

/** entries 模块：保留真实 mergeFixedEntries，默认 loader 改为读本地 JSON 资源（不经网络）。 */
vi.mock('../../../src/translation/dictionaries/entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/translation/dictionaries/entries')>()
  const readLocal = async (id: string, language: string) => {
    const raw = readFileSync(`public/dictionaries/${language}/${id}.json`, 'utf8')
    return Object.freeze(JSON.parse(raw) as Record<string, string>)
  }
  const localLoader = actual.createBuiltinLoader(readLocal)
  type Merge = typeof actual.mergeFixedEntries
  return {
    ...actual,
    builtinTranslations: localLoader,
    mergeFixedEntries: vi.fn(
      (...[ids, custom, language, load = localLoader]: Parameters<Merge>) =>
        actual.mergeFixedEntries(ids, custom, language, load),
    ),
  }
})

let apiKeyStore: { key: string; origin: string } | undefined = { key: 'sk-live', origin: 'https://api.example.com' }
let customHeadersStore:
  | { headers: Readonly<Record<string, string>>; origin: string; revision: string }
  | undefined
vi.mock('../../../src/translation/secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/translation/secrets')>()
  return {
    ...actual,
    readStoredApiKey: vi.fn(async () => apiKeyStore),
    writeStoredApiKey: vi.fn(async (value: unknown) => {
      apiKeyStore = value as never
    }),
    writeApiKey: vi.fn(async (value: string, baseUrl: string) => {
      const origin = actual.credentialOrigin(baseUrl)
      if (origin === '') return actual.writeApiKey(value, baseUrl)
      apiKeyStore = { key: actual.validateApiKey(value), origin }
    }),
    clearApiKey: vi.fn(async () => {
      apiKeyStore = undefined
    }),
    readApiKey: vi.fn(async (baseUrl: string) => {
      if (apiKeyStore === undefined) return ''
      if (typeof apiKeyStore === 'string') throw new Error('旧版密钥需要重新输入后使用')
      if (apiKeyStore.origin !== actual.credentialOrigin(baseUrl)) {
        throw new Error('接口来源已改变，请重新输入或删除旧密钥')
      }
      return apiKeyStore.key
    }),
    readStoredCustomHeaders: vi.fn(async () => customHeadersStore),
    writeStoredCustomHeaders: vi.fn(async (value: unknown) => {
      customHeadersStore = value as never
    }),
    readCustomHeaders: vi.fn(async (baseUrl: string, revision: string) => {
      if (revision === '') return {}
      const origin = actual.credentialOrigin(baseUrl)
      if (
        customHeadersStore === undefined ||
        customHeadersStore.revision !== revision ||
        origin === '' ||
        customHeadersStore.origin !== origin
      ) {
        throw new Error('自定义请求头与当前接口不匹配，请重新填写或清空')
      }
      return customHeadersStore.headers
    }),
  }
})

vi.mock('../../../src/translation/persistent-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/translation/persistent-cache')>()
  return {
    ...actual,
    clearPersistentTranslations: vi.fn(actual.clearPersistentTranslations),
    readPersistentTranslations: vi.fn(actual.readPersistentTranslations),
    writePersistentTranslations: vi.fn(actual.writePersistentTranslations),
  }
})

const extSender = { id: '', url: '' }
const contentSender = { id: '', tab: { id: 7 }, frameId: 0, documentId: 'doc-top', url: 'https://app.devin.ai/work' }
const pageSender = { id: 'other-extension', url: 'https://evil.example' }
const removedListeners: Array<(permissions: unknown) => void> = []
let menuClick: Parameters<typeof fakeBrowser.contextMenus.onClicked.addListener>[0] | undefined
let commandTrigger: Parameters<typeof fakeBrowser.commands.onCommand.addListener>[0] | undefined
let tabUpdated: Parameters<typeof fakeBrowser.tabs.onUpdated.addListener>[0] | undefined
let portConnect: ((port: unknown) => void) | undefined

function trigger(message: unknown, sender: object): Promise<unknown> {
  return new Promise((resolve) => {
    void fakeBrowser.runtime.onMessage.trigger(message, sender, resolve)
  })
}

const VALID_CONFIG = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  autoOrigins: ['https://app.devin.ai'],
}

function completionReply(texts: readonly string[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts) } }] }), { status: 200 })
}

beforeEach(() => {
  fakeBrowser.reset()
  apiKeyStore = { key: 'sk-live', origin: 'https://api.example.com' }
  customHeadersStore = undefined
  extSender.id = fakeBrowser.runtime.id
  extSender.url = fakeBrowser.runtime.getURL('/options.html')
  contentSender.id = fakeBrowser.runtime.id
  fakeContentScripts()
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => true)
  vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
  removedListeners.length = 0
  vi.spyOn(fakeBrowser.permissions.onAdded, 'addListener').mockImplementation(() => undefined)
  vi.spyOn(fakeBrowser.permissions.onRemoved, 'addListener').mockImplementation((listener) => {
    removedListeners.push(listener as (permissions: unknown) => void)
  })
  // This fake browser has no context-menu event implementation. Capture the real registered callback.
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation((listener) => {
    menuClick = listener
  })
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation((listener) => {
    commandTrigger = listener
  })
  vi.spyOn(fakeBrowser.tabs.onUpdated, 'addListener').mockImplementation((listener) => {
    tabUpdated = listener
  })
  // The fake browser has no port implementation either.
  vi.spyOn(fakeBrowser.runtime.onConnect, 'addListener').mockImplementation((listener) => {
    portConnect = listener as (port: unknown) => void
  })
  vi.spyOn(fakeBrowser.alarms, 'create').mockResolvedValue()
  vi.spyOn(fakeBrowser.alarms, 'clear').mockImplementation(async () => true as never)
  installTranslationBackground()
})

describe('模型隐私边界真实消息入口', () => {
  it('保存自动弹窗偏好经真实消息入口持久化，不改连接、语言和其他开关', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    const original = { ...DEFAULT_TRANSLATION_CONFIG, baseUrl: 'https://api.example.com/v1', model: 'synthetic-model', targetLanguage: 'ja' as const, sourceLanguage: 'en' as const, temperature: 0.2, selectionPopupEnabled: true, proactiveAssistEnabled: true }
    await translationConfigItem.setValue(original)
    expect(await trigger({ type: 'wt:save-config', patch: { autoInteractionEnabled: false } }, extSender))
      .toMatchObject({ ok: true, config: { ...original, autoInteractionEnabled: false } })
    expect(await translationConfigItem.getValue()).toEqual({ ...original, autoInteractionEnabled: false })
    expect(await trigger({ type: 'wt:get-config' }, extSender)).toMatchObject({ ok: true, config: { autoInteractionEnabled: false } })
  })

  const text = 'A deliberately selected synthetic sentence about physics.'
  const sensitiveSender = { ...contentSender, url: 'https://app.devin.ai/#/settings/tokens' }
  const input = {
    text,
    context: 'PRIVATE_CONTEXT_MARKER',
    pageTitle: 'PRIVATE_TITLE_MARKER',
    site: 'app.devin.ai',
    trigger: 'selection',
    signals: { method: 'mouse', dwellMs: 1500, visits: 2 },
  }

  async function enableSmart(): Promise<void> {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({ ok: true }) as never)
    expect(await trigger({
      type: 'wt:save-config',
      patch: {
        baseUrl: VALID_CONFIG.baseUrl, model: VALID_CONFIG.model,
        selectionPopupEnabled: true, proactiveAssistEnabled: true,
      },
    }, extSender)).toMatchObject({ ok: true })
    expect(await trigger({
      type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true,
    }, extSender)).toMatchObject({ ok: true })
  }

  async function grant(url: string, selected = text, documentId = 'doc-top', menuText = selected): Promise<string> {
    expect(menuClick).toBeDefined()
    let manualSelectionId = ''
    let shownText = ''
    const execSpy = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { documentIds?: string[]; frameIds?: number[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) return []
      if (opts.target?.documentIds !== undefined) {
        return [{ frameId: 0, documentId, result: url }]
      }
      return [{
        frameId: 0,
        documentId,
        result: { url, focused: true, text: selected, frameFocused: false },
      }]
    }) as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (_tabId: number, message: unknown) => {
      const msg = message as { type?: string; text?: string; manualSelectionId?: string }
      if (msg.type === 'wt:show-selection' && typeof msg.manualSelectionId === 'string') {
        manualSelectionId = msg.manualSelectionId
        shownText = msg.text ?? ''
      }
      return { ok: true }
    }) as never)
    menuClick!(
      { menuItemId: 'wt-selection', selectionText: menuText, pageUrl: url, frameId: 0, editable: false },
      { id: contentSender.tab.id, url } as never,
    )
    await vi.waitFor(() => expect(manualSelectionId).not.toBe(''))
    expect(shownText).toBe(selected)
    execSpy.mockImplementation((async (opts: {
      target?: { documentIds?: string[]; frameIds?: number[] }
      files?: string[]
    }) => {
      if (opts.target?.documentIds !== undefined) {
        return [{ frameId: 0, documentId, result: url }]
      }
      throw new Error('Method not implemented')
    }) as never)
    return manualSelectionId
  }

  it('敏感页面阻止自动、普通划词、两种辅助和线索记录', async () => {
    await enableSmart()
    const sender = { ...sensitiveSender, id: contentSender.id }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({
      ok: true, modes: { fixed: true, auto: false, selection: false, smart: false },
    })
    for (const mode of ['auto', 'selection']) {
      expect(await trigger({ type: 'wt:translate', mode, texts: [text] }, sender)).toMatchObject({ ok: false })
    }
    for (const action of ['selection', 'revisit']) {
      expect(await trigger({
        type: 'wt:assist', requestId: `sensitive-${action}`, input: { ...input, trigger: action },
      }, sender)).toMatchObject({ ok: false })
    }
    expect(await trigger({
      type: 'wt:page-context', pageId: 'sensitive-page',
      page: { site: 'app.devin.ai', title: input.pageTitle, heading: input.context },
    }, sender)).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect((await fakeBrowser.storage.session.get('wtReadingContext')).wtReadingContext).toBeUndefined()
  })

  it('敏感页右键授权只允许准确选中文字，且不发送页面或近期语境', async () => {
    await enableSmart()
    const sender = { ...sensitiveSender, id: contentSender.id }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['手动译文']))
    expect(await trigger({
      type: 'wt:page-context', pageId: 'prior-page',
      page: { site: 'app.devin.ai', title: 'RECENT_PRIVATE_MARKER', heading: 'Previous topic' },
    }, contentSender)).toMatchObject({ ok: true })
    const manualSelectionId = await grant(sender.url)
    expect(await trigger({
      type: 'wt:translate', mode: 'selection', texts: ['A different selected sentence.'], manualSelectionId,
    }, sender)).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await trigger({
      type: 'wt:translate', mode: 'selection', texts: [text], manualSelectionId, pageId: 'sensitive-page',
      page: { site: 'app.devin.ai', title: input.pageTitle, heading: input.context },
    }, sender)).toMatchObject({ ok: true, texts: ['手动译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as { messages: { content: string }[] }
    expect(JSON.parse(body.messages[1]!.content)).toEqual({
      texts: [text], currentPage: { title: '', heading: '', site: '' }, recentPages: [],
    })
  })

  it('敏感页的文字不读写持久缓存，普通页面正常读写', async () => {
    await enableSmart()
    vi.mocked(readPersistentTranslations).mockClear()
    vi.mocked(writePersistentTranslations).mockClear()
    const sender = { ...sensitiveSender, id: contentSender.id }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    const manualSelectionId = await grant(sender.url)
    expect(await trigger({ type: 'wt:translate', mode: 'selection', texts: [text], manualSelectionId }, sender)).toMatchObject({ ok: true })
    expect(readPersistentTranslations).not.toHaveBeenCalled()
    expect(writePersistentTranslations).not.toHaveBeenCalled()
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['A public persistable sentence.'],
    }, contentSender)).toMatchObject({ ok: true })
    expect(readPersistentTranslations).toHaveBeenCalledTimes(1)
    expect(writePersistentTranslations).toHaveBeenCalledTimes(1)
  })

  it('过期右键授权不能发送敏感选区', async () => {
    await enableSmart()
    const sender = { ...sensitiveSender, id: contentSender.id }
    const manualSelectionId = await grant(sender.url, `${text} Expired.`)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16_000)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      expect(await trigger({
        type: 'wt:translate', mode: 'selection', texts: [`${text} Expired.`], manualSelectionId,
      }, sender)).toMatchObject({ ok: false })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })

  it('新鲜右键授权在慢响应超过 15s 后仍成功一次；释放后不可重放过期票据；慢请求期间源导航仍取消；未认领过期票据零请求', async () => {
    await enableSmart()
    const sender = { ...sensitiveSender, id: contentSender.id }
    const slowText = `${text} Slow leased.`
    const leasedTicket = await grant(sender.url, slowText)
    const baseNow = Date.now()
    let currentNow = baseNow
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => currentNow)
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let fetchStarted = false
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchStarted = true
      await fetchGate
      return completionReply(['慢响应译文'])
    })
    try {
      const slowPending = trigger({
        type: 'wt:translate', mode: 'selection', texts: [slowText], manualSelectionId: leasedTicket,
      }, sender)
      await vi.waitFor(() => expect(fetchStarted).toBe(true))
      expect(fetcher).toHaveBeenCalledTimes(1)
      currentNow = baseNow + 16_000
      releaseFetch()
      expect(await slowPending).toMatchObject({ ok: true, texts: ['慢响应译文'] })
      expect(fetcher).toHaveBeenCalledTimes(1)

      expect(await trigger({
        type: 'wt:translate', mode: 'selection', texts: [slowText], manualSelectionId: leasedTicket,
      }, sender)).toMatchObject({ ok: false, code: 'cancelled' })
      expect(fetcher).toHaveBeenCalledTimes(1)

      currentNow = baseNow
      const unclaimedText = `${text} Unclaimed expired.`
      const unclaimedTicket = await grant(sender.url, unclaimedText)
      currentNow = baseNow + 16_000
      expect(await trigger({
        type: 'wt:translate', mode: 'selection', texts: [unclaimedText], manualSelectionId: unclaimedTicket,
      }, sender)).toMatchObject({ ok: false, code: 'cancelled' })
      expect(fetcher).toHaveBeenCalledTimes(1)

      currentNow = baseNow
      const navText = `${text} Navigated while pending.`
      const navTicket = await grant(sender.url, navText)
      let liveUrl = sender.url
      vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
        target?: { documentIds?: string[] }
        files?: string[]
      }) => {
        if (opts.files !== undefined) return []
        if (opts.target?.documentIds !== undefined) {
          return [{ frameId: 0, documentId: 'doc-top', result: liveUrl }]
        }
        throw new Error('Method not implemented')
      }) as never)
      fetchStarted = false
      let releaseNavFetch!: () => void
      const navFetchGate = new Promise<void>((resolve) => {
        releaseNavFetch = resolve
      })
      fetcher.mockImplementationOnce(async () => {
        fetchStarted = true
        await navFetchGate
        return completionReply(['不应送达'])
      })
      const navPending = trigger({
        type: 'wt:translate', mode: 'selection', texts: [navText], manualSelectionId: navTicket,
      }, sender)
      await vi.waitFor(() => expect(fetchStarted).toBe(true))
      currentNow = baseNow + 16_000
      liveUrl = 'https://app.devin.ai/#/other'
      releaseNavFetch()
      expect(await navPending).toMatchObject({ ok: false, code: 'cancelled' })
      expect(await trigger({
        type: 'wt:translate', mode: 'selection', texts: [navText], manualSelectionId: navTicket,
      }, sender)).toMatchObject({ ok: false, code: 'cancelled' })
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('右键多行选区空白归一化比对并保留换行；tabs.onUpdated 仅在顶层地址变化时清票据', async () => {
    await enableSmart()
    expect(tabUpdated).toBeDefined()
    const multiline = 'First fixture line.\nSecond fixture line.'
    const collapsed = 'First fixture line. Second fixture line.'

    // 非空白不匹配不能建票据
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['多行译文']))
    const rejectedSent: unknown[] = []
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { documentIds?: string[]; frameIds?: number[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) return []
      return [{
        frameId: 0,
        documentId: 'doc-top',
        result: { url: contentSender.url, focused: true, text: multiline, frameFocused: false },
      }]
    }) as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (_tabId: number, message: unknown) => {
      rejectedSent.push(message)
      return { ok: true }
    }) as never)
    menuClick!(
      { menuItemId: 'wt-selection', selectionText: 'First fixture line. Different line.', pageUrl: contentSender.url, frameId: 0, editable: false },
      { id: contentSender.tab.id, url: contentSender.url } as never,
    )
    await vi.waitFor(() => expect(rejectedSent.length === 1).toBe(true))
    expect(rejectedSent).toEqual([{ type: 'wt:show-selection', text: '', error: NO_SELECTION_ERROR }])
    expect(rejectedSent[0]).not.toHaveProperty('manualSelectionId')
    expect(fetcher).not.toHaveBeenCalled()

    // 多行选区：menuText 空白折叠而 DOM snapshot 保留换行，建 ticket 且向 provider 发送原始多行
    const multilineTicket = await grant(contentSender.url, multiline, 'doc-top', collapsed)
    let releaseFirstFetch!: () => void
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve
    })
    let firstFetchStarted = false
    fetcher.mockImplementation(async () => {
      firstFetchStarted = true
      await firstFetchGate
      return completionReply(['多行译文'])
    })

    // 回归 1：pending 新鲜 manual top selection；fire { status: 'loading' }（同 URL/docId），release fetch → ok
    const pendingOk = trigger({
      type: 'wt:translate',
      mode: 'selection',
      texts: [multiline],
      manualSelectionId: multilineTicket,
    }, contentSender)
    await vi.waitFor(() => expect(firstFetchStarted).toBe(true))
    tabUpdated!(contentSender.tab.id, { status: 'loading' }, { id: contentSender.tab.id, url: contentSender.url } as never)
    releaseFirstFetch()
    expect(await pendingOk).toMatchObject({ ok: true, texts: ['多行译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const firstBody = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as { messages: { content: string }[] }
    expect(JSON.parse(firstBody.messages[1]!.content).texts).toEqual([multiline])

    // 回归 2：pending manual top selection，fire { url: 'https://app.devin.ai/other' } → cancelled
    const urlChangedText = 'Pending manual selection before top url change.'
    const urlChangedTicket = await grant(contentSender.url, urlChangedText)
    let releaseSecondFetch!: () => void
    const secondFetchGate = new Promise<void>((resolve) => {
      releaseSecondFetch = resolve
    })
    let secondFetchStarted = false
    fetcher.mockImplementationOnce(async () => {
      secondFetchStarted = true
      await secondFetchGate
      return completionReply(['不应送达'])
    })
    const pendingCancelled = trigger({
      type: 'wt:translate',
      mode: 'selection',
      texts: [urlChangedText],
      manualSelectionId: urlChangedTicket,
    }, contentSender)
    await vi.waitFor(() => expect(secondFetchStarted).toBe(true))
    tabUpdated!(
      contentSender.tab.id,
      { url: 'https://app.devin.ai/other' },
      { id: contentSender.tab.id, url: 'https://app.devin.ai/other' } as never,
    )
    releaseSecondFetch()
    expect(await pendingCancelled).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('在途手动授权翻译期间撤销权限返回权限撤销取消提示且不返回旧译文，普通无票据请求保持通用取消', async () => {
    await enableSmart()
    const manualText = 'Held manual selection before permission removal.'
    const manualTicket = await grant(contentSender.url, manualText)
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount += 1
      await fetchGate
      return completionReply(['不应送达'])
    })

    const manualPending = trigger({
      type: 'wt:translate',
      mode: 'selection',
      texts: [manualText],
      manualSelectionId: manualTicket,
    }, contentSender)
    const plainPending = trigger({
      type: 'wt:translate',
      mode: 'selection',
      texts: ['Plain selection before permission removal.'],
    }, { ...contentSender, tab: { id: 8 }, documentId: 'doc-plain' })
    await vi.waitFor(() => expect(fetchCount).toBe(2))

    removedListeners[0]!({ origins: ['https://app.devin.ai/*'] })
    releaseFetch()

    const manualReply = await manualPending
    expect(manualReply).toEqual({
      ok: false,
      code: 'cancelled',
      error: TRANSLATION_PERMISSION_REMOVED_ERROR,
    })
    expect(manualReply).not.toHaveProperty('texts')

    const plainReply = await plainPending
    expect(plainReply).toEqual({
      ok: false,
      code: 'cancelled',
      error: '已取消',
    })
    expect(plainReply).not.toHaveProperty('texts')
  })

  it.each([
    { targetLanguage: 'ja' as const },
    { temperature: 0.5 },
    { requestParams: { reasoning_effort: 'low' } },
  ])(
    '在途手动授权翻译期间保存配置变更（%o）先于权限撤销时仍返回设置变化取消提示且不返回旧译文，普通无票据请求保持通用取消',
    async (patch) => {
      await enableSmart()
      const manualText = 'Held manual selection before config change.'
      const manualTicket = await grant(contentSender.url, manualText)
      let releaseFetch!: () => void
      const fetchGate = new Promise<void>((resolve) => {
        releaseFetch = resolve
      })
      let fetchCount = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        fetchCount += 1
        await fetchGate
        return completionReply(['不应送达'])
      })

      const manualPending = trigger({
        type: 'wt:translate',
        mode: 'selection',
        texts: [manualText],
        manualSelectionId: manualTicket,
      }, contentSender)
      const plainPending = trigger({
        type: 'wt:translate',
        mode: 'selection',
        texts: ['Plain selection before config change.'],
      }, { ...contentSender, tab: { id: 8 }, documentId: 'doc-plain' })
      await vi.waitFor(() => expect(fetchCount).toBe(2))

      expect(await trigger({
        type: 'wt:save-config',
        patch,
      }, extSender)).toMatchObject({ ok: true })
      removedListeners[0]!({ origins: ['https://app.devin.ai/*'] })
      releaseFetch()

      const manualReply = await manualPending
      expect(manualReply).toEqual({
        ok: false,
        code: 'cancelled',
        error: TRANSLATION_CONFIG_CHANGED_ERROR,
      })
      expect(manualReply).not.toHaveProperty('texts')

      const plainReply = await plainPending
      expect(plainReply).toEqual({
        ok: false,
        code: 'cancelled',
        error: '已取消',
      })
      expect(plainReply).not.toHaveProperty('texts')
    },
  )

  it.each([
    {
      name: 'DOM 快照为空且 raw 非空时返回本地化无选区提示且不建票据',
      snapshotText: '',
      raw: 'Synthetic inaccessible selection',
      expectedError: NO_SELECTION_ERROR,
    },
    {
      name: 'DOM 快照超过 6000 字且 raw 未超长时优先报过长错误且不建票据',
      snapshotText: 'a'.repeat(2500) + ' '.repeat(3000) + 'b'.repeat(501),
      raw: 'a'.repeat(2500) + ' ' + 'b'.repeat(505),
      expectedError: '选中文字过长（最多 6000 字）',
    },
    {
      name: 'DOM 快照与 raw 均为 6000 字时正常建票据并展示选区',
      snapshotText: 'a'.repeat(6000),
      raw: 'a'.repeat(6000),
      expectedError: undefined,
    },
  ])('右键选区边界：$name', async ({ snapshotText, raw, expectedError }) => {
    await enableSmart()
    expect(menuClick).toBeDefined()
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const sent: unknown[] = []
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { documentIds?: string[]; frameIds?: number[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) return []
      if (opts.target?.documentIds !== undefined) {
        return [{ frameId: 0, documentId: 'doc-top', result: contentSender.url }]
      }
      return [{
        frameId: 0,
        documentId: 'doc-top',
        result: { url: contentSender.url, focused: true, text: snapshotText, frameFocused: false },
      }]
    }) as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (_tabId: number, message: unknown) => {
      sent.push(message)
      return { ok: true }
    }) as never)
    menuClick!(
      { menuItemId: 'wt-selection', selectionText: raw, pageUrl: contentSender.url, frameId: 0, editable: false },
      { id: contentSender.tab.id, url: contentSender.url } as never,
    )
    await vi.waitFor(() => expect(sent.length === 1).toBe(true))
    const msg = sent[0] as { type?: string; text?: string; error?: string; manualSelectionId?: string }
    if (expectedError !== undefined) {
      expect(msg).toEqual({ type: 'wt:show-selection', text: '', error: expectedError })
      expect(msg.manualSelectionId).toBeUndefined()
    } else {
      expect(msg.type).toBe('wt:show-selection')
      expect(msg.text).toBe('a'.repeat(6000))
      expect(typeof msg.manualSelectionId).toBe('string')
      expect(msg.manualSelectionId).not.toBe('')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('排除网站禁止右键与线索发送，保留本地词库', async () => {
    await enableSmart()
    expect(await trigger({
      type: 'wt:save-config', patch: { excludedHosts: ['devin.ai'] },
    }, extSender)).toMatchObject({ ok: true })
    const manualSelectionId = await grant(contentSender.url)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({
      ok: true, modes: { fixed: true, auto: false, selection: false, smart: false },
    })
    expect(await trigger({
      type: 'wt:translate', mode: 'selection', texts: [text], manualSelectionId,
    }, contentSender)).toMatchObject({ ok: false, error: '该站点已排除模型处理' })
    expect(await trigger({
      type: 'wt:page-context', pageId: 'excluded-page',
      page: { site: 'app.devin.ai', title: 'Excluded title', heading: 'Excluded heading' },
    }, contentSender)).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('范围外右键授权仍不能发模型请求', async () => {
    await enableSmart()
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      selectionPopupEnabled: true,
      proactiveAssistEnabled: true,
      autoOrigins: ['https://app.devin.ai'],
      siteScopeMode: 'include',
      siteScopeHosts: [],
    })
    const manualSelectionId = await grant(contentSender.url)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    expect(await trigger({
      type: 'wt:translate', mode: 'selection', texts: [text], manualSelectionId,
    }, contentSender)).toMatchObject({ ok: false, error: SITE_SCOPE_BLOCKED_ERROR })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('无痕来源不能请求模型或记录线索', async () => {
    await enableSmart()
    const sender = { ...contentSender, tab: { ...contentSender.tab, incognito: true } }
    const fetcher = vi.spyOn(globalThis, 'fetch')
    for (const message of [
      { type: 'wt:translate', mode: 'selection', texts: [text] },
      { type: 'wt:assist', requestId: 'private-window', input },
      { type: 'wt:page-context', pageId: 'private-window', page: { site: 'app.devin.ai', title: 'Private title', heading: '' } },
    ]) {
      expect(await trigger(message, sender)).toMatchObject({ ok: false })
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect((await fakeBrowser.storage.session.get('wtReadingContext')).wtReadingContext).toBeUndefined()
  })

  it('未配置模型时不开启选中即发送模式', async () => {
    await translationConfigItem.setValue({ ...DEFAULT_TRANSLATION_CONFIG, selectionPopupEnabled: true })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({
      ok: true, modes: { fixed: true, selection: false, auto: false, smart: false },
    })
  })

  it.each([false, true])('排除旧线索后不得附带到其他站点，清理失败=%s', async (failRemove) => {
    await enableSmart()
    const prior = { ...contentSender, tab: { id: 8 }, url: 'https://project.example/guide' }
    expect(await trigger({
      type: 'wt:page-context', pageId: 'prior-project',
      page: { site: 'project.example', title: 'EXCLUDED_CONTEXT_TITLE', heading: 'Prior project' },
    }, prior)).toMatchObject({ ok: true })
    expect(JSON.stringify(await fakeBrowser.storage.session.get('wtReadingContext'))).toContain('EXCLUDED_CONTEXT_TITLE')
    const remove = failRemove
      ? vi.spyOn(fakeBrowser.storage.session, 'remove').mockRejectedValueOnce(new Error('synthetic storage failure'))
      : undefined
    const saved = await trigger({ type: 'wt:save-config', patch: { excludedHosts: ['project.example'] } }, extSender)
    expect(saved).toMatchObject({ ok: true, config: { excludedHosts: ['project.example'] } })
    if (failRemove) expect(saved).toHaveProperty('warning')
    else expect((await fakeBrowser.storage.session.get('wtReadingContext')).wtReadingContext).toBeUndefined()
    remove?.mockRestore()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    expect(await trigger({
      type: 'wt:translate', mode: 'selection', texts: ['A public sentence.'], pageId: 'current-page',
      page: { site: 'app.devin.ai', title: 'Current page', heading: 'Current topic' },
    }, contentSender)).toMatchObject({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![1]!.body).not.toContain('EXCLUDED_CONTEXT_TITLE')
  })

  it('写回页面的自动翻译只带同站线索，划词与辅助保留跨站线索', async () => {
    await enableSmart()
    const otherSender = {
      ...contentSender,
      tab: { id: 9 },
      documentId: 'doc-other',
      url: 'https://other.example/article',
    }
    expect(await trigger({
      type: 'wt:page-context', pageId: 'ctx-other',
      page: { site: 'other.example', title: 'OTHER_SITE_TITLE', heading: 'Other heading' },
    }, otherSender)).toMatchObject({ ok: true })
    expect(await trigger({
      type: 'wt:page-context', pageId: 'ctx-same',
      page: { site: 'app.devin.ai', title: 'SAME_SITE_TITLE', heading: 'Same heading' },
    }, contentSender)).toMatchObject({ ok: true })

    const sameEntry = { site: 'app.devin.ai', title: 'SAME_SITE_TITLE', heading: 'Same heading' }
    const otherEntry = { site: 'other.example', title: 'OTHER_SITE_TITLE', heading: 'Other heading' }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    const lastCall = (): { body: string; context: { recentPages: { site: string }[] } } => {
      const call = fetcher.mock.calls.at(-1)
      const body = call![1]!.body as string
      const parsed = JSON.parse(body) as { messages: { content: string }[] }
      return { body, context: JSON.parse(parsed.messages[1]!.content) as { recentPages: { site: string }[] } }
    }

    // mode=auto：译文写回页面 DOM，只保留同站线索
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['A public sentence.'],
    }, contentSender)).toMatchObject({ ok: true })
    const autoCall = lastCall()
    expect(autoCall.context.recentPages).toEqual([sameEntry])
    expect(autoCall.body).toContain('SAME_SITE_TITLE')
    expect(autoCall.body).not.toContain('OTHER_SITE_TITLE')

    // mode=selection：结果只进扩展面板，保留跨站线索
    fetcher.mockClear()
    expect(await trigger({
      type: 'wt:translate', mode: 'selection', texts: ['A public sentence.'],
    }, contentSender)).toMatchObject({ ok: true })
    expect(lastCall().context.recentPages).toEqual([sameEntry, otherEntry])

    // wt:assist：结果只进扩展面板，保留跨站线索
    fetcher.mockClear()
    fetcher.mockImplementation(async () => new Response(
      JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ decision: 'show', intent: 'translate', translation: '译文', explanation: '' }) },
        }],
      }),
      { status: 200 },
    ))
    expect(await trigger({
      type: 'wt:assist', requestId: 'cross-site', input,
    }, contentSender)).toMatchObject({ ok: true })
    expect(lastCall().context.recentPages).toEqual([sameEntry, otherEntry])
  })

  it('页面动作校验接受 retry-failed，拒绝未知动作', () => {
    for (const action of ['restore', 'resume', 'retry-failed']) {
      expect(isTranslationMessage({ type: 'wt:page-action', action })).toBe(true)
      expect(isContentTranslationMessage({ type: 'wt:page-action', action })).toBe(true)
    }
    for (const action of ['retry', undefined, 1]) {
      expect(isTranslationMessage({ type: 'wt:page-action', action })).toBe(false)
      expect(isContentTranslationMessage({ type: 'wt:page-action', action })).toBe(false)
    }
    expect(isTranslationMessage({ type: 'wt:page-action', action: 'restore', tabId: 7, url: 'https://page.example/a' })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:page-action', action: 'restore', tabId: 7 })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:page-action', action: 'restore', url: 'https://page.example/a' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:page-action', action: 'restore', tabId: -1, url: 'https://page.example/a' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:page-action', action: 'restore', tabId: 7, url: 'javascript:alert(1)' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:page-action', action: 'restore', tabId: 7, url: `https://x.com/${'a'.repeat(8192)}` })).toBe(false)
    expect(isContentTranslationMessage({ type: 'wt:page-action', action: 'restore', url: 'https://app.devin.ai/work/a' })).toBe(true)
    expect(isContentTranslationMessage({ type: 'wt:page-action', action: 'restore', url: 'http://app.devin.ai/a' })).toBe(true)
    expect(isContentTranslationMessage({ type: 'wt:page-action', action: 'restore', url: `http://x.com/${'a'.repeat(4083)}` })).toBe(true)
    expect(isContentTranslationMessage({ type: 'wt:page-action', action: 'restore', url: 'javascript:alert(1)' })).toBe(false)
    expect(isContentTranslationMessage({ type: 'wt:page-action', action: 'restore', url: `https://x.com/${'a'.repeat(8192)}` })).toBe(false)
    expect(isContentTranslationMessage({ type: 'wt:page-action', action: 'restore', url: 'ftp://x.com/a' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:current-site-auto', enabled: true })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:current-site-auto', enabled: 'yes' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:current-page-controls', action: 'status' })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:current-page-controls', action: 'retry-failed' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:open-options' })).toBe(true)
    const legacy = { active: false, paused: true }
    expect(isTranslationReply({ ok: true, legacy }, { type: 'wt:current-page-controls', action: 'status' })).toBe(true)
    expect(isTranslationReply({ ok: true }, { type: 'wt:current-page-controls', action: 'status' })).toBe(false)
    expect(isTranslationReply({ ok: true, legacy: { active: 'no', paused: false } }, { type: 'wt:current-page-controls', action: 'resume' })).toBe(false)
  })

  it('消息与回复校验拒绝损坏或超限的排除列表', () => {
    for (const excludedHosts of [null, {}, [1], [''], ['x'.repeat(2049)], Array.from({ length: 51 }, () => 'a.example')]) {
      expect(isTranslationMessage({ type: 'wt:save-config', patch: { excludedHosts } })).toBe(false)
      expect(isTranslationReply({ ok: true, config: { ...VALID_CONFIG, excludedHosts } })).toBe(false)
    }
    const { excludedHosts: _omitted, ...legacy } = VALID_CONFIG
    expect(isTranslationReply({ ok: true, config: legacy })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { excludedHosts: [] } })).toBe(true)
    for (const sourceLanguage of ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt'] as const) {
      expect(isTranslationMessage({ type: 'wt:save-config', patch: { sourceLanguage } })).toBe(true)
      expect(isTranslationReply({ ok: true, config: { ...VALID_CONFIG, sourceLanguage } })).toBe(true)
    }
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { sourceLanguage: 'xx' } })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { sourceLanguage: 'auto' } })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputTargetLanguage: 'es' } })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputTargetLanguage: 'xx' } })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputSourceLanguage: 'auto' } })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputSourceLanguage: 'ja' } })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputSourceLanguage: 'xx' } })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputReplaceKey: 'Ctrl+Enter' } })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputReplaceKey: '' } })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { inputReplaceKey: 'a' } })).toBe(false)
    const { sourceLanguage: _source, ...missingSource } = VALID_CONFIG
    expect(isTranslationReply({ ok: true, config: missingSource })).toBe(false)
    expect(isTranslationReply({ ok: true, config: VALID_CONFIG })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { siteScopeHosts: ['a.example'] } })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { siteScopeMode: 'include' } })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { siteScopeMode: 'nope' } })).toBe(false)
    const dictionaryIds = BUILTIN_DICTIONARY_META.map((item) => item.id)
    expect(dictionaryIds.length).toBeGreaterThan(20)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { disabledDictionaries: dictionaryIds } })).toBe(true)
    expect(isTranslationMessage({
      type: 'wt:save-config',
      patch: { disabledDictionaries: [...dictionaryIds, dictionaryIds[0]] },
    })).toBe(false)
    const { siteScopeMode: _mode, siteScopeHosts: _hosts, ...missingScope } = VALID_CONFIG
    expect(isTranslationReply({ ok: true, config: missingScope })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { selectionToolbarEnabled: true } })).toBe(true)
    expect(isTranslationMessage({ type: 'wt:save-config', patch: { selectionToolbarEnabled: 'yes' } })).toBe(false)
    const { selectionToolbarEnabled: _toolbar, ...missingToolbar } = VALID_CONFIG
    expect(isTranslationReply({ ok: true, config: missingToolbar })).toBe(false)
    expect(isTranslationReply({ ok: true, texts: ['a'], cachedChars: 1 })).toBe(true)
    expect(isTranslationReply({ ok: true, cachedChars: -1 })).toBe(false)
    expect(isTranslationReply({ ok: true, cachedChars: '1' })).toBe(false)
    expect(isTranslationReply({ ok: true, warning: 7 })).toBe(false)
    expect(isTranslationReply({ ok: true, warning: 'x'.repeat(501) })).toBe(false)
  })
})

describe('消息权限边界', () => {
  it('配置/密钥/测试只接受扩展页面', async () => {
    for (const sender of [contentSender, pageSender]) {
      expect(await trigger({ type: 'wt:get-config' }, sender)).toMatchObject({ ok: false })
      expect(await trigger({ type: 'wt:clear-key' }, sender)).toMatchObject({ ok: false })
      expect(await trigger({ type: 'wt:test' }, sender)).toMatchObject({ ok: false })
      expect(await trigger({ type: 'wt:save-config', patch: { baseUrl: 'x' } }, sender)).toMatchObject({ ok: false })
    }
  })

  it('清除翻译缓存只接受扩展页面，消息与回复校验通过', async () => {
    vi.mocked(clearPersistentTranslations).mockClear()
    for (const sender of [contentSender, pageSender]) {
      expect(await trigger({ type: 'wt:clear-cache' }, sender)).toMatchObject({ ok: false })
    }
    expect(clearPersistentTranslations).not.toHaveBeenCalled()
    const message = { type: 'wt:clear-cache' } as const
    expect(isTranslationMessage(message)).toBe(true)
    expect(isTranslationReply({ ok: true }, message)).toBe(true)
    expect(isTranslationReply({ ok: false, error: '清除失败' }, message)).toBe(true)
    expect(isTranslationReply({ ok: false }, message)).toBe(false)
  })

  it('get-config 只回传配置与 hasKey', async () => {
    const reply = (await trigger({ type: 'wt:get-config' }, extSender)) as Record<string, unknown>
    expect(reply.ok).toBe(true)
    expect(reply.hasKey).toBe(true)
    expect(JSON.stringify(reply)).not.toContain('sk-live')
    expect(JSON.stringify(reply)).not.toContain('apiKey')
  })

  it('wt:translate 拒绝扩展页面与外部调用方', async () => {
    const message = { type: 'wt:translate', mode: 'selection', texts: ['Hello'] }
    expect(await trigger(message, extSender)).toMatchObject({ ok: false })
    expect(await trigger(message, pageSender)).toMatchObject({ ok: false })
  })

  it('不响应非 wt 消息', async () => {
    const NO_REPLY = 'no-reply'
    const probe = (message: unknown) =>
      Promise.race([trigger(message, extSender), new Promise((r) => setTimeout(() => r(NO_REPLY), 200))])
    expect(await probe({ type: 'gcn:get-status' })).toBe(NO_REPLY)
    expect(await probe('random')).toBe(NO_REPLY)
  })
})

describe('wt:translate 门控', () => {
  it.each(['/settings/keys', '/settings/personal-access-tokens', '/settings/%74okens', '/settings//tokens'])(
    '已获站点授权仍阻止敏感路径自动发送：%s',
    async (path) => {
      await translationConfigItem.setValue(VALID_CONFIG)
      const fetcher = vi.spyOn(globalThis, 'fetch')
      const reply = await trigger(
        { type: 'wt:translate', mode: 'auto', texts: ['Private credential page.'] },
        { ...contentSender, url: `https://app.devin.ai${path}` },
      )
      expect(reply).toMatchObject({ ok: false })
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each(['translate', 'assist'] as const)('重复 %s ID 被拒绝且原请求仍可取消', async (kind) => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, selectionPopupEnabled: true })
    let signal: AbortSignal | undefined
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    const text = `Unique ${kind} request to verify duplicate cancellation.`
    const message = kind === 'translate'
      ? { type: 'wt:translate', mode: 'selection', requestId: 'duplicate', texts: [text] }
      : {
          type: 'wt:assist', requestId: 'duplicate',
          input: { text, context: '', pageTitle: '', site: 'app.devin.ai', trigger: 'selection', signals: { method: 'mouse', dwellMs: 0, visits: 1 } },
        }
    const original = trigger(message, contentSender)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect(await trigger(message, contentSender)).toMatchObject({ ok: false, error: '请求 ID 重复' })
    expect(signal!.aborted).toBe(false)
    await trigger({ type: 'wt:cancel-assist', requestId: 'duplicate' }, contentSender)
    expect(signal!.aborted).toBe(true)
    expect(await original).toMatchObject({ ok: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('未开启自动翻译的站点不发请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger(
      { type: 'wt:translate', mode: 'auto', texts: ['Hello'] },
      { ...contentSender, url: 'https://not-allowed.example/x' },
    )
    expect(reply).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('总开关关闭不发请求', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    await translationConfigItem.setValue(VALID_CONFIG)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)
    expect(reply).toMatchObject({ ok: false, error: '总开关已关闭' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('缺少端点权限不发请求', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async (query) => {
      const origins = (query as { origins?: string[] }).origins ?? []
      return !origins.some((o) => o.includes('api.example.com'))
    })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)
    expect(reply).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('正常请求转发到模型接口，响应不含 key', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['你好']))
    const reply = await trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)
    expect(reply).toMatchObject({ ok: true, texts: ['你好'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const init = (fetcher.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-live')
    expect(JSON.stringify(reply)).not.toContain('sk-live')
  })
})

describe('wt:save-config 严格校验', () => {
  it('非法接口地址与站点被拒绝而不是静默净化', async () => {
    const reply = await trigger({ type: 'wt:save-config', patch: { baseUrl: 'javascript:x' } }, extSender)
    expect(reply).toMatchObject({ ok: false })
    const reply2 = await trigger({ type: 'wt:set-site-auto', origin: 'not a url', enabled: true }, extSender)
    expect(reply2).toMatchObject({ ok: false })
  })

  it('selectionPopupEnabled 需要全站授权', async () => {
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => false)
    const reply = await trigger({ type: 'wt:save-config', patch: { selectionPopupEnabled: true } }, extSender)
    expect(reply).toMatchObject({ ok: false })
  })

  it('wt:set-site-auto 原子增删站点', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const add = await trigger({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai/x', enabled: true }, extSender)
    expect(add).toMatchObject({ ok: true })
    const removed = await trigger({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: false }, extSender)
    expect(removed).toMatchObject({ ok: true })
  })

  it('wt:set-site-auto 未配置接口时拒绝开启', async () => {
    const reply = await trigger({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true }, extSender)
    expect(reply).toMatchObject({ ok: false })
    const config = await translationConfigItem.getValue()
    expect(config.autoOrigins).not.toContain('https://app.devin.ai')
  })

  it('expectedConnection 不匹配时拒绝写入', async () => {
    const reply = await trigger(
      {
        type: 'wt:save-config',
        patch: { baseUrl: 'https://api.example.com/v1', model: 'm2' },
        expectedConnection: { baseUrl: 'https://stale.example', model: 'old' },
      },
      extSender,
    )
    expect(reply).toMatchObject({ ok: false })
  })
})

describe('绑定密钥与并发保存', () => {
  it('换接口地址且密钥留空时拒绝，config 与旧密钥均不变', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger(
      { type: 'wt:save-config', patch: { baseUrl: 'https://api-b.example.com/v1', model: 'm' } },
      extSender,
    )
    expect(reply).toMatchObject({ ok: false, error: '接口来源已改变，请重新输入或删除旧密钥' })
    expect((await translationConfigItem.getValue()).baseUrl).toBe(VALID_CONFIG.baseUrl)
    expect(apiKeyStore).toEqual({ key: 'sk-live', origin: 'https://api.example.com' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('同 origin 路径变更留空密钥可保留', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const reply = await trigger(
      { type: 'wt:save-config', patch: { baseUrl: 'https://api.example.com/v2', model: 'm' } },
      extSender,
    )
    expect(reply).toMatchObject({ ok: true })
    expect((await translationConfigItem.getValue()).baseUrl).toBe('https://api.example.com/v2')
    expect(apiKeyStore?.origin).toBe('https://api.example.com')
  })

  it('换接口同时提供新密钥则绑定新 origin', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const reply = await trigger(
      { type: 'wt:save-config', patch: { baseUrl: 'https://api-b.example.com/v1', model: 'm' }, apiKey: 'sk-b' },
      extSender,
    )
    expect(reply).toMatchObject({ ok: true })
    expect(apiKeyStore).toEqual({ key: 'sk-b', origin: 'https://api-b.example.com' })
  })

  it('配置写入失败时回滚密钥，不留半写状态', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const spy = vi.spyOn(translationConfigItem, 'setValue').mockRejectedValueOnce(new Error('io'))
    const reply = await trigger(
      { type: 'wt:save-config', patch: { baseUrl: 'https://api-b.example.com/v1', model: 'm' }, apiKey: 'sk-b' },
      extSender,
    )
    expect(reply).toMatchObject({ ok: false })
    expect(apiKeyStore).toEqual({ key: 'sk-live', origin: 'https://api.example.com' })
    expect((await translationConfigItem.getValue()).baseUrl).toBe(VALID_CONFIG.baseUrl)
    spy.mockRestore()
  })

  it('密钥读取失败时 get-config 报 unavailable 且请求全部阻断', async () => {
    const secrets = await import('../../../src/translation/secrets')
    vi.mocked(secrets.readStoredApiKey).mockRejectedValueOnce(new Error('idb down'))
    await translationConfigItem.setValue(VALID_CONFIG)
    const reply = (await trigger({ type: 'wt:get-config' }, extSender)) as Record<string, unknown>
    expect(reply.keyState).toBe('unavailable')
    expect('hasKey' in reply).toBe(false)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    vi.mocked(secrets.readApiKey).mockRejectedValueOnce(new Error('idb down'))
    const t = await trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)
    expect(t).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('显式删除后无密钥新 origin 允许保存', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const clear = await trigger({ type: 'wt:clear-key' }, extSender)
    expect(clear).toMatchObject({ ok: true, keyState: 'none' })
    const reply = await trigger(
      { type: 'wt:save-config', patch: { baseUrl: 'https://api-b.example.com/v1', model: 'm' } },
      extSender,
    )
    expect(reply).toMatchObject({ ok: true })
    expect(apiKeyStore).toBeUndefined()
  })

  it('延迟权限 + 并发保存：旧快照请求不携带新密钥也不发出', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => {
      await gate
      return true
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['x']))
    const a = trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)
    const saveB = trigger(
      { type: 'wt:save-config', patch: { baseUrl: 'https://api-b.example.com/v1', model: 'm' }, apiKey: 'sk-b' },
      extSender,
    )
    release()
    const [replyA, replyB] = await Promise.all([a, saveB])
    expect(replyB).toMatchObject({ ok: true })
    expect(replyA).toMatchObject({ ok: false })
    for (const call of fetcher.mock.calls) {
      const init = (call as [string, RequestInit])[1]
      expect((init.headers as Record<string, string>).Authorization).not.toBe('Bearer sk-b')
    }
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => true)
    const replyB2 = await trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hi'] }, contentSender)
    expect(replyB2).toMatchObject({ ok: true })
    const last = fetcher.mock.calls[fetcher.mock.calls.length - 1] as [string, RequestInit]
    expect((last[1].headers as Record<string, string>).Authorization).toBe('Bearer sk-b')
  })
})

describe('wt:translate 失败代码', () => {
  beforeEach(async () => {
    clearAutomaticPause()
    await translationConfigItem.setValue(VALID_CONFIG)
  })

  it('401/404 回复类型化代码且只请求一次', async () => {
    for (const [status, code] of [[401, 'auth'], [403, 'auth'], [404, 'not_found']] as const) {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x', { status }))
      fetcher.mockClear()
      const reply = await trigger({ type: 'wt:translate', mode: 'auto', texts: [`Hello ${status}`] }, contentSender)
      expect(reply).toMatchObject({ ok: false, code })
      expect(isTranslationReply(reply)).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('429 带回 retryAfterMs，其他标签页的自动请求不再发出', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('x', { status: 429, headers: { 'Retry-After': '20' } }))
    fetcher.mockClear()
    const first = (await trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)) as {
      code: string
      retryAfterMs: number
    }
    expect(first.code).toBe('rate_limited')
    expect(first.retryAfterMs).toBeGreaterThan(19_000)
    expect(first.retryAfterMs).toBeLessThanOrEqual(20_000)
    const other = await trigger(
      { type: 'wt:translate', mode: 'auto', texts: ['Other tab'] },
      { ...contentSender, tab: { id: 8 } },
    )
    expect(other).toMatchObject({ ok: false, code: 'queue_paused' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('更换模型清除 429 暂停，只改站点开关不清除', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['x']))
    pauseAutomaticTasks(30_000)
    await trigger({ type: 'wt:set-site-auto', origin: 'https://example.org', enabled: true }, extSender)
    expect(automaticPauseRemainingMs()).toBeGreaterThan(0)
    await trigger({ type: 'wt:save-config', patch: { model: 'replacement' } }, extSender)
    expect(automaticPauseRemainingMs()).toBe(0)
  })

  it('关闭本站自动翻译中止在途批次时回复 cancelled，而不是普通失败', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    fetcher.mockClear()
    const pending = trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const saved = await trigger({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: false }, extSender)
    expect(saved).toMatchObject({ ok: true })
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('派发前关闭本站也回复 cancelled，不被误报为站点未开启', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['x']))
    fetcher.mockClear()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => {
      await gate
      return true
    })
    const pending = trigger({ type: 'wt:translate', mode: 'auto', texts: ['Hello'] }, contentSender)
    const saved = trigger({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: false }, extSender)
    release()
    await saved
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('页面生命周期端口', () => {
  const otherTab = { ...contentSender, tab: { id: 8 } }
  let release: (() => void)[]
  let fetcher: MockInstance<typeof fetch>

  beforeEach(async () => {
    clearAutomaticPause()
    otherTab.id = fakeBrowser.runtime.id
    await translationConfigItem.setValue({ ...VALID_CONFIG, selectionPopupEnabled: true })
    release = []
    fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const { texts } = JSON.parse(body.messages[1]!.content) as { texts?: string[] }
      return await new Promise<Response>((resolve, reject) => {
        release.push(() => resolve(completionReply((texts ?? []).map((text) => `译：${text}`))))
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    fetcher.mockClear()
  })

  function openPort(session: string, sender: object = contentSender): { port: { disconnect: MockInstance }; close(): void } {
    const listeners: ((port: unknown) => void)[] = []
    const port = {
      name: `wt:page:${session}`,
      sender,
      disconnect: vi.fn(),
      onDisconnect: { addListener: (listener: (port: unknown) => void) => listeners.push(listener) },
    }
    portConnect!(port)
    return { port, close: () => listeners.forEach((listener) => listener(port)) }
  }

  function translateAuto(text: string, pageSession: string, sender: object = contentSender): Promise<unknown> {
    return trigger({ type: 'wt:translate', mode: 'auto', texts: [text], pageSession }, sender)
  }

  it.each([
    ['其他标签页', otherTab],
    ['同一标签页的新文档（Firefox 没有 documentId，scope 相同）', contentSender],
  ])('端口断开只中止该页的排队与在途任务，不影响%s', async (_name, survivor) => {
    // 已结束的会话会被后台记住，每个用例使用自己的 ID。
    const ended = `page-a-${survivor.tab.id}`
    const { close } = openPort(ended)
    openPort('page-b', survivor)
    const inflight = translateAuto('A in flight', ended)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const queued = translateAuto('A queued', ended)
    const other = translateAuto('B queued', 'page-b', survivor)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetcher).toHaveBeenCalledTimes(1)

    close()

    expect(await inflight).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await queued).toMatchObject({ ok: false, code: 'cancelled' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    release[1]!()
    expect(await other).toMatchObject({ ok: true, texts: ['译：B queued'] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(automaticPauseRemainingMs()).toBe(0)
  })

  it('端口断开同样中止划词辅助', async () => {
    const { close } = openPort('page-assist')
    const pending = trigger({
      type: 'wt:assist', requestId: 'assist-a', pageSession: 'page-assist',
      input: {
        text: 'A selected sentence.', context: '', pageTitle: '', site: 'app.devin.ai', trigger: 'selection',
        signals: { method: 'mouse', dwellMs: 0, visits: 1 },
      },
    }, contentSender)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    close()
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('中止后迟到的 429 不算失败，也不触发自动翻译暂停', async () => {
    fetcher.mockImplementation(async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }))
    let respond!: (response: Response) => void
    fetcher.mockImplementationOnce(async () => await new Promise<Response>((resolve) => {
      respond = resolve
    }))
    const { close } = openPort('page-429')
    const pending = translateAuto('Rate limited late', 'page-429')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    close()
    respond(new Response('', { status: 429, headers: { 'retry-after': '30' } }))
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    expect(automaticPauseRemainingMs()).toBe(0)
  })

  it('端口断开后才到达的旧文档消息直接取消，不打断新文档的划词', async () => {
    const { close } = openPort('page-old')
    openPort('page-new')
    close()
    const selection = trigger(
      { type: 'wt:translate', mode: 'selection', texts: ['New page selection'], requestId: 'new-sel', pageSession: 'page-new' },
      contentSender,
    )
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect(await trigger(
      { type: 'wt:translate', mode: 'selection', texts: ['Late'], requestId: 'late-sel', pageSession: 'page-old' },
      contentSender,
    )).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await translateAuto('Late auto', 'page-old')).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    release[0]!()
    expect(await selection).toMatchObject({ ok: true, texts: ['译：New page selection'] })
  })

  it('另一标签页的同名会话不受影响', async () => {
    const { close } = openPort('same-id')
    const pending = translateAuto('Other tab', 'same-id', otherTab)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    close()
    release[0]!()
    expect(await pending).toMatchObject({ ok: true })
  })

  it('后台重启后没有端口记录的会话照常处理', async () => {
    const pending = translateAuto('After restart', 'unknown-to-new-worker')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    release[0]!()
    expect(await pending).toMatchObject({ ok: true })
  })

  it('标签页关闭作为后备同样中止排队与在途任务', async () => {
    const inflight = translateAuto('Closed in flight', 'page-closed')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const queued = translateAuto('Closed queued', 'page-closed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    void fakeBrowser.tabs.onRemoved.trigger(contentSender.tab.id, { windowId: 1, isWindowClosing: false })
    expect(await inflight).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await queued).toMatchObject({ ok: false, code: 'cancelled' })
    expect(automaticPauseRemainingMs()).toBe(0)
  })

  it.each([
    ['扩展页面', () => ({ session: 'page-ext', sender: extSender })],
    ['子框架', () => ({ session: 'page-frame', sender: { ...contentSender, frameId: 3 } })],
    ['非法会话 ID', () => ({ session: 'bad id!', sender: contentSender })],
  ])('拒绝来自%s的端口，断开它也不结束任何会话', async (_name, source) => {
    const { session, sender } = source()
    const { port, close } = openPort(session, sender)
    expect(port.disconnect).toHaveBeenCalledTimes(1)
    close()
    const pending = translateAuto('Still allowed', 'page-frame')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    release[0]!()
    expect(await pending).toMatchObject({ ok: true })
  })

  it('消息校验接受合法的 pageSession，拒绝非法值', () => {
    const translate = { type: 'wt:translate', mode: 'auto', texts: ['a'] }
    expect(isTranslationMessage({ ...translate, pageSession: 'abc-123' })).toBe(true)
    expect(isTranslationMessage({ ...translate, pageSession: 'bad id!' })).toBe(false)
    expect(isTranslationMessage({ ...translate, pageSession: 1 })).toBe(false)
  })
})

describe('配置变更的作废范围', () => {
  const otherSender = { ...contentSender, tab: { id: 8 }, url: 'https://other.example/page' }
  let release: (() => void)[]
  let signals: AbortSignal[]
  let fetcher: MockInstance<typeof fetch>

  beforeEach(async () => {
    clearAutomaticPause()
    otherSender.id = fakeBrowser.runtime.id
    await translationConfigItem.setValue({ ...VALID_CONFIG, autoOrigins: ['https://app.devin.ai', 'https://other.example'] })
    release = []
    signals = []
    fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal
      signals.push(signal)
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const { texts } = JSON.parse(body.messages[1]!.content) as { texts: string[] }
      return await new Promise<Response>((resolve, reject) => {
        release.push(() => resolve(completionReply(texts.map((text) => `译：${text}`))))
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    fetcher.mockClear()
  })

  function translateAuto(text: string, sender: object = contentSender): Promise<unknown> {
    return trigger({ type: 'wt:translate', mode: 'auto', texts: [text] }, sender)
  }

  /** 包一层对象：async 函数直接返回 Promise 会被展开，变成等请求结束。 */
  async function inFlight(text: string): Promise<{ reply: Promise<unknown> }> {
    const reply = translateAuto(text)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    return { reply }
  }

  it('空接口新密钥被拒绝时不能取消在途请求或写入密钥', async () => {
    const before = await translationConfigItem.getValue()
    const beforeKey = apiKeyStore
    const text = 'Empty connection key replacement'
    const { reply: pending } = await inFlight(text)
    vi.mocked(writeApiKey).mockClear()
    try {
      const saved = await trigger(
        { type: 'wt:save-config', patch: { baseUrl: '', model: '' }, apiKey: 'sk-review-replacement' },
        extSender,
      )
      expect(saved).toMatchObject({ ok: false })
      expect(await translationConfigItem.getValue()).toEqual(before)
      expect(apiKeyStore).toEqual(beforeKey)
      expect(signals[0]!.aborted).toBe(false)
      expect(writeApiKey).not.toHaveBeenCalled()
      expect(saved).toMatchObject({ error: '接口地址无效' })
      release[0]!()
      expect(await pending).toMatchObject({ ok: true, texts: [`译：${text}`] })
    } finally {
      release[0]?.()
      await pending
    }
  })

  it('空接口不带新密钥的断开保存保持可用', async () => {
    const { reply: pending } = await inFlight('Normal disconnect save')
    try {
      const saved = await trigger({ type: 'wt:save-config', patch: { baseUrl: '', model: '' } }, extSender)
      expect(saved).toMatchObject({ ok: true, config: { baseUrl: '', model: '' } })
      expect((await translationConfigItem.getValue()).baseUrl).toBe('')
      expect(signals[0]!.aborted).toBe(true)
      expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    } finally {
      release[0]?.()
      await pending
    }
  })

  it.each([
    ['with replacement key', 'sk-review-replacement'],
    ['without replacement key', undefined],
  ])('拒绝过期保存不会取消在途请求（%s）', async (_name, apiKey) => {
    const before = await translationConfigItem.getValue()
    const beforeKey = apiKeyStore
    const text = `Review stale-save ${_name}`
    const { reply: pending } = await inFlight(text)
    try {
      const saved = await trigger({
        type: 'wt:save-config',
        patch: { baseUrl: VALID_CONFIG.baseUrl, model: VALID_CONFIG.model },
        ...(apiKey === undefined ? {} : { apiKey }),
        expectedConnection: { baseUrl: 'https://stale.example/v1', model: 'old' },
      }, extSender)
      expect(saved).toMatchObject({ ok: false, error: '接口配置已在其他窗口更改，请重新加载' })
      expect(await translationConfigItem.getValue()).toEqual(before)
      expect(apiKeyStore).toEqual(beforeKey)
      expect(signals[0]!.aborted).toBe(false)
      release[0]!()
      expect(await pending).toMatchObject({ ok: true, texts: [`译：${text}`] })
    } finally {
      release[0]?.()
      await pending
    }
  })

  it('缺少模型的密钥保存被拒绝时保留在途请求', async () => {
    const before = await translationConfigItem.getValue()
    const beforeKey = apiKeyStore
    const { reply: pending } = await inFlight('Invalid empty model draft')
    try {
      expect(await trigger({ type: 'wt:save-config', patch: { model: '' }, apiKey: 'sk-review-valid' }, extSender))
        .toMatchObject({ ok: false, error: '请先配置模型名称' })
      expect(await translationConfigItem.getValue()).toEqual(before)
      expect(apiKeyStore).toEqual(beforeKey)
      expect(signals[0]!.aborted).toBe(false)
      release[0]!()
      expect(await pending).toMatchObject({ ok: true })
    } finally {
      release[0]?.()
      await pending
    }
  })

  it.each([
    ['其他站点的自动翻译开关', { type: 'wt:set-site-auto', origin: 'https://example.org', enabled: true }],
    ['关闭其他站点', { type: 'wt:set-site-auto', origin: 'https://other.example', enabled: false }],
    ['不匹配本页的排除网站', { type: 'wt:save-config', patch: { excludedHosts: ['unrelated.example'] } }],
    ['固定词库开关', { type: 'wt:save-config', patch: { disabledDictionaries: ['cursor'] } }],
    ['划词辅助开关', { type: 'wt:save-config', patch: { selectionPopupEnabled: true } }],
    ['连接字段原样重新保存', { type: 'wt:save-config', patch: { baseUrl: VALID_CONFIG.baseUrl, model: VALID_CONFIG.model } }],
  ])('无关保存（%s）不中止在途请求，也不清缓存', async (name, message) => {
    const text = `Unrelated ${name}`
    const { reply: pending } = await inFlight(text)
    expect(await trigger(message, extSender)).toMatchObject({ ok: true })
    expect(signals[0]!.aborted).toBe(false)
    release[0]!()
    expect(await pending).toMatchObject({ ok: true, texts: [`译：${text}`] })
    expect(await translateAuto(text)).toMatchObject({ ok: true, texts: [`译：${text}`] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('绕过保存入口的无关写入同样不中止；监听器按新旧值比较', async () => {
    const { reply: pending } = await inFlight('External write')
    await translationConfigItem.setValue({ ...VALID_CONFIG, autoOrigins: ['https://app.devin.ai', 'https://new.example'] })
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(false))
    release[0]!()
    expect(await pending).toMatchObject({ ok: true })
  })

  it.each([
    ['模型', { type: 'wt:save-config', patch: { model: 'replacement' } }],
    ['接口地址', { type: 'wt:save-config', patch: { baseUrl: 'https://api.example.com/v2' } }],
    ['密钥', { type: 'wt:save-config', patch: {}, apiKey: 'sk-rotated' }],
    ['删除密钥', { type: 'wt:clear-key' }],
  ])('%s变更中止全部在途请求并清空缓存', async (name, message) => {
    const cachedText = `Cached ${name}`
    const first = translateAuto(cachedText)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    release[0]!()
    await first
    const inflight = translateAuto(`In flight ${name}`)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(await trigger(message, extSender)).toMatchObject({ ok: true })
    expect(signals[1]!.aborted).toBe(true)
    expect(await inflight).toMatchObject({ ok: false, code: 'cancelled' })
    fetcher.mockClear()
    const again = translateAuto(cachedText)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    release.at(-1)!()
    expect(await again).toMatchObject({ ok: true })
  })

  it.each([
    ['成功', true, { ok: true }],
    ['失败', false, { ok: false, error: '清除失败' }],
  ])('清除翻译缓存%s：中止在途请求并清空内存缓存', async (_name, cleared, expected) => {
    const first = translateAuto('Cached before clear')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    release[0]!()
    await first
    const inflight = translateAuto('In flight during clear')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    vi.mocked(clearPersistentTranslations).mockResolvedValueOnce(cleared)
    expect(await trigger({ type: 'wt:clear-cache' }, extSender)).toEqual(expected)
    expect(signals[1]!.aborted).toBe(true)
    expect(await inflight).toMatchObject({ ok: false, code: 'cancelled' })
    fetcher.mockClear()
    const again = translateAuto('Cached before clear')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    release.at(-1)!()
    expect(await again).toMatchObject({ ok: true })
  })

  it('只有被改动的站点收到 cancelled，其他标签页继续且缓存保留', async () => {
    const { reply: running } = await inFlight('Tab A text')
    const queued = translateAuto('Tab B text', otherSender)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await trigger({ type: 'wt:set-site-auto', origin: 'https://other.example', enabled: false }, extSender)).toMatchObject({ ok: true })
    expect(await queued).toMatchObject({ ok: false, code: 'cancelled' })
    expect(signals[0]!.aborted).toBe(false)
    release[0]!()
    expect(await running).toMatchObject({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('名单已满时重复添加成功、新增被拒，且不中止在途请求', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `site${i}.example`)
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: ['https://app.devin.ai', 'https://other.example'],
      siteScopeHosts: fifty,
    })
    const { reply: pending } = await inFlight('Scope limit in flight')
    try {
      expect(await trigger({ type: 'wt:set-site-scope-host', host: 'site0.example', listed: true }, extSender))
        .toMatchObject({ ok: true })
      expect(await trigger({ type: 'wt:set-site-scope-host', host: 'extra.example', listed: true }, extSender))
        .toMatchObject({ ok: false, error: SITE_SCOPE_LIMIT_ERROR })
      expect((await translationConfigItem.getValue()).siteScopeHosts).toEqual(fifty)
      expect(signals[0]!.aborted).toBe(false)
      release[0]!()
      expect(await pending).toMatchObject({ ok: true, texts: ['译：Scope limit in flight'] })
    } finally {
      release[0]?.()
      await pending
    }
  })

  it('排除本页时立即中止本页请求；排除其他站点不影响', async () => {
    const { reply: pending } = await inFlight('Excluded page text')
    expect(await trigger({ type: 'wt:save-config', patch: { excludedHosts: ['devin.ai'] } }, extSender)).toMatchObject({ ok: true })
    expect(signals[0]!.aborted).toBe(true)
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await translateAuto('Excluded page text')).toMatchObject({ ok: false, error: '该站点已排除模型处理' })
  })

  it('被无关保存延迟的新请求读到新配置后正常完成', async () => {
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains')
    contains.mockImplementation(async () => {
      await gate
      return true
    })
    const saved = trigger({ type: 'wt:set-site-auto', origin: 'https://example.org', enabled: true }, extSender)
    const pending = translateAuto('Waits for mutation')
    unblock()
    expect(await saved).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    release[0]!()
    expect(await pending).toMatchObject({ ok: true })
  })

  it.each([true, false])('补丁回归_清缓存完成前新请求等待屏障（%s）', async (cleared) => {
    let releaseClear!: (value: boolean) => void
    let entered!: () => void
    const gate = new Promise<boolean>((resolve) => { releaseClear = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.mocked(clearPersistentTranslations).mockImplementationOnce(async () => { entered(); return gate })
    vi.mocked(readPersistentTranslations).mockClear()
    const clearing = trigger({ type: 'wt:clear-cache' }, extSender)
    let pending: Promise<unknown> | undefined
    try {
      await started
      pending = translateAuto('New request during cache clear')
      let settled = false
      void pending.then(() => { settled = true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(readPersistentTranslations).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
      expect(settled).toBe(false)
      releaseClear(cleared)
      expect(await clearing).toEqual(cleared ? { ok: true } : { ok: false, error: '清除失败' })
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
      release[0]!()
      expect(await pending).toMatchObject({ ok: true, texts: ['译：New request during cache clear'] })
    } finally {
      releaseClear(cleared)
      await clearing
      for (const finish of release) finish()
      await Promise.allSettled([pending])
    }
  })
})

describe('wt:assist 门控', () => {
  const INPUT = {
    text: 'selected text',
    context: '',
    pageTitle: 't',
    site: 'app.devin.ai',
    trigger: 'selection',
    signals: { method: 'mouse', dwellMs: 0, visits: 1 },
  }

  it('未开启划词辅助时拒绝且不请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger({ type: 'wt:assist', requestId: 'r1', input: INPUT }, contentSender)
    expect(reply).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('取消未知 requestId 返回 ok', async () => {
    const reply = await trigger({ type: 'wt:cancel-assist', requestId: 'nope' }, contentSender)
    expect(reply).toMatchObject({ ok: true })
  })

  it('相同输入命中辅助缓存不占调度槽；撤销权限后拒绝', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => {
      throw new Error('no receiver')
    })
    expect(
      await trigger(
        {
          type: 'wt:save-config',
          patch: { baseUrl: VALID_CONFIG.baseUrl, model: VALID_CONFIG.model, selectionPopupEnabled: true },
        },
        extSender,
      ),
    ).toMatchObject({ ok: true })
    const assistReply = new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ decision: 'show', intent: 'translate', translation: '译文', explanation: '' }) } }],
      }),
      { status: 200 },
    )
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => assistReply.clone())
    const first = await trigger({ type: 'wt:assist', requestId: 'r1', input: INPUT }, contentSender)
    expect(first).toMatchObject({ ok: true, result: { translation: '译文' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let blockersStarted = 0
    const blockers = [
      scheduleModelTask('interactive', async () => {
        blockersStarted += 1
        await gate
        return 'x'
      }),
      scheduleModelTask('interactive', async () => {
        blockersStarted += 1
        await gate
        return 'y'
      }),
    ]
    let settled = false
    const secondPromise = trigger({ type: 'wt:assist', requestId: 'r2', input: INPUT }, contentSender).then(
      (result) => {
        settled = true
        return result
      },
    )
    try {
      await vi.waitFor(() => expect(blockersStarted).toBe(2))
      await vi.waitFor(() => expect(settled).toBe(true))
      const second = await secondPromise
      expect(second).toMatchObject({ ok: true, result: { translation: '译文' } })
      expect(fetcher).toHaveBeenCalledTimes(1)
      vi.mocked(fakeBrowser.permissions.contains).mockImplementation(async () => false)
      const third = await trigger({ type: 'wt:assist', requestId: 'r3', input: INPUT }, contentSender)
      expect(third).toMatchObject({ ok: false })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await Promise.allSettled([...blockers, secondPromise])
    }
  })
})

describe('wt:page-context 记忆门控 (R4)', () => {
  function saveSmart(on: boolean): { type: string; patch: Record<string, unknown> } {
    return {
      type: 'wt:save-config',
      patch: {
        baseUrl: VALID_CONFIG.baseUrl,
        model: VALID_CONFIG.model,
        selectionPopupEnabled: on,
        proactiveAssistEnabled: on,
      },
    }
  }

  beforeEach(() => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => {
      throw new Error('no receiver')
    })
  })

  it('关闭智能陪读后在途上报不能写回阅读记忆', async () => {
    const patchOn = saveSmart(true)
    expect(isTranslationMessage(patchOn)).toBe(true)
    expect(await trigger(patchOn, extSender)).toMatchObject({ ok: true })
    let armed = false
    let entered!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    let release!: (v: boolean) => void
    const gate = new Promise<boolean>((r) => {
      release = r
    })
    vi.mocked(fakeBrowser.permissions.contains).mockImplementation(async (query) => {
      if (armed && (query as { origins?: string[] }).origins?.includes('https://app.devin.ai/*')) {
        entered()
        return await gate
      }
      return true
    })
    armed = true
    const ctxMsg = {
      type: 'wt:page-context',
      pageId: 'page-old',
      page: { site: 'app.devin.ai', title: 'Read topic', heading: 'Topic' },
    }
    expect(isTranslationMessage(ctxMsg)).toBe(true)
    const pending = trigger(ctxMsg, contentSender)
    await started
    armed = false
    expect(
      await trigger(
        { type: 'wt:save-config', patch: { proactiveAssistEnabled: false, selectionPopupEnabled: false } },
        extSender,
      ),
    ).toMatchObject({ ok: true })
    release(true)
    expect(await pending).toMatchObject({ ok: false })
    const env = (await fakeBrowser.storage.session.get('wtReadingContext')) as Record<string, unknown>
    expect(env.wtReadingContext).toBeUndefined()
  })

  it('撤销站点权限后清除全部阅读线索', async () => {
    const patchOn = saveSmart(true)
    expect(isTranslationMessage(patchOn)).toBe(true)
    expect(await trigger(patchOn, extSender)).toMatchObject({ ok: true })
    const { recentPageContexts, recordPageContext } = await import('../../../src/translation/context-memory')
    for (const [site, tab] of [
      ['app.devin.ai', 7],
      ['other.example', 8],
    ] as const) {
      await recordPageContext(
        { site, title: `t-${site}`, heading: `h-${site}` },
        `page-${tab}`,
        tab,
      )
    }
    expect((await recentPageContexts('none', -1)).length).toBe(2)
    expect(removedListeners).toHaveLength(2)
    for (const listener of removedListeners) {
      listener({ origins: ['https://app.devin.ai/*'] })
    }
    await new Promise((r) => setTimeout(r, 0))
    await recentPageContexts('none', -1)
    const env = (await fakeBrowser.storage.session.get('wtReadingContext')) as Record<string, unknown>
    expect(env.wtReadingContext).toBeUndefined()
  })
})

describe('单站点排除操作', () => {
  it('合并两个窗口的添加并只删除指定站点', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const addA = { type: 'wt:set-site-excluded', host: 'https://Devin.ai/', excluded: true }
    const addB = { type: 'wt:set-site-excluded', host: 'other.example', excluded: true }
    expect(await trigger(addA, extSender)).toMatchObject({ ok: true })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({ ok: true, modes: { auto: false } })
    expect(await trigger(addB, extSender)).toMatchObject({ ok: true, config: { excludedHosts: ['devin.ai', 'other.example'] } })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({ ok: true, modes: { auto: false } })
    expect(await trigger(addA, extSender)).toMatchObject({ ok: true, config: { excludedHosts: ['devin.ai', 'other.example'] } })
    expect(await trigger({ type: 'wt:set-site-excluded', host: 'other.example', excluded: false }, extSender))
      .toMatchObject({ ok: true, config: { excludedHosts: ['devin.ai'] } })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({ ok: true, modes: { auto: false } })
  })

  it('非设置页来源不能调用 set-site-excluded', async () => {
    for (const sender of [contentSender, pageSender]) {
      expect(await trigger({ type: 'wt:set-site-excluded', host: 'a.example', excluded: true }, sender))
        .toMatchObject({ ok: false, error: '无权访问' })
    }
  })

  it('无效主机报错误且不改变配置', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    for (const host of ['ftp://x.example/', 'https://user:pw@evil.example/']) {
      expect(await trigger({ type: 'wt:set-site-excluded', host, excluded: true }, extSender))
        .toMatchObject({ ok: false, error: '排除网站地址无效' })
    }
    expect((await translationConfigItem.getValue()).excludedHosts).toEqual(VALID_CONFIG.excludedHosts)
  })

  it('最多 50 个排除网站', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `site${i}.example`)
    await translationConfigItem.setValue({ ...VALID_CONFIG, excludedHosts: fifty })
    expect(await trigger({ type: 'wt:set-site-excluded', host: 'extra.example', excluded: true }, extSender))
      .toMatchObject({ ok: false, error: '排除网站最多 50 个' })
    expect(await trigger({ type: 'wt:set-site-excluded', host: 'site0.example', excluded: true }, extSender))
      .toMatchObject({ ok: true })
    expect(await trigger({ type: 'wt:set-site-excluded', host: 'site0.example', excluded: false }, extSender))
      .toMatchObject({ ok: true })
    expect(await trigger({ type: 'wt:set-site-excluded', host: 'extra.example', excluded: true }, extSender))
      .toMatchObject({ ok: true })
  })

  it('拒绝缺 host、空 host、超长 host、非字符串 host 和非布尔 excluded', () => {
    expect(isTranslationMessage({ type: 'wt:set-site-excluded' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-excluded', excluded: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-excluded', host: '', excluded: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-excluded', host: 'x'.repeat(2049), excluded: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-excluded', host: 1, excluded: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-excluded', host: 'a.example', excluded: 'yes' })).toBe(false)
  })

  it('两个排除操作同时排队时从最新状态合并', async () => {
    const other = { ...contentSender, tab: { id: 8 }, url: 'https://other.example/page' }
    await translationConfigItem.setValue({ ...VALID_CONFIG, autoOrigins: ['https://app.devin.ai', 'https://other.example'] })
    for (const sender of [contentSender, other]) {
      expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({ ok: true, modes: { auto: true } })
    }
    const originalSet = translationConfigItem.setValue.bind(translationConfigItem)
    let started!: () => void
    let releaseWrite!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const writer = vi.spyOn(translationConfigItem, 'setValue').mockImplementationOnce(async (config) => {
      started()
      await gate
      await originalSet(config)
    })
    const first = trigger({ type: 'wt:set-site-excluded', host: 'devin.ai', excluded: true }, extSender)
    let second: Promise<unknown> | undefined
    try {
      await entered
      second = trigger({ type: 'wt:set-site-excluded', host: 'other.example', excluded: true }, extSender)
      let done = false
      void second.then(() => {
        done = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(done).toBe(false)
      expect(writer).toHaveBeenCalledTimes(1)
      releaseWrite()
      expect(await first).toMatchObject({ ok: true })
      expect(await second).toMatchObject({ ok: true, config: { excludedHosts: ['devin.ai', 'other.example'] } })
      for (const sender of [contentSender, other]) {
        expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({ ok: true, modes: { auto: false } })
      }
    } finally {
      releaseWrite()
      await Promise.allSettled([first, second])
      writer.mockRestore()
    }
  })
})

describe('wt:page-modes 词典 fixedEntries', () => {
  it('devin 主机命中内置词典：fixed=true 且带词条', async () => {
    const reply = await trigger({ type: 'wt:page-modes' }, contentSender) as { ok: boolean; modes?: { fixed: boolean; fixedEntries?: Record<string, string> } }
    expect(reply.ok).toBe(true)
    expect(reply.modes?.fixed).toBe(true)
    expect(reply.modes?.fixedEntries?.['Settings']).toBe('设置')
    expect(reply.modes?.fixedEntries?.['New session']).toBe('新建会话')
  })

  it('禁用 devin 词典后 fixed=false 且无 fixedEntries', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, disabledDictionaries: ['devin'] })
    const reply = await trigger({ type: 'wt:page-modes' }, contentSender) as { ok: boolean; modes?: { fixed: boolean; fixedEntries?: Record<string, string> } }
    expect(reply.modes?.fixed).toBe(false)
    expect(reply.modes?.fixedEntries).toBeUndefined()
  })

  it('启用的自定义词典命中时覆盖同名内置词条', async () => {
    await customDictionariesItem.setValue([
      { id: 'custom:d12345', label: 'T', hosts: ['devin.ai'], entries: { Settings: '自定义设置' }, enabled: true },
    ])
    const reply = await trigger({ type: 'wt:page-modes' }, contentSender) as { ok: boolean; modes?: { fixed: boolean; fixedEntries?: Record<string, string> } }
    expect(reply.modes?.fixed).toBe(true)
    expect(reply.modes?.fixedEntries?.['Settings']).toBe('自定义设置')
    await customDictionariesItem.setValue([])
  })

  it('en 目标且无自定义词典时 fixed=false', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, targetLanguage: 'en' })
    const reply = await trigger({ type: 'wt:page-modes' }, contentSender) as { ok: boolean; modes?: { fixed: boolean; fixedEntries?: Record<string, string> } }
    expect(reply.modes?.fixed).toBe(false)
    expect(reply.modes?.fixedEntries).toBeUndefined()
  })
})

describe('wt:page-modes 词典加载门控', () => {
  it('save-config targetLanguage=ja 真实保存并下发日语词条', async () => {
    const save = await trigger(
      { type: 'wt:save-config', patch: { targetLanguage: 'ja' } },
      extSender,
    )
    expect(save).toMatchObject({ ok: true })
    expect((save as { config?: { targetLanguage?: string } }).config?.targetLanguage).toBe('ja')
    expect((await translationConfigItem.getValue()).targetLanguage).toBe('ja')
    const sourceSave = await trigger({ type: 'wt:save-config', patch: { sourceLanguage: 'ja' } }, extSender)
    expect(sourceSave).toMatchObject({ ok: true, config: { sourceLanguage: 'ja' } })
    expect((await translationConfigItem.getValue()).sourceLanguage).toBe('ja')
    const reply = await trigger({ type: 'wt:page-modes' }, contentSender)
    expect(reply).toMatchObject({ ok: true })
    expect((reply as { modes?: { fixedEntries?: Record<string, string> } }).modes?.fixedEntries?.['Settings']).toBe('設定')
    expect(vi.mocked(mergeFixedEntries).mock.calls.length).toBeGreaterThan(0)
  })

  it.each(['permission', 'master'])('%s 不允许时 page-modes 不调用 loader', async (mode) => {
    await translationConfigItem.setValue(DEFAULT_TRANSLATION_CONFIG)
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: mode === 'permission' })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(
      async () => mode !== 'permission',
    )
    vi.mocked(mergeFixedEntries).mockClear()
    const reply = await trigger({ type: 'wt:page-modes' }, contentSender)
    expect(reply).toMatchObject({ ok: true })
    expect((reply as { modes?: { fixed?: boolean } }).modes?.fixed).toBe(false)
    expect(vi.mocked(mergeFixedEntries)).not.toHaveBeenCalled()
  })
})

describe('右键菜单语言', () => {
  it('两个菜单都随 uiLanguage 更新，且保留各自上下文', async () => {
    const update = vi.spyOn(fakeBrowser.contextMenus, 'update').mockResolvedValue(undefined)
    for (const [language, selection, page] of [
      ['ja', '選択したテキストを翻訳', 'このページを翻訳 / 原文に戻す'],
      ['ko', '선택한 텍스트 번역', '이 페이지 번역 / 원문 복원'],
    ] as const) {
      update.mockClear()
      await settingsItem.setValue({ ...DEFAULT_SETTINGS, uiLanguage: language })
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith('wt-selection', {
          title: selection, contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'],
        })
        expect(update).toHaveBeenCalledWith('wt-page', {
          title: page, contexts: ['page', 'link', 'image'], documentUrlPatterns: ['http://*/*', 'https://*/*'],
        })
      })
    }
  })
})

describe('网站运行范围', () => {
  it('拒绝缺 host、空 host、超长 host、非字符串 host 和非布尔 listed', () => {
    expect(isTranslationMessage({ type: 'wt:set-site-scope-host' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-scope-host', listed: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-scope-host', host: '', listed: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-scope-host', host: 'x'.repeat(2049), listed: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-scope-host', host: 1, listed: true })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-scope-host', host: 'a.example', listed: 'yes' })).toBe(false)
    expect(isTranslationMessage({ type: 'wt:set-site-scope-host', host: 'a.example', listed: true })).toBe(true)
  })

  it('非设置页不能改名单', async () => {
    for (const sender of [contentSender, pageSender]) {
      expect(await trigger({ type: 'wt:set-site-scope-host', host: 'a.example', listed: true }, sender))
        .toMatchObject({ ok: false, error: '无权访问' })
    }
  })

  it('添加、删除、非法地址和 50 个上限', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    expect(await trigger({ type: 'wt:set-site-scope-host', host: 'https://Docs.Example/path', listed: true }, extSender))
      .toMatchObject({ ok: true, config: { siteScopeHosts: ['docs.example'] } })
    expect(await trigger({ type: 'wt:set-site-scope-host', host: 'docs.example', listed: false }, extSender))
      .toMatchObject({ ok: true, config: { siteScopeHosts: [] } })
    expect(await trigger({ type: 'wt:set-site-scope-host', host: 'ftp://x.example/', listed: true }, extSender))
      .toMatchObject({ ok: false, error: SITE_SCOPE_INVALID_ERROR })
    const fifty = Array.from({ length: 50 }, (_, i) => `site${i}.example`)
    await translationConfigItem.setValue({ ...VALID_CONFIG, siteScopeHosts: fifty })
    expect(await trigger({ type: 'wt:set-site-scope-host', host: 'extra.example', listed: true }, extSender))
      .toMatchObject({ ok: false, error: SITE_SCOPE_LIMIT_ERROR })
    expect((await translationConfigItem.getValue()).siteScopeHosts).toEqual(fifty)
  })

  it('模式或名单变化清理阅读线索，清理失败给出范围警告', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      selectionPopupEnabled: true,
      proactiveAssistEnabled: true,
    })
    expect(await trigger({
      type: 'wt:page-context',
      pageId: 'scope-clue',
      page: { site: 'app.devin.ai', title: 'SCOPE_CONTEXT_TITLE', heading: 'h' },
    }, contentSender)).toMatchObject({ ok: true })
    expect(JSON.stringify(await fakeBrowser.storage.session.get('wtReadingContext'))).toContain('SCOPE_CONTEXT_TITLE')
    const saved = await trigger({ type: 'wt:save-config', patch: { siteScopeMode: 'include' } }, extSender)
    expect(saved).toMatchObject({ ok: true, config: { siteScopeMode: 'include' } })
    expect((await fakeBrowser.storage.session.get('wtReadingContext')).wtReadingContext).toBeUndefined()

    expect(await trigger({
      type: 'wt:page-context',
      pageId: 'scope-clue-2',
      page: { site: 'app.devin.ai', title: 'SCOPE_CONTEXT_AGAIN', heading: 'h' },
    }, contentSender)).toMatchObject({ ok: false, error: SITE_SCOPE_BLOCKED_ERROR })

    const remove = vi.spyOn(fakeBrowser.storage.session, 'remove').mockRejectedValueOnce(new Error('synthetic storage failure'))
    try {
      const warned = await trigger({ type: 'wt:set-site-scope-host', host: 'extra.example', listed: true }, extSender)
      expect(warned).toMatchObject({
        ok: true,
        warning: '网站运行范围已保存，但阅读线索清理失败；范围外的线索仍不会发送，请重试清理',
      })
    } finally {
      remove.mockRestore()
    }
  })

  it('include 未列出时 page-modes 连固定词典一起关掉，列出后恢复', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      siteScopeMode: 'include',
      siteScopeHosts: ['other.example'],
    })
    vi.mocked(mergeFixedEntries).mockClear()
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({
      ok: true,
      modes: { fixed: false, auto: false, selection: false },
    })
    expect(vi.mocked(mergeFixedEntries)).not.toHaveBeenCalled()
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      siteScopeMode: 'include',
      siteScopeHosts: ['devin.ai'],
    })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({
      ok: true,
      modes: { fixed: true },
    })
  })

  it('范围外的翻译请求返回固定错误且不发请求', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      siteScopeMode: 'include',
      siteScopeHosts: [],
    })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    expect(await trigger({ type: 'wt:translate', mode: 'selection', texts: ['Hello'] }, contentSender))
      .toMatchObject({ ok: false, error: SITE_SCOPE_BLOCKED_ERROR })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('include 空名单时 page-modes 五个旗标都关闭', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS)
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      selectionPopupEnabled: true,
      proactiveAssistEnabled: true,
      siteScopeMode: 'include',
      siteScopeHosts: [],
    })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({
      ok: true,
      modes: { enabled: false, fixed: false, auto: false, selection: false, smart: false },
    })
  })

  it('范围外不能开启自动翻译，关闭仍可移除', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: ['https://app.devin.ai'],
      siteScopeMode: 'include',
      siteScopeHosts: [],
    })
    expect(await trigger({
      type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true,
    }, extSender)).toMatchObject({ ok: false, error: SITE_SCOPE_BLOCKED_ERROR })
    expect((await translationConfigItem.getValue()).autoOrigins).toEqual(['https://app.devin.ai'])
    expect(await trigger({
      type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: false,
    }, extSender)).toMatchObject({ ok: true, config: { autoOrigins: [] } })
  })

  it('两个范围添加同时排队时都保留，删除后旧窗口再加成功', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const originalSet = translationConfigItem.setValue.bind(translationConfigItem)
    let started!: () => void
    let releaseWrite!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const writer = vi.spyOn(translationConfigItem, 'setValue').mockImplementationOnce(async (config) => {
      started()
      await gate
      await originalSet(config)
    })
    const first = trigger({ type: 'wt:set-site-scope-host', host: 'docs.example', listed: true }, extSender)
    let second: Promise<unknown> | undefined
    try {
      await entered
      second = trigger({ type: 'wt:set-site-scope-host', host: 'other.example', listed: true }, extSender)
      let done = false
      void second.then(() => {
        done = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(done).toBe(false)
      expect(writer).toHaveBeenCalledTimes(1)
      releaseWrite()
      expect(await first).toMatchObject({ ok: true })
      expect(await second).toMatchObject({
        ok: true,
        config: { siteScopeHosts: ['docs.example', 'other.example'] },
      })
    } finally {
      releaseWrite()
      await Promise.allSettled([first, second])
      writer.mockRestore()
    }
    expect(await trigger({ type: 'wt:set-site-scope-host', host: 'docs.example', listed: false }, extSender))
      .toMatchObject({ ok: true, config: { siteScopeHosts: ['other.example'] } })
    expect(await trigger({ type: 'wt:set-site-scope-host', host: 'docs.example', listed: true }, extSender))
      .toMatchObject({ ok: true, config: { siteScopeHosts: ['other.example', 'docs.example'] } })
  })
})

describe('选择工具栏配置与门控', () => {
  const INPUT = {
    text: 'selected text',
    context: '',
    pageTitle: 't',
    site: 'app.devin.ai',
    trigger: 'selection' as const,
    signals: { method: 'mouse' as const, dwellMs: 0, visits: 1 },
  }

  it('工具栏开启时无模型也可划词，智能陪读关闭', async () => {
    await translationConfigItem.setValue({
      ...DEFAULT_TRANSLATION_CONFIG,
      selectionPopupEnabled: true,
      selectionToolbarEnabled: true,
    })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({
      ok: true,
      modes: { selection: true, smart: false, auto: false },
    })
  })

  it('保存时工具栏会关掉主动提示，并拒绝同时打开智能陪读', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    expect(
      await trigger(
        {
          type: 'wt:save-config',
          patch: {
            baseUrl: VALID_CONFIG.baseUrl,
            model: VALID_CONFIG.model,
            selectionPopupEnabled: true,
            selectionToolbarEnabled: true,
            proactiveAssistEnabled: false,
          },
        },
        extSender,
      ),
    ).toMatchObject({
      ok: true,
      config: { selectionPopupEnabled: true, selectionToolbarEnabled: true, proactiveAssistEnabled: false },
    })
    expect(
      await trigger(
        { type: 'wt:save-config', patch: { proactiveAssistEnabled: true } },
        extSender,
      ),
    ).toMatchObject({ ok: false, error: '需先开启划词辅助并配置模型' })
  })

  it('工具栏模式下拒绝无意图的划词辅助和回读，允许显式释义', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => {
      throw new Error('no receiver')
    })
    expect(
      await trigger(
        {
          type: 'wt:save-config',
          patch: {
            baseUrl: VALID_CONFIG.baseUrl,
            model: VALID_CONFIG.model,
            selectionPopupEnabled: true,
            selectionToolbarEnabled: true,
          },
        },
        extSender,
      ),
    ).toMatchObject({ ok: true })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    expect(await trigger({ type: 'wt:assist', requestId: 'r1', input: INPUT }, contentSender))
      .toMatchObject({ ok: false, error: '未开启相应阅读辅助' })
    expect(
      await trigger(
        {
          type: 'wt:assist',
          requestId: 'r2',
          input: { ...INPUT, trigger: 'revisit', text: 'x'.repeat(40) },
        },
        contentSender,
      ),
    ).toMatchObject({ ok: false })
    expect(
      await trigger(
        { type: 'wt:page-context', pageId: 'page-1', page: { site: 'app.devin.ai', title: 'T', heading: 'H' } },
        contentSender,
      ),
    ).toMatchObject({ ok: false, error: '未开启主动阅读提示' })
    const assistReply = new Response(
      JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ decision: 'show', intent: 'define', translation: '', explanation: '定义' }) },
        }],
      }),
      { status: 200 },
    )
    fetcher.mockImplementation(async () => assistReply.clone())
    expect(
      await trigger(
        { type: 'wt:assist', requestId: 'r3', input: { ...INPUT, requestedIntent: 'define' } },
        contentSender,
      ),
    ).toMatchObject({ ok: true, result: { intent: 'define' } })
  })
})

describe('悬浮入口桥接', () => {
  const messages = [
    { type: 'wt:current-site-auto', enabled: true },
    { type: 'wt:current-page-controls', action: 'restore' },
    { type: 'wt:open-options' },
    { type: 'wt:open-text-window' },
  ] as const
  function githubSender(): typeof contentSender & { documentId: string } {
    return {
      ...contentSender,
      url: 'https://github.com/vuejs/core/issues',
      documentId: 'doc-9',
      tab: { id: 11 },
    }
  }

  async function arm(patch: Record<string, unknown> = {}): Promise<{
    open: MockInstance
    send: MockInstance
    write: MockInstance
  }> {
    const open = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never)
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: true } as never)
    const write = vi.spyOn(translationConfigItem, 'setValue')
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true, ...patch })
    await new Promise((resolve) => setTimeout(resolve, 0))
    open.mockClear()
    send.mockClear()
    write.mockClear()
    return { open, send, write }
  }

  it('fromOurContent 之外拒绝新三类', async () => {
    const { open, send, write } = await arm()
    for (const sender of [pageSender, extSender, { ...contentSender, frameId: 1 }]) {
      for (const message of messages) {
        expect(await trigger(message, sender)).toMatchObject({ ok: false, error: '无权访问' })
      }
    }
    expect(open).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('总开关、范围、排除、敏感页、权限和浮钮关闭都挡住且无副作用', async () => {
    const cases: Array<{ patch?: Record<string, unknown>; sender?: object; permission?: boolean; enabled?: boolean }> = [
      { enabled: false },
      { patch: { siteScopeMode: 'include', siteScopeHosts: ['other.example'] } },
      { patch: { excludedHosts: ['app.devin.ai'] } },
      { sender: { ...contentSender, url: 'https://app.devin.ai/settings/tokens' } },
      { permission: false },
      { patch: { floatingButtonEnabled: false } },
    ]
    for (const item of cases) {
      fakeBrowser.reset()
      extSender.id = fakeBrowser.runtime.id
      extSender.url = fakeBrowser.runtime.getURL('/options.html')
      contentSender.id = fakeBrowser.runtime.id
      vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => item.permission !== false)
      vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation(async () => true)
      installTranslationBackground()
      if (item.enabled === false) await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
      const { open, send, write } = await arm(item.patch)
      for (const message of messages) {
        expect(await trigger(message, item.sender ?? contentSender)).toMatchObject({ ok: false })
      }
      expect(open).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
    }
  })

  it('无模型时 page-modes.floating 仍可为 true，auto 为 false', async () => {
    await translationConfigItem.setValue({
      ...DEFAULT_TRANSLATION_CONFIG,
      floatingButtonEnabled: true,
      baseUrl: '',
      model: '',
    })
    expect(await trigger({ type: 'wt:page-modes' }, contentSender)).toMatchObject({
      ok: true,
      modes: { floating: true, auto: false },
    })
  })

  it('patch 保存 floating 后 get-config 保留', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    expect(await trigger({ type: 'wt:save-config', patch: { floatingButtonEnabled: true } }, extSender)).toMatchObject({
      ok: true,
      config: { floatingButtonEnabled: true },
    })
    expect(await trigger({ type: 'wt:save-config', patch: { model: 'm2' } }, extSender)).toMatchObject({
      ok: true,
      config: { floatingButtonEnabled: true, model: 'm2' },
    })
    expect(await trigger({ type: 'wt:get-config' }, extSender)).toMatchObject({
      ok: true,
      config: { floatingButtonEnabled: true },
    })
  })

  it('current-site-auto 忽略伪造 origin，只保存 sender 的站点', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true, autoOrigins: [] })
    expect(await trigger({
      type: 'wt:current-site-auto',
      enabled: true,
      origin: 'https://evil.example',
    }, contentSender)).toEqual({ ok: true })
    expect(await trigger({ type: 'wt:get-config' }, extSender)).toMatchObject({
      ok: true,
      config: { autoOrigins: ['https://app.devin.ai'] },
    })
  })

  it('排队期间范围被收窄则不写自动站点', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true, autoOrigins: [] })
    const originalSet = translationConfigItem.setValue.bind(translationConfigItem)
    let started!: () => void
    let releaseWrite!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const writer = vi.spyOn(translationConfigItem, 'setValue').mockImplementationOnce(async (config) => {
      started()
      await gate
      await originalSet(config)
    })
    const first = trigger({ type: 'wt:save-config', patch: { siteScopeMode: 'include' } }, extSender)
    let second: Promise<unknown> | undefined
    try {
      await entered
      second = trigger({
        type: 'wt:current-site-auto',
        enabled: true,
        origin: 'https://evil.example',
      }, contentSender)
      releaseWrite()
      expect(await first).toMatchObject({ ok: true })
      expect(await second).toMatchObject({ ok: false, error: SITE_SCOPE_BLOCKED_ERROR })
    } finally {
      releaseWrite()
      await Promise.allSettled([first, second])
      writer.mockRestore()
    }
    expect(await trigger({ type: 'wt:get-config' }, extSender)).toMatchObject({
      ok: true,
      config: { autoOrigins: [], siteScopeMode: 'include' },
    })
  })

  it('current-page-controls 用 sender 的 tab 与 document，GitHub 接力，非 GitHub 不发 gcn', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true })
    const query = vi.spyOn(fakeBrowser.tabs, 'query')
    const calls: unknown[][] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (...args) => {
      calls.push(args)
      const message = args[1] as { type?: string }
      if (message.type === 'wt:page-action') return { ok: true }
      if (message.type === 'gcn:page-translation') return { ok: true, active: true, paused: false }
      return undefined
    })
    const sender = githubSender()
    expect(await trigger({ type: 'wt:current-page-controls', action: 'restore' }, sender)).toEqual({
      ok: true,
      legacy: { active: true, paused: false },
    })
    expect(query).not.toHaveBeenCalled()
    expect(calls.map((args) => args[1])).toEqual([
      { type: 'wt:page-action', action: 'restore', url: sender.url },
      { type: 'gcn:page-translation', action: 'restore', url: sender.url },
    ])
    expect(calls[0]?.[0]).toBe(11)
    expect(calls[0]?.[2]).toEqual({ frameId: 0, documentId: 'doc-9' })
    calls.length = 0
    expect(await trigger({ type: 'wt:current-page-controls', action: 'resume' }, sender)).toEqual({
      ok: true,
      legacy: { active: true, paused: false },
    })
    expect(calls.map((args) => (args[1] as { type: string }).type)).toEqual(['wt:page-action', 'gcn:page-translation'])
    calls.length = 0
    expect(await trigger({ type: 'wt:current-page-controls', action: 'restore' }, contentSender)).toEqual({
      ok: true,
      legacy: { active: false, paused: false },
    })
    expect(calls.map((args) => args[1])).toEqual([
      { type: 'wt:page-action', action: 'restore', url: contentSender.url },
    ])
  })

  it('status 只查 gcn 且不发模型请求；缺回复或错回复 fail closed', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const calls: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      calls.push(message)
      return { ok: true, active: false, paused: true }
    })
    const sender = githubSender()
    expect(await trigger({ type: 'wt:current-page-controls', action: 'status' }, sender)).toEqual({
      ok: true,
      legacy: { active: false, paused: true },
    })
    expect(calls).toEqual([{ type: 'gcn:page-translation', action: 'status', url: sender.url }])
    expect(fetcher).not.toHaveBeenCalled()
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined as never)
    expect(await trigger({ type: 'wt:current-page-controls', action: 'status' }, sender)).toMatchObject({
      ok: false,
      error: '当前页面不支持',
    })
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: true, active: 'yes', paused: false } as never)
    expect(await trigger({ type: 'wt:current-page-controls', action: 'restore' }, sender)).toMatchObject({
      ok: false,
      error: '当前页面不支持',
    })
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      if ((message as { type: string }).type === 'wt:page-action') return { ok: false, error: '页面已变化' }
      return { ok: true, active: true, paused: false }
    })
    expect(await trigger({ type: 'wt:current-page-controls', action: 'resume' }, sender)).toMatchObject({
      ok: false,
      error: '当前页面不支持',
    })
  })

  it('openOptions 只打开一次', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true })
    const open = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never)
    expect(await trigger({ type: 'wt:open-options' }, contentSender)).toEqual({ ok: true })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('open-text-window 用 popup 窗口打开 translate.html，不发模型请求也不改配置', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true })
    const windowsCreate = vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({} as never)
    const tabsCreate = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const write = vi.spyOn(translationConfigItem, 'setValue')
    const before = await translationConfigItem.getValue()
    expect(await trigger({ type: 'wt:open-text-window' }, contentSender)).toEqual({ ok: true })
    expect(windowsCreate).toHaveBeenCalledTimes(1)
    expect(windowsCreate).toHaveBeenCalledWith({
      url: fakeBrowser.runtime.getURL('/translate.html'),
      type: 'popup',
      width: 1000,
      height: 760,
    })
    expect(tabsCreate).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(await translationConfigItem.getValue()).toEqual(before)
  })

  it('open-text-window 窗口创建失败时回退标签页', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true })
    vi.spyOn(fakeBrowser.windows, 'create').mockRejectedValue(new Error('popup blocked') as never)
    const tabsCreate = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never)
    expect(await trigger({ type: 'wt:open-text-window' }, contentSender)).toEqual({ ok: true })
    expect(tabsCreate).toHaveBeenCalledTimes(1)
    expect(tabsCreate).toHaveBeenCalledWith({ url: fakeBrowser.runtime.getURL('/translate.html') })
  })

  it('两次发送之间授权撤销：resume 被阻断不再发 gcn，restore 仍完成 GitHub 引擎还原', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, floatingButtonEnabled: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    let sent = false
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => !sent)
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      sent = true
      if ((message as { type?: string }).type === 'gcn:page-translation') {
        return { ok: true, active: false, paused: true }
      }
      return { ok: true }
    })
    expect(await trigger({ type: 'wt:current-page-controls', action: 'resume' }, githubSender())).toMatchObject({
      ok: false,
      error: '未授权访问该站点',
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toMatchObject({ type: 'wt:page-action', action: 'resume' })
    expect(send.mock.calls.some((call) => (call[1] as { type?: string }).type === 'gcn:page-translation')).toBe(false)

    sent = false
    send.mockClear()
    expect(await trigger({ type: 'wt:current-page-controls', action: 'restore' }, githubSender())).toEqual({
      ok: true,
      legacy: { active: false, paused: true },
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      { type: 'wt:page-action', action: 'restore', url: githubSender().url },
      { type: 'gcn:page-translation', action: 'restore', url: githubSender().url },
    ])
  })
})

describe('浏览器快捷键', () => {
  const PAGE_STATUS = {
    supported: true,
    fixed: false,
    auto: false,
    paused: false,
    capped: false,
    failed: 0,
    error: '',
  }

  it('toggle 在未授权/范围外/排除站点/总开关关闭时不向标签页发送任何消息', async () => {
    const cases: Array<{ patch?: Record<string, unknown>; permission?: boolean; enabled?: boolean }> = [
      { permission: false },
      { patch: { siteScopeMode: 'include', siteScopeHosts: ['other.example'] } },
      { patch: { excludedHosts: ['app.devin.ai'] } },
      { enabled: false },
    ]
    for (const item of cases) {
      await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: item.enabled !== false })
      await translationConfigItem.setValue({ ...VALID_CONFIG, ...item.patch })
      vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => item.permission !== false)
      const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: true } as never)
      commandTrigger!('toggle-page-translation', { id: 7, url: contentSender.url } as never)
      await new Promise((resolve) => setTimeout(resolve, 10))
      // 关总开关时后台会向标签页发 wt:stop，那是设置监听的职责，不属于快捷键路径
      const shortcutMessages = send.mock.calls.map((call) => call[1] as { type: string }).filter((message) => message.type !== 'wt:stop')
      expect(shortcutMessages, JSON.stringify(item)).toEqual([])
    }
  })

  it('generic fixed=true 且非 GitHub 只发 wt:page-action restore（带 url）', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const calls: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      calls.push(message)
      if ((message as { type: string }).type === 'wt:status') {
        return { ok: true, status: { ...PAGE_STATUS, fixed: true } }
      }
      return { ok: true }
    })
    commandTrigger!('toggle-page-translation', { id: 7, url: contentSender.url } as never)
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual([
      { type: 'wt:status' },
      { type: 'wt:page-action', action: 'restore', url: contentSender.url },
    ])
  })

  it('generic paused=true 发送 resume', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const calls: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      calls.push(message)
      if ((message as { type: string }).type === 'wt:status') {
        return { ok: true, status: { ...PAGE_STATUS, paused: true } }
      }
      return { ok: true }
    })
    commandTrigger!('toggle-page-translation', { id: 7, url: contentSender.url } as never)
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual([
      { type: 'wt:status' },
      { type: 'wt:page-action', action: 'resume', url: contentSender.url },
    ])
  })

  it('GitHub 页 legacy.active=true 且 generic 空时先 wt:page-action restore 再 gcn:page-translation restore', async () => {
    const githubUrl = 'https://github.com/vuejs/core/issues'
    await translationConfigItem.setValue(VALID_CONFIG)
    const calls: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      calls.push(message)
      const typed = message as { type: string; action?: string }
      if (typed.type === 'wt:status') return { ok: true, status: PAGE_STATUS }
      if (typed.type === 'gcn:page-translation') return { ok: true, active: true, paused: false }
      return { ok: true }
    })
    commandTrigger!('toggle-page-translation', { id: 7, url: githubUrl } as never)
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    expect(calls.slice(2)).toEqual([
      { type: 'wt:page-action', action: 'restore', url: githubUrl },
      { type: 'gcn:page-translation', action: 'restore', url: githubUrl },
    ])
  })

  it('两边都无翻译时不发动作', async () => {
    const githubUrl = 'https://github.com/vuejs/core/issues'
    await translationConfigItem.setValue(VALID_CONFIG)
    const calls: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      calls.push(message)
      const typed = message as { type: string }
      if (typed.type === 'wt:status') return { ok: true, status: PAGE_STATUS }
      if (typed.type === 'gcn:page-translation') return { ok: true, active: false, paused: false }
      return { ok: true }
    })
    commandTrigger!('toggle-page-translation', { id: 7, url: githubUrl } as never)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toEqual([
      { type: 'wt:status' },
      { type: 'gcn:page-translation', action: 'status', url: githubUrl },
    ])
  })

  it('GitHub 页只有词典脚本时，Alt+T 跳过通用引擎直接恢复 GitHub 词典', async () => {
    const githubUrl = 'https://github.com/vuejs/core/issues'
    await translationConfigItem.setValue(VALID_CONFIG)
    const calls: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      calls.push(message)
      const typed = message as { type: string; action?: string }
      if (typed.type === 'gcn:page-translation') {
        return typed.action === 'status' ? { ok: true, active: true, paused: false } : { ok: true, active: false, paused: true }
      }
      throw new Error('Could not establish connection. Receiving end does not exist.')
    })
    commandTrigger!('toggle-page-translation', { id: 7, url: githubUrl } as never)
    await vi.waitFor(() =>
      expect(calls).toEqual([
        { type: 'wt:status' },
        { type: 'gcn:page-translation', action: 'status', url: githubUrl },
        { type: 'wt:page-action', action: 'restore', url: githubUrl },
        { type: 'gcn:page-translation', action: 'restore', url: githubUrl },
      ]),
    )
  })

  it('没有可切换的翻译时 Alt+T 给出提示而不是静默', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never)
    const calls: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      calls.push(message)
      if ((message as { type: string }).type === 'wt:status') {
        return { ok: true, status: { ...PAGE_STATUS, fixed: false, auto: false, paused: false } }
      }
      return { ok: true }
    })
    commandTrigger!('toggle-page-translation', { id: contentSender.tab.id, url: contentSender.url } as never)
    await vi.waitFor(() =>
      expect(calls).toEqual([
        { type: 'wt:status' },
        { type: 'wt:show-selection', text: '', error: NOTHING_TO_TOGGLE_ERROR },
      ]),
    )
  })

  it('translate-selection：读取焦点快照并写入 manualGrants 展示到 top documentId；空选区提示 NO_SELECTION_ERROR；无痕不发送', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    let selectionReply = 'Hello'
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { tabId: number; allFrames?: boolean; documentIds?: string[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) return []
      if (opts.target?.documentIds !== undefined) {
        return [{ frameId: 0, documentId: 'doc-top', result: contentSender.url }]
      }
      return [{
        frameId: 0,
        documentId: 'doc-top',
        result: { url: contentSender.url, focused: true, text: selectionReply, frameFocused: false },
      }]
    }) as never)
    const sent: Array<{ message: unknown; options: unknown }> = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message, options) => {
      sent.push({ message, options })
      return { ok: true }
    })
    commandTrigger!('translate-selection', { id: contentSender.tab.id, url: contentSender.url } as never)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const shown = sent[0]?.message as { type: string; text: string; manualSelectionId?: string }
    expect(shown).toMatchObject({
      type: 'wt:show-selection',
      text: 'Hello',
    })
    expect(typeof shown.manualSelectionId).toBe('string')
    expect(sent[0]?.options).toEqual({ frameId: 0, documentId: 'doc-top' })
    expect(inject.mock.calls[0]?.[0]).toMatchObject({ target: { tabId: contentSender.tab.id, allFrames: true } })
    expect(inject.mock.calls[1]?.[0]).toMatchObject({
      target: { tabId: contentSender.tab.id, documentIds: ['doc-top'] },
      injectImmediately: true,
    })

    // 验证 manualGrants 已生效（即使站点未授权，凭本次手动 ticket 也可完成翻译）
    let originPermitted = false
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async ({ origins } = {}) => {
      const pattern = origins?.[0] ?? ''
      return pattern.startsWith('https://api.example.com') ? true : originPermitted
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['你好']))
    expect(
      await trigger(
        { type: 'wt:translate', mode: 'selection', texts: ['Hello'], manualSelectionId: shown.manualSelectionId },
        contentSender,
      ),
    ).toMatchObject({ ok: true, texts: ['你好'] })
    originPermitted = true

    sent.length = 0
    selectionReply = ''
    commandTrigger!('translate-selection', { id: contentSender.tab.id, url: contentSender.url } as never)
    await vi.waitFor(() =>
      expect(sent).toEqual([
        {
          message: { type: 'wt:show-selection', text: '', error: NO_SELECTION_ERROR },
          options: { frameId: 0, documentId: 'doc-top' },
        },
      ]),
    )

    sent.length = 0
    commandTrigger!('translate-selection', { id: contentSender.tab.id, url: contentSender.url, incognito: true } as never)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sent).toEqual([])
  })

  it('已移除的输入命令不会注入、写入或打开文本窗口', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true })
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript')
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage')
    const open = vi.spyOn(fakeBrowser.windows, 'create')
    commandTrigger!('translate-input', { id: contentSender.tab.id, url: contentSender.url } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(inject).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('Alt+S 焦点在已授权跨源 iframe 时优先读取该 frame 并展示到 top doc，不聚合其他 frame，且语境仅用源 frame 站点', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      selectionPopupEnabled: true,
      proactiveAssistEnabled: true,
    })
    expect(await trigger({
      type: 'wt:page-context',
      pageId: 'recent-page',
      page: { site: 'app.devin.ai', title: 'RECENT_TOP_MARKER', heading: 'Recent heading' },
    }, contentSender)).toMatchObject({ ok: true })

    const frameUrl = 'https://docs.example/embed/guide'
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { allFrames?: boolean; documentIds?: string[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) return []
      if (opts.target?.documentIds !== undefined) {
        return [
          { frameId: 0, documentId: 'doc-top', result: contentSender.url },
          { frameId: 2, documentId: 'doc-sub', result: frameUrl },
        ]
      }
      return [
        { frameId: 0, documentId: 'doc-top', result: { url: contentSender.url, focused: false, text: '', frameFocused: true } },
        { frameId: 1, documentId: 'doc-sibling', result: { url: 'https://sibling.example/a', focused: false, text: 'Unfocused sibling text', frameFocused: false } },
        { frameId: 2, documentId: 'doc-sub', result: { url: frameUrl, focused: true, text: 'Focused iframe text', frameFocused: false } },
      ]
    }) as never)
    const sent: Array<{ message: unknown; options: unknown }> = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message, options) => {
      sent.push({ message, options })
      return { ok: true }
    })

    commandTrigger!('translate-selection', { id: contentSender.tab.id, url: contentSender.url } as never)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const shown = sent[0]?.message as { type: string; text: string; manualSelectionId: string }
    expect(shown.text).toBe('Focused iframe text')
    expect(typeof shown.manualSelectionId).toBe('string')
    expect(sent[0]?.options).toEqual({ frameId: 0, documentId: 'doc-top' })

    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['子框架译文']))
    const reply = await trigger({
      type: 'wt:translate',
      mode: 'selection',
      texts: ['Focused iframe text'],
      manualSelectionId: shown.manualSelectionId,
      pageId: 'top-page',
      page: { site: 'app.devin.ai', title: 'TOP_TITLE_MARKER', heading: 'TOP_HEADING_MARKER' },
    }, contentSender)
    expect(reply).toMatchObject({ ok: true, texts: ['子框架译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as { messages: { content: string }[] }
    expect(JSON.parse(body.messages[1]!.content)).toEqual({
      texts: ['Focused iframe text'],
      currentPage: { title: '', heading: '', site: 'docs.example' },
      recentPages: [],
    })
  })

  it('未授权/被排除/不在范围/敏感路径/沙盒子框架零模型请求，右键同源子框架可用 activeTab', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      selectionPopupEnabled: true,
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    const sent: Array<{ message: unknown; options: unknown }> = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message, options) => {
      sent.push({ message, options })
      return { ok: true }
    })

    // 1. Alt+S allFrames 因未授权子框架失败、top.frameFocused=true 时提示未授权且不回退顶层选区
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { allFrames?: boolean; frameIds?: number[]; documentIds?: string[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) return []
      if (opts.target?.allFrames === true) throw new Error('Cannot access contents of the page')
      return [{ frameId: 0, documentId: 'doc-top', result: { url: contentSender.url, focused: false, text: '', frameFocused: true } }]
    }) as never)
    commandTrigger!('translate-selection', { id: contentSender.tab.id, url: contentSender.url } as never)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.message).toMatchObject({ type: 'wt:show-selection', text: '', error: '未授权访问该站点' })
    expect(fetcher).not.toHaveBeenCalled()

    // 2. 右键未授权跨源子框架、被排除子框架、不在范围子框架、敏感路径子框架、沙盒子框架均不发模型请求
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      excludedHosts: ['excluded.example'],
      siteScopeMode: 'include',
      siteScopeHosts: ['app.devin.ai', 'unauth.example', 'excluded.example', 'authorized.example'],
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async ({ origins } = {}) => {
      const pattern = origins?.[0] ?? ''
      return !pattern.includes('unauth.example') && !pattern.includes('app.devin.ai')
    })
    for (const frameUrl of [
      'https://unauth.example/frame',
      'https://excluded.example/frame',
      'https://out-of-scope.example/frame',
      'https://authorized.example/settings/tokens',
      'about:srcdoc',
    ]) {
      sent.length = 0
      vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
        target?: { frameIds?: number[]; documentIds?: string[] }
        files?: string[]
      }) => {
        if (opts.files !== undefined) return []
        return [
          { frameId: 0, documentId: 'doc-top', result: { url: contentSender.url, focused: false, text: '', frameFocused: true } },
          { frameId: 4, documentId: 'doc-sub-4', result: { url: frameUrl, focused: true, text: 'Frame text', frameFocused: false } },
        ]
      }) as never)
      menuClick!(
        { menuItemId: 'wt-selection', selectionText: 'Frame text', pageUrl: contentSender.url, frameUrl, frameId: 4, editable: false },
        { id: contentSender.tab.id, url: contentSender.url } as never,
      )
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const msg = sent[0]?.message as { text?: string; error?: string; manualSelectionId?: string }
      expect(msg.manualSelectionId, frameUrl).toBeUndefined()
      expect(typeof msg.error, frameUrl).toBe('string')
      if (frameUrl === 'https://out-of-scope.example/frame') {
        expect(msg.error).toBe(SITE_SCOPE_BLOCKED_ERROR)
      }
      if (frameUrl === 'https://authorized.example/settings/tokens') {
        expect(msg.text).toBe('')
        expect(msg.error).toBe(SENSITIVE_FRAME_ERROR)
      }
    }
    expect(fetcher).not.toHaveBeenCalled()

    // 3. 右键同源子框架（持久权限 contains=false 但右键具备 activeTab）允许翻译
    sent.length = 0
    const sameOriginFrame = 'https://app.devin.ai/embed/widget'
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { frameIds?: number[]; documentIds?: string[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) return []
      if (opts.target?.documentIds !== undefined) {
        return [
          { frameId: 0, documentId: 'doc-top', result: contentSender.url },
          { frameId: 3, documentId: 'doc-same', result: sameOriginFrame },
        ]
      }
      return [
        { frameId: 0, documentId: 'doc-top', result: { url: contentSender.url, focused: false, text: '', frameFocused: true } },
        { frameId: 3, documentId: 'doc-same', result: { url: sameOriginFrame, focused: true, text: 'Same origin frame text', frameFocused: false } },
      ]
    }) as never)
    menuClick!(
      { menuItemId: 'wt-selection', selectionText: 'Same origin frame text', pageUrl: contentSender.url, frameUrl: sameOriginFrame, frameId: 3, editable: false },
      { id: contentSender.tab.id, url: contentSender.url } as never,
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const okMsg = sent[0]?.message as { text: string; manualSelectionId: string }
    expect(okMsg.text).toBe('Same origin frame text')
    expect(typeof okMsg.manualSelectionId).toBe('string')
    expect(await trigger({
      type: 'wt:translate',
      mode: 'selection',
      texts: ['Same origin frame text'],
      manualSelectionId: okMsg.manualSelectionId,
    }, contentSender)).toMatchObject({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('展示前同 URL 重载不展示选区；排队期间源 frame 导航/删除或同 URL 顶层重载零模型调用；失效 ticket 即使顶层全权也不回退', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      selectionPopupEnabled: true,
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    const sent: Array<{ message: unknown; options: unknown }> = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId, message, options) => {
      sent.push({ message, options })
      return { ok: true }
    })

    // 1. 注入期间顶层重载为同 URL 的新 documentId，不发送 wt:show-selection
    let topDocId = 'doc-top-1'
    let injected = false
    let verified = false
    let releaseVerify!: () => void
    const verifyGate = new Promise<void>((resolve) => {
      releaseVerify = resolve
    })
    const execSpy = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      target?: { allFrames?: boolean; documentIds?: string[] }
      files?: string[]
    }) => {
      if (opts.files !== undefined) {
        injected = true
        topDocId = 'doc-top-2'
        return []
      }
      if (opts.target?.documentIds !== undefined) {
        verified = true
        await verifyGate
        return opts.target.documentIds.includes(topDocId)
          ? [{ frameId: 0, documentId: topDocId, result: contentSender.url }]
          : []
      }
      return [{ frameId: 0, documentId: 'doc-top-1', result: { url: contentSender.url, focused: true, text: 'Reloaded text', frameFocused: false } }]
    }) as never)
    commandTrigger!('translate-selection', { id: contentSender.tab.id, url: contentSender.url } as never)
    await vi.waitFor(() => expect(verified).toBe(true))
    expect(injected).toBe(true)
    expect(execSpy).toHaveBeenCalledTimes(3)
    releaseVerify()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])

    // 2. 携带不存在/失效的 manualSelectionId 时，即使顶层拥有完整权限也返回 cancelled，绝不按普通 selection 回退发送
    expect(await trigger({
      type: 'wt:translate',
      mode: 'selection',
      texts: ['Normal looking text'],
      manualSelectionId: 'expired-or-forged-ticket',
    }, contentSender)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fetcher).not.toHaveBeenCalled()

    // 3. 排队阶段（queued phase）源 frame 导航/被删，或顶层同 URL 重载为新 documentId：零模型请求
    for (const raceMode of ['source-navigated', 'source-removed', 'top-reloaded-same-url'] as const) {
      sent.length = 0
      const frameUrl = 'https://docs.example/embed'
      let liveTopDoc = 'doc-top'
      let liveSourceDoc: string | undefined = 'doc-sub'
      let liveSourceUrl = frameUrl
      vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
        target?: { allFrames?: boolean; documentIds?: string[] }
        files?: string[]
      }) => {
        if (opts.files !== undefined) return []
        if (opts.target?.documentIds !== undefined) {
          const results: Array<{ frameId: number; documentId: string; result: string }> = []
          if (opts.target.documentIds.includes(liveTopDoc)) {
            results.push({ frameId: 0, documentId: liveTopDoc, result: contentSender.url })
          }
          if (liveSourceDoc !== undefined && opts.target.documentIds.includes(liveSourceDoc)) {
            results.push({ frameId: 2, documentId: liveSourceDoc, result: liveSourceUrl })
          }
          return results
        }
        return [
          { frameId: 0, documentId: liveTopDoc, result: { url: contentSender.url, focused: false, text: '', frameFocused: true } },
          { frameId: 2, documentId: liveSourceDoc!, result: { url: liveSourceUrl, focused: true, text: `Queued text ${raceMode}`, frameFocused: false } },
        ]
      }) as never)

      commandTrigger!('translate-selection', { id: contentSender.tab.id, url: contentSender.url } as never)
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const ticket = (sent[0]?.message as { manualSelectionId: string }).manualSelectionId

      // 占满 2 个 interactive 调度槽，让本次请求进入队列等待
      let releaseSlot!: () => void
      const slotGate = new Promise<void>((resolve) => {
        releaseSlot = resolve
      })
      let slotsRunning = 0
      const slot1 = scheduleModelTask('interactive', async () => {
        slotsRunning += 1
        await slotGate
      })
      const slot2 = scheduleModelTask('interactive', async () => {
        slotsRunning += 1
        await slotGate
      })
      await vi.waitFor(() => expect(slotsRunning).toBe(2))

      const scheduler = await import('../../../src/translation/scheduler')
      const realSchedule = scheduler.scheduleModelTask
      const scheduleSpy = vi
        .spyOn(scheduler, 'scheduleModelTask')
        .mockImplementation((...args) => realSchedule(...args))
      try {
        const translatePromise = trigger({
          type: 'wt:translate',
          mode: 'selection',
          texts: [`Queued text ${raceMode}`],
          manualSelectionId: ticket,
        }, contentSender)
        await vi.waitFor(() => expect(scheduleSpy).toHaveBeenCalledTimes(1))

        // 在队列等待期间发生导航/删除/同 URL 重载
        if (raceMode === 'source-navigated') liveSourceUrl = 'https://docs.example/other'
        else if (raceMode === 'source-removed') liveSourceDoc = undefined
        else liveTopDoc = 'doc-top-reloaded'

        releaseSlot()
        await Promise.allSettled([slot1, slot2])
        expect(await translatePromise, raceMode).toMatchObject({ ok: false, code: 'cancelled' })
        expect(fetcher, raceMode).not.toHaveBeenCalled()
      } finally {
        scheduleSpy.mockRestore()
      }
    }
  })
})

describe('高级接口设置与自定义请求头事务边界', () => {
  it('保存自定义请求头生成不透明修订号，不向公开配置或回复泄露秘密值，支持保留、清空、跨源拦截与失败回滚', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    expect(
      await trigger(
        { type: 'wt:save-config', patch: {}, customHeaders: { 'X-Secret': 'synthetic-header-secret' } },
        contentSender,
      ),
    ).toMatchObject({ ok: false, error: '无权访问' })

    const saved = (await trigger(
      {
        type: 'wt:save-config',
        patch: {},
        customHeaders: { 'X-Secret': 'synthetic-header-secret' },
      },
      extSender,
    )) as {
      ok: boolean
      config?: { customHeadersRevision: string }
      customHeadersState?: string
    }
    expect(saved.ok).toBe(true)
    const rev1 = saved.config?.customHeadersRevision ?? ''
    expect(rev1).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    expect(saved.customHeadersState).toBe('ready')
    expect(JSON.stringify(saved)).not.toContain('synthetic-header-secret')
    expect(JSON.stringify(await translationConfigItem.getValue())).not.toContain('synthetic-header-secret')
    expect(customHeadersStore).toEqual({
      headers: { 'x-secret': 'synthetic-header-secret' },
      origin: 'https://api.example.com',
      revision: rev1,
    })

    const getReply = await trigger({ type: 'wt:get-config' }, extSender)
    expect(getReply).toMatchObject({ ok: true, customHeadersState: 'ready' })
    expect(JSON.stringify(getReply)).not.toContain('synthetic-header-secret')

    // 省略 customHeaders 保留原修订号与私有存储
    const keepReply = (await trigger(
      { type: 'wt:save-config', patch: { temperature: 0.3 } },
      extSender,
    )) as { ok: boolean; config?: { customHeadersRevision: string; temperature: number | null } }
    expect(keepReply).toMatchObject({
      ok: true,
      config: { customHeadersRevision: rev1, temperature: 0.3 },
    })
    expect(customHeadersStore?.revision).toBe(rev1)

    // 重新填写规范化后等价的请求头复用同一修订号
    const sameHeaderReply = (await trigger(
      {
        type: 'wt:save-config',
        patch: {},
        customHeaders: { 'X-Secret': ' synthetic-header-secret ' },
      },
      extSender,
    )) as { ok: boolean; config?: { customHeadersRevision: string } }
    expect(sameHeaderReply).toMatchObject({
      ok: true,
      config: { customHeadersRevision: rev1 },
    })

    // 更换接口来源但未重填请求头时，即使提供新 API Key 仍拒绝并保持旧配置与请求头不变
    const snapshotConfig = await translationConfigItem.getValue()
    const snapshotHeaders = { ...customHeadersStore! }
    const originChanged = await trigger(
      {
        type: 'wt:save-config',
        patch: { baseUrl: 'https://other.example/v1', model: 'm' },
        apiKey: 'sk-other',
      },
      extSender,
    )
    expect(originChanged).toMatchObject({
      ok: false,
      error: '接口来源已改变，请重新填写或清空自定义请求头',
    })
    expect(await translationConfigItem.getValue()).toEqual(snapshotConfig)
    expect(customHeadersStore).toEqual(snapshotHeaders)

    // 显式提供新请求头与新密钥时成功绑定新来源与新修订号
    const replaced = (await trigger(
      {
        type: 'wt:save-config',
        patch: { baseUrl: 'https://other.example/v1', model: 'm' },
        apiKey: 'sk-other',
        customHeaders: { 'X-New': 'next-secret' },
      },
      extSender,
    )) as { ok: boolean; config?: { customHeadersRevision: string }; customHeadersState?: string }
    expect(replaced.ok).toBe(true)
    const rev2 = replaced.config?.customHeadersRevision ?? ''
    expect(rev2).not.toBe('')
    expect(rev2).not.toBe(rev1)
    expect(replaced.customHeadersState).toBe('ready')
    expect(customHeadersStore).toEqual({
      headers: { 'x-new': 'next-secret' },
      origin: 'https://other.example',
      revision: rev2,
    })

    // 公开配置写入失败时回滚私有请求头与密钥
    const beforeFailConfig = await translationConfigItem.getValue()
    const beforeFailApiKey = { ...apiKeyStore! }
    const beforeFailHeaders = { ...customHeadersStore! }
    const setSpy = vi.spyOn(translationConfigItem, 'setValue').mockRejectedValueOnce(new Error('synthetic'))
    const failedSave = await trigger(
      {
        type: 'wt:save-config',
        patch: { model: 'm-fail' },
        apiKey: 'sk-rollback',
        customHeaders: { 'X-Fail': 'should-rollback' },
      },
      extSender,
    )
    expect(failedSave).toMatchObject({ ok: false })
    expect(await translationConfigItem.getValue()).toEqual(beforeFailConfig)
    expect(apiKeyStore).toEqual(beforeFailApiKey)
    expect(customHeadersStore).toEqual(beforeFailHeaders)
    setSpy.mockRestore()

    // 非法参数或受限字段不调用 setValue
    const setSpyInvalid = vi.spyOn(translationConfigItem, 'setValue')
    for (const invalidMsg of [
      { type: 'wt:save-config', patch: { requestParams: { model: 'override' } } },
      { type: 'wt:save-config', patch: {}, customHeaders: { Authorization: 'Bearer x' } },
      { type: 'wt:save-config', patch: { customHeadersRevision: rev1 } },
    ]) {
      expect(await trigger(invalidMsg, extSender)).toMatchObject({ ok: false })
    }
    expect(setSpyInvalid).not.toHaveBeenCalled()
    setSpyInvalid.mockRestore()

    // {} 清空请求头
    const cleared = await trigger(
      { type: 'wt:save-config', patch: {}, customHeaders: {} },
      extSender,
    )
    expect(cleared).toMatchObject({
      ok: true,
      config: { customHeadersRevision: '' },
      customHeadersState: 'none',
    })
    expect(customHeadersStore).toBeUndefined()
  })

  it('双窗口 expectedConnection.requestOptionsKey CAS 拦截过期高级设置覆盖', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const baselineKey = requestOptionsKey(VALID_CONFIG)
    const first = await trigger(
      {
        type: 'wt:save-config',
        patch: { temperature: 0.5 },
        expectedConnection: {
          baseUrl: VALID_CONFIG.baseUrl,
          model: VALID_CONFIG.model,
          requestOptionsKey: baselineKey,
        },
      },
      extSender,
    )
    expect(first).toMatchObject({ ok: true, config: { temperature: 0.5 } })

    const second = await trigger(
      {
        type: 'wt:save-config',
        patch: { temperature: 1 },
        expectedConnection: {
          baseUrl: VALID_CONFIG.baseUrl,
          model: VALID_CONFIG.model,
          requestOptionsKey: baselineKey,
        },
      },
      extSender,
    )
    expect(second).toMatchObject({ ok: false, error: '接口配置已在其他窗口更改，请重新加载' })
    expect((await translationConfigItem.getValue()).temperature).toBe(0.5)
  })

  it('请求头记录缺失或修订号不匹配时允许无关阅读策略保存，但阻止无重填的连接变更并阻断模型调用', async () => {
    const rev = '11111111-1111-4111-8111-111111111111'
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      selectionPopupEnabled: true,
      customHeadersRevision: rev,
    })
    customHeadersStore = undefined

    const unrelated = await trigger(
      { type: 'wt:save-config', patch: { selectionPopupEnabled: false } },
      extSender,
    )
    expect(unrelated).toMatchObject({
      ok: true,
      config: { selectionPopupEnabled: false, customHeadersRevision: rev },
      customHeadersState: 'unavailable',
    })

    const connectionEdit = await trigger(
      { type: 'wt:save-config', patch: { temperature: 0.5 } },
      extSender,
    )
    expect(connectionEdit).toMatchObject({
      ok: false,
      error: '自定义请求头与当前接口不匹配，请重新填写或清空',
    })

    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['恢复成功']))
    const translated = await trigger(
      { type: 'wt:translate', mode: 'auto', texts: ['Hello'] },
      contentSender,
    )
    expect(translated).toEqual({ ok: false, error: '无法读取接口配置或密钥，请在设置中检查' })
    expect(fetcher).not.toHaveBeenCalled()

    const recovered = await trigger(
      { type: 'wt:save-config', patch: {}, customHeaders: {} },
      extSender,
    )
    expect(recovered).toMatchObject({
      ok: true,
      config: { customHeadersRevision: '' },
      customHeadersState: 'none',
    })
    expect(await trigger({ type: 'wt:test' }, extSender)).toEqual({
      ok: true,
      texts: ['恢复成功'],
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['temperature', { temperature: 0.5 }],
    ['requestParams', { requestParams: { reasoning_effort: 'low' } }],
    ['sourceLanguage', { sourceLanguage: 'en' as const }],
    ['targetLanguage', { targetLanguage: 'ja' as const }],
  ] as const)('保存 %s 不清除 429 自动暂停', async (_label, patch) => {
    await translationConfigItem.setValue(VALID_CONFIG)
    pauseAutomaticTasks(30_000)
    try {
      const saved = await trigger({ type: 'wt:save-config', patch }, extSender)
      expect(saved).toMatchObject({ ok: true })
      expect(automaticPauseRemainingMs()).toBeGreaterThan(0)
      const callback = vi.fn(async () => 'never')
      const error = await scheduleModelTask('automatic', callback).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(AutomaticPausedError)
      expect(describeFailure(error)).toMatchObject({ code: 'queue_paused' })
      expect(callback).not.toHaveBeenCalled()
    } finally {
      clearAutomaticPause()
    }
  })

  it('配置已写入后脚本同步失败返回已保存状态与警告，按新 CAS 基线可重试', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const registration = await import('../../../src/translation/registration')
    const sync = vi.spyOn(registration, 'syncSiteScript').mockRejectedValueOnce(new Error('synthetic sync failure'))
    try {
      const saved = await trigger({
        type: 'wt:save-config',
        patch: { temperature: 0.5 },
        expectedConnection: {
          baseUrl: VALID_CONFIG.baseUrl,
          model: VALID_CONFIG.model,
          requestOptionsKey: requestOptionsKey(VALID_CONFIG),
        },
      }, extSender)
      expect(saved).toMatchObject({
        ok: true,
        config: { temperature: 0.5 },
        warning: '已保存，但站点脚本更新失败，请重试保存',
      })
      expect(isTranslationReply(saved, { type: 'wt:save-config', patch: {} })).toBe(true)
      const committed = await translationConfigItem.getValue()
      expect(committed.temperature).toBe(0.5)
      const retried = await trigger({
        type: 'wt:save-config',
        patch: { temperature: 0.6 },
        expectedConnection: {
          baseUrl: committed.baseUrl,
          model: committed.model,
          requestOptionsKey: requestOptionsKey(committed),
        },
      }, extSender)
      expect(retried).toMatchObject({ ok: true, config: { temperature: 0.6 } })
      expect(retried).not.toHaveProperty('warning')
    } finally {
      sync.mockRestore()
    }
  })

  it('模型发现 wt:list-models：草稿不落盘、同源凭据复用、跨源拦截且零请求、内容脚本拒绝、精确取消与配置作废', async () => {
    const rev = '11111111-1111-4111-8111-111111111111'
    const initialConfig = {
      ...DEFAULT_TRANSLATION_CONFIG,
      baseUrl: 'https://api.example.com/v1',
      model: '',
      customHeadersRevision: rev,
    }
    await translationConfigItem.setValue(initialConfig)
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    customHeadersStore = {
      headers: { 'x-saved-header': 'saved-val' },
      origin: 'https://api.example.com',
      revision: rev,
    }

    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )

    // 内容脚本不能调用 list-models 或 cancel-models
    expect(
      await trigger(
        { type: 'wt:list-models', baseUrl: 'https://api.example.com/v1', requestId: 'c1' },
        contentSender,
      ),
    ).toEqual({ ok: false, error: '无权访问' })
    expect(await trigger({ type: 'wt:cancel-models', requestId: 'c1' }, contentSender)).toEqual({
      ok: false,
      error: '无权访问',
    })
    expect(fetcher).not.toHaveBeenCalled()

    // 草稿 URL + key + headers 在 model 为空且总开关关闭时可获取模型，且不改变存储
    const draftReply = await trigger(
      {
        type: 'wt:list-models',
        baseUrl: 'https://draft.example.com/v1/responses',
        apiKey: 'sk-draft-temp',
        customHeaders: { 'X-Draft': 'draft-val' },
        requestId: 'req-draft',
      },
      extSender,
    )
    expect(draftReply).toEqual({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [draftUrl, draftInit] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(draftUrl).toBe('https://draft.example.com/v1/models')
    expect((draftInit.headers as Headers).get('authorization')).toBe('Bearer sk-draft-temp')
    expect((draftInit.headers as Headers).get('x-draft')).toBe('draft-val')
    expect((draftInit.headers as Headers).get('x-saved-header')).toBeNull()
    expect(await translationConfigItem.getValue()).toEqual(initialConfig)
    expect(apiKeyStore).toEqual({ key: 'sk-live', origin: 'https://api.example.com' })
    expect(customHeadersStore?.headers).toEqual({ 'x-saved-header': 'saved-val' })

    // 同源省略草稿时复用已保存的 key 与自定义头
    const savedReply = await trigger(
      {
        type: 'wt:list-models',
        baseUrl: 'https://api.example.com/v1/chat/completions',
        requestId: 'req-saved',
      },
      extSender,
    )
    expect(savedReply).toEqual({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [, savedInit] = fetcher.mock.calls[1] as [string, RequestInit]
    expect((savedInit.headers as Headers).get('authorization')).toBe('Bearer sk-live')
    expect((savedInit.headers as Headers).get('x-saved-header')).toBe('saved-val')

    // 显式传空对象 customHeaders: {} 时不使用已保存头
    expect(
      await trigger(
        {
          type: 'wt:list-models',
          baseUrl: 'https://api.example.com/v1',
          customHeaders: {},
          requestId: 'req-empty-headers',
        },
        extSender,
      ),
    ).toEqual({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] })
    const [, emptyHeaderInit] = fetcher.mock.calls[2] as [string, RequestInit]
    expect((emptyHeaderInit.headers as Headers).get('x-saved-header')).toBeNull()

    // 跨源未提供草稿 key 或未提供草稿 headers 时拒绝且 fetch 0 次
    fetcher.mockClear()
    expect(
      await trigger(
        {
          type: 'wt:list-models',
          baseUrl: 'https://other.example.com/v1',
          customHeaders: {},
          requestId: 'req-cross-key',
        },
        extSender,
      ),
    ).toEqual({ ok: false, error: '接口来源已改变，请重新输入或删除旧密钥' })
    expect(
      await trigger(
        {
          type: 'wt:list-models',
          baseUrl: 'https://other.example.com/v1',
          apiKey: 'sk-other',
          requestId: 'req-cross-headers',
        },
        extSender,
      ),
    ).toEqual({ ok: false, error: '自定义请求头与当前接口不匹配，请重新填写或清空' })
    expect(fetcher).not.toHaveBeenCalled()

    // cancel-models 精确中止同 scope 的 catalog 请求，不影响其他 scope
    let startedCancel = false
    let cancelSignal: AbortSignal | undefined
    fetcher.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          startedCancel = true
          cancelSignal = init?.signal ?? undefined
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    const pendingCancel = trigger(
      {
        type: 'wt:list-models',
        baseUrl: 'https://api.example.com/v1',
        requestId: 'req-cancel',
      },
      extSender,
    )
    await vi.waitFor(() => expect(startedCancel).toBe(true))
    // 不同 scope 的取消不会中止该请求
    expect(
      await trigger({ type: 'wt:cancel-models', requestId: 'req-cancel' }, { ...extSender, documentId: 'other-doc' }),
    ).toEqual({ ok: true })
    expect(cancelSignal).toBeDefined()
    expect(cancelSignal?.aborted).toBe(false)
    // 同一 scope 取消成功中止
    expect(await trigger({ type: 'wt:cancel-models', requestId: 'req-cancel' }, extSender)).toEqual({ ok: true })
    expect(await pendingCancel).toMatchObject({ ok: false, code: 'cancelled' })

    // 在途期间阅读策略变化不取消 catalog 请求，但连接配置变化会取消
    let releaseConn!: () => void
    let startedConn = false
    let connectionSignal: AbortSignal | undefined
    fetcher.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          startedConn = true
          connectionSignal = init?.signal ?? undefined
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
          releaseConn = () =>
            resolve(
              new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
        }),
    )
    const pendingConn = trigger(
      {
        type: 'wt:list-models',
        baseUrl: 'https://api.example.com/v1',
        requestId: 'req-conn-change',
      },
      extSender,
    )
    await vi.waitFor(() => expect(startedConn).toBe(true))
    // 阅读策略变化（排除站点）不应中止 catalog 请求
    await trigger({ type: 'wt:set-site-excluded', host: 'example.org', excluded: true }, extSender)
    expect(connectionSignal).toBeDefined()
    expect(connectionSignal?.aborted).toBe(false)
    // 连接配置变化（修改 model）中止在途 catalog 请求
    await trigger(
      {
        type: 'wt:save-config',
        patch: { baseUrl: 'https://api.example.com/v1', model: 'new-model' },
      },
      extSender,
    )
    expect(connectionSignal?.aborted).toBe(true)
    releaseConn()
    expect(await pendingConn).toMatchObject({ ok: false, code: 'cancelled' })
  })
})

async function prepareManualPage(url = 'https://page.example/article') {
  await clearManualPages()
  clearAutomaticPause()
  await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: true })
  await translationConfigItem.setValue({
    ...VALID_CONFIG, autoOrigins: [], selectionPopupEnabled: false, proactiveAssistEnabled: false,
  })
  vi.mocked(fakeBrowser.permissions.contains).mockImplementation(async (query) => {
    const origins = (query as { origins?: string[] }).origins ?? []
    return origins.length > 0 && origins.every((origin) => origin === 'https://api.example.com/*')
  })
  const state = {
    url,
    documentId: 'doc-page',
    autoAllowed: false,
    status: { supported: true, fixed: false, auto: false, paused: false, capped: false, failed: 0, error: '' },
  }
  const sender = { ...contentSender, url, documentId: state.documentId }
  const execute = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (options: {
    files?: string[]
    target: { tabId: number; documentIds?: string[] }
  }) => {
    if (options.target.documentIds !== undefined && !options.target.documentIds.includes(state.documentId)) {
      throw new Error('Synthetic document no longer exists')
    }
    return options.files === undefined
      ? [{ frameId: 0, documentId: state.documentId, result: state.url }]
      : []
  }) as never)
  const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (
    _tabId: number, message: { type: string; action?: string },
  ) => {
    if (message.type === 'gcn:page-translation') throw new Error('Receiving end does not exist')
    if (message.type === 'wt:status') return { ok: true, status: { ...state.status } }
    if (message.type === 'wt:refresh') {
      const modeMessage = { type: 'wt:page-modes' } as const
      const reply = await trigger(modeMessage, sender)
      if (!isTranslationReply(reply, modeMessage) || !reply.ok) throw new Error('Synthetic refresh failed')
      state.autoAllowed = reply.modes.auto
      state.status.auto = state.autoAllowed && !state.status.paused
    }
    if (message.type === 'wt:page-action') {
      state.status.paused = message.action === 'restore'
      state.status.auto = message.action === 'resume' && state.autoAllowed
    }
    return { ok: true }
  }) as never)
  vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation(async (id) => ({ id, url: state.url }) as never)
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [{ id: 7, url: state.url }] as never)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
  return { state, sender, execute, send, fetcher }
}

describe('仅本页翻译与会话授权', () => {
  it.each(['content', 'extension'] as const)('%s 入口仅授权当前文档，不改自动站点或永久权限', async (entry) => {
    const { sender, fetcher } = await prepareManualPage()
    expect(await fakeBrowser.permissions.contains({ origins: ['https://page.example/*'] })).toBe(false)
    expect(await trigger({ type: 'wt:translate-page' }, entry === 'content' ? sender : extSender)).toMatchObject({ ok: true })
    expect((await translationConfigItem.getValue()).autoOrigins).toEqual([])
    expect(await fakeBrowser.permissions.contains({ origins: ['https://page.example/*'] })).toBe(false)
    expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({
      ok: true, modes: { auto: true, selection: false, smart: false },
    })
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: [`Authorized synthetic ${entry} page.`],
    }, sender)).toMatchObject({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    for (const wrong of [
      { ...sender, tab: { id: 8 } },
      { ...sender, documentId: 'other-doc' },
      { ...sender, url: 'https://page.example/other' },
      { ...sender, frameId: 1 },
      { ...sender, id: 'other-extension' },
    ]) {
      expect(await trigger({
        type: 'wt:translate', mode: 'auto', texts: [`Authorized synthetic ${entry} page.`],
      }, wrong)).toMatchObject({ ok: false })
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['url', 'document'] as const)('%s 变化后旧授权不能继续请求或替新文档授权', async (change) => {
    const { sender, state, fetcher } = await prepareManualPage()
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    if (change === 'url') state.url = 'https://page.example/next'
    else state.documentId = 'doc-reloaded'
    const current = { ...sender, url: state.url, documentId: state.documentId }
    expect(await trigger({ type: 'wt:page-modes' }, current)).toMatchObject({ ok: true, modes: { auto: false } })
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: false })
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['Navigation must not inherit authorization.'],
    }, current)).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await getManualPageGrant(7, state.documentId, state.url)).toBeUndefined()
  })

  it('只发生 iframe loading 不清授权，顶层URL改变和关页会清对应授权', async () => {
    const { sender } = await prepareManualPage()
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    await putManualPageGrant({ id: 'other-tab', tabId: 8, documentId: 'doc-8', url: 'https://page.example/8' })
    tabUpdated!(7, { status: 'loading' }, { id: 7, url: sender.url } as never)
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeDefined()
    tabUpdated!(7, { url: 'https://page.example/next' }, { id: 7, url: 'https://page.example/next' } as never)
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined()
    expect(await getManualPageGrant(8, 'doc-8', 'https://page.example/8')).toBeDefined()
    await fakeBrowser.tabs.onRemoved.trigger(8, { windowId: 1, isWindowClosing: false })
    expect(await getManualPageGrant(8, 'doc-8', 'https://page.example/8')).toBeUndefined()
  })

  it.each(['permissions', 'master'] as const)('%s 撤销会清除会话授权', async (cause) => {
    const { sender } = await prepareManualPage()
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    if (cause === 'permissions') removedListeners.forEach((listener) => listener({ origins: ['https://page.example/*'] }))
    else await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    await vi.waitFor(async () => expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined())
    expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({ ok: true, modes: { auto: false } })
  })

  it('只有会话存储中的当前文档授权也有效，畸形记录无效', async () => {
    const { sender, fetcher } = await prepareManualPage()
    await fakeBrowser.storage.session.set({
      'wt:manual-pages:v1': [{ id: 'persisted', tabId: 7, documentId: sender.documentId, url: sender.url }],
    })
    expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({ ok: true, modes: { auto: true } })
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['Session-only synthetic authorization.'],
    }, sender)).toMatchObject({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await fakeBrowser.storage.session.set({
      'wt:manual-pages:v1': [{ id: '', tabId: 7, documentId: sender.documentId, url: sender.url }],
    })
    expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({ ok: true, modes: { auto: false } })
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['Session-only synthetic authorization.'],
    }, sender)).toMatchObject({ ok: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('会话数量有界，旧操作回滚不能删除后来的授权', async () => {
    await clearManualPages()
    for (let tabId = 0; tabId < 33; tabId += 1) {
      await putManualPageGrant({ id: `g-${tabId}`, tabId, documentId: `doc-${tabId}`, url: `https://page.example/${tabId}` })
    }
    expect(await getManualPageGrant(0, 'doc-0', 'https://page.example/0')).toBeUndefined()
    const latest = { id: 'latest', tabId: 32, documentId: 'doc-32', url: 'https://page.example/32' }
    await putManualPageGrant(latest)
    await revokeManualPageGrant(32, 'g-32')
    expect(await getManualPageGrant(32, 'doc-32', latest.url)).toEqual(latest)
    expect(await getManualPageGrant(32, 'other-doc', latest.url)).toBeUndefined()
    const stored = await fakeBrowser.storage.session.get('wt:manual-pages:v1')
    expect(stored['wt:manual-pages:v1']).toHaveLength(32)
  })

  it('普通锚点保持文档授权，hash路由变化会失效', async () => {
    const { sender, state, fetcher } = await prepareManualPage()
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    const original = await getManualPageGrant(7, sender.documentId, sender.url)
    state.url = `${sender.url}#section`
    tabUpdated!(7, { url: state.url }, { id: 7, url: state.url } as never)
    expect(await getManualPageGrant(7, sender.documentId, state.url)).toEqual(original)
    const anchored = { ...sender, url: state.url }
    expect(await trigger({ type: 'wt:page-modes' }, anchored)).toMatchObject({ ok: true, modes: { auto: true } })
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['A paragraph after an ordinary anchor remains authorized.'],
    }, anchored)).toMatchObject({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    state.url = `${sender.url}#/other-route`
    tabUpdated!(7, { url: state.url }, { id: 7, url: state.url } as never)
    expect(await getManualPageGrant(7, sender.documentId, state.url)).toBeUndefined()
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['New route must require authorization.'],
    }, { ...sender, url: state.url })).toMatchObject({ ok: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('启动捕获期间仅锚点变化可以完成，文档身份仍一致', async () => {
    const { sender, state } = await prepareManualPage()
    state.url = `${sender.url}#section`
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    expect(await getManualPageGrant(7, sender.documentId, state.url)).toBeDefined()
  })
})

describe('普通页面菜单与启动边界', () => {
  it.each([
    'master', 'scope', 'excluded', 'sensitive', 'missing-model', 'endpoint', 'metadata', 'sender', 'incognito',
  ] as const)('%s 拒绝启动且没有模型请求', async (cause) => {
    const { sender, state, fetcher } = await prepareManualPage(
      cause === 'sensitive' ? 'https://app.devin.ai/#/settings/tokens' : undefined,
    )
    const requestSender = cause === 'sender' ? { ...sender, id: 'other-extension' }
      : cause === 'incognito' ? { ...sender, tab: { id: 7, incognito: true } } : sender
    const config = await translationConfigItem.getValue()
    if (cause === 'master') await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    if (cause === 'scope') await translationConfigItem.setValue({ ...config, siteScopeMode: 'include', siteScopeHosts: ['elsewhere.example'] })
    if (cause === 'excluded') await translationConfigItem.setValue({ ...config, excludedHosts: ['page.example'] })
    if (cause === 'missing-model') await translationConfigItem.setValue({ ...config, model: '' })
    if (cause === 'endpoint') vi.mocked(fakeBrowser.permissions.contains).mockImplementation(async () => false)
    if (cause === 'metadata') {
      vi.mocked(fakeBrowser.permissions.contains).mockImplementation(async (query) => {
        const origins = (query as { origins?: string[] }).origins ?? []
        if (origins.includes('https://api.example.com/*')) state.documentId = 'doc-changed-during-start'
        return origins.length > 0 && origins.every((origin) => origin === 'https://api.example.com/*')
      })
    }
    expect(await trigger({ type: 'wt:translate-page' }, requestSender)).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined()
    expect(await getManualPageGrant(7, state.documentId, state.url)).toBeUndefined()
  })

  it('普通页面菜单实际开始、恢复、继续，不改自动名单', async () => {
    const { sender, state, send, fetcher } = await prepareManualPage()
    const click = () => menuClick!(
      { menuItemId: 'wt-page', pageUrl: sender.url, frameId: 0, editable: false },
      { id: 7, url: sender.url } as never,
    )
    click()
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      7, expect.objectContaining({ type: 'wt:page-action', action: 'resume', url: sender.url }),
      { frameId: 0, documentId: sender.documentId },
    ))
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeDefined()
    click()
    await vi.waitFor(() => expect(state.status.paused).toBe(true))
    click()
    await vi.waitFor(() => expect(state.status.auto).toBe(true))
    expect((await translationConfigItem.getValue()).autoOrigins).toEqual([])
    expect(fakeBrowser.permissions.request).not.toHaveBeenCalled()
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['Native page menu synthetic text.'],
    }, sender)).toMatchObject({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('未配置打开模型设置；嵌入页面显示明确错误且不授权', async () => {
    const { sender, send, fetcher } = await prepareManualPage()
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 90 } as never)
    await translationConfigItem.setValue({ ...VALID_CONFIG, model: '', autoOrigins: [] })
    menuClick!(
      { menuItemId: 'wt-page', pageUrl: sender.url, frameId: 0, editable: false },
      { id: 7, url: sender.url } as never,
    )
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({
      url: fakeBrowser.runtime.getURL('/options.html') + '#wt-title',
    }))
    menuClick!(
      { menuItemId: 'wt-page', pageUrl: sender.url, frameId: 2, frameUrl: 'https://frame.example/private', editable: false },
      { id: 7, url: sender.url } as never,
    )
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(7, {
      type: 'wt:show-selection', text: '', error: '嵌入页面暂不支持整页翻译，请在主页面操作',
    }, { frameId: 0, documentId: sender.documentId }))
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('读取不到顶层文档时打开固定通知，不创建授权', async () => {
    const { sender, execute, fetcher } = await prepareManualPage()
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ id: 90 } as never)
    execute.mockImplementation((async () => []) as never)
    menuClick!(
      { menuItemId: 'wt-page', pageUrl: sender.url, frameId: 0, editable: false },
      { id: 7, url: sender.url } as never,
    )
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({
      url: fakeBrowser.runtime.getURL('/options.html') + '?notice=page-unavailable',
    }))
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('旧启动失败回滚时不能删除另一入口的新授权', async () => {
    const { sender, execute, fetcher } = await prepareManualPage()
    const original = execute.getMockImplementation()!
    let held = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    execute.mockImplementation((async (options: Parameters<typeof fakeBrowser.scripting.executeScript>[0]) => {
      if (options.files !== undefined && !held) {
        held = true
        await gate
        throw new Error('Synthetic first-start injection failure')
      }
      return original(options, undefined as never)
    }) as never)
    const first = trigger({ type: 'wt:translate-page' }, sender)
    await vi.waitFor(() => expect(held).toBe(true))
    expect(await trigger({ type: 'wt:translate-page' }, extSender)).toMatchObject({ ok: true })
    const latest = await getManualPageGrant(7, sender.documentId, sender.url)
    expect(latest).toBeDefined()
    release()
    expect(await first).toMatchObject({ ok: false })
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toEqual(latest)
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['A newer page action remains authorized.'],
    }, sender)).toMatchObject({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('GitHub旧脚本不存在可完成通用翻译，其他发送错误不能吞掉', async () => {
    const { sender, state, send } = await prepareManualPage('https://github.com/example/project')
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    const original = send.getMockImplementation()!
    send.mockImplementation((async (...args: Parameters<typeof fakeBrowser.tabs.sendMessage>) => {
      const message = args[1] as { type?: string }
      if (message.type === 'gcn:page-translation') throw new Error('Synthetic unrelated send error')
      return original(...args)
    }) as never)
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: false })
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined()
    await vi.waitFor(() => expect(state.status.auto).toBe(false))
  })

  it('启动刷新已生效但返回失败时，回滚通知同一文档停止模型翻译', async () => {
    const { sender, state, send, fetcher } = await prepareManualPage()
    const original = send.getMockImplementation()!
    let refreshes = 0
    send.mockImplementation((async (...args: Parameters<typeof fakeBrowser.tabs.sendMessage>) => {
      const reply = await original(...args)
      if ((args[1] as { type?: string }).type === 'wt:refresh') {
        refreshes += 1
        if (refreshes === 1) {
          expect(state.status.auto).toBe(true)
          return { ok: false, error: 'Synthetic acknowledgement failure' }
        }
      }
      return reply
    }) as never)
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: false })
    await vi.waitFor(() => expect(refreshes).toBe(2))
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined()
    expect(state.status.auto).toBe(false)
    expect(send).toHaveBeenLastCalledWith(7, { type: 'wt:refresh' }, {
      frameId: 0, documentId: sender.documentId,
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('启动期间修改网站范围必须撤销这次操作', async () => {
    const { sender, execute, fetcher } = await prepareManualPage()
    const original = execute.getMockImplementation()!
    let held = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    execute.mockImplementation((async (options: Parameters<typeof fakeBrowser.scripting.executeScript>[0]) => {
      if (options.files !== undefined && !held) {
        held = true
        await gate
      }
      return original(options, undefined as never)
    }) as never)
    const pending = trigger({ type: 'wt:translate-page' }, sender)
    await vi.waitFor(() => expect(held).toBe(true))
    await translationConfigItem.setValue({
      ...(await translationConfigItem.getValue()), siteScopeMode: 'include', siteScopeHosts: ['elsewhere.example'],
    })
    expect(await trigger({ type: 'wt:page-modes' }, sender)).toMatchObject({ ok: true, modes: { auto: false } })
    release()
    expect(await pending).toMatchObject({ ok: false })
    expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('授权撤销后右键继续必须重新取得当前文档授权', async () => {
    const { sender, state, fetcher } = await prepareManualPage()
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    await clearManualPages()
    state.status.auto = false
    state.status.paused = true
    menuClick!(
      { menuItemId: 'wt-page', pageUrl: sender.url, frameId: 0, editable: false },
      { id: 7, url: sender.url } as never,
    )
    await vi.waitFor(async () => expect(await getManualPageGrant(7, sender.documentId, sender.url)).toBeDefined())
    expect(await trigger({
      type: 'wt:translate', mode: 'auto', texts: ['Explicit resume on this document is authorized again.'],
    }, sender)).toMatchObject({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await translationConfigItem.getValue()).autoOrigins).toEqual([])
  })

  it.each(['restore', 'resume', 'retry-failed'] as const)('指定页面的%s不跟随另一活动标签页', async (action) => {
    const { sender, send } = await prepareManualPage()
    const query = vi.mocked(fakeBrowser.tabs.query).mockImplementation(async () => [
      { id: 8, url: 'https://other.example/article' },
    ] as never)
    query.mockClear()
    send.mockClear()
    expect(await trigger({
      type: 'wt:page-action', action, tabId: 7, url: sender.url,
    }, extSender)).toMatchObject({ ok: true })
    expect(query).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(7, {
      type: 'wt:page-action', action, url: sender.url,
    }, { frameId: 0, documentId: sender.documentId })
  })

  it('指定页面已经换页时不发送动作，普通锚点仍可恢复', async () => {
    const { sender, state, send } = await prepareManualPage()
    const message = { type: 'wt:page-action', action: 'restore', tabId: 7, url: sender.url }
    state.url = 'https://page.example/another'
    send.mockClear()
    expect(await trigger(message, extSender)).toMatchObject({ ok: false })
    expect(send).not.toHaveBeenCalled()
    state.url = `${sender.url}#section`
    expect(await trigger(message, extSender)).toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith(7, {
      type: 'wt:page-action', action: 'restore', url: sender.url,
    }, { frameId: 0, documentId: sender.documentId })
  })

  it('指定无痕标签页拒绝动作', async () => {
    const { sender, send } = await prepareManualPage()
    vi.mocked(fakeBrowser.tabs.get).mockImplementation(async () => ({
      id: 7, url: sender.url, incognito: true,
    }) as never)
    send.mockClear()
    expect(await trigger({
      type: 'wt:page-action', action: 'restore', tabId: 7, url: sender.url,
    }, extSender)).toMatchObject({ ok: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('本页授权的切换快捷键允许捕获后的普通锚点变化', async () => {
    const { sender, state, send } = await prepareManualPage()
    expect(await trigger({ type: 'wt:translate-page' }, sender)).toMatchObject({ ok: true })
    state.url = `${sender.url}#section`
    tabUpdated!(7, { url: state.url }, { id: 7, url: state.url } as never)
    send.mockClear()
    commandTrigger!('toggle-page-translation', { id: 7, url: sender.url } as never)
    await vi.waitFor(() => expect(state.status.paused).toBe(true))
    expect(send).toHaveBeenCalledWith(7, {
      type: 'wt:page-action', action: 'restore', url: sender.url,
    }, { frameId: 0 })
    expect(await getManualPageGrant(7, sender.documentId, state.url)).toBeDefined()
  })
})

describe('悬浮模型设置入口', () => {
  it('定向模型设置，且保留来源检查', async () => {
    await translationConfigItem.setValue({ ...DEFAULT_TRANSLATION_CONFIG, floatingButtonEnabled: true })
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async () => ({ id: 90 } as never))
    const open = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockImplementation(async () => undefined)
    expect(await trigger({ type: 'wt:open-options', section: 'model' }, contentSender)).toMatchObject({ ok: true })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({ url: fakeBrowser.runtime.getURL('/options.html') + '#wt-title' })
    expect(open).not.toHaveBeenCalled()
    expect(await trigger({ type: 'wt:open-options', section: 'model' }, { ...contentSender, id: 'foreign' })).toMatchObject({ ok: false })
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('输入翻译自动处理边界与字幕移除', () => {
  it('仅保留 input 模式，自动弹窗关闭不阻断明确开启的自动输入', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true, autoOrigins: [], autoInteractionEnabled: false })
    const reply = await trigger({ type: 'wt:page-modes' }, contentSender)
    expect(reply).toMatchObject({ ok: true, modes: { auto: false, input: true } })
    expect(reply).not.toHaveProperty('modes.subtitles')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['English']))
    expect(await trigger({ type: 'wt:translate', mode: 'input', texts: ['中文'], requestId: 'auto-input-1' }, contentSender)).toEqual({ ok: true, texts: ['English'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('已移除的字幕模式及输入命令被拒绝，不发起请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = vi.fn()
    const handled = await fakeBrowser.runtime.onMessage.trigger({ type: 'wt:translate', mode: 'subtitle', texts: ['English'], requestId: 'removed-sub' }, contentSender as Browser.runtime.MessageSender, reply)
    expect(handled).not.toContain(true)
    expect(reply).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('未开启、无站点权限、敏感页、排除站点及网站范围外均拒绝输入处理', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['English']))
    const message = { type: 'wt:translate', mode: 'input', texts: ['中文'], requestId: 'input-denied' } as const
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: false })
    expect(await trigger(message, contentSender)).toMatchObject({ ok: false })
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true })
    expect(await trigger(message, { ...contentSender, url: 'https://app.devin.ai/settings/tokens' })).toMatchObject({ ok: false })
    expect(await trigger(message, { ...contentSender, frameId: 1 })).toMatchObject({ ok: false })
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true, excludedHosts: ['app.devin.ai'] })
    expect(await trigger(message, contentSender)).toMatchObject({ ok: false })
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true, siteScopeMode: 'include', siteScopeHosts: ['other.example'] })
    expect(await trigger(message, contentSender)).toMatchObject({ ok: false })
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true })
    await putManualPageGrant({ id: 'manual-input-deny', tabId: 7, documentId: 'doc-top', url: contentSender.url })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async permission => !(permission.origins ?? []).includes('https://app.devin.ai/*'))
    expect(await trigger(message, contentSender)).toMatchObject({ ok: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('输入方向独立于网页，不访问持久缓存或附带阅读语境', async () => {
    const prompts: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content: string }> }
      prompts.push(body.messages?.[0]?.content ?? '')
      return completionReply(['Translated draft'])
    })
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true, autoOrigins: [], targetLanguage: 'ja', sourceLanguage: 'en' })
    expect(await trigger({ type: 'wt:translate', mode: 'input', texts: ['中文草稿'], requestId: 'input-direction-1' }, contentSender)).toEqual({ ok: true, texts: ['Translated draft'] })
    expect(prompts.at(-1)).toContain('into natural, accurate English')
    expect(prompts.at(-1)).not.toContain('Japanese')
    expect(prompts.at(-1)).not.toContain('app.devin.ai')
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true, targetLanguage: 'ja', inputSourceLanguage: 'fr', inputTargetLanguage: 'es' })
    expect(await trigger({ type: 'wt:translate', mode: 'input', texts: ['Bonjour tout le monde'], requestId: 'input-direction-2' }, contentSender)).toEqual({ ok: true, texts: ['Translated draft'] })
    expect(prompts.at(-1)).toContain('into natural, accurate Spanish')
    expect(prompts.at(-1)).toContain('The source language is French.')
    expect((await translationConfigItem.getValue()).targetLanguage).toBe('ja')
    expect(readPersistentTranslations).not.toHaveBeenCalled()
    expect(writePersistentTranslations).not.toHaveBeenCalled()
  })

  it('新输入取消同标签页旧请求，关闭输入功能取消在途请求', async () => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, inputTranslationEnabled: true })
    const signals: AbortSignal[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init?.signal as AbortSignal
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error)
      }))
    })
    const first = trigger({ type: 'wt:translate', mode: 'input', texts: ['第一段中文'], requestId: 'input-old' }, contentSender)
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    const second = trigger({ type: 'wt:translate', mode: 'input', texts: ['第二段中文'], requestId: 'input-new' }, contentSender)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    expect(await first).toMatchObject({ ok: false, code: 'cancelled' })
    await trigger({ type: 'wt:save-config', patch: { inputTranslationEnabled: false } }, extSender)
    expect(signals[1]?.aborted).toBe(true)
    expect(await second).toMatchObject({ ok: false, code: 'cancelled' })
  })
})

describe('Discord 输入替换授权', () => {
  const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const discordMessage = {
    type: 'wt:replace-discord-input',
    elementId,
    expectedText: '你好',
    text: 'Hello',
  } as const

  beforeEach(async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    await settingsItem.setValue(DEFAULT_SETTINGS)
    await clearPersistentTranslations()
    vi.mocked(readPersistentTranslations).mockClear()
    vi.mocked(writePersistentTranslations).mockClear()
  })

  function discordSender(patch: Record<string, unknown> = {}) {
    return { ...contentSender, documentId: 'doc-discord', url: 'https://discord.com/channels/@me/1', ...patch }
  }

  it('只向发送者自己的顶层 documentId 注入 MAIN 世界函数，不读翻译接口或持久缓存', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
    })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation(async () => ([
      { frameId: 0, documentId: 'doc-discord', result: 'ok' },
    ]) as never)
    const reply = await trigger(discordMessage, discordSender())
    expect(reply).toEqual({ ok: true, inputReplacement: 'ok' })
    expect(exec).toHaveBeenCalledTimes(1)
    const injection = exec.mock.calls[0]?.[0]
    expect(injection).toMatchObject({
      target: { tabId: 7, documentIds: ['doc-discord'] },
      world: 'MAIN',
      func: replaceDiscordDraftInMainWorld,
      args: [{ elementId, expectedText: '你好', text: 'Hello' }],
    })
    expect(injection?.target && 'frameIds' in injection.target).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    expect(writePersistentTranslations).not.toHaveBeenCalled()

    exec.mockImplementation(async () => ([
      { frameId: 0, documentId: 'doc-discord', result: 'nope' },
    ]) as never)
    expect(await trigger(discordMessage, discordSender())).toEqual({ ok: true, inputReplacement: 'failed' })
    exec.mockImplementation(async () => ([
      { frameId: 1, documentId: 'doc-discord', result: 'ok' },
    ]) as never)
    expect(await trigger(discordMessage, discordSender())).toEqual({ ok: true, inputReplacement: 'failed' })
    exec.mockImplementation(async () => ([
      { frameId: 0, documentId: 'other-doc', result: 'ok' },
    ]) as never)
    expect(await trigger(discordMessage, discordSender())).toEqual({ ok: true, inputReplacement: 'failed' })
    exec.mockRejectedValue(new Error('draft 你好 should not leak'))
    const failed = await trigger(discordMessage, discordSender())
    expect(failed).toMatchObject({ ok: false, error: '无法连接翻译服务' })
    expect(JSON.stringify(failed)).not.toContain('你好')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('错误主机、缺 documentId、子框架、扩展页、功能关闭、撤权和排除站点都不注入', async () => {
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
    })

    expect(await trigger(discordMessage, discordSender({ url: 'https://evil-discord.com/channels/@me/1' }))).toMatchObject({ ok: false })
    expect(await trigger(discordMessage, discordSender({ documentId: '' }))).toMatchObject({ ok: false })
    expect(await trigger(discordMessage, discordSender({ frameId: 1 }))).toMatchObject({ ok: false })
    expect(await trigger(discordMessage, extSender)).toMatchObject({ ok: false })
    expect(await trigger(discordMessage, discordSender({ tab: { id: 7, incognito: true } }))).toMatchObject({
      ok: false,
      error: '无痕窗口不启用模型功能',
    })

    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: false,
    })
    expect(await trigger(discordMessage, discordSender())).toMatchObject({ ok: false })

    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
      autoInteractionEnabled: false,
    })
    exec.mockResolvedValueOnce([{ frameId: 0, documentId: 'doc-discord', result: 'ok' }] as never)
    expect(await trigger(discordMessage, discordSender())).toMatchObject({ ok: true, inputReplacement: 'ok' })
    expect(exec).toHaveBeenCalled()
    exec.mockClear()

    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
      excludedHosts: ['discord.com'],
    })
    expect(await trigger(discordMessage, discordSender())).toMatchObject({ ok: false })

    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
      siteScopeMode: 'include',
      siteScopeHosts: ['other.example'],
    })
    expect(await trigger(discordMessage, discordSender())).toMatchObject({ ok: false })

    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
    })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async (perm) => {
      const origins = perm.origins ?? []
      return !origins.includes('https://discord.com/*')
    })
    expect(await trigger(discordMessage, discordSender())).toMatchObject({ ok: false, error: '未授权访问该站点' })
    expect(exec).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(writePersistentTranslations).not.toHaveBeenCalled()
  })
})

describe('聊天输入替换授权', () => {
  const elementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const chatMessage = {
    type: 'wt:replace-chat-input',
    elementId,
    expectedText: '你好',
    text: 'Hello',
  } as const
  const discordMessage = {
    type: 'wt:replace-discord-input',
    elementId,
    expectedText: '你好',
    text: 'Hello',
  } as const

  beforeEach(async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    await settingsItem.setValue(DEFAULT_SETTINGS)
    await clearPersistentTranslations()
    vi.mocked(readPersistentTranslations).mockClear()
    vi.mocked(writePersistentTranslations).mockClear()
  })

  function chatSender(url: string, patch: Record<string, unknown> = {}) {
    return { ...contentSender, documentId: 'doc-chat', url, ...patch }
  }

  it('三个允许的主机注入对应 MAIN 函数和发送者 documentId', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
    })
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation(async () => ([
      { frameId: 0, documentId: 'doc-chat', result: 'ok' },
    ]) as never)
    for (const url of [
      'https://chatgpt.com/c/1',
      'https://claude.ai/chat/1',
      'https://web.telegram.org/a/',
      'https://web.telegram.org/k/1',
      'https://web.whatsapp.com/',
      'https://app.slack.com/client/T/C',
      'https://acme.slack.com/client/T/C',
      'https://teams.microsoft.com/v2/',
      'https://teams.live.com/',
      'https://teams.cloud.microsoft/v2/',
    ]) {
      exec.mockClear()
      expect(await trigger(chatMessage, chatSender(url))).toEqual({ ok: true, inputReplacement: 'ok' })
      expect(exec.mock.calls[0]?.[0]).toMatchObject({
        target: { tabId: 7, documentIds: ['doc-chat'] },
        world: 'MAIN',
        func: replaceChatDraftInMainWorld,
        args: [{ elementId, expectedText: '你好', text: 'Hello' }],
      })
    }
    expect(await trigger(discordMessage, chatSender('https://chatgpt.com/c/1'))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://discord.com/channels/@me/1'))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://chatgpt.com/login'))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://app.slack.com/ssb/redirect'))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://slack.com/client/T'))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://web.whatsapp.com/settings'))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://teams.microsoft.com.evil/v2/'))).toMatchObject({ ok: false })
  })

  it('错误主机、缺 documentId、子框架、扩展页、功能关闭、撤权和排除站点都不注入', async () => {
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never)
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
    })
    expect(await trigger(chatMessage, chatSender('https://chat.openai.com/'))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1', { documentId: '' }))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1', { frameId: 1 }))).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, extSender)).toMatchObject({ ok: false })
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1', { tab: { id: 7, incognito: true } }))).toMatchObject({
      ok: false,
      error: '无痕窗口不启用模型功能',
    })
    await translationConfigItem.setValue({ ...VALID_CONFIG, autoOrigins: [], inputTranslationEnabled: false })
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1'))).toMatchObject({ ok: false })
    await translationConfigItem.setValue({ ...VALID_CONFIG, autoOrigins: [], inputTranslationEnabled: true, autoInteractionEnabled: false })
    exec.mockResolvedValueOnce([{ frameId: 0, documentId: 'doc-chat', result: 'ok' }] as never)
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1'))).toMatchObject({ ok: true, inputReplacement: 'ok' })
    expect(exec).toHaveBeenCalled()
    exec.mockClear()
    await translationConfigItem.setValue({ ...VALID_CONFIG, autoOrigins: [], inputTranslationEnabled: true, excludedHosts: ['claude.ai'] })
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1'))).toMatchObject({ ok: false })
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      autoOrigins: [],
      inputTranslationEnabled: true,
      siteScopeMode: 'include',
      siteScopeHosts: ['other.example'],
    })
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1'))).toMatchObject({ ok: false })
    await translationConfigItem.setValue({ ...VALID_CONFIG, autoOrigins: [], inputTranslationEnabled: true })
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async (perm) => {
      const origins = perm.origins ?? []
      return !origins.includes('https://claude.ai/*')
    })
    expect(await trigger(chatMessage, chatSender('https://claude.ai/chat/1'))).toMatchObject({ ok: false, error: '未授权访问该站点' })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('wt:translate-text 文本翻译窗口', () => {
  const textSender = { id: '', url: '' }
  const popupSender = { id: '', url: '' }
  const message = {
    type: 'wt:translate-text',
    text: 'Hello **world**\n第二行',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    requestId: 'text-req-1',
  } as const

  beforeEach(() => {
    textSender.id = fakeBrowser.runtime.id
    textSender.url = fakeBrowser.runtime.getURL('/translate.html')
    popupSender.id = fakeBrowser.runtime.id
    popupSender.url = fakeBrowser.runtime.getURL('/popup.html')
  })

  function textMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...message, ...overrides }
  }

  it.each([
    ['内容脚本', contentSender],
    ['弹出页', popupSender],
    ['选项页', extSender],
    ['其他扩展', pageSender],
    ['普通扩展页', { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL('/options.html#x') }],
    ['错误路径', { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL('/translate.html.evil') }],
  ])('%s 发送 wt:translate-text 被拒绝且不发请求', async (_name, sender) => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger(textMessage(), sender)
    expect(reply).toEqual({ ok: false, error: '无权访问' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('文本翻译窗口按消息中的语言翻译，不改全局配置', async () => {
    await translationConfigItem.setValue({
      ...VALID_CONFIG,
      targetLanguage: 'zh-CN',
      sourceLanguage: 'auto',
      inputTargetLanguage: 'en',
      inputSourceLanguage: 'auto',
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    const reply = await trigger(textMessage({ sourceLanguage: 'en', targetLanguage: 'ja' }), textSender)
    expect(reply).toEqual({ ok: true, texts: ['译文'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const init = (fetcher.mock.calls[0] as [string, RequestInit])[1]
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] }
    expect(body.messages[0]!.content).toContain('Japanese')
    expect(body.messages[0]!.content).toContain('The source language is English.')
    expect(body.messages[0]!.content).not.toContain('Simplified Chinese')
    expect(JSON.parse(body.messages[1]!.content)).toEqual(['Hello **world**\n第二行'])
    const saved = await translationConfigItem.getValue()
    expect(saved.targetLanguage).toBe('zh-CN')
    expect(saved.sourceLanguage).toBe('auto')
    expect(saved.inputTargetLanguage).toBe('en')
    expect(saved.inputSourceLanguage).toBe('auto')
  })

  it('粘贴文本不写入持久缓存', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completionReply(['译文']))
    const writeSpy = vi.mocked(writePersistentTranslations)
    const readSpy = vi.mocked(readPersistentTranslations)
    writeSpy.mockClear()
    readSpy.mockClear()
    expect(await trigger(textMessage(), textSender)).toEqual({ ok: true, texts: ['译文'] })
    expect(writeSpy).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('总开关关闭不发请求', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    await translationConfigItem.setValue(VALID_CONFIG)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger(textMessage(), textSender)
    expect(reply).toMatchObject({ ok: false, error: '总开关已关闭' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['缺少接口地址', { baseUrl: '' }],
    ['缺少模型', { model: '' }],
  ])('%s 不发请求', async (_name, patch) => {
    await translationConfigItem.setValue({ ...VALID_CONFIG, ...patch })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger(textMessage(), textSender)
    expect(reply).toMatchObject({ ok: false, error: '请先配置接口地址与模型' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('缺少接口权限不发请求', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async (query) => {
      const origins = (query as { origins?: string[] }).origins ?? []
      return !origins.some((o) => o.includes('api.example.com'))
    })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const reply = await trigger(textMessage(), textSender)
    expect(reply).toMatchObject({ ok: false, error: '未授权访问该接口地址' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('非法消息被拒绝且无回复', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    for (const invalid of [
      textMessage({ text: '   ' }),
      textMessage({ text: 'x'.repeat(6001) }),
      textMessage({ sourceLanguage: 'xx' }),
      textMessage({ targetLanguage: 'zh' }),
      textMessage({ requestId: 'bad id!' }),
      textMessage({ pageSession: 'bad id!' }),
      textMessage({ extra: true }),
      { type: 'wt:translate-text', text: 'hi' },
    ]) {
      const reply = await Promise.race([
        trigger(invalid, textSender),
        new Promise((resolve) => setTimeout(() => resolve('no-reply'), 50)),
      ])
      expect(reply).toBe('no-reply')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('重复 requestId 被拒绝，原请求仍可取消', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    let signal: AbortSignal | undefined
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    const pending = trigger(textMessage(), textSender)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect(await trigger(textMessage(), textSender)).toMatchObject({ ok: false, error: '请求 ID 重复' })
    expect(signal!.aborted).toBe(false)
    await trigger({ type: 'wt:cancel-assist', requestId: 'text-req-1' }, textSender)
    expect(signal!.aborted).toBe(true)
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('内容脚本的取消按自身作用域查找，无法中止文本翻译窗口的请求', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    let signal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    const pending = trigger(textMessage(), textSender)
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(await trigger({ type: 'wt:cancel-assist', requestId: 'text-req-1' }, contentSender)).toEqual({ ok: true })
    expect(signal!.aborted).toBe(false)
    await trigger({ type: 'wt:cancel-assist', requestId: 'text-req-1' }, textSender)
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('页面会话断开中止在途请求', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const session = 'text-page-1'
    const listeners: ((port: unknown) => void)[] = []
    const port = {
      name: `wt:page:${session}`,
      sender: textSender,
      disconnect: vi.fn(),
      onDisconnect: { addListener: (listener: (port: unknown) => void) => listeners.push(listener) },
    }
    portConnect!(port)
    let signal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    const pending = trigger(textMessage({ pageSession: session }), textSender)
    await vi.waitFor(() => expect(signal).toBeDefined())
    listeners.forEach((listener) => listener(port))
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    expect(signal!.aborted).toBe(true)
  })

  it('已结束的页面会话直接取消，不发请求', async () => {
    await translationConfigItem.setValue(VALID_CONFIG)
    const session = 'text-page-2'
    const listeners: ((port: unknown) => void)[] = []
    const port = {
      name: `wt:page:${session}`,
      sender: textSender,
      disconnect: vi.fn(),
      onDisconnect: { addListener: (listener: (port: unknown) => void) => listeners.push(listener) },
    }
    portConnect!(port)
    listeners.forEach((listener) => listener(port))
    const fetcher = vi.spyOn(globalThis, 'fetch')
    expect(await trigger(textMessage({ pageSession: session }), textSender)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('wt:document-input 桥接授权', () => {
  const elementId = '123e4567-e89b-42d3-a456-426614174000'
  const docConfig = { ...VALID_CONFIG, inputTranslationEnabled: true }
  const topSender = { ...contentSender, tab: { id: 7, url: 'https://app.devin.ai/work' } }
  const frameSender = {
    ...topSender,
    frameId: 3,
    documentId: 'doc-frame',
    url: 'about:blank',
    origin: 'https://app.devin.ai',
  }

  function bridgeMock(
    result: unknown = { status: 'ok', text: '文本', canReplace: true },
    frameId = 0,
  ) {
    return vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: {
      world?: string
      target?: { documentIds?: string[] }
    }) => {
      if (opts.world === 'MAIN') {
        const documentId = opts.target?.documentIds?.[0] ?? ''
        return [{ frameId, documentId, result }]
      }
      return [{
        frameId: 3,
        documentId: 'doc-frame',
        result: { url: 'about:blank', topUrl: 'https://app.devin.ai/work', focused: false },
      }]
    }) as never)
  }

  beforeEach(async () => {
    await translationConfigItem.setValue(docConfig)
    topSender.id = fakeBrowser.runtime.id
    frameSender.id = fakeBrowser.runtime.id
    vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation(
      async (id) => ({ id, url: 'https://app.devin.ai/work' }) as never,
    )
  })

  it('顶层 read 经 MAIN world 执行并返回 editor 结果', async () => {
    const exec = bridgeMock()
    const reply = await trigger({ type: 'wt:document-input', elementId, action: 'read' }, topSender)
    expect(reply).toMatchObject({ ok: true, editor: { status: 'ok', text: '文本' } })
    const mainCall = exec.mock.calls.map((call) => call[0] as { world?: string; args?: unknown[] }).find((o) => o.world === 'MAIN')
    expect(mainCall?.args?.[0]).toEqual({ elementId, action: 'read' })
  })

  it('同源 about:blank 子框架 read 允许，replace 校验 expectedText/text', async () => {
    bridgeMock({ status: 'ok', text: '文本', canReplace: true }, 3)
    const read = await trigger({ type: 'wt:document-input', elementId, action: 'read' }, frameSender)
    expect(read).toMatchObject({ ok: true })
    const replace = await trigger(
      { type: 'wt:document-input', elementId, action: 'replace', expectedText: 'a', text: 'b' },
      frameSender,
    )
    expect(replace).toMatchObject({ ok: true })
  })

  it.each([
    ['输入翻译关闭', async () => { await translationConfigItem.setValue({ ...docConfig, inputTranslationEnabled: false }) }, [topSender]],
    ['站点排除', async () => { await translationConfigItem.setValue({ ...docConfig, excludedHosts: ['app.devin.ai'] }) }, [topSender]],
    ['主开关关闭', async () => { await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false }) }, [topSender]],
    ['权限拒绝', async () => { vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => false) }, [topSender]],
    ['跨源框架', async () => { void 0 }, [{ ...frameSender, url: 'https://evil.example/x', origin: 'https://evil.example' }]],
    ['sandbox null origin', async () => { void 0 }, [{ ...frameSender, origin: 'null' }]],
    ['扩展页面', async () => { void 0 }, [extSender]],
    ['普通外部内容', async () => { void 0 }, [{ ...topSender, id: 'other-extension' }]],
    ['标签页已变化', async () => { vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation(async (id) => ({ id, url: 'https://other.example/' }) as never) }, [frameSender]],
  ])('%s 时拒绝且不执行桥接', async (_name, arrange, senders) => {
    await arrange()
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript')
    for (const sender of senders) {
      const reply = await trigger({ type: 'wt:document-input', elementId, action: 'read' }, sender)
      expect(reply).toMatchObject({ ok: false })
    }
    expect(exec.mock.calls.filter((call) => (call[0] as { world?: string }).world === 'MAIN')).toHaveLength(0)
  })

  it('桥接返回不匹配的 documentId/frameId 或非法结果被拒绝', async () => {
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (opts: { world?: string }) => {
      if (opts.world === 'MAIN') {
        return [{ frameId: 0, documentId: 'stale-doc', result: { status: 'ok', text: 'x', canReplace: true } }]
      }
      return []
    }) as never)
    const reply = await trigger({ type: 'wt:document-input', elementId, action: 'read' }, topSender)
    expect(reply).toMatchObject({ ok: false })
  })

  it('read 结果 text 超过 6000 或为空时拒绝', async () => {
    bridgeMock({ status: 'ok', text: 'x'.repeat(6001), canReplace: true })
    const reply = await trigger({ type: 'wt:document-input', elementId, action: 'read' }, topSender)
    expect(reply).toMatchObject({ ok: false })
  })
})

describe('inputFrameUrl 同源策略', () => {
  it('接受同源 http(s) 与 about:blank/srcdoc，拒绝跨源、凭据与非法协议', async () => {
    const { inputFrameUrl } = await import('../../../src/translation/input-frame')
    const top = 'https://app.devin.ai/work'
    expect(inputFrameUrl(top, 'about:blank')).toBe(top)
    expect(inputFrameUrl(top, 'about:srcdoc')).toBe(top)
    expect(inputFrameUrl(top, 'https://app.devin.ai/frame')).toBe('https://app.devin.ai/frame')
    expect(inputFrameUrl('http://a.example/', 'http://a.example/f')).toBe('http://a.example/f')
    expect(inputFrameUrl(top, 'https://evil.example/x')).toBeUndefined()
    expect(inputFrameUrl(top, 'https://app.devin.ai:8443/x')).toBeUndefined()
    expect(inputFrameUrl(top, 'https://user@app.devin.ai/x')).toBeUndefined()
    expect(inputFrameUrl(top, 'https://app.devin.ai@evil.example/x')).toBeUndefined()
    expect(inputFrameUrl(top, 'chrome-extension://abc/x')).toBeUndefined()
    expect(inputFrameUrl('not a url', 'about:blank')).toBeUndefined()
    expect(inputFrameUrl('https://user:pw@app.devin.ai/', 'about:blank')).toBeUndefined()
    expect(inputFrameUrl(top, 'javascript:alert(1)')).toBeUndefined()
    expect(inputFrameUrl('', 'about:blank')).toBeUndefined()
  })
})
