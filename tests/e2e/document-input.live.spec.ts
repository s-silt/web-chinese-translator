import { writeFile } from 'node:fs/promises'
import { chromium, type BrowserContext, type Frame, type Page } from '@playwright/test'
import {
  acceptOwnedPermission,
  expect,
  EXTENSION_PATH,
  inspectClosedShadowPage,
  installClosedShadowInspection,
  NATIVE_ACCESSIBILITY_ARGS,
  sendOwnedBrowserAltShortcut,
  test,
  waitForSiteScriptRegistration,
} from './fixtures'
import { startMock } from './mock-server'

const headedTest = test.extend({
  context: async ({ headless: _headless }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--lang=zh-CN',
        '--host-resolver-rules=MAP reader.fixture.test 127.0.0.1',
        '--no-proxy-server',
        ...NATIVE_ACCESSIBILITY_ARGS,
      ],
    })
    await installClosedShadowInspection(context)
    await use(context)
    await context.close()
  },
})

const MODEL_KEY = 'sk-e2e-fake'

interface ChromeApiLike {
  readonly tabs: {
    query(query: { url: string }): Promise<Array<{ id?: number }>>
    setZoom(tabId: number, zoomFactor: number): Promise<void>
    getZoom(tabId: number): Promise<number>
    sendMessage(
      tabId: number,
      message: unknown,
      options?: { frameId?: number },
    ): Promise<unknown>
  }
  readonly scripting: {
    executeScript(request: {
      target: { tabId: number; allFrames?: boolean; frameIds?: number[] }
      func?: () => unknown
      files?: string[]
    }): Promise<Array<{ frameId: number; result?: unknown }>>
  }
}

async function showOptionsSection(options: Page, section: 'general' | 'model'): Promise<void> {
  const target = section === 'general' ? 'wt-general-title' : 'wt-title'
  await options.locator(`[data-test="nav-${target}"]`).click()
  const control = section === 'general' ? 'wt-general-view' : 'wt-model-view'
  await expect(options.locator(`[data-test="${control}"]`)).toBeVisible()
}

async function saveModelConfig(options: Page, apiUrl: string): Promise<void> {
  await showOptionsSection(options, 'model')
  await options.getByPlaceholder(/api\.example\.com|v1/).fill(apiUrl)
  await options.locator('input[type="password"]').fill(MODEL_KEY)
  await options.locator('[data-test="wt-model-input"]').fill('mock-model')
  await options.locator('[data-test="wt-save"]').click()
  await acceptOwnedPermission(options, ['http://127.0.0.1/*'])
  await expect(options.getByText(/connection succeeded|连接成功/)).toBeVisible({ timeout: 20000 })
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

async function openOptions(context: BrowserContext, extensionId: string): Promise<Page> {
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
  return options
}

async function sendTranslateInput(
  extensionPage: Page,
  url: string,
  frameId?: number,
): Promise<unknown> {
  return extensionPage.evaluate(
    async ({ targetUrl, frame }) => {
      const { chrome } = globalThis as unknown as { chrome: ChromeApiLike }
      const [tab] = await chrome.tabs.query({ url: targetUrl })
      if (tab?.id === undefined) throw new Error(`owned tab not found: ${targetUrl}`)
      return chrome.tabs.sendMessage(
        tab.id,
        { type: 'wt:translate-input' },
        frame === undefined ? undefined : { frameId: frame },
      )
    },
    { targetUrl: url, frame: frameId },
  )
}

async function blockExternalWrites(context: BrowserContext): Promise<string[]> {
  const blocked: string[] = []
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = request.url()
    if (!/^https?:\/\//.test(url)) {
      await route.fallback()
      return
    }
    const host = new URL(url).hostname
    if (host === '127.0.0.1' || host === 'localhost') {
      await route.continue()
      return
    }
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      blocked.push(`${request.method()} ${url}`)
      await route.abort()
      return
    }
    await route.continue()
  })
  return blocked
}

function modelTranslator(text: string): string {
  return text.includes('你好') && text.includes('第二行') ? 'Hello\nWorld' : `EN:${text}`
}

