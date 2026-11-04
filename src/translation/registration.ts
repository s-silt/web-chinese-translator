import { browser, type Browser } from 'wxt/browser'
import type { ScriptPublicPath } from 'wxt/utils/inject-script'
import { getTranslationConfig, hostPermissionPattern, type TranslationConfig } from './config'
import { getSettings, watchSettings } from '../shared/settings'
import { BUILTIN_DICTIONARY_META, hostMatchPattern } from './dictionaries/index'
import { getCustomDictionaries, watchCustomDictionaries } from './custom-dictionaries'
import { isSiteScopeAllowed, restrictSitePatterns, siteScopeExclusions } from './site-scope'

export const SITE_SCRIPT_ID = 'wt-sites'
const REGISTERED_JS = 'web-translate.js'
export const SITE_SCRIPT_FILES: ScriptPublicPath[] = ['/web-translate.js']

function reportError(_error: unknown): void {
  console.error('[网页汉化助手] 站点脚本同步失败')
}

function sameSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (a === undefined) return false
  const have = new Set(a)
  const want = new Set(b)
  return have.size === want.size && [...want].every((value) => have.has(value))
}

export const ALL_HTTP_MATCHES = ['http://*/*', 'https://*/*']

async function granted(pattern: string): Promise<boolean> {
  if (typeof browser.permissions?.contains !== 'function') return false
  try {
    return await browser.permissions.contains({ origins: [pattern] })
  } catch {
    return false
  }
}

export async function siteScriptMatches(config: TranslationConfig): Promise<string[]> {
  const matches: string[] = []
  const disabled = new Set(config.disabledDictionaries)
  const custom = await getCustomDictionaries().catch(() => [])
  const dictionaryHosts = [
    ...BUILTIN_DICTIONARY_META.filter((d) => !disabled.has(d.id)).flatMap((d) => d.hosts),
    ...custom.filter((d) => d.enabled).flatMap((d) => d.hosts),
  ]
  for (const host of new Set(dictionaryHosts)) {
    const pattern = hostMatchPattern(host)
    if (await granted(pattern)) matches.push(pattern)
  }
  for (const origin of config.autoOrigins) {
    const pattern = hostPermissionPattern(origin)
    if (await granted(pattern)) matches.push(pattern)
  }
  if (config.selectionPopupEnabled || config.floatingButtonEnabled) {
    const grantedAll = await Promise.all(ALL_HTTP_MATCHES.map(granted))
    if (grantedAll.every(Boolean)) return restrictSitePatterns([...ALL_HTTP_MATCHES], config).sort()
    if (grantedAll[1]) matches.push('https://*/*')
    if (grantedAll[0]) matches.push('http://*/*')
  }
  return restrictSitePatterns([...new Set(matches)], config).sort()
}

function isDuplicateId(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Duplicate script ID')
}

let queue: Promise<void> = Promise.resolve()

