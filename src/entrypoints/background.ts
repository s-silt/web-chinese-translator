import { browser, type Browser } from 'wxt/browser'
import { defineBackground } from 'wxt/utils/define-background'
import type { ScriptPublicPath } from 'wxt/utils/inject-script'
import { syncBadge } from '../shared/badge'
import { isFirefoxBuild } from '../shared/extension'
import { parseGitHubUrl } from '../shared/github'
import { applyLegacySettingValues, removeLegacyUntranslated } from '../shared/legacy-storage'
import type { PageLocale } from '../shared/locale'
import { LOCALE_SCRIPT_FILES } from '../shared/locale-loader'
import { syncLocaleScript } from '../shared/locale-script'
import { isBackgroundMessage, isContentStatus, type ContentMessage } from '../shared/messages'
import { getSettings, watchSettings, type Settings } from '../shared/settings'
import { installTranslationBackground } from '../translation/background'

type MessageSender = Browser.runtime.MessageSender

function reportError(error: unknown): void {
  console.error('[GitHub 中文化]', error)
}

/** 词典脚本注册的排队：注册、更新、注销依次进行，不并发（并发注册同一 ID 会报错） */
let localeScriptSync: Promise<void> = Promise.resolve()

/** 按设置同步词典脚本的注册（见 shared/locale-script）；不传设置时读存储 */
function scheduleLocaleScriptSync(settings?: Settings): void {
  localeScriptSync = localeScriptSync
    .then(async () => syncLocaleScript(settings ?? (await getSettings())))
    .catch(reportError)
}

/** 按存储中的设置刷新徽标 */
function syncBadgeFromStorage(): Promise<void> {
  return getSettings().then(syncBadge).catch(reportError)
}

/** 来自 GitHub 页面的内容脚本 */
function fromGitHubTab(sender: MessageSender): boolean {
  return sender.id === browser.runtime.id && sender.tab !== undefined && parseGitHubUrl(sender.url) !== undefined
}

/** 来自本扩展的页面（popup、设置页） */
function fromExtensionPage(sender: MessageSender): boolean {
  return sender.id === browser.runtime.id && (sender.url?.startsWith(browser.runtime.getURL('/')) ?? false)
}

/** 通知所有 GitHub 标签页的内容脚本；未注入内容脚本的标签页忽略 */
async function notifyGitHubTabs(message: ContentMessage): Promise<void> {
  // 有主机权限的页面才带 url。url 不可见的也发：撤销站点权限后，已注入的内容脚本仍在运行到刷新
  const tabs = (await browser.tabs.query({})).filter(
    (tab) => tab.id !== undefined && (tab.url === undefined || parseGitHubUrl(tab.url) !== undefined),
  )
  await Promise.all(tabs.map((tab) => browser.tabs.sendMessage(tab.id!, message).catch(() => undefined)))
}

/** 内容脚本与主世界桥接的构建产物：路径类型由 WXT 按实际产物生成，改名时类型检查报错 */
const CONTENT_SCRIPT_FILES: ScriptPublicPath[] = ['/content-scripts/content.js']
const BRIDGE_SCRIPT_FILES: ScriptPublicPath[] = ['/content-scripts/turbo-bridge.js']

/**
 * 标签页里已有本版本的内容脚本在运行（更新时正在加载的页面已由清单注入）：能应答状态查询。
 * 还在读存储的内容脚本也已注册监听，启动完成后应答
 */
async function hasLiveContentScript(tabId: number): Promise<boolean> {
  const request: ContentMessage = { type: 'gcn:get-status' }
  try {
    return isContentStatus(await browser.tabs.sendMessage(tabId, request))
  } catch {
    // 没有接收方：未注入，或只有已失效的旧版本
    return false
  }
}

/** 先注入主世界桥接：新内容脚本启动时旧实例还原、派发重置事件，要有桥接接收 */
async function injectIntoTab(tabId: number): Promise<void> {
  if (await hasLiveContentScript(tabId)) return
  const target = { tabId }
  // 立即注入：缺省要等到 document_idle，仍在加载的页面会先显示英文
  await browser.scripting
    .executeScript({ target, files: BRIDGE_SCRIPT_FILES, world: 'MAIN', injectImmediately: true })
    .catch(() => undefined)
  await browser.scripting
    .executeScript({ target, files: CONTENT_SCRIPT_FILES, injectImmediately: true })
    .catch(() => undefined)
}

