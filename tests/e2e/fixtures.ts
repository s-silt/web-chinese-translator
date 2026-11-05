import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test'
import type { CustomEntries, Settings } from '../../src/shared/settings'
import { inspectClosedShadowPage, installClosedShadowInspection } from './closed-shadow'

/** 被测扩展目录：默认构建产物 .output/chrome-mv3（bun run build）；E2E_EXTENSION 可指向其他解压目录 */
export const EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../..',
  process.env.E2E_EXTENSION?.trim() || '.output/chrome-mv3',
)

/** Linux 下原生权限确认依赖 AT-SPI 可访问树；--force-renderer-accessibility 让 Chromium 暴露它 */
export const NATIVE_ACCESSIBILITY_ARGS = process.platform === 'linux' ? ['--force-renderer-accessibility'] : []

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures')

interface FixtureFile {
  readonly file: string
  readonly contentType: string
}

const HTML = 'text/html; charset=utf-8'

/** 离线夹具：github.com 路径 → 本地文件 */
const FIXTURE_ROUTES: Readonly<Record<string, FixtureFile>> = {
  '/octo-org/hello-world': { file: 'repo.html', contentType: HTML },
  '/octo-org/hello-world/issues': { file: 'issues.html', contentType: HTML },
  '/octo-org/hello-world/pull/1': { file: 'pull.html', contentType: HTML },
  '/settings/apps/fixture-app/permissions': { file: 'app-permissions.html', contentType: HTML },
  '/__fixtures__/github-sim.js': { file: 'github-sim.js', contentType: 'text/javascript; charset=utf-8' },
  '/__fixtures__/github-sim.css': { file: 'github-sim.css', contentType: 'text/css; charset=utf-8' },
}

export const FIXTURE_URL = {
  repo: 'https://github.com/octo-org/hello-world',
  issues: 'https://github.com/octo-org/hello-world/issues',
  pull: 'https://github.com/octo-org/hello-world/pull/1',
  appPermissions: 'https://github.com/settings/apps/fixture-app/permissions',
} as const

/** 与 src/shared/settings.ts 的 DEFAULT_SETTINGS 一致（该模块依赖扩展运行时，不能在 Node 中导入） */
export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  translateTime: true,
  translateTitle: true,
  excludedPaths: [],
  language: 'auto',
  uiLanguage: 'auto',
  theme: 'auto',
  uiStyle: 'classic',
}

/** 中日韩统一表意文字（含扩展 A 区） */
export const CJK = /[\u3400-\u9fff]/

export function readFixture(file: string): Promise<string> {
  return readFile(resolve(FIXTURE_DIR, file), 'utf8')
}

/** 夹具中 <script type="application/json"> 的原文 */
export function extractJsonScripts(html: string): string[] {
  const pattern = /<script\b[^>]*\btype="application\/json"[^>]*>([\s\S]*?)<\/script>/g
  return [...html.matchAll(pattern)].map((match) => match[1]!)
}

