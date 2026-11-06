import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium, test as nativeTest, type BrowserContext, type Locator, type Page } from '@playwright/test'
import * as ts from 'typescript'
import zhCN from '../../src/i18n/zh-CN'
import type { TranslationPanel } from '../../src/translation/panel'
import {
  expect,
  test,
  acceptOwnedPermission,
  EXTENSION_PATH,
  NATIVE_ACCESSIBILITY_ARGS,
  inspectClosedShadowPage,
  installClosedShadowInspection,
  waitForSiteScriptRegistration,
  waitForSiteContentReady,
  sendOwnedBrowserAltShortcut,
  invokeOwnedContextMenu,
  invokeOwnedSelectionMenu,
} from './fixtures'
import { bundleDanmakuFixture, bundleManagedChatFixture, bundleProseMirrorFixture } from './chat-editors-fixture'
import { bundleDiscordSlateFixture } from './discord-slate-fixture'
import { startMock, PHYSICS, ENTROPY, THIRD, LONG_RESULT, PAGE_HTML, type MockCall } from './mock-server'

type FixtureChrome = typeof import('wxt/browser').browser


test.describe.configure({ timeout: 90000 })

test.describe('网页翻译真实流程', () => {
  let api: Awaited<ReturnType<typeof startMock>>
  const readingUrl = (): string => api.url.replace('127.0.0.1', 'reader.fixture.test')

  test.beforeEach(async () => {
    api = await startMock()
  })

  test.afterEach(async () => {
    await api.close()
  })

  async function launch(
    viewport: { width: number; height: number } | null = { width: 1280, height: 800 },
  ): Promise<{ context: BrowserContext; extensionId: string }> {
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

  async function showOptionsSection(options: Page, section: 'general' | 'model' | 'sites'): Promise<void> {
    const target = section === 'general' ? 'wt-general-title' : section === 'model' ? 'wt-title' : 'wt-dictionary-title'
    await options.locator(`[data-test="nav-${target}"]`).click()
    const control = section === 'general' ? 'wt-general-view' : section === 'model' ? 'wt-model-view' : 'wt-sites-view'
    await expect(options.locator(`[data-test="${control}"]`)).toBeVisible()
  }

  async function saveAndConnect(context: BrowserContext, extensionId: string): Promise<Page> {
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
    await options.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      const stored = await chrome.storage.sync.get('settings')
      await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiLanguage: 'zh-CN' } })
    })
    await options.getByPlaceholder(/api\.example\.com|v1/).fill(api.url)
    await options.locator('input[type="password"]').fill('sk-e2e-fake')
    await options.locator('[data-test="wt-model-input"]').fill('mock-model')
    await options.locator('[data-test="wt-save"]').click()
    await acceptOwnedPermission(options, ['http://127.0.0.1/*'])
    try {
      await expect(options.getByText(/connection succeeded|连接成功/)).toBeVisible({ timeout: 15000 })
    } catch (error) {
      const state = await options.evaluate(async (endpoint) => {
        const { chrome } = globalThis as unknown as {
          chrome: {
            permissions: { contains(query: { origins: string[] }): Promise<boolean> }
            storage: { local: { get(key: string): Promise<Record<string, { baseUrl?: string }>> } }
          }
        }
        const config = await chrome.storage.local.get('translationConfig')
        return {
          granted: await chrome.permissions.contains({ origins: [`${new URL(endpoint).protocol}//${new URL(endpoint).hostname}/*`] }),
          saved: config.translationConfig?.baseUrl === endpoint,
        }
      }, api.url)
      throw new Error(`Fixture connection state: ${JSON.stringify({ ...state, requests: api.calls.length })}`, { cause: error })
    }
    return options
  }

  async function enableSelection(options: Page): Promise<void> {
    await showOptionsSection(options, 'general')
    await options.locator('[data-test="wt-assist-mode"]').click()
    await options.getByRole('option', { name: /Selection assist|划词辅助|劃詞輔助/ }).click()
    await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
    await expect.poll(() => options.evaluate(async () => {
      const { chrome } = globalThis as unknown as {
        chrome: {
          storage: { local: { get(key: string): Promise<Record<string, { selectionPopupEnabled?: boolean }>> } }
          permissions: { contains(query: { origins: string[] }): Promise<boolean> }
        }
      }
      const data = await chrome.storage.local.get('translationConfig')
      return data.translationConfig?.selectionPopupEnabled === true &&
        await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })
    })).toBe(true)
    await expect(options.locator('[data-test="wt-assist-mode"]')).toBeEnabled()
  }

  async function dragText(page: Page, selector: string): Promise<void> {
    await page.bringToFront()
    await page.locator(selector).scrollIntoViewIfNeeded()
    if (await page.locator(selector).evaluate((element) => {
      const selection = getSelection()
      return selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode)
    })) {
      await page.mouse.click(4, 4)
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const points = await page.locator(selector).evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
      const first = rects[0]
      const last = rects.at(-1)
      if (first === undefined || last === undefined) throw new Error('Fixture text is not visible')
      return {
        start: { x: first.left + 0.5, y: first.top + first.height / 2 },
        end: { x: last.right - 0.5, y: last.top + last.height / 2 },
      }
    })
    await page.mouse.move(points.start.x, points.start.y)
    await page.mouse.down()
    await page.mouse.move(points.end.x, points.end.y, { steps: 8 })
    await page.mouse.up()
  }

  test('真实保存连接、四站词库不调用模型、密钥绑定来源', async () => {
    const { context, extensionId } = await launch()
    const other = await startMock()
    try {
      await context.route(/^https:\/\/(app\.devin\.ai|cursor\.com|openrouter\.ai|railway\.com)\//, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body:
            '<html><head><style>body,button,p,span,div,h4{font:13px/16px system-ui,sans-serif}.cursor-pointer{cursor:pointer}</style></head><body>' +
            '<nav><button id="b"><div><div><span>Settings</span></div></div></button></nav>' +
            '<p id="entry-prose">Settings</p>' +
            '<pre id="entry-code">Settings</pre>' +
            '<input id="entry-input" placeholder="Settings" value="Settings">' +
            '<div id="entry-editor" contenteditable>Settings</div>' +
            '<nav><ul><li><div><p id="list-label">Settings</p></div></li></ul></nav>' +
            '<button><p id="paragraph-label">Preferences</p></button>' +
            '<div class="cursor-pointer"><svg id="pointer-icon"></svg><span id="pointer-label">Security</span></div>' +
            '<div role="navigation"><ul><li><span id="aria-nav-label">Settings</span></li></ul></div>' +
            '<h4 id="heading-label">Settings</h4>' +
            '<textarea id="static-hint" placeholder="Settings">Settings</textarea>' +
            '</body></html>',
        }),
      )
      const options = await saveAndConnect(context, extensionId)
      expect(api.calls.some((call) => call.path.includes('/chat/completions'))).toBe(true)
      expect(api.calls[0]?.auth).toBe('Bearer sk-e2e-fake')
      const before = api.calls.length
      for (const url of [
        'https://app.devin.ai/work/x',
        'https://cursor.com/dashboard',
        'https://openrouter.ai/-/profile/preferences',
        'https://railway.com/settings/',
      ]) {
        const page = await context.newPage()
        await page.goto(url)
        await expect(page.locator('#b')).toHaveText('设置')
        await expect(page.locator('#entry-prose')).toHaveText('Settings')
        await expect(page.locator('#entry-code')).toHaveText('Settings')
        await expect(page.locator('#entry-input')).toHaveValue('Settings')
        await expect(page.locator('#entry-editor')).toHaveText('Settings')
        await expect(page.locator('#list-label')).toHaveText('设置')
        await expect(page.locator('#paragraph-label')).toHaveText('偏好设置')
        await expect(page.locator('#pointer-label')).toHaveText('安全')
        await expect(page.locator('#aria-nav-label')).toHaveText('设置')
        await expect(page.locator('#heading-label')).toHaveText('设置')
        await expect(page.locator('#entry-input')).toHaveAttribute('placeholder', '设置')
        await expect(page.locator('#static-hint')).toHaveAttribute('placeholder', '设置')
        await expect(page.locator('#static-hint')).toHaveValue('Settings')
        await expect(page.locator('#static-hint')).toHaveText('Settings')
        await page.evaluate(() => {
          const input = document.createElement('input')
          input.id = 'dynamic-hint'
          input.setAttribute('placeholder', 'Settings')
          input.value = 'Settings'
          document.body.append(input)
        })
        await expect(page.locator('#dynamic-hint')).toHaveAttribute('placeholder', '设置')
        await expect(page.locator('#dynamic-hint')).toHaveValue('Settings')
        if (url.startsWith('https://app.devin.ai/')) {
          const entries = [
            ['Connections', '连接'],
            ['Plans', '套餐'],
            ['Invoices', '发票'],
            ['Usage & Limits', '用量与限额'],
            ['My Analytics', '我的统计'],
            ['Environment', '环境'],
            ['Keyboard shortcuts', '键盘快捷键'],
          ] as const
          await page.evaluate((keys) => {
            const nav = document.createElement('nav')
            keys.forEach((key, index) => {
              const button = document.createElement('button')
              button.setAttribute('data-test', `key-${index}`)
              const p = document.createElement('p')
              p.textContent = key
              button.append(p)
              nav.append(button)
            })
            document.body.append(nav)
          }, entries.map(([key]) => key))
          for (const [index, [, expected]] of entries.entries()) {
            await expect(page.locator(`[data-test="key-${index}"] p`)).toHaveText(expected)
          }
        }
      }
      expect(api.calls).toHaveLength(before)
      await options.bringToFront()
      await options.getByPlaceholder(/api\.example\.com|v1/).fill(other.url)
      await options.locator('input[type="password"]').fill('')
      await options.locator('[data-test="wt-save"]').click()
      await expect(options.getByText(/接口来源已改变/)).toBeVisible()
      expect(other.calls).toHaveLength(0)
      const current = await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as {
          chrome: { runtime: { sendMessage(message: unknown): Promise<{ config: { baseUrl: string } }> } }
        }
        return (await chrome.runtime.sendMessage({ type: 'wt:get-config' })).config.baseUrl
      })
      expect(current).toBe(api.url)
      await options.locator('input[type="password"]').fill('sk-e2e-second-fake')
      await options.locator('[data-test="wt-save"]').click()
      await expect.poll(() => other.calls.length).toBe(1)
      expect(other.calls[0]?.auth).toBe('Bearer sk-e2e-second-fake')
    } finally {
      await context.close()
      await other.close()
    }
  })

  test('卡片界面语言', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      const writeLanguage = (language: 'ja' | 'ko'): Promise<void> =>
        options.evaluate(async (uiLanguage) => {
          const { chrome } = globalThis as unknown as {
            chrome: {
              storage: {
                sync: {
                  get(key: string): Promise<Record<string, Record<string, unknown> | undefined>>
                  set(value: object): Promise<void>
                }
              }
            }
          }
          const saved = await chrome.storage.sync.get('settings')
          const current = saved.settings ?? {}
          await chrome.storage.sync.set({
            settings: {
              enabled: true,
              translateTime: true,
              translateTitle: true,
              excludedPaths: [],
              language: 'auto',
              theme: 'auto',
              uiStyle: 'classic',
              ...current,
              uiLanguage,
            },
          })
        }, language)
      await writeLanguage('ja')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await expect.poll(() => options.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
        if (tab?.id === undefined) return false
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'wt:status' }).catch(() => undefined)
        return (reply as { status?: { supported?: boolean } } | undefined)?.status?.supported === true
      }, page.url())).toBe(true)
      await dragText(page, '#p1')
      await expect(page.locator('.panel-target')).not.toBeEmpty()
      await expect(page.locator('[aria-label="翻訳結果"]')).toBeVisible()
      await expect(page.locator('.panel-close')).toHaveAttribute('aria-label', '閉じる')
      const calls = api.calls.length
      await writeLanguage('ko')
      await expect(page.locator('[aria-label="번역 결과"]')).toBeVisible()
      await expect(page.locator('.panel-close')).toHaveAttribute('aria-label', '닫기')
      expect(api.calls.length).toBe(calls)
    } finally {
      await context.close()
    }
  })

  test('可信划词恰好一次请求、隐藏内容不外发、复制取消零请求', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await expect.poll(() => options.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
        if (tab?.id === undefined) return false
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'wt:status' }).catch(() => undefined)
        return (reply as { status?: { supported?: boolean } } | undefined)?.status?.supported === true
      }, page.url())).toBe(true)
      const before = api.calls.filter((call) => call.kind === 'assist').length
      await dragText(page, '#p1')
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(PHYSICS)
      await expect(page.locator('.panel-target')).toHaveText('量子退相干')
      expect(api.calls.filter((call) => call.kind === 'assist')).toHaveLength(before + 1)
      expect(api.calls.at(-1)?.payload.text).toBe(PHYSICS)

      await page.keyboard.press('Escape')
      await dragText(page, '#term')
      await expect.poll(() => api.calls.filter((call) => call.kind === 'assist').length).toBe(before + 2)
      expect(api.calls.at(-1)?.payload.text).toBe('token')
      for (const marker of ['HIDDEN_FIXTURE_MARKER', 'SENSITIVE_FIXTURE_MARKER', 'CODE_FIXTURE_MARKER', 'EDITABLE_FIXTURE_MARKER', 'TRANSPARENT_FIXTURE_MARKER', 'TRANSPARENT_ANCESTOR_MARKER']) {
        expect(JSON.stringify(api.calls.at(-1)?.payload)).not.toContain(marker)
      }
      await expect(page.locator('.panel-target')).toHaveText('量子退相干')
      await page.keyboard.press('Escape')
      const beforeCopy = api.calls.filter((call) => call.kind === 'assist').length
      await dragText(page, '#p2')
      await page.keyboard.press('Control+c')
      await page.waitForTimeout(700)
      expect(api.calls.filter((call) => call.kind === 'assist')).toHaveLength(beforeCopy)
      await expect(page.getByRole('dialog', { name: '翻译结果' })).not.toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('切换选区取消旧 HTTP 请求，过期错误不覆盖新结果，Esc 不被迟到响应重开', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await waitForSiteScript(context, page)
      api.hold(PHYSICS)
      await dragText(page, '#p1')
      await expect.poll(() => api.calls.some((call) => call.payload.text === PHYSICS)).toBe(true)
      const first = api.calls.find((call) => call.payload.text === PHYSICS)!
      await dragText(page, '#p2')
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(ENTROPY)
      await expect(page.locator('.panel-target')).toHaveText('熵与信息')
      await expect.poll(() => first.aborted).toBe(true)
      api.release(PHYSICS, true)
      await expect(page.locator('.panel-target')).toHaveText('熵与信息')
      expect(api.calls.filter((call) => call.kind === 'assist')).toHaveLength(2)

      await page.keyboard.press('Escape')
      api.hold(THIRD)
      await dragText(page, '#p3')
      await expect.poll(() => api.calls.some((call) => call.payload.text === THIRD)).toBe(true)
      const third = api.calls.find((call) => call.payload.text === THIRD)!
      await page.keyboard.press('Escape')
      await expect.poll(() => third.aborted).toBe(true)
      api.release(THIRD)
      await page.waitForTimeout(100)
      await expect(page.getByRole('dialog', { name: '翻译结果' })).not.toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('浮窗实际布局：无锚点、窄屏、浏览器缩放、长译文和内部复制', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      api.longResults()
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.setViewportSize({ width: 360, height: 640 })
      await page.goto(`${readingUrl()}/page`)
      await waitForSiteScript(context, page)
      await options.bringToFront()
      await options.locator('[data-test="wt-auto-interaction"] [role="switch"]').click()
      await expect.poll(() => configFlag(options, 'autoInteractionEnabled')).toBe(false)
      await page.reload()
      await waitForSiteScript(context, page)
      const beforeQuietSelection = api.calls.length
      await dragText(page, '#p1')
      // 关闭后的静默窗口覆盖选区防抖；后续同一选区开启后必须实际返回结果。
      await page.waitForTimeout(600)
      await expect(page.locator('.panel')).toBeHidden()
      await expect(page.locator('.hint')).toBeHidden()
      expect(api.calls).toHaveLength(beforeQuietSelection)
      await page.evaluate(() => getSelection()?.removeAllRanges())
      const worker = context.serviceWorkers()[0]!
      const tabId = await worker.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as {
          chrome: { tabs: { query(query: object): Promise<Array<{ id?: number; url?: string }>> } }
        }
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
        if (tab?.id === undefined) throw new Error('Fixture tab missing')
        return tab.id
      }, page.url())
      const bounds = () => page.locator('.panel').evaluate((panel) => {
        const rect = panel.getBoundingClientRect()
        return {
          x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
          viewportW: innerWidth, viewportH: innerHeight,
          scrollW: panel.scrollWidth, clientW: panel.clientWidth,
          scrollH: panel.scrollHeight, clientH: panel.clientHeight,
        }
      })
      const assertInViewport = async (): Promise<void> => {
        const box = await bounds()
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(box.viewportW + 1)
        expect(box.bottom).toBeLessThanOrEqual(box.viewportH + 1)
        expect(box.scrollW).toBeLessThanOrEqual(box.clientW + 1)
        expect(box.scrollH).toBeGreaterThan(box.clientH)
      }
      await page.bringToFront()
      await worker.evaluate(async (id) => {
        const { chrome } = globalThis as unknown as {
          chrome: { tabs: { sendMessage(id: number, message: unknown): Promise<unknown> } }
        }
        await chrome.tabs.sendMessage(id, { type: 'wt:show-selection', text: 'Manual translation fixture' })
      }, tabId)
      await expect(page.locator('.panel-target')).toHaveText(LONG_RESULT)
      await assertInViewport()
      await page.screenshot({ path: testInfo.outputPath('manual-no-anchor.png') })
      await page.keyboard.press('Escape')
      await options.bringToFront()
      await options.locator('[data-test="wt-auto-interaction"] [role="switch"]').click()
      await expect.poll(() => configFlag(options, 'autoInteractionEnabled')).toBe(true)
      for (const style of ['cyber', 'glass'] as const) {
        await setUiStyle(options, style)
        for (const variant of [
        { width: 1280, height: 800, zoom: 1 },
        { width: 360, height: 640, zoom: 1 },
        { width: 360, height: 640, zoom: 2 },
        { width: 760, height: 640, zoom: 0.8 },
      ]) {
        await page.setViewportSize({ width: variant.width, height: variant.height })
        await worker.evaluate(async ({ id, zoom }) => {
          const { chrome } = globalThis as unknown as {
            chrome: { tabs: { setZoom(id: number, zoom: number): Promise<void> } }
          }
          await chrome.tabs.setZoom(id, zoom)
        }, { id: tabId, zoom: variant.zoom })
        // setZoom 返回时页面可能仍用旧缩放布局；先等 CSS viewport 生效再采集基线。
        await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
          width: Math.round(variant.width / variant.zoom),
          height: Math.round(variant.height / variant.zoom),
        })
        await page.evaluate(() => { document.documentElement.classList.add('hostile'); scrollTo(0, 0) })
        const before = await page.locator('#p1').boundingBox()
        await dragText(page, '#p1')
        expect(await page.evaluate(() => getSelection()?.toString())).toBe(PHYSICS)
        await expect(page.locator('.panel-target')).toHaveText(LONG_RESULT)
        await assertInViewport()
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
        expect(await page.locator('#p1').boundingBox()).toEqual(before)
        const overlap = await page.locator('.panel').evaluate((panel) => {
          const range = getSelection()?.getRangeAt(0)
          if (range === undefined) throw new Error('Missing selection or card')
          const a = range.getBoundingClientRect()
          const b = panel.getBoundingClientRect()
          return {
            collides: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
            selected: a.toJSON(), panel: b.toJSON(), maxHeight: (panel as HTMLElement).style.maxHeight,
            viewport: [innerWidth, innerHeight], root: [document.documentElement.getBoundingClientRect().width, document.documentElement.offsetWidth],
          }
        })
        expect(overlap.collides, JSON.stringify({ ...variant, ...overlap })).toBe(false)
        await expect(page.locator('.panel')).toHaveAttribute('data-style', style)
        await page.screenshot({ path: testInfo.outputPath(`layout-${style}-${variant.width}-zoom-${variant.zoom}.png`) })
        if (variant.zoom === 0.8) {
          const target = await page.locator('.panel-target').boundingBox()
          expect(target).not.toBeNull()
          await page.mouse.move(target!.x + 4, target!.y + 12)
          await page.mouse.down()
          await page.mouse.move(target!.x + 50, target!.y + 12, { steps: 5 })
          await page.mouse.up()
          await page.keyboard.press('Control+c')
          await expect(page.getByRole('dialog', { name: '翻译结果' })).toBeVisible()
          const scrollBefore = await page.evaluate(() => scrollY)
          await page.mouse.wheel(0, 280)
          await expect.poll(() => page.locator('.panel').evaluate((panel) => panel.scrollTop)).toBeGreaterThan(0)
          expect(await page.evaluate(() => scrollY)).toBe(scrollBefore)
          await expect(page.getByRole('dialog', { name: '翻译结果' })).toBeVisible()
        }
        await page.keyboard.press('Escape')
        }
      }
    } finally {
      await context.close()
    }
  })

  test('原生模态对话框中的划词面板', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      api.longResults()
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await expect.poll(() => options.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
        if (tab?.id === undefined) return false
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'wt:status' }).catch(() => undefined)
        return (reply as { status?: { supported?: boolean } } | undefined)?.status?.supported === true
      }, page.url())).toBe(true)
      await page.evaluate((physics) => {
        const dialog = document.createElement('dialog')
        dialog.id = 'modal-fixture'
        dialog.style.width = '220px'
        dialog.style.height = '170px'
        dialog.style.overflow = 'hidden'
        dialog.style.transform = 'translate(17px,11px)'
        const p = document.createElement('p')
        p.id = 'modal-source'
        p.textContent = physics
        dialog.append(p)
        document.body.append(dialog)
        dialog.showModal()
      }, PHYSICS)
      const before = await page.locator('#modal-source').boundingBox()
      await dragText(page, '#modal-source')
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(PHYSICS)
      await expect(page.locator('.panel-target')).toHaveText(LONG_RESULT)
      const geometry = await page.locator('.panel').evaluate((panel) => {
        const b = panel.getBoundingClientRect()
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: innerWidth, h: innerHeight }
      })
      expect(geometry.left).toBeGreaterThanOrEqual(0)
      expect(geometry.top).toBeGreaterThanOrEqual(0)
      expect(geometry.right).toBeLessThanOrEqual(geometry.w + 1)
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.h + 1)
      expect(await page.locator('#modal-source').boundingBox()).toEqual(before)
      await page.screenshot({ path: testInfo.outputPath('modal-panel.png') })
      const textsBefore = api.calls.filter((call) => call.kind === 'texts').length
      await expect(page.locator('.panel-more')).not.toHaveAttribute('open')
      await page.locator('.panel-more > summary').click()
      await page.getByRole('button', { name: '只翻译', exact: true }).click()
      await expect.poll(() => api.calls.filter((call) => call.kind === 'texts').length).toBe(textsBefore + 1)
      expect(api.calls.at(-1)?.payload.texts).toEqual([PHYSICS])
      expect(await page.locator('#modal-fixture').evaluate((dialog) => (dialog as HTMLDialogElement).open)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.locator('.panel')).toBeHidden()
      expect(await page.locator('#modal-fixture').evaluate((dialog) => (dialog as HTMLDialogElement).open)).toBe(true)
      await dragText(page, '#modal-source')
      await expect(page.locator('.panel')).toBeVisible()
      await page.locator('#modal-fixture').evaluate((dialog) => (dialog as HTMLDialogElement).close())
      await expect(page.locator('.panel')).toBeHidden()
      await expect.poll(() =>
        page.locator('[data-wt-root]').evaluate((host) => host.matches(':popover-open')),
      ).toBe(false)
      await expect(page.locator('.floating-entry')).toBeVisible()
      await page.locator('#modal-fixture').evaluate((dialog) => dialog.remove())
      await dragText(page, '#p2')
      await expect(page.locator('.panel-target')).toHaveText(LONG_RESULT)
      await expect(page.locator('[data-wt-root]')).toHaveCount(1)
    } finally {
      await context.close()
    }
  })

  test('实际 DOM：布局回滚、十次恢复继续、SPA、总开关和浏览器回退', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    const oldRoute = 'An old route waits for a delayed translation response.'
    const newRoute = 'A new route has a different paragraph and should stay current.'
    const html = `<!doctype html><html><head><title>Lifecycle fixture</title><style>
body{margin:24px;font:16px/1.6 sans-serif}nav button{width:96px}
.row{display:flex;gap:8px;margin:12px 0}.grid{display:grid;grid-template-columns:80px 100px;gap:8px}
.tight{width:80px;height:32px;white-space:nowrap;overflow:hidden;box-sizing:border-box}
table{table-layout:fixed;width:188px}td{width:80px}td .tight{display:block}
</style></head><body><nav><button id="fixed" title="Settings">Settings</button><button id="fixed-rejected" style="font:20px Arial,sans-serif;padding:0;border:0;white-space:nowrap;overflow:hidden">Edit</button><button id="fixed-tail">Cancel</button></nav>
<main><p id="body">${PHYSICS}</p>
<div class="row"><button class="tight" id="flex">A constrained flex label</button><span>Adjacent label</span></div>
<div class="grid"><button class="tight" id="grid">A constrained grid label</button><span>Next label</span></div>
<table><tr><td><span class="tight" id="table">A constrained table label</span></td><td>Other label</td></tr></table>
<input value="INPUT_FIXTURE_MARKER"><textarea>TEXTAREA_FIXTURE_MARKER</textarea>
<pre>CODE_FIXTURE_MARKER</pre><div hidden>HIDDEN_FIXTURE_MARKER</div><div data-sensitive>SENSITIVE_FIXTURE_MARKER</div>
</main><script>const tightFixed=document.getElementById('fixed-rejected');
const tightRange=document.createRange();tightRange.selectNodeContents(tightFixed);
tightFixed.style.width=Math.ceil(tightRange.getBoundingClientRect().width)+'px';tightRange.detach();
window.fixtureButton=document.getElementById('fixed');window.fixtureClicks=0;
window.fixtureButton.addEventListener('click',()=>window.fixtureClicks++);
window.addEventListener('pageshow',e=>window.fixturePersisted=e.persisted);</script></body></html>`
    try {
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: html }))
      const options = await saveAndConnect(context, extensionId)
      const page = await context.newPage()
      await page.goto('https://app.devin.ai/work/first')
      await expect(page.locator('#fixed')).toHaveText('设置')
      await expect(page.locator('#fixed-rejected')).toHaveText('Edit')
      await expect(page.locator('#fixed-tail')).toHaveText('取消')
      expect(await page.locator('#fixed-rejected').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await options.bringToFront()
      await showOptionsSection(options, 'sites')
      await options.locator('.wt-add:has([data-test="wt-add"]) input').fill('https://app.devin.ai')
      await options.locator('[data-test="wt-add"]').click()
      await expect(options.locator('[data-test="wt-origin"]')).toHaveText('https://app.devin.ai')
      await page.bringToFront()
      await expect(page.locator('#body')).toHaveText('中文译文')
      await expect.poll(() => api.calls.some((call) =>
        Array.isArray(call.payload.texts) && call.payload.texts.includes('A constrained table label'),
      )).toBe(true)
      for (const id of ['flex', 'grid', 'table']) {
        await expect(page.locator(`#${id}`)).toHaveText(`A constrained ${id} label`)
      }
      const collision = await page.evaluate(() => {
        const a = document.querySelector('#flex')!.getBoundingClientRect()
        const b = document.querySelector('#flex')!.nextElementSibling!.getBoundingClientRect()
        return a.right > b.left
      })
      expect(collision).toBe(false)
      for (const marker of ['INPUT_FIXTURE_MARKER', 'TEXTAREA_FIXTURE_MARKER', 'CODE_FIXTURE_MARKER', 'HIDDEN_FIXTURE_MARKER', 'SENSITIVE_FIXTURE_MARKER']) {
        expect(JSON.stringify(api.calls.map((call) => call.payload))).not.toContain(marker)
      }
      const nodes = await page.locator('body *').count()
      const action = async (value: 'restore' | 'resume'): Promise<void> => {
        await page.bringToFront()
        const reply = await options.evaluate(async (current) => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({ type: 'wt:page-action', action: current })
        }, value)
        expect(reply).toMatchObject({ ok: true })
      }
      for (let cycle = 0; cycle < 10; cycle += 1) {
        await action('restore')
        await expect(page.locator('#body')).toHaveText(PHYSICS)
        await expect(page.locator('#fixed')).toHaveText('Settings')
        await expect(page.locator('#fixed')).toHaveAttribute('title', 'Settings')
        await expect(page.locator('#fixed-tail')).toHaveText('Cancel')
        await expect(page.locator('#fixed-rejected')).toHaveText('Edit')
        await page.waitForTimeout(700)
        await expect(page.locator('#body')).toHaveText(PHYSICS)
        await action('resume')
        await expect(page.locator('#body')).toHaveText('中文译文')
        await expect(page.locator('#fixed')).toHaveAttribute('title', '设置')
        await expect(page.locator('#fixed-tail')).toHaveText('取消')
        await expect(page.locator('#fixed-rejected')).toHaveText('Edit')
        await page.locator('#fixed').click()
        expect(await page.locator('body *').count()).toBe(nodes)
      }
      expect(await page.evaluate(() => {
        const state = window as Window & { fixtureButton?: Element; fixtureClicks?: number }
        return { same: state.fixtureButton === document.querySelector('#fixed'), clicks: state.fixtureClicks }
      })).toEqual({ same: true, clicks: 10 })

      api.hold(oldRoute)
      await page.locator('#body').evaluate((node, text) => { node.textContent = text }, oldRoute)
      await expect.poll(() => api.calls.some((call) =>
        Array.isArray(call.payload.texts) && call.payload.texts.includes(oldRoute),
      )).toBe(true)
      const oldCall = api.calls.find((call) => Array.isArray(call.payload.texts) && call.payload.texts.includes(oldRoute))!
      await page.evaluate((text) => {
        history.pushState({}, '', '/work/second')
        document.querySelector('#body')!.textContent = text
      }, newRoute)
      await expect(page.locator('#body')).toHaveText('中文译文')
      await expect.poll(() => oldCall.aborted).toBe(true)
      api.release(oldRoute, true)
      await expect(page.locator('#body')).toHaveText('中文译文')
      const master = (enabled: boolean) => options.evaluate(async (value) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const saved = await chrome.storage.sync.get('settings')
        await chrome.storage.sync.set({ settings: { ...(saved.settings as object ?? {}), enabled: value } })
      }, enabled)
      await master(false)
      await expect(page.locator('#body')).toHaveText(newRoute)
      await expect(page.locator('#fixed')).toHaveText('Settings')
      await master(true)
      await expect(page.locator('#body')).toHaveText('中文译文')
      await page.screenshot({ path: testInfo.outputPath('dom-restored-resumed.png') })
      await page.goto(`${readingUrl()}/page`)
      await page.goBack({ waitUntil: 'commit' })
      await expect(page.locator('#body')).toHaveText('中文译文')
      await expect(page.locator('#fixed')).toHaveText('设置')
      const persisted = await page.evaluate(() => (window as Window & { fixturePersisted?: boolean }).fixturePersisted)
      testInfo.annotations.push({ type: 'BFCache', description: String(persisted) })
      expect(persisted).toBe(true)
    } finally {
      await context.close()
    }
  })

  test('智能陪读提示、候选直译、短期语境、关闭清理和真实权限撤销重授', async () => {
    const { context, extensionId } = await launch()
    const authText = 'Authentication tokens identify the owner of a request.'
    const freshText = 'A separate credential can grant access to this account.'
    try {
      await context.route('https://reading.example.test/**', (route) => {
        const auth = new URL(route.request().url()).pathname === '/protocol-guide'
        const html = auth
          ? PAGE_HTML.replaceAll('Physics notes', 'Authentication guide').replace(PHYSICS, authText)
          : PAGE_HTML
        return route.fulfill({ contentType: 'text/html', body: html })
      })
      const options = await saveAndConnect(context, extensionId)
      await showOptionsSection(options, 'general')
      await options.locator('[data-test="wt-assist-mode"]').click()
      await options.getByRole('option', { name: /Smart reading|智能陪读|智能陪讀/ }).click()
      await expect(options.locator('[data-test="wt-smart-confirm"]')).toHaveCount(0)
      await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
      await expect(options.locator('[data-test="wt-assist-mode"]')).toBeEnabled()
      const page = await context.newPage()
      await page.goto('https://reading.example.test/physics')
      await expect.poll(() => options.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
        if (tab?.id === undefined) return false
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'wt:status' }).catch(() => undefined)
        return (reply as { status?: { supported?: boolean } } | undefined)?.status?.supported === true
      }, page.url())).toBe(true)
      await page.bringToFront()
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const box = await page.locator('#p1').boundingBox()
      expect(box).not.toBeNull()
      const point = { x: box!.x + 60, y: box!.y + box!.height / 2 }
      await page.mouse.move(point.x, point.y)
      await page.waitForTimeout(2100)
      await page.mouse.move(8, 600)
      await page.waitForTimeout(1000)
      await page.mouse.move(point.x, point.y)
      await expect(page.locator('.hint')).toBeVisible()
      await expect(page.getByRole('dialog', { name: '翻译结果' })).not.toBeVisible()
      const revisits = api.calls.filter((call) => call.payload.trigger === 'revisit')
      expect(revisits).toHaveLength(1)
      expect(revisits[0]?.payload.text).toBe(PHYSICS)
      await page.locator('.hint').click()
      await expect(page.locator('.panel-target')).toHaveText('量子退相干')
      await expect(page.locator('.panel-more')).not.toHaveAttribute('open')
      await page.locator('.panel-more > summary').click()
      await page.getByRole('button', { name: '只翻译', exact: true }).click()
      await expect(page.locator('.panel-target')).toHaveText('中文译文')
      expect(api.calls.at(-1)?.payload.texts).toEqual([PHYSICS])
      await page.keyboard.press('Escape')
      const memory = () => options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return (await chrome.storage.session.get('wtReadingContext')).wtReadingContext as
          { entries: Array<{ page: { title: string } }> } | undefined
      })
      await expect.poll(async () => (await memory())?.entries.some((entry) => entry.page.title === 'Physics notes'), {
        timeout: 12000,
      }).toBe(true)
      const auth = await context.newPage()
      await auth.goto('https://reading.example.test/protocol-guide')
      await dragText(auth, '#p1')
      await expect(auth.locator('.panel-target')).toHaveText('量子退相干')
      const authCall = api.calls.find((call) => call.payload.text === authText)!
      expect(authCall.payload.currentPage).toMatchObject({ title: 'Authentication guide' })
      expect(authCall.payload.recentPages).toContainEqual({
        title: 'Physics notes', heading: 'Physics notes', site: 'reading.example.test',
      })

      await options.bringToFront()
      await enableSelection(options)
      await expect.poll(memory).toBeUndefined()
      await auth.locator('#p1').evaluate((node, text) => { node.textContent = text }, freshText)
      await dragText(auth, '#p1')
      const freshSelection = await auth.evaluate(() => getSelection()?.toString().trim() ?? '')
      expect(freshSelection.length).toBeGreaterThan(0)
      expect(freshText).toContain(freshSelection)
      await expect.poll(() => api.calls.some((call) => call.payload.text === freshSelection)).toBe(true)
      expect(api.calls.find((call) => call.payload.text === freshSelection)!.payload.recentPages).toEqual([])
      const removed = await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.permissions.remove({ origins: ['https://*/*'] })
      })
      expect(removed).toBe(true)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.permissions.contains({ origins: ['https://reading.example.test/*'] })
      })).toBe(false)
      await expect(auth.getByRole('dialog', { name: '翻译结果' })).not.toBeVisible()
      const revokedCount = api.calls.length
      await dragText(auth, '#p2')
      await auth.waitForTimeout(700)
      expect(api.calls).toHaveLength(revokedCount)
      await options.bringToFront()
      await showOptionsSection(options, 'general')
      await options.locator('[data-test="wt-assist-mode"]').click()
      await options.getByRole('option', { name: /^(Off|关闭|關閉)$/ }).click()
      await expect(options.locator('[data-test="wt-assist-mode"]')).toBeEnabled()
      await enableSelection(options)
      const regrantedCount = api.calls.filter((call) => call.kind === 'assist').length
      await dragText(auth, '#p2')
      await expect(auth.locator('.panel-target')).toHaveText('熵与信息')
      expect(api.calls.filter((call) => call.kind === 'assist')).toHaveLength(regrantedCount + 1)
      await expect(auth.locator('[data-wt-root]')).toHaveCount(1)
    } finally {
      await context.close()
    }
  })

  test('敏感路径及 hash 路由禁止自动翻译与选中即发送', async () => {
    const { context, extensionId } = await launch()
    const chosen = 'Only this deliberately selected synthetic phrase may be sent.'
    const title = 'Synthetic private credentials heading'
    try {
      const html = PAGE_HTML.replaceAll('Physics notes', title).replace(PHYSICS, chosen)
        .replace('<main>', '<nav><button id="fixed">Settings</button></nav><main>')
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: html }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      const page = await context.newPage()
      const before = api.calls.length
      for (const path of ['/settings/keys', '/settings/personal-access-tokens', '/settings//tokens', '/settings/%74okens', '/#/settings/tokens']) {
        await page.goto(`https://app.devin.ai${path}`)
        await expect(page.locator('#fixed')).toHaveText('设置')
        await dragText(page, '#p1')
        await page.waitForTimeout(700)
        expect(api.calls).toHaveLength(before)
        await expect(page.getByRole('dialog', { name: '翻译结果' })).not.toBeVisible()
      }
      const privacy = await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return {
          contexts: JSON.stringify(await chrome.storage.session.get('wtReadingContext')),
          incognito: chrome.runtime.getManifest().incognito,
        }
      })
      expect(privacy.contexts).not.toContain(title)
      expect(privacy.incognito).toBe('not_allowed')
    } finally {
      await context.close()
    }
  })

  test('排除网站设置阻止发送，移除后恢复划词', async () => {
    const { context, extensionId } = await launch()
    try {
      await context.route('https://reading.example.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: PAGE_HTML }),
      )
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      await showOptionsSection(options, 'general')
      await options.locator('[data-test="wt-assist-mode"]').click()
      await options.getByRole('option', { name: /Smart reading|智能陪读|智能陪讀/ }).click()
      await expect(options.locator('[data-test="wt-smart-confirm"]')).toHaveCount(0)
      await expect(options.locator('[data-test="wt-assist-mode"]')).toBeEnabled()
      await showOptionsSection(options, 'sites')
      await options.locator('.wt-add').first().locator('input').fill('https://reading.example.test')
      await options.locator('[data-test="wt-add"]').click()
      await expect(options.locator('[data-test="wt-origin"]')).toHaveText('https://reading.example.test')
      await options.locator('[data-test="wt-excluded-input"]').fill('reading.example.test')
      await options.locator('[data-test="wt-excluded-add"]').click()
      await expect(options.locator('[data-test="wt-excluded-host"]')).toHaveText('reading.example.test')
      await waitForSiteScriptRegistration(options, {
        requiredMatches: ['http://*/*', 'https://*/*'],
        excludedHosts: ['reading.example.test'],
      })
      const before = api.calls.length
      const page = await context.newPage()
      await page.goto('https://reading.example.test/physics')
      await waitForSiteContentReady(options, page, { supported: false, auto: false })
      await dragText(page, '#p1')
      await page.waitForTimeout(800)
      expect(api.calls).toHaveLength(before)
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      await expect(page.getByRole('dialog', { name: '翻译结果' })).not.toBeVisible()
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return JSON.stringify(await chrome.storage.session.get('wtReadingContext'))
      })).not.toContain('reading.example.test')
      await options.bringToFront()
      await options.locator('[data-test="wt-remove"]').click()
      await expect(options.locator('[data-test="wt-origin"]')).toHaveCount(0)
      await options.locator('[data-test="wt-excluded-remove"]').click()
      await expect(options.locator('[data-test="wt-excluded-host"]')).toHaveCount(0)
      await waitForSiteScriptRegistration(options, {
        url: 'https://reading.example.test/physics',
        requiredMatches: ['http://*/*', 'https://*/*'],
        excludedHosts: [],
      })
      await waitForSiteContentReady(options, page, { supported: true, auto: false, refresh: true })
      await dragText(page, '#p2')
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(ENTROPY)
      await expect(page.locator('.panel-target')).toHaveText('熵与信息')
      expect(api.calls).toHaveLength(before + 1)
      expect(api.calls.at(-1)!.payload).not.toHaveProperty('signals')
    } finally {
      await context.close()
    }
  })

  test('真实 session 隔离、过期 alarm 和 Service Worker 重启清理', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      // 查询目标页 URL 和注入 ISOLATED 脚本都需要该网站的授权。
      await enableSelection(options)
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      const raw = () => options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return (await chrome.storage.session.get('wtReadingContext')).wtReadingContext as
          { entries: Array<{ pageId: string; at: number }> } | undefined
      })
      await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const page = { site: 'fixture.example', title: 'Synthetic context', heading: 'Synthetic heading' }
        const now = Date.now()
        await chrome.storage.session.set({
          wtReadingContext: {
            entries: [
              { page, pageId: 'expired-fixture', tabId: 0, at: now - 1800001 },
              { page, pageId: 'fresh-fixture', tabId: 1, at: now },
            ],
          },
        })
        await chrome.alarms.create('wt-context-expiry', { when: now + 500 })
      })
      await expect.poll(async () => (await raw())?.entries.map((entry) => entry.pageId), {
        timeout: 45000,
      }).toEqual(['fresh-fixture'])
      const access = await options.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const tab = (await chrome.tabs.query({})).find((item) => item.url === url)
        if (tab?.id === undefined) throw new Error('Fixture tab missing')
        return chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'ISOLATED',
          func: async () => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            try {
              await chrome.storage.session.get('wtReadingContext')
              return true
            } catch { return false }
          },
        })
      }, page.url())
      expect(access).toHaveLength(1)
      expect(access[0]?.result).toBe(false)
      await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const data = await chrome.storage.session.get('wtReadingContext')
        const current = data.wtReadingContext as { entries: Array<{ at: number }> }
        for (const entry of current.entries) entry.at = Date.now() - 1800001
        await chrome.storage.session.set({ wtReadingContext: current })
      })
      const session = await context.newCDPSession(options)
      const { targetInfos } = await session.send('Target.getTargets')
      const target = targetInfos.find((item) => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${extensionId}/`))
      expect(target).toBeDefined()
      await session.send('Target.closeTarget', { targetId: target!.targetId })
      await session.detach()
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:get-config' })
      })).toMatchObject({ ok: true })
      await expect.poll(raw).toBeUndefined()
    } finally {
      await context.close()
    }
  })

  test('后台唤醒后保留已翻译内容并继续处理新内容', async () => {
    const { context, extensionId } = await launch()
    try {
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      const page = await context.newPage()
      await page.goto('https://app.devin.ai/work')
      await expect(page.locator('#p1')).toHaveText('中文译文')
      const textsBefore = api.calls.filter((call) => call.kind === 'texts').length
      await page.evaluate(() => {
        const node = document.querySelector('#p1')
        if (node === null) throw new Error('missing p1')
        const observer = new MutationObserver((entries) => {
          if (entries.some((entry) => entry.type === 'characterData')) {
            document.documentElement.setAttribute('data-p1-mutated', 'true')
          }
        })
        observer.observe(node, { characterData: true, childList: true, subtree: true })
      })
      const session = await context.newCDPSession(options)
      const { targetInfos } = await session.send('Target.getTargets')
      const target = targetInfos.find((item) => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${extensionId}/`))
      expect(target).toBeDefined()
      await session.send('Target.closeTarget', { targetId: target!.targetId })
      await session.detach()
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:get-config' })
      })).toMatchObject({ ok: true })
      await page.waitForTimeout(800)
      expect(await page.locator('#p1').textContent()).toBe('中文译文')
      expect(await page.locator('html').getAttribute('data-p1-mutated')).not.toBe('true')
      expect(api.calls.filter((call) => call.kind === 'texts')).toHaveLength(textsBefore)
      const fresh = 'A brand new paragraph appeared after the worker restarted.'
      await page.evaluate((text) => {
        const p = document.createElement('p')
        p.id = 'late'
        p.textContent = text
        document.querySelector('main')?.append(p)
      }, fresh)
      await expect(page.locator('#late')).toHaveText('中文译文')
      expect(await page.locator('#p1').textContent()).toBe('中文译文')
      const textsAfterLate = api.calls.filter((call) => call.kind === 'texts').length
      expect(textsAfterLate).toBe(textsBefore + 1)
      const held = 'A held paragraph keeps flowing across an anchor change.'
      api.hold(held)
      await page.evaluate((text) => {
        const p = document.createElement('p')
        p.id = 'held'
        p.textContent = text
        document.querySelector('main')?.append(p)
      }, held)
      await page.locator('#held').scrollIntoViewIfNeeded()
      await expect.poll(() => api.calls.some((call) => call.kind === 'texts' && JSON.stringify(call.payload.texts).includes('held paragraph'))).toBe(true)
      const callsWhileHeld = api.calls.filter((call) => call.kind === 'texts').length
      await page.evaluate(() => { location.hash = 'section' })
      await page.waitForTimeout(400)
      api.release(held)
      await expect(page.locator('#held')).toHaveText('中文译文')
      expect(await page.locator('#p1').textContent()).toBe('中文译文')
      expect(await page.locator('#late').textContent()).toBe('中文译文')
      const encore = 'A final paragraph proves the engine still scans.'
      await page.evaluate((text) => {
        const p = document.createElement('p')
        p.id = 'encore'
        p.textContent = text
        document.querySelector('main')?.append(p)
      }, encore)
      await page.locator('#encore').scrollIntoViewIfNeeded()
      await expect(page.locator('#encore')).toHaveText('中文译文')
      const originals = api.calls.filter(
        (call) => call.kind === 'texts' && JSON.stringify(call.payload.texts ?? []).includes('Quantum decoherence'),
      )
      expect(originals.length).toBeLessThanOrEqual(1)
      expect(callsWhileHeld).toBeGreaterThan(textsBefore)
    } finally {
      await context.close()
    }
  })

  test('非回环 HTTP 页面中划词仍可用', async () => {
    const { context, extensionId } = await launch()
    try {
      const targetUrl = 'http://reader.insecure.test/page'
      await context.route('http://reader.insecure.test/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      await waitForSiteScriptRegistration(options, {
        url: targetUrl,
        requiredMatches: ['http://*/*', 'https://*/*'],
        selectionPopupEnabled: true,
      })
      const page = await context.newPage()
      await page.goto(targetUrl)
      await waitForSiteContentReady(options, page, { supported: true })
      expect(await page.evaluate(() => isSecureContext)).toBe(false)
      const probe = await options.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const tab = (await chrome.tabs.query({})).find((item) => item.url === url)
        if (tab?.id === undefined) throw new Error('Fixture tab missing')
        return chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'ISOLATED',
          func: () => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }),
        })
      }, page.url())
      expect(probe[0]?.result).toEqual({ secure: false, uuid: 'undefined' })
      await dragText(page, '#p1')
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(PHYSICS)
      await expect(page.locator('.panel-target')).toHaveText('量子退相干')
      expect(api.calls.at(-1)?.payload.text).toBe(PHYSICS)
    } finally {
      await context.close()
    }
  })

  test('长页面离屏列表经滚动才翻译', async () => {
    const { context, extensionId } = await launch()
    try {
      const targetUrl = 'https://app.devin.ai/list'
      const items = Array.from({ length: 1200 }, (_, i) => `<p id="n${i}">Offscreen list entry number ${i}.</p>`).join('')
      // 固定行高，避免中英文字体度量差异把滚入视口的末项再次推到屏外。
      const html = `<!doctype html><html><head><style>p{line-height:22px}</style></head><body><main>${items}</main></body></html>`
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: html }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      await waitForSiteScriptRegistration(options, {
        url: targetUrl,
        autoOrigin: 'https://app.devin.ai',
        selectionPopupEnabled: true,
      })
      const page = await context.newPage()
      await page.goto(targetUrl)
      await waitForSiteContentReady(options, page, { supported: true, auto: true })
      await expect(page.locator('#n0')).toHaveText('中文译文', { timeout: 20000 })
      const tailPhrase = 'Offscreen list entry number 1199.'
      const tail = page.locator('#n1199')
      expect(api.calls.filter((call) => JSON.stringify(call.payload.texts ?? []).includes('number 1199'))).toHaveLength(0)
      await tail.scrollIntoViewIfNeeded()
      await expect(tail).toBeInViewport({ ratio: 1 })
      await expect(tail).toHaveText('中文译文', { timeout: 30000 })
      await expect(tail).toBeInViewport({ ratio: 1 })
      expect(api.calls.filter((call) => JSON.stringify(call.payload.texts ?? []).includes(tailPhrase)).length).toBeGreaterThan(0)
    } finally {
      await context.close()
    }
  })

  test('展开内容：闭合容器与透明菜单在显示前不发送', async () => {
    const { context, extensionId } = await launch()
    try {
      const html = `<!doctype html><html><body><main>
        <p id="visible">Visible page sentence for baseline.</p>
        <details id="det"><summary>Detail summary</summary><p id="dt">Hidden detail fixture phrase.</p></details>
        <dialog id="dlg"><p id="dp">Hidden dialog fixture phrase.</p></dialog>
        <div id="pop" popover><p id="pp">Hidden popover fixture phrase.</p></div>
        <div id="menu"><button id="mbtn">Menu</button><div id="mp"><p>Hidden menu fixture phrase.</p></div></div>
      </main><style>#mp{opacity:0} #menu:hover #mp{opacity:1}</style></body></html>`
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: html }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      const page = await context.newPage()
      await page.goto('https://app.devin.ai/reveal')
      await expect(page.locator('#visible')).toHaveText('中文译文', { timeout: 20000 })
      const phrase = (id: string): number => api.calls.filter((call) => JSON.stringify(call.payload.texts ?? []).includes(id)).length
      await page.mouse.move(10, 10)
      await page.waitForTimeout(1200)
      for (const hidden of ['Hidden detail fixture phrase', 'Hidden dialog fixture phrase', 'Hidden popover fixture phrase', 'Hidden menu fixture phrase']) {
        expect(phrase(hidden)).toBe(0)
      }
      await page.locator('#det summary').click()
      await expect(page.locator('#dt')).toHaveText('中文译文', { timeout: 20000 })
      await page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).showModal())
      await expect(page.locator('#dp')).toHaveText('中文译文', { timeout: 20000 })
      await page.evaluate(() => (document.getElementById('pop') as HTMLElement).showPopover())
      await expect(page.locator('#pp')).toHaveText('中文译文', { timeout: 20000 })
      await page.evaluate(() => {
        ;(document.getElementById('dlg') as HTMLDialogElement).close()
        ;(document.getElementById('pop') as HTMLElement).hidePopover()
      })
      const menuCalls = (): number => api.calls.filter(
        (call) => JSON.stringify(call.payload.texts ?? []).includes('Hidden menu fixture phrase'),
      ).length
      await page.locator('#mbtn').hover()
      await expect(page.locator('#mp')).toHaveText('中文译文', { timeout: 20000 })
      expect(menuCalls()).toBe(1)
    } finally {
      await context.close()
    }
  })

  test.describe('故障路径', () => {
    const paragraphs = (...texts: string[]): string =>
      `<!doctype html><html><head><title>Failure fixture</title></head><body><main>${texts
        .map((text, index) => `<p id="p${index + 1}">${text}</p>`)
        .join('')}</main></body></html>`

    const textCalls = (): MockCall[] => api.calls.filter((call) => call.kind === 'texts')

    /** 所有路径共用同一份 HTML；故障要在 page.goto 之前登记。 */
    async function prepareAutoSite(context: BrowserContext, extensionId: string, html: string): Promise<Page> {
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: html }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      return options
    }

    async function appendParagraph(page: Page, id: string, text: string): Promise<void> {
      await page.evaluate(({ id, text }) => {
        const p = document.createElement('p')
        p.id = id
        p.textContent = text
        document.querySelector('main')?.append(p)
      }, { id, text })
    }

    test('请求挂起：按真实时限中止并重试，用尽后暂停，点继续恢复', async () => {
      // 不加测试钩子：三次真实超时（每次约 18~19 秒）加退避
      test.setTimeout(180_000)
      const { context, extensionId } = await launch()
      try {
        await prepareAutoSite(context, extensionId, paragraphs(PHYSICS))
        api.failNext({ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' })
        const page = await context.newPage()
        await page.goto('https://app.devin.ai/hang')
        await expect.poll(() => textCalls().length).toBe(1)
        // 第一次超时后自动重试，此时还不该打扰用户
        await expect.poll(() => textCalls().length, { timeout: 35_000 }).toBe(2)
        await expect(page.locator('.pause-status')).toBeHidden()
        await expect(page.locator('#p1')).toHaveText(PHYSICS)
        await expect(page.locator('.pause-status')).toBeVisible({ timeout: 70_000 })
        await expect(page.locator('.pause-status')).toContainText('请求超时')
        await expect(page.locator('#p1')).toHaveText(PHYSICS)
        const hung = textCalls()
        expect(hung).toHaveLength(3)
        await expect.poll(() => hung.every((call) => call.aborted)).toBe(true)
        for (const call of hung) {
          // 时限来自 requestTimeoutMs：下限 18 秒，上限 28 秒（低于 MV3 的 30 秒 fetch 限制）
          const elapsed = call.abortedAt! - call.at
          expect(elapsed).toBeGreaterThan(17_500)
          expect(elapsed).toBeLessThan(29_000)
        }
        await page.locator('.pause-resume').click()
        await expect(page.locator('#p1')).toHaveText('中文译文')
        await expect(page.locator('.pause-status')).toBeHidden()
        expect(textCalls()).toHaveLength(4)
      } finally {
        await context.close()
      }
    })

    test('429 带 Retry-After：所有页面的自动翻译等到期才继续，不显示暂停条', async () => {
      const { context, extensionId } = await launch()
      const other = 'A second tab must honour the shared rate limit pause.'
      const retryAfterSeconds = 4
      try {
        await prepareAutoSite(context, extensionId, paragraphs(PHYSICS))
        await context.route('https://app.devin.ai/other', (route) =>
          route.fulfill({ contentType: 'text/html', body: paragraphs(other) }),
        )
        api.failNext({ kind: 'status', status: 429, retryAfter: String(retryAfterSeconds) })
        const page = await context.newPage()
        await page.goto('https://app.devin.ai/limited')
        await expect.poll(() => textCalls().length).toBe(1)
        // 限流期间打开的另一个标签页由后台共用的暂停挡住，同样不能发请求
        const second = await context.newPage()
        await second.goto('https://app.devin.ai/other')
        await expect(page.locator('#p1')).toHaveText('中文译文')
        await expect(second.locator('#p1')).toHaveText('中文译文')
        const [limited, ...rest] = textCalls()
        expect(rest.length).toBeGreaterThanOrEqual(2)
        for (const call of rest) {
          // 服务端时钟：暂停从回包才开始计时，所以不会早于收到请求后的 Retry-After（留 100 毫秒取整余量）
          expect(call.at - limited!.at).toBeGreaterThanOrEqual(retryAfterSeconds * 1000 - 100)
        }
        await expect(page.locator('.pause-status')).toBeHidden()
        await expect(second.locator('.pause-status')).toBeHidden()
      } finally {
        await context.close()
      }
    })

    test('5xx：少于上限时自动恢复；连续三次暂停，点继续恢复', async () => {
      const { context, extensionId } = await launch()
      const late = 'A paragraph added after the first recovery keeps failing for a while.'
      try {
        await prepareAutoSite(context, extensionId, paragraphs(PHYSICS))
        api.failNext({ kind: 'status', status: 503 }, { kind: 'status', status: 500 })
        const page = await context.newPage()
        await page.goto('https://app.devin.ai/flaky')
        await expect(page.locator('#p1')).toHaveText('中文译文')
        expect(textCalls()).toHaveLength(3)
        await expect(page.locator('.pause-status')).toBeHidden()

        // 成功清零了失败计数，新一轮要再失败三次才暂停
        api.failNext({ kind: 'status', status: 502 }, { kind: 'status', status: 502 }, { kind: 'status', status: 502 })
        await appendParagraph(page, 'late', late)
        await expect(page.locator('.pause-status')).toBeVisible()
        await expect(page.locator('.pause-status')).toContainText('模型服务暂时不可用')
        expect(textCalls()).toHaveLength(6)
        await expect(page.locator('#late')).toHaveText(late)
        await expect(page.locator('#p1')).toHaveText('中文译文')
        await page.locator('.pause-resume').click()
        await expect(page.locator('#late')).toHaveText('中文译文')
        await expect(page.locator('.pause-status')).toBeHidden()
        expect(textCalls()).toHaveLength(7)
      } finally {
        await context.close()
      }
    })

    test('条数不符：坏条目显示失败并可重试，其余页面继续翻译', async () => {
      const { context, extensionId } = await launch()
      const poison = 'This poison paragraph always gets a wrong item count.'
      try {
        await prepareAutoSite(context, extensionId, paragraphs(PHYSICS, ENTROPY, poison))
        api.wrongCountWhen((texts) => texts.length > 1 || texts.includes(poison))
        const page = await context.newPage()
        await page.goto('https://app.devin.ai/count')
        await expect(page.locator('#p1')).toHaveText('中文译文')
        await expect(page.locator('#p2')).toHaveText('中文译文')
        const includes = (text: string): MockCall[] =>
          textCalls().filter((call) => (call.payload.texts as string[]).includes(text))
        // 三段依次进入视口，各自的防抖可能落在不同批次：只要求都发出过，不要求同批
        for (const text of [PHYSICS, ENTROPY, poison]) expect(includes(text).length).toBeGreaterThan(0)
        await expect.poll(() => includes(poison).at(-1)?.payload.texts).toEqual([poison])
        // 等失败状态真正显示，避免用固定延时猜测重试是否结束。
        const chip = page.locator('.pause-status')
        const retry = page.locator('.pause-resume')
        await expect(chip).toBeVisible()
        await expect(chip).toContainText('翻译失败')
        await expect(chip.locator('.notice-speech')).toHaveAttribute('title', '1 段翻译失败')
        await expect(retry).toBeVisible()
        await expect(retry).toBeEnabled()
        // 单独一条最多试 2 次（MAX_BAD_OUTPUT_TRIES），若首批与其他段同发则再多 1 次；不得无限重发
        const poisonCalls = includes(poison).length
        expect(poisonCalls).toBeGreaterThanOrEqual(2)
        expect(poisonCalls).toBeLessThanOrEqual(3)
        await expect(page.locator('#p3')).toHaveText(poison)
        // 失败提示不代表暂停：后来出现的正常内容仍应自动完成。
        await appendParagraph(page, 'late', 'A healthy paragraph added after a failed item.')
        await expect(page.locator('#late')).toHaveText('中文译文')
        const beforeRetry = textCalls().length
        api.wrongCountWhen(() => false)
        await retry.click()
        await expect(page.locator('#p3')).toHaveText('中文译文')
        await expect(chip).toBeHidden()
        expect(textCalls().slice(beforeRetry).map((call) => call.payload.texts)).toEqual([[poison]])
        api.wrongCountWhen((texts) => texts.some((text) => text.startsWith('Another poison')))
        await appendParagraph(page, 'second-failure', 'Another poison paragraph.')
        await expect(chip).toBeVisible()
        for (const style of ['cyber', 'glass'] as const) {
          const options = context.pages().find((candidate) => candidate.url().includes('options.html'))!
          await setUiStyle(options, style)
          await page.bringToFront()
          await expect(chip).toHaveAttribute('data-style', style)
          expect((await chip.locator('.notice-speech').boundingBox())!.width).toBeLessThanOrEqual(177)
          await page.screenshot({ path: test.info().outputPath(`retry-${style}.png`) })
          const details = chip.locator('.notice-error-details')
          await expect(details).not.toHaveAttribute('open', '')
          await details.locator('summary').focus()
          await page.keyboard.press('Enter')
          await expect(details).toHaveAttribute('open', '')
          await expect(details.locator('.error-reason')).not.toBeEmpty()
          await page.keyboard.press('Enter')
          await expect(details).not.toHaveAttribute('open', '')
        }
        await chip.locator('.notice-close').click()
        await expect(chip).toBeHidden()
        await appendParagraph(page, 'third-failure', 'Another poison paragraph with changed count.')
        const tabId = await tabIdOf(context, page)
        await expect.poll(() => pageStatus(context, tabId).then((status) => status?.failed)).toBe(2)
        await expect(chip).toBeHidden()
      } finally {
        await context.close()
      }
    })

    test('长段落分段在途搬家：按新位置续译，全部成功才写回', async () => {
      const { context, extensionId } = await launch()
      const first = 'a'.repeat(1500)
      const middle = 'b'.repeat(1500)
      const last = 'c'.repeat(600)
      const source = first + middle + last
      try {
        const html = paragraphs(source).replace('</main>', '<div id="target"></div></main>')
        await prepareAutoSite(context, extensionId, html)
        api.hold(first)
        api.hold(last)
        const page = await context.newPage()
        await page.goto('https://app.devin.ai/reparent-long')
        await expect.poll(() => textCalls().some((call) =>
          (call.payload.texts as string[]).includes(first),
        )).toBe(true)
        await page.evaluate(() => {
          const node = document.querySelector('#p1')!.firstChild!
          const marker = document.createElement('button')
          marker.id = 'scan-marker'
          marker.textContent = 'Settings'
          document.querySelector('#target')!.append(node, marker)
        })
        // 词典处理到文本之后的按钮，证明搬动后的扫描已经执行。
        await expect(page.locator('#scan-marker')).toHaveText('设置')
        api.release(first)
        await expect.poll(() => textCalls().some((call) =>
          (call.payload.texts as string[]).includes(last),
        )).toBe(true)
        await expect.poll(() => page.locator('#target').evaluate((el) => el.firstChild?.textContent)).toBe(source)
        api.release(last)
        await expect.poll(() => page.locator('#target').evaluate((el) => el.firstChild?.textContent)).toBe('中文译文'.repeat(3))
        await expect(page.locator('#p1')).toHaveText('')
        await expect(page.locator('.pause-status')).toBeHidden()
        expect(textCalls().flatMap((call) => call.payload.texts as string[]).every((text) => text.length <= 1500)).toBe(true)
      } finally {
        await context.close()
      }
    })

    test('两个标签页同时对接慢接口（每次约 15 秒）：轮流完成，不超时、不暂停', async () => {
      // 不加测试钩子：每页两批、自动任务同时只跑一个，共四次真实的 15 秒请求
      test.setTimeout(180_000)
      const delayMs = 15_000
      const { context, extensionId } = await launch()
      // 单段约 1000 字符，两段超过 1500 字符的批次上限，所以每页恰好两批
      const longParagraph = (label: string): string =>
        `This ${label} paragraph is served by a deliberately slow endpoint. `.repeat(14).trim()
      const firstParagraphs = [longParagraph('first tab opening'), longParagraph('first tab closing')]
      const secondParagraphs = [longParagraph('second tab opening'), longParagraph('second tab closing')]
      try {
        await prepareAutoSite(context, extensionId, paragraphs(...firstParagraphs))
        await context.route('https://app.devin.ai/slow-second', (route) =>
          route.fulfill({ contentType: 'text/html', body: paragraphs(...secondParagraphs) }),
        )
        api.delayTexts(delayMs)
        const first = await context.newPage()
        await first.goto('https://app.devin.ai/slow-first')
        await expect.poll(() => textCalls().length).toBe(1)
        // 第一页的请求还要回复十几秒，第二页的第一批一定排在第一页的第二批之前
        const second = await context.newPage()
        await second.goto('https://app.devin.ai/slow-second')
        for (const page of [first, second]) {
          for (const id of ['#p1', '#p2']) {
            await expect(page.locator(id)).toHaveText('中文译文', { timeout: 120_000 })
          }
        }
        const calls = textCalls()
        const owner = (call: MockCall): string =>
          JSON.stringify(call.payload.texts).includes('first tab') ? 'first' : 'second'
        // 恰好四次说明没有重试；先来先服务下两页交替，不会有一页连续占用
        expect(calls.map(owner)).toEqual(['first', 'second', 'first', 'second'])
        calls.forEach((call, index) => {
          expect(call.aborted).toBe(false)
          expect(call.respondedAt).toBeDefined()
          expect(call.respondedAt! - call.at).toBeGreaterThanOrEqual(delayMs - 100)
          // 自动任务并发为 1：上一个回复之后才发下一个。排队时间不计入请求时限，否则这里早已超时
          if (index > 0) expect(call.at).toBeGreaterThanOrEqual(calls[index - 1]!.respondedAt!)
        })
        await expect(first.locator('.pause-status')).toBeHidden()
        await expect(second.locator('.pause-status')).toBeHidden()
      } finally {
        await context.close()
      }
    })

    test('批次在途时保存无关配置：请求不中止，页面不暂停，翻译完成', async () => {
      const { context, extensionId } = await launch()
      try {
        const options = await prepareAutoSite(context, extensionId, paragraphs(PHYSICS))
        api.hold(PHYSICS)
        const page = await context.newPage()
        await page.goto('https://app.devin.ai/saving')
        await expect.poll(() => textCalls().length).toBe(1)
        const inFlight = textCalls()[0]!
        // 真实走设置页：给另一个站点开自动翻译，再排除另一个主机。两次保存都会刷新所有标签页
        await options.bringToFront()
        await showOptionsSection(options, 'sites')
        await options.locator('.wt-add').first().locator('input').fill('https://reading.example.test')
        await options.locator('[data-test="wt-add"]').click()
        await expect(options.locator('[data-test="wt-origin"]', { hasText: 'reading.example.test' })).toBeVisible()
        await options.locator('[data-test="wt-excluded-input"]').fill('unrelated.example.test')
        await options.locator('[data-test="wt-excluded-add"]').click()
        await expect(options.locator('[data-test="wt-excluded-host"]')).toHaveText('unrelated.example.test')
        await page.bringToFront()
        expect(inFlight.aborted).toBe(false)
        await expect(page.locator('#p1')).toHaveText(PHYSICS)
        await expect(page.locator('.pause-status')).toBeHidden()
        api.release(PHYSICS)
        await expect(page.locator('#p1')).toHaveText('中文译文')
        // 只有一次请求：若被中止，页面会静默重发，译文同样会出现，所以必须查次数
        expect(textCalls()).toHaveLength(1)
        expect(inFlight.aborted).toBe(false)
        expect(inFlight.respondedAt).toBeDefined()
        await expect(page.locator('.pause-status')).toBeHidden()
      } finally {
        await context.close()
      }
    })

    test('Service Worker 在请求途中被终止：请求随之中止，页面自动重发并完成', async () => {
      const { context, extensionId } = await launch()
      try {
        const options = await prepareAutoSite(context, extensionId, paragraphs(PHYSICS))
        api.hold(PHYSICS)
        const page = await context.newPage()
        await page.goto('https://app.devin.ai/worker')
        await expect.poll(() => textCalls().length).toBe(1)
        const first = textCalls()[0]!
        const session = await context.newCDPSession(options)
        const { targetInfos } = await session.send('Target.getTargets')
        const target = targetInfos.find((item) => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${extensionId}/`))
        expect(target).toBeDefined()
        await session.send('Target.closeTarget', { targetId: target!.targetId })
        await session.detach()
        await expect.poll(() => first.aborted).toBe(true)
        // 后台重启不算请求失败：页面退避后重发，发送本身唤醒后台
        await expect(page.locator('#p1')).toHaveText('中文译文')
        expect(textCalls()).toHaveLength(2)
        await expect(page.locator('.pause-status')).toBeHidden()
        expect(await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({ type: 'wt:get-config' })
        })).toMatchObject({ ok: true })
      } finally {
        await context.close()
      }
    })
  })

  async function entryConfig(options: Page): Promise<{ baseUrl: string; model: string; autoOrigins: string[] }> {
    return options.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      const reply = await chrome.runtime.sendMessage({ type: 'wt:get-config' }) as {
        ok: boolean
        config?: { baseUrl: string; model: string; autoOrigins: string[] }
      }
      if (!reply.ok || reply.config === undefined) throw new Error('Fixture config read failed')
      return reply.config
    })
  }

  test('入口改进：获取模型携带当前及保存的凭据，失败恢复、分区保留草稿和手填', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await openOptions(context, extensionId)
      await showOptionsSection(options, 'model')
      const base = options.locator('input[aria-labelledby="wt-base-url-label"]')
      const key = options.locator('input[aria-labelledby="wt-api-key-label"]')
      const model = options.locator('[data-test="wt-model-input"]')
      const fetch = options.locator('[data-test="wt-fetch-models"]')
      const menu = options.locator('[data-test="wt-model-menu"]')
      const choices = options.locator('[data-test="wt-model-options"] [role="option"]')
      const headers = options.locator('[data-test="wt-custom-headers"]')
      const fixtureHeader = 'X-Fixture-Token'
      const rawHeaders = JSON.stringify({ [fixtureHeader]: 'synthetic-entry-header' })
      await base.fill(`${api.url}/v1`)
      await key.fill('sk-e2e-model-list')
      await model.fill('keep-model')
      await options.locator('[data-test="wt-advanced"] > summary').click()
      await headers.fill(rawHeaders)
      await fetch.click()
      const apiOrigin = new URL(api.url)
      await acceptOwnedPermission(options, [`${apiOrigin.protocol}//${apiOrigin.hostname}/*`])
      await expect(menu).toBeVisible()
      if ((await model.getAttribute('aria-expanded')) === 'true') await model.press('Escape')
      await menu.click()
      await expect(choices).toHaveCount(2)
      expect((await choices.allTextContents()).sort()).toEqual(['fixture-model-a', 'fixture-model-b'])
      await model.press('Escape')
      expect(api.modelCalls).toEqual([{
        path: '/v1/models',
        auth: 'Bearer sk-e2e-model-list',
        customHeader: 'synthetic-entry-header',
        status: 200,
      }])
      await expect(model).toHaveValue('keep-model')
      expect(api.calls).toHaveLength(0)
      expect(await entryConfig(options)).toMatchObject({ baseUrl: '', model: '', autoOrigins: [] })

      for (const section of ['general', 'sites', 'model'] as const) await showOptionsSection(options, section)
      await expect(base).toHaveValue(`${api.url}/v1`)
      await expect(key).toHaveValue('sk-e2e-model-list')
      await expect(model).toHaveValue('keep-model')
      await expect(headers).toHaveValue(rawHeaders)
      await expect(menu).toBeVisible()
      if ((await model.getAttribute('aria-expanded')) === 'true') await model.press('Escape')
      await menu.click()
      await expect(choices).toHaveCount(2)
      expect((await choices.allTextContents()).sort()).toEqual(['fixture-model-a', 'fixture-model-b'])
      await model.press('Escape')

      api.failModelsNext(401)
      await fetch.click()
      await expect(options.locator('#wt-model-status')).toHaveClass(/wt-status-error/)
      await expect(fetch).toHaveText(zhCN.wtModelsFetch)
      await expect(fetch).toBeEnabled()
      await expect(menu).toHaveCount(0)
      await expect(choices).toHaveCount(0)
      await expect(base).toHaveValue(`${api.url}/v1`)
      await expect(key).toHaveValue('sk-e2e-model-list')
      await expect(model).toHaveValue('keep-model')
      await expect(headers).toHaveValue(rawHeaders)
      expect(api.modelCalls.at(-1)?.status).toBe(401)
      await fetch.click()
      await expect(menu).toBeVisible()
      if ((await model.getAttribute('aria-expanded')) === 'true') await model.press('Escape')
      await menu.click()
      await expect(choices).toHaveCount(2)
      expect((await choices.allTextContents()).sort()).toEqual(['fixture-model-a', 'fixture-model-b'])
      await model.press('Escape')
      await expect(fetch).toHaveText(zhCN.wtModelsFetch)

      await model.fill('MODEL-B')
      await expect(choices).toHaveCount(1)
      await choices.filter({ hasText: /^fixture-model-b$/ }).click()
      await expect(model).toHaveValue('fixture-model-b')
      await expect(model).toHaveAttribute('aria-expanded', 'false')
      await model.press('ArrowDown')
      await expect(choices).toHaveCount(2)
      await model.press('Enter')
      await expect(model).toHaveValue('fixture-model-a')
      await model.press('Alt+ArrowDown')
      await expect(choices).toHaveCount(2)
      await model.press('Alt+ArrowUp')
      await expect(model).toHaveAttribute('aria-expanded', 'false')
      await model.fill('fixture-model-')
      await expect(choices).toHaveCount(2)
      await model.press('ArrowDown')
      await expect(model).toHaveValue('fixture-model-')
      await model.press('Escape')
      await expect(model).toHaveValue('fixture-model-')
      await model.press('ArrowDown')
      await model.press('Enter')
      await expect(model).toHaveValue('fixture-model-a')
      const chosen = await model.inputValue()
      await saveAdvancedDraft(options)
      expect(api.calls.at(-1)).toMatchObject({
        auth: 'Bearer sk-e2e-model-list',
        customHeader: 'synthetic-entry-header',
        requestBody: { model: chosen },
      })
      await expect(key).toHaveValue('')
      await expect(headers).toHaveValue('')
      const beforeSavedLookup = api.modelCalls.length
      await fetch.click()
      await expect.poll(() => api.modelCalls.length).toBe(beforeSavedLookup + 1)
      await expect(menu).toBeVisible()
      if ((await model.getAttribute('aria-expanded')) === 'true') await model.press('Escape')
      await menu.click()
      await expect(choices).toHaveCount(2)
      expect((await choices.allTextContents()).sort()).toEqual(['fixture-model-a', 'fixture-model-b'])
      await model.press('Escape')
      await expect(fetch).toHaveText(zhCN.wtModelsFetch)
      expect(api.modelCalls.at(-1)).toMatchObject({
        auth: 'Bearer sk-e2e-model-list',
        customHeader: 'synthetic-entry-header',
        status: 200,
      })
      await options.locator('[data-test="wt-delete-key"]').click()
      await expect(menu).toHaveCount(0)
      await expect(choices).toHaveCount(0)
      await expect(options.locator('#wt-model-status')).toHaveCount(0)
      await expect(model).toHaveValue(chosen)
    } catch (error) {
      await context.close().catch(() => undefined)
      throw error
    }
    await context.close()
  })

  test('入口改进：普通页面原生右键翻译、恢复与继续，不加入自动名单', async () => {
    test.skip(process.platform !== 'win32', '原生菜单验收需要Windows UIAutomation')
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      const protectedCode = 'The code sample should remain in English.'
      const authoredText = 'I wrote this sentence myself.'
      await context.route(`${readingUrl()}/page`, (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: PAGE_HTML.replace('</main>', `<pre id="entry-protected-code">${protectedCode}</pre><div id="entry-authored" contenteditable>${authoredText}</div></main>`),
      }))
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.permissions.contains({ origins: ['http://reader.fixture.test/*'] })
      })).toBe(false)
      expect((await entryConfig(options)).autoOrigins).toEqual([])
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      expect(api.calls.filter((call) => call.kind === 'texts')).toHaveLength(0)
      const menu = async (): Promise<void> => {
        await page.bringToFront()
        await page.mouse.click(4, 4)
        await page.locator('#p1').click({ button: 'right' })
        await expect(async () => {
          await invokeOwnedContextMenu(page, '翻译本页 / 恢复原文')
        }).toPass({ timeout: 10_000, intervals: [200, 500, 1000] })
      }
      await menu()
      await expect(page.locator('#p1')).toHaveText('中文译文')
      await expect(page.locator('#entry-protected-code')).toHaveText(protectedCode)
      await expect(page.locator('#entry-authored')).toHaveText(authoredText)
      const sent = JSON.stringify(api.calls.filter((call) => call.kind === 'texts').map((call) => call.payload))
      expect(sent).not.toContain(protectedCode)
      expect(sent).not.toContain(authoredText)
      expect((await entryConfig(options)).autoOrigins).toEqual([])
      await menu()
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      await menu()
      await expect(page.locator('#p1')).toHaveText('中文译文')
      expect((await entryConfig(options)).autoOrigins).toEqual([])
    } finally {
      await context.close()
    }
  })

  test('入口改进：悬浮翻译仅作用当前文档，与永久自动翻译分开', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableFloating(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      const tabId = await waitForSiteScript(context, page)
      await expect(page.locator('.floating-entry')).toBeVisible()
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      expect(api.calls.filter((call) => call.kind === 'texts')).toHaveLength(0)
      expect((await entryConfig(options)).autoOrigins).toEqual([])
      await page.locator('.floating-entry').click()
      await expect(page.locator('.floating-menu')).toBeVisible()
      await page.locator('.floating-translate').click()
      await expect(page.locator('#p1')).toHaveText('中文译文')
      await expect(page.locator('.floating-menu')).toBeVisible()
      await expect.poll(() => pageStatus(context, tabId).then((status) => status?.auto)).toBe(true)
      await expect(page.locator('.floating-page')).toHaveText(zhCN.wtRestore)
      await expect(page.locator('.floating-consent')).toBeHidden()
      expect((await entryConfig(options)).autoOrigins).toEqual([])
      await page.screenshot({ path: test.info().outputPath('entry-floating-page.png') })
      await page.evaluate(() => {
        const link = document.createElement('a')
        link.id = 'entry-anchor'
        link.href = '#entry-section'
        link.textContent = 'Go to section'
        document.body.prepend(link)
      })
      await page.locator('#entry-anchor').click()
      await expect(page).toHaveURL(/#entry-section$/)
      await page.evaluate(() => {
        const paragraph = document.createElement('p')
        paragraph.id = 'entry-after-anchor'
        paragraph.textContent = 'This paragraph appeared after an ordinary anchor navigation.'
        document.body.prepend(paragraph)
      })
      await expect(page.locator('#entry-after-anchor')).toHaveText('中文译文')
      expect((await entryConfig(options)).autoOrigins).toEqual([])
      if (await page.locator('.floating-menu').isHidden()) await page.locator('.floating-entry').click()
      await page.locator('.floating-page').click()
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      await expect(page.locator('.floating-resume')).toHaveText('继续翻译')
      await page.locator('.floating-resume').click()
      await expect(page.locator('#p1')).toHaveText('中文译文')
      await page.reload()
      await waitForSiteScript(context, page)
      await expect.poll(() => pageStatus(context, tabId).then((status) => status?.auto)).toBe(false)
      await expect(page.locator('.floating-entry')).toBeVisible()
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      expect((await entryConfig(options)).autoOrigins).toEqual([])
    } finally {
      await context.close()
    }
  })

  test('入口改进：原生弹出页翻译恢复、悬浮开关及双主题', async () => {
    const attachBefore = process.env.PW_CHROMIUM_ATTACH_TO_OTHER
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1'
    let context: BrowserContext | undefined
    try {
      const launched = await launch(null)
      context = launched.context
      const options = await saveAndConnect(context, launched.extensionId)
      await enableFloating(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      const tabId = await waitForSiteScript(context, page)
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      await page.bringToFront()
      const worker = context.serviceWorkers()[0]!
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 10_000 }),
        worker.evaluate(async (id) => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          const tab = await chrome.tabs.get(id)
          await chrome.action.openPopup({ windowId: tab.windowId })
        }, tabId),
      ])
      await expect(popup).toHaveURL(`chrome-extension://${launched.extensionId}/popup.html`)
      const actual = await popup.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
        const ownTab = await chrome.tabs.getCurrent()
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })
        return {
          activeId: active?.id,
          ownTabId: ownTab?.id ?? null,
          isPopup: contexts.some((item) => item.documentUrl === location.href),
        }
      })
      expect(actual).toEqual({ activeId: tabId, ownTabId: null, isPopup: true })
      await expect(popup.locator('.popup-enable [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="wt-popup-auto-interaction"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="wt-popup-floating"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="wt-popup-video-subtitles"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="wt-popup-input-translation"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="settings"]')).toBeVisible()
      const autoInteraction = popup.locator('[data-test="wt-popup-auto-interaction"] [role="switch"]')
      await autoInteraction.click()
      await expect(autoInteraction).toHaveAttribute('aria-checked', 'false')
      await expect.poll(() => configFlag(options, 'autoInteractionEnabled')).toBe(false)
      const pageUrl = page.url()
      expect(
        await popup.evaluate(
          async ({ id, url }) => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({ type: 'wt:translate-page', tabId: id, url })
          },
          { id: tabId, url: pageUrl },
        ),
      ).toEqual({ ok: true })
      await expect(page.locator('#p1')).toHaveText('中文译文')
      expect((await entryConfig(options)).autoOrigins).toEqual([])
      expect(
        await popup.evaluate(
          async ({ id, url }) => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({ type: 'wt:page-action', action: 'restore', tabId: id, url })
          },
          { id: tabId, url: pageUrl },
        ),
      ).toEqual({ ok: true })
      await expect(page.locator('#p1')).toHaveText(PHYSICS)
      expect(
        await popup.evaluate(
          async ({ id, url }) => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({ type: 'wt:page-action', action: 'resume', tabId: id, url })
          },
          { id: tabId, url: pageUrl },
        ),
      ).toEqual({ ok: true })
      await expect(page.locator('#p1')).toHaveText('中文译文')
      const floating = popup.locator('[data-test="wt-popup-floating"] [role="switch"]')
      await expect(floating).toHaveAttribute('aria-checked', 'true')
      await floating.click()
      await expect(floating).toHaveAttribute('aria-checked', 'false')
      await expect(page.locator('.floating-entry')).toBeHidden()
      await floating.click()
      await expect(floating).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('.floating-entry')).toBeVisible()
      for (const style of ['cyber', 'glass'] as const) {
        await setUiStyle(options, style)
        await expect(popup.locator('html')).toHaveAttribute('data-style', style)
        expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
        await popup.screenshot({ path: test.info().outputPath(`entry-native-popup-${style}.png`) })
      }
      expect((await entryConfig(options)).autoOrigins).toEqual([])
    } finally {
      await context?.close()
      if (attachBefore === undefined) delete process.env.PW_CHROMIUM_ATTACH_TO_OTHER
      else process.env.PW_CHROMIUM_ATTACH_TO_OTHER = attachBefore
    }
  })

  const SCREENS = process.env.WT_SCREENSHOT_DIR ?? resolve(tmpdir(), 'web-translator-e2e-screens')

  async function openOptions(context: BrowserContext, extensionId: string): Promise<Page> {
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html`)
    await options.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      const stored = await chrome.storage.sync.get('settings')
      await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiLanguage: 'zh-CN' } })
    })
    await expect(options.locator('[data-test="wt-assist-mode"]')).toBeEnabled()
    return options
  }

  async function configFlag(options: Page, key: string): Promise<boolean> {
    return options.evaluate(async (name) => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      const reply = await chrome.runtime.sendMessage({ type: 'wt:get-config' }) as
        { ok: boolean; config?: Record<string, unknown> }
      if (!reply.ok || reply.config === undefined) throw new Error('Fixture config read failed')
      return reply.config[name] === true
    }, key)
  }

  async function enableFloating(options: Page): Promise<void> {
    await showOptionsSection(options, 'general')
    const toggle = options.locator('[data-test="wt-floating-toggle"] [role="switch"]')
    await expect(toggle).toBeEnabled()
    if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    const hasAccess = (): Promise<boolean> => options.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      return chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })
    })
    if (!await hasAccess()) {
      await options.locator('[data-test="wt-floating-grant"]').click()
      await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
    }
    await expect.poll(hasAccess).toBe(true)
    await expect.poll(() => configFlag(options, 'floatingButtonEnabled')).toBe(true)
  }

  async function enableToolbarMode(options: Page): Promise<void> {
    await showOptionsSection(options, 'general')
    await options.locator('[data-test="wt-assist-mode"]').click()
    await options.getByRole('option', { name: /Selection toolbar|选择工具栏|選擇工具列/ }).click()
    await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
    await expect.poll(() => configFlag(options, 'selectionToolbarEnabled')).toBe(true)
    await expect(options.locator('[data-test="wt-assist-mode"]')).toBeEnabled()
  }

  async function setUiStyle(options: Page, style: 'classic' | 'cyber' | 'glass'): Promise<void> {
    await options.evaluate(async (uiStyle) => {
      const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
      const stored = await chrome.storage.sync.get('settings')
      await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiStyle } })
    }, style)
  }

  async function tabIdOf(context: BrowserContext, page: Page): Promise<number> {
    const worker = context.serviceWorkers()[0]!
    return worker.evaluate(async (url) => {
      const { chrome } = globalThis as unknown as {
        chrome: { tabs: { query(query: object): Promise<Array<{ id?: number; url?: string }>> } }
      }
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
      if (tab?.id === undefined) throw new Error('Fixture tab missing')
      return tab.id
    }, page.url())
  }

  async function pageStatus(context: BrowserContext, tabId: number): Promise<{ auto?: boolean; paused?: boolean; fixed?: boolean; failed?: number } | undefined> {
    const worker = context.serviceWorkers()[0]!
    return worker.evaluate(async (id) => {
      const { chrome } = globalThis as unknown as {
        chrome: { tabs: { sendMessage(id: number, message: unknown): Promise<unknown> } }
      }
      const reply = await chrome.tabs.sendMessage(id, { type: 'wt:status' }).catch(() => undefined)
      return (reply as { status?: { auto?: boolean; paused?: boolean; fixed?: boolean; failed?: number } } | undefined)?.status
    }, tabId)
  }

  /** 站点脚本按配置异步注册：先等注册含该匹配模式，再打开页面，否则已加载的页面不会注入 */
  async function waitForRegistration(context: BrowserContext, pattern: string): Promise<void> {
    const worker = context.serviceWorkers()[0]!
    await waitForSiteScriptRegistration(worker, { requiredMatches: [pattern] })
  }

  /** 页面里的内容脚本已就绪（能回答 wt:status） */
  async function waitForSiteScript(context: BrowserContext, page: Page): Promise<number> {
    const worker = context.serviceWorkers()[0]!
    return waitForSiteContentReady(worker, page)
  }

  /** 持久化上下文里不能授予 clipboard-read：用可信的 Ctrl+V 粘贴到探针 textarea 读取剪贴板 */
  async function readClipboardByPaste(page: Page): Promise<string> {
    await page.evaluate(() => {
      const probe = document.createElement('textarea')
      probe.id = 'wt-paste-probe'
      probe.style.cssText = 'position:fixed;top:0;left:0;width:200px;height:40px;z-index:1'
      document.body.append(probe)
      probe.focus({ preventScroll: true })
    })
    await page.keyboard.press('Control+v')
    const value = await page.locator('#wt-paste-probe').inputValue()
    await page.evaluate(() => document.getElementById('wt-paste-probe')?.remove())
    return value
  }

  const cssViewport = (page: Page) =>
    page.evaluate(() => ({
      w: Math.min(innerWidth, document.documentElement.clientWidth || innerWidth),
      h: Math.min(innerHeight, document.documentElement.clientHeight || innerHeight),
    }))

  test('悬浮入口：拖拽贴边、可信点击展开、键盘移动、刷新保持', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableFloating(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await page.bringToFront()
      const entry = page.locator('.floating-entry')
      const menu = page.locator('.floating-menu')
      await expect(entry).toBeVisible({ timeout: 15_000 })
      const { w } = await cssViewport(page)
      await expect.poll(() => entry.boundingBox().then((box) => Math.abs(box!.x - (w - 20)))).toBeLessThan(1.5)
      const initial = (await entry.boundingBox())!
      await page.mouse.move(w - 10, initial.y + 20)
      await expect.poll(() => entry.boundingBox().then((box) => Math.abs(box!.x - (w - 40)))).toBeLessThan(1.5)
      const start = (await entry.boundingBox())!
      // 在页面中间松开也会靠近最近一侧，移开后自动半收起。
      await page.mouse.move(start.x + 20, start.y + 20)
      await page.mouse.down()
      await page.mouse.move(600, start.y + 20, { steps: 6 })
      await page.mouse.move(210, 300, { steps: 10 })
      await page.mouse.up()
      await page.mouse.move(600, 500)
      await expect.poll(() => entry.boundingBox().then((b) => Math.abs(b!.x + 20)), { timeout: 10_000 }).toBeLessThan(1.5)
      const collapsed = (await entry.boundingBox())!
      expect(Math.abs(collapsed.x + 20)).toBeLessThan(1.5)
      expect(Math.abs(collapsed.x + collapsed.width - 20)).toBeLessThan(1.5)
      await expect(entry).toHaveAttribute('aria-label', '展开翻译工具')
      await expect(menu).toBeHidden()
      expect(await entry.evaluate((el) => el.classList.contains('is-dragging'))).toBe(false)
      await page.screenshot({ path: `${SCREENS}/floating-classic-collapsed.png` })
      // 半收起状态一次点击即展开并打开菜单。
      await page.mouse.click(10, collapsed.y + 20)
      await expect.poll(() => entry.boundingBox().then((b) => b!.x), { timeout: 10_000 }).toBeGreaterThanOrEqual(0)
      expect(Math.abs((await entry.boundingBox())!.x)).toBeLessThan(1.5)
      await expect(menu).toBeVisible({ timeout: 10_000 })
      await expect(entry).toHaveAttribute('aria-expanded', 'true')
      await expect(menu).toHaveAttribute('aria-labelledby', 'wt-floating-title')
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden({ timeout: 5_000 })
      await expect(entry).toHaveAttribute('aria-expanded', 'false')
      expect(await entry.evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el)).toBe(true)
      // 键盘：Shift+↑ 上移 20px，Shift+→ 切到右侧
      const yBefore = (await entry.boundingBox())!.y
      await entry.press('Shift+ArrowUp')
      await expect.poll(() => entry.boundingBox().then((b) => Math.abs(b!.y - (yBefore - 20))), { timeout: 5_000 }).toBeLessThan(1.5)
      await entry.press('Shift+ArrowRight')
      await expect.poll(() => entry.boundingBox().then((b) => Math.abs(b!.x - (w - 40))), { timeout: 5_000 }).toBeLessThan(1.5)
      await expect.poll(() => options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const data = await chrome.storage.local.get('translationFloatingPosition')
        return (data.translationFloatingPosition as { side?: string; collapsed?: boolean } | undefined)
      }), { timeout: 5_000 }).toMatchObject({ side: 'right', collapsed: true })
      // 刷新后位置保持（新脚本先按默认位置出现，再读到存储的位置：等它落到保存的位置）
      const saved = (await entry.boundingBox())!
      await page.reload()
      await expect(entry).toBeVisible({ timeout: 15_000 })
      await expect.poll(async () => {
        const after = (await entry.boundingBox())!
        return Math.max(Math.abs(after.x - (w - 20)), Math.abs(after.y - saved.y))
      }, { timeout: 10_000 }).toBeLessThan(2)
    } finally {
      await context.close()
    }
  })

  test('悬浮菜单：未配置提示、设置入口、开启本站自动翻译与恢复/继续', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await openOptions(context, extensionId)
      await enableFloating(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await page.bringToFront()
      const entry = page.locator('.floating-entry')
      const menu = page.locator('.floating-menu')
      const primary = page.locator('.floating-auto')
      const openMenu = async (): Promise<void> => {
        await page.bringToFront()
        if (await menu.isHidden()) await entry.click()
        await expect(menu).toBeVisible({ timeout: 10_000 })
      }
      await expect(entry).toBeVisible({ timeout: 15_000 })
      // 只有入口可见：卡片、陪读提示、工具栏与关闭态菜单都不得渲染（曾在页面左上角露出空卡片和提示）
      for (const selector of ['.panel', '.hint', '.selection-toolbar', '.pause-status', '.floating-menu']) {
        expect(await page.locator(selector).evaluate((el) => getComputedStyle(el).display), selector).toBe('none')
      }
      await openMenu()
      // 未配置模型时主动作引导配置，设置和关闭仍可用。
      await expect(primary).toBeDisabled()
      await expect(page.locator('.floating-translate')).toHaveText('请在扩展设置中配置模型')
      await expect(page.locator('.floating-close')).toBeEnabled()
      await expect(page.locator('.floating-consent')).toHaveCount(0)
      // openOptionsPage 会复用已打开的设置页：先关掉再点「设置」，应新开一个设置页且菜单无错误提示
      await options.close()
      await page.bringToFront()
      await page.locator('.floating-settings').click()
      await expect.poll(() => context.pages().filter((p) => p.url().includes('options.html')).length, { timeout: 10_000 }).toBe(1)
      await expect(page.locator('.floating-error')).toBeHidden()
      const reopened = context.pages().find((p) => p.url().includes('options.html'))!
      await reopened.waitForLoadState('domcontentloaded')
      // 两种主题截图
      for (const style of ['cyber', 'glass'] as const) {
        await setUiStyle(reopened, style)
        await expect.poll(() => entry.getAttribute('data-style'), { timeout: 5_000 }).toBe(style)
        await openMenu()
        await page.screenshot({ path: `${SCREENS}/floating-${style}-menu.png` })
      }
      // 配置模型后只点一次开关；等待条件中不重复执行切换。
      await saveAndConnect(context, extensionId)
      await expect(async () => {
        await openMenu()
        await expect(primary).toBeEnabled({ timeout: 2_000 })
        await expect(primary).toHaveAttribute('role', 'switch')
        await expect(primary).toHaveAttribute('aria-checked', 'false')
      }).toPass({ timeout: 30_000 })
      // 闭合 ShadowRoot 下网页主世界不可读取开关或卡片 DOM。
      expect(
        await page.evaluate(() => {
          const host = document.querySelector('[data-wt-root]')
          return {
            hasHost: host !== null,
            shadowRoot: host?.shadowRoot ?? null,
            hostControl: host?.querySelector('.floating-auto') ?? null,
            docControl: document.querySelector('.floating-auto'),
            hostText: host?.textContent ?? '',
          }
        }),
      ).toEqual({
        hasHost: true,
        shadowRoot: null,
        hostControl: null,
        docControl: null,
        hostText: '',
      })
      await page.screenshot({ path: `${SCREENS}/floating-glass-immediate.png` })
      await expect(primary).toBeEnabled()
      const callsBefore = api.calls.length
      await primary.click()
      const tabId = await tabIdOf(context, page)
      await expect.poll(() => pageStatus(context, tabId).then((status) => status?.auto === true), { timeout: 15_000 }).toBe(true)
      await expect(page.locator('#p1')).toHaveText('中文译文', { timeout: 15_000 })
      expect(api.calls.length).toBeGreaterThan(callsBefore)
      // 恢复本页原文 → 继续翻译（开启后的重载可能关闭菜单，同样重试到稳定）
      await expect(async () => {
        await openMenu()
        await expect(primary).toHaveAttribute('aria-checked', 'true', { timeout: 2_000 })
        await expect(page.locator('.floating-page')).toHaveText('恢复本页原文', { timeout: 2_000 })
        await page.locator('.floating-page').click({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
      await expect(page.locator('#p1')).toHaveText(PHYSICS, { timeout: 10_000 })
      await expect(async () => {
        await openMenu()
        await expect(page.locator('.floating-resume')).toHaveText('继续翻译', { timeout: 2_000 })
        await page.locator('.floating-resume').click({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
      await expect(page.locator('#p1')).toHaveText('中文译文', { timeout: 15_000 })
      await openMenu()
      await expect(page.locator('.floating-page')).toHaveText('恢复本页原文')
    } finally {
      await context.close()
    }
  })

  test('工具栏未配置提示与本地复制', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await openOptions(context, extensionId)
      await enableToolbarMode(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await waitForSiteScript(context, page)
      await dragText(page, '#p1')
      const toolbar = page.locator('.selection-toolbar')
      await expect(toolbar).toBeVisible({ timeout: 15_000 })
      const hint = page.locator('.toolbar-configure-hint')
      await expect(hint).toBeVisible()
      await expect(hint).toHaveText('翻译、释义和解释需先配置模型，复制可直接使用。')
      expect(await toolbar.getAttribute('aria-describedby')).toBe(await hint.getAttribute('id'))
      await expect(toolbar.locator('[data-action="translate"]')).toBeDisabled()
      await expect(toolbar.locator('[data-action="define"]')).toBeDisabled()
      await expect(toolbar.locator('[data-action="explain"]')).toBeDisabled()
      await expect(toolbar.locator('[data-action="copy"]')).toBeEnabled()
      await page.screenshot({ path: `${SCREENS}/toolbar-unconfigured-hint.png` })
      const callsBefore = api.calls.length
      await toolbar.locator('[data-action="copy"]').click()
      await expect(toolbar.locator('[data-action="copy"]')).toHaveText('已复制', { timeout: 5_000 })
      expect(api.calls.length).toBe(callsBefore)
      expect(await readClipboardByPaste(page)).toBe(PHYSICS)
    } finally {
      await context.close()
    }
  })

  test('结果卡片复制译文', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.goto(`${readingUrl()}/page`)
      await waitForSiteScript(context, page)
      await dragText(page, '#p1')
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(PHYSICS)
      const target = page.locator('.panel-target')
      await expect(target).toHaveText('量子退相干', { timeout: 15_000 })
      // 主世界隔离断言：闭合 ShadowRoot 下网页主世界读不到卡片译文与内部节点
      expect(
        await page.evaluate(() => {
          const host = document.querySelector('[data-wt-root]')
          return {
            shadowRoot: host?.shadowRoot ?? null,
            hostTarget: host?.querySelector('.panel-target') ?? null,
            docTarget: document.querySelector('.panel-target'),
            hostText: host?.textContent ?? '',
          }
        }),
      ).toEqual({
        shadowRoot: null,
        hostTarget: null,
        docTarget: null,
        hostText: '',
      })
      const copy = page.locator('.panel-copy')
      await expect(copy).toBeVisible()
      await expect(copy).toHaveText('复制')
      await copy.click()
      await expect(copy).toHaveText('已复制', { timeout: 5_000 })
      await page.screenshot({ path: `${SCREENS}/panel-copy-copied.png` })
      await expect(copy).toHaveText('复制', { timeout: 5_000 })
      await expect(page.getByRole('dialog', { name: '翻译结果' })).toBeVisible()
      expect(await readClipboardByPaste(page)).toBe('量子退相干')
    } finally {
      await context.close()
    }
  })

  test('构建产物 manifest commands 声明 Alt+T 与 Alt+S', async () => {
    const manifest = JSON.parse(await readFile(resolve(EXTENSION_PATH, 'manifest.json'), 'utf8')) as {
      commands: Record<string, { suggested_key: { default: string } }>
    }
    expect(manifest.commands['toggle-page-translation']?.suggested_key.default).toBe('Alt+T')
    expect(manifest.commands['translate-selection']?.suggested_key.default).toBe('Alt+S')
    expect(manifest.commands['translate-input']?.suggested_key.default).toBe('Alt+Y')
  })

  test('弹出页只有总开关、五项全局开关和设置齿轮', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const blank = await context.newPage()
      await blank.goto('about:blank')
      const popup = await context.newPage()
      await popup.goto(`chrome-extension://${extensionId}/popup.html`)
      await expect(popup.locator('[data-test="settings"]')).toBeVisible()
      await expect(popup.locator('[role="switch"]')).toHaveCount(5)
      await expect(popup.locator('.popup-details, [data-test="repository"]')).toHaveCount(0)
      await expect(popup.getByRole('button', { name: '规则' })).toHaveCount(0)
      await expect(popup.getByText('GitHub 词典语言', { exact: true })).toHaveCount(0)
      await popup.screenshot({ path: testInfo.outputPath('popup-compact.png') })
      const optionsUrlRegex = new RegExp(`^chrome-extension://${extensionId}/options\\.html`)
      const optionsPrefix = `chrome-extension://${extensionId}/options.html`
      const optionsPromise = context.waitForEvent('page')
      await popup.locator('[data-test="settings"]').click()
      await Promise.race([
        optionsPromise.then((page) => page.waitForLoadState('domcontentloaded')),
        popup.waitForURL(optionsUrlRegex),
      ].map((pending) => pending.catch(() => undefined)))
      await expect.poll(() => context.pages().some((page) => page.url().startsWith(optionsPrefix))).toBe(true)
      const options = context.pages().find((page) => page.url().startsWith(optionsPrefix))!
      await options.waitForLoadState('domcontentloaded')
      await options.locator('[data-test="nav-github-title"]').click()
      await expect(options.locator('.wt-github-preferences')).toBeVisible()
      await expect(options.locator('label[for="page-language"]')).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('精简弹出页：开关与设置齿轮', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const blank = await context.newPage()
      await blank.goto('about:blank')
      const popup = await context.newPage()
      await popup.setViewportSize({ width: 320, height: 720 })
      await context.serviceWorkers()[0]!.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const stored = await chrome.storage.sync.get('settings')
        await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiLanguage: 'zh-CN' } })
      })
      await popup.goto(`chrome-extension://${extensionId}/popup.html`)
      await expect(popup.locator('[role="switch"]')).toHaveCount(5)
      await expect(popup.locator('[data-test="wt-popup-auto-interaction"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="wt-popup-floating"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="wt-popup-video-subtitles"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('[data-test="wt-popup-input-translation"] [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('.popup-enable [role="switch"]')).toHaveCount(1)
      await expect(popup.locator('.popup-details')).toHaveCount(0)
      await expect(popup.locator('footer a[href]')).toHaveCount(0)
      await expect(popup.getByRole('button', { name: '规则' })).toHaveCount(0)
      await expect(popup.locator('[data-test="wt-settings"]')).toHaveCount(0)
      const footerButtons = popup.locator('footer button')
      await expect(footerButtons).toHaveCount(3)
      await expect(popup.locator('[data-test="settings"]')).toHaveAttribute('aria-label', '设置')
      await popup.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const stored = await chrome.storage.sync.get('settings')
        await chrome.storage.sync.set({
          settings: {
            ...(stored.settings as object ?? {}),
            uiLanguage: 'zh-CN',
            language: 'zh-TW',
            translateTime: false,
            translateTitle: true,
          },
        })
      })
      await popup.screenshot({ path: testInfo.outputPath('compact-popup.png') })
      const optionsUrlRegex = new RegExp(`^chrome-extension://${extensionId}/options\\.html`)
      const optionsPrefix = `chrome-extension://${extensionId}/options.html`
      const optionsPromise = context.waitForEvent('page')
      await popup.locator('button[data-test="settings"]').click()
      // Full-page extension views reuse the popup target, so openOptionsPage may
      // navigate this page instead of opening a new one. Either landing is valid.
      await Promise.race([
        optionsPromise.then((page) => page.waitForLoadState('domcontentloaded')),
        popup.waitForURL(optionsUrlRegex),
      ].map((pending) => pending.catch(() => undefined)))
      await expect.poll(() => context.pages().some((page) => page.url().startsWith(optionsPrefix))).toBe(true)
      const options = context.pages().find((page) => page.url().startsWith(optionsPrefix))!
      await options.waitForLoadState('domcontentloaded')
      await expect(options).toHaveURL(new RegExp(`^chrome-extension://${extensionId}/options\\.html`))
      await expect(options.locator('[data-test="wt-general-view"]')).toBeVisible()
      await expect(options.locator('[data-test="wt-input-target-language"]')).toBeVisible()
      await expect(options.locator('[data-test="wt-shortcuts"]')).toBeVisible()
      await expect(options.locator('.wt-privacy-note')).toContainText('不随浏览器账号同步')
      await options.locator('[data-test="wt-shortcuts"]').scrollIntoViewIfNeeded()
      await options.screenshot({ path: testInfo.outputPath('input-settings.png'), fullPage: true })
      await options.locator('[data-test="nav-github-title"]').click()
      await expect(options.locator('.wt-github-preferences')).toBeVisible()
      await expect(options.getByText('GitHub 词典语言', { exact: true })).toBeVisible()
      await expect(options.locator('[data-test="ui-language"]')).toContainText('简体中文')
      await expect(options.locator('[data-test="page-language"]')).toContainText('繁體中文')
      const githubSwitches = options.locator('.wt-github-preferences [role="switch"]')
      await expect(githubSwitches).toHaveCount(2)
      await expect(githubSwitches.nth(0)).toHaveAttribute('aria-checked', 'false')
      await expect(githubSwitches.nth(1)).toHaveAttribute('aria-checked', 'true')
    } finally {
      await context.close()
    }
  })

  test('输入翻译快捷键：目标语言与直接替换', async () => {
    const testInfo = test.info()
    const bundle = await bundleProseMirrorFixture()
    const { context, extensionId } = await launch()
    const targetUrl = 'https://chatgpt.com/c/shortcut'
    const origin = new URL(targetUrl).origin
    const scriptUrl = `${origin}/wt-chat-fixture.js`
    await context.route(`${origin}/**`, async (route) => {
      const url = route.request().url().split('?')[0] ?? ''
      if (url === targetUrl) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><head><meta charset="utf-8"><title>Input Shortcut Fixture</title></head><body style="margin:24px"><div id="editor-mount"></div><button id="fixture-send" type="button">Send</button><script src="${scriptUrl}"></script></body></html>`,
        })
        return
      }
      if (url === scriptUrl) {
        await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle })
        return
      }
      await route.abort()
    })
    try {
      const options = await saveAndConnect(context, extensionId)
      api.setTextTranslator((text) => {
        if (text === '请检查这段代码') return 'Revisa este código.'
        if (text === '你好') return 'こんにちは'
        return `EN:${text}`
      })
      await enableRealtimeFeature(options, 'input')
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({
          type: 'wt:save-config',
          patch: {
            inputTargetLanguage: 'es',
            targetLanguage: 'ja',
            autoInteractionEnabled: false,
            floatingButtonEnabled: false,
          },
        })
      })).toMatchObject({
        ok: true,
        config: { inputTargetLanguage: 'es', targetLanguage: 'ja', autoInteractionEnabled: false },
      })
      const page = await context.newPage()
      await page.goto(targetUrl)
      await waitForSiteScriptRegistration(options, { url: targetUrl })
      await waitForSiteContentReady(options, page, { supported: true })
      const readModel = (): Promise<string> => page.evaluate(() => {
        const root = document.getElementById('chat-editor') as (HTMLElement & { editor?: { state: { doc: { content: { size: number }; textBetween(from: number, to: number, blockSeparator: string, leafText: string): string } } } }) | null
        const current = root?.editor
        if (current === undefined) return ''
        return current.state.doc.textBetween(0, current.state.doc.content.size, '\n', '\n')
      })
      const readSent = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __sentDrafts?: string[] }).__sentDrafts ?? [])
      await page.bringToFront()
      const editor = page.locator('#chat-editor')
      const readDOM = (): Promise<string> => editor.innerText()
      await editor.click()
      const callsBefore = api.calls.length
      await page.keyboard.type('请检查这段代码')
      await page.waitForTimeout(650)
      expect(api.calls.slice(callsBefore).filter((call) => call.kind === 'texts')).toEqual([])
      expect(await readModel()).toBe('请检查这段代码')
      await context.serviceWorkers()[0]!.evaluate(() => {
        const probe = globalThis as unknown as { chrome: FixtureChrome; __wtNativeCommands: string[] }
        probe.__wtNativeCommands = []
        probe.chrome.commands.onCommand.addListener((command) => { probe.__wtNativeCommands.push(command) })
      })
      const readNativeCommands = (): Promise<string[]> => context.serviceWorkers()[0]!.evaluate(() => {
        const probe = globalThis as unknown as { __wtNativeCommands?: string[] }
        return probe.__wtNativeCommands ?? []
      })
      const shortcut = await sendOwnedBrowserAltShortcut(page, 'Y', async () => (await readModel()) === 'Revisa este código.')
      const commands = await readNativeCommands()
      if (!shortcut.sent && !commands.includes('translate-input')) {
        testInfo.skip(true, `ENVIRONMENT GATE: Windows 原生快捷键未触发浏览器扩展命令: ${shortcut.reason ?? 'unknown'}`)
        return
      }
      expect(commands).toContain('translate-input')
      await expect.poll(readModel).toBe('Revisa este código.')
      await expect.poll(readDOM).toBe('Revisa este código.')
      expect(await readSent()).toEqual([])
      const spanish = api.calls.findLast((call) => {
        const texts = call.payload.texts
        return call.kind === 'texts' && Array.isArray(texts) && texts[0] === '请检查这段代码'
      })
      expect(JSON.stringify(spanish?.requestBody)).toContain('Spanish')
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const reply = await chrome.runtime.sendMessage({ type: 'wt:get-config' }) as { config?: { targetLanguage?: string } }
        return reply.config?.targetLanguage
      })).toBe('ja')
      await page.locator('[data-wt-root] .popover button[data-action="restore"]').click()
      await expect.poll(readModel).toBe('请检查这段代码')

      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:save-config', patch: { inputTargetLanguage: 'ja' } })
      })).toMatchObject({ ok: true, config: { inputTargetLanguage: 'ja', targetLanguage: 'ja' } })
      await page.bringToFront()
      await editor.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.type('你好')
      await page.waitForTimeout(200)
      const japanese = await sendOwnedBrowserAltShortcut(page, 'Y', async () => (await readModel()) === 'こんにちは')
      expect(japanese.sent, japanese.reason).toBe(true)
      await expect.poll(readModel).toBe('こんにちは')
      await expect.poll(readDOM).toBe('こんにちは')
      expect(await readSent()).toEqual([])

      api.hold('请检查这段代码')
      await editor.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.type('请检查这段代码')
      const heldCommandsBefore = (await readNativeCommands()).filter((name) => name === 'translate-input').length
      const heldCallsBefore = api.calls.length
      const held = await sendOwnedBrowserAltShortcut(page, 'Y', async () => {
        const count = (await readNativeCommands()).filter((name) => name === 'translate-input').length
        return count > heldCommandsBefore && api.calls.slice(heldCallsBefore).some((call) => {
          const texts = call.payload.texts
          return call.kind === 'texts' && Array.isArray(texts) && texts[0] === '请检查这段代码'
        })
      })
      expect(held.sent, held.reason).toBe(true)
      expect((await readNativeCommands()).filter((name) => name === 'translate-input')).toHaveLength(heldCommandsBefore + 1)
      await page.keyboard.press('Control+A')
      await page.keyboard.type('新的中文')
      api.release('请检查这段代码')
      await page.waitForTimeout(400)
      expect(await readModel()).toBe('新的中文')
      expect(await readSent()).toEqual([])
    } finally {
      await context.close()
    }
  })

  test('快捷键 Alt+T 切换本页翻译、Alt+S 翻译选中文字（原生按键触发）', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await enableToolbarMode(options)
      const origin = new URL(readingUrl()).origin
      expect(await options.evaluate(async (targetOrigin) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: targetOrigin, enabled: true })
      }, origin)).toMatchObject({ ok: true })
      const targetUrl = `${readingUrl()}/page`
      await waitForSiteScriptRegistration(options, {
        url: targetUrl,
        requiredMatches: ['http://*/*', 'https://*/*'],
        selectionToolbarEnabled: true,
        autoOrigin: origin,
      })
      const page = await context.newPage()
      await page.goto(targetUrl)
      await waitForSiteContentReady(options, page, { supported: true, auto: true })
      await page.bringToFront()
      await expect(page.locator('#p1')).toHaveText('中文译文', { timeout: 15_000 })
      await page.mouse.click(4, 4)

      await context.serviceWorkers()[0]!.evaluate(() => {
        const probe = globalThis as unknown as { chrome: FixtureChrome; __wtNativeCommands: string[] }
        probe.__wtNativeCommands = []
        probe.chrome.commands.onCommand.addListener((command) => { probe.__wtNativeCommands.push(command) })
      })
      const readNativeCommands = (): Promise<string[]> =>
        context.serviceWorkers()[0]!.evaluate(() => {
          const probe = globalThis as unknown as { chrome: FixtureChrome; __wtNativeCommands: string[] }
          return probe.__wtNativeCommands
        })

      const firstToggle = await sendOwnedBrowserAltShortcut(
        page,
        'T',
        async () => (await page.locator('#p1').textContent()) === PHYSICS,
      )
      if (!firstToggle.sent) {
        const commandsAfterFirst = await readNativeCommands()
        if (commandsAfterFirst.includes('toggle-page-translation')) {
          throw new Error('Native command received, but page restore did not complete')
        }
        testInfo.skip(true, `Windows 原生快捷键未触发浏览器扩展命令: ${firstToggle.reason ?? 'unknown'}`)
        return
      }
      await expect(page.locator('#p1')).toHaveText(PHYSICS, { timeout: 5_000 })

      const secondToggle = await sendOwnedBrowserAltShortcut(
        page,
        'T',
        async () => (await page.locator('#p1').textContent()) === '中文译文',
      )
      expect(secondToggle.sent, secondToggle.reason).toBe(true)
      await expect(page.locator('#p1')).toHaveText('中文译文', { timeout: 10_000 })

      await dragText(page, '#p1')
      await expect(page.locator('.selection-toolbar')).toBeVisible({ timeout: 10_000 })
      const translateShortcut = await sendOwnedBrowserAltShortcut(
        page,
        'S',
        async () => (await page.locator('.panel-target').isVisible().catch(() => false)),
      )
      expect(translateShortcut.sent, translateShortcut.reason).toBe(true)
      await expect(page.locator('.panel-target')).toHaveText('中文译文', { timeout: 10_000 })
      await page.keyboard.press('Escape')
      await page.mouse.click(4, 4)
      const emptyShortcut = await sendOwnedBrowserAltShortcut(
        page,
        'S',
        async () => (await page.locator('.panel .panel-status').isVisible().catch(() => false)),
      )
      expect(emptyShortcut.sent, emptyShortcut.reason).toBe(true)
      await expect(page.locator('.panel .panel-status')).toHaveText('请先选中要翻译的文字', { timeout: 10_000 })
      const receivedCommands = await readNativeCommands()
      expect(receivedCommands).toEqual([
        'toggle-page-translation',
        'toggle-page-translation',
        'translate-selection',
        'translate-selection',
      ])
      await testInfo.attach('native-commands', {
        body: JSON.stringify(receivedCommands),
        contentType: 'application/json',
      })
    } finally {
      await context.close()
    }
  })

  test('原生右键：多行选区、跨源 iframe 与导航期间的文档校验', async () => {
    if (process.platform !== 'win32') {
      test.skip(true, `当前平台 (${process.platform}) 不支持 Windows 原生右键菜单测试`)
      return
    }
    const { context, extensionId } = await launch()
    try {
      const topUrl = `${readingUrl()}/manual-parent`
      const noiseAUrl = `${readingUrl()}/manual-noise-a`
      const noiseBUrl = `${readingUrl()}/manual-noise-b`
      await context.route(`${readingUrl()}/manual-*`, async (route) => {
        const url = route.request().url()
        if (url === noiseAUrl) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><body><p id="noise-a">Noise frame A paragraph.</p></body></html>',
          })
          return
        }
        if (url === noiseBUrl) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><body><p id="noise-b">Noise frame B paragraph.</p></body></html>',
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><head><title>PARENT_CONTEXT_MARKER</title></head><body style="margin:24px;font:24px/1.5 sans-serif"><div id="manual-source">First fixture line.<br>Second fixture line.</div><iframe id="noise" src="${noiseAUrl}" width="640" height="60"></iframe><iframe id="source-frame" src="https://manual-frame.fixture.test/a" width="700" height="130"></iframe></body></html>`,
        })
      })
      await context.route('https://manual-frame.fixture.test/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname
        if (pathname === '/a') {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><body style="margin:16px;font:24px/1.5 sans-serif"><div id="frame-source">Iframe fixture line one.<br>Iframe fixture line two.</div></body></html>',
          })
          return
        }
        if (pathname === '/b') {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><body style="margin:16px;font:24px/1.5 sans-serif"><div id="frame-source">Pending frame fixture.<br>Do not deliver a stale response.</div></body></html>',
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html><body><p id="replacement">Replacement frame paragraph.</p></body></html>',
        })
      })

      const options = await saveAndConnect(context, extensionId)
      await enableToolbarMode(options)
      await waitForSiteScriptRegistration(options, {
        url: topUrl,
        requiredMatches: ['http://*/*', 'https://*/*'],
        selectionToolbarEnabled: true,
      })
      const worker = context.serviceWorkers()[0]!
      await worker.evaluate(async () => {
        const { chrome } = globalThis as unknown as {
          chrome: { contextMenus: { update(id: string, props: { title: string }): Promise<void> | void } }
        }
        await chrome.contextMenus.update('wt-selection', { title: 'WT_MULTILINE_PROBE' })
      })

      const page = await context.newPage()
      await page.goto(topUrl)
      await waitForSiteContentReady(options, page, { supported: true })
      await expect(page.frameLocator('#noise').locator('#noise-a')).toBeVisible()
      await expect(page.frameLocator('#source-frame').locator('#frame-source')).toBeVisible()

      const selectAndRightClick = async (source: Locator, expected: string): Promise<void> => {
        await page.bringToFront()
        await source.scrollIntoViewIfNeeded()
        await source.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        const local = await source.evaluate((element) => {
          const range = element.ownerDocument.createRange()
          range.selectNodeContents(element)
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
          const first = rects[0]
          const last = rects.at(-1)
          if (first === undefined || last === undefined) throw new Error('Fixture text is not visible')
          const box = element.getBoundingClientRect()
          return {
            start: { x: first.left - box.left + 0.5, y: first.top - box.top + first.height / 2 },
            end: { x: last.right - box.left - 0.5, y: last.top - box.top + last.height / 2 },
          }
        })
        const box = await source.boundingBox()
        if (box === null) throw new Error('Fixture source is not visible')
        const start = { x: box.x + local.start.x, y: box.y + local.start.y }
        const end = { x: box.x + local.end.x, y: box.y + local.end.y }
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(end.x, end.y, { steps: 16 })
        await page.mouse.up()
        expect(await source.evaluate((el) => el.ownerDocument.getSelection()?.toString().trim())).toBe(expected)
        await page.mouse.click(start.x + 4, start.y, { button: 'right' })
        await invokeOwnedSelectionMenu(page)
      }

      const A = 'First fixture line.\nSecond fixture line.'
      api.hold(A)
      await selectAndRightClick(page.locator('#manual-source'), A)
      await expect
        .poll(() => api.calls.some((call) => call.kind === 'texts' && JSON.stringify(call.payload.texts) === JSON.stringify([A])))
        .toBe(true)
      await page.locator('#noise').evaluate((el, url) => {
        ;(el as HTMLIFrameElement).src = url
      }, noiseBUrl)
      await expect(page.frameLocator('#noise').locator('#noise-b')).toBeVisible()
      api.release(A)
      await expect(page.locator('.panel-target')).toHaveText('中文译文', { timeout: 15_000 })

      await page.keyboard.press('Escape')
      await expect(page.locator('.panel')).toBeHidden()
      const B = 'Iframe fixture line one.\nIframe fixture line two.'
      await selectAndRightClick(page.frameLocator('#source-frame').locator('#frame-source'), B)
      await expect(page.locator('.panel-target')).toHaveText('中文译文', { timeout: 15_000 })
      const callB = api.calls.findLast(
        (call) => call.kind === 'texts' && JSON.stringify(call.payload.texts) === JSON.stringify([B]),
      )
      expect(callB).toBeDefined()
      expect(callB!.payload.texts).toEqual([B])
      expect(callB!.payload.currentPage).toEqual({
        title: '',
        heading: '',
        site: 'manual-frame.fixture.test',
      })
      expect(callB!.payload.recentPages).toEqual([])
      expect(JSON.stringify(callB!.payload)).not.toContain('PARENT_CONTEXT_MARKER')

      await page.locator('.panel-close').click()
      await expect(page.locator('.panel')).toBeHidden()
      await page.locator('#source-frame').evaluate((el) => {
        ;(el as HTMLIFrameElement).src = 'https://manual-frame.fixture.test/b'
      })
      await expect(page.frameLocator('#source-frame').locator('#frame-source')).toHaveText(/Pending frame fixture\.\s*Do not deliver a stale response\./)
      const C = 'Pending frame fixture.\nDo not deliver a stale response.'
      api.hold(C)
      await selectAndRightClick(page.frameLocator('#source-frame').locator('#frame-source'), C)
      await expect
        .poll(() => api.calls.some((call) => call.kind === 'texts' && JSON.stringify(call.payload.texts) === JSON.stringify([C])))
        .toBe(true)
      await page.locator('#source-frame').evaluate((el) => {
        ;(el as HTMLIFrameElement).src = 'https://manual-frame.fixture.test/replacement'
      })
      await expect(page.frameLocator('#source-frame').locator('#replacement')).toBeVisible()
      api.release(C)
      await expect(page.locator('.panel .panel-status')).toHaveText('请重新选中文字，再通过右键菜单或快捷键翻译。', {
        timeout: 15_000,
      })
      await expect(page.locator('.panel-actions button')).toHaveCount(0)
      await expect(page.locator('.panel-target')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('设置页快捷键区块随界面语言更新，弹出页说明 GitHub 词典语言', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await openOptions(context, extensionId)
      const block = options.locator('[data-test="wt-shortcuts"]')
      await expect(block).toBeVisible()
      const rows = block.locator('li')
      await expect(rows).toHaveCount(3)
      await expect(rows.nth(0)).toContainText('翻译本页 / 恢复原文')
      await expect(rows.nth(1)).toContainText('翻译并替换输入')
      await expect(rows.nth(2)).toContainText('翻译选中文字')
      await expect(rows.nth(0).locator('kbd')).toHaveText(/^(Alt\+T|未设置)$/)
      await expect(rows.nth(1).locator('kbd')).toHaveText(/^(Alt\+Y|未设置)$/)
      await expect(rows.nth(2).locator('kbd')).toHaveText(/^(Alt\+S|未设置)$/)
      await expect(options.locator('[data-test="wt-shortcuts-manage"]')).toBeEnabled()
      await expect(options.getByText('用于模型翻译和各网站内置词典', { exact: false })).toBeVisible()
      await block.scrollIntoViewIfNeeded()
      await options.screenshot({ path: `${SCREENS}/options-shortcuts-zh.png` })
      const setLanguage = (language: string): Promise<void> =>
        options.evaluate(async (uiLanguage) => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          const stored = await chrome.storage.sync.get('settings')
          await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiLanguage } })
        }, language)
      await setLanguage('en')
      await expect(rows.nth(0)).toContainText('Translate page / show original')
      await expect(rows.nth(1)).toContainText('Translate and replace input')
      await expect(rows.nth(2)).toContainText('Translate selected text')
      await expect(options.getByText('Used by model translation and the built-in site dictionaries', { exact: false })).toBeVisible()
      await options.screenshot({ path: `${SCREENS}/options-shortcuts-en.png` })
      await setLanguage('zh-CN')
      await options.locator('[data-test="nav-github-title"]').click()
      const hint = options.locator('#page-language-hint')
      await expect(hint).toBeVisible()
      await expect(hint).toHaveText('仅决定 GitHub 内置词典用简体还是繁体；其他网站和模型翻译跟随「翻译目标语言」。')
      await expect(options.getByText('GitHub 词典语言', { exact: true })).toBeVisible()
      expect(await options.locator('[data-test="page-language"]').getAttribute('aria-describedby')).toBe('page-language-hint')
      const popup = await context.newPage()
      await popup.goto(`chrome-extension://${extensionId}/popup.html`)
      await expect(popup.locator('[data-test="settings"]')).toBeVisible()
      await expect(popup.locator('.popup-details')).toHaveCount(0)
      await expect(popup.locator('[data-test="repository"]')).toHaveCount(0)
      await expect(popup.getByText('GitHub 词典语言', { exact: true })).toHaveCount(0)
      await popup.screenshot({ path: `${SCREENS}/popup-language-hint-zh.png` })
    } finally {
      await context.close()
    }
  })

  test('窄屏 400×700 与 200% 缩放下悬浮入口与菜单不溢出', async () => {
    const { context, extensionId } = await launch()
    try {
      const options = await openOptions(context, extensionId)
      await enableFloating(options)
      await waitForRegistration(context, 'http://*/*')
      const page = await context.newPage()
      await page.setViewportSize({ width: 400, height: 700 })
      await page.goto(`${readingUrl()}/page`)
      await page.bringToFront()
      const entry = page.locator('.floating-entry')
      const menu = page.locator('.floating-menu')
      await expect(entry).toBeVisible({ timeout: 15_000 })
      // 关闭态的菜单必须真正不渲染：类选择器的 display 会盖过 [hidden]，曾在 400px 宽下挡住入口的点击
      expect(await menu.evaluate((el) => getComputedStyle(el).display)).toBe('none')
      await expect(page.locator('.floating-consent')).toHaveCount(0)
      // 浏览器缩放下 boundingBox 是视觉像素，与页面 CSS 像素的视口不可比：几何一律用 getBoundingClientRect
      const cssRect = (locator: Locator) =>
        locator.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })
      const inside = (box: { x: number; y: number; width: number; height: number }, w: number, h: number): boolean =>
        box.x >= 0 && box.y >= 0 && box.x + box.width <= w + 0.5 && box.y + box.height <= h + 0.5
      const check = async (label: string): Promise<void> => {
        const { w, h } = await cssViewport(page)
        // 半收起入口保持可点击；悬停展开后才检查整个入口在视口内。
        const initial = await cssRect(entry)
        await page.mouse.move(Math.min(w - 5, Math.max(5, initial.x + initial.width / 2)), initial.y + initial.height / 2)
        await expect.poll(async () => inside(await cssRect(entry), w, h), { timeout: 5_000, message: `${label} 入口在视口内` }).toBe(true)
        await entry.click()
        await expect(menu).toBeVisible({ timeout: 10_000 })
        await expect.poll(async () => inside(await cssRect(menu), w, h), { timeout: 5_000, message: `${label} 菜单在视口内` }).toBe(true)
        const mb = await cssRect(menu)
        expect(mb.width, label).toBeLessThanOrEqual(w - 24 + 0.5)
        expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), label).toBe(true)
        // 菜单压住入口时入口让位；空间够时保持可见
        const entryBox = await cssRect(entry)
        const overlaps = mb.x < entryBox.x + entryBox.width && mb.x + mb.width > entryBox.x && mb.y < entryBox.y + entryBox.height && mb.y + mb.height > entryBox.y
        expect(await entry.evaluate((el) => el.classList.contains('is-covered')), label).toBe(overlaps)
      }
      await check('400x700')
      await page.screenshot({ path: `${SCREENS}/floating-narrow-400.png` })
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      const tabId = await tabIdOf(context, page)
      await context.serviceWorkers()[0]!.evaluate(async (id) => {
        const { chrome } = globalThis as unknown as { chrome: { tabs: { setZoom(id: number, zoom: number): Promise<void> } } }
        await chrome.tabs.setZoom(id, 2)
      }, tabId)
      await expect.poll(() => page.evaluate(() => innerWidth), { timeout: 10_000 }).toBe(200)
      await check('400x700@200%')
      await page.screenshot({ path: `${SCREENS}/floating-narrow-400-zoom2.png` })
      await options.close()
      await page.bringToFront()
      if (await menu.isHidden()) await entry.click()
      await expect(menu).toBeVisible({ timeout: 10_000 })
      const settingsBtn = page.locator('.floating-settings')
      await settingsBtn.focus()
      await expect
        .poll(
          async () => {
            const menuBox = await cssRect(menu)
            const btnBox = await cssRect(settingsBtn)
            return (
              btnBox.x >= menuBox.x - 0.5 &&
              btnBox.y >= menuBox.y - 0.5 &&
              btnBox.x + btnBox.width <= menuBox.x + menuBox.width + 0.5 &&
              btnBox.y + btnBox.height <= menuBox.y + menuBox.height + 0.5
            )
          },
          { timeout: 5_000, message: '400x700@200% 设置按钮聚焦后完全在菜单可视区域内' },
        )
        .toBe(true)
      await settingsBtn.press('Enter')
      await expect.poll(() => context.pages().filter((p) => p.url().includes('options.html')).length, { timeout: 10_000 }).toBe(1)
      await expect(page.locator('.floating-error')).toBeHidden()
    } finally {
      await context.close()
    }
  })


  test('本地词表站点：六个新增站点不调用模型，热切语言和禁用后恢复', async () => {
    const { context, extensionId } = await launch()
    try {
      const SITES = [
        { id: 'openrouter', host: 'openrouter.ai', uniqueSource: 'API Keys', uniqueTarget: 'API 密钥' },
        { id: 'bolt', host: 'bolt.new', uniqueSource: 'Version history', uniqueTarget: '版本历史' },
        { id: 'lovable', host: 'lovable.dev', uniqueSource: 'Visual edits', uniqueTarget: '可视化编辑' },
        { id: 'netlify', host: 'app.netlify.com', uniqueSource: 'Deploy previews', uniqueTarget: '部署预览' },
        { id: 'railway', host: 'railway.com', uniqueSource: 'Shared Variables', uniqueTarget: '共享变量' },
        { id: 'render', host: 'dashboard.render.com', uniqueSource: 'Environment Groups', uniqueTarget: '环境组' },
      ] as const
      const siteHtml = (unique: string): string =>
        '<!doctype html><html><body><nav>' +
        '<button id="site-settings"><div><p>Settings</p></div></button>' +
        `<button id="site-unique"><div><p>${unique}</p></div></button>` +
        '<code id="site-code">Settings</code>' +
        '<input id="site-input" value="Settings">' +
        '<textarea id="site-textarea">Settings</textarea>' +
        '</nav></body></html>'
      for (const site of SITES) {
        await context.route(`https://${site.host}/**`, (route) =>
          route.fulfill({ contentType: 'text/html; charset=utf-8', body: siteHtml(site.uniqueSource) }),
        )
      }
      await context.route('https://gitlab.com/**', (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: siteHtml('Merge requests') }),
      )
      const options = await context.newPage()
      await options.goto(`chrome-extension://${extensionId}/options.html`)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:get-config' })
      })).toMatchObject({
        ok: true,
        config: { baseUrl: '', model: '', targetLanguage: 'zh-CN', autoOrigins: [] },
      })
      const requiredMatches = SITES.map((s) => `https://*.${s.host}/*`)
      await waitForSiteScriptRegistration(options, { requiredMatches })
      const matches = await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as {
          chrome: { scripting: { getRegisteredContentScripts(filter: { ids: string[] }): Promise<{ matches?: string[] }[]> } }
        }
        const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['wt-sites'] })
        return scripts.flatMap((s) => s.matches ?? [])
      })
      for (const pattern of requiredMatches) {
        expect(matches).toContain(pattern)
      }
      for (const excluded of [
        'gitlab.com', 'pypi.org', 'dash.cloudflare.com', 'notion.so', 'notion.site',
        'atlassian.net', 'slack.com', 'chatgpt.com', 'chat.openai.com', 'perplexity.ai',
        'x.com', 'twitter.com', 'reddit.com', 'linkedin.com', 'threads.net',
        'threads.com', 'discord.com', 'gemini.google.com',
        'stackoverflow.com',
        'netlify.app', 'onrender.com', 'railway.app', 'bolt.host', 'lovable.app',
      ]) {
        expect(matches.some((m) => m.includes(excluded))).toBe(false)
      }
      expect(matches).not.toContain('http://*/*')
      expect(matches).not.toContain('https://*/*')
      expect(matches).not.toContain('<all_urls>')
      const setConfig = (patch: Record<string, unknown>) => options.evaluate(async (p) => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:save-config', patch: p })
      }, patch)
      const pages = new Map<string, Page>()
      for (const site of SITES) {
        const page = await context.newPage()
        await page.goto(`https://${site.host}/`)
        await expect(page.locator('#site-settings')).toHaveText('设置', { timeout: 15_000 })
        await expect(page.locator('#site-unique')).toHaveText(site.uniqueTarget)
        await expect(page.locator('#site-code')).toHaveText('Settings')
        await expect(page.locator('#site-input')).toHaveValue('Settings')
        await expect(page.locator('#site-textarea')).toHaveValue('Settings')
        pages.set(site.id, page)
      }
      expect(api.calls.filter((call) => call.kind === 'texts')).toHaveLength(0)
      const openrouter = pages.get('openrouter')!
      // 真实 save-config 热切换：保持页面打开，不通过 reload 重建内容脚本。
      expect(await setConfig({ targetLanguage: 'ja' })).toMatchObject({
        ok: true,
        config: { baseUrl: '', model: '', targetLanguage: 'ja' },
      })
      await expect(openrouter.locator('#site-settings')).toHaveText('設定', { timeout: 15_000 })
      await expect(openrouter.locator('#site-code')).toHaveText('Settings')
      await expect(openrouter.locator('#site-input')).toHaveValue('Settings')
      await expect(openrouter.locator('#site-textarea')).toHaveValue('Settings')
      expect(await setConfig({ targetLanguage: 'zh-CN' })).toMatchObject({
        ok: true,
        config: { baseUrl: '', model: '', targetLanguage: 'zh-CN' },
      })
      await expect(openrouter.locator('#site-settings')).toHaveText('设置', { timeout: 15_000 })
      await expect(openrouter.locator('#site-unique')).toHaveText('API 密钥')
      // 禁用 openrouter 词典 → 恢复源文，其它站仍保持中文
      expect(await setConfig({ disabledDictionaries: ['openrouter'] })).toMatchObject({
        ok: true,
        config: { baseUrl: '', model: '', targetLanguage: 'zh-CN', disabledDictionaries: ['openrouter'] },
      })
      await expect(openrouter.locator('#site-settings')).toHaveText('Settings', { timeout: 15_000 })
      await expect(openrouter.locator('#site-unique')).toHaveText('API Keys')
      await expect(openrouter.locator('#site-code')).toHaveText('Settings')
      await expect(openrouter.locator('#site-input')).toHaveValue('Settings')
      await expect(openrouter.locator('#site-textarea')).toHaveValue('Settings')
      for (const site of SITES.filter((s) => s.id !== 'openrouter')) {
        const page = pages.get(site.id)!
        await expect(page.locator('#site-settings')).toHaveText('设置')
        await expect(page.locator('#site-unique')).toHaveText(site.uniqueTarget)
      }
      const gitlab = await context.newPage()
      await gitlab.goto('https://gitlab.com/')
      await expect(gitlab.locator('#site-settings')).toHaveText('Settings')
      expect(api.calls.filter((call) => call.kind === 'texts')).toHaveLength(0)
    } finally {
      await context.close()
    }
  })

  test('自定义 hostname 词典：真实授权保存后本地翻译，删除后原位恢复', async () => {
    const { context, extensionId } = await launch()
    try {
      await context.route('https://dictionary.fixture.test/**', (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body><nav><button id="custom-settings">Settings</button></nav><code>Settings</code></body></html>',
      }))
      const options = await context.newPage()
      await options.goto(`chrome-extension://${extensionId}/options.html`)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:get-config' })
      })).toMatchObject({ ok: true, config: { baseUrl: '', model: '', targetLanguage: 'zh-CN' } })
      await showOptionsSection(options, 'sites')
      await options.locator('[data-test="wt-dict-new"]').click()
      await options.locator('[data-test="wt-dict-name"]').fill('Synthetic custom')
      await options.locator('[data-test="wt-dict-hosts"]').fill('dictionary.fixture.test')
      await options.locator('[data-test="wt-dict-entries"]').fill('Settings = 自定义设置')
      await options.locator('[data-test="wt-dict-save"]').click()
      await acceptOwnedPermission(options, ['https://*.dictionary.fixture.test/*'])
      await expect(options.locator('[data-test="wt-dict-form"]')).toBeHidden()
      const row = options.locator('[data-test^="wt-custom-dict-"]', { hasText: 'Synthetic custom' })
      await expect(row).toBeVisible()
      const savedDictionaries = () => options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return (await chrome.storage.local.get('customDictionaries')).customDictionaries
      })
      await expect.poll(savedDictionaries).toEqual([expect.objectContaining({
        label: 'Synthetic custom',
        hosts: ['dictionary.fixture.test'],
        entries: { Settings: '自定义设置' },
        enabled: true,
      })])
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.permissions.contains({ origins: ['https://*.dictionary.fixture.test/*'] })
      })).toBe(true)
      const page = await context.newPage()
      await page.goto('https://dictionary.fixture.test/')
      await expect(page.locator('#custom-settings')).toHaveText('自定义设置', { timeout: 15_000 })
      await expect(page.locator('code')).toHaveText('Settings')
      await options.bringToFront()
      await row.locator('[data-test^="wt-dict-remove-"]').click()
      await expect(row).toHaveCount(0)
      await expect.poll(savedDictionaries).toEqual([])
      await page.bringToFront()
      await expect(page.locator('#custom-settings')).toHaveText('Settings', { timeout: 15_000 })
      await expect(page.locator('code')).toHaveText('Settings')
      expect(api.calls).toHaveLength(0)
    } finally {
      await context.close()
    }
  })

  test('行内 code：在途成员搬入 code 后旧结果不写入', async () => {
    const { context, extensionId } = await launch()
    const template = 'Unique lead <1>movable fragment</1> unique tail.'
    const nextTemplate = 'Unique lead <1></1> unique tail.'
    const callsFor = (text: string): MockCall[] => api.calls.filter((call) =>
      call.kind === 'texts' && (call.payload.texts as string[]).includes(text))
    let originalReleased = false
    try {
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body><p id="inline-target">Unique lead <span id="moving">movable fragment</span> unique tail.</p></body></html>',
      }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      const page = await context.newPage()
      api.hold(template)
      await page.goto('https://app.devin.ai/page')
      await expect.poll(() => callsFor(template).some((call) => call.respondedAt === undefined),
        { timeout: 15_000 }).toBe(true)
      const inFlight = callsFor(template)[0]!
      // 新快照的合法结果也先挂起，避免它覆盖旧回包造成的错误写入。
      api.hold(nextTemplate)
      // 在途期间把 <span> 的文本搬进 code —— 快照失效
      await page.evaluate(() => {
        const span = document.getElementById('moving')!
        const moved = span.firstChild as Text
        const code = document.createElement('code')
        code.id = 'protected'
        code.appendChild(moved)
        document.getElementById('inline-target')!.after(code)
      })
      api.release(template)
      originalReleased = true
      await expect.poll(() => inFlight.respondedAt, { timeout: 15_000 }).toBeDefined()
      await expect.poll(() => callsFor(nextTemplate).some((call) => call.respondedAt === undefined),
        { timeout: 15_000 }).toBe(true)
      // 此时只允许旧回包完成，新快照仍在途；不要求释放新快照后安全片段永远无中文。
      await expect(page.locator('#protected')).toHaveText('movable fragment')
      await expect(page.locator('#moving')).toHaveText('')
      await expect(page.locator('#inline-target')).not.toContainText('中文译文')
      expect(callsFor(template)).toHaveLength(1)
    } finally {
      try {
        if (!originalReleased && callsFor(template).length > 0) api.release(template)
        if (callsFor(nextTemplate).length > 0) api.release(nextTemplate)
      } finally {
        await context.close()
      }
    }
  })

  test('shadow 恢复：restore → start → shadow 新增 p 重新翻译', async () => {
    const { context, extensionId } = await launch()
    try {
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      const page = await context.newPage()
      await page.goto('https://app.devin.ai/page')
      const shadowText = () => page.evaluate(() =>
        document.getElementById('shadow-host')?.shadowRoot?.querySelector('#shadow-p')?.textContent)
      await expect.poll(shadowText, { timeout: 15_000 }).toBe('中文译文')
      // 恢复 → 原文还原
      await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: { storage: { sync: { set(i: Record<string, unknown>): Promise<void> } } } }
        await chrome.storage.sync.set({ settings: { enabled: false } })
      })
      await expect.poll(shadowText, { timeout: 15_000 }).toBe('Shadow DOM paragraph to translate.')
      // 重启 → 重新翻译
      await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: { storage: { sync: { set(i: Record<string, unknown>): Promise<void> } } } }
        await chrome.storage.sync.set({ settings: { enabled: true } })
      })
      await expect.poll(shadowText, { timeout: 15_000 }).toBe('中文译文')
      // shadow 内新增 p → 产生新请求
      const callsBefore = api.calls.length
      await page.evaluate(() => {
        const p = document.createElement('p')
        p.id = 'shadow-p2'
        p.textContent = 'Newly added shadow paragraph.'
        document.getElementById('shadow-host')!.shadowRoot!.appendChild(p)
      })
      await expect.poll(() =>
        api.calls.slice(callsBefore).some((c) => ((c.payload.texts as string[] | undefined) ?? []).some((t) => t.includes('Newly added shadow paragraph'))),
        { timeout: 15_000 }).toBe(true)
      await expect.poll(() => page.evaluate(() =>
        document.getElementById('shadow-host')?.shadowRoot?.querySelector('#shadow-p2')?.textContent),
        { timeout: 15_000 }).toBe('中文译文')
    } finally {
      await context.close()
    }
  })

  test('open shadow DOM 内段落被扫描并原处替换', async () => {
    const { context, extensionId } = await launch()
    try {
      await context.route('https://app.devin.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
      const options = await saveAndConnect(context, extensionId)
      await enableSelection(options)
      expect(await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        return chrome.runtime.sendMessage({ type: 'wt:set-site-auto', origin: 'https://app.devin.ai', enabled: true })
      })).toMatchObject({ ok: true })
      const page = await context.newPage()
      await page.goto('https://app.devin.ai/page')
      const shadowText = () => page.evaluate(() =>
        document.getElementById('shadow-host')?.shadowRoot?.querySelector('#shadow-p')?.textContent)
      await expect.poll(shadowText, { timeout: 15_000 }).toBe('中文译文')
      expect(api.calls.flatMap((call) => call.payload.texts ?? [])).toContain('Shadow DOM paragraph to translate.')
    } finally {
      await context.close()
    }
  })

  async function saveAdvancedDraft(options: Page): Promise<void> {
    const before = api.calls.filter((call) => call.kind === 'other').length
    await options.locator('[data-test="wt-save"]').click()
    await acceptOwnedPermission(options, ['http://127.0.0.1/*'])
    await expect.poll(() => api.calls.filter((call) => call.kind === 'other').length).toBe(before + 1)
    await expect(options.locator('[data-test="wt-save"]')).toBeEnabled()
    await expect(options.getByText(/connection succeeded|连接成功/)).toBeVisible()
  }

  function expectAdvancedWire(
    call: MockCall | undefined,
    apiType: 'chat-completions' | 'responses',
    temperature: number,
    params: Record<string, unknown>,
    header: string | undefined,
  ): void {
    expect(call).toBeDefined()
    expect(call!.path).toBe(apiType === 'responses' ? '/v1/responses' : '/v1/chat/completions')
    expect(call!.auth).toBeUndefined()
    expect(call!.customHeader).toBe(header)
    expect(call!.requestBody).toMatchObject({
      model: 'mock-model',
      temperature,
      stream: false,
      ...params,
    })
    if (apiType === 'responses') {
      expect(call!.requestBody.store).toBe(false)
      expect(call!.requestBody.instructions).toEqual(expect.any(String))
      expect(call!.requestBody.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: expect.any(String) }] },
      ])
      expect(call!.requestBody).not.toHaveProperty('messages')
    } else {
      expect(call!.requestBody).not.toHaveProperty('store')
      expect(call!.requestBody.messages).toEqual([
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: expect.any(String) },
      ])
      expect(call!.requestBody).not.toHaveProperty('instructions')
      expect(call!.requestBody).not.toHaveProperty('input')
    }
  }

  for (const entry of [
    { apiType: 'chat-completions', label: '自定义 Chat Completions', params: { reasoning_effort: 'medium' } },
    { apiType: 'responses', label: '自定义 Responses', params: { reasoning: { effort: 'medium' } } },
  ] as const) {
    test(`自定义接口高级设置：${entry.apiType}`, async () => {
      const { context, extensionId } = await launch()
      try {
        const options = await openOptions(context, extensionId)
        await showOptionsSection(options, 'model')
        const advanced = options.locator('[data-test="wt-advanced"]')
        await expect(advanced).not.toHaveAttribute('open', '')
        await options.locator('[data-test="wt-api-type"]').click()
        await options.getByRole('option', { name: entry.label, exact: true }).click()
        await options.getByPlaceholder(/api\.example\.com|v1/).fill(api.url)
        await options.locator('[data-test="wt-model-input"]').fill('mock-model')
        await advanced.locator('summary').click()
        const temperatureInput = options.locator('[data-test=wt-temperature]')
        await temperatureInput.fill('')
        await temperatureInput.pressSequentially('0.05')
        await expect(temperatureInput).toHaveValue('0.05')
        await options.locator('[data-test="wt-temperature"]').fill('0')
        await options.locator('[data-test="wt-custom-headers"]').fill(
          JSON.stringify({
            'X-Fixture-Token': 'synthetic-header-credential',
          }),
        )
        if (entry.apiType === 'chat-completions') {
          await options.locator('[data-test="wt-request-params"]').fill('{broken')
          await options.locator('[data-test="wt-save"]').click()
          await expect(
            options.getByText(/附加参数须为有效 JSON 对象|Parameters must be a valid JSON object/),
          ).toBeVisible()
          await expect(options.locator('[data-test="wt-request-params"]')).toHaveValue('{broken')
          await expect(advanced).toHaveAttribute('open', '')
          expect(api.calls).toHaveLength(0)
          expect(
            await options.evaluate(async () => {
              const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
              return chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })
            }),
          ).toBe(false)
        }
        await options.locator('[data-test="wt-request-params"]').fill(JSON.stringify(entry.params))
        await saveAdvancedDraft(options)
        expectAdvancedWire(api.calls.at(-1), entry.apiType, 0, entry.params, 'synthetic-header-credential')

        const storedConfig = await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return (await chrome.storage.local.get('translationConfig')).translationConfig as
            | Record<string, unknown>
            | undefined
        })
        expect(storedConfig).toMatchObject({
          apiType: entry.apiType,
          temperature: 0,
          requestParams: entry.params,
        })
        expect(typeof storedConfig?.customHeadersRevision).toBe('string')
        expect(storedConfig?.customHeadersRevision).not.toBe('')
        expect(JSON.stringify(storedConfig)).not.toContain('synthetic-header-credential')
        expect(storedConfig).not.toHaveProperty('customHeaders')

        await options.reload()
        await expect(options.locator('[data-test="wt-save"]')).toBeEnabled()
        await expect(advanced).not.toHaveAttribute('open', '')
        await expect(options.locator('[data-test="wt-api-type"]')).toContainText(entry.label)
        await advanced.locator('summary').click()
        await expect(options.locator('[data-test="wt-temperature"]')).toHaveValue('0')
        expect(JSON.parse(await options.locator('[data-test="wt-request-params"]').inputValue())).toEqual(entry.params)
        await expect(options.locator('[data-test="wt-custom-headers"]')).toHaveValue('')
        await expect(
          options.getByText(/已保存请求头|Headers are saved/),
        ).toBeVisible()

        await enableSelection(options)
        await waitForRegistration(context, 'http://*/*')
        const page = await context.newPage()
        await page.goto(`${readingUrl()}/page`)
        await waitForSiteScript(context, page)
        const assistBefore1 = api.calls.filter((call) => call.kind === 'assist').length
        await dragText(page, '#p1')
        await expect(page.locator('.panel-target')).toHaveText('量子退相干')
        const assistCalls1 = api.calls.filter((call) => call.kind === 'assist')
        expect(assistCalls1).toHaveLength(assistBefore1 + 1)
        expectAdvancedWire(assistCalls1.at(-1), entry.apiType, 0, entry.params, 'synthetic-header-credential')
        await page.keyboard.press('Escape')

        await options.bringToFront()
        await showOptionsSection(options, 'model')
        if ((await advanced.getAttribute('open')) === null) {
          await advanced.locator('summary').click()
        }
        await options.locator('[data-test="wt-temperature"]').fill('0.6')
        await options.locator('[data-test="wt-custom-headers"]').fill('')
        await saveAdvancedDraft(options)

        await dragText(page, '#p1')
        await expect(page.locator('.panel-target')).toHaveText('量子退相干')
        const assistCalls2 = api.calls.filter((call) => call.kind === 'assist')
        expect(assistCalls2).toHaveLength(assistBefore1 + 2)
        expectAdvancedWire(assistCalls2.at(-1), entry.apiType, 0.6, entry.params, 'synthetic-header-credential')

        await options.bringToFront()
        await showOptionsSection(options, 'model')
        if ((await advanced.getAttribute('open')) === null) {
          await advanced.locator('summary').click()
        }
        await options.locator('[data-test="wt-custom-headers"]').fill('{}')
        await saveAdvancedDraft(options)
        expectAdvancedWire(api.calls.at(-1), entry.apiType, 0.6, entry.params, undefined)
        const clearedConfig = await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return (await chrome.storage.local.get('translationConfig')).translationConfig as
            | { customHeadersRevision?: string }
            | undefined
        })
        expect(clearedConfig?.customHeadersRevision).toBe('')
      } finally {
        await context.close()
      }
    })
  }

  test('自定义接口高级设置：两套主题与窄屏', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await showOptionsSection(options, 'general')
      await expect(options.locator('[data-test="wt-source-language"]')).toHaveAccessibleName(zhCN.wtSourceLanguage)
      await expect(options.locator('[data-test="wt-target-language"]')).toHaveAccessibleName(zhCN.wtTargetLanguage)
      await expect(options.locator('[data-test="wt-assist-mode"]')).toHaveAccessibleName(zhCN.wtAssistMode)
      await showOptionsSection(options, 'model')
      const advanced = options.locator('[data-test="wt-advanced"]')
      const summary = advanced.locator('summary')
      const paramsArea = options.locator('[data-test="wt-request-params"]')
      const headersArea = options.locator('[data-test="wt-custom-headers"]')
      await options.getByRole('combobox', { name: zhCN.wtApiType, exact: true }).click()
      await expect(options.getByRole('listbox')).toHaveAccessibleName(zhCN.wtApiType)
      await options.getByRole('option', { name: '自定义 Responses', exact: true }).click()
      await summary.click()
      await expect(options.getByPlaceholder('https://api.example.com/v1')).toHaveAccessibleName(zhCN.wtBaseUrl)
      await expect(options.locator('input[type="password"]')).toHaveAccessibleName('API Key')
      await expect(options.locator('[data-test="wt-temperature"]')).toHaveAccessibleName(zhCN.wtTemperature)
      await expect(options.locator('[data-test="wt-temperature"]')).toHaveAccessibleDescription(zhCN.wtTemperatureHint)
      await expect(paramsArea).toHaveAccessibleName(zhCN.wtRequestParams)
      await expect(paramsArea).toHaveAccessibleDescription(zhCN.wtRequestParamsHint)
      await expect(headersArea).toHaveAccessibleName(zhCN.wtCustomHeaders)
      await options.locator('[data-test="wt-temperature"]').fill('0.2')
      await paramsArea.fill('{\n  "reasoning": {\n    "effort": "medium"\n  }\n}')
      await headersArea.fill('{\n  "X-Fixture-Token": "synthetic-header-credential"\n}')

      const tabId = await tabIdOf(context, options)
      const setZoom = async (zoom: number): Promise<void> => {
        await context.serviceWorkers()[0]!.evaluate(
          async ({ id, factor }) => {
            const { chrome } = globalThis as unknown as {
              chrome: { tabs: { setZoom(id: number, zoom: number): Promise<void> } }
            }
            await chrome.tabs.setZoom(id, factor)
          },
          { id: tabId, factor: zoom },
        )
      }
      const assertHorizontalBounds = async (): Promise<void> => {
        await advanced.scrollIntoViewIfNeeded()
        const metrics = await options.evaluate(() => {
          const doc = document.documentElement
          const areas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.wt-code-textarea'))
          return {
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
            innerWidth: window.innerWidth,
            rects: areas.map((el) => {
              const r = el.getBoundingClientRect()
              return { left: r.left, right: r.right }
            }),
          }
        })
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
        expect(metrics.rects).toHaveLength(2)
        for (const rect of metrics.rects) {
          expect(rect.left).toBeGreaterThanOrEqual(0)
          expect(rect.right).toBeLessThanOrEqual(metrics.innerWidth + 1)
        }
      }

      for (const style of ['cyber', 'glass'] as const) {
        await setUiStyle(options, style)
        await expect(options.locator('html')).toHaveAttribute('data-style', style)
        await setZoom(1)
        await options.setViewportSize({ width: 1280, height: 900 })
        await expect.poll(() => options.evaluate(() => innerWidth)).toBe(1280)
        if ((await advanced.getAttribute('open')) !== null) {
          await summary.click()
        }
        await expect(advanced).not.toHaveAttribute('open', '')
        await options.screenshot({ path: testInfo.outputPath(`wt-advanced-${style}-collapsed.png`) })

        await summary.focus()
        await options.keyboard.press('Enter')
        await expect(advanced).toHaveAttribute('open', '')
        await expect(paramsArea).toBeVisible()
        await expect(headersArea).toBeVisible()
        await advanced.screenshot({ path: testInfo.outputPath(`wt-advanced-${style}-expanded.png`) })

        await options.setViewportSize({ width: 400, height: 700 })
        await expect.poll(() => options.evaluate(() => innerWidth)).toBe(400)
        await assertHorizontalBounds()
        await options.screenshot({ path: testInfo.outputPath(`wt-advanced-${style}-narrow-400.png`) })

        await options.setViewportSize({ width: 1280, height: 900 })
        await setZoom(2)
        await expect.poll(() => options.evaluate(() => innerWidth), { timeout: 10_000 }).toBe(640)
        await assertHorizontalBounds()
        for (const { previous, field } of [
          { previous: options.locator('[data-test="wt-temperature"]'), field: paramsArea },
          { previous: paramsArea, field: headersArea },
        ]) {
          await previous.focus()
          expect(await previous.evaluate((el) => document.activeElement === el)).toBe(true)
          // 首行露出但控件底部越界，分别验证两处真实 Tab 入口。
          await field.evaluate((el) => {
            const textarea = el as HTMLTextAreaElement
            textarea.setSelectionRange(0, 0)
            scrollBy({ top: textarea.getBoundingClientRect().top - (innerHeight - 32), behavior: 'instant' })
          })
          const clipped = await field.evaluate((el) => ({
            bottom: el.getBoundingClientRect().bottom, height: innerHeight,
          }))
          expect(clipped.bottom).toBeGreaterThan(clipped.height)
          await options.keyboard.press('Tab')
          expect(await field.evaluate((el) => document.activeElement === el)).toBe(true)
          const focusedBounds = await field.evaluate((el) => {
            const rect = el.getBoundingClientRect()
            return { top: rect.top, bottom: rect.bottom, height: innerHeight }
          })
          expect(focusedBounds.top).toBeGreaterThanOrEqual(0)
          expect(focusedBounds.bottom).toBeLessThanOrEqual(focusedBounds.height + 1)
        }
        // 原生缩放时不传截图裁剪坐标，直接捕获当前视口。
        const cdp = await context.newCDPSession(options)
        try {
          const image = await cdp.send('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false, fromSurface: true,
          })
          await writeFile(testInfo.outputPath(`wt-advanced-${style}-zoom-200.png`), Buffer.from(image.data, 'base64'))
        } finally {
          await cdp.detach()
        }
        await setZoom(1)
      }
    } finally {
      await context.close()
    }
  })

  test('入口改进：模型候选双主题、窄屏和200%缩放', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const options = await saveAndConnect(context, extensionId)
      await showOptionsSection(options, 'model')
      const model = options.locator('[data-test="wt-model-input"]')
      const fetch = options.locator('[data-test="wt-fetch-models"]')
      const menu = options.locator('[data-test="wt-model-menu"]')
      const choices = options.locator('[data-test="wt-model-options"] [role="option"]')
      await fetch.click()
      await expect(menu).toBeVisible()

      const tabId = await tabIdOf(context, options)
      const setZoom = async (zoom: number): Promise<void> => {
        await context.serviceWorkers()[0]!.evaluate(
          async ({ id, factor }) => {
            const { chrome } = globalThis as unknown as {
              chrome: { tabs: { setZoom(id: number, zoom: number): Promise<void> } }
            }
            await chrome.tabs.setZoom(id, factor)
          },
          { id: tabId, factor: zoom },
        )
      }

      const cdp = await context.newCDPSession(options)
      try {
        for (const style of ['cyber', 'glass'] as const) {
          await setUiStyle(options, style)
          await expect(options.locator('html')).toHaveAttribute('data-style', style)
          for (const variant of [
            { width: 1280, height: 900, zoom: 1 },
            { width: 400, height: 800, zoom: 1 },
            { width: 1280, height: 900, zoom: 2 },
          ] as const) {
            await setZoom(1)
            await options.setViewportSize({ width: variant.width, height: variant.height })
            await setZoom(variant.zoom)
            await expect
              .poll(() => options.evaluate(() => ({ width: innerWidth, height: innerHeight })), { timeout: 10_000 })
              .toEqual({
                width: Math.round(variant.width / variant.zoom),
                height: Math.round(variant.height / variant.zoom),
              })

            if ((await model.getAttribute('aria-expanded')) === 'true') await model.press('Escape')
            await menu.click()
            await expect(choices).toHaveCount(2)
            const metrics = await options.evaluate(() => {
              const popover = document.querySelector<HTMLElement>('.model-popover')
              if (popover === null) throw new Error('Missing .model-popover')
              const rect = popover.getBoundingClientRect()
              return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
              }
            })
            expect(metrics.left).toBeGreaterThanOrEqual(-1)
            expect(metrics.top).toBeGreaterThanOrEqual(-1)
            expect(metrics.right).toBeLessThanOrEqual(metrics.innerWidth + 1)
            expect(metrics.bottom).toBeLessThanOrEqual(metrics.innerHeight + 1)
            expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)

            await choices.filter({ hasText: /^fixture-model-b$/ }).click()
            await expect(model).toHaveValue('fixture-model-b')
            await model.fill('fixture-model-')
            await model.press('ArrowDown')
            await model.press('Enter')
            await expect(model).toHaveValue('fixture-model-a')
            if ((await model.getAttribute('aria-expanded')) === 'true') await model.press('Escape')
            await menu.click()
            await expect(choices).toHaveCount(2)

            const image = await cdp.send('Page.captureScreenshot', {
              format: 'png',
              captureBeyondViewport: false,
            })
            await writeFile(
              testInfo.outputPath(`model-${style}-${variant.width}-zoom-${variant.zoom}.png`),
              Buffer.from(image.data, 'base64'),
            )
          }
        }
        await setZoom(1)
      } finally {
        await cdp.detach()
      }
    } finally {
      await context.close()
    }
  })

  test('词典分类界面：两套主题与窄屏', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const options = await context.newPage()
      await options.goto(`chrome-extension://${extensionId}/options.html`)
      await showOptionsSection(options, 'sites')
      for (const category of ['ai-code', 'ai-model', 'cloud', 'code', 'design', 'community'] as const) {
        await expect(options.locator(`[data-test="wt-dict-group-${category}"]`)).toBeVisible()
      }
      await expect(options.locator('.wt-builtin-card')).toHaveCount(26)
      for (const retiredId of ['gitlab', 'reddit', 'chatgpt', 'pypi', 'cloudflare', 'notion', 'jira', 'slack', 'perplexity', 'x', 'linkedin', 'threads', 'discord']) {
        await expect(options.locator(`[data-test="wt-dict-${retiredId}"]`)).toHaveCount(0)
      }
      for (const style of ['cyber', 'glass'] as const) {
        await options.evaluate(async (nextStyle) => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          const stored = await chrome.storage.sync.get('settings')
          const old = (stored.settings as Record<string, unknown> | undefined) ?? {}
          await chrome.storage.sync.set({
            settings: { ...old, uiLanguage: 'zh-CN', uiStyle: nextStyle, theme: 'light' },
          })
        }, style)
        await expect(options.locator('html')).toHaveAttribute('data-style', style)
        for (const width of [1280, 400] as const) {
          await options.setViewportSize({ width, height: 800 })
          await expect.poll(() => options.evaluate(() => window.innerWidth)).toBe(width)
          const metrics = await options.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))
          expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
          await options.screenshot({ path: testInfo.outputPath(`wt-dict-${style}-${width}.png`) })
        }
      }
      const openrouterSwitch = options.locator('[data-test="wt-dict-openrouter"] [role="switch"]')
      await expect(openrouterSwitch).toBeEnabled()
      await expect(openrouterSwitch).toHaveAttribute('aria-checked', 'true')
      await openrouterSwitch.focus()
      await openrouterSwitch.press('Space')
      await expect(openrouterSwitch).toHaveAttribute('aria-checked', 'false')
      await expect(openrouterSwitch).toBeEnabled()
      const getDisabled = () => options.evaluate(async () => {
        const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
        const reply = await chrome.runtime.sendMessage({ type: 'wt:get-config' }) as {
          config?: { disabledDictionaries?: string[] }
        }
        return reply.config?.disabledDictionaries ?? []
      })
      expect(await getDisabled()).toContain('openrouter')
      await openrouterSwitch.focus()
      await openrouterSwitch.press('Space')
      await expect(openrouterSwitch).toHaveAttribute('aria-checked', 'true')
      await expect(openrouterSwitch).toBeEnabled()
      expect(await getDisabled()).not.toContain('openrouter')
      expect(api.calls).toHaveLength(0)
    } finally {
      await context.close()
    }
  })

  async function enableRealtimeFeature(options: Page, feature: 'input' | 'video'): Promise<void> {
    await showOptionsSection(options, 'general')
    const selector = feature === 'input' ? 'wt-input-translation-toggle' : 'wt-video-subtitles-toggle'
    const toggle = options.locator(`[data-test="${selector}"] [role="switch"]`)
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toBeEnabled()
  }

  test('实时功能扩展链路：输入开关注入已打开页面，草稿英文预览确认替换还原与关闭取消', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      const targetUrl = 'https://chat.fixture.test/chat'
      await context.route(targetUrl, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body style="margin:24px">
                <p id="history">CHAT_HISTORY_SENTINEL</p>
                <form id="chat-form" style="display:flex;flex-direction:column;gap:140px;margin-bottom:200px">
                  <textarea id="draft" rows="4" style="width:360px;height:84px"></textarea>
                  <div id="plain" contenteditable="true" style="width:360px;min-height:64px;border:1px solid #999"></div>
                </form>
                <input id="pwd" type="password" style="width:240px">
                <script>
                  window.__submittedCount = 0;
                  window.__navCounter = (window.__navCounter || 0) + 1;
                  document.getElementById('chat-form').addEventListener('submit', (e) => {
                    e.preventDefault();
                    window.__submittedCount += 1;
                  });
                </script>
              </body>
            </html>`,
        }),
      )

      const options = await saveAndConnect(context, extensionId)
      api.setTextTranslator((t) =>
        t === '请检查这段代码'
          ? 'Please review this code.'
          : t === '你好\n世界'
            ? 'Hello\nworld'
            : `English: ${t}`,
      )

      const page = await context.newPage()
      let navigations = 0
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations += 1
      })
      await page.goto(targetUrl)
      expect(navigations).toBe(1)
      await page.evaluate(() => {
        ;(window as unknown as { __aliveMarker?: string }).__aliveMarker = 'stay-on-page'
      })

      const callsBeforeEnable = api.calls.length
      const draft = page.locator('#draft')
      await draft.click()
      await draft.fill('你好\n世界')
      await page.waitForTimeout(800)
      expect(api.calls).toHaveLength(callsBeforeEnable)
      await inspectClosedShadowPage(page)
      await expect(page.locator('[data-wt-root] .popover [role="status"]')).toHaveCount(0)

      await options.bringToFront()
      await enableRealtimeFeature(options, 'input')
      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { floatingButtonEnabled: false },
          })
        }),
      ).toMatchObject({
        ok: true,
        config: {
          targetLanguage: 'zh-CN',
          sourceLanguage: 'auto',
          autoOrigins: [],
          inputTranslationEnabled: true,
        },
      })
      await waitForSiteScriptRegistration(options, { url: targetUrl })
      await waitForSiteContentReady(options, page, { supported: true })
      expect(navigations).toBe(1)
      expect(await page.evaluate(() => (window as unknown as { __aliveMarker?: string }).__aliveMarker)).toBe('stay-on-page')

      await page.bringToFront()
      const callsBeforeDraft = api.calls.length
      await draft.click()
      await draft.fill('请检查这段代码')

      const popover = page.locator('[data-wt-root] .popover')
      const status = popover.locator('[role="status"]')
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        })
        .toBe('Please review this code.')

      await expect(draft).toHaveValue('请检查这段代码')
      expect(await page.evaluate(() => (window as unknown as { __submittedCount: number }).__submittedCount)).toBe(0)

      const draftCalls = api.calls.slice(callsBeforeDraft).filter((call) => call.kind === 'texts')
      expect(draftCalls).toHaveLength(1)
      const draftCall = draftCalls[0]!
      expect(draftCall.payload).toEqual({ texts: ['请检查这段代码'] })
      expect(JSON.stringify(draftCall.requestBody)).not.toContain('CHAT_HISTORY_SENTINEL')
      const sysPrompt = (draftCall.requestBody.messages as Array<{ content: string }>)[0]?.content ?? ''
      expect(sysPrompt).toContain('into natural, accurate English')

      await popover.locator('button[data-action="replace"]').click()
      await expect(draft).toHaveValue('Please review this code.')
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft')
      expect(await page.evaluate(() => (window as unknown as { __submittedCount: number }).__submittedCount)).toBe(0)

      await inspectClosedShadowPage(page)
      await popover.locator('button[data-action="restore"]').click()
      await expect(draft).toHaveValue('请检查这段代码')
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft')
      expect(await page.evaluate(() => (window as unknown as { __submittedCount: number }).__submittedCount)).toBe(0)

      const plain = page.locator('#plain')
      await plain.click()
      await page.evaluate(() => {
        document.getElementById('plain')!.innerHTML = '<div>你好</div><div>世界</div>'
      })
      await page.keyboard.insertText('！')
      await page.keyboard.press('Backspace')

      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        })
        .toBe('Hello\nworld')

      await popover.locator('button[data-action="replace"]').click()
      expect(await plain.evaluate((el) => el.innerHTML)).toBe('Hello<br>world')
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('plain')

      await inspectClosedShadowPage(page)
      await popover.locator('button[data-action="restore"]').click()
      expect(await plain.evaluate((el) => el.innerHTML)).toBe('你好<br>世界')
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('plain')

      const callsBeforePassword = api.calls.length
      await page.locator('#pwd').click()
      await page.locator('#pwd').fill('密码中文测试')
      await page.waitForTimeout(800)
      expect(api.calls).toHaveLength(callsBeforePassword)

      await draft.click()
      await draft.fill('请检查这段代码')
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        })
        .toBe('Please review this code.')
      await page.screenshot({ path: testInfo.outputPath('input-extension-preview.png') })

      const heldDraft = '关闭功能前的草稿'
      api.hold(heldDraft)
      await draft.click()
      await draft.fill(heldDraft)
      await expect
        .poll(() =>
          api.calls.some(
            (call) => call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes(heldDraft),
          ),
        )
        .toBe(true)
      const heldCall = api.calls.findLast(
        (call) => call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes(heldDraft),
      )!

      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { inputTranslationEnabled: false },
          })
        }),
      ).toMatchObject({ ok: true, config: { inputTranslationEnabled: false } })

      await expect.poll(() => heldCall.aborted).toBe(true)
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return status.count()
        })
        .toBe(0)

      api.release(heldDraft)
      await page.waitForTimeout(200)
      await inspectClosedShadowPage(page)
      await expect(status).toHaveCount(0)

      const callsAfterDisable = api.calls.length
      await draft.click()
      await draft.fill('禁用后的新中文草稿')
      await page.waitForTimeout(800)
      expect(api.calls).toHaveLength(callsAfterDisable)
      await inspectClosedShadowPage(page)
      await expect(status).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('Discord Slate 输入预览替换与 CDP 合成边界', async () => {
    const testInfo = test.info()
    const bundle = await bundleDiscordSlateFixture()
    const { context, extensionId } = await launch()
    const targetUrl = 'https://discord.com/channels/@me/fixture'
    const scriptUrl = 'https://discord.com/wt-slate-fixture.js'
    await context.route('https://discord.com/**', async (route) => {
      const url = route.request().url().split('?')[0] ?? ''
      if (url === targetUrl) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:24px"><div id="root"></div><script src="${scriptUrl}"></script></body></html>`,
        })
        return
      }
      if (url === scriptUrl) {
        await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle })
        return
      }
      await route.abort()
    })
    try {
      const options = await saveAndConnect(context, extensionId)
      api.setTextTranslator((text) => {
        if (text === '水水水水水水') return 'water water water water water water'
        if (text === '第一行\n\n第三行') return 'Line one\n\nLine three'
        if (text === '提交的中文') return 'Committed Chinese'
        return `EN:${text}`
      })
      await enableRealtimeFeature(options, 'input')
      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { floatingButtonEnabled: false },
          })
        }),
      ).toMatchObject({ ok: true, config: { inputTranslationEnabled: true } })

      const page = await context.newPage()
      await page.goto(targetUrl)
      await waitForSiteScriptRegistration(options, { url: targetUrl })
      await waitForSiteContentReady(options, page, { supported: true })
      const editor = page.locator('#discord-editor')
      await expect(editor).toHaveAttribute('data-slate-editor', 'true')
      const readDraft = (): Promise<string> => page.evaluate(() => {
        const root = document.querySelector('[data-slate-editor="true"]')
        if (!(root instanceof HTMLElement)) return ''
        const readNode = (node: Node): string => {
          if (node instanceof Element && (node.hasAttribute('data-slate-zero-width') || node.hasAttribute('data-slate-placeholder'))) return ''
          if (node instanceof Text) return node.data
          if (node instanceof Element && node.tagName === 'BR') return '\n'
          let text = ''
          for (const child of node.childNodes) text += readNode(child)
          return text
        }
        const blocks = [...root.children].filter((child) => child.getAttribute('data-slate-node') === 'element')
        return blocks.length === 0 ? readNode(root) : blocks.map((block) => readNode(block)).join('\n')
      })
      const readModel = (): Promise<string> => page.evaluate(() => (window as unknown as { __discordModelText?: string }).__discordModelText ?? '')
      const readSent = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __sentDrafts?: string[] }).__sentDrafts ?? [])

      const callsBeforeDraft = api.calls.length
      await editor.click()
      await page.keyboard.type('水水水水水水')
      const popover = page.locator('[data-wt-root] .popover')
      const status = popover.locator('[role="status"]')
      await expect.poll(async () => {
        await inspectClosedShadowPage(page)
        return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
      }).toBe('water water water water water water')
      expect(await readDraft()).toBe('水水水水水水')
      expect(await readModel()).toBe('水水水水水水')
      const draftCalls = api.calls.slice(callsBeforeDraft).filter((call) => call.kind === 'texts')
      expect(draftCalls).toHaveLength(1)
      expect(draftCalls[0]?.payload).toEqual({ texts: ['水水水水水水'] })
      expect(JSON.stringify(draftCalls[0]?.requestBody)).not.toContain('CHAT_HISTORY_SENTINEL')
      await page.screenshot({ path: testInfo.outputPath('discord-input-preview.png') })

      await page.evaluate(() => {
        const target = window as unknown as { __uiEvents?: string[] }
        target.__uiEvents = []
        document.addEventListener('keydown', (event) => { target.__uiEvents?.push(`keydown:${event.key}`) }, true)
        document.addEventListener('submit', () => { target.__uiEvents?.push('submit') }, true)
      })
      await popover.locator('button[data-action="replace"]').click()
      await expect.poll(readModel).toBe('water water water water water water')
      await expect.poll(readDraft).toBe('water water water water water water')
      await page.waitForTimeout(200)
      await page.locator('#outside').click()
      await editor.click()
      expect(await readModel()).toBe('water water water water water water')
      expect(await readDraft()).toBe('water water water water water water')
      expect(await readSent()).toEqual([])
      const uiEvents = await page.evaluate(() => (window as unknown as { __uiEvents?: string[] }).__uiEvents ?? [])
      expect(uiEvents.filter((item) => item.startsWith('keydown:') || item === 'submit')).toEqual([])

      await inspectClosedShadowPage(page)
      await popover.locator('button[data-action="restore"]').click()
      await expect.poll(readModel).toBe('水水水水水水')
      await expect.poll(readDraft).toBe('水水水水水水')
      await inspectClosedShadowPage(page)
      await popover.locator('button[data-action="replace"]').click()
      await expect.poll(readModel).toBe('water water water water water water')
      await page.locator('#fixture-send').click()
      expect(await readSent()).toEqual(['water water water water water water'])

      await editor.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.type('第一行')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.type('第三行')
      await expect.poll(async () => {
        await inspectClosedShadowPage(page)
        return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
      }).toBe('Line one\n\nLine three')
      const multilineCall = api.calls.findLast((call) => {
        const texts = call.payload.texts
        return call.kind === 'texts' && Array.isArray(texts) && texts[0] === '第一行\n\n第三行'
      })
      expect(multilineCall?.payload).toEqual({ texts: ['第一行\n\n第三行'] })
      await popover.locator('button[data-action="replace"]').click()
      await expect.poll(readModel).toBe('Line one\n\nLine three')
      await expect.poll(readDraft).toBe('Line one\n\nLine three')
      await inspectClosedShadowPage(page)
      await popover.locator('button[data-action="restore"]').click()
      await expect.poll(readModel).toBe('第一行\n\n第三行')
      await expect.poll(readDraft).toBe('第一行\n\n第三行')

      await page.evaluate(() => {
        const state = window as unknown as { __compositionEndTrusted?: boolean }
        delete state.__compositionEndTrusted
        document.addEventListener('compositionend', (event) => {
          state.__compositionEndTrusted = event.isTrusted
        }, { capture: true, once: true })
      })
      const callsBeforeIme = api.calls.length
      await editor.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      const client = await page.context().newCDPSession(page)
      await client.send('Input.imeSetComposition', {
        text: '预编辑中文',
        selectionStart: 5,
        selectionEnd: 5,
      })
      await page.waitForTimeout(800)
      expect(api.calls.length).toBe(callsBeforeIme)
      await client.send('Input.insertText', { text: '提交的中文' })
      await expect.poll(readModel).toBe('提交的中文')
      await expect.poll(readDraft).toBe('提交的中文')
      let endTrusted: boolean | undefined
      await expect.poll(async () => {
        endTrusted = await page.evaluate(() => (window as unknown as { __compositionEndTrusted?: boolean }).__compositionEndTrusted)
        return endTrusted
      }).not.toBeUndefined()
      await testInfo.attach('ime-end-trust', { body: JSON.stringify({ trusted: endTrusted, driver: 'CDP', nativeOsImeTested: false }), contentType: 'application/json' })
      if (endTrusted === true) {
        await expect.poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        }).toBe('Committed Chinese')
        const imeCall = api.calls.findLast((call) => call.kind === 'texts')
        expect(imeCall?.payload).toEqual({ texts: ['提交的中文'] })
      } else if (endTrusted === false) {
        expect(api.calls.length).toBe(callsBeforeIme)
        await page.locator('#outside').click()
        await editor.click()
        await page.keyboard.type('继续')
        await expect.poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        }).toBe('EN:提交的中文继续')
        const recoveryCall = api.calls.findLast((call) => call.kind === 'texts')
        expect(recoveryCall?.payload).toEqual({ texts: ['提交的中文继续'] })
      } else {
        throw new Error('compositionend was not observed')
      }
      await client.detach()
    } finally {
      await context.close()
    }
  })

  for (const site of [
    { title: '常用聊天编辑器：ChatGPT', pageUrl: 'https://chatgpt.com/c/fixture' },
    { title: '常用聊天编辑器：Claude', pageUrl: 'https://claude.ai/chat/fixture' },
    { title: '常用聊天编辑器：Telegram Web', pageUrl: 'https://web.telegram.org/a/' },
  ]) {
    test(site.title, async () => {
      const testInfo = test.info()
      const bundle = await bundleProseMirrorFixture()
      const { context, extensionId } = await launch()
      const targetUrl = site.pageUrl
      const origin = new URL(targetUrl).origin
      const scriptUrl = `${origin}/wt-chat-fixture.js`
      await context.route(`${origin}/**`, async (route) => {
        const url = route.request().url().split('?')[0] ?? ''
        if (url === targetUrl) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:24px"><p id="history">CHAT_HISTORY_SENTINEL</p><div id="editor-mount"></div><div style="margin-top:200px"><button id="fixture-send" type="button">Send</button><button id="outside" type="button">Outside</button></div><script src="${scriptUrl}"></script></body></html>`,
          })
          return
        }
        if (url === scriptUrl) {
          await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle })
          return
        }
        await route.abort()
      })
      try {
        const options = await saveAndConnect(context, extensionId)
        api.setTextTranslator((text) => {
          if (text === '请检查这段代码') return 'Please review this code.'
          if (text === '第一行\n\n第三行') return 'Line one\n\nLine three'
          return `EN:${text}`
        })
        await enableRealtimeFeature(options, 'input')
        expect(
          await options.evaluate(async () => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({
              type: 'wt:save-config',
              patch: { floatingButtonEnabled: false },
            })
          }),
        ).toMatchObject({ ok: true, config: { inputTranslationEnabled: true } })

        const page = await context.newPage()
        await page.goto(targetUrl)
        await waitForSiteScriptRegistration(options, { url: targetUrl })
        await waitForSiteContentReady(options, page, { supported: true })
        const editor = page.locator('#chat-editor')
        await expect(editor).toHaveClass(/ProseMirror/)
        const readDraft = (): Promise<string> => page.evaluate(() => {
          const root = document.getElementById('chat-editor')
          if (!(root instanceof HTMLElement)) return ''
          const ignored = (node: Element): boolean => node.classList.contains('ProseMirror-trailingBreak') ||
            node.hasAttribute('data-slate-zero-width') || node.hasAttribute('data-slate-placeholder')
          const readBlock = (block: HTMLElement): string => {
            const meaningful = [...block.childNodes].filter((child) => !(child instanceof Element && ignored(child)) && !(child instanceof Text && child.data === ''))
            if (meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement &&
              block.querySelector('.ProseMirror-trailingBreak') === null) return ''
            let text = ''
            for (const child of block.childNodes) {
              if (child instanceof Element && ignored(child)) continue
              if (child instanceof Text) text += child.data
              else if (child instanceof HTMLBRElement) text += '\n'
              else if (child instanceof HTMLElement) text += readBlock(child)
            }
            return text
          }
          const blocks = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement && (child.tagName === 'P' || child.tagName === 'DIV'))
          return blocks.length === 0 ? readBlock(root) : blocks.map((block) => readBlock(block)).join('\n')
        })
        const readModel = (): Promise<string> => page.evaluate(() => {
          const root = document.getElementById('chat-editor') as (HTMLElement & { editor?: { state: { doc: { content: { size: number }; textBetween(from: number, to: number, blockSeparator: string, leafText: string): string } } } }) | null
          const current = root?.editor
          if (current === undefined) return ''
          return current.state.doc.textBetween(0, current.state.doc.content.size, '\n', '\n')
        })
        const readSent = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __sentDrafts?: string[] }).__sentDrafts ?? [])

        const callsBeforeDraft = api.calls.length
        await editor.click()
        await page.keyboard.type('请检查这段代码')
        const popover = page.locator('[data-wt-root] .popover')
        const status = popover.locator('[role="status"]')
        await expect.poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        }).toBe('Please review this code.')
        expect(await readDraft()).toBe('请检查这段代码')
        expect(await readModel()).toBe('请检查这段代码')
        const draftCalls = api.calls.slice(callsBeforeDraft).filter((call) => call.kind === 'texts')
        expect(draftCalls).toHaveLength(1)
        expect(draftCalls[0]?.payload).toEqual({ texts: ['请检查这段代码'] })
        expect(JSON.stringify(draftCalls[0]?.requestBody)).not.toContain('CHAT_HISTORY_SENTINEL')
        await page.screenshot({ path: testInfo.outputPath(`${site.title}-preview.png`) })

        await page.evaluate(() => {
          const target = window as unknown as { __uiEvents?: string[] }
          target.__uiEvents = []
          document.addEventListener('keydown', (event) => { target.__uiEvents?.push(`keydown:${event.key}`) }, true)
          document.addEventListener('submit', () => { target.__uiEvents?.push('submit') }, true)
        })
        await popover.locator('button[data-action="replace"]').click()
        await expect.poll(readModel).toBe('Please review this code.')
        await expect.poll(readDraft).toBe('Please review this code.')
        await page.waitForTimeout(200)
        await page.locator('#outside').click()
        await editor.click()
        expect(await readModel()).toBe('Please review this code.')
        expect(await readDraft()).toBe('Please review this code.')
        expect(await readSent()).toEqual([])
        const uiEvents = await page.evaluate(() => (window as unknown as { __uiEvents?: string[] }).__uiEvents ?? [])
        expect(uiEvents.filter((item) => item.startsWith('keydown:') || item === 'submit')).toEqual([])

        await inspectClosedShadowPage(page)
        await popover.locator('button[data-action="restore"]').click()
        await expect.poll(readModel).toBe('请检查这段代码')
        await expect.poll(readDraft).toBe('请检查这段代码')
        await inspectClosedShadowPage(page)
        await popover.locator('button[data-action="replace"]').click()
        await expect.poll(readModel).toBe('Please review this code.')
        await page.locator('#fixture-send').click()
        expect(await readSent()).toEqual(['Please review this code.'])

        await editor.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        await page.keyboard.type('第一行')
        await page.keyboard.press('Enter')
        await page.keyboard.press('Enter')
        await page.keyboard.type('第三行')
        await expect.poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        }).toBe('Line one\n\nLine three')
        const multilineCall = api.calls.findLast((call) => {
          const texts = call.payload.texts
          return call.kind === 'texts' && Array.isArray(texts) && texts[0] === '第一行\n\n第三行'
        })
        expect(multilineCall?.payload).toEqual({ texts: ['第一行\n\n第三行'] })
        await popover.locator('button[data-action="replace"]').click()
        await expect.poll(readModel).toBe('Line one\n\nLine three')
        await expect.poll(readDraft).toBe('Line one\n\nLine three')
        await inspectClosedShadowPage(page)
        await popover.locator('button[data-action="restore"]').click()
        await expect.poll(readModel).toBe('第一行\n\n第三行')
        await expect.poll(readDraft).toBe('第一行\n\n第三行')
      } finally {
        await context.close()
      }
    })
  }

  for (const site of [
    {
      title: '新增聊天编辑器：WhatsApp Lexical',
      pageUrl: 'https://web.whatsapp.com/',
      kind: 'lexical' as const,
      pageTitle: 'WhatsApp Lexical Fixture',
      multilineKeys: ['Shift+Enter', 'Shift+Enter', 'Shift+Enter'] as const,
    },
    {
      title: '新增聊天编辑器：Slack Quill',
      pageUrl: 'https://app.slack.com/client/T/C',
      kind: 'quill' as const,
      pageTitle: 'Slack Quill Fixture',
      multilineKeys: ['Enter', 'Enter', 'Enter'] as const,
    },
    {
      title: '新增聊天编辑器：Teams Rooster',
      pageUrl: 'https://teams.microsoft.com/v2/',
      kind: 'rooster' as const,
      pageTitle: 'Teams Rooster Fixture',
      multilineKeys: ['Enter', 'Enter', 'Enter'] as const,
    },
  ]) {
    test(site.title, async () => {
      const bundle = await bundleManagedChatFixture(site.kind)
      const { context, extensionId } = await launch()
      const targetUrl = site.pageUrl
      const origin = new URL(targetUrl).origin
      const scriptUrl = `${origin}/wt-chat-fixture.js`
      await context.route(`${origin}/**`, async (route) => {
        const url = route.request().url().split('?')[0] ?? ''
        if (url === targetUrl) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"><title>${site.pageTitle}</title></head><body style="margin:24px"><p id="history">CHAT_HISTORY_SENTINEL</p><div id="react-root"></div><div style="margin-top:200px"><button id="fixture-send" type="button">Send</button><button id="outside" type="button">Outside</button></div><script src="${scriptUrl}"></script></body></html>`,
          })
          return
        }
        if (url === scriptUrl) {
          await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle })
          return
        }
        await route.abort()
      })
      try {
        const options = await saveAndConnect(context, extensionId)
        api.setTextTranslator((text) => {
          if (text === '请检查这段代码') return 'Please review this code.'
          if (text === '第一行\n\n第三行\n') return 'Line one\n\nLine three\n'
          if (text === '<b>不是标签</b>') return '<b>不是标签</b>'
          return `EN:${text}`
        })
        await enableRealtimeFeature(options, 'input')
        expect(await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { inputTargetLanguage: 'en', targetLanguage: 'ja', floatingButtonEnabled: false },
          })
        })).toMatchObject({ ok: true, config: { inputTranslationEnabled: true, inputTargetLanguage: 'en', targetLanguage: 'ja' } })
        const page = await context.newPage()
        await page.goto(targetUrl)
        await waitForSiteScriptRegistration(options, { url: targetUrl })
        await waitForSiteContentReady(options, page, { supported: true })
        const editor = page.locator('#chat-editor')
        await expect(editor).toHaveAttribute('role', 'textbox')
        const readModel = (): Promise<string> => page.evaluate(() => (window as unknown as { __chatModelText?: string }).__chatModelText ?? '')
        const readDraft = (): Promise<string> => page.evaluate(() => (window as unknown as { __chatDraftState?: string }).__chatDraftState ?? '')
        const clearDraft = async (): Promise<void> => {
          await editor.click()
          if (site.kind === 'rooster') {
            await editor.evaluate((root) => {
              const probe = window as unknown as { __wtSelectionReady?: boolean }
              probe.__wtSelectionReady = false
              const onChange = (): void => {
                const selection = getSelection()
                if (selection !== null && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
                  probe.__wtSelectionReady = true
                  document.removeEventListener('selectionchange', onChange)
                }
              }
              document.addEventListener('selectionchange', onChange)
            })
          }
          await page.keyboard.press('Control+A')
          if (site.kind === 'rooster') {
            await page.waitForFunction(() => (window as unknown as { __wtSelectionReady?: boolean }).__wtSelectionReady === true, undefined, { timeout: 2000 })
          }
          await page.keyboard.press('Backspace')
          await expect.poll(readModel).toBe('')
          await expect.poll(readDraft).toBe('')
        }
        const readSent = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __sentDrafts?: string[] }).__sentDrafts ?? [])
        const readInjected = (): Promise<number> => page.evaluate(() => document.querySelectorAll('#chat-editor b, #chat-editor img, #chat-editor a').length)
        await page.bringToFront()
        await editor.click()
        await expect(editor).toBeEditable()
        await page.keyboard.type('请检查这段代码')
        const popover = page.locator('[data-wt-root] .popover')
        const status = popover.locator('[role="status"]')
        await expect.poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        }).toBe('Please review this code.')
        await expect.poll(readModel).toBe('请检查这段代码')
        await expect.poll(readDraft).toBe('请检查这段代码')
        expect(JSON.stringify(api.calls.findLast((call) => call.kind === 'texts')?.requestBody)).not.toContain('CHAT_HISTORY_SENTINEL')
        await page.screenshot({ path: test.info().outputPath('managed-input-preview.png') })
        const directReply = await context.serviceWorkers()[0]!.evaluate(async (url) => {
          const { chrome } = globalThis as unknown as {
            chrome: { tabs: {
              query(query: { url: string }): Promise<Array<{ id?: number }>>
              sendMessage(tabId: number, message: { type: 'wt:translate-input' }, options: { frameId: number }): Promise<unknown>
            } }
          }
          const [tab] = await chrome.tabs.query({ url })
          if (tab?.id === undefined) throw new Error('owned fixture tab unavailable')
          return chrome.tabs.sendMessage(tab.id, { type: 'wt:translate-input' }, { frameId: 0 })
        }, targetUrl)
        expect(directReply).toMatchObject({ ok: true })
        await expect.poll(readModel).toBe('Please review this code.')
        await expect.poll(() => editor.innerText()).toBe('Please review this code.')
        await expect.poll(readDraft).toBe('Please review this code.')
        expect(await readSent()).toEqual([])
        await page.locator('#outside').click()
        await editor.click()
        await inspectClosedShadowPage(page)
        await popover.locator('button[data-action="restore"]').click()
        await expect.poll(readModel).toBe('请检查这段代码')
        await expect.poll(readDraft).toBe('请检查这段代码')
        await clearDraft()
        await page.keyboard.type('第一行')
        for (const [index, key] of site.multilineKeys.entries()) {
          await page.keyboard.press(key)
          if (index === 1) await page.keyboard.type('第三行')
        }
        await expect.poll(readModel).toBe('第一行\n\n第三行\n')
        await expect.poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        }).toBe('Line one\n\nLine three\n')
        await popover.locator('button[data-action="replace"]').click()
        await expect.poll(readModel).toBe('Line one\n\nLine three\n')
        await expect.poll(readDraft).toBe('Line one\n\nLine three\n')
        await popover.locator('button[data-action="restore"]').click()
        await expect.poll(readModel).toBe('第一行\n\n第三行\n')
        await clearDraft()
        await page.keyboard.type('<b>不是标签</b>')
        await expect.poll(readInjected).toBe(0)
        await expect.poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
        }).toBe('<b>不是标签</b>')
        await popover.locator('button[data-action="replace"]').click()
        await expect.poll(readModel).toBe('<b>不是标签</b>')
        await expect.poll(readDraft).toBe('<b>不是标签</b>')
        expect(await readInjected()).toBe(0)
        expect(await readSent()).toEqual([])
        await page.locator('#fixture-send').click()
        expect(await readSent()).toEqual(['<b>不是标签</b>'])
      } finally {
        await context.close()
      }
    })
  }

  test.describe('视频站点输入', () => {
    const VIDEO_SITES = [
      {
        title: 'YouTube 评论 #contenteditable-root',
        pageUrl: 'https://www.youtube.com/watch?v=fixture',
        pageTitle: 'YouTube Comment Fixture',
        html: `<!doctype html><html><head><meta charset="utf-8"><title>YouTube Comment Fixture</title></head><body style="margin:24px"><p id="history">CHAT_HISTORY_SENTINEL</p><ytd-comment-simplebox-renderer><div id="contenteditable-root" style="min-height:72px;border:1px solid #888;padding:8px;display:block" contenteditable="true" role="textbox"><p><span class="style-scope yt-formatted-string"></span></p></div></ytd-comment-simplebox-renderer><div style="margin-top:200px"><button id="fixture-send" type="button">Send</button><button id="outside" type="button">Outside</button></div><script>window.__chatDraftState='';window.__sentDrafts=[];window.__trustedInputCount=0;const f=document.getElementById('contenteditable-root');f.addEventListener('input',(e)=>{if(e.isTrusted){window.__trustedInputCount++;window.__chatDraftState=f.innerText.replace(/\\r\\n?/g,'\\n')}});document.getElementById('fixture-send').addEventListener('click',()=>{window.__sentDrafts.push(window.__chatDraftState)});</script></body></html>`,
        editor: '#contenteditable-root',
        vue: false,
        autoInteraction: true,
      },
      {
        title: 'YouTube 直播聊天弹窗 #input',
        pageUrl: 'https://www.youtube.com/live_chat?is_popout=1&v=fixture',
        pageTitle: 'YouTube Live Chat Fixture',
        html: `<!doctype html><html><head><meta charset="utf-8"><title>YouTube Live Chat Fixture</title></head><body style="margin:24px"><p id="history">CHAT_HISTORY_SENTINEL</p><yt-live-chat-text-input-field-renderer><div id="input" style="min-height:72px;border:1px solid #888;padding:8px;display:block" contenteditable="" class="style-scope yt-live-chat-text-input-field-renderer" role="textbox"><div></div></div></yt-live-chat-text-input-field-renderer><div style="margin-top:200px"><button id="fixture-send" type="button">Send</button><button id="outside" type="button">Outside</button></div><script>window.__chatDraftState='';window.__sentDrafts=[];window.__trustedInputCount=0;const f=document.getElementById('input');f.addEventListener('input',(e)=>{if(e.isTrusted){window.__trustedInputCount++;window.__chatDraftState=f.innerText.replace(/\\r\\n?/g,'\\n')}});document.getElementById('fixture-send').addEventListener('click',()=>{window.__sentDrafts.push(window.__chatDraftState)});</script></body></html>`,
        editor: '#input',
        vue: false,
        autoInteraction: true,
      },
      {
        title: 'Bilibili 评论 openShadow .brt-editor',
        pageUrl: 'https://www.bilibili.com/video/BVfixture',
        pageTitle: 'Bilibili Comment Fixture',
        html: `<!doctype html><html><head><meta charset="utf-8"><title>Bilibili Comment Fixture</title></head><body style="margin:24px"><p id="history">CHAT_HISTORY_SENTINEL</p><style>bili-comments,bili-comment-box,bili-comment-rich-textarea{display:block}.brt-editor{min-height:72px;border:1px solid #888;padding:8px;display:block}</style><bili-comments></bili-comments><div style="margin-top:200px"><button id="fixture-send" type="button">Send</button><button id="outside" type="button">Outside</button></div><script>window.__chatDraftState='';window.__sentDrafts=[];window.__trustedInputCount=0;const c=document.querySelector('bili-comments').attachShadow({mode:'open'});c.innerHTML='<bili-comment-box></bili-comment-box>';const box=c.querySelector('bili-comment-box').attachShadow({mode:'open'});box.innerHTML='<bili-comment-rich-textarea></bili-comment-rich-textarea>';const ta=box.querySelector('bili-comment-rich-textarea').attachShadow({mode:'open'});ta.innerHTML='<div id="input" style="display:block"><div class="brt-root" style="display:block"><div class="brt-editor" contenteditable="true" role="textbox" style="min-height:72px;border:1px solid #888;padding:8px;display:block"><p><span class="brt-text"></span></p></div></div></div>';const f=ta.querySelector('.brt-editor');f.addEventListener('input',(e)=>{if(e.isTrusted){window.__trustedInputCount++;window.__chatDraftState=f.innerText.replace(/\\r\\n?/g,'\\n')}});document.getElementById('fixture-send').addEventListener('click',()=>{window.__sentDrafts.push(window.__chatDraftState)});</script></body></html>`,
        editor: '.brt-editor',
        vue: false,
        autoInteraction: false,
      },
      {
        title: 'Bilibili 直播弹幕 Vue3 input',
        pageUrl: 'https://live.bilibili.com/fixture',
        pageTitle: 'Bilibili Danmaku Fixture',
        html: `<!doctype html><html><head><meta charset="utf-8"><title>Bilibili Danmaku Fixture</title></head><body style="margin:24px"><p id="history">CHAT_HISTORY_SENTINEL</p><div id="vue-root"></div><div style="margin-top:200px"><button id="outside" type="button">Outside</button></div><script src="/wt-video-fixture.js"></script></body></html>`,
        editor: '.bpx-player-dm-input',
        vue: true,
        autoInteraction: true,
      },
    ] as const

    for (const site of VIDEO_SITES) {
      test(`视频站点输入：${site.title}`, async () => {
        const bundle = site.vue === true ? await bundleDanmakuFixture() : ''
        const { context, extensionId } = await launch()
        const origin = new URL(site.pageUrl).origin
        await context.route(`${origin}/**`, async (route) => {
          const url = route.request().url().split('?')[0] ?? ''
          if (site.vue === true && url === `${origin}/wt-video-fixture.js`) {
            await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle })
            return
          }
          if (url === site.pageUrl.split('?')[0]) {
            await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: site.html })
            return
          }
          await route.abort()
        })
        try {
          const options = await saveAndConnect(context, extensionId)
          api.setTextTranslator((text) => {
            if (text === '请检查这段代码') return 'このコードを確認してください。'
            if (text === '请保留换行') return '改行を保持してください。\n'
            if (text.includes('第一行') && text.includes('第三行')) return text.replace('第一行', '一行目').replace('第三行', '三行目')
            if (text === '<b>不是标签</b>') return '<b>タグではありません</b>'
            return `EN:${text}`
          })
          await enableRealtimeFeature(options, 'input')
          expect(await options.evaluate(async (autoInteraction) => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({
              type: 'wt:save-config',
              patch: {
                inputTargetLanguage: 'ja',
                targetLanguage: 'en',
                floatingButtonEnabled: false,
                autoInteractionEnabled: autoInteraction,
              },
            })
          }, site.autoInteraction)).toMatchObject({ ok: true, config: { inputTranslationEnabled: true, inputTargetLanguage: 'ja' } })
          const page = await context.newPage()
          await page.goto(site.pageUrl)
          await page.waitForLoadState('domcontentloaded')
          await waitForSiteScriptRegistration(options, { url: site.pageUrl })
          await waitForSiteContentReady(options, page, { supported: true })
          const editor = page.locator(site.editor)
          await expect(editor).toBeAttached()
          const readDraft = (): Promise<string> => page.evaluate(() => (window as unknown as { __chatDraftState?: string }).__chatDraftState ?? '')
          const readSent = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __sentDrafts?: string[] }).__sentDrafts ?? [])
          const readDom = async (): Promise<string> =>
            site.vue === true ? await editor.inputValue() : await editor.innerText()
          const readTrusted = (): Promise<number> => page.evaluate(() => (window as unknown as { __trustedInputCount?: number }).__trustedInputCount ?? 0)
          const clearDraft = async (): Promise<void> => {
            await editor.click()
            await page.keyboard.press('Control+A')
            await page.keyboard.press('Backspace')
            await expect.poll(async () => (await readDom()).trim()).toBe('')
            await expect.poll(async () => (await readDraft()).trim()).toBe('')
          }
          const popover = page.locator('[data-wt-root] .popover')
          const directReplace = async (): Promise<void> => {
            await editor.click()
            const directReply = await context.serviceWorkers()[0]!.evaluate(async (url) => {
              const { chrome } = globalThis as unknown as {
                chrome: { tabs: { query(q: { url: string }): Promise<Array<{ id?: number }>>; sendMessage(id: number, m: { type: string }, o: { frameId: number }): Promise<unknown> } }
              }
              const [tab] = await chrome.tabs.query({ url })
              if (tab?.id === undefined) throw new Error('fixture tab unavailable')
              return chrome.tabs.sendMessage(tab.id, { type: 'wt:translate-input' }, { frameId: 0 })
            }, site.pageUrl)
            expect(directReply).toMatchObject({ ok: true })
          }
          const callsBefore = api.calls.length
          const textCalls = () => api.calls.slice(callsBefore).filter((call) => call.kind === 'texts')
          await editor.click()
          await page.keyboard.type('请检查这段代码')
          if (site.autoInteraction) {
            const status = popover.locator('[role="status"]')
            await expect.poll(async () => {
              await inspectClosedShadowPage(page)
              return (await status.isVisible().catch(() => false)) ? await status.textContent() : ''
            }).toBe('このコードを確認してください。')
          } else {
            await page.waitForTimeout(650)
            expect(textCalls()).toEqual([])
          }
          const trustedBefore = await readTrusted()
          await directReplace()
          await expect.poll(readDom).toBe('このコードを確認してください。')
          await expect.poll(readDraft).toBe('このコードを確認してください。')
          if (!site.vue) expect(await readTrusted()).toBeGreaterThan(trustedBefore)
          const countAfterReplace = textCalls().length
          await page.waitForTimeout(650)
          expect(textCalls()).toHaveLength(countAfterReplace)
          expect(textCalls()[0]?.payload.texts).toEqual(['请检查这段代码'])
          expect(await readSent()).toEqual([])
          await inspectClosedShadowPage(page)
          await popover.locator('button[data-action="restore"]').click()
          await expect.poll(readDom).toBe('请检查这段代码')
          await expect.poll(readDraft).toBe('请检查这段代码')
          if (!site.vue) {
            await clearDraft()
            await page.keyboard.type('第一行')
            await page.keyboard.press('Shift+Enter')
            await page.keyboard.press('Shift+Enter')
            await page.keyboard.type('第三行')
            await page.keyboard.press('Shift+Enter')
            const multiline = await readDom()
            expect(multiline).toContain('第一行\n\n第三行')
            expect(multiline.endsWith('\n')).toBe(true)
            await expect.poll(readDraft).toBe(multiline)
            const translated = multiline.replace('第一行', '一行目').replace('第三行', '三行目')
            await directReplace()
            await expect.poll(readDom).toBe(translated)
            await expect.poll(readDraft).toBe(translated)
            expect(textCalls().findLast((call) => (call.payload.texts as string[] | undefined)?.[0] === multiline)?.payload.texts).toEqual([multiline])
            await inspectClosedShadowPage(page)
            await popover.locator('button[data-action="restore"]').click()
            await expect.poll(readDom).toBe(multiline)
            await expect.poll(readDraft).toBe(multiline)
          }
          if (site.editor === '#contenteditable-root') {
            await clearDraft()
            await page.keyboard.type('请保留换行')
            await expect.poll(readDom).toBe('请保留换行')
            await expect.poll(readDraft).toBe('请保留换行')
            const trustedBeforeReject = await readTrusted()
            await directReplace()
            await expect.poll(async () => {
              await inspectClosedShadowPage(page)
              return await popover.locator('[role="status"].is-error').textContent().catch(() => '')
            }).toBe(zhCN.wtInputReplaceFailed)
            await inspectClosedShadowPage(page)
            await expect(popover.locator('button[data-action="copy"]')).toBeVisible()
            expect(await readDom()).toBe('请保留换行')
            expect(await readDraft()).toBe('请保留换行')
            expect(await readTrusted()).toBe(trustedBeforeReject)
          }
          await clearDraft()
          await page.keyboard.type('<b>不是标签</b>')
          await directReplace()
          await expect.poll(readDom).toBe('<b>タグではありません</b>')
          await expect.poll(readDraft).toBe('<b>タグではありません</b>')
          expect(await editor.locator('b,img,a').count()).toBe(0)
          expect(await readSent()).toEqual([])
          expect(JSON.stringify(textCalls().map((call) => call.requestBody))).not.toContain('CHAT_HISTORY_SENTINEL')
          await page.screenshot({ path: test.info().outputPath('video-input.png') })
          await page.locator('#fixture-send').click()
          expect(await readSent()).toEqual(['<b>タグではありません</b>'])
        } finally {
          await context.close()
        }
      })
    }

    async function waitForInputFrameContentReady(
      options: Page,
      targetPage: Page,
      topUrl: string,
      frameUrl: string,
    ): Promise<void> {
      await inspectClosedShadowPage(targetPage)
      await expect
        .poll(
          async () =>
            options.evaluate(
              async ({ expectedTopUrl, expectedFrameUrl }) => {
                const { chrome } = globalThis as unknown as {
                  chrome: {
                    tabs: {
                      query(query: object): Promise<Array<{ id?: number; url?: string }>>
                      sendMessage(
                        id: number,
                        message: unknown,
                        sendOptions?: { frameId?: number; documentId?: string },
                      ): Promise<unknown>
                    }
                    scripting: {
                      executeScript(injection: {
                        target: { tabId: number; allFrames?: boolean }
                        func: () => string
                      }): Promise<Array<{ frameId?: number; documentId?: string; result?: unknown }>>
                    }
                  }
                }
                const tabs = await chrome.tabs.query({})
                const tab = tabs.find((item) => item.url === expectedTopUrl)
                if (tab?.id === undefined) return { ok: false, reason: 'tab-not-found' }
                const frames = await chrome.scripting
                  .executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: () => location.href,
                  })
                  .catch(() => [])
                const frame = frames.find(
                  (item) =>
                    typeof item.frameId === 'number' && item.frameId > 0 && item.result === expectedFrameUrl,
                )
                if (frame?.frameId === undefined) return { ok: false, reason: 'frame-not-found' }
                const reply = (await chrome.tabs
                  .sendMessage(tab.id, { type: 'wt:status' }, { frameId: frame.frameId })
                  .catch(() => undefined)) as
                  | { ok?: boolean; status?: { supported?: boolean } }
                  | undefined
                if (!reply?.ok || reply.status === undefined) {
                  return { ok: false, reason: 'status-no-reply', frameId: frame.frameId }
                }
                if (reply.status.supported !== true) {
                  return { ok: false, reason: 'supported-mismatch', status: reply.status }
                }
                return { ok: true, status: reply.status }
              },
              { expectedTopUrl: topUrl, expectedFrameUrl: frameUrl },
            ),
          { timeout: 15_000, message: `等待子框架内容脚本就绪 (${frameUrl})` },
        )
        .toMatchObject({ ok: true })
      await inspectClosedShadowPage(targetPage)
    }

    test('内嵌输入：YouTube 同源 live_chat 子框架 Alt+Y 直接替换', async () => {
      const testInfo = test.info()
      const { context, extensionId } = await launch()
      const watchUrl = 'https://www.youtube.com/watch?v=input-frame'
      const liveChatUrl = 'https://www.youtube.com/live_chat?v=input-frame'
      const liveChatHtml = VIDEO_SITES[1].html
      const watchHtml =
        '<!doctype html><html><head><meta charset="utf-8"><title>YouTube Watch Input Frame Fixture</title></head>' +
        '<body style="margin:24px">' +
        '<textarea id="top-draft" rows="3" style="width:360px;height:64px">顶层草稿</textarea>' +
        '<iframe id="chat-frame" src="/live_chat?v=input-frame" style="width:480px;height:320px;border:1px solid #ccc;display:block;margin-top:16px"></iframe>' +
        '</body></html>'

      await context.route('https://www.youtube.com/**', async (route) => {
        const requestUrl = route.request().url()
        if (requestUrl === watchUrl) {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: watchHtml })
          return
        }
        if (requestUrl === liveChatUrl) {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: liveChatHtml })
          return
        }
        await route.abort()
      })

      try {
        const options = await saveAndConnect(context, extensionId)
        api.setTextTranslator((text) => {
          if (text === '请检查这段代码') return 'Revisa este código.'
          if (text === '等待中的草稿') return 'Borrador en espera.'
          return `ES:${text}`
        })
        expect(
          await options.evaluate(async () => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({
              type: 'wt:save-config',
              patch: {
                inputTargetLanguage: 'es',
                autoInteractionEnabled: false,
                floatingButtonEnabled: false,
              },
            })
          }),
        ).toMatchObject({
          ok: true,
          config: {
            inputTargetLanguage: 'es',
            autoInteractionEnabled: false,
            floatingButtonEnabled: false,
          },
        })

        const page = await context.newPage()
        let topNavigations = 0
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) topNavigations += 1
        })
        await page.goto(watchUrl)
        await page.waitForLoadState('domcontentloaded')
        const chatFrame = page.frameLocator('#chat-frame')
        const editor = chatFrame.locator('#input')
        await expect(page.locator('#top-draft')).toHaveValue('顶层草稿')
        await expect(editor).toBeAttached()
        await editor.evaluate(() => {
          ;(window as unknown as { __frameAliveMarker?: string }).__frameAliveMarker = 'stay-in-frame'
        })
        expect(topNavigations).toBe(1)

        await options.bringToFront()
        await enableRealtimeFeature(options, 'input')
        await waitForSiteScriptRegistration(options, { url: watchUrl })
        await waitForSiteContentReady(options, page, { supported: true })
        await waitForInputFrameContentReady(options, page, watchUrl, liveChatUrl)
        expect(topNavigations).toBe(1)
        expect(
          await editor.evaluate(() => (window as unknown as { __frameAliveMarker?: string }).__frameAliveMarker),
        ).toBe('stay-in-frame')

        await expect
          .poll(() =>
            context.serviceWorkers()[0]!.evaluate(async () => {
              const { chrome } = globalThis as unknown as {
                chrome: {
                  scripting: {
                    getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<
                      Array<{ id: string; allFrames?: boolean; matches?: string[] }>
                    >
                  }
                }
              }
              const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['wt-input-frames'] })
              return scripts[0] ?? null
            }),
          )
          .toMatchObject({
            id: 'wt-input-frames',
            allFrames: true,
            matches: expect.arrayContaining(['https://www.youtube.com/live_chat*']),
          })

        const readDom = (): Promise<string> => editor.innerText()
        const readDraft = (): Promise<string> =>
          editor.evaluate(() => (window as unknown as { __chatDraftState?: string }).__chatDraftState ?? '')
        const readSent = (): Promise<string[]> =>
          editor.evaluate(() => (window as unknown as { __sentDrafts?: string[] }).__sentDrafts ?? [])
        const readTrusted = (): Promise<number> =>
          editor.evaluate(() => (window as unknown as { __trustedInputCount?: number }).__trustedInputCount ?? 0)

        await page.bringToFront()
        await editor.click()
        const callsBeforeType = api.calls.length
        const textCalls = () => api.calls.slice(callsBeforeType).filter((call) => call.kind === 'texts')
        await page.keyboard.type('请检查这段代码')
        await expect.poll(readDom).toBe('请检查这段代码')
        await expect.poll(readDraft).toBe('请检查这段代码')
        await page.waitForTimeout(650)
        expect(textCalls()).toEqual([])

        await context.serviceWorkers()[0]!.evaluate(() => {
          const probe = globalThis as unknown as { chrome: FixtureChrome; __wtNativeCommands: string[] }
          probe.__wtNativeCommands = []
          probe.chrome.commands.onCommand.addListener((command) => {
            probe.__wtNativeCommands.push(command)
          })
        })
        const readNativeCommands = (): Promise<string[]> =>
          context.serviceWorkers()[0]!.evaluate(() => {
            const probe = globalThis as unknown as { __wtNativeCommands?: string[] }
            return probe.__wtNativeCommands ?? []
          })

        const countTranslateInputCommands = async (): Promise<number> =>
          (await readNativeCommands()).filter((name) => name === 'translate-input').length
        const sendTargetedTranslateInput = async (): Promise<void> => {
          await page.bringToFront()
          await editor.click()
          const targeted = await context.serviceWorkers()[0]!.evaluate(async (topUrl) => {
            const { chrome } = globalThis as unknown as {
              chrome: {
                tabs: {
                  query(query: object): Promise<Array<{ id?: number; url?: string }>>
                  sendMessage(
                    tabId: number,
                    message: { type: 'wt:translate-input' },
                    sendOptions: { frameId: number; documentId: string },
                  ): Promise<unknown>
                }
                scripting: {
                  executeScript(injection: {
                    target: { tabId: number; allFrames?: boolean }
                    func: () => string
                  }): Promise<Array<{ frameId?: number; documentId?: string; result?: unknown }>>
                }
              }
            }
            const tabs = await chrome.tabs.query({})
            const tab = tabs.find((item) => item.url === topUrl)
            if (tab?.id === undefined) throw new Error('fixture tab unavailable')
            const tabId = tab.id
            const executed = await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: () => location.href,
            })
            const frames = executed.map((item) => ({
              frameId: item.frameId,
              documentId: item.documentId,
              url: typeof item.result === 'string' ? item.result : '',
            }))
            const liveChatFrames = frames.filter((item) =>
              item.url.startsWith('https://www.youtube.com/live_chat'),
            )
            if (liveChatFrames.length !== 1) {
              return { frames, liveChatFrames, reply: undefined }
            }
            const targetFrame = liveChatFrames[0]!
            if (
              typeof targetFrame.frameId !== 'number' ||
              typeof targetFrame.documentId !== 'string' ||
              targetFrame.documentId === ''
            ) {
              return { frames, liveChatFrames, reply: undefined }
            }
            const reply = await chrome.tabs.sendMessage(
              tabId,
              { type: 'wt:translate-input' },
              { frameId: targetFrame.frameId, documentId: targetFrame.documentId },
            )
            return { frames, liveChatFrames, reply }
          }, watchUrl)
          expect(targeted.liveChatFrames, JSON.stringify(targeted.frames)).toHaveLength(1)
          expect(targeted.reply).toEqual({ ok: true })
        }

        let triggerMode: 'native' | 'targeted' | undefined
        const triggerTranslateInput = async (verifyEffect: () => Promise<boolean>): Promise<void> => {
          if (triggerMode === undefined) {
            const shortcut = await sendOwnedBrowserAltShortcut(page, 'Y', verifyEffect)
            const commands = await readNativeCommands()
            if (shortcut.sent || commands.includes('translate-input')) {
              triggerMode = 'native'
              expect(commands).toContain('translate-input')
              return
            }
            const reason = shortcut.reason ?? 'unknown'
            testInfo.annotations.push({
              type: 'environment-gate',
              description: `原生 Alt+Y 未触发（${reason}），改用定向消息验证子框架链路；原生快捷键路由未在本环境验证`,
            })
            triggerMode = 'targeted'
          } else if (triggerMode === 'native') {
            const commandsBefore = await countTranslateInputCommands()
            const shortcut = await sendOwnedBrowserAltShortcut(page, 'Y', async () => {
              const count = await countTranslateInputCommands()
              return count > commandsBefore && (await verifyEffect())
            })
            expect(shortcut.sent, shortcut.reason).toBe(true)
            expect(await countTranslateInputCommands()).toBe(commandsBefore + 1)
            return
          }
          await sendTargetedTranslateInput()
          await expect.poll(verifyEffect).toBe(true)
        }

        const trustedBefore = await readTrusted()
        await triggerTranslateInput(async () => (await readDom()) === 'Revisa este código.')

        await expect.poll(readDom).toBe('Revisa este código.')
        await expect.poll(readDraft).toBe('Revisa este código.')
        expect(await readTrusted()).toBeGreaterThan(trustedBefore)
        await expect(page.locator('#top-draft')).toHaveValue('顶层草稿')
        expect(await readSent()).toEqual([])
        expect(textCalls()).toHaveLength(1)
        expect(textCalls()[0]?.payload.texts).toEqual(['请检查这段代码'])
        expect(JSON.stringify(textCalls()[0]?.requestBody)).not.toContain('CHAT_HISTORY_SENTINEL')
        expect(JSON.stringify(textCalls()[0]?.requestBody)).toContain('Spanish')

        const popover = chatFrame.locator('[data-wt-root] .popover')
        const restoreButton = popover.locator('button[data-action="restore"]')
        await expect
          .poll(async () => {
            await inspectClosedShadowPage(page)
            return restoreButton.isVisible().catch(() => false)
          })
          .toBe(true)
        await restoreButton.click()
        await expect.poll(readDom).toBe('请检查这段代码')
        await expect.poll(readDraft).toBe('请检查这段代码')
        await expect(page.locator('#top-draft')).toHaveValue('顶层草稿')
        expect(await readSent()).toEqual([])

        const heldText = '等待中的草稿'
        api.hold(heldText)
        await page.bringToFront()
        await editor.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        await expect.poll(async () => (await readDom()).trim()).toBe('')
        await expect.poll(async () => (await readDraft()).trim()).toBe('')
        await page.keyboard.type(heldText)
        await expect.poll(readDom).toBe(heldText)
        await expect.poll(readDraft).toBe(heldText)

        const heldCallsBefore = api.calls.length
        await triggerTranslateInput(async () =>
          api.calls.slice(heldCallsBefore).some((call) => {
            const texts = call.payload.texts
            return call.kind === 'texts' && Array.isArray(texts) && texts[0] === heldText
          }),
        )

        expect(
          await options.evaluate(async () => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({
              type: 'wt:save-config',
              patch: { inputTranslationEnabled: false },
            })
          }),
        ).toMatchObject({ ok: true, config: { inputTranslationEnabled: false } })

        api.release(heldText)
        await page.waitForTimeout(400)
        expect(await readDom()).toBe(heldText)
        expect(await readDraft()).toBe(heldText)
        expect(await readSent()).toEqual([])
        await inspectClosedShadowPage(page)
        await expect(chatFrame.locator('[data-wt-root]')).toBeHidden()
      } finally {
        await context.close()
      }
    })

    test('内嵌输入：跨源父页嵌入 YouTube live_chat 不启动子框架', async () => {
      const { context, extensionId } = await launch()
      const outerUrl = 'https://outer.fixture.test/player'
      const foreignLiveChatUrl = 'https://www.youtube.com/live_chat?v=foreign'
      const liveChatHtml = VIDEO_SITES[1].html
      const outerHtml =
        '<!doctype html><html><head><meta charset="utf-8"><title>Outer Player Fixture</title></head>' +
        '<body style="margin:24px">' +
        '<textarea id="top-draft" rows="3" style="width:360px;height:64px">外层草稿</textarea>' +
        '<iframe id="chat-frame" src="https://www.youtube.com/live_chat?v=foreign" style="width:480px;height:320px;border:1px solid #ccc;display:block;margin-top:16px"></iframe>' +
        '</body></html>'

      await context.route(outerUrl, (route) =>
        route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: outerHtml }),
      )
      await context.route('https://www.youtube.com/**', async (route) => {
        if (route.request().url() === foreignLiveChatUrl) {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: liveChatHtml })
          return
        }
        await route.abort()
      })

      try {
        const options = await saveAndConnect(context, extensionId)
        api.setTextTranslator((text) => `EN:${text}`)
        await enableRealtimeFeature(options, 'input')
        expect(
          await options.evaluate(async () => {
            const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
            return chrome.runtime.sendMessage({
              type: 'wt:save-config',
              patch: { floatingButtonEnabled: false },
            })
          }),
        ).toMatchObject({ ok: true, config: { inputTranslationEnabled: true, floatingButtonEnabled: false } })

        await waitForSiteScriptRegistration(options, { url: outerUrl })
        const page = await context.newPage()
        await page.goto(outerUrl)
        await page.waitForLoadState('domcontentloaded')
        await waitForSiteContentReady(options, page, { supported: true })

        const chatFrame = page.frameLocator('#chat-frame')
        const editor = chatFrame.locator('#input')
        await expect(page.locator('#top-draft')).toHaveValue('外层草稿')
        await expect(editor).toBeAttached()

        const readDom = (): Promise<string> => editor.innerText()
        const readDraft = (): Promise<string> =>
          editor.evaluate(() => (window as unknown as { __chatDraftState?: string }).__chatDraftState ?? '')
        const readSent = (): Promise<string[]> =>
          editor.evaluate(() => (window as unknown as { __sentDrafts?: string[] }).__sentDrafts ?? [])

        await page.bringToFront()
        await editor.click()
        const callsBefore = api.calls.length
        const textCalls = () => api.calls.slice(callsBefore).filter((call) => call.kind === 'texts')
        await page.keyboard.type('请检查这段代码')
        await expect.poll(readDom).toBe('请检查这段代码')
        await expect.poll(readDraft).toBe('请检查这段代码')
        await page.waitForTimeout(650)
        expect(textCalls()).toEqual([])

        const topReply = await context.serviceWorkers()[0]!.evaluate(async (url) => {
          const { chrome } = globalThis as unknown as {
            chrome: {
              tabs: {
                query(query: { url: string }): Promise<Array<{ id?: number }>>
                sendMessage(
                  tabId: number,
                  message: { type: 'wt:translate-input' },
                  sendOptions: { frameId: number },
                ): Promise<unknown>
              }
            }
          }
          const [tab] = await chrome.tabs.query({ url })
          if (tab?.id === undefined) throw new Error('fixture tab unavailable')
          return chrome.tabs.sendMessage(tab.id, { type: 'wt:translate-input' }, { frameId: 0 }).catch(() => undefined)
        }, outerUrl)
        if (topReply !== undefined) {
          expect(topReply).toMatchObject({ ok: false })
        }

        await expect(page.locator('#top-draft')).toHaveValue('外层草稿')
        expect(await readDom()).toBe('请检查这段代码')
        expect(await readDraft()).toBe('请检查这段代码')
        expect(textCalls()).toEqual([])
        expect(await readSent()).toEqual([])
        await inspectClosedShadowPage(page)
        await expect(chatFrame.locator('[data-wt-root]')).toHaveCount(0)
      } finally {
        await context.close()
      }
    })
  })

  test('实时功能扩展链路：YouTube Netflix 与原生 TextTrack 字幕保持原文并固定译中文', async () => {
    const testInfo = test.info()
    const { context, extensionId } = await launch()
    try {
      api.setTextTranslator((t) => `测试译文：${t}`)
      const options = await saveAndConnect(context, extensionId)
      await enableRealtimeFeature(options, 'video')
      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { targetLanguage: 'ja', floatingButtonEnabled: false },
          })
        }),
      ).toMatchObject({
        ok: true,
        config: { targetLanguage: 'ja', videoSubtitlesEnabled: true, autoOrigins: [] },
      })

      const ytUrl = 'https://www.youtube.com/watch?v=fixture'
      const nfUrl = 'https://www.netflix.com/watch/fixture'
      const nativeUrl = 'https://video.fixture.test/player'

      await context.route(ytUrl, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body>
                <p>NOT_SENT_SENTINEL</p>
                <button id="fs-btn" type="button">Fullscreen</button>
                <div id="movie_player" class="html5-video-player" style="position:relative;width:640px;height:360px;background:#111">
                  <video id="yt-video" style="width:640px;height:360px;display:block"></video>
                  <div class="ytp-caption-window-container">
                    <span class="ytp-caption-segment">English subtitle fixture</span>
                  </div>
                </div>
                <script>
                  document.getElementById('fs-btn').addEventListener('click', () => {
                    document.getElementById('movie_player').requestFullscreen();
                  });
                </script>
              </body>
            </html>`,
        }),
      )

      await context.route(nfUrl, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body>
                <p>NOT_SENT_SENTINEL</p>
                <button id="fs-btn" type="button">Fullscreen</button>
                <div id="nf-player" class="watch-video--player-view" style="position:relative;width:640px;height:360px;background:#111">
                  <video id="nf-video" style="width:640px;height:360px;display:block"></video>
                  <div class="player-timedtext">
                    <div class="player-timedtext-text-container">
                      <span>日本語字幕のテストです</span>
                    </div>
                  </div>
                </div>
                <script>
                  document.getElementById('fs-btn').addEventListener('click', () => {
                    document.getElementById('nf-player').requestFullscreen();
                  });
                </script>
              </body>
            </html>`,
        }),
      )

      await context.route(nativeUrl, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body>
                <p>NOT_SENT_SENTINEL</p>
                <button id="fs-btn" type="button">Fullscreen</button>
                <div id="native-player" style="position:relative;width:640px;height:360px;background:#111">
                  <video id="native-video" muted playsinline style="width:640px;height:360px;display:block"></video>
                </div>
                <script>
                  document.getElementById('fs-btn').addEventListener('click', () => {
                    document.getElementById('native-player').requestFullscreen();
                  });
                </script>
              </body>
            </html>`,
        }),
      )

      await waitForSiteScriptRegistration(options, { url: ytUrl })
      const page = await context.newPage()

      await page.goto(ytUrl)
      await page.bringToFront()
      await waitForSiteContentReady(options, page, { supported: true })

      const bubble = page.locator('[data-wt-root] .bubble')
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await bubble.isVisible().catch(() => false)) ? await bubble.textContent() : ''
        })
        .toBe('测试译文：English subtitle fixture')
      await expect(page.locator('.ytp-caption-segment')).toHaveText('English subtitle fixture')

      const ytCall = api.calls.findLast(
        (call) =>
          call.kind === 'texts' &&
          (call.payload.texts as string[] | undefined)?.includes('English subtitle fixture'),
      )
      expect(ytCall).toBeDefined()
      expect(ytCall!.payload.texts).toEqual(['English subtitle fixture'])
      expect(JSON.stringify(ytCall!.requestBody)).not.toContain('NOT_SENT_SENTINEL')
      expect((ytCall!.requestBody.messages as Array<{ content: string }>)[0]?.content ?? '').toContain(
        'into natural, accurate Simplified Chinese',
      )
      await page.screenshot({ path: testInfo.outputPath('subtitle-youtube-extension.png') })

      api.hold('Slow subtitle fixture')
      await page.evaluate(() => {
        const seg = document.querySelector('.ytp-caption-segment')!
        seg.textContent = 'Slow subtitle fixture'
      })
      await expect
        .poll(() =>
          api.calls.some(
            (call) =>
              call.kind === 'texts' &&
              (call.payload.texts as string[] | undefined)?.includes('Slow subtitle fixture'),
          ),
        )
        .toBe(true)

      await page.evaluate(() => {
        const seg = document.querySelector('.ytp-caption-segment')!
        seg.textContent = 'Newest subtitle fixture'
      })
      api.release('Slow subtitle fixture')

      const observedDuringTransition: string[] = []
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          const text = (await bubble.isVisible().catch(() => false)) ? ((await bubble.textContent()) ?? '') : ''
          if (text !== '') observedDuringTransition.push(text)
          return text
        })
        .toBe('测试译文：Newest subtitle fixture')
      expect(observedDuringTransition).not.toContain('测试译文：Slow subtitle fixture')

      const callsBeforeHideCc = api.calls.length
      await page.evaluate(() => {
        const cc = document.querySelector<HTMLElement>('.ytp-caption-window-container')!
        cc.hidden = true
      })
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await bubble.isVisible().catch(() => false)) ? await bubble.textContent() : ''
        })
        .toBe(zhCN.wtSubtitleWaitingHint)
      await page.waitForTimeout(1200)
      expect(api.calls).toHaveLength(callsBeforeHideCc)

      await waitForSiteScriptRegistration(options, { url: nfUrl })
      await page.goto(nfUrl)
      await page.bringToFront()
      await waitForSiteContentReady(options, page, { supported: true })

      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await bubble.isVisible().catch(() => false)) ? await bubble.textContent() : ''
        })
        .toBe('测试译文：日本語字幕のテストです')
      await expect(page.locator('.player-timedtext-text-container span')).toHaveText('日本語字幕のテストです')

      const nfCall = api.calls.findLast(
        (call) =>
          call.kind === 'texts' &&
          (call.payload.texts as string[] | undefined)?.includes('日本語字幕のテストです'),
      )
      expect(nfCall).toBeDefined()
      expect(nfCall!.payload.texts).toEqual(['日本語字幕のテストです'])
      expect(JSON.stringify(nfCall!.requestBody)).not.toContain('NOT_SENT_SENTINEL')
      expect((nfCall!.requestBody.messages as Array<{ content: string }>)[0]?.content ?? '').toContain(
        'into natural, accurate Simplified Chinese',
      )

      await waitForSiteScriptRegistration(options, { url: nativeUrl })
      await page.goto(nativeUrl)
      await page.bringToFront()
      await waitForSiteContentReady(options, page, { supported: true })

      await page.evaluate(async () => {
        const video = document.getElementById('native-video') as HTMLVideoElement
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 90
        canvas.hidden = true
        document.body.append(canvas)
        const ctx = canvas.getContext('2d')!
        let tick = 0
        const draw = () => {
          tick += 1
          ctx.fillStyle = tick % 2 === 0 ? '#123' : '#234'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        draw()
        ;(window as unknown as { __canvasTimer?: ReturnType<typeof setInterval> }).__canvasTimer = setInterval(draw, 80)
        video.srcObject = canvas.captureStream(10)
        video.muted = true
        const track = video.addTextTrack('subtitles', 'Japanese', 'ja')
        track.mode = 'showing'
        track.addCue(new VTTCue(0, 120, 'こんにちは、字幕のテストです'))
        await video.play()
      })

      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await bubble.isVisible().catch(() => false)) ? await bubble.textContent() : ''
        })
        .toBe('测试译文：こんにちは、字幕のテストです')

      expect(
        await page.evaluate(() => {
          const video = document.getElementById('native-video') as HTMLVideoElement
          const cue = video.textTracks[0]?.cues?.[0] as VTTCue | undefined
          return cue?.text
        }),
      ).toBe('こんにちは、字幕のテストです')

      const nativeCall = api.calls.findLast(
        (call) =>
          call.kind === 'texts' &&
          (call.payload.texts as string[] | undefined)?.includes('こんにちは、字幕のテストです'),
      )
      expect(nativeCall).toBeDefined()
      expect(nativeCall!.payload.texts).toContain('こんにちは、字幕のテストです')
      expect(JSON.stringify(nativeCall!.requestBody)).not.toContain('NOT_SENT_SENTINEL')
      expect((nativeCall!.requestBody.messages as Array<{ content: string }>)[0]?.content ?? '').toContain(
        'into natural, accurate Simplified Chinese',
      )

      await page.locator('#fs-btn').click()
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('native-player')
      await inspectClosedShadowPage(page)
      await expect(bubble).toBeVisible()
      await expect(bubble).toHaveText('测试译文：こんにちは、字幕のテストです')
      expect(
        await page.evaluate(() => {
          const fs = document.fullscreenElement
          const host = document.querySelector('[data-wt-root]')
          return fs !== null && host !== null && fs.contains(host)
        }),
      ).toBe(true)

      await page.evaluate(() => document.exitFullscreen())
      await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull()
      await page.evaluate(() => {
        const w = window as unknown as { __canvasTimer?: ReturnType<typeof setInterval> }
        if (w.__canvasTimer !== undefined) clearInterval(w.__canvasTimer)
      })
    } finally {
      await context.close()
    }
  })

  test('实时功能扩展链路：站点范围与撤权停止发送，标签页输入请求相互隔离', async () => {
    const { context, extensionId } = await launch()
    try {
      const urlA = 'https://chat.fixture.test/a'
      const urlB = 'https://chat.fixture.test/b'
      await context.route(/^https:\/\/chat\.fixture\.test\/[ab]$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body style="margin:24px">
                <textarea id="draft" rows="4" style="width:360px;height:84px"></textarea>
              </body>
            </html>`,
        }),
      )

      api.setTextTranslator((t) => `English: ${t}`)
      const options = await saveAndConnect(context, extensionId)
      await enableRealtimeFeature(options, 'input')
      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { floatingButtonEnabled: false },
          })
        }),
      ).toMatchObject({ ok: true, config: { inputTranslationEnabled: true } })

      await waitForSiteScriptRegistration(options, { url: urlA })
      const pageA = await context.newPage()
      await pageA.goto(urlA)
      await waitForSiteContentReady(options, pageA, { supported: true })

      const pageB = await context.newPage()
      await pageB.goto(urlB)
      await waitForSiteContentReady(options, pageB, { supported: true })

      api.hold('标签甲')
      api.hold('标签乙')

      await pageA.bringToFront()
      await pageA.locator('#draft').click()
      await pageA.locator('#draft').fill('标签甲')
      await expect
        .poll(() =>
          api.calls.some(
            (call) => call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes('标签甲'),
          ),
        )
        .toBe(true)
      const callA1 = api.calls.findLast(
        (call) => call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes('标签甲'),
      )!

      await pageB.bringToFront()
      await pageB.locator('#draft').click()
      await pageB.locator('#draft').fill('标签乙')
      await expect
        .poll(() =>
          api.calls.some(
            (call) => call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes('标签乙'),
          ),
        )
        .toBe(true)
      const callB1 = api.calls.findLast(
        (call) => call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes('标签乙'),
      )!

      expect(callA1.aborted).toBe(false)
      expect(callB1.aborted).toBe(false)

      await pageA.bringToFront()
      await pageA.locator('#draft').click()
      await pageA.locator('#draft').fill('标签甲更新')
      await expect.poll(() => callA1.aborted).toBe(true)
      expect(callB1.aborted).toBe(false)

      const statusA = pageA.locator('[data-wt-root] .popover [role="status"]')
      const statusB = pageB.locator('[data-wt-root] .popover [role="status"]')

      await expect
        .poll(async () => {
          await inspectClosedShadowPage(pageA)
          return (await statusA.isVisible().catch(() => false)) ? await statusA.textContent() : ''
        })
        .toBe('English: 标签甲更新')
      expect(callB1.aborted).toBe(false)

      api.release('标签乙')
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(pageB)
          return (await statusB.isVisible().catch(() => false)) ? await statusB.textContent() : ''
        })
        .toBe('English: 标签乙')

      api.release('标签甲')
      await pageA.waitForTimeout(200)
      await inspectClosedShadowPage(pageA)
      await expect(statusA).toHaveText('English: 标签甲更新')

      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:set-site-scope-host',
            host: 'other.fixture.test',
            listed: true,
          })
        }),
      ).toMatchObject({ ok: true })
      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { siteScopeMode: 'include' },
          })
        }),
      ).toMatchObject({
        ok: true,
        config: { siteScopeMode: 'include', siteScopeHosts: ['other.fixture.test'] },
      })

      await expect
        .poll(async () => {
          await inspectClosedShadowPage(pageA)
          await inspectClosedShadowPage(pageB)
          return (await statusA.count()) + (await statusB.count())
        })
        .toBe(0)

      const callsInExcludedScope = api.calls.length
      await pageA.bringToFront()
      await pageA.locator('#draft').click()
      await pageA.locator('#draft').fill('范围外不发送甲')
      await pageB.bringToFront()
      await pageB.locator('#draft').click()
      await pageB.locator('#draft').fill('范围外不发送乙')
      await pageA.waitForTimeout(800)
      expect(api.calls).toHaveLength(callsInExcludedScope)

      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:set-site-scope-host',
            host: 'other.fixture.test',
            listed: false,
          })
        }),
      ).toMatchObject({ ok: true })
      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as { chrome: FixtureChrome }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: { siteScopeMode: 'all' },
          })
        }),
      ).toMatchObject({
        ok: true,
        config: { siteScopeMode: 'all', siteScopeHosts: [] },
      })

      await waitForSiteScriptRegistration(options, { url: urlA })
      await waitForSiteContentReady(options, pageA, { supported: true })
      await waitForSiteContentReady(options, pageB, { supported: true })

      await pageA.bringToFront()
      await pageA.locator('#draft').click()
      await pageA.locator('#draft').fill('恢复范围后的草稿')
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(pageA)
          return (await statusA.isVisible().catch(() => false)) ? await statusA.textContent() : ''
        })
        .toBe('English: 恢复范围后的草稿')

      const heldBeforeRevoke = '撤权前在途草稿'
      api.hold(heldBeforeRevoke)
      await pageA.locator('#draft').click()
      await pageA.locator('#draft').fill(heldBeforeRevoke)
      await expect
        .poll(() =>
          api.calls.some(
            (call) =>
              call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes(heldBeforeRevoke),
          ),
        )
        .toBe(true)
      const revokeCall = api.calls.findLast(
        (call) => call.kind === 'texts' && (call.payload.texts as string[] | undefined)?.includes(heldBeforeRevoke),
      )!

      const permissionState = await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as {
          chrome: {
            permissions: {
              remove(query: { origins: string[] }): Promise<boolean>
              contains(query: { origins: string[] }): Promise<boolean>
            }
          }
        }
        const removed = await chrome.permissions.remove({ origins: ['https://*/*'] })
        const granted = await chrome.permissions.contains({ origins: ['https://chat.fixture.test/*'] })
        return { removed, granted }
      })
      expect(permissionState).toEqual({ removed: true, granted: false })

      await expect.poll(() => revokeCall.aborted).toBe(true)
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(pageA)
          return statusA.count()
        })
        .toBe(0)

      api.release(heldBeforeRevoke)
      expect(await configFlag(options, 'inputTranslationEnabled')).toBe(true)

      const callsAfterRevoke = api.calls.length
      await pageA.bringToFront()
      await pageA.locator('#draft').click()
      await pageA.locator('#draft').fill('撤权后再次输入中文')
      await pageA.waitForTimeout(800)
      expect(api.calls).toHaveLength(callsAfterRevoke)
      await inspectClosedShadowPage(pageA)
      await expect(statusA).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})

