import { resolve } from 'node:path'
import { chromium as pwChromium, test as nativeTest } from '@playwright/test'
import {
  acceptOwnedPermission,
  CJK,
  expect,
  EXTENSION_PATH,
  inspectClosedShadowPage,
  installClosedShadowInspection,
  NATIVE_ACCESSIBILITY_ARGS,
  test,
  waitForSiteContentReady,
  waitForSiteScriptRegistration,
} from './fixtures'
import { startMock } from './mock-server'

/** 线上冒烟：访问真实 github.com（未登录），仅 E2E_LIVE=1 时执行 */
const LIVE = process.env.E2E_LIVE === '1'
const REPO = '/vuejs/core'

interface LiveTarget {
  readonly name: string
  readonly slug: string
  readonly path: string
  /** 页面含 README */
  readonly readme?: boolean
}

const TARGETS: readonly LiveTarget[] = [
  { name: '存储库首页', slug: 'repo', path: REPO, readme: true },
  { name: '议题列表', slug: 'issues', path: `${REPO}/issues` },
  { name: '拉取请求列表', slug: 'pulls', path: `${REPO}/pulls` },
  { name: '提交历史记录', slug: 'commits', path: `${REPO}/commits/main` },
]

test.describe('线上冒烟', () => {
  test.skip(!LIVE, '设置 E2E_LIVE=1 后运行（bun run test:e2e:live）')

  for (const target of TARGETS) {
    test(`${target.name} ${target.path}`, async ({ page }, testInfo) => {
      await page.goto(`https://github.com${target.path}`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)

      // 存储库标签页（按链接定位，不依赖已被翻译的 aria-label）
      const nav = page.locator(`nav:has(a[href="${REPO}/pulls"])`).first()
      await expect(nav.locator(`a[href="${REPO}"]`).first()).toContainText('代码')
      await expect(nav.locator(`a[href="${REPO}/issues"]`).first()).toContainText('议题')
      await expect(nav.locator(`a[href="${REPO}/pulls"]`).first()).toContainText('拉取请求')

      if (target.readme) {
        const readme = page.locator('article.markdown-body').first()
        await expect(readme).toBeVisible()
        expect(await readme.innerText()).not.toMatch(CJK)
      }

      await expect(page.locator('relative-time').first()).toHaveAttribute('lang', 'zh-CN')
      await expect.poll(() => page.locator('relative-time:not([lang="zh-CN"])').count()).toBe(0)

      const screenshot = resolve('test-results', `live-${target.slug}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`live-${target.slug}`, { path: screenshot, contentType: 'image/png' })
    })
  }
})

nativeTest.describe('视频字幕真实页面：公开 YouTube 提取与扩展覆盖层', () => {
  nativeTest('视频字幕真实页面：公开 YouTube 提取与扩展覆盖层', async () => {
    nativeTest.skip(process.env.WT_VIDEO_LIVE !== '1', 'Set WT_VIDEO_LIVE=1')
    const testInfo = nativeTest.info()
    const api = await startMock()
    api.setTextTranslator(() => '字幕链路测试译文')
    const context = await pwChromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        ...NATIVE_ACCESSIBILITY_ARGS,
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--lang=en-US',
        '--apps-gallery-install-auto-confirm-for-tests=accept',
      ],
    })
    try {
      await installClosedShadowInspection(context)
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
      const extensionId = new URL(worker.url()).host
      const options = await context.newPage()
      await options.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
      await options.evaluate(async () => {
        const { chrome } = globalThis as unknown as {
          chrome: {
            storage: {
              sync: {
                get(key: string): Promise<Record<string, unknown>>
                set(items: Record<string, unknown>): Promise<void>
              }
            }
          }
        }
        const stored = await chrome.storage.sync.get('settings')
        await chrome.storage.sync.set({ settings: { ...(stored.settings as object ?? {}), uiLanguage: 'zh-CN' } })
      })
      await options.getByPlaceholder(/api\.example\.com|v1/).fill(api.url)
      await options.locator('input[type="password"]').fill('sk-e2e-fake')
      await options.locator('[data-test="wt-model-input"]').fill('mock-model')
      await options.locator('[data-test="wt-save"]').click()
      const mockEndpoint = new URL(api.url)
      await acceptOwnedPermission(options, [`${mockEndpoint.protocol}//${mockEndpoint.hostname}/*`])
      await expect(options.getByText(/connection succeeded|连接成功/)).toBeVisible({ timeout: 15_000 })

      await options.locator('[data-test="nav-wt-general-title"]').click()
      await expect(options.locator('[data-test="wt-general-view"]')).toBeVisible()
      const videoToggle = options.locator('[data-test="wt-video-subtitles-toggle"] [role="switch"]')
      await expect(videoToggle).toHaveAttribute('aria-checked', 'false')
      await videoToggle.click()
      await acceptOwnedPermission(options, ['http://*/*', 'https://*/*'])
      await expect(videoToggle).toHaveAttribute('aria-checked', 'true')
      await expect(videoToggle).toBeEnabled()

      expect(
        await options.evaluate(async () => {
          const { chrome } = globalThis as unknown as {
            chrome: { runtime: { sendMessage(msg: unknown): Promise<{ ok: boolean; config?: Record<string, unknown> }> } }
          }
          return chrome.runtime.sendMessage({
            type: 'wt:save-config',
            patch: {
              selectionPopupEnabled: false,
              proactiveAssistEnabled: false,
              floatingButtonEnabled: false,
            },
          })
        }),
      ).toMatchObject({
        ok: true,
        config: {
          selectionPopupEnabled: false,
          proactiveAssistEnabled: false,
          floatingButtonEnabled: false,
          videoSubtitlesEnabled: true,
          autoOrigins: [],
        },
      })

      const targetUrl = 'https://www.youtube.com/watch?v=arj7oStGLkU'
      await waitForSiteScriptRegistration(options, { url: targetUrl })
      const callsAfterSetup = api.calls.length

      const page = await context.newPage()
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      const rejectButton = page
        .getByRole('button', { name: /Reject all|全部拒绝|拒絕全部/i })
        .first()
      if (await rejectButton.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await rejectButton.click()
      }

      const collectNarrowState = async () => {
        await inspectClosedShadowPage(page).catch(() => undefined)
        return page.evaluate(() => {
          const video = document.querySelector<HTMLVideoElement>('#movie_player video, video.html5-main-video, video')
          const segments = Array.from(document.querySelectorAll<HTMLElement>('.ytp-caption-segment'))
          const visibleSegments = segments.filter((el) => {
            const style = getComputedStyle(el)
            return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && (el.textContent ?? '').trim() !== ''
          })
          const bubble = document.querySelector<HTMLElement>('[data-wt-root] .bubble')
          const errEl = document.querySelector<HTMLElement>('.ytp-error, #error-screen')
          return {
            url: location.href,
            title: document.title,
            videoPresent: video !== null,
            paused: video?.paused ?? null,
            currentTime: video ? Math.round(video.currentTime * 100) / 100 : null,
            captionNodes: visibleSegments.length,
            overlayText: bubble && getComputedStyle(bubble).display !== 'none' ? (bubble.textContent ?? '').trim() : '',
            playerError: errEl && getComputedStyle(errEl).display !== 'none' ? (errEl.textContent ?? '').trim().slice(0, 120) : '',
          }
        })
      }

      try {
        await waitForSiteContentReady(options, page, { supported: true })
        const player = page.locator('#movie_player')
        await expect(player).toBeVisible({ timeout: 25_000 })
        const video = player.locator('video').first()
        await expect(video).toBeVisible({ timeout: 25_000 })

        await video.evaluate((el: HTMLVideoElement) => {
          el.muted = true
        })

        const isPaused = await video.evaluate((el: HTMLVideoElement) => el.paused)
        if (isPaused) {
          const largePlay = player.locator('.ytp-large-play-button')
          const playBtn = player.locator('.ytp-play-button')
          if (await largePlay.isVisible().catch(() => false)) {
            await largePlay.click()
          } else if (await playBtn.isVisible().catch(() => false)) {
            await playBtn.click()
          } else {
            await player.click()
          }
        }

        const deadline = Date.now() + 60_000
        let captionFound = false
        while (Date.now() < deadline) {
          await page.bringToFront()
          const skipAd = player.locator('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern').first()
          if (await skipAd.isVisible().catch(() => false)) {
            await skipAd.click().catch(() => undefined)
          }
          const adShowing = await player.evaluate(
            (el) => el.classList.contains('ad-showing') || el.classList.contains('ad-interrupting'),
          )
          if (!adShowing) {
            const pausedNow = await video.evaluate((el: HTMLVideoElement) => el.paused)
            if (pausedNow) {
              const playBtn = player.locator('.ytp-play-button')
              if (await playBtn.isVisible().catch(() => false)) {
                await playBtn.click().catch(() => undefined)
              }
            }
            const subBtn = player.locator('.ytp-subtitles-button')
            if (await subBtn.isVisible().catch(() => false)) {
              const pressed = await subBtn.getAttribute('aria-pressed')
              if (pressed !== 'true') {
                await subBtn.click().catch(() => undefined)
              }
            }
            const segCount = await player
              .locator('.ytp-caption-window-container .ytp-caption-segment')
              .evaluateAll((els) =>
                els.filter((el) => {
                  const style = getComputedStyle(el)
                  return (
                    !(el as HTMLElement).hidden &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (el.textContent ?? '').trim().length > 0
                  )
                }).length,
              )
              .catch(() => 0)
            if (segCount > 0) {
              captionFound = true
              break
            }
          }
          await page.waitForTimeout(500)
        }

        expect(captionFound).toBe(true)

        const bubble = page.locator('[data-wt-root] .bubble')
        await expect
          .poll(
            async () => {
              await inspectClosedShadowPage(page)
              return (await bubble.isVisible().catch(() => false)) ? ((await bubble.textContent()) ?? '').trim() : ''
            },
            { timeout: 15_000 },
          )
          .toBe('字幕链路测试译文')

        const currentSourceCaption = await player
          .locator('.ytp-caption-window-container .ytp-caption-segment')
          .evaluateAll((els) =>
            els
              .map((el) => (el.textContent ?? '').trim())
              .filter((t) => t.length > 0)
              .join('\n'),
          )
        expect(currentSourceCaption.length).toBeGreaterThan(0)

        const subtitleCalls = api.calls
          .slice(callsAfterSetup)
          .filter(
            (call) =>
              call.kind === 'texts' &&
              Array.isArray(call.payload.texts) &&
              (call.payload.texts as string[]).some((t) => typeof t === 'string' && t.trim().length > 0),
          )
        expect(subtitleCalls.length).toBeGreaterThan(0)

        const shotPath = testInfo.outputPath('youtube-real-extension.png')
        await page.screenshot({ path: shotPath })
      } catch (error) {
        const state = await collectNarrowState().catch(() => ({
          url: page.url(),
          title: '',
          videoPresent: false,
          paused: null,
          currentTime: null,
          captionNodes: 0,
          overlayText: '',
          playerError: 'state-collection-failed',
        }))
        const failShot = testInfo.outputPath('youtube-real-extension.png')
        await page.screenshot({ path: failShot }).catch(() => undefined)
        throw new Error(`YouTube real-page state: ${JSON.stringify(state)}`, { cause: error })
      }
    } finally {
      await context.close()
      await api.close()
    }
  })
})