/** 夹具中 <title> 的文本（与 document.title 一样合并空白） */
export function extractTitle(html: string): string {
  return (/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()
}

/** 存储库标签页文字（data-tab-item：code、issues、pull-requests…） */
export function repoTab(page: Page, item: string): Locator {
  return page.locator(`[data-tab-item="${item}"] [data-component="text"]`)
}

/** 夹具元素（data-fx） */
export function fx(page: Page, name: string): Locator {
  return page.locator(`[data-fx="${name}"]`)
}

/** 用本地夹具应答 github.com 请求；未登记的路径返回 404 */
export async function serveFixtures(context: BrowserContext): Promise<void> {
  await context.route('https://github.com/**', async (route) => {
    const { pathname } = new URL(route.request().url())
    const entry = FIXTURE_ROUTES[pathname.replace(/\/+$/, '')]
    if (!entry) {
      await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not Found' })
      return
    }
    await route.fulfill({ status: 200, contentType: entry.contentType, body: await readFixture(entry.file) })
  })
}

/** 等夹具脚本完成 React 改写与动态插入（见 fixtures/github-sim.js） */
export async function waitForSimulation(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-fx-rewritten', 'true')
  await expect(page.locator('body')).toHaveAttribute('data-fx-dynamic', 'true')
}

type StorageAreaName = 'sync' | 'local'

/** 内容脚本状态（与 src/shared/messages.ts 的 ContentStatus 对应） */
export interface ContentStatusLike {
  readonly active: boolean
  readonly excluded: boolean
  readonly pages: readonly string[]
}

/** 扩展页面上下文中可用的 chrome API 子集 */
interface ChromeLike {
  readonly storage: Record<
    StorageAreaName,
    {
      set(items: Record<string, unknown>): Promise<void>
      get(keys: string | string[]): Promise<Record<string, unknown>>
    }
  >
  readonly tabs: {
    query(info: { url: string }): Promise<Array<{ id?: number }>>
    sendMessage(tabId: number, message: unknown): Promise<unknown>
  }
  readonly runtime: {
    sendMessage(message: unknown): Promise<unknown>
    getContexts(filter: { contextTypes: string[] }): Promise<unknown[]>
  }
}

/** 通过扩展页面读写 chrome.storage */
export interface ExtensionControl {
  readonly page: Page
  /** 写入 chrome.storage.sync 的 settings（在默认设置上合并） */
  setSettings(patch: Partial<Settings>): Promise<void>
  /** 写入 local:translationConfig（模型翻译配置），供需要划词/自动翻译的用例直接播种 */
  setTranslationConfig(patch: Record<string, unknown>): Promise<void>
  /** 写入 chrome.storage.local 的 customEntries，并像设置页一样通知后台转发给已打开的页面 */
  setCustomEntries(entries: CustomEntries): Promise<void>
  /** 读取 chrome.storage.sync 的 settings 原始值 */
  readSettings(): Promise<unknown>
  /** 向匹配 url 的标签页发送 gcn:get-status；无标签页或无应答时返回 undefined */
  status(url: string): Promise<ContentStatusLike | undefined>
  /** 扩展的 Service Worker；找不到时抛错 */
  serviceWorker(): Worker
  /**
   * 停止扩展的 Service Worker（模拟空闲回收），确认已停止才返回；之后的消息、事件会重新唤醒它。
   * Playwright 停止、重启前后沿用同一个 Worker 对象，不发 close、serviceworker 事件
   */
  stopServiceWorker(): Promise<void>
}

/** 等扩展 Service Worker 停止的时限 */
const SERVICE_WORKER_STOP_TIMEOUT_MS = 10_000

function createControl(page: Page): ExtensionControl {
  const serviceWorker = (): Worker => {
    // chrome-extension: 不是特殊协议，Node 中 URL.origin 为 "null"：按扩展 ID 拼前缀
    const prefix = `chrome-extension://${new URL(page.url()).host}/`
    // 取最新加入的
    const worker = page
      .context()
      .serviceWorkers()
      .findLast((item) => item.url().startsWith(prefix))
    if (!worker) throw new Error('未找到扩展的 Service Worker')
    return worker
  }

  const write = (area: StorageAreaName, items: Record<string, unknown>): Promise<void> =>
    page.evaluate(
      async ({ name, values }) => {
        const { chrome } = globalThis as unknown as { chrome: ChromeLike }
        await chrome.storage[name].set(values)
      },
      { name: area, values: items },
    )

  /** 后台是否在 runtime.getContexts 中：只列出活动的上下文，停止后不在其中 */
  const backgroundRunning = (): Promise<boolean> =>
    page.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: ChromeLike }
      return (await chrome.runtime.getContexts({ contextTypes: ['BACKGROUND'] })).length > 0
    })

  return {
    page,
    setSettings: (patch) => write('sync', { settings: { ...DEFAULT_SETTINGS, ...patch } }),
    setTranslationConfig: (patch) => write('local', { translationConfig: patch }),
    setCustomEntries: (entries) =>
      page.evaluate(async (values) => {
        const { chrome } = globalThis as unknown as { chrome: ChromeLike }
        await chrome.storage.local.set({ customEntries: values })
        await chrome.runtime.sendMessage({ type: 'gcn:custom-entries-saved' })
      }, entries),
    readSettings: () =>
      page.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: ChromeLike }
        return (await chrome.storage.sync.get('settings')).settings
      }),
    status: (url) =>
      page.evaluate(async (target) => {
        const { chrome } = globalThis as unknown as { chrome: ChromeLike }
        const [tab] = await chrome.tabs.query({ url: target })
        if (tab?.id === undefined) return undefined
        try {
          return (await chrome.tabs.sendMessage(tab.id, { type: 'gcn:get-status' })) as ContentStatusLike | undefined
        } catch {
          return undefined
        }
      }, url),
    serviceWorker,
    stopServiceWorker: async () => {
      const url = serviceWorker().url()
      const session = await page.context().newCDPSession(page)
      /** 运行中的扩展 Service Worker 的 CDP 目标 ID；已停止的不在目标列表中 */
      const runningTargetId = async (): Promise<string | undefined> => {
        const { targetInfos } = await session.send('Target.getTargets')
        return targetInfos.find((info) => info.type === 'service_worker' && info.url === url)?.targetId
      }
      try {
        const targetId = await runningTargetId()
        if (!targetId) throw new Error('未找到扩展的 Service Worker 目标')
        // 停止前列出过后台，才用 runtime.getContexts 判断
        const listed = await backgroundRunning().catch(() => false)
        // 关闭 Service Worker 目标：与浏览器空闲回收一样终止，下一条消息、事件重新启动它
        await session.send('Target.closeTarget', { targetId })
        // 目标列表、runtime.getContexts 任一处已没有它即已停止
        await expect
          .poll(async () => (await runningTargetId()) === undefined || (listed && !(await backgroundRunning())), {
            message: 'Service Worker 未停止',
            timeout: SERVICE_WORKER_STOP_TIMEOUT_MS,
          })
          .toBe(true)
      } finally {
        await session.detach()
      }
    },
  }
}

