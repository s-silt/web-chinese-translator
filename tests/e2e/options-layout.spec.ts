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

test('英文长文案、200% 缩放与窄窗明暗主题下区分未填模型、接口未授权与保存失败草稿保留', async ({ page, extensionId, extension }) => {
  test.setTimeout(120_000)
  const secret = 'sk-never-expose-in-ui-or-toast-991122'
  await page.goto(`chrome-extension://${extensionId}/options.html#wt-title`)
  await expect(page.locator('[data-test="wt-model-view"]')).toBeVisible()
  for (const theme of ['light', 'dark'] as const) {
    await extension.setSettings({ uiLanguage: 'en', uiStyle: 'classic', theme })

    // 1) 已存 Base URL 但未填模型 -> 显示 Model not set 及下一步说明
    await page.evaluate(async () => {
      const { chrome } = globalThis as unknown as {
        chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } }
      }
      await chrome.storage.local.set({
        translationConfig: { baseUrl: 'https://api.example.com/v1', model: '', targetLanguage: 'zh-CN' },
      })
    })
    for (const [width, zoom] of [[360, '1'], [640, '1'], [1280, '2']] as const) {
      await page.setViewportSize({ width, height: 800 })
      await page.reload()
      await expect(page.locator('[data-test="wt-model-view"]')).toBeVisible()
      if (zoom !== '1') {
        await page.evaluate((z) => {
          document.documentElement.style.zoom = z
        }, zoom)
      }
      await expect(page.locator('[data-test="wt-connection"]')).toHaveText('Model not set')
      await expect(page.locator('.connection-status')).toContainText('Enter a model name or click Fetch models, then save.')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
    }

    // 2) 已存 Base URL 与模型，但尚未授予该接口主机权限 -> 显示 Endpoint not authorized 与显式授权按钮
    await page.evaluate(async () => {
      document.documentElement.style.zoom = '1'
      const { chrome } = globalThis as unknown as {
        chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } }
      }
      await chrome.storage.local.set({
        translationConfig: { baseUrl: 'https://ungranted-api.fixture.test/v1', model: 'gpt-4o-mini', targetLanguage: 'zh-CN' },
      })
    })
    await page.setViewportSize({ width: 360, height: 800 })
    await page.reload()
    await expect(page.locator('[data-test="wt-connection"]')).toHaveText('Endpoint not authorized')
    const grantBtn = page.locator('[data-test="wt-grant-endpoint"]')
    await expect(grantBtn).toBeVisible()
    await expect(grantBtn).toHaveText('Authorize endpoint')
    await page.keyboard.press('Tab')
    await grantBtn.focus()
    const focusVisible = await grantBtn.evaluate((el) => {
      const style = getComputedStyle(el)
      return (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none'
    })
    expect(focusVisible).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: test.info().outputPath(`options-unauthorized-en-${theme}-360.png`) })

    // 3) 保存校验失败保留全部草稿，不以纯颜色报错，且不暴露 API Key
    await page.getByPlaceholder(/api\.example\.com|v1/).fill('http://insecure-non-loopback.example/v1')
    await page.locator('input[type="password"]').fill(secret)
    await page.locator('[data-test="wt-model-input"]').fill('draft-model-keep')
    const save = page.locator('[data-test="wt-save"]')
    await save.scrollIntoViewIfNeeded()
    await save.click()
    await expect(page.locator('[role="alert"], [role="status"]').filter({ hasText: /invalid|value|Enter/i }).first()).toBeVisible()
    await expect(page.getByPlaceholder(/api\.example\.com|v1/)).toHaveValue('http://insecure-non-loopback.example/v1')
    await expect(page.locator('input[type="password"]')).toHaveValue(secret)
    await expect(page.locator('[data-test="wt-model-input"]')).toHaveValue('draft-model-keep')
    expect(await page.locator('body').innerText()).not.toContain(secret)

    const discard = page.locator('[data-test="wt-discard-draft"]')
    const badge = page.locator('[data-test="wt-draft-badge"]')
    await discard.click()
    await expect(page.locator('[data-test="wt-model-input"]')).toHaveValue('gpt-4o-mini')
    await expect(page.locator('input[type="password"]')).toHaveValue('')
    await expect(page.locator('.wt-status-error')).toHaveCount(0)
    await expect(badge).toHaveCount(0)

    // 原生数字输入单独键入负号时，界面仍有未完成输入，value 却与已保存的空值相同。
    await page.locator('[data-test="wt-advanced"] summary').click()
    const temperature = page.locator('[data-test="wt-temperature"]')
    await temperature.pressSequentially('-')
    expect(await temperature.evaluate((el: HTMLInputElement) => el.validity.badInput)).toBe(true)
    await expect(badge).toBeVisible()
    await save.click()
    await expect(temperature).toHaveAttribute('aria-invalid', 'true')
    await discard.click()
    expect(await temperature.evaluate((el: HTMLInputElement) => el.validity.badInput)).toBe(false)
    await expect(temperature).toHaveValue('')
    await expect(badge).toHaveCount(0)
    await expect(page.locator('.wt-status-error')).toHaveCount(0)
  }
})
