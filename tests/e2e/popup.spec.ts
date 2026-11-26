import { expect, test } from './fixtures'

/** 存储中 settings.enabled 的值 */
function enabledOf(settings: unknown): unknown {
  return (settings as { enabled?: unknown } | undefined)?.enabled
}

test.describe('弹出页', () => {
  test('「启用」开关存在且可切换', async ({ extension }) => {
    await extension.setSettings({ uiLanguage: 'zh-CN' })
    const { page } = extension
    const toggle = page
      .getByRole('switch', { name: '启用', exact: true })
      .or(page.getByRole('checkbox', { name: '启用', exact: true }))
      .first()
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeChecked()

    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect.poll(async () => enabledOf(await extension.readSettings())).toBe(false)

    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect.poll(async () => enabledOf(await extension.readSettings())).toBe(true)
  })

  test('更多默认收起并保留展开偏好；没有未翻译一行与收集开关', async ({ extension }) => {
    await extension.setSettings({ uiLanguage: 'zh-CN' })
    const { page } = extension
    await expect(page.getByRole('switch', { name: '启用', exact: true })).toBeVisible()
    const more = page.locator('.popup-more')
    await expect(more).toHaveJSProperty('open', false)
    await expect(page.locator('[data-test="wt-popup-auto-interaction"] [role="switch"]')).toBeHidden()
    await more.locator('summary').click()
    await expect(more).toHaveJSProperty('open', true)
    await expect(page.locator('[data-test="wt-popup-auto-interaction"] [role="switch"]')).toBeVisible()
    await expect(page.locator('[data-test="wt-popup-floating"] [role="switch"]')).toBeVisible()
    await expect(page.getByText('收集未翻译')).toHaveCount(0)
    await expect(page.locator('[data-test="untranslated"]')).toHaveCount(0)
    await page.reload()
    await expect(more).toHaveJSProperty('open', true)
    await expect(page.locator('[data-test="wt-popup-floating"] [role="switch"]')).toBeVisible()
  })

  test('真实 320px 宽度、200% 缩放、明暗主题与英文长文案下主操作不裁切且焦点可见', async ({ extension }) => {
    const { page } = extension
    for (const theme of ['light', 'dark'] as const) {
      await extension.setSettings({ uiLanguage: 'en', theme, uiStyle: 'classic' })
      for (const [width, zoom] of [[320, '1'], [640, '2']] as const) {
        await page.setViewportSize({ width, height: 600 })
        await page.reload()
        if (zoom !== '1') {
          await page.evaluate((z) => {
            document.documentElement.style.zoom = z
          }, zoom)
        }
        const primary = page.locator('[data-test="wt-translate-page"]')
        await expect(primary).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(overflow).toBeLessThanOrEqual(1)
        const box = await primary.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
        await page.keyboard.press('Tab')
        const focusRing = await page.evaluate(() => {
          const el = document.activeElement
          if (!(el instanceof HTMLElement)) return false
          const style = getComputedStyle(el)
          return (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none'
        })
        expect(focusRing).toBe(true)
        await page.screenshot({ path: test.info().outputPath(`popup-en-${theme}-${width}-zoom${zoom}.png`) })
      }
    }
  })
})