interface ExtensionFixtures {
  /** 扩展 ID（取自 service worker URL） */
  extensionId: string
  /** 已打开 popup.html 的扩展页面，用于读写存储 */
  extension: ExtensionControl
}

/** 加载 .output/chrome-mv3 的测试；每个测试使用全新的浏览器配置 */
export const test = base.extend<ExtensionFixtures>({
  context: async ({ headless }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      // 浏览器界面语言用简体中文：扩展界面（自动识别）与页面翻译语言都按简体，断言的界面文字与之对应
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--lang=zh-CN', '--host-resolver-rules=MAP reader.fixture.test 127.0.0.1', '--no-proxy-server', ...NATIVE_ACCESSIBILITY_ARGS],
    })
    await installClosedShadowInspection(context)
    await use(context)
    await context.close()
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    await use(new URL(worker.url()).host)
  },
  extension: async ({ context, extensionId }, use) => {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/popup.html`)
    await use(createControl(page))
  },
})

/** 离线夹具测试：github.com 请求全部由 tests/e2e/fixtures 应答 */
export const offlineTest = test.extend({
  context: async ({ context }, use) => {
    await serveFixtures(context)
    await use(context)
  },
})

export { expect, inspectClosedShadowPage, installClosedShadowInspection }

export interface SiteRegistrationWaitOptions {
  readonly url?: string
  readonly requiredMatches?: readonly string[]
  readonly excludedPattern?: string
  readonly excludedHosts?: readonly string[]
  readonly selectionPopupEnabled?: boolean
  readonly selectionToolbarEnabled?: boolean
  readonly proactiveAssistEnabled?: boolean
  readonly floatingButtonEnabled?: boolean
  readonly autoOrigin?: string
}

export interface SiteContentReadyOptions {
  readonly supported?: boolean
  readonly auto?: boolean
  readonly fixed?: boolean
  readonly paused?: boolean
  readonly refresh?: boolean
}

function matchPatternCoversUrl(pattern: string, rawUrl: string): boolean {
  if (pattern === '<all_urls>') return true
  const match = /^(https?|[*]):\/\/(\*|\*\.[^/]+|[^/]+)\/(.*)$/.exec(pattern)
  if (!match) return false
  const [, scheme, hostPattern] = match
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  const urlScheme = parsed.protocol.replace(/:$/, '')
  if (scheme !== '*' && scheme !== urlScheme) return false
  if (hostPattern === '*') return true
  const hostname = parsed.hostname.toLowerCase()
  const targetHost = hostPattern!.toLowerCase()
  if (targetHost.startsWith('*.')) {
    const bare = targetHost.slice(2)
    return hostname === bare || hostname.endsWith(`.${bare}`)
  }
  return hostname === targetHost
}

interface ExtensionEvaluationSurface {
  evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>
  evaluate<R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>
}

/** 在扩展页/Service Worker 上等待 wt-sites 内容脚本注册及存储配置就绪 */
export async function waitForSiteScriptRegistration(
  extensionSurface: ExtensionEvaluationSurface,
  options: SiteRegistrationWaitOptions = {},
): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await extensionSurface.evaluate(async () => {
          const { chrome } = globalThis as unknown as {
            chrome: {
              scripting: {
                getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<
                  Array<{
                    id: string
                    matches?: string[]
                    excludeMatches?: string[]
                  }>
                >
              }
              storage: {
                local: { get(key: string): Promise<Record<string, Record<string, unknown> | undefined>> }
                sync: { get(key: string): Promise<Record<string, Record<string, unknown> | undefined>> }
              }
            }
          }
          const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['wt-sites'] })
          const local = await chrome.storage.local.get('translationConfig')
          const sync = await chrome.storage.sync.get('settings')
          return {
            script: scripts[0] ?? null,
            config: local.translationConfig ?? {},
            settings: sync.settings ?? {},
          }
        })
        if (state.script === null) return { ok: false, reason: 'missing-wt-sites-script', state }
        const matches: string[] = state.script.matches ?? []
        const excludeMatches: string[] = state.script.excludeMatches ?? []
        if (options.requiredMatches !== undefined) {
          for (const req of options.requiredMatches) {
            if (!matches.includes(req)) {
              return { ok: false, reason: `missing-match:${req}`, matches }
            }
          }
        }
        if (options.url !== undefined) {
          const covered = matches.some((m: string) => matchPatternCoversUrl(m, options.url!))
          const excluded = excludeMatches.some((m: string) => matchPatternCoversUrl(m, options.url!))
          if (!covered || excluded) {
            return { ok: false, reason: 'url-not-covered-or-excluded', url: options.url, matches, excludeMatches }
          }
        }
        if (options.excludedPattern !== undefined && !excludeMatches.includes(options.excludedPattern)) {
          return { ok: false, reason: `missing-exclude:${options.excludedPattern}`, excludeMatches }
        }
        const cfg = state.config as {
          selectionPopupEnabled?: boolean
          selectionToolbarEnabled?: boolean
          proactiveAssistEnabled?: boolean
          floatingButtonEnabled?: boolean
          autoOrigins?: string[]
          excludedHosts?: string[]
        }
        if (options.excludedHosts !== undefined) {
          const actual = cfg.excludedHosts ?? []
          if (actual.length !== options.excludedHosts.length || options.excludedHosts.some((host) => !actual.includes(host))) {
            return { ok: false, reason: 'model-excluded-hosts-mismatch', actual }
          }
        }
        if (options.selectionPopupEnabled !== undefined && Boolean(cfg.selectionPopupEnabled) !== options.selectionPopupEnabled) {
          return { ok: false, reason: 'selectionPopupEnabled-mismatch', actual: cfg.selectionPopupEnabled }
        }
        if (options.selectionToolbarEnabled !== undefined && Boolean(cfg.selectionToolbarEnabled) !== options.selectionToolbarEnabled) {
          return { ok: false, reason: 'selectionToolbarEnabled-mismatch', actual: cfg.selectionToolbarEnabled }
        }
        if (options.proactiveAssistEnabled !== undefined && Boolean(cfg.proactiveAssistEnabled) !== options.proactiveAssistEnabled) {
          return { ok: false, reason: 'proactiveAssistEnabled-mismatch', actual: cfg.proactiveAssistEnabled }
        }
        if (options.floatingButtonEnabled !== undefined && Boolean(cfg.floatingButtonEnabled) !== options.floatingButtonEnabled) {
          return { ok: false, reason: 'floatingButtonEnabled-mismatch', actual: cfg.floatingButtonEnabled }
        }
        if (options.autoOrigin !== undefined && !(cfg.autoOrigins ?? []).includes(options.autoOrigin)) {
          return { ok: false, reason: 'autoOrigin-missing', autoOrigins: cfg.autoOrigins }
        }
        return { ok: true, reason: 'ready' }
      },
      { timeout: 15_000, message: `等待 wt-sites 脚本注册就绪: ${JSON.stringify(options)}` },
    )
    .toMatchObject({ ok: true })
}

/** 导航后等待目标页内容脚本响应 wt:refresh / wt:status 且满足期望状态 */
export async function waitForSiteContentReady(
  extensionSurface: ExtensionEvaluationSurface,
  targetPage: Page,
  options: SiteContentReadyOptions = {},
): Promise<number> {
  await inspectClosedShadowPage(targetPage)
  const url = targetPage.url()
  let resolvedTabId = -1
  await expect
    .poll(
      async () => {
        const result = await extensionSurface.evaluate(
          async ({ targetUrl, doRefresh }: { targetUrl: string; doRefresh: boolean }) => {
            const { chrome } = globalThis as unknown as {
              chrome: {
                tabs: {
                  query(query: object): Promise<Array<{ id?: number; url?: string }>>
                  sendMessage(id: number, message: unknown): Promise<unknown>
                }
              }
            }
            const tabs = await chrome.tabs.query({})
            const tab = tabs.find((item) => item.url === targetUrl) ?? tabs.find((item) => item.url?.split('#')[0] === targetUrl.split('#')[0])
            if (tab?.id === undefined) return { ok: false, reason: 'tab-not-found' }
            if (doRefresh) {
              await chrome.tabs.sendMessage(tab.id, { type: 'wt:refresh' }).catch(() => undefined)
            }
            const reply = (await chrome.tabs.sendMessage(tab.id, { type: 'wt:status' }).catch(() => undefined)) as
              | { ok?: boolean; status?: { supported?: boolean; auto?: boolean; fixed?: boolean; paused?: boolean } }
              | undefined
            if (!reply?.ok || reply.status === undefined) return { ok: false, reason: 'status-no-reply', tabId: tab.id }
            return { ok: true, tabId: tab.id, status: reply.status }
          },
          { targetUrl: url, doRefresh: options.refresh === true },
        )
        if (!result.ok || result.status === undefined) return result
        if (options.supported !== undefined && result.status.supported !== options.supported) {
          return { ok: false, reason: 'supported-mismatch', status: result.status }
        }
        if (options.auto !== undefined && result.status.auto !== options.auto) {
          return { ok: false, reason: 'auto-mismatch', status: result.status }
        }
        if (options.fixed !== undefined && result.status.fixed !== options.fixed) {
          return { ok: false, reason: 'fixed-mismatch', status: result.status }
        }
        if (options.paused !== undefined && result.status.paused !== options.paused) {
          return { ok: false, reason: 'paused-mismatch', status: result.status }
        }
        resolvedTabId = result.tabId!
        return { ok: true, status: result.status }
      },
      { timeout: 15_000, message: `等待内容脚本就绪 (${url}): ${JSON.stringify(options)}` },
    )
    .toMatchObject({ ok: true })
  await inspectClosedShadowPage(targetPage)
  return resolvedTabId
}

async function getOwnedBrowserPid(context: BrowserContext): Promise<number> {
  const browser = context.browser()
  if (browser === null) throw new Error('Missing fixture browser')
  const session = await browser.newBrowserCDPSession()
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    const ownedPid = processInfo.find((entry) => entry.type === 'browser')?.id
    if (ownedPid === undefined || !Number.isInteger(ownedPid)) throw new Error('Missing fixture process')
    return ownedPid
  } finally {
    await session.detach()
  }
}

export interface NativeShortcutResult {
  readonly sent: boolean
  readonly method?: string
  readonly reason?: string
}

/**
 * 仅针对本测试 BrowserContext 所属浏览器 PID 的窗口发送 Windows 原生 Alt+Key 快捷键。
 * 前后核对测试窗口，焦点异常停止并报告。
 */
export async function sendOwnedBrowserAltShortcut(
  page: Page,
  key: 'T' | 'S' | 'Y',
  verifyEffect?: () => Promise<boolean>,
): Promise<NativeShortcutResult> {
  if (process.platform !== 'win32') {
    return { sent: false, reason: `当前平台 (${process.platform}) 不支持 Windows 原生快捷键注入` }
  }
  const pageTitle = await page.title()
  if (pageTitle === '') return { sent: false, reason: 'Missing target window title' }
  const titleBase64 = Buffer.from(pageTitle, 'utf8').toString('base64')
  const ownedPid = await getOwnedBrowserPid(page.context())
  const vkCode = key.charCodeAt(0)

  const methods: ReadonlyArray<{ readonly name: string; readonly sendBody: string }> = [
    {
      name: 'SendInput',
      sendBody: `
$count=[Win32Shortcut]::SendAltKey(${vkCode})
if ($count -ne 4) {
  Write-Output "SENDINPUT_REJECTED:$count events; error=$([Win32Shortcut]::SendError); keyup=$([Win32Shortcut]::Released)/$([Win32Shortcut]::ReleaseExpected); keyupError=$([Win32Shortcut]::ReleaseError)"
  exit 0
}
`,
    },
  ]

  const reasons: string[] = []
  for (const method of methods) {
    await page.bringToFront()
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Shortcut {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
    public uint pad1;
    public uint pad2;
  }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public static uint ReleaseExpected, Released;
  public static int SendError, ReleaseError;
  public static INPUT[] ReleaseKeysForPartial(uint sent, ushort vk) {
    if (sent == 0 || sent >= 4) return new INPUT[0];
    INPUT[] releases = new INPUT[sent == 2 ? 2 : 1];
    for (int i = 0; i < releases.Length; i++) {
      ushort key = sent == 2 && i == 0 ? vk : (ushort)0x12;
      releases[i].type = 1;
      releases[i].ki.wVk = key;
      releases[i].ki.wScan = (ushort)MapVirtualKey(key, 0);
      releases[i].ki.dwFlags = 2;
    }
    return releases;
  }

  public static uint SendAltKey(ushort vk) {
    INPUT[] inputs = new INPUT[4];
    inputs[0].type = 1; inputs[0].ki.wVk = 0x12; inputs[0].ki.wScan = (ushort)MapVirtualKey(0x12, 0);
    inputs[1].type = 1; inputs[1].ki.wVk = vk;   inputs[1].ki.wScan = (ushort)MapVirtualKey(vk, 0);
    inputs[2].type = 1; inputs[2].ki.wVk = vk;   inputs[2].ki.wScan = (ushort)MapVirtualKey(vk, 0); inputs[2].ki.dwFlags = 2;
    inputs[3].type = 1; inputs[3].ki.wVk = 0x12; inputs[3].ki.wScan = (ushort)MapVirtualKey(0x12, 0); inputs[3].ki.dwFlags = 2;
    uint sent = SendInput(4, inputs, Marshal.SizeOf(typeof(INPUT)));
    SendError = sent == 4 ? 0 : Marshal.GetLastWin32Error();
    ReleaseExpected = 0;
    Released = 0;
    ReleaseError = 0;
    if (sent > 0 && sent < 4) {
      INPUT[] releases = ReleaseKeysForPartial(sent, vk);
      ReleaseExpected = (uint)releases.Length;
      Released = SendInput(ReleaseExpected, releases, Marshal.SizeOf(typeof(INPUT)));
      if (Released != ReleaseExpected) ReleaseError = Marshal.GetLastWin32Error();
    }
    return sent;
  }
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$targetPid = [uint32]${ownedPid}
$targetTitle=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleBase64}'))
$cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]${ownedPid})
$wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$hwnd = [IntPtr]::Zero
foreach ($w in $wins) {
  if ($w.Current.NativeWindowHandle -ne 0 -and $w.Current.Name.Contains($targetTitle)) {
    $hwnd = [IntPtr]$w.Current.NativeWindowHandle
    break
  }
}
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output 'NO_WINDOW'
  exit 0
}
[void][Win32Shortcut]::ShowWindowAsync($hwnd, 9)
[void][Win32Shortcut]::SetForegroundWindow($hwnd)
$fgOk = $false
for ($i = 0; $i -lt 15; $i++) {
  $fg = [Win32Shortcut]::GetForegroundWindow()
  $fgPid = [uint32]0
  [void][Win32Shortcut]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  if ($fg -eq $hwnd -and $fgPid -eq $targetPid) {
    $fgOk = $true
    break
  }
  Start-Sleep -Milliseconds 50
  [void][Win32Shortcut]::SetForegroundWindow($hwnd)
}
if (-not $fgOk) {
  Write-Output 'FOREGROUND_MISMATCH'
  exit 0
}
${method.sendBody}
$afterFg = [Win32Shortcut]::GetForegroundWindow()
$afterFgPid = [uint32]0
[void][Win32Shortcut]::GetWindowThreadProcessId($afterFg, [ref]$afterFgPid)
if ($afterFg -ne $hwnd -or $afterFgPid -ne $targetPid) {
  Write-Output 'FOREGROUND_CHANGED_AFTER_SEND'
  exit 0
}
Write-Output 'SENT'
`
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 25_000,
        windowsHide: true,
      }).trim()
      if (!out.endsWith('SENT')) {
        reasons.push(`${method.name}: ${out}`)
        continue
      }
      if (verifyEffect === undefined) {
        return { sent: true, method: method.name }
      }
      const deadline = Date.now() + 3_500
      while (Date.now() < deadline) {
        if (await verifyEffect()) {
          return { sent: true, method: method.name }
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      reasons.push(`${method.name}: 已发送但未触发扩展命令响应`)
      return { sent: false, reason: reasons.join('; ') }
    } catch (error) {
      reasons.push(`${method.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { sent: false, reason: reasons.join('; ') }
}

export async function invokeOwnedContextMenu(page: Page, title: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(`当前平台 (${process.platform}) 不支持 Windows 原生右键菜单调用`)
  }
  const ownedPid = await getOwnedBrowserPid(page.context())
  const quotedTitle = title.replaceAll("'", "''")
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$pidCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]${ownedPid})
$nameCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '${quotedTitle}')
$condition = [System.Windows.Automation.AndCondition]::new($pidCondition, $nameCondition)
$item = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
if ($null -eq $item) { Write-Output 'OWNED_MENU_ITEM_NOT_FOUND'; exit 0 }
$invoke = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Write-Output 'OWNED_MENU_ITEM_INVOKED'
`
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 25000,
    windowsHide: true,
  }).trim()
  if (!result.endsWith('OWNED_MENU_ITEM_INVOKED')) {
    throw new Error(`Native context menu item not invoked: ${result}`)
  }
}

