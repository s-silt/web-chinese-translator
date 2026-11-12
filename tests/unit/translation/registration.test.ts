import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INPUT_FRAME_SCRIPT_FILES,
  INPUT_FRAME_SCRIPT_ID,
  isYouTubeInputFramePair,
  isYouTubeLiveChatUrl,
  isYouTubePageUrl,
  readInputFrameDocuments,
  readInputFrameSnapshot,
} from '../../../src/translation/input-frame'
import { inputFrameScriptMatches, installSiteScriptSync, SITE_SCRIPT_ID, siteScriptMatches, syncAllSiteScripts, syncSiteTabs } from '../../../src/translation/registration'
import { customDictionariesItem } from '../../../src/translation/custom-dictionaries'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { translationConfigItem, DEFAULT_TRANSLATION_CONFIG } from '../../../src/translation/config'
import { settingsItem, DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { fakeContentScripts } from '../shared/fake-scripting'

const CONFIG = {
  ...DEFAULT_TRANSLATION_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  selectionPopupEnabled: true,
  floatingButtonEnabled: false,
}

beforeEach(async () => {
  fakeBrowser.reset()
  fakeContentScripts()
  await translationConfigItem.setValue(CONFIG)
  await settingsItem.setValue(DEFAULT_SETTINGS)
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => true)
})

