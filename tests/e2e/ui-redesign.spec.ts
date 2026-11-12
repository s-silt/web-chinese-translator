import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test'
import {
  acceptOwnedPermission,
  EXTENSION_PATH,
  installClosedShadowInspection,
  NATIVE_ACCESSIBILITY_ARGS,
  waitForSiteContentReady,
  waitForSiteScriptRegistration,
} from './fixtures'
import { PHYSICS, startMock } from './mock-server'

type FixtureChrome = typeof import('wxt/browser').browser

const PHASE = process.env.WT_UI_PHASE
const VALID_PHASE = PHASE === 'before' || PHASE === 'after'
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const EVIDENCE_DIR = process.env.WT_UI_EVIDENCE_DIR
  ? resolve(REPO_ROOT, process.env.WT_UI_EVIDENCE_DIR)
  : join(REPO_ROOT, 'test-results', 'ui-redesign-evidence', VALID_PHASE ? PHASE : 'unset')
const EXTENSION_OUTPUT = join(REPO_ROOT, '.output', 'chrome-mv3')

const UI_INPUT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Input fixture</title></head><body style="margin:24px;font:16px/1.6 sans-serif"><h1>Input fixture</h1><p>Draft area for input translation capture.</p><textarea id="ui-input" rows="4" style="width:440px"></textarea><div style="height:220px"></div><button id="send" type="button">Send</button></body></html>`

const POPUP_READY_DEFINITION = 'state badge nonempty/non-loading and master switch enabled'

interface RunMeta {
  readonly phase: string
  readonly platform: string
  readonly nodeVersion: string
  readonly build: string
  readonly buildTarget: string
  readonly buildVersion: string
  readonly buildTreeSha256: string
}

async function hashFilesUnder(root: string, prefix: string, out: Record<string, string>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.env') || entry.name.endsWith('.env')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      await hashFilesUnder(full, `${prefix}${entry.name}/`, out)
      continue
    }
    if (!entry.isFile()) continue
    out[`${prefix}${entry.name}`] = createHash('sha256').update(await readFile(full)).digest('hex')
  }
}

async function collectSourceHashes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await hashFilesUnder(join(REPO_ROOT, 'src'), 'src/', out)
  await hashFilesUnder(join(REPO_ROOT, 'tests'), 'tests/', out)
  for (const name of ['package.json', 'playwright.config.ts', 'vitest.config.ts', 'wxt.config.ts', 'tsconfig.json']) {
    try {
      out[name] = createHash('sha256').update(await readFile(join(REPO_ROOT, name))).digest('hex')
    } catch {
      void 0
    }
  }
  return out
}

async function collectBuildInfo(): Promise<{ version: string; treeSha256: string }> {
  const files: Record<string, string> = {}
  await hashFilesUnder(EXTENSION_OUTPUT, '', files)
  const tree = createHash('sha256')
  for (const key of Object.keys(files).sort()) {
    tree.update(key)
    tree.update('\0')
    tree.update(files[key]!)
    tree.update('\0')
  }
  const manifest = JSON.parse(await readFile(join(EXTENSION_OUTPUT, 'manifest.json'), 'utf8')) as { version?: string }
  return { version: manifest.version ?? 'unknown', treeSha256: tree.digest('hex') }
}

let metaPromise: Promise<RunMeta> | undefined

function runMeta(): Promise<RunMeta> {
  metaPromise ??= (async () => {
    const phase = PHASE ?? 'unset'
    const dir = join(EVIDENCE_DIR)
    await mkdir(dir, { recursive: true })
    const [sourceHashes, build] = await Promise.all([collectSourceHashes(), collectBuildInfo()])
    await writeFile(
      join(dir, 'source-hashes.json'),
      `${JSON.stringify({ phase, generatedAt: new Date().toISOString(), files: sourceHashes }, null, 2)}\n`,
    )
    return {
      phase,
      platform: process.platform,
      nodeVersion: process.version,
      build: `chrome-mv3@${build.version}+${build.treeSha256.slice(0, 16)}`,
      buildTarget: 'chrome-mv3',
      buildVersion: build.version,
      buildTreeSha256: build.treeSha256,
    }
  })()
  return metaPromise
}

async function writeEvidence(name: string, data: unknown): Promise<string> {
  await runMeta()
  const path = join(EVIDENCE_DIR, name)
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
  return path
}

const popupGeometry: Record<
  string,
  {
    innerWidth: number
    innerHeight: number
    scrollWidth: number
    scrollHeight: number
    popupRect: { x: number; y: number; width: number; height: number } | null
  }
> = {}

async function flushPopupGeometry(): Promise<void> {
  const meta = await runMeta()
  await writeFile(
    join(EVIDENCE_DIR, 'popup-capture-geometry.json'),
    `${JSON.stringify(
      {
        phase: meta.phase,
        viewportPolicy: 'native popup, no device-metrics override',
        captures: popupGeometry,
      },
      null,
      2,
    )}\n`,
  )
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await runMeta()
  const path = join(EVIDENCE_DIR, name)
  if (new URL(page.url()).pathname.endsWith('popup.html')) {
    await page.locator('.popup').screenshot({ path })
    popupGeometry[name] = await page.evaluate(() => {
      const rect = document.querySelector('.popup')?.getBoundingClientRect()
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        popupRect:
          rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })
    await flushPopupGeometry()
    return
  }
  const overflowsViewport = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 1,
  )
  await page.screenshot({ path, fullPage: fullPage && !overflowsViewport })
}

async function launch(
  viewport: { width: number; height: number } | null = null,
): Promise<{ context: BrowserContext; extensionId: string }> {
  process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1'
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    viewport,
    args: [
      ...NATIVE_ACCESSIBILITY_ARGS,
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--lang=zh-CN',
      '--apps-gallery-install-auto-confirm-for-tests=accept',
      '--host-resolver-rules=MAP reader.fixture.test 127.0.0.1',
      '--no-proxy-server',
    ],
  })
  await installClosedShadowInspection(context)
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return { context, extensionId: new URL(worker.url()).host }
}

async function showOptionsSection(options: Page, section: 'general' | 'model'): Promise<void> {
  const target = section === 'general' ? 'wt-general-title' : 'wt-title'
  await options.locator(`[data-test="nav-${target}"]`).click()
  const control = section === 'general' ? 'wt-general-view' : 'wt-model-view'
  await expect(options.locator(`[data-test="${control}"]`)).toBeVisible()
}

async function configFlag(options: Page, key: string): Promise<boolean> {
  return options.evaluate(async (name) => {
    const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
    const reply = (await chrome.runtime.sendMessage({ type: 'wt:get-config' })) as
      | { ok: boolean; config?: Record<string, unknown> }
      | undefined
    if (!reply?.ok || reply.config === undefined) throw new Error('Fixture config read failed')
    return reply.config[name] === true
  }, key)
}

async function saveAndConnect(context: BrowserContext, extensionId: string, apiUrl: string): Promise<Page> {
  const options = await context.newPage()
  await options.setViewportSize({ width: 1280, height: 800 })
  await options.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
  await options.evaluate(async () => {
    const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
    const stored = await chrome.storage.sync.get('settings')
    await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiLanguage: 'zh-CN' } })
  })
  await options.getByPlaceholder(/api\.example\.com|v1/).fill(apiUrl)
  await options.locator('input[type="password"]').fill('sk-e2e-fake')
  await options.locator('[data-test="wt-model-input"]').fill('mock-model')
  await options.locator('[data-test="wt-save"]').click()
  await acceptOwnedPermission(options, ['http://127.0.0.1/*'])
  await expect(options.getByText(/connection succeeded|连接成功/)).toBeVisible({ timeout: 15000 })
  return options
}

async function enableFloating(options: Page): Promise<void> {
  await showOptionsSection(options, 'general')
  const toggle = options.locator('[data-test="wt-floating-toggle"] [role="switch"]')
  await expect(toggle).toBeEnabled()
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  const hasAccess = (): Promise<boolean> =>
    options.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      return chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })
    })
  if (!(await hasAccess())) {
    await options.locator('[data-test="wt-floating-grant"]').click()
    await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
  }
  await expect.poll(hasAccess).toBe(true)
  await expect.poll(() => configFlag(options, 'floatingButtonEnabled')).toBe(true)
}

async function enableInputTranslation(options: Page): Promise<void> {
  await showOptionsSection(options, 'general')
  const toggle = options.locator('[data-test="wt-input-translation-toggle"] [role="switch"]')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeEnabled()
}

async function enableSelection(options: Page): Promise<void> {
  await showOptionsSection(options, 'general')
  await options.locator('[data-test="wt-assist-mode"]').click()
  await options.getByRole('option', { name: /Selection assist|划词辅助|劃詞輔助/ }).click()
  await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
  await expect
    .poll(() =>
      options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const data = await chrome.storage.local.get('translationConfig')
        return (
          (data.translationConfig as { selectionPopupEnabled?: boolean } | undefined)?.selectionPopupEnabled === true &&
          (await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }))
        )
      }),
    )
    .toBe(true)
  await expect(options.locator('[data-test="wt-assist-mode"]')).toBeEnabled()
}

async function setAutoInteractionOff(options: Page): Promise<void> {
  const reply = await options.evaluate(async () => {
    const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
    return chrome.runtime.sendMessage({ type: 'wt:save-config', patch: { autoInteractionEnabled: false } })
  })
  expect(reply).toMatchObject({ ok: true })
}

async function setAppearance(
  options: Page,
  uiStyle: 'classic' | 'cyber' | 'glass',
  theme: 'light' | 'dark',
): Promise<void> {
  await options.evaluate(
    async ({ style, mode }) => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      const stored = await chrome.storage.sync.get('settings')
      await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiStyle: style, theme: mode } })
    },
    { style: uiStyle, mode: theme },
  )
}

async function assertAppearance(page: Page, uiStyle: 'classic' | 'cyber' | 'glass', theme: 'light' | 'dark'): Promise<void> {
  const html = page.locator('html')
  expect(await html.getAttribute('data-style')).toBe(uiStyle === 'classic' ? null : uiStyle)
  expect(await html.getAttribute('data-theme')).toBe(theme)
}

async function workerOf(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
}

test('深色导航与玻璃悬浮菜单在明暗网页上保持文字对比度', async () => {
  const api = await startMock()
  const { context, extensionId } = await launch({ width: 1100, height: 800 })
  const contrast = async (page: Page, selector: string): Promise<number> => page.locator(selector).evaluate(node => {
    const rgba = (value: string): number[] => {
      const parts = (value.match(/[\d.]+/g) ?? []).map(Number)
      return [...parts.slice(0, 3), parts[3] ?? 1]
    }
    const layers: number[][] = []
    let current: Element | null = node
    while (current) {
      layers.push(rgba(getComputedStyle(current).backgroundColor))
      current = current.parentElement ?? (current.getRootNode() as ShadowRoot).host ?? null
    }
    let background = [255, 255, 255]
    for (const layer of layers.reverse()) background = background.map((value, i) => layer[i]! * layer[3]! + value * (1 - layer[3]!))
    const luminance = (color: number[]): number => color.slice(0, 3).reduce((sum, value, i) => {
      const srgb = value / 255
      return sum + [0.2126, 0.7152, 0.0722][i]! * (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4)
    }, 0)
    const levels = [luminance(rgba(getComputedStyle(node).color)), luminance(background)].sort((a, b) => a - b)
    return (levels[1]! + 0.05) / (levels[0]! + 0.05)
  })
  try {
    const options = await saveAndConnect(context, extensionId, api.url)
    await setAppearance(options, 'classic', 'dark')
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.configure({ soft: true }).poll(() => contrast(options, '.options-nav a[aria-current="page"]')).toBeGreaterThanOrEqual(4.5)
    await enableFloating(options)
    await setAppearance(options, 'glass', 'dark')
    await expect(options.locator('html')).toHaveAttribute('data-style', 'glass')
    const page = await context.newPage()
    await page.goto(`${api.url.replace('127.0.0.1', 'reader.fixture.test')}/page`)
    await waitForSiteScriptRegistration(options, { url: page.url() })
    await waitForSiteContentReady(options, page, { supported: false })
    await page.bringToFront()
    const entry = page.locator('.floating-entry')
    await expect(entry).toBeVisible()
    const rect = await entry.boundingBox()
    expect(rect).not.toBeNull()
    const width = await page.evaluate(() => innerWidth)
    await page.mouse.move(Math.min(rect!.x + rect!.width - 4, width - 4), rect!.y + rect!.height / 2)
    await entry.click()
    const menu = page.locator('.floating-menu')
    await expect(menu).toBeVisible()
    await expect.poll(() => menu.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    for (const color of ['#ffffff', '#000000']) {
      await page.evaluate(value => { document.documentElement.style.backgroundColor = value }, color)
      await expect.poll(() => contrast(page, '.floating-disclosure')).toBeGreaterThanOrEqual(4.5)
      await expect.poll(() => contrast(page, '.floating-close')).toBeGreaterThanOrEqual(4.5)
    }
  } finally {
    await context.close()
    await api.close()
  }
})

async function workerTabId(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (target) => {
    const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url === target) ?? tabs.find((candidate) => candidate.active === true)
    if (tab?.id === undefined) throw new Error('fixture tab unavailable')
    return tab.id
  }, url)
}

async function popupReady(popup: Page): Promise<void> {
  await popup.waitForFunction(
    () => {
      const badge = document.querySelector('[data-test="wt-page-state"]')
      const sw = document.querySelector('.popup-enable [role="switch"]')
      const text = badge?.textContent?.trim() ?? ''
      return text !== '' && text !== '加载中' && text !== 'Loading' && sw instanceof HTMLButtonElement && !sw.disabled
    },
    undefined,
    { timeout: 15_000 },
  )
}

async function openNativePopup(context: BrowserContext, page: Page): Promise<{ popup: Page; elapsedMs: number }> {
  await page.bringToFront()
  const worker = await workerOf(context)
  const tabId = await workerTabId(worker, page.url())
  const start = performance.now()
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    worker.evaluate(async (id) => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      const tab = await chrome.tabs.get(id)
      await chrome.action.openPopup({ windowId: tab.windowId })
    }, tabId),
  ])
  await popupReady(popup)
  return { popup, elapsedMs: performance.now() - start }
}

async function popupStateText(popup: Page): Promise<string> {
  return ((await popup.locator('[data-test="wt-page-state"]').textContent()) ?? '').trim()
}

async function popupCaptureState(popup: Page) {
  return popup.evaluate(async () => {
    const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const primary = document.querySelector<HTMLButtonElement>('[data-test="wt-translate-page"]')
    const secondary = document.querySelector<HTMLButtonElement>('[data-test="wt-configure-now"]')
    return {
      status: document.querySelector('[data-test="wt-page-state"]')?.textContent?.trim(),
      primary: { text: primary?.textContent?.trim(), disabled: primary?.disabled },
      secondary: secondary ? { text: secondary.textContent?.trim(), disabled: secondary.disabled } : null,
      activeTabId: tab?.id ?? null,
      activeTabUrl: tab?.url ?? null,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    }
  })
}

async function sendToTab(context: BrowserContext, url: string, message: unknown): Promise<unknown> {
  const worker = await workerOf(context)
  return worker.evaluate(
    async ({ target, msg }) => {
      const { chrome } = globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: object): Promise<Array<{ id?: number; url?: string }>>
            sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>
          }
        }
      }
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === target)
      if (tab?.id === undefined) throw new Error('fixture tab unavailable')
      return chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 })
    },
    { target: url, msg: message },
  )
}

async function waitForRegistration(context: BrowserContext, pattern: string): Promise<void> {
  const worker = await workerOf(context)
  await waitForSiteScriptRegistration(worker, { requiredMatches: [pattern] })
}

async function waitForSiteScript(context: BrowserContext, page: Page): Promise<number> {
  const worker = await workerOf(context)
  return waitForSiteContentReady(worker, page)
}

test.describe('UI redesign baseline capture', () => {
  test.skip(!VALID_PHASE, 'requires WT_UI_PHASE=before|after')

  let api: Awaited<ReturnType<typeof startMock>>
  const readingUrl = (): string => api.url.replace('127.0.0.1', 'reader.fixture.test')

  test.beforeEach(async () => {
    api = await startMock()
  })

  test.afterEach(async () => {
    await api.close()
  })

  test('未配置界面基线：页面不可访问、模型与通用设置、空文本窗', async () => {
    const { context, extensionId } = await launch()
    try {
      await runMeta()
      const options = await context.newPage()
      await options.setViewportSize({ width: 1280, height: 800 })
      await options.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
      await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const stored = await chrome.storage.sync.get('settings')
        await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiLanguage: 'zh-CN' } })
      })
      await options.reload()
      await expect(options.locator('[data-test="wt-model-view"]')).toBeVisible()

      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      const { popup } = await openNativePopup(context, page)
      await expect(popup.locator('.popup')).toBeVisible()
      await popup.waitForFunction(
        () => {
          const sw = document.querySelector('.popup-enable [role="switch"]')
          return sw instanceof HTMLButtonElement && !sw.disabled
        },
        undefined,
        { timeout: 15_000 },
      )
      if (PHASE === 'after') {
        await expect(popup.locator('[data-test="wt-translate-page"]')).toBeDisabled()
        await expect(popup.locator('[data-test="wt-translate-page"]')).toHaveText('翻译本页')
        await expect(popup.locator('[data-test="wt-configure-now"]')).toBeVisible()
        await expect(popup.locator('[data-test="wt-configure-now"]')).toBeEnabled()
        const captured = await popupCaptureState(popup)
        expect(captured.activeTabUrl).toBeNull()
        await writeEvidence('unconfigured-inaccessible-popup-dom.json', { pageUrl: page.url(), ...captured })
      }
      await shot(popup, 'unconfigured-inaccessible-popup.png')
      await popup.close()

      if (PHASE === 'after') {
        await page.goto('chrome://extensions/')
        const { popup: blocked } = await openNativePopup(context, page)
        await expect(blocked.locator('[data-test="wt-translate-page"]')).toBeDisabled()
        await expect(blocked.locator('[data-test="wt-translate-page"]')).toHaveText('翻译本页')
        const setup = blocked.locator('[data-test="wt-configure-now"]')
        await expect(setup).toBeVisible()
        await expect(setup).toBeEnabled()
        await writeEvidence('blocked-capture-dom.json', { pageUrl: page.url(), ...await popupCaptureState(blocked) })
        await shot(blocked, 'unconfigured-unsupported-popup.png')
        const openedPromise = context.waitForEvent('page')
        await setup.click()
        const configured = await openedPromise
        await configured.waitForURL(`chrome-extension://${extensionId}/options.html#wt-title`)
        await expect(configured.locator('[data-test="wt-model-view"]')).toBeVisible()
        await configured.close()
      }

      await shot(options, 'fresh-options-model.png', true)
      await showOptionsSection(options, 'general')
      await shot(options, 'fresh-options-general.png', true)

      const win = await context.newPage()
      await win.setViewportSize({ width: 1280, height: 800 })
      await win.goto(`chrome-extension://${extensionId}/translate.html`)
      await expect(win.locator('[data-test="wt-text-input"]')).toBeVisible()
      await shot(win, 'fresh-text-window.png', true)
      await win.close()
    } finally {
      await context.close()
    }
  })

  test('已配置弹出页状态流与五套外观截图矩阵', async () => {
    const { context, extensionId } = await launch()
    try {
      await runMeta()
      const options = await saveAndConnect(context, extensionId, api.url)
      await enableFloating(options)
      await enableInputTranslation(options)
      await setAutoInteractionOff(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      const tabId = await waitForSiteScript(context, page)
      await expect(page.locator('#p1')).toHaveText(PHYSICS)

      const first = await openNativePopup(context, page)
      const popup = first.popup
      const identity = await popup.evaluate(async (expectedTabId) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
        const ownTab = await chrome.tabs.getCurrent()
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })
        return {
          popupUrl: location.href,
          activeTabId: active?.id ?? null,
          ownTabId: ownTab?.id ?? null,
          popupContextListed: contexts.some((item) => item.documentUrl === location.href),
          expectedTabId,
        }
      }, tabId)
      expect(identity.activeTabId).toBe(tabId)
      expect(identity.ownTabId).toBeNull()
      expect(identity.popupContextListed).toBe(true)
      await writeEvidence('native-popup-identity.json', { ...identity, tabUrl: page.url(), extensionId })

      const readyText = await popupStateText(popup)
      await shot(popup, 'popup-state-ready.png')
      await popup.locator('[data-test="wt-translate-page"]').click()
      await expect(page.locator('#p1')).toHaveText('中文译文')
      await expect.poll(() => popupStateText(popup), { timeout: 10_000 }).not.toBe(readyText)
      const translatedText = await popupStateText(popup)
      await shot(popup, 'popup-state-translated.png')
      await popup.locator('[data-test="wt-translate-page"]').click()
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      await shot(popup, 'popup-state-restored.png')
      await popup.close()
      await page.bringToFront()

      const reopened = await openNativePopup(context, page)
      const reopenedText = await popupStateText(reopened.popup)
      await shot(reopened.popup, 'popup-state-reopened.png')
      await reopened.popup.close()
      await writeEvidence('popup-states.json', { ready: readyText, translated: translatedText, reopened: reopenedText })
      await page.bringToFront()

      const combos = [
        ['classic', 'light'],
        ['classic', 'dark'],
        ['cyber', 'dark'],
        ['glass', 'light'],
        ['glass', 'dark'],
      ] as const
      for (const [uiStyle, theme] of combos) {
        await setAppearance(options, uiStyle, theme)
        const opened = await openNativePopup(context, page)
        await assertAppearance(opened.popup, uiStyle, theme)
        await shot(opened.popup, `popup-${uiStyle}-${theme}.png`)
        await opened.popup.close()
        await page.bringToFront()
        await options.bringToFront()
        await options.locator('[data-test="nav-wt-title"]').click()
        await expect(options.locator('[data-test="wt-model-view"]')).toBeVisible()
        await expect(options.locator('[data-test="wt-connection"]')).toBeVisible()
        await assertAppearance(options, uiStyle, theme)
        await shot(options, `options-model-${uiStyle}-${theme}.png`, true)
      }
    } finally {
      await context.close()
    }
  })

  test('原生弹出页打开耗时原始采样', async () => {
    const { context, extensionId } = await launch()
    try {
      const meta = await runMeta()
      const options = await saveAndConnect(context, extensionId, api.url)
      await enableFloating(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await waitForSiteScript(context, page)
      await page.bringToFront()
      const worker = await workerOf(context)
      const tabId = await workerTabId(worker, page.url())
      const browserVersion = context.browser()?.version() ?? 'unknown'

      const warmup = await openNativePopup(context, page)
      await warmup.popup.close()
      await page.bringToFront()

      const samples: { index: number; elapsedMs: number }[] = []
      let firstPopupViewport: { innerWidth: number; innerHeight: number; devicePixelRatio: number } | null = null
      for (let index = 0; index < 10; index += 1) {
        const start = performance.now()
        const [popup] = await Promise.all([
          context.waitForEvent('page', { timeout: 15_000 }),
          worker.evaluate(async (id) => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            const tab = await chrome.tabs.get(id)
            await chrome.action.openPopup({ windowId: tab.windowId })
          }, tabId),
        ])
        await popupReady(popup)
        samples.push({ index, elapsedMs: performance.now() - start })
        if (index === 0) {
          firstPopupViewport = await popup.evaluate(() => ({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
          }))
        }
        await popup.close()
        await page.bringToFront()
      }
      await writeEvidence('popup-open.json', {
        phase: meta.phase,
        protocol: 'native-popup-ready-v2',
        viewportPolicy: 'native popup, no device-metrics override',
        warmups: 1,
        samples,
        firstPopupViewport,
        browserVersion,
        platform: meta.platform,
        nodeVersion: meta.nodeVersion,
        build: meta.build,
        buildVersion: meta.buildVersion,
        buildTreeSha256: meta.buildTreeSha256,
        readyDefinition: POPUP_READY_DEFINITION,
      })
    } finally {
      await context.close()
    }
  })

  test('页面浮层基线：输入自动直写/还原、划词面板、悬浮菜单、文本窗', async () => {
    const { context, extensionId } = await launch()
    try {
      await runMeta()
      const options = await saveAndConnect(context, extensionId, api.url)
      api.setTextTranslator((text) => {
        if (text === '你好\n第二行') return 'Hello\nWorld'
        if (text === '你好，世界') return 'Hello, world'
        return text
          .split('\n')
          .map((line) => `EN:${line}`)
          .join('\n')
      })
      await enableFloating(options)
      await enableInputTranslation(options)
      await enableSelection(options)
      await context.route('**/ui-input', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: UI_INPUT_HTML }),
      )
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/ui-input`)
      await waitForSiteScriptRegistration(options, { url: page.url() })
      await waitForSiteContentReady(options, page, { supported: true })

      const input = page.locator('#ui-input')
      await input.click()
      await input.fill('你好\n第二行')
      await expect(input).toHaveValue('Hello\nWorld', { timeout: 10_000 })
      const popover = page.locator('[data-wt-root] .popover')
      const status = popover.locator('[role="status"]')
      await expect(popover.locator('button[data-action="restore"]')).toBeVisible()
      await expect(popover.locator('button[data-action="replace"]')).toBeHidden()
      await expect(status).not.toHaveText('Hello\nWorld')
      await expect(status).not.toHaveText('')
      await shot(page, 'input-translated.png')

      await popover.locator('button[data-action="restore"]').click()
      await expect(input).toHaveValue('你好\n第二行')
      await expect(status).toHaveText('')
      await expect(popover).toBeHidden()
      await expect(input).toBeFocused()
      await shot(page, 'input-restored.png')

      await setAutoInteractionOff(options)
      const selectionReply = await sendToTab(context, page.url(), { type: 'wt:show-selection', text: '你好，世界' })
      expect(selectionReply).toMatchObject({ ok: true })
      await expect(page.locator('.panel-target')).toHaveText('Hello, world')
      const panelState = await page.locator('.panel-target').textContent()
      await shot(page, 'selection-panel.png')
      await page.keyboard.press('Escape')
      await expect(page.locator('.panel')).toBeHidden()

      const entry = page.locator('.floating-entry')
      await expect(entry).toBeVisible({ timeout: 10_000 })
      const box = await entry.boundingBox()
      expect(box).not.toBeNull()
      const { width: vw } = await page.evaluate(() => ({ width: innerWidth }))
      await page.mouse.click(Math.min(box!.x + box!.width - 6, vw - 4), box!.y + box!.height / 2)
      await expect(page.locator('.floating-menu')).toBeVisible({ timeout: 10_000 })
      await shot(page, 'floating-menu.png')
      await page.keyboard.press('Escape')

      const win = await context.newPage()
      await win.goto(`chrome-extension://${extensionId}/translate.html`)
      await win.locator('[data-test="wt-text-input"]').fill('# 标题\n\n**粗体** 文字\n\n- 第一项')
      await win.locator('[data-test="wt-text-translate"]').click()
      await expect(win.locator('[data-test="wt-text-result"]')).not.toHaveValue('')
      const textResult = await win.locator('[data-test="wt-text-result"]').inputValue()
      await shot(win, 'text-window-result.png', true)
      await writeEvidence('page-surfaces.json', { panelTarget: panelState?.trim() ?? '', textWindowResult: textResult })
    } finally {
      await context.close()
    }
  })

  test('设置页交互与资源原始采样', async () => {
    const { context, extensionId } = await launch()
    try {
      const meta = await runMeta()
      const options = await saveAndConnect(context, extensionId, api.url)
      const browserVersion = context.browser()?.version() ?? 'unknown'
      const base = {
        phase: meta.phase,
        browserVersion,
        platform: meta.platform,
        nodeVersion: meta.nodeVersion,
        build: meta.build,
        buildVersion: meta.buildVersion,
        buildTreeSha256: meta.buildTreeSha256,
      }

      await showOptionsSection(options, 'general')
      const sw = options.locator('[data-test="wt-auto-interaction"] [role="switch"]')
      await expect(sw).toBeEnabled()
      const switchSelector = '[data-test="wt-auto-interaction"] [role="switch"]'
      const switchSamples: { index: number; elapsedMs: number }[] = []
      for (let index = 0; index < 10; index += 1) {
        const previous = await sw.getAttribute('aria-checked')
        const expected = previous === 'true' ? 'false' : 'true'
        const start = performance.now()
        await sw.click()
        await options.waitForFunction(
          ({ selector, wanted }: { selector: string; wanted: string }) =>
            document.querySelector(selector)?.getAttribute('aria-checked') === wanted,
          { selector: switchSelector, wanted: expected },
          { timeout: 10_000 },
        )
        switchSamples.push({ index, elapsedMs: performance.now() - start })
      }
      await writeEvidence('switch-response.json', {
        ...base,
        protocol: 'automation-observed-switch-response-v1',
        samples: switchSamples,
        toggles: 10,
        restoredToInitial: (await sw.getAttribute('aria-checked')) === 'true',
      })

      await options.locator('[data-test="nav-wt-title"]').click()
      await expect(options.locator('[data-test="wt-model-view"]')).toBeVisible()
      const summary = options.locator('[data-test="wt-advanced"] > summary')
      await expect(summary).toBeVisible()

      const cdp = await context.newCDPSession(options)
      const motionRuns: {
        prefersReducedMotion: string
        timestampsMs: number[]
        computed: Record<string, Record<string, string> | null>
      }[] = []
      for (const motion of ['no-preference', 'reduce'] as const) {
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: motion }],
        })
        await options.evaluate(() => {
          const details = document.querySelector<HTMLDetailsElement>('[data-test="wt-advanced"]')
          if (details !== null) details.open = false
        })
        const observation = options.evaluate(
          () =>
            new Promise<number[]>((resolveFrames) => {
              const frames: number[] = []
              const start = performance.now()
              const frame = (now: number): void => {
                frames.push(now - start)
                if (now - start < 1200) requestAnimationFrame(frame)
                else resolveFrames(frames)
              }
              requestAnimationFrame(frame)
            }),
        )
        await summary.click()
        const timestampsMs = await observation
        const computed = await options.evaluate(() => {
          const pick = (selector: string): Record<string, string> | null => {
            const el = document.querySelector(selector)
            if (el === null) return null
            const style = getComputedStyle(el)
            return {
              transitionDuration: style.transitionDuration,
              transitionProperty: style.transitionProperty,
              animationDuration: style.animationDuration,
              animationName: style.animationName,
            }
          }
          return {
            switchKnob: pick('.ui-switch-knob'),
            rippleWave: pick('.ui-ripple-wave'),
            detailsBody: pick('.wt-details-body'),
          }
        })
        motionRuns.push({ prefersReducedMotion: motion, timestampsMs, computed })
        await cdp.send('Emulation.setEmulatedMedia', { features: [] })
      }
      await writeEvidence('animation-frames.json', {
        ...base,
        protocol: 'raf-timestamps-on-details-toggle-v1',
        windowMs: 1200,
        runs: motionRuns,
      })

      await options.evaluate(() => {
        const details = document.querySelector<HTMLDetailsElement>('[data-test="wt-advanced"]')
        if (details !== null) details.open = false
      })
      await cdp.send('HeapProfiler.enable')
      await cdp.send('HeapProfiler.collectGarbage')
      const countersBefore = await cdp.send('Memory.getDOMCounters')
      for (let cycle = 0; cycle < 20; cycle += 1) {
        await summary.click()
        await summary.click()
      }
      await options.evaluate(
        () => new Promise<void>((resolveFrames) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames()))),
      )
      await cdp.send('HeapProfiler.collectGarbage')
      const countersAfter = await cdp.send('Memory.getDOMCounters')
      const settled = await options.evaluate(() => ({
        runningAnimations: document.getAnimations().filter((animation) => animation.playState === 'running').length,
        openDetails: document.querySelectorAll('details[open]').length,
      }))
      await writeEvidence('dom-counters.json', {
        ...base,
        protocol: 'cdp-dom-counters-v1',
        forcedGC: true,
        cycles: 20,
        clicks: 40,
        before: countersBefore,
        after: countersAfter,
        ...settled,
      })
      await cdp.detach()
    } finally {
      await context.close()
    }
  })
})