async function expectCopyFeedback(page: Page, screenshot: string): Promise<void> {
  const copy = page.locator('[data-test="wt-text-copy"]')
  const feedback = page.locator('.ui-toast')
  await copy.hover()
  await expect(feedback).toHaveCount(0)
  await copy.click()
  await expect(feedback).toHaveCount(1)
  await expect(feedback).toBeVisible()
  await expect(feedback).toBeInViewport()
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    )
  })
  const session = await page.context().newCDPSession(page)
  const shot = await session.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  })
  await writeFile(test.info().outputPath(screenshot), Buffer.from(shot.data, 'base64'))
  await session.detach()
  await page.locator('h1').scrollIntoViewIfNeeded()
  const overlaps = await page.evaluate(() => {
    const toast = document.querySelector('.ui-toast')?.getBoundingClientRect()
    if (!toast) throw new Error('Missing copy feedback during layout check')
    return [...document.querySelectorAll('h1, a, textarea, button')]
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < toast.right &&
          rect.right > toast.left &&
          rect.top < toast.bottom &&
          rect.bottom > toast.top
        )
      })
      .map((element) => element.getAttribute('data-test') ?? element.tagName)
  })
  expect(overlaps).toEqual([])
}

headedTest.describe.configure({ timeout: 150_000 })