/**
 * 把词典脚本注入内容脚本所在的框架（内容脚本动态导入失败时的退路，Firefox 同样适用）。
 * 没有 scripting API 时返回 false
 */
async function injectLocale(tabId: number, frameId: number, locale: PageLocale): Promise<boolean> {
  if (typeof browser.scripting?.executeScript !== 'function') return false
  const files = [LOCALE_SCRIPT_FILES[locale] as ScriptPublicPath]
  // 内容脚本已在等待：立即注入，不等 document_idle
  await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files, injectImmediately: true })
  return true
}

/**
 * 扩展安装、更新后向已打开的 GitHub 页面注入内容脚本与桥接：Chromium 不自动注入，旧内容脚本失效后页面还原为英文。
 * Firefox 自动注入已打开的页面，再注入会出现两个实例：不注入
 */
async function injectIntoOpenTabs(): Promise<void> {
  if (isFirefoxBuild() || typeof browser.scripting?.executeScript !== 'function') return
  // 休眠的标签页不注入：恢复时重新加载，自动注入
  const tabs = (await browser.tabs.query({})).filter(
    (tab) => tab.id !== undefined && !tab.discarded && parseGitHubUrl(tab.url) !== undefined,
  )
  await Promise.all(tabs.map((tab) => injectIntoTab(tab.id!)))
}

export default defineBackground(() => {
  // 事件监听须在顶层同步注册，Service Worker 被唤醒时才能收到事件
  // 自定义词条由设置页保存后发消息，这里转发给各 GitHub 标签页
  browser.runtime.onMessage.addListener((message: unknown, sender: MessageSender, sendResponse) => {
    if (!isBackgroundMessage(message)) return undefined
    switch (message.type) {
      case 'gcn:custom-entries-saved':
        if (!fromExtensionPage(sender)) return undefined
        notifyGitHubTabs({ type: 'gcn:custom-entries-changed' }).catch(reportError)
        sendResponse({ ok: true })
        return undefined
      case 'gcn:inject-locale': {
        const tabId = sender.tab?.id
        if (!fromGitHubTab(sender) || tabId === undefined) return undefined
        injectLocale(tabId, sender.frameId ?? 0, message.locale).then(
          (ok) => sendResponse({ ok }),
          (error: unknown) => {
            reportError(error)
            sendResponse({ ok: false })
          },
        )
        return true
      }
    }
  })
  // 浏览器重启或扩展更新后徽标会重置。旧版本的未翻译文本：更新时删除，启动时再删一次（更新时没删成的）
  browser.runtime.onStartup.addListener(() => {
    void syncBadgeFromStorage()
    removeLegacyUntranslated().catch(reportError)
  })
  browser.runtime.onInstalled.addListener(({ reason }) => {
    void syncBadgeFromStorage()
    // 安装、更新扩展时浏览器清空注册（Chromium、Firefox 都是），在此与顶层同步补回
    scheduleLocaleScriptSync()
    if (reason === 'install' || reason === 'update') injectIntoOpenTabs().catch(reportError)
    if (reason === 'update') {
      removeLegacyUntranslated().catch(reportError)
      // 设置中旧版本的「收集未翻译」开关改为关闭：同步到未更新的旧版本，它们随之停止收集
      applyLegacySettingValues().catch(reportError)
    }
  })
  watchSettings((settings) => {
    syncBadge(settings).catch(reportError)
    scheduleLocaleScriptSync(settings)
  })
  // 浏览器语言变化：自动识别的翻译语言随之变化，按新语言注册
  globalThis.addEventListener('languagechange', () => scheduleLocaleScriptSync())
  void syncBadgeFromStorage()
  scheduleLocaleScriptSync()
  if (!isFirefoxBuild()) installTranslationBackground()
})
