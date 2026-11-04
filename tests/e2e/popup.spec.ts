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

  test('没有未翻译一行与收集开关', async ({ extension }) => {
    await extension.setSettings({ uiLanguage: 'zh-CN' })
    const { page } = extension
    await expect(page.getByRole('switch', { name: '启用', exact: true })).toBeVisible()
    await expect(page.locator('[data-test="wt-popup-auto-interaction"] [role="switch"]')).toBeVisible()
    await expect(page.locator('[data-test="wt-popup-floating"] [role="switch"]')).toBeVisible()
    await page.locator('.popup-details > summary').click()
    await expect(page.getByText('收集未翻译')).toHaveCount(0)
    await expect(page.locator('[data-test="untranslated"]')).toHaveCount(0)
  })
})