headedTest.describe('文档输入与文本窗：真实扩展 + 真实 Chromium', () => {
  headedTest.skip(process.env.E2E_LIVE !== '1', 'Live editor smoke tests require E2E_LIVE=1')

  headedTest('独立文本窗：粘贴多行 Markdown → 翻译 → 复制/清空/取消，窄视口无横向溢出并截图', async ({
    context,
    extensionId,
    extension,
  }) => {
    const api = await startMock()
    try {
      await extension.setSettings({ uiLanguage: 'zh-CN' })

      const page = await context.newPage()
      await page.goto(`chrome-extension://${extensionId}/translate.html`)
      const focusSession = await context.newCDPSession(page)
      await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      await focusSession.detach()
      const input = page.locator('[data-test="wt-text-input"]')
      await expect(input).toBeVisible({ timeout: 20000 })

      const markdown = '# 标题\n\n**加粗**与`代码`\n\n- 第一项\n- 第二项'
      await input.fill(markdown)

      const [options] = await Promise.all([
        context.waitForEvent('page'),
        page.locator('[data-test="wt-text-configure"]').click(),
      ])
      await expect(options).toHaveURL(/options\.html#wt-title$/)
      expect(page.url()).toContain('translate.html')
      await expect(input).toHaveValue(markdown)

      await saveModelConfig(options, api.url)
      api.setTextTranslator(modelTranslator)
      await page.bringToFront()
      await expect(input).toHaveValue(markdown)

      await page.locator('[data-test="wt-text-translate"]').click()
      const result = page.locator('[data-test="wt-text-result"]')
      await expect(result).toHaveValue(/ENTRANSLATED:|EN:/, { timeout: 20000 })
      const translated = await result.inputValue()
      expect(translated.length).toBeGreaterThan(0)

      await page.locator('[data-test="wt-text-copy"]').click()
      await expect(page.getByText('已复制', { exact: true })).toBeVisible()
      await page.locator('[data-test="wt-text-clear"]').click()
      await expect(input).toHaveValue('')
      await expect(result).toHaveValue('')

      await input.fill('待取消文本')
      api.hold('待取消文本')
      await page.locator('[data-test="wt-text-translate"]').click()
      const cancel = page.locator('[data-test="wt-text-cancel"]')
      await expect(cancel).toBeVisible({ timeout: 10000 })
      await cancel.click()
      await expect(cancel).toHaveCount(0, { timeout: 10000 })
      try {
        api.release('待取消文本', true)
      } catch {
        void 0
      }

      await page.setViewportSize({ width: 1000, height: 760 })
      await input.fill(markdown)
      await page.locator('[data-test="wt-text-translate"]').click()
      await expect(result).toHaveValue(/EN:/, { timeout: 20000 })
      const shot = test.info().outputPath('translate-window-1000x760.png')
      await page.screenshot({ path: shot })
      await expectCopyFeedback(page, 'text-zh-CN-copy-actions-1000.png')
      await page.setViewportSize({ width: 400, height: 800 })
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1)

      const stableResult = await result.inputValue()
      const callsBefore = api.calls.length
      for (const [uiLanguage, title] of [
        ['zh-CN', '文本翻译'],
        ['zh-TW', '文字翻譯'],
        ['en', 'Text translation'],
        ['ja', 'テキスト翻訳'],
        ['ko', '텍스트 번역'],
      ] as const) {
        await extension.setSettings({ uiLanguage, uiStyle: 'glass', theme: 'dark' })
        await expect(page.locator('html')).toHaveAttribute('lang', uiLanguage)
        await expect(page.locator('h1')).toHaveText(title)
        await expect(input).toHaveValue(markdown)
        await expect(result).toHaveValue(stableResult)
        if (uiLanguage === 'en') {
          await expectCopyFeedback(page, 'text-en-copy-actions-400.png')
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(1)
        await page.screenshot({ path: test.info().outputPath(`text-${uiLanguage}-glass-dark-400.png`) })
      }
      expect(api.calls.length).toBe(callsBefore)
      await extension.setSettings({ uiLanguage: 'en', uiStyle: 'glass', theme: 'dark' })
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      await page.setViewportSize({ width: 800, height: 900 })
      const initialDpr = await page.evaluate(() => window.devicePixelRatio)
      const zoom = await extension.page.evaluate(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: ChromeApiLike }
        const [tab] = await chrome.tabs.query({ url })
        if (tab?.id === undefined) throw new Error('Missing text window tab')
        await chrome.tabs.setZoom(tab.id, 2)
        return chrome.tabs.getZoom(tab.id)
      }, page.url())
      expect(zoom).toBe(2)
      await expect
        .poll(() => page.evaluate(() => window.devicePixelRatio))
        .toBeCloseTo(initialDpr * 2, 2)
      await expectCopyFeedback(page, 'text-en-copy-actions-browser-200.png')
      const geometry = await page.evaluate(() => ({
        dpr: window.devicePixelRatio,
        cssZoom: getComputedStyle(document.documentElement).zoom,
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }))
      expect(geometry.cssZoom).toBe('1')
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
      const geometryPath = test.info().outputPath('text-browser-zoom.json')
      await writeFile(geometryPath, JSON.stringify({ zoom, initialDpr, ...geometry }, null, 2))
      await test.info().attach('text-browser-zoom', {
        path: geometryPath,
        contentType: 'application/json',
      })
      await input.fill('中'.repeat(6001))
      await expect(input).toHaveAttribute('aria-invalid', 'true')
      await expect(page.locator('[data-test="wt-text-translate"]')).toBeDisabled()
      expect(api.calls.length).toBe(callsBefore)
    } finally {
      await api.close()
    }
  })

  headedTest('CKEditor5（texteditor.cn）：原生 Alt+Y 纯文本替换并可还原，富文本仅预览不写回', async ({
    context,
    extensionId,
    extension,
  }) => {
    const api = await startMock()
    const blockedWrites = await blockExternalWrites(context)
    try {
      await extension.setSettings({})
      const options = await openOptions(context, extensionId)
      await saveModelConfig(options, api.url)
      await enableInputTranslation(options)
      api.setTextTranslator(modelTranslator)

      const targetUrl = 'https://texteditor.cn/'
      await waitForSiteScriptRegistration(extension.page, { url: targetUrl })

      const page = await context.newPage()
      await page.goto(targetUrl, { timeout: 30_000 })
      await page.waitForFunction(
        () => {
          const candidates = [
            ...document.querySelectorAll('.ck-editor__editable'),
            ...document.querySelectorAll('[contenteditable="true"]'),
          ]
          return candidates.some(
            (el) => (el as { ckeditorInstance?: unknown }).ckeditorInstance !== undefined,
          )
        },
        undefined,
        { timeout: 30_000 },
      )

      const readCk = (): Promise<string | null> =>
        page.evaluate(() => {
          const candidates = [
            ...document.querySelectorAll('.ck-editor__editable'),
            ...document.querySelectorAll('[contenteditable="true"]'),
          ]
          const el = candidates.find(
            (node) => (node as { ckeditorInstance?: unknown }).ckeditorInstance !== undefined,
          ) as (HTMLElement & { ckeditorInstance?: { getData(): string } }) | undefined
          return el?.ckeditorInstance?.getData() ?? null
        })

      const setCk = (html: string): Promise<void> =>
        page.evaluate((source) => {
          const candidates = [
            ...document.querySelectorAll('.ck-editor__editable'),
            ...document.querySelectorAll('[contenteditable="true"]'),
          ]
          const el = candidates.find(
            (node) => (node as { ckeditorInstance?: unknown }).ckeditorInstance !== undefined,
          ) as (HTMLElement & { ckeditorInstance?: {
            setData?(data: string): void
            data?: { set(data: string): void }
          } }) | undefined
          const editor = el?.ckeditorInstance
          if (editor === undefined) throw new Error('ckeditor instance missing')
          if (typeof editor.setData === 'function') editor.setData(source)
          else editor.data?.set(source)
        }, html)

      const focusCk = (): Promise<void> =>
        page.evaluate(() => {
          const candidates = [
            ...document.querySelectorAll('.ck-editor__editable'),
            ...document.querySelectorAll('[contenteditable="true"]'),
          ]
          const el = candidates.find(
            (node) => (node as { ckeditorInstance?: unknown }).ckeditorInstance !== undefined,
          ) as HTMLElement | undefined
          el?.focus()
        })

      await setCk('<p>你好</p><p>第二行</p>')
      await expect.poll(readCk).toContain('你好')
      const originalHtml = await readCk()
      await focusCk()

      await inspectClosedShadowPage(page)
      const docHost = page.locator('[data-wt-root]:has([data-action="hint"])')
      const status = docHost.locator('[role="status"]')
      const shortcut = await sendOwnedBrowserAltShortcut(page, 'Y', async () => {
        await inspectClosedShadowPage(page)
        return (await status.isVisible().catch(() => false)) && (await status.textContent()) === 'Hello\nWorld'
      })
      await test.info().attach('native-input-shortcut', {
        body: Buffer.from(JSON.stringify(shortcut)),
        contentType: 'application/json',
      })
      expect(shortcut.sent, shortcut.reason).toBe(true)

      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? status.textContent() : ''
        }, { timeout: 15000 })
        .toBe('Hello\nWorld')
      const replace = docHost.locator('button[data-action="replace"]')
      await expect(replace).toBeVisible()
      await page.screenshot({ path: test.info().outputPath('ckeditor-preview.png') })

      await replace.click()
      await expect.poll(readCk).toContain('Hello')
      const afterReplace = await readCk()
      expect(afterReplace).toContain('World')
      expect(afterReplace).not.toContain('你好')
      await page.screenshot({ path: test.info().outputPath('ckeditor-replaced.png') })

      await docHost.locator('button[data-action="restore"]').click()
      await expect.poll(readCk).toBe(originalHtml)
      await expect(docHost.locator('.popover')).toBeHidden()
      await page.screenshot({ path: test.info().outputPath('ckeditor-restored.png') })

      await focusCk()
      await page.keyboard.type('追加')
      await expect.poll(readCk).toContain('追加')

      await setCk('<p><strong>你好</strong></p>')
      await focusCk()
      await sendTranslateInput(extension.page, targetUrl, 0)
      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? status.textContent() : ''
        }, { timeout: 15000 })
        .toBe('EN:你好')
      await expect(replace).toBeHidden()
      const boldState = await readCk()
      expect(boldState).toContain('strong')
      expect(boldState).toContain('你好')

      expect(blockedWrites.filter((entry) => entry.includes('127.0.0.1'))).toEqual([])
      expect(api.calls.length).toBeGreaterThan(0)
    } finally {
      await api.close()
    }
  })

  headedTest('TinyMCE4（cn.anotepad.com/richtext）：原生 Alt+Y 按需注入帧桥读写并可还原，无外发保存', async ({
    context,
    extensionId,
    extension,
  }) => {
    const api = await startMock()
    const blockedWrites = await blockExternalWrites(context)
    try {
      await extension.setSettings({})
      const options = await openOptions(context, extensionId)
      await saveModelConfig(options, api.url)
      await enableInputTranslation(options)
      api.setTextTranslator(modelTranslator)

      const targetUrl = 'https://cn.anotepad.com/richtext'
      await waitForSiteScriptRegistration(extension.page, { url: targetUrl })

      const page = await context.newPage()
      await page.goto(targetUrl, { timeout: 30_000 })

      const findEditorFrame = async (): Promise<Frame> => {
        let lastError = ''
        for (const frame of page.frames()) {
          try {
            const ready = await frame.evaluate(
              () => document.querySelector('.mce-content-body') !== null,
            )
            if (ready) return frame
          } catch (error) {
            lastError = `${frame.url()}: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        throw new Error(`TinyMCE frame not found (${lastError})`)
      }
      await expect
        .poll(async () => {
          try {
            await findEditorFrame()
            return true
          } catch {
            return false
          }
        }, { timeout: 30_000 })
        .toBe(true)
      const editorFrame = await findEditorFrame()

      await page.evaluate(() => {
        for (const frame of document.querySelectorAll('iframe')) {
          try {
            if (frame.contentDocument?.querySelector('.mce-content-body')) {
              frame.setAttribute('data-wt-e2e-frame', '')
            }
          } catch {
            void 0
          }
        }
      })

      const tinyInTop = await page.evaluate(() => {
        const tiny = (window as { tinymce?: { editors?: unknown[] } }).tinymce
        return Array.isArray(tiny?.editors) && tiny.editors.length > 0
      })
      const tinyScope = tinyInTop ? page : editorFrame
      await tinyScope.evaluate(() => {
        const tiny = (window as { tinymce?: { editors?: Array<{ setContent(html: string): void }> } }).tinymce
        tiny?.editors?.[0]?.setContent('<p>你好<br>第二行</p>')
      })
      const readTinyText = (): Promise<string> =>
        tinyScope.evaluate(() => {
          const tiny = (window as { tinymce?: { editors?: Array<{ getContent(options?: { format: string }): string }> } }).tinymce
          return tiny?.editors?.[0]?.getContent({ format: 'text' }) ?? ''
        })
      await expect.poll(readTinyText).toContain('你好')
      const originalText = await readTinyText()

      const editorScope = page.frameLocator('iframe[data-wt-e2e-frame]')
      const docHost = editorScope.locator('[data-wt-root]:has([data-action="hint"])')
      const status = docHost.locator('[role="status"]')

      const body = editorFrame.locator('.mce-content-body')
      await body.click()
      const shortcut = await sendOwnedBrowserAltShortcut(page, 'Y', async () => {
        await inspectClosedShadowPage(page)
        return (await status.isVisible().catch(() => false)) && (await status.textContent()) === 'Hello\nWorld'
      })
      await test.info().attach('native-input-shortcut', {
        body: Buffer.from(JSON.stringify(shortcut)),
        contentType: 'application/json',
      })
      expect(shortcut.sent, shortcut.reason).toBe(true)

      await expect
        .poll(async () => {
          await inspectClosedShadowPage(page)
          return (await status.isVisible().catch(() => false)) ? status.textContent() : ''
        }, { timeout: 20000 })
        .toBe('Hello\nWorld')

      const replace = docHost.locator('button[data-action="replace"]')
      await expect(replace).toBeVisible()
      await page.screenshot({ path: test.info().outputPath('tinymce-preview.png') })
      await replace.click()

      await expect
        .poll(async () => {
          const text = await readTinyText()
          return text.includes('Hello') && text.includes('World') ? text : ''
        }, { timeout: 20000 })
        .not.toBe('')
      const finalText = await readTinyText()
      expect(finalText).not.toContain('你好')
      const finalHtml = await tinyScope.evaluate(() => {
        const tiny = (window as { tinymce?: { editors?: Array<{ getContent(): string }> } }).tinymce
        return tiny?.editors?.[0]?.getContent() ?? ''
      })
      expect(finalHtml).toContain('Hello')
      await page.screenshot({ path: test.info().outputPath('tinymce-replaced.png') })

      await docHost.locator('button[data-action="restore"]').click()
      await expect.poll(readTinyText).toBe(originalText)
      await expect(docHost.locator('.popover')).toBeHidden()
      await page.screenshot({ path: test.info().outputPath('tinymce-restored.png') })

      const blockedLocal = blockedWrites.filter((entry) => entry.includes('127.0.0.1'))
      expect(blockedLocal).toEqual([])
      expect(api.calls.length).toBeGreaterThan(0)
    } finally {
      await api.close()
    }
  })
  for (const version of [5, 6] as const) {
    headedTest(`CodeMirror ${version} 官方线上编辑器：预览、替换、还原与继续编辑`, async ({ context, extensionId, extension }, info) => {
      const api = await startMock()
      await blockExternalWrites(context)
      try {
        await extension.setSettings({ uiLanguage: 'zh-CN' })
        const options = await openOptions(context, extensionId)
        await saveModelConfig(options, api.url)
        await enableInputTranslation(options)
        api.setTextTranslator(modelTranslator)
        const targetUrl = version === 5 ? 'https://codemirror.net/5/demo/placeholder.html' : 'https://codemirror.net/'
        await waitForSiteScriptRegistration(extension.page, { url: targetUrl })
        const page = await context.newPage()
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        const editor = page.locator(version === 5 ? '.CodeMirror' : '.cm-content').first()
        await expect(editor).toBeVisible({ timeout: 30000 })
        const readModel = () => page.evaluate((v) => {
          if (v === 5) {
            const root = document.querySelector('.CodeMirror') as HTMLElement & { CodeMirror?: { getValue(): string } }
            return root?.CodeMirror?.getValue() ?? null
          }
          const content = document.querySelector('.cm-content') as HTMLElement & { cmView?: unknown; cmTile?: { root?: { view?: { state?: { doc?: { toString(): string } } } } } }
          if (content.cmTile?.root?.view?.state?.doc) return content.cmTile.root.view.state.doc.toString()
          let candidate: unknown = content?.cmView
          for (let depth = 0; depth < 10 && candidate; depth++) {
            const current = candidate as { view?: { contentDOM?: Element; state?: { doc?: { toString(): string } } }; parent?: unknown }
            if (current.view?.contentDOM === content) return current.view.state?.doc?.toString() ?? null
            candidate = current.parent
          }
          return null
        }, version)
        await editor.click()
        await page.keyboard.press('Control+a')
        await page.keyboard.insertText('你好\n第二行')
        await expect.poll(readModel).toBe('你好\n第二行')
        const host = page.locator('[data-wt-root]:has([data-action="hint"])')
        const status = host.locator('[role="status"]')
        const preview = async () => {
          const shortcut = await sendOwnedBrowserAltShortcut(page, 'Y', async () => {
            await inspectClosedShadowPage(page)
            return await status.isVisible().catch(() => false) && await status.textContent() === 'Hello\nWorld'
          })
          expect(shortcut.sent, shortcut.reason).toBe(true)
          await expect.poll(async () => {
            await inspectClosedShadowPage(page)
            return await status.isVisible().catch(() => false) ? status.textContent() : ''
          }).toBe('Hello\nWorld')
        }
        await preview()
        const replace = host.locator('[data-action="replace"]')
        await expect(replace).toBeVisible()
        await page.screenshot({ path: info.outputPath(`cm${version}-preview.png`) })
        await replace.click()
        await expect.poll(readModel).toBe('Hello\nWorld')
        await page.screenshot({ path: info.outputPath(`cm${version}-replaced.png`) })
        await host.locator('[data-action="restore"]').click()
        await expect.poll(readModel).toBe('你好\n第二行')
        await expect(host.locator('.popover')).toBeHidden()
        await editor.click()
        await preview()
        await replace.click()
        await expect.poll(readModel).toBe('Hello\nWorld')
        await page.keyboard.insertText('追加')
        await expect.poll(readModel).toContain('追加')
        await expect(host.locator('[data-action="restore"]')).toBeHidden()
        await page.screenshot({ path: info.outputPath(`cm${version}-continued-edit.png`) })
        await info.attach('real-site-result', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ targetUrl, version, modelText: await readModel(), mockCalls: api.calls.length, shortcutCoverage: true })) })
      } finally { await api.close() }
    })
  }
})
