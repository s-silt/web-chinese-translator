import { expect, test } from './fixtures'

test.use({ headless: false })

test('模型设置在各外观与宽窄视口下正常布局，保存按钮可滚动并点击', async ({ page, extensionId, extension }) => {
  test.setTimeout(180_000)
  const appearances = [
    ['classic', 'light'], ['classic', 'dark'], ['cyber', 'dark'], ['glass', 'light'], ['glass', 'dark'],
  ] as const
  for (const [uiStyle, theme] of appearances) {
    await extension.setSettings({ uiLanguage: 'zh-CN', uiStyle, theme })
    for (const width of [1280, 640, 320]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
      await expect(page.locator('[data-test="wt-model-view"]')).toBeVisible()
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).display)).toBe('block')
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
      if (width >= 900) {
        const side = await page.locator('.options-side').boundingBox()
        const main = await page.locator('.options-main').boundingBox()
        expect(side).not.toBeNull()
        expect(main).not.toBeNull()
        expect(main!.x).toBeGreaterThanOrEqual(side!.x + side!.width)
        expect(main!.width).toBeGreaterThan(500)
      }
      await page.getByPlaceholder(/api\.example\.com|v1/).fill('https://api.example.com/v1')
      await page.locator('input[type="password"]').fill('sk-e2e-fake')
      await page.locator('[data-test="wt-model-input"]').fill('mock-model')
      const save = page.locator('[data-test="wt-save"]')
      await expect(save).toBeEnabled()
      await save.scrollIntoViewIfNeeded()
      await save.click({ trial: true })
      await page.screenshot({ path: test.info().outputPath(`options-layout-${uiStyle}-${theme}-${width}.png`) })
    }
  }
})