async function syncNow(config: TranslationConfig): Promise<void> {
  const scripting = browser.scripting
  if (typeof scripting?.getRegisteredContentScripts !== 'function') return
  const settings = await getSettings().catch(() => undefined)
  const matches = settings?.enabled === true ? await siteScriptMatches(config) : []
  const exclusions = siteScopeExclusions(config)
  const [current] = await scripting.getRegisteredContentScripts({ ids: [SITE_SCRIPT_ID] })
  if (matches.length === 0) {
    if (current !== undefined) await scripting.unregisterContentScripts({ ids: [SITE_SCRIPT_ID] })
    return
  }
  if (
    current !== undefined &&
    current.runAt === 'document_idle' &&
    current.persistAcrossSessions !== false &&
    current.allFrames !== true &&
    sameSet(current.js?.map((path) => path.replace(/^\//, '')), [REGISTERED_JS]) &&
    sameSet(current.matches, matches) &&
    sameSet(current.excludeMatches ?? [], exclusions)
  ) {
    return
  }
  const script = {
    id: SITE_SCRIPT_ID,
    matches,
    excludeMatches: exclusions,
    js: [REGISTERED_JS],
    runAt: 'document_idle' as const,
    allFrames: false,
    persistAcrossSessions: true,
  }
  if (current !== undefined) {
    await scripting.updateContentScripts([script])
    return
  }
  try {
    await scripting.registerContentScripts([script])
  } catch (error) {
    if (!isDuplicateId(error)) throw error
  }
}

export function syncSiteScript(): Promise<void> {
  const pending = queue.then(async () => {
    await syncNow(await getTranslationConfig())
  })
  queue = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

const MISSING_RECEIVER = /Receiving end does not exist|Could not establish connection|no receiver/i

type TabReply = 'ready' | 'missing' | 'unavailable'

async function sendToTab(tabId: number, message: unknown): Promise<TabReply> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reply: unknown = await Promise.race([
      Promise.resolve().then(() => browser.tabs.sendMessage(tabId, message, { frameId: 0 })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 1000)
      }),
    ])
    return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true
      ? 'ready'
      : 'unavailable'
  } catch (error) {
    return error instanceof Error && MISSING_RECEIVER.test(error.message) ? 'missing' : 'unavailable'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function syncSiteTabs(previous: TranslationConfig, next: TranslationConfig): Promise<void> {
  const scripting = browser.scripting
  const tabs = browser.tabs
  if (typeof tabs?.query !== 'function') return
  const settings = await getSettings().catch(() => undefined)
  const masterOn = settings?.enabled === true
  const current = await getTranslationConfig().catch(() => next)
  const after = masterOn ? new Set(await siteScriptMatches(current).catch(() => [] as string[])) : new Set<string>()
  void previous
  const allTabs = (await tabs.query({}).catch(() => [] as Browser.tabs.Tab[])).filter(
    (tab) => typeof tab.id === 'number',
  )
  const matched =
    after.size === 0 ? [] : (await tabs.query({ url: [...after] }).catch(() => [] as Browser.tabs.Tab[]))
  const eligible =
    current.siteScopeMode === 'all'
      ? matched
      : matched.filter((tab) => typeof tab.url === 'string' && isSiteScopeAllowed(tab.url, current))
  const eligibleIds = new Set(eligible.map((tab) => tab.id).filter((id): id is number => id !== undefined))
  const jobs: Promise<unknown>[] = []
  for (const tab of allTabs) {
    const id = tab.id
    if (id === undefined) continue
    if (!masterOn) {
      jobs.push(sendToTab(id, { type: 'wt:stop' }).catch(() => undefined))
      continue
    }
    if (eligibleIds.has(id)) {
      jobs.push(
        sendToTab(id, { type: 'wt:refresh' })
          .catch((): TabReply => 'unavailable')
          .then(async (result) => {
            if (result !== 'missing' || typeof scripting?.executeScript !== 'function') return
            await scripting
              .executeScript({ target: { tabId: id }, files: SITE_SCRIPT_FILES, injectImmediately: true })
              .catch(() => undefined)
            await sendToTab(id, { type: 'wt:refresh' }).catch(() => 'unavailable' as const)
          }),
      )
    } else {
      jobs.push(sendToTab(id, { type: 'wt:refresh' }).catch(() => undefined))
    }
  }
  await Promise.all(jobs)
}

export async function syncAllSiteScripts(): Promise<void> {
  await syncSiteScript()
  const config = await getTranslationConfig()
  await syncSiteTabs(config, config)
}

export function installSiteScriptSync(): void {
  const syncAll = (): void => {
    void syncAllSiteScripts().catch(reportError)
  }
  const syncRegistration = (): void => {
    void syncSiteScript().catch(reportError)
  }
  try {
    if (typeof browser.permissions?.onAdded?.addListener === 'function') {
      browser.permissions.onAdded.addListener(syncAll)
    }
    if (typeof browser.permissions?.onRemoved?.addListener === 'function') {
      browser.permissions.onRemoved.addListener(syncAll)
    }
    if (typeof browser.runtime?.onStartup?.addListener === 'function') {
      browser.runtime.onStartup.addListener(syncRegistration)
    }
  } catch {
    void 0
  }
  let previousEnabled: boolean | undefined
  void getSettings()
    .catch(() => undefined)
    .then((settings) => {
      if (previousEnabled === undefined) previousEnabled = settings?.enabled
    })
  watchSettings((next) => {
    if (previousEnabled !== undefined && next.enabled === previousEnabled) return
    previousEnabled = next.enabled
    syncAll()
  })
  watchCustomDictionaries(() => syncAll())
  syncRegistration()
}
