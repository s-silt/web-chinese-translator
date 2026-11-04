import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ConfigEnv, UserManifest, UserManifestFn } from 'wxt'

// 只取配置对象，不加载 WXT
vi.mock('wxt', () => ({ defineConfig: (config: unknown) => config }))

/** 重新加载 wxt.config.ts：构建标识按模块缓存 */
async function loadConfig(): Promise<typeof import('../../../wxt.config')> {
  vi.resetModules()
  return import('../../../wxt.config')
}

const ENV = { mode: 'production', command: 'build', browser: 'chrome', manifestVersion: 3 } as ConfigEnv

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('构建标识（wxt.config.ts）', () => {
  it.each([
    'src/.DS_Store',
    'src/core/.cache/a.ts',
    '.output/firefox-mv3/content-scripts/content.js',
    'node_modules/wxt/package.json',
    'src/core/__tests__/a.ts',
    'src/core/matcher.test.ts',
    'scripts/harvest.spec.mjs',
    'web-ext.config.ts',
    'src/web-ext.config.ts',
  ])('与 WXT 源码包相同的排除项：%s', async (path) => {
    const { excludedFromSources } = await loadConfig()
    expect(excludedFromSources(path)).toBe(true)
  })

  it.each(['src/entrypoints/content.ts', 'public/_locales/en/messages.json', 'src/core/latest.ts', 'LICENSE'])(
    '收入：%s',
    async (path) => {
      const { excludedFromSources } = await loadConfig()
      expect(excludedFromSources(path)).toBe(false)
    },
  )

  it('按路径排序，逐个写入「路径 + \\0 + 原始字节 + \\0」，sha256 取前 12 位', async () => {
    const { computeBuildId } = await loadConfig()
    const hash = createHash('sha256')
    for (const file of ['LICENSE', 'tsconfig.json']) {
      hash.update(file).update('\0').update(readFileSync(file)).update('\0')
    }
    expect(computeBuildId(['tsconfig.json', 'LICENSE'])).toBe(hash.digest('hex').slice(0, 12))
  })

  it('同一份源码各次相同；目录逐个文件计入，不存在的路径跳过', async () => {
    const { computeBuildId } = await loadConfig()
    const id = computeBuildId(['public'])
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(computeBuildId(['public', 'missing-directory'])).toBe(id)
    expect(computeBuildId(['public', 'LICENSE'])).not.toBe(id)
  })

  it('与当前目录无关：按 wxt.config.ts 所在目录（项目根目录）读取', async () => {
    const { computeBuildId } = await loadConfig()
    const sources = ['public', 'LICENSE', 'tsconfig.json']
    const id = computeBuildId(sources)
    const cwd = process.cwd()
    process.chdir(`${cwd}/public`)
    try {
      expect(computeBuildId(sources)).toBe(id)
    } finally {
      process.chdir(cwd)
    }
  })

  it('源码包与构建标识用同一份路径列表', async () => {
    const { default: config, SOURCES } = await loadConfig()
    expect(config.zip?.includeSources).toBe(SOURCES)
  })

  it('GCN_BUILD_ID 可覆盖；同一次构建的各步骤共用第一次的结果', async () => {
    vi.stubEnv('GCN_BUILD_ID', 'fixed-build')
    const { default: config } = await loadConfig()
    expect((await config.vite!(ENV)).define).toEqual({ __GCN_BUILD_ID__: '"fixed-build"' })
    vi.stubEnv('GCN_BUILD_ID', 'other-build')
    expect((await config.vite!(ENV)).define).toEqual({ __GCN_BUILD_ID__: '"fixed-build"' })
  })

  it.each([
    ['wxt build', ENV],
    ['wxt dev', { ...ENV, mode: 'development', command: 'serve' } as ConfigEnv],
  ])('%s：构建时压缩词典的词条表（scripts/pack-tables.ts），插件不限定命令', async (_, env) => {
    const { default: config } = await loadConfig()
    const plugins = (await config.vite!(env)).plugins ?? []
    const plugin = plugins.find((item) => item && 'name' in item && item.name === 'github-chinese:pack-tables')
    expect(plugin).toBeDefined()
    // 不设 apply：开发版与正式版的词条表是同一种形态
    expect(plugin && 'apply' in plugin ? plugin.apply : undefined).toBeUndefined()
  })
})

describe('清单权限', () => {
  it.each(['chrome', 'edge', 'firefox'])('%s：权限按浏览器功能区分；不申请历史、tabs；快捷键只在 Chromium 声明', async (browser) => {
    const { default: config } = await loadConfig()
    const manifest = (await (config.manifest as UserManifestFn)({ ...ENV, browser })) as UserManifest
    expect(manifest.permissions).toEqual(
      browser === 'firefox'
        ? ['storage', 'scripting']
        : ['storage', 'scripting', 'activeTab', 'contextMenus', 'alarms'],
    )
    expect(manifest.optional_host_permissions).toEqual(
      browser === 'firefox' ? [] : ['https://*/*', 'http://*/*'],
    )
    // 网页翻译功能只在 Chromium 构建里：翻译/恢复本页与翻译选中文字两条命令，描述走 _locales
    if (browser === 'firefox') expect(manifest.commands).toBeUndefined()
    else {
      expect(Object.keys(manifest.commands ?? {})).toEqual(['toggle-page-translation', 'translate-selection'])
      expect(manifest.commands?.['toggle-page-translation']).toEqual({
        suggested_key: { default: 'Alt+T' },
        description: '__MSG_cmdTogglePage__',
      })
      expect(manifest.commands?.['translate-selection']).toEqual({
        suggested_key: { default: 'Alt+S' },
        description: '__MSG_cmdTranslateSelection__',
      })
    }
  })
})