interface WtPanelWindow extends Window {
  __wtPanel: TranslationPanel
  __wtResumed: number
  __wtClosed: number
}

async function mountPanelFixture(page: Page): Promise<void> {
  const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  const floatingCode = ts.transpileModule(
    await readFile(resolve(import.meta.dirname, '../../src/translation/floating.ts'), 'utf8'),
    { compilerOptions },
  ).outputText
  let code = ts.transpileModule(
    await readFile(resolve(import.meta.dirname, '../../src/translation/panel.ts'), 'utf8'),
    { compilerOptions },
  ).outputText
  await page.setContent(
    '<!doctype html><html><body><dialog id="native-dialog" style="width:220px;height:170px;overflow:hidden;transform:translate(17px,11px)"><input id="native-input"><button id="native-close">关闭网页窗口</button></dialog></body></html>',
  )
  const floatingUrl = await page.evaluate((source) => {
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  }, floatingCode)
  code = code.replaceAll("from './floating'", `from '${floatingUrl}'`).replaceAll('from "./floating"', `from "${floatingUrl}"`)
  await page.addScriptTag({
    type: 'module',
    content:
      code +
      '\nwindow.__wtPanel = createTranslationPanel(); window.__wtResumed = 0; window.__wtClosed = 0;' +
      ' window.__wtPanel.setOnResume(() => { window.__wtResumed += 1 });' +
      ' window.__wtPanel.setOnClose(() => { window.__wtClosed += 1 });' +
      ' document.getElementById("native-close").onclick = () => document.getElementById("native-dialog").close();',
  })
  await page.evaluate((url) => URL.revokeObjectURL(url), floatingUrl)
  await inspectClosedShadowPage(page)
}

