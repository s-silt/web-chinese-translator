/**
 * 截图脚本（不进 CI）：WT_SHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts --project=offline
 * 弹出页以普通标签打开时「当前标签」是它自己：注入脚本把 tabs.query 指向目标页，模拟从目标页点开弹出页。
 */
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, offlineTest as test, FIXTURE_URL, acceptOwnedPermission } from './fixtures'
import { startMock } from './mock-server'

const SHOTS = resolve(process.env.WT_SCREENSHOT_DIR ?? 'test-results/ui-shots')
mkdirSync(SHOTS, { recursive: true })

test.skip(process.env.WT_SHOTS !== '1', '仅手动截图时运行')

interface ChromeLike {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> }; sync: { set(items: Record<string, unknown>): Promise<void> } }
  permissions: { request(query: { origins: string[] }): Promise<boolean> }
  tabs: { query(q: Record<string, unknown>): Promise<{ id?: number; url?: string }[]> }
}

async function seed(page: Page, settings: Record<string, unknown>, config: Record<string, unknown> | undefined): Promise<void> {
  await page.evaluate(async ({ settings, config }) => {
    const { chrome } = globalThis as unknown as { chrome: ChromeLike }
    await chrome.storage.sync.set({ settings: { enabled: true, uiLanguage: 'zh-CN', ...settings } })
    if (config) await chrome.storage.local.set({ translationConfig: config })
  }, { settings, config })
}

/** 在新标签打开弹出页，并让它把 targetUrl 所在标签当作当前标签 */
async function openPopupFor(context: BrowserContext, extensionId: string, targetUrl: string, width = 320): Promise<Page> {
  const popup = await context.newPage()
  await popup.addInitScript((target) => {
    const c = (globalThis as unknown as { chrome: ChromeLike }).chrome
    const original = c.tabs.query.bind(c.tabs)
    c.tabs.query = async (q) => {
      if (q.active === true && q.currentWindow === true) {
        const all = await original({})
        const found = all.filter((tab) => tab.url?.startsWith(target))
        return found.slice(-1)
      }
      return original(q)
    }
  }, targetUrl)
  await popup.setViewportSize({ width, height: 640 })
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.waitForTimeout(1200)
  return popup
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}

test.describe('界面截图', () => {
  test('弹出页：GitHub 页面、普通网页（已配置 / 未配置模型）、三种风格', async ({ context, extension, extensionId }) => {
    test.setTimeout(240_000)
    const api = await startMock()
    try {
      const readerUrl = (() => { const url = new URL(api.url); url.hostname = 'reader.fixture.test'; return url.origin })()
      const control = extension.page

      // GitHub 页面，未配置模型
      await seed(control, { uiStyle: 'classic', theme: 'light' }, undefined)
      const gh = await context.newPage()
      await gh.goto(FIXTURE_URL.repo)
      await gh.waitForTimeout(1500)
      for (const style of ['classic', 'cyber', 'glass'] as const) {
        await seed(control, { uiStyle: style, theme: 'light' }, undefined)
        const popup = await openPopupFor(context, extensionId, FIXTURE_URL.repo)
        await shot(popup, `popup-github-unconfigured-${style}`)
        await popup.close()
      }

      // 普通网页：走真实的「保存并连接」流程，顺便截设置页的连接状态
      await seed(control, { uiStyle: 'classic', theme: 'light' }, undefined)
      const options = await context.newPage()
      await options.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
      await options.locator('[data-test="wt-preset-deepseek"]').click()
      await shot(options, 'options-model-preset-picked')
      await options.getByPlaceholder(/api\.example\.com|v1/).fill(api.url)
      await options.locator('input[type="password"]').fill('sk-e2e-fake')
      await options.locator('[data-test="wt-model-input"]').fill('deepseek-chat')
      await options.locator('[data-test="wt-save"]').click()
      await acceptOwnedPermission(options, [`${new URL(api.url).protocol}//${new URL(api.url).hostname}/*`])
      await expect(options.locator('[data-test="wt-connection"]')).toContainText(/已连接/, { timeout: 15_000 })
      await shot(options, 'options-model-connected-classic')
      await options.locator('[data-test="wt-test-connection"]').click()
      await expect(options.locator('.ui-toast')).toContainText(/延迟/)
      await shot(options, 'options-model-test-toast-classic')
      // 网站访问权限：真实使用时由开启悬浮入口或本站自动翻译时申请
      const allSites = options.evaluate(() => {
        const { chrome } = globalThis as unknown as { chrome: ChromeLike }
        return chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })
      })
      void allSites.catch(() => undefined)
      await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
      expect(await allSites).toBe(true)
      const site = await context.newPage()
      await site.goto(readerUrl + '/page')
      await site.waitForTimeout(1500)
      for (const style of ['classic', 'cyber', 'glass'] as const) {
        for (const theme of style === 'cyber' ? (['dark'] as const) : (['light', 'dark'] as const)) {
          await seed(control, { uiStyle: style, theme }, undefined)
          const popup = await openPopupFor(context, extensionId, readerUrl)
          await shot(popup, `popup-site-${style}-${theme}`)
          if (style === 'classic' && theme === 'light') {
            await popup.locator('[data-test="wt-translate-page"]').click()
            await popup.waitForTimeout(2500)
            await shot(popup, 'popup-site-after-translate-classic-light')
          }
          await popup.close()
        }
      }

      // 总开关关闭
      await seed(control, { uiStyle: 'classic', theme: 'light', enabled: false }, undefined)
      const off = await openPopupFor(context, extensionId, readerUrl)
      await shot(off, 'popup-master-off-classic')
      await off.close()
    } finally {
      await api.close()
    }
  })

  test('设置页：分组导航与模型连接', async ({ page, extension, extensionId }) => {
    test.setTimeout(120_000)
    for (const style of ['classic', 'cyber', 'glass'] as const) {
      await seed(extension.page, { uiStyle: style, theme: 'light' }, { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' })
      for (const width of [1280, 420]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
        await page.waitForTimeout(800)
        // 打开时焦点落在分区标题上（便于读屏），截图前移开，避免焦点框进图
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await shot(page, `options-model-${style}-${width}`)
      }
    }
  })

  test('设置页：常用设置（输入翻译自动替换等待时间与全局快捷键）', async ({ page, extension, extensionId }) => {
    test.setTimeout(120_000)
    for (const style of ['classic', 'cyber', 'glass'] as const) {
      for (const theme of style === 'cyber' ? (['dark'] as const) : (['light', 'dark'] as const)) {
        await seed(extension.page, { uiStyle: style, theme }, {
          enabled: true,
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          inputTranslationEnabled: true,
          inputAutoReplaceDelayMs: 1500,
        })
        for (const width of [1280, 420]) {
          await page.setViewportSize({ width, height: 900 })
          await page.goto(`chrome-extension://${extensionId}/options.html#wt-general-title`)
          await page.waitForTimeout(800)
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
          await shot(page, `options-general-${style}-${theme}-${width}`)
        }
      }
    }
  })
})