export function invokeOwnedSelectionMenu(page: Page): Promise<void> {
  return invokeOwnedContextMenu(page, 'WT_MULTILINE_PROBE')
}

/** Windows/Linux 下原生主机权限弹窗：只点本测试浏览器进程的按钮 */
export async function acceptOwnedPermission(page: Page, origins: string[]): Promise<void> {
  const hasPermission = (): Promise<boolean> =>
    page.evaluate(async (patterns) => {
      const { chrome } = globalThis as unknown as {
        chrome: { permissions: { contains(query: { origins: string[] }): Promise<boolean> } }
      }
      return chrome.permissions.contains({ origins: patterns })
    }, origins)
  if (await hasPermission() || (process.platform !== 'win32' && process.platform !== 'linux')) return
  const browser = page.context().browser()
  if (browser === null) throw new Error('Missing fixture browser')
  const session = await browser.newBrowserCDPSession()
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  await session.detach()
  const ownedPid = processInfo.find((entry) => entry.type === 'browser')?.id
  if (ownedPid === undefined || !Number.isInteger(ownedPid)) throw new Error('Missing fixture process')
  if (process.platform === 'linux') {
    const script = `
import sys
import time
from collections import deque
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib

pid = int(sys.argv[1])
buttons: set[str] = set()
Atspi.init()
Atspi.set_timeout(100, 1000)
deadline = time.monotonic() + 8
while time.monotonic() < deadline:
    try:
        desktop = Atspi.get_desktop(0)
        for index in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(index)
            if app is None or app.get_process_id() != pid:
                continue
            pending = deque([app])
            visited = 0
            while pending and visited < 2000 and time.monotonic() < deadline:
                node = pending.popleft()
                visited += 1
                if node.get_role() == Atspi.Role.PUSH_BUTTON:
                    name = node.get_name().strip()
                    buttons.add(name)
                    state = node.get_state_set()
                    if name in {'允许', 'Allow', '添加权限', 'Add permissions'} and state.contains(Atspi.StateType.ENABLED) and state.contains(Atspi.StateType.SENSITIVE):
                        action = node.get_action_iface()
                        if action is not None and action.get_n_actions() > 0 and action.do_action(0):
                            print('accepted', flush=True)
                            sys.exit(0)
                for child_index in range(node.get_child_count()):
                    child = node.get_child_at_index(child_index)
                    if child is not None:
                        pending.append(child)
    except GLib.Error as error:
        print(f'Native accessibility tree changed: {error.message}', file=sys.stderr, flush=True)
    time.sleep(0.1)
raise RuntimeError(f'No native permission button in owned browser {pid}; buttons={sorted(buttons)}')
`
    execFileSync('/usr/bin/python3', ['-c', script, String(ownedPid)], { encoding: 'utf8', timeout: 12_000 })
    await expect.poll(hasPermission, { timeout: 5_000 }).toBe(true)
    return
  }
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]${ownedPid})
$buttons = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$names = @()
for ($attempt = 0; $attempt -lt 20; $attempt++) {
$windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
foreach ($window in $windows) {
  foreach ($button in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttons)) {
    $name = $button.Current.Name
    $names += $name
    if ($button.Current.IsEnabled -and $name -match '^(允许|Allow|添加权限|Add permissions)$') {
      $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pattern.Invoke()
      Write-Output 'accepted'
      exit 0
    }
  }
}
  Start-Sleep -Milliseconds 100
}
throw ('No native permission button in owned browser: ' + (($names | Select-Object -Unique) -join ', '))
`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  })
}