describe('输入子框架注册兼容性', () => {
  async function freshSync(): Promise<() => Promise<void>> {
    vi.resetModules()
    return (await import('../../../src/translation/registration')).syncSiteScript
  }

  it.each(['register', 'update'] as const)('%s 遇到旧浏览器不识别属性时降级一次，重复同步不重新写入', async (operation) => {
    const sync = await freshSync()
    const scripts = fakeContentScripts()
    await translationConfigItem.setValue({ ...CONFIG, inputTranslationEnabled: true })
    if (operation === 'update') {
      scripts.registered.push({
        id: INPUT_FRAME_SCRIPT_ID,
        matches: ['https://editor.example/*'],
        js: ['input-frame.js'],
        allFrames: true,
        runAt: 'document_idle',
        persistAcrossSessions: true,
      })
    }
    const method = operation === 'register' ? 'registerContentScripts' : 'updateContentScripts'
    const apply = vi.mocked(fakeBrowser.scripting[method]).getMockImplementation()!
    let rejectedProperty = 0
    const attempts: Array<{ id: string; matchOriginAsFallback?: boolean }> = []
    vi.spyOn(fakeBrowser.scripting, method).mockImplementation(async (definitions) => {
      for (const definition of definitions) {
        if (definition.id === INPUT_FRAME_SCRIPT_ID) {
          const snapshot = { ...definition } as { id: string; matchOriginAsFallback?: boolean }
          attempts.push(snapshot)
          if ('matchOriginAsFallback' in snapshot) {
            rejectedProperty += 1
            throw new TypeError("Error at parameter 'scripts': Error at index 0: Unexpected property: 'matchOriginAsFallback'.")
          }
        }
      }
      await apply(definitions, () => undefined)
    })

    await sync()
    expect(rejectedProperty).toBe(1)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.matchOriginAsFallback).toBe(true)
    expect(attempts[1]).not.toHaveProperty('matchOriginAsFallback')
    expect(scripts.registered.find((script) => script.id === INPUT_FRAME_SCRIPT_ID)).toMatchObject({
      allFrames: true,
      matches: ['http://*/*', 'https://*/*'],
      persistAcrossSessions: true,
    })
    const registerCount = vi.mocked(fakeBrowser.scripting.registerContentScripts).mock.calls.length
    const updateCount = vi.mocked(fakeBrowser.scripting.updateContentScripts).mock.calls.length
    await sync()
    expect(vi.mocked(fakeBrowser.scripting.registerContentScripts).mock.calls).toHaveLength(registerCount)
    expect(vi.mocked(fakeBrowser.scripting.updateContentScripts).mock.calls).toHaveLength(updateCount)

    await translationConfigItem.setValue({
      ...CONFIG,
      inputTranslationEnabled: true,
      siteScopeMode: 'exclude',
      siteScopeHosts: ['blocked.example'],
    })
    await sync()
    expect(scripts.registered.find((script) => script.id === INPUT_FRAME_SCRIPT_ID)).toMatchObject({
      excludeMatches: ['http://*.blocked.example/*', 'https://*.blocked.example/*'],
    })
    expect(scripts.registered.find((script) => script.id === INPUT_FRAME_SCRIPT_ID)).not.toHaveProperty('matchOriginAsFallback')
    expect(rejectedProperty).toBe(1)
  })

  it.each([
    'Cannot access contents of url: missing host permission',
    "Unexpected property: 'unrelatedProperty'.",
    'matchOriginAsFallback: permission denied',
  ])('注册的非兼容性错误原样抛出且不重试：%s', async (message) => {
    const sync = await freshSync()
    fakeContentScripts()
    await translationConfigItem.setValue({ ...CONFIG, inputTranslationEnabled: true })
    const apply = vi.mocked(fakeBrowser.scripting.registerContentScripts).getMockImplementation()!
    const error = new Error(message)
    let inputAttempts = 0
    vi.spyOn(fakeBrowser.scripting, 'registerContentScripts').mockImplementation(async (definitions) => {
      if (definitions.some((definition) => definition.id === INPUT_FRAME_SCRIPT_ID)) {
        inputAttempts += 1
        throw error
      }
      await apply(definitions, () => undefined)
    })
    await expect(sync()).rejects.toBe(error)
    expect(inputAttempts).toBe(1)
  })

  it('更新的权限错误原样抛出，不触发降级或注册', async () => {
    const sync = await freshSync()
    const scripts = fakeContentScripts()
    scripts.registered.push({ id: INPUT_FRAME_SCRIPT_ID, matches: ['https://old.example/*'] })
    await translationConfigItem.setValue({ ...CONFIG, inputTranslationEnabled: true })
    const error = new Error('Permission denied')
    const update = vi.spyOn(fakeBrowser.scripting, 'updateContentScripts').mockRejectedValue(error)
    await expect(sync()).rejects.toBe(error)
    expect(update).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fakeBrowser.scripting.registerContentScripts).mock.calls.flatMap(([definitions]) => definitions))
      .not.toContainEqual(expect.objectContaining({ id: INPUT_FRAME_SCRIPT_ID }))
  })

  it('降级后仍失败时保留错误，不循环重试', async () => {
    const sync = await freshSync()
    fakeContentScripts()
    await translationConfigItem.setValue({ ...CONFIG, inputTranslationEnabled: true })
    const apply = vi.mocked(fakeBrowser.scripting.registerContentScripts).getMockImplementation()!
    const error = new Error('Permission denied after fallback')
    let inputAttempts = 0
    vi.spyOn(fakeBrowser.scripting, 'registerContentScripts').mockImplementation(async (definitions) => {
      if (definitions.some((definition) => definition.id === INPUT_FRAME_SCRIPT_ID)) {
        inputAttempts += 1
        if (inputAttempts === 1) throw new TypeError("Unexpected property: 'matchOriginAsFallback'.")
        throw error
      }
      await apply(definitions, () => undefined)
    })
    await expect(sync()).rejects.toBe(error)
    expect(inputAttempts).toBe(2)
  })
})

describe('syncSiteTabs/sendToTab', () => {
  it('无接收者的刷新回复注入一次再发 refresh', async () => {
    const tabs = [
      { id: 1, url: 'https://app.devin.ai/x' },
      { id: 2, url: 'https://other.example/' },
    ]
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async (query) => {
      if ((query as { url?: string[] }).url !== undefined) return [tabs[0]!] as never
      return tabs as never
    })
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => {
      throw new Error('no receiver')
    })
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation(async () => undefined as never)
    await syncAllSiteScripts()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(((exec.mock.calls[0] as unknown as [{ target: { tabId: number } }])[0].target.tabId)).toBe(1)
  })

  it('正常应答的标签页不重复注入', async () => {
    const tabs = [{ id: 1, url: 'https://app.devin.ai/x' }]
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async (query) => {
      if ((query as { url?: string[] }).url !== undefined) return tabs as never
      return tabs as never
    })
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript')
    await syncAllSiteScripts()
    expect(exec).not.toHaveBeenCalled()
  })

  it('总开关关闭时向所有标签页发 wt:stop', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    const tabs = [
      { id: 1, url: 'https://app.devin.ai/x' },
      { id: 2, url: 'https://other.example/' },
    ]
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => tabs as never)
    const sent: unknown[] = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_id: number, m: unknown) => {
      sent.push(m)
      return { ok: true }
    })
    await syncAllSiteScripts()
    const stops = sent.filter((m) => (m as { type: string }).type === 'wt:stop')
    expect(stops).toHaveLength(2)
  })
})

