import { browser, type Browser } from 'wxt/browser'
import { completionUrl, hostPermissionPattern, normalizeOrigin, type TranslationConfig } from './config'
import { inputFrameUrl, parseInputFrameDocument, readInputFrameSnapshot } from './input-frame'
import type { CustomHeadersState, KeyState, TranslationFailure } from './messages'
import { currentRevision, type ModelSnapshot } from './model-state'
import { documentFormOfBrowserUrl, matchesBrowserUrl } from './page-lifecycle'
import { isExcludedSite, isSensitivePage } from './page-policy'
import { describeFailure } from './scheduler'
import { credentialOrigin, readStoredApiKey, readStoredCustomHeaders } from './secrets'
import { isSiteScopeAllowed } from './site-scope'
import { CompletionCancelledError } from './transport'

export type MessageSender = Browser.runtime.MessageSender

export const SNAPSHOT_ERROR = '无法读取接口配置或密钥，请在设置中检查'

export function fromExtensionPage(sender: MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(browser.runtime.getURL('/'))
  )
}

export function fromTextWindow(sender: MessageSender): boolean {
  if (!fromExtensionPage(sender)) return false
  try {
    return new URL(sender.url!).pathname === '/translate.html'
  } catch {
    return false
  }
}

export function fromOurContent(sender: MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.tab?.id === 'number' &&
    sender.frameId === 0 &&
    typeof sender.url === 'string' &&
    /^https?:/.test(sender.url)
  )
}

export function fromOurInputFrame(sender: MessageSender): boolean {
  if (
    sender.id !== browser.runtime.id ||
    typeof sender.tab?.id !== 'number' ||
    !Number.isSafeInteger(sender.tab.id) ||
    sender.tab.id < 0 ||
    sender.tab.incognito === true ||
    typeof sender.frameId !== 'number' ||
    !Number.isSafeInteger(sender.frameId) ||
    sender.frameId <= 0 ||
    typeof sender.documentId !== 'string' ||
    sender.documentId === '' ||
    sender.documentId.length > 256 ||
    typeof sender.url !== 'string' ||
    typeof sender.tab.url !== 'string' ||
    typeof sender.origin !== 'string'
  ) {
    return false
  }
  const tabDocUrl = documentFormOfBrowserUrl(sender.tab.url)
  const effective = inputFrameUrl(tabDocUrl, sender.url)
  if (effective === undefined) return false
  const expectedOrigin = normalizeOrigin(effective)
  return expectedOrigin !== '' && sender.origin === expectedOrigin
}

export async function patternAllowed(pattern: string): Promise<boolean> {
  if (typeof browser.permissions?.contains !== 'function') return false
  try {
    return await browser.permissions.contains({ origins: [pattern] })
  } catch {
    return false
  }
}

export async function originAllowed(origin: string): Promise<boolean> {
  return origin !== '' && patternAllowed(hostPermissionPattern(origin))
}

export async function endpointAllowed(baseUrl: string): Promise<boolean> {
  const url = completionUrl(baseUrl)
  if (url === '') return false
  if (typeof browser.permissions?.contains !== 'function') return false
  try {
    return await browser.permissions.contains({ origins: [hostPermissionPattern(url)] })
  } catch {
    return false
  }
}

export async function inputFrameAllowed(sender: MessageSender, config: TranslationConfig): Promise<boolean> {
  if (!fromOurInputFrame(sender) || !config.inputTranslationEnabled) return false
  const tabId = sender.tab!.id!
  const frameId = sender.frameId!
  const documentId = sender.documentId!
  const sourceUrl = sender.url!
  const tabs = browser.tabs
  const scripting = browser.scripting
  if (typeof tabs?.get !== 'function' || typeof scripting?.executeScript !== 'function') return false
  try {
    const currentTab = await tabs.get(tabId)
    if (currentTab.incognito === true || typeof currentTab.url !== 'string') return false
    const browserTopUrl = currentTab.url
    const candidateTopUrl = documentFormOfBrowserUrl(browserTopUrl)
    const candidateEffectiveUrl = inputFrameUrl(candidateTopUrl, sourceUrl)
    if (candidateEffectiveUrl === undefined) return false
    if (!isSiteScopeAllowed(candidateTopUrl, config) || !isSiteScopeAllowed(candidateEffectiveUrl, config)) return false
    if (
      isExcludedSite(candidateTopUrl, config.excludedHosts) ||
      isExcludedSite(candidateEffectiveUrl, config.excludedHosts)
    ) {
      return false
    }
    if (isSensitivePage(candidateTopUrl) || isSensitivePage(candidateEffectiveUrl)) return false
    const origin = normalizeOrigin(candidateTopUrl)
    if (origin === '' || !(await originAllowed(origin))) return false
    const results: unknown = await scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      func: readInputFrameSnapshot,
    })
    if (!Array.isArray(results) || results.length !== 1) return false
    const parsed = parseInputFrameDocument(results[0])
    if (parsed === undefined) return false
    if (
      parsed.frameId !== frameId ||
      parsed.documentId !== documentId ||
      !matchesBrowserUrl(parsed.snapshot.topUrl, browserTopUrl)
    ) {
      return false
    }
    const topUrl = parsed.snapshot.topUrl
    const effectiveUrl = inputFrameUrl(topUrl, parsed.snapshot.url)
    if (effectiveUrl === undefined || inputFrameUrl(topUrl, sourceUrl) !== effectiveUrl) return false
    if (!isSiteScopeAllowed(topUrl, config) || !isSiteScopeAllowed(effectiveUrl, config)) return false
    if (isExcludedSite(topUrl, config.excludedHosts) || isExcludedSite(effectiveUrl, config.excludedHosts)) return false
    if (isSensitivePage(topUrl) || isSensitivePage(effectiveUrl)) return false
    return true
  } catch {
    return false
  }
}

export async function keyStateFor(baseUrl: string): Promise<{ keyState: KeyState; hasKey?: boolean }> {
  const origin = credentialOrigin(baseUrl)
  try {
    const stored = await readStoredApiKey()
    if (stored === undefined) return { keyState: 'none', hasKey: false }
    if (typeof stored === 'string') return { keyState: 'legacy', hasKey: true }
    if (origin !== '' && stored.origin === origin) return { keyState: 'ready', hasKey: true }
    return { keyState: 'different-origin', hasKey: true }
  } catch {
    return { keyState: 'unavailable' }
  }
}

export async function customHeadersStateFor(baseUrl: string, revision: string): Promise<CustomHeadersState> {
  if (revision === '') return 'none'
  const origin = credentialOrigin(baseUrl)
  try {
    const stored = await readStoredCustomHeaders()
    if (stored === undefined || stored.revision !== revision) return 'unavailable'
    if (origin !== '' && stored.origin === origin) return 'ready'
    return 'different-origin'
  } catch {
    return 'unavailable'
  }
}

export function failureReply(error: unknown): TranslationFailure {
  return { ok: false, ...describeFailure(error) }
}

export function unavailableReply(snapshot: ModelSnapshot | undefined): TranslationFailure {
  return snapshot === undefined ? { ok: false, error: SNAPSHOT_ERROR } : failureReply(new CompletionCancelledError())
}

export function checkCurrent(snapshot: ModelSnapshot, signal: AbortSignal): void {
  if (signal.aborted || snapshot.revision !== currentRevision()) throw new CompletionCancelledError()
}
