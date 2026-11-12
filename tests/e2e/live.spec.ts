import { resolve } from 'node:path'
import {
  CJK,
  expect,
  test,
} from './fixtures'

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