describe('installSiteScriptSync', () => {
  it('初始执行只做脚本注册，不查询或广播标签页', async () => {
    const registered = vi.spyOn(fakeBrowser.scripting, 'getRegisteredContentScripts')
    const query = vi.spyOn(fakeBrowser.tabs, 'query')
    const sendMessage = vi.spyOn(fakeBrowser.tabs, 'sendMessage')
    installSiteScriptSync()
    await vi.waitFor(() => expect(registered).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(query).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('sendMessage 超时属于不可用，不注入', async () => {
    const tabs = [{ id: 1, url: 'https://app.devin.ai/x' }]
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => tabs as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => await new Promise<never>(() => undefined))
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript')
    await syncAllSiteScripts()
    expect(exec).not.toHaveBeenCalled()
  })

  it('非 enabled 的设置变化不触发重新同步；enabled 变化触发', async () => {
    const registered = vi.spyOn(fakeBrowser.scripting, 'getRegisteredContentScripts')
    installSiteScriptSync()
    await vi.waitFor(() => expect(registered).toHaveBeenCalled())
    const query = vi.spyOn(fakeBrowser.tabs, 'query')
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, translateTime: false })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(query).not.toHaveBeenCalled()
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    await vi.waitFor(() => expect(query).toHaveBeenCalled())
  })
})

describe('siteScriptMatches', () => {
  it('输入子框架同时保留 HTTPS 全站权限与单独授予的 HTTP 来源', async () => {
    vi.mocked(fakeBrowser.permissions.contains).mockImplementation(async (permission) =>
      (permission.origins ?? []).every((origin) => origin === 'https://*/*' || origin === 'http://editor.example/*'),
    )
    const matches = await inputFrameScriptMatches({
      ...CONFIG,
      inputTranslationEnabled: true,
      autoOrigins: ['http://editor.example'],
    })
    expect(matches).toEqual(['http://editor.example/*', 'https://*/*'])
    expect(matches).not.toContain('http://*/*')
  })

  it('已授权的内置与自定义词典 host 进入 matches，未授权与 disabled 不进入', async () => {
    await customDictionariesItem.setValue([
      { id: 'custom:ok12', label: 'T', hosts: ['tools.example.com'], entries: { A: 'a' }, enabled: true },
      { id: 'custom:no12', label: 'N', hosts: ['other.example.com'], entries: { A: 'a' }, enabled: false },
    ])
    vi.mocked(fakeBrowser.permissions.contains).mockImplementation(
      async (perm) => (perm.origins ?? []).every((o) => o !== 'https://*.cursor.com/*'),
    )
    const matches = await siteScriptMatches({ ...CONFIG, disabledDictionaries: ['cursor'], targetLanguage: 'zh-CN', selectionPopupEnabled: false, autoOrigins: [] } as never)
    expect(matches).toContain('https://*.devin.ai/*')
    expect(matches).toContain('https://*.tools.example.com/*')
    expect(matches).not.toContain('https://*.cursor.com/*')
    expect(matches).not.toContain('https://*.other.example.com/*')
  })
})

