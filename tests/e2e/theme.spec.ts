import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import {
  expect,
  offlineTest as test,
  EXTENSION_PATH,
  acceptOwnedPermission,
  NATIVE_ACCESSIBILITY_ARGS,
  installClosedShadowInspection,
  waitForSiteScriptRegistration,
  waitForSiteContentReady,
} from './fixtures'
import { startMock, PHYSICS } from './mock-server'

const SHOTS = process.env.WT_SCREENSHOT_DIR ?? join(tmpdir(), 'wt-theme-shots')
const STYLES = ['classic', 'cyber', 'glass'] as const

test.describe('界面风格', () => {
  for (const style of STYLES) {
    for (const width of [360, 1280]) {
      test(`设置页 ${style} @${width}px 无横向溢出`, async ({ page, extension, extensionId }) => {
        await extension.setSettings({ uiStyle: style })
        await page.setViewportSize({ width, height: 800 })
        await page.goto(`chrome-extension://${extensionId}/options.html`)
        await page.waitForLoadState('domcontentloaded')
        for (const section of ['wt-general-title', 'wt-title', 'wt-dictionary-title']) {
          await page.locator(`[data-test="nav-${section}"]`).click()
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
          ).toBe(true)
          await page.screenshot({ path: join(SHOTS, `${style}-options-${section}-${width}.png`), fullPage: true })
        }
      })
    }

    test(`弹出页 ${style} @320px 无横向溢出`, async ({ page, extension, extensionId }) => {
      await extension.setSettings({ uiStyle: style })
      await page.setViewportSize({ width: 320, height: 600 })
      await page.goto(`chrome-extension://${extensionId}/popup.html`)
      await page.waitForLoadState('domcontentloaded')
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true)
      await page.screenshot({ path: join(SHOTS, `${style}-popup-320.png`), fullPage: true })
    })
  }
})


test.describe('划词卡片风格', () => {
  let api: Awaited<ReturnType<typeof startMock>>
  const readingUrl = (): string => api.url.replace('127.0.0.1', 'reader.fixture.test')
  test.beforeEach(async () => { api = await startMock() })
  test.afterEach(async () => { await api.close() })

  async function launch(): Promise<{ context: BrowserContext; extensionId: string }> {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--lang=zh-CN',
        ...NATIVE_ACCESSIBILITY_ARGS,
        '--apps-gallery-install-auto-confirm-for-tests=accept',
        '--host-resolver-rules=MAP reader.fixture.test 127.0.0.1',
        '--no-proxy-server',
      ],
    })
    await installClosedShadowInspection(context)
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
    const extensionId = new URL(worker.url()).host
    return { context, extensionId }
  }

  /** 拖选；headed 窗口焦点不稳时重试，每次先清空旧选区 */
  async function dragText(page: Page, selector: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.bringToFront()
      await page.locator(selector).scrollIntoViewIfNeeded()
      await page.mouse.click(4, 4)
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const box = await page.locator(selector).boundingBox()
      if (box === null) throw new Error(`no box for ${selector}`)
      await page.mouse.move(box.x + 2, box.y + 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 8 })
      await page.mouse.up()
      if ((await page.evaluate(() => getSelection()?.toString() ?? '')).length > 0) return
    }
    throw new Error(`no selection for ${selector}`)
  }

  for (const style of ['cyber', 'glass'] as const) {
    test(`${style} 卡片 data-style 正确并截图`, async () => {
      const { context, extensionId } = await launch()
      try {
        const options = await context.newPage()
        await options.goto(`chrome-extension://${extensionId}/options.html`)
        await options.evaluate(async ({ url, style }: { url: string; style: string }) => {
          const { chrome } = globalThis as unknown as {
            chrome: {
              storage: { local: { set(items: Record<string, unknown>): Promise<void> }; sync: { set(items: Record<string, unknown>): Promise<void> } }
            }
          }
          await chrome.storage.local.set({
            translationConfig: { enabled: true, selectionPopupEnabled: true, baseUrl: url, model: 'm', targetLanguage: 'zh-CN' },
          })
          await chrome.storage.sync.set({ settings: { uiStyle: style } })
        }, { url: api.url, style })
        // reader 主机权限：先发起 request（挂起等弹窗），原生辅助功能确认允许
        const permissionRequest = options.evaluate(() => {
          const { chrome } = globalThis as unknown as {
            chrome: { permissions: { request(query: { origins: string[] }): Promise<boolean> } }
          }
          return chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })
        })
        void permissionRequest.catch((error: unknown) =>
          console.error('Fixture permission request failed:', error),
        )
        await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
        expect(await permissionRequest).toBe(true)
        const targetUrl = `${readingUrl()}/page`
        await waitForSiteScriptRegistration(options, {
          url: targetUrl,
          requiredMatches: ['http://*/*', 'https://*/*'],
          selectionPopupEnabled: true,
        })
        const page = await context.newPage()
        await page.goto(targetUrl)
        await page.waitForSelector('#p1')
        await waitForSiteContentReady(options, page, { supported: true, refresh: true })
        await dragText(page, '#p1')
        expect(await page.evaluate(() => getSelection()?.toString())).toBe(PHYSICS)
        const panel = page.locator(`.panel[data-style="${style}"]`)
        await expect(panel).toBeVisible()
        // HUD 角标用 background-image 绘制，不得在 overflow:auto 面板上撑出滚动条
        if (style === 'cyber') {
          const scrollbarFree = await panel.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)
          expect(scrollbarFree).toBe(true)
        }
        await page.screenshot({ path: join(SHOTS, `${style}-card.png`) })
      } finally {
        await context.close()
      }
    })
  }
})
