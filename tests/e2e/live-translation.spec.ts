import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import ts from 'typescript'
import zhCN from '../../src/i18n/zh-CN'
import { inspectClosedShadowPage, installClosedShadowInspection } from './closed-shadow'

/** 组件入口；运行时依赖从源码的相对导入自动收集，入口新增依赖时不必手工维护清单 */
const ENTRY_FILES = ['input-translation.ts', 'subtitles.ts'] as const
const TRANSLATION_DIR = resolve(import.meta.dirname, '../../src/translation')

interface LiveFixturePageWindow extends Window {
  __wtCalls: Array<{ readonly texts: string[]; readonly requestId: string }>
  __wtCanceled: string[]
  __wtNextMode: 'auto' | 'manual' | 'malicious'
  __wtResolveManual?: (texts: string[]) => void
  __wtWatcher?: { dispose(): void }
}

/** 转译后仍保留的相对导入（仅类型的导入已被擦除），依赖在前、入口在后 */
async function transpileLiveModules(): Promise<Array<{ readonly spec: string; readonly code: string }>> {
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  }
  const ordered: Array<{ readonly spec: string; readonly code: string }> = []
  const visited = new Set<string>()
  async function visit(file: string, chain: readonly string[]): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const raw = await readFile(resolve(TRANSLATION_DIR, file), 'utf8')
    const code = ts.transpileModule(raw, { compilerOptions }).outputText
    for (const match of code.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]!
      // 只支持同目录模块：越出 src/translation 的依赖说明组件不再适合在页面里单独挂载
      if (!/^\.\/[\w-]+$/.test(spec)) {
        throw new Error(`${[...chain, file].join(' → ')} 导入了 ${spec}，组件夹具只支持同目录模块`)
      }
      await visit(`${spec.slice(2)}.ts`, [...chain, file])
    }
    ordered.push({ spec: `./${file.replace(/\.ts$/, '')}`, code })
  }
  for (const entry of ENTRY_FILES) await visit(entry, [])
  return ordered
}