describe('siteScriptMatches 26 组站点元数据', () => {
  it('新增站点默认匹配，退休站点不再默认匹配', async () => {
    const matches = await siteScriptMatches({
      ...CONFIG, disabledDictionaries: [], targetLanguage: 'zh-CN',
      selectionPopupEnabled: false, autoOrigins: [],
    } as never)
    for (const pattern of [
      'https://*.openrouter.ai/*', 'https://*.bolt.new/*', 'https://*.lovable.dev/*',
      'https://*.app.netlify.com/*', 'https://*.railway.com/*', 'https://*.dashboard.render.com/*',
    ]) expect(matches).toContain(pattern)
    for (const pattern of ['https://*.gitlab.com/*', 'https://*.reddit.com/*', 'https://*.discord.com/*']) {
      expect(matches).not.toContain(pattern)
    }
  })

  it('disabled 删除对应 pattern；拒绝权限不注册', async () => {
    const matches = await siteScriptMatches({
      ...CONFIG, disabledDictionaries: ['openrouter'], targetLanguage: 'zh-CN',
      selectionPopupEnabled: false, autoOrigins: [],
    } as never)
    expect(matches).not.toContain('https://*.openrouter.ai/*')
    expect(matches).toContain('https://*.railway.com/*')
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(
      async (perm) => (perm.origins ?? []).every((o) => o !== 'https://*.railway.com/*'),
    )
    const filtered = await siteScriptMatches({
      ...CONFIG, disabledDictionaries: [], targetLanguage: 'zh-CN',
      selectionPopupEnabled: false, autoOrigins: [],
    } as never)
    expect(filtered).not.toContain('https://*.railway.com/*')
    expect(filtered).toContain('https://*.openrouter.ai/*')
  })

  it('include 只保留名单覆盖的匹配', async () => {
    const matches = await siteScriptMatches({
      ...CONFIG, disabledDictionaries: [], targetLanguage: 'zh-CN',
      selectionPopupEnabled: false, autoOrigins: [],
      siteScopeMode: 'include', siteScopeHosts: ['devin.ai'],
    } as never)
    expect(matches).toContain('https://*.devin.ai/*')
    expect(matches).not.toContain('https://*.openrouter.ai/*')
    expect(matches).not.toContain('https://*.railway.com/*')
  })

  it('selection 关闭且无 autoOrigins 时 include app.devin.ai 保留该主机通配', async () => {
    const matches = await siteScriptMatches({
      ...CONFIG,
      disabledDictionaries: [],
      targetLanguage: 'zh-CN',
      selectionPopupEnabled: false,
      autoOrigins: [],
      siteScopeMode: 'include',
      siteScopeHosts: ['app.devin.ai'],
    })
    expect(matches).toContain('https://*.app.devin.ai/*')
    expect(matches).not.toContain('https://*.devin.ai/*')
    expect(matches).not.toContain('https://*.gitlab.com/*')
  })
})

