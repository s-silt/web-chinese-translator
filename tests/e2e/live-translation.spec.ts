import { test, expect, type Page } from '@playwright/test'
import zhCN from '../../src/i18n/zh-CN'
import { inspectClosedShadowPage, installClosedShadowInspection } from './closed-shadow'
import { createTranslationModuleUrls } from './translation-module-fixture'

/** 组件入口；运行时依赖从源码的相对导入自动收集，入口新增依赖时不必手工维护清单 */
const ENTRY_FILES = ['input-translation.ts'] as const

interface LiveFixturePageWindow extends Window {
  __wtCalls: Array<{ readonly texts: string[]; readonly requestId: string }>
  __wtCanceled: string[]
  __wtNextMode: 'auto' | 'manual' | 'malicious'
  __wtDelayMs: number
  __wtResolveManual?: (texts: string[]) => void
  __wtWatcher?: { dispose(): void }
}

async function mountLiveTranslationModule(page: Page): Promise<void> {
  const blobUrls = await createTranslationModuleUrls(page, ENTRY_FILES)

  const entryUrl = blobUrls['./input-translation']!

  await page.evaluate(
    ({ messages }) => {
      const w = window as unknown as LiveFixturePageWindow & { __wtMessages: Record<string, string> }
      w.__wtCalls = []
      w.__wtCanceled = []
      w.__wtNextMode = 'auto'
      w.__wtDelayMs = 500
      w.__wtMessages = messages
    },
    { messages: zhCN as Record<string, string> },
  )

  await page.addScriptTag({
    type: 'module',
    content: `
      import { createInputTranslation } from '${entryUrl}';
      const w = window;
      w.__wtWatcher = createInputTranslation({
        autoReplaceDelayMs: () => w.__wtDelayMs,
        translate: (texts, requestId) => {
          w.__wtCalls.push({ texts: [...texts], requestId });
          if (w.__wtNextMode === 'manual') {
            return new Promise((resolve) => {
              w.__wtResolveManual = (outTexts) => resolve({ ok: true, texts: outTexts });
            });
          }
          if (w.__wtNextMode === 'malicious') {
            return Promise.resolve({
              ok: true,
              texts: texts.map(() => '<img src="x" onerror="window.__xss=1"><script>window.__xss=2</script>'),
            });
          }
          return Promise.resolve({
            ok: true,
            texts: texts.map((t) =>
              t === '你好\\n\\n世界'
                ? 'Hello\\n\\nWorld'
                : t === '第一行\\n第二行'
                  ? 'Line one\\nLine two'
                  : 'Translated: ' + t
            ),
          });
        },
        cancel: (requestId) => {
          w.__wtCanceled.push(requestId);
        },
        t: (key) => w.__wtMessages[key] ?? key,
      });
    `,
  })

  await page.waitForFunction(() =>
    typeof (window as unknown as LiveFixturePageWindow).__wtWatcher?.dispose === 'function',
  )

  await page.evaluate((urls) => {
    for (const u of Object.values(urls)) URL.revokeObjectURL(u)
  }, blobUrls)
  await inspectClosedShadowPage(page)
}