function hostParentIsRoot(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-wt-root]')
    return host !== null && host.parentElement === document.documentElement
  })
}

nativeTest.describe('暂停条原生dialog', () => {
  nativeTest('仅暂停条：原生关闭后宿主回到根节点并可继续', async ({ page }) => {
    await mountPanelFixture(page)
    const dlg = page.locator('#native-dialog')
    await dlg.evaluate((el) => (el as HTMLDialogElement).showModal())
    await page.locator('#native-input').focus()
    await page.evaluate(() => (window as unknown as WtPanelWindow).__wtPanel.showPauseStatus('凭证无效', true))
    const host = page.locator('[data-wt-root]')
    expect(await host.evaluate((el) => el.parentElement?.tagName)).toBe('DIALOG')

    await page.locator('#native-close').click()
    await expect.poll(() => hostParentIsRoot(page)).toBe(true)
    expect(await dlg.evaluate((el) => (el as HTMLDialogElement).open)).toBe(false)
    expect(await host.getAttribute('popover')).toBeNull()
    await expect(page.locator('.pause-status')).toBeVisible()
    await page.locator('.pause-resume').click()
    await expect(page.locator('[data-wt-root]')).toBeHidden()
    expect(await page.evaluate(() => (window as unknown as WtPanelWindow).__wtResumed)).toBe(1)
    expect(await page.evaluate(() => (window as unknown as WtPanelWindow).__wtClosed)).toBe(0)
  })

  nativeTest('卡片关闭后弹层内暂停条保留，原生关闭才回根节点', async ({ page }) => {
    await mountPanelFixture(page)
    const dlg = page.locator('#native-dialog')
    await dlg.evaluate((el) => (el as HTMLDialogElement).showModal())
    await page.locator('#native-input').focus()
    await page.evaluate(() => (window as unknown as WtPanelWindow).__wtPanel.showPauseStatus('自动暂停', true))
    const host = page.locator('[data-wt-root]')
    expect(await host.evaluate((el) => el.matches(':popover-open'))).toBe(true)
    await expect(page.locator('.pause-status')).toBeVisible()
    const stripBox = await page.locator('.pause-status').boundingBox()
    const viewport = page.viewportSize()
    expect(stripBox !== null && viewport !== null &&
      stripBox!.x >= 0 && stripBox!.y >= 0 &&
      stripBox!.x + stripBox!.width <= viewport!.width + 1 &&
      stripBox!.y + stripBox!.height <= viewport!.height + 1).toBe(true)

    await page.evaluate(() =>
      (window as unknown as WtPanelWindow).__wtPanel.showSelectionResult('Physics term', ['物理术语']),
    )
    await expect(page.locator('.panel-target')).toHaveText('物理术语')
    await page.keyboard.press('Escape')
    await expect(page.locator('.panel')).toBeHidden()
    expect(await host.evaluate((el) => el.matches(':popover-open'))).toBe(true)
    expect(await dlg.evaluate((el) => (el as HTMLDialogElement).open)).toBe(true)
    expect(await host.evaluate((el) => el.parentElement?.tagName)).toBe('DIALOG')
    await expect(page.locator('.pause-status')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as WtPanelWindow).__wtClosed)).toBe(1)

    await page.evaluate(() =>
      (window as unknown as WtPanelWindow).__wtPanel.setOnResume(() => {
        const w = window as unknown as WtPanelWindow
        w.__wtResumed += 1
        w.__wtPanel.showPauseStatus('再次暂停', true)
      }),
    )
    await page.locator('.pause-resume').click()
    expect(await page.evaluate(() => (window as unknown as WtPanelWindow).__wtResumed)).toBe(1)
    await expect(page.locator('.pause-status')).toBeVisible()
    await page.locator('.pause-resume').click()
    await expect.poll(() =>
      page.evaluate(() => (window as unknown as WtPanelWindow).__wtResumed),
    ).toBe(2)
    await page.locator('#native-close').click()
    await expect.poll(() => hostParentIsRoot(page)).toBe(true)
    await expect(page.locator('.pause-status')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as WtPanelWindow).__wtClosed)).toBe(1)
    await page.evaluate(() =>
      (window as unknown as WtPanelWindow).__wtPanel.setOnResume(() => {
        ;(window as unknown as WtPanelWindow).__wtResumed += 1
      }),
    )
    await page.locator('.pause-resume').click()
    await expect.poll(() =>
      page.evaluate(() => (window as unknown as WtPanelWindow).__wtResumed),
    ).toBe(3)
    await expect(page.locator('[data-wt-root]')).toBeHidden()
  })

})