describe('网站运行范围脚本注册', () => {
  it('exclude 写入 excludeMatches，切回 all 时传空数组清掉', async () => {
    const scripts = fakeContentScripts()
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    await translationConfigItem.setValue({
      ...CONFIG,
      siteScopeMode: 'exclude',
      siteScopeHosts: ['bank.example'],
    })
    await syncAllSiteScripts()
    expect(scripts.registered[0]).toMatchObject({
      excludeMatches: ['http://*.bank.example/*', 'https://*.bank.example/*'],
    })
    await translationConfigItem.setValue({
      ...CONFIG,
      siteScopeMode: 'all',
      siteScopeHosts: ['bank.example'],
    })
    await syncAllSiteScripts()
    expect(scripts.registered[0]).toMatchObject({ excludeMatches: [] })
  })

  it('范围不是 all 时不向名单外标签页注入', async () => {
    await translationConfigItem.setValue({
      ...CONFIG,
      siteScopeMode: 'include',
      siteScopeHosts: ['devin.ai'],
      selectionPopupEnabled: true,
    })
    const tabs = [
      { id: 1, url: 'https://app.devin.ai/x' },
      { id: 2, url: 'https://other.example/' },
      { id: 3 },
    ]
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => tabs as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => {
      throw new Error('no receiver')
    })
    const injected: number[] = []
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation(async (injection) => {
      injected.push((injection as { target: { tabId: number } }).target.tabId)
      return undefined as never
    })
    await syncAllSiteScripts()
    expect(injected).toEqual([1])
  })

  it('include 空名单注销旧脚本', async () => {
    const scripts = fakeContentScripts()
    scripts.registered.push({
      id: 'wt-sites',
      matches: ['https://*.devin.ai/*'],
      js: ['web-translate.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    })
    await settingsItem.setValue(DEFAULT_SETTINGS)
    await translationConfigItem.setValue({
      ...CONFIG,
      selectionPopupEnabled: false,
      autoOrigins: [],
      siteScopeMode: 'include',
      siteScopeHosts: [],
    })
    await syncAllSiteScripts()
    expect(scripts.registered).toEqual([])
  })

  it('只有 floating 开启也返回 HTTP patterns；未授权不扩大', async () => {
    const opened = await siteScriptMatches({
      ...DEFAULT_TRANSLATION_CONFIG,
      selectionPopupEnabled: false,
      floatingButtonEnabled: true,
    })
    expect(opened).toEqual(['http://*/*', 'https://*/*'])
    vi.mocked(fakeBrowser.permissions.contains).mockImplementation(async () => false)
    const denied = await siteScriptMatches({
      ...DEFAULT_TRANSLATION_CONFIG,
      selectionPopupEnabled: false,
      floatingButtonEnabled: true,
    })
    expect(denied).not.toContain('http://*/*')
    expect(denied).not.toContain('https://*/*')
    expect(denied).toEqual([])
  })

  it('仅开启输入翻译时匹配已授权全站并遵守网站运行范围', async () => {
    for (const flag of [{ inputTranslationEnabled: true }] as const) {
      const matches = await siteScriptMatches({
        ...DEFAULT_TRANSLATION_CONFIG,
        selectionPopupEnabled: false,
        floatingButtonEnabled: false,
        ...flag,
      })
      expect(matches).toEqual(['http://*/*', 'https://*/*'])

      const scoped = await siteScriptMatches({
        ...DEFAULT_TRANSLATION_CONFIG,
        selectionPopupEnabled: false,
        floatingButtonEnabled: false,
        siteScopeMode: 'include',
        siteScopeHosts: ['youtube.com'],
        ...flag,
      })
      expect(scoped).toEqual(['http://*.youtube.com/*', 'https://*.youtube.com/*'])
    }
  })

  it('floating 开启时 include 收窄匹配，exclude 仍写入排除', async () => {
    const included = await siteScriptMatches({
      ...DEFAULT_TRANSLATION_CONFIG,
      selectionPopupEnabled: false,
      floatingButtonEnabled: true,
      siteScopeMode: 'include',
      siteScopeHosts: ['devin.ai'],
    })
    expect(included).toEqual(['http://*.devin.ai/*', 'https://*.devin.ai/*'])
    const scripts = fakeContentScripts()
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    await translationConfigItem.setValue({
      ...DEFAULT_TRANSLATION_CONFIG,
      selectionPopupEnabled: false,
      floatingButtonEnabled: true,
      siteScopeMode: 'exclude',
      siteScopeHosts: ['bank.example'],
    })
    await syncAllSiteScripts()
    expect(scripts.registered[0]).toMatchObject({
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches: ['http://*.bank.example/*', 'https://*.bank.example/*'],
    })
  })

  it('同配置且 excludeMatches 缺省时不 update', async () => {
    const scripts = fakeContentScripts()
    scripts.registered.push({
      id: 'wt-sites',
      matches: ['http://*/*', 'https://*/*'],
      js: ['web-translate.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    })
    const update = vi.mocked(fakeBrowser.scripting.updateContentScripts)
    update.mockClear()
    await settingsItem.setValue(DEFAULT_SETTINGS)
    await translationConfigItem.setValue(CONFIG)
    await syncAllSiteScripts()
    expect(update).not.toHaveBeenCalled()
    expect(scripts.registered).toHaveLength(1)
  })
})

describe('同源输入子框架注册与同步', () => {
  it('普通编辑器仅注入同源与继承来源框架，排除站、敏感页和范围外仍停止', async () => {
    let topUrl = 'https://editor.example/document'
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [{ id: 19, url: topUrl }] as never)
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({ ok: true }))
    const injected: unknown[] = []
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (injection: {
      target: unknown; files?: unknown; func?: unknown
    }) => {
      if (injection.func === readInputFrameSnapshot) {
        return [
          { frameId: 0, documentId: 'top', result: { url: topUrl, topUrl, focused: false } },
          { frameId: 2, documentId: 'same', result: { url: 'https://editor.example/frame', topUrl, focused: true } },
          { frameId: 3, documentId: 'blank', result: { url: 'about:blank', topUrl, focused: false } },
          { frameId: 4, documentId: 'srcdoc', result: { url: 'about:srcdoc', topUrl, focused: false } },
          { frameId: 5, documentId: 'cross', result: { url: 'https://other.example/frame', topUrl, focused: false } },
          { frameId: 6, documentId: 'sensitive', result: { url: 'https://editor.example/account', topUrl, focused: false } },
          { frameId: 7, documentId: 'stale', result: { url: 'https://editor.example/frame', topUrl: 'https://editor.example/previous', focused: false } },
        ]
      }
      injected.push(injection.target)
      return []
    }) as never)
    await translationConfigItem.setValue({ ...CONFIG, inputTranslationEnabled: true })
    await syncAllSiteScripts()
    expect(injected).toEqual([
      { tabId: 19, documentIds: ['same'] },
      { tabId: 19, documentIds: ['blank'] },
      { tabId: 19, documentIds: ['srcdoc'] },
    ])
    for (const patch of [
      { excludedHosts: ['editor.example'] },
      { siteScopeMode: 'include' as const, siteScopeHosts: ['other.example'] },
      { inputTranslationEnabled: false },
    ]) {
      injected.length = 0
      send.mockClear()
      await translationConfigItem.setValue({ ...CONFIG, inputTranslationEnabled: true, ...patch })
      await syncSiteTabs(
        { ...CONFIG, inputTranslationEnabled: true },
        { ...CONFIG, inputTranslationEnabled: true, ...patch },
      )
      expect(injected).toEqual([])
      expect(send).toHaveBeenCalledWith(19, { type: 'wt:stop-input-frame' })
    }
    injected.length = 0
    send.mockClear()
    topUrl = 'https://editor.example/account'
    await translationConfigItem.setValue({ ...CONFIG, inputTranslationEnabled: true })
    await syncAllSiteScripts()
    expect(injected).toEqual([])
    expect(send).toHaveBeenCalledWith(19, { type: 'wt:stop-input-frame' })
  })

  it('URL 纯函数与快照解析严格校验同源 YouTube live_chat', async () => {
    expect(isYouTubePageUrl('https://www.youtube.com/watch?v=fixture')).toBe(true)
    expect(isYouTubePageUrl('https://youtube.com/live/fixture')).toBe(true)
    expect(isYouTubePageUrl('http://www.youtube.com/watch?v=fixture')).toBe(false)
    expect(isYouTubePageUrl('https://www.youtube.com:8443/watch?v=fixture')).toBe(false)
    expect(isYouTubePageUrl('https://user:pass@www.youtube.com/watch?v=fixture')).toBe(false)
    expect(isYouTubePageUrl('https://music.youtube.com/watch?v=fixture')).toBe(false)
    expect(isYouTubePageUrl('https://youtube.com.evil.test/watch?v=fixture')).toBe(false)

    expect(isYouTubeLiveChatUrl('https://www.youtube.com/live_chat?v=fixture')).toBe(true)
    expect(isYouTubeLiveChatUrl('https://youtube.com/live_chat?is_popout=1')).toBe(true)
    expect(isYouTubeLiveChatUrl('https://www.youtube.com/live_chat_replay?v=fixture')).toBe(false)
    expect(isYouTubeLiveChatUrl('https://www.youtube.com/live_chat/extra')).toBe(false)
    expect(isYouTubeLiveChatUrl('https://www.youtube.com/watch?v=fixture')).toBe(false)

    expect(
      isYouTubeInputFramePair(
        'https://www.youtube.com/watch?v=fixture',
        'https://www.youtube.com/live_chat?v=fixture',
      ),
    ).toBe(true)
    expect(
      isYouTubeInputFramePair(
        'https://youtube.com/watch?v=fixture',
        'https://youtube.com/live_chat?v=fixture',
      ),
    ).toBe(true)
    expect(
      isYouTubeInputFramePair(
        'https://www.youtube.com/watch?v=fixture',
        'https://youtube.com/live_chat?v=fixture',
      ),
    ).toBe(false)
    expect(
      isYouTubeInputFramePair(
        'https://outer.fixture.test/player',
        'https://www.youtube.com/live_chat?v=fixture',
      ),
    ).toBe(false)

    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValueOnce([
      {
        frameId: 0,
        documentId: 'top-doc',
        result: {
          url: 'https://www.youtube.com/watch?v=fixture',
          topUrl: 'https://www.youtube.com/watch?v=fixture',
          focused: false,
        },
      },
      {
        frameId: 2,
        documentId: 'chat-doc',
        result: {
          url: 'https://www.youtube.com/live_chat?v=fixture',
          topUrl: 'https://www.youtube.com/watch?v=fixture',
          focused: true,
        },
      },
      {
        frameId: 3,
        documentId: '',
        result: {
          url: 'https://www.youtube.com/live_chat?v=fixture',
          topUrl: 'https://www.youtube.com/watch?v=fixture',
          focused: true,
        },
      },
      {
        frameId: -1,
        documentId: 'neg-doc',
        result: {
          url: 'https://www.youtube.com/live_chat?v=fixture',
          topUrl: 'https://www.youtube.com/watch?v=fixture',
          focused: true,
        },
      },
      {
        frameId: 4,
        documentId: 'bad-result',
        result: undefined,
      },
    ] as never)
    expect(await readInputFrameDocuments(7)).toEqual([
      {
        frameId: 0,
        documentId: 'top-doc',
        snapshot: {
          url: 'https://www.youtube.com/watch?v=fixture',
          topUrl: 'https://www.youtube.com/watch?v=fixture',
          focused: false,
        },
      },
      {
        frameId: 2,
        documentId: 'chat-doc',
        snapshot: {
          url: 'https://www.youtube.com/live_chat?v=fixture',
          topUrl: 'https://www.youtube.com/watch?v=fixture',
          focused: true,
        },
      },
    ])
  })

  it('独立注册 wt-input-frames，遵守网站范围，关闭 input、总开关或撤权时注销子脚本', async () => {
    const scripts = fakeContentScripts()
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [] as never)
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({ ok: true }))

    await translationConfigItem.setValue({
      ...CONFIG,
      inputTranslationEnabled: true,
    })
    await syncAllSiteScripts()

    const mainScript = scripts.registered.find((s) => s.id === SITE_SCRIPT_ID)
    const frameScript = scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)
    expect(mainScript).toMatchObject({
      id: SITE_SCRIPT_ID,
      js: ['web-translate.js'],
      allFrames: false,
      persistAcrossSessions: true,
    })
    expect(frameScript).toMatchObject({
      id: INPUT_FRAME_SCRIPT_ID,
      js: ['input-frame.js'],
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches: [],
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    })

    // 网站范围只允许 www.youtube.com 时只注册 www
    await translationConfigItem.setValue({
      ...CONFIG,
      inputTranslationEnabled: true,
      siteScopeMode: 'include',
      siteScopeHosts: ['www.youtube.com'],
    })
    await syncAllSiteScripts()
    expect(scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)).toMatchObject({
      matches: ['http://*.www.youtube.com/*', 'https://*.www.youtube.com/*'],
    })

    // 关闭 inputTranslationEnabled 注销子脚本，保留主脚本
    await translationConfigItem.setValue({
      ...CONFIG,
      inputTranslationEnabled: false,
    })
    await syncAllSiteScripts()
    expect(scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)).toBeUndefined()
    expect(scripts.registered.find((s) => s.id === SITE_SCRIPT_ID)).toBeDefined()

    // 重新开启后再测排除 youtube.com 不影响其他站点的子脚本注册
    await translationConfigItem.setValue({
      ...CONFIG,
      inputTranslationEnabled: true,
      excludedHosts: ['youtube.com'],
    })
    await syncAllSiteScripts()
    expect(scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)).toBeDefined()

    // 恢复非排除后测试撤权注销子脚本
    await translationConfigItem.setValue({
      ...CONFIG,
      inputTranslationEnabled: true,
      excludedHosts: [],
    })
    await syncAllSiteScripts()
    expect(scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)).toBeDefined()

    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => false)
    await syncAllSiteScripts()
    expect(scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)).toBeUndefined()

    // 恢复权限后测试总开关关闭注销子脚本
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async () => true)
    await syncAllSiteScripts()
    expect(scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)).toBeDefined()

    await settingsItem.setValue({ ...DEFAULT_SETTINGS, enabled: false })
    await syncAllSiteScripts()
    expect(scripts.registered.find((s) => s.id === INPUT_FRAME_SCRIPT_ID)).toBeUndefined()
  })

  it('已打开标签页只向同源子框架注入，撤权发送专用 stop 且不停止父页面', async () => {
    const ytTopUrl = 'https://www.youtube.com/watch?v=fixture'
    const tabs = [
      { id: 10, url: ytTopUrl },
      { id: 11, url: 'https://app.devin.ai/work' },
    ]
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => tabs as never)

    const sent: Array<{ tabId: number; message: unknown; options?: unknown }> = []
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(
      async (tabId: number, message: unknown, options?: unknown) => {
        sent.push({ tabId, message, options })
        return { ok: true }
      },
    )

    const injectedTargets: Array<{ target: unknown; files?: unknown }> = []
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation((async (injection: {
      target: unknown
      files?: unknown
      func?: unknown
    }) => {
      if (injection.func === readInputFrameSnapshot) {
        return [
          {
            frameId: 0,
            documentId: 'yt-top-doc',
            result: { url: ytTopUrl, topUrl: ytTopUrl, focused: false },
          },
          {
            frameId: 2,
            documentId: 'yt-live-chat-doc',
            result: {
              url: 'https://www.youtube.com/live_chat?v=fixture',
              topUrl: ytTopUrl,
              focused: true,
            },
          },
          {
            frameId: 3,
            documentId: 'yt-replay-doc',
            result: {
              url: 'https://www.youtube.com/live_chat_replay?v=fixture',
              topUrl: ytTopUrl,
              focused: false,
            },
          },
          {
            frameId: 4,
            documentId: 'yt-cross-origin-doc',
            result: {
              url: 'https://youtube.com/live_chat?v=fixture',
              topUrl: ytTopUrl,
              focused: false,
            },
          },
        ]
      }
      injectedTargets.push({ target: injection.target, files: injection.files })
      return []
    }) as never)

    await translationConfigItem.setValue({
      ...CONFIG,
      inputTranslationEnabled: true,
    })
    await syncAllSiteScripts()

    expect(injectedTargets).toEqual([
      {
        target: { tabId: 10, documentIds: ['yt-live-chat-doc'] },
        files: INPUT_FRAME_SCRIPT_FILES,
      },
      {
        target: { tabId: 10, documentIds: ['yt-replay-doc'] },
        files: INPUT_FRAME_SCRIPT_FILES,
      },
    ])
    expect(sent).toContainEqual({
      tabId: 10,
      message: { type: 'wt:refresh-input-frame' },
      options: undefined,
    })
    expect(sent).toContainEqual({
      tabId: 10,
      message: { type: 'wt:refresh-input-frame' },
      options: { documentId: 'yt-live-chat-doc' },
    })
    expect(sent).toContainEqual({
      tabId: 11,
      message: { type: 'wt:refresh-input-frame' },
      options: undefined,
    })

    // 撤销 YouTube 权限或关闭输入翻译：发送专用 wt:stop-input-frame，不向父页面发 wt:stop
    sent.length = 0
    injectedTargets.length = 0
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(async (perm) => {
      const origins = perm.origins ?? []
      return !origins.some((o) => o.includes('youtube.com'))
    })
    await syncAllSiteScripts()

    expect(injectedTargets).toEqual([])
    expect(sent).toContainEqual({
      tabId: 10,
      message: { type: 'wt:stop-input-frame' },
      options: undefined,
    })
    expect(sent.some((item) => (item.message as { type?: string }).type === 'wt:stop')).toBe(false)
    expect(sent).toContainEqual({
      tabId: 10,
      message: { type: 'wt:refresh' },
      options: { frameId: 0 },
    })
  })
})