test.describe('离线 Chromium 组件级真实 DOM 与事件验证（非真实站点/非扩展后台 E2E）', () => {
  test('输入翻译组件：停输自动直写、重新输入重置等待、在途过期丢弃、多行保留、原生 setter 监听、焦点保持、无请求还原与恶意返回纯文本安全', async ({
    page,
  }) => {
    await installClosedShadowInspection(page.context())
    await page.route('**/*', async (route) => {
      if (route.request().url() === 'https://app.example.test/input') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body>
                <form id="chat-form" style="display:flex;flex-direction:column;gap:140px">
                  <textarea id="draft-area" rows="4" style="width:320px;height:80px"></textarea>
                  <div id="plain-ce" contenteditable="true" style="width:320px;min-height:60px;border:1px solid #ccc"></div>
                </form>
              </body>
            </html>`,
        })
        return
      }
      await route.abort()
    })

    await page.goto('https://app.example.test/input')
    await page.evaluate(() => {
      const w = window as unknown as {
        __observedInputEvents: Array<{ targetId: string; value: string; inputType: string }>
        __observedKeyOrSubmit: string[]
      }
      w.__observedInputEvents = []
      w.__observedKeyOrSubmit = []
      const form = document.getElementById('chat-form')!
      const area = document.getElementById('draft-area') as HTMLTextAreaElement
      area.addEventListener('input', (e) => {
        w.__observedInputEvents.push({
          targetId: 'draft-area',
          value: area.value,
          inputType: (e as InputEvent).inputType ?? '',
        })
      })
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        w.__observedKeyOrSubmit.push('submit')
      })
    })

    await mountLiveTranslationModule(page)

    const textarea = page.locator('#draft-area')
    await textarea.click()
    await page.evaluate(() => {
      ;(window as unknown as LiveFixturePageWindow).__wtDelayMs = 800
    })
    await textarea.fill('半途输入')
    await page.waitForTimeout(450)
    expect(await page.evaluate(() => (window as unknown as LiveFixturePageWindow).__wtCalls.length)).toBe(0)
    await textarea.fill('第一行\n第二行')
    await page.waitForTimeout(450)
    expect(await page.evaluate(() => (window as unknown as LiveFixturePageWindow).__wtCalls.length)).toBe(0)
    await expect(textarea).toHaveValue('第一行\n第二行')

    await page.evaluate(() => {
      const w = window as unknown as { __observedKeyOrSubmit: string[] }
      window.addEventListener('keydown', () => w.__observedKeyOrSubmit.push('keydown'), true)
      window.addEventListener('keypress', () => w.__observedKeyOrSubmit.push('keypress'), true)
      window.addEventListener('keyup', () => w.__observedKeyOrSubmit.push('keyup'), true)
    })

    await expect(textarea).toHaveValue('Line one\nLine two', { timeout: 5_000 })
    await expect(page.locator('[data-wt-root]')).toBeAttached()
    await inspectClosedShadowPage(page)
    const status = page.locator('[data-wt-root] [role="status"]')
    const restoreBtn = page.locator('[data-wt-root] button[data-action="restore"]')
    await expect(restoreBtn).toBeVisible()
    await expect(page.locator('[data-wt-root] button[data-action="replace"]')).toBeHidden()
    await expect(status).not.toHaveText('Line one\nLine two')
    await expect(status).not.toHaveText('')
    await expect
      .poll(() =>
        page
          .locator('[data-wt-root]')
          .evaluate((element) => getComputedStyle(element).getPropertyValue('--gcn-font-latin')),
      )
      .toContain('Segoe UI')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft-area')

    const observedAfterReplace = await page.evaluate(() => {
      const w = window as unknown as {
        __observedInputEvents: Array<{ targetId: string; value: string; inputType: string }>
        __observedKeyOrSubmit: string[]
      }
      return {
        inputs: w.__observedInputEvents,
        keyOrSubmit: w.__observedKeyOrSubmit,
      }
    })
    expect(observedAfterReplace.inputs.at(-1)).toEqual({
      targetId: 'draft-area',
      value: 'Line one\nLine two',
      inputType: 'insertReplacementText',
    })
    expect(observedAfterReplace.keyOrSubmit).toEqual([])

    const callsBeforeRestore = await page.evaluate(() => (window as unknown as LiveFixturePageWindow).__wtCalls.length)
    await restoreBtn.click()
    await expect(textarea).toHaveValue('第一行\n第二行')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft-area')
    await expect(status).toHaveText('')
    await expect(page.locator('[data-wt-root] .popover')).toBeHidden()
    await expect(textarea).toBeFocused()
    await page.waitForTimeout(900)
    expect(await page.evaluate(() => (window as unknown as LiveFixturePageWindow).__wtCalls.length)).toBe(callsBeforeRestore)

    await page.evaluate(() => {
      const w = window as unknown as LiveFixturePageWindow
      w.__wtDelayMs = 500
      w.__wtNextMode = 'manual'
    })
    await textarea.fill('在途慢请求')
    await expect
      .poll(() => page.evaluate(() => (window as unknown as LiveFixturePageWindow).__wtCalls.length))
      .toBe(callsBeforeRestore + 1)
    await textarea.fill('已经改写的新草稿')
    await page.evaluate(() => {
      const w = window as unknown as LiveFixturePageWindow
      w.__wtResolveManual?.(['Stale translation should not write'])
      w.__wtNextMode = 'auto'
    })
    await page.waitForTimeout(200)
    await expect(textarea).not.toHaveValue('Stale translation should not write')
    await expect(textarea).toHaveValue('Translated: 已经改写的新草稿', { timeout: 5_000 })
    await inspectClosedShadowPage(page)
    await restoreBtn.click()
    await expect(textarea).toHaveValue('已经改写的新草稿')
    await expect(page.locator('[data-wt-root] .popover')).toBeHidden()

    const editable = page.locator('#plain-ce')
    await editable.click()
    await page.evaluate(() => {
      const el = document.getElementById('plain-ce')!
      el.innerHTML = '<div>你好</div><div><br></div><div>世界</div>'
    })
    await page.keyboard.insertText('！')
    await page.keyboard.press('Backspace')

    await expect
      .poll(() => editable.evaluate((el) => el.innerHTML), { timeout: 5_000 })
      .toBe('Hello<br><br>World')
    await inspectClosedShadowPage(page)
    await expect(restoreBtn).toBeVisible()
    await expect(page.locator('[data-wt-root] button[data-action="replace"]')).toBeHidden()
    await expect(status).not.toHaveText('Hello\n\nWorld')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('plain-ce')

    await restoreBtn.click()
    expect(await editable.evaluate((el) => el.innerHTML)).toBe('你好<br><br>世界')
    await expect(status).toHaveText('')
    await expect(page.locator('[data-wt-root] .popover')).toBeHidden()
    await expect(editable).toBeFocused()

    await page.evaluate(() => {
      ;(window as unknown as LiveFixturePageWindow).__wtNextMode = 'malicious'
    })
    await textarea.click()
    await textarea.fill('测试安全转义')
    await expect(textarea).toHaveValue('<img src="x" onerror="window.__xss=1"><script>window.__xss=2</script>', {
      timeout: 5_000,
    })
    await inspectClosedShadowPage(page)
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  })

  test('视频字幕模块已移除且整页扫描排除字幕容器（YouTube 与 Netflix 字幕节点命中排除规则）', async ({
    page,
  }) => {
    await expect(createTranslationModuleUrls(page, ['subtitles.ts'])).rejects.toThrow()
    await expect(createTranslationModuleUrls(page, ['subtitle-source.ts'])).rejects.toThrow()

    await page.route('**/*', async (route) => {
      const url = route.request().url()
      if (url === 'https://www.youtube.com/watch?v=fixture') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body>
                <p id="normal-text">Normal paragraph</p>
                <div id="movie_player" class="html5-video-player">
                  <div class="ytp-caption-window-container">
                    <span id="yt-seg" class="ytp-caption-segment">Hello from YouTube fixture</span>
                  </div>
                </div>
                <div class="watch-video--player-view">
                  <div class="player-timedtext">
                    <div class="player-timedtext-text-container">
                      <span id="nf-seg">Netflix synthetic subtitle</span>
                    </div>
                  </div>
                </div>
              </body>
            </html>`,
        })
        return
      }
      await route.abort()
    })

    await page.goto('https://www.youtube.com/watch?v=fixture')
    const blobUrls = await createTranslationModuleUrls(page, ['sites.ts'])
    await page.addScriptTag({
      type: 'module',
      content: `
        import { isExcludedElement } from '${blobUrls['./sites']!}';
        window.__wtExcludedCheck = {
          normal: isExcludedElement(document.getElementById('normal-text')),
          yt: isExcludedElement(document.getElementById('yt-seg')),
          nf: isExcludedElement(document.getElementById('nf-seg')),
        };
      `,
    })
    await page.waitForFunction(() => Boolean((window as unknown as { __wtExcludedCheck?: unknown }).__wtExcludedCheck))
    const check = await page.evaluate(
      () => (window as unknown as { __wtExcludedCheck: { normal: boolean; yt: boolean; nf: boolean } }).__wtExcludedCheck,
    )
    expect(check).toEqual({ normal: false, yt: true, nf: true })
  })
})