async function mountLiveTranslationModule(
  page: Page,
  kind: 'input' | 'subtitles',
): Promise<void> {
  const modules = await transpileLiveModules()
  const blobUrls = await page.evaluate(
    ({ list }) => {
      const urlMap: Record<string, string> = {}
      for (const item of list) {
        let rewritten = item.code
        for (const [spec, blobUrl] of Object.entries(urlMap)) {
          rewritten = rewritten
            .replaceAll(`from '${spec}'`, `from '${blobUrl}'`)
            .replaceAll(`from "${spec}"`, `from "${blobUrl}"`)
        }
        urlMap[item.spec] = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
      }
      return urlMap
    },
    { list: modules },
  )

  const entryUrl = kind === 'input' ? blobUrls['./input-translation']! : blobUrls['./subtitles']!
  const factoryName = kind === 'input' ? 'createInputTranslation' : 'createSubtitleTranslation'

  await page.evaluate(
    ({ messages }) => {
      const w = window as unknown as LiveFixturePageWindow & { __wtMessages: Record<string, string> }
      w.__wtCalls = []
      w.__wtCanceled = []
      w.__wtNextMode = 'auto'
      w.__wtMessages = messages
    },
    { messages: zhCN as Record<string, string> },
  )

  await page.addScriptTag({
    type: 'module',
    content: `
      import { ${factoryName} } from '${entryUrl}';
      const w = window;
      w.__wtWatcher = ${factoryName}({
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
  test('输入翻译组件：真实输入、预览、确认替换、多行保留、原生 setter 监听、焦点保持、还原与恶意返回纯文本安全', async ({
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

    await mountLiveTranslationModule(page, 'input')

    const textarea = page.locator('#draft-area')
    await textarea.click()
    await textarea.fill('第一行\n第二行')

    await expect(page.locator('[data-wt-root]')).toBeAttached()
    await inspectClosedShadowPage(page)
    const status = page.locator('[data-wt-root] [role="status"]')
    await expect(status).toHaveText('Line one\nLine two')

    await page.evaluate(() => {
      const w = window as unknown as { __observedKeyOrSubmit: string[] }
      window.addEventListener('keydown', () => w.__observedKeyOrSubmit.push('keydown'), true)
      window.addEventListener('keypress', () => w.__observedKeyOrSubmit.push('keypress'), true)
      window.addEventListener('keyup', () => w.__observedKeyOrSubmit.push('keyup'), true)
    })

    await page.locator('[data-wt-root] button[data-action="replace"]').click()
    await expect(textarea).toHaveValue('Line one\nLine two')
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

    await page.locator('[data-wt-root] button[data-action="restore"]').click()
    await expect(textarea).toHaveValue('第一行\n第二行')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft-area')

    const editable = page.locator('#plain-ce')
    await editable.click()
    await page.evaluate(() => {
      const el = document.getElementById('plain-ce')!
      el.innerHTML = '<div>你好</div><div><br></div><div>世界</div>'
    })
    await page.keyboard.insertText('！')
    await page.keyboard.press('Backspace')

    await inspectClosedShadowPage(page)
    await expect(status).toHaveText('Hello\n\nWorld')
    await page.locator('[data-wt-root] button[data-action="replace"]').click()
    expect(await editable.evaluate((el) => el.innerHTML)).toBe('Hello<br><br>World')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('plain-ce')

    await page.locator('[data-wt-root] button[data-action="restore"]').click()
    expect(await editable.evaluate((el) => el.innerHTML)).toBe('你好<br><br>世界')

    await page.evaluate(() => {
      ;(window as unknown as LiveFixturePageWindow).__wtNextMode = 'malicious'
    })
    await textarea.click()
    await textarea.fill('测试安全转义')
    await inspectClosedShadowPage(page)
    await expect(status).toContainText('<img src="x"')
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
    await page.locator('[data-wt-root] button[data-action="replace"]').click()
    await expect(textarea).toHaveValue('<img src="x" onerror="window.__xss=1"><script>window.__xss=2</script>')
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  })

  test('字幕翻译组件：YouTube 与 Netflix 本地合成字幕夹具、切行清除、隐藏 CC 阻断、过期请求丢弃与 dispose 清理', async ({
    page,
  }) => {
    await installClosedShadowInspection(page.context())
    await page.route('**/*', async (route) => {
      const url = route.request().url()
      if (url === 'https://www.youtube.com/watch?v=fixture') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body>
                <div id="movie_player" class="html5-video-player" style="position:relative;width:640px;height:360px">
                  <video id="yt-video" style="width:640px;height:360px;display:block"></video>
                  <div class="ytp-caption-window-container">
                    <span class="ytp-caption-segment">Hello from YouTube fixture</span>
                  </div>
                </div>
              </body>
            </html>`,
        })
        return
      }
      if (url === 'https://www.netflix.com/watch/fixture') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <html>
              <body>
                <div class="watch-video--player-view" style="position:relative;width:640px;height:360px">
                  <video id="nf-video" style="width:640px;height:360px;display:block"></video>
                  <div class="player-timedtext">
                    <div class="player-timedtext-text-container">
                      <span>Netflix synthetic subtitle</span>
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
    await mountLiveTranslationModule(page, 'subtitles')
    await inspectClosedShadowPage(page)

    const bubble = page.locator('[data-wt-root] .bubble')
    await expect(bubble).toBeVisible()
    await expect(bubble).toHaveText('Translated: Hello from YouTube fixture')
    await expect(page.locator('.ytp-caption-segment')).toHaveText('Hello from YouTube fixture')

    await page.evaluate(() => {
      const w = window as unknown as LiveFixturePageWindow
      w.__wtNextMode = 'manual'
      const container = document.querySelector('.ytp-caption-window-container')!
      container.innerHTML = '<span class="ytp-caption-segment">Pending slow line</span>'
    })
    await expect(page.locator('[data-wt-root]')).toBeHidden()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as LiveFixturePageWindow).__wtCalls.length))
      .toBe(2)

    await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('.ytp-caption-window-container')!
      container.style.display = 'none'
    })
    await inspectClosedShadowPage(page)
    await expect(bubble).toHaveText(zhCN.wtSubtitleWaitingHint)

    await page.evaluate(() => {
      const w = window as unknown as LiveFixturePageWindow
      w.__wtResolveManual?.(['Stale slow translation'])
    })
    await expect(bubble).toHaveText(zhCN.wtSubtitleWaitingHint)

    await page.evaluate(() => {
      ;(window as unknown as LiveFixturePageWindow).__wtWatcher?.dispose()
    })
    await expect(page.locator('[data-wt-root]')).toHaveCount(0)

    await page.goto('https://www.netflix.com/watch/fixture')
    await mountLiveTranslationModule(page, 'subtitles')
    await inspectClosedShadowPage(page)

    const nfBubble = page.locator('[data-wt-root] .bubble')
    await expect(nfBubble).toBeVisible()
    await expect(nfBubble).toHaveText('Translated: Netflix synthetic subtitle')
    await expect(page.locator('.player-timedtext-text-container')).toHaveText('Netflix synthetic subtitle')

    await page.evaluate(() => {
      ;(window as unknown as LiveFixturePageWindow).__wtWatcher?.dispose()
    })
    await expect(page.locator('[data-wt-root]')).toHaveCount(0)
  })
})
