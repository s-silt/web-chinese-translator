import { builtinHostPatterns } from './src/translation/dictionaries/index'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { defineConfig } from 'wxt'
import { packTablesPlugin } from './scripts/pack-tables'
import { stripVueStaticContentPlugin, VUE_COMPILER_OPTIONS } from './scripts/strip-vue-static-content'

/** 本项目 Firefox 扩展 ID；上架 AMO 后不可更改 */
const GECKO_ID = '{4f5a7e2d-8b39-4c64-b87b-64cf6ba2987f}'

/** 扩展生效的站点（含 GitHub 状态页），与 src/shared/github.ts 保持一致 */
export const GITHUB_ORIGINS = ['https://github.com/*', 'https://gist.github.com/*', 'https://www.githubstatus.com/*']

/** 源码包（AMO 审核用）收入的路径，也是构建标识的计算范围 */
export const SOURCES = [
  'src',
  'public',
  'scripts',
  'docs',
  'package.json',
  'bun.lock',
  'wxt.config.ts',
  'tsconfig.json',
  'README.md',
  'LICENSE',
]

/**
 * 源码包不收的路径，同 WXT 打包源码的默认排除：任一段以 . 开头（含输出目录 .output）、node_modules、__tests__、
 * 测试文件（*.test.*、*.spec.*）、web-ext.config.ts。计算构建标识时同样跳过，审核者解压源码包后算出的相同
 */
export function excludedFromSources(path: string): boolean {
  const segments = path.split('/')
  const name = segments.at(-1) ?? ''
  return (
    segments.some((segment) => segment.startsWith('.') || segment === 'node_modules' || segment === '__tests__') ||
    /\.(test|spec)\./.test(name) ||
    name === 'web-ext.config.ts'
  )
}

/**
 * 项目根目录（本文件所在目录），即 WXT 的根目录与源码包的根目录。构建标识按它读取源码：
 * 命令行可指定根目录（`wxt build <root>`），当前目录不一定是项目根目录
 */
const ROOT = import.meta.dirname

/** 路径下源码包收入的文件（相对项目根目录的 posix 路径） */
function sourceFiles(path: string): string[] {
  const absolute = `${ROOT}/${path}`
  if (excludedFromSources(path) || !existsSync(absolute)) return []
  const stat = statSync(absolute)
  if (stat.isFile()) return [path]
  if (!stat.isDirectory()) return []
  return readdirSync(absolute).flatMap((name) => sourceFiles(`${path}/${name}`))
}

/**
 * 构建标识（见 src/shared/build-id.ts）：源码包内文件的内容哈希。源码不同则不同，
 * 同一份源码的各次构建相同（AMO 审核要求可复现），与当前目录无关。
 * 按路径排序，逐个写入「路径 + \0 + 原始字节 + \0」，sha256 取前 12 位
 */
export function computeBuildId(sources: readonly string[] = SOURCES): string {
  const hash = createHash('sha256')
  for (const file of sources.flatMap(sourceFiles).sort()) {
    const content = readFileSync(`${ROOT}/${file}`)
    hash.update(file).update('\0').update(content).update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** 构建标识：第一次用到时计算，同一次构建的各脚本共用；环境变量 GCN_BUILD_ID 可覆盖 */
let buildId: string | undefined

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue'],
  // 模板不生成字符串化的静态片段，Vue 运行时插入它们的 innerHTML 代码随之去掉（见 scripts/strip-vue-static-content.ts）
  vue: { vite: { template: { compilerOptions: VUE_COMPILER_OPTIONS } } },
  vite: () => {
    buildId ??= process.env.GCN_BUILD_ID || computeBuildId()
    return {
      define: { __GCN_BUILD_ID__: JSON.stringify(buildId) },
      plugins: [
        // 词典的 static / scoped 表改写成字符串，缩短词典脚本在 document_start 的编译与执行（见 scripts/pack-tables.ts）
        packTablesPlugin(`${ROOT}/src/locales`),
        stripVueStaticContentPlugin(),
      ],
    }
  },
  // 三个浏览器统一使用 MV3
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    // 名称、描述随浏览器界面语言（public/_locales），没有对应语言时用英文
    name: '__MSG_extName__',
    description: browser === 'firefox' ? '__MSG_extDescriptionFirefox__' : '__MSG_extDescription__',
    default_locale: 'en',
    incognito: 'not_allowed',
    // scripting：按当前语言注册词典内容脚本（页面开始解析前就绪），动态导入失败（Firefox 不动态导入）时注入词典脚本；
    // Chromium 安装、更新后向已打开的 GitHub 标签页注入脚本（Firefox 自动注入）。Firefox 的 scripting 无安装、更新提示
    permissions:
      browser === 'firefox'
          ? ['storage', 'scripting']
        : ['storage', 'scripting', 'activeTab', 'contextMenus', 'alarms'],
    host_permissions:
      browser === 'firefox' ? [...GITHUB_ORIGINS] : [...GITHUB_ORIGINS, ...builtinHostPatterns()],
    optional_host_permissions: browser === 'firefox' ? [] : ['https://*/*', 'http://*/*'],
    action: {
      default_title: '__MSG_extName__',
    },
    // 词典脚本由内容脚本动态导入（见 src/shared/locale-loader.ts），只对 GitHub 页面开放，用会话随机地址，
    // 页面无法据固定地址探测扩展。Firefox 不动态导入（改请后台注入），不开放
    ...(browser === 'firefox'
      ? {
          web_accessible_resources: [
            { resources: ['icon/48.png'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true },
          ],
        }
      : {
          minimum_chrome_version: '116',
          commands: {
            'toggle-page-translation': { suggested_key: { default: 'Alt+T' }, description: '__MSG_cmdTogglePage__' },
            'translate-selection': { suggested_key: { default: 'Alt+S' }, description: '__MSG_cmdTranslateSelection__' },
          },
          web_accessible_resources: [
            { resources: ['locale-*.js'], matches: GITHUB_ORIGINS, use_dynamic_url: true },
            { resources: ['icon/48.png'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true },
          ],
        }),
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: GECKO_ID,
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['none'] },
            },
            // Android 版从 142 起支持 data_collection_permissions
            gecko_android: {
              strict_min_version: '142.0',
            },
          },
        }
      : {}),
  }),
  zip: {
    includeSources: SOURCES,
  },
  webExt: {
    startUrls: ['https://github.com/vuejs/core'],
  },
})
