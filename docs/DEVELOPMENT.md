# 开发与发布

本文由 README 移出，内容未删减。使用说明见 [USAGE.md](USAGE.md)。

## 环境

Bun 1.3+、Node.js 22.13+（CI 使用 Node 24）。

```bash
bun install
bun run build           # Chrome → .output/chrome-mv3
bun run build:edge      # Edge → .output/edge-mv3
bun run build:firefox   # Firefox → .output/firefox-mv3
```

## 参与贡献

- 网页翻译与阅读辅助问题请在[本项目反馈](https://github.com/s-silt/web-chinese-translator/issues/new/choose)；上游 GitHub 词库问题也可在[上游仓库](https://github.com/setube/github-chinese/issues/new/choose)反馈。
- 改进译文：先读[术语表](GLOSSARY.md)；改动简体词典后同步繁体。
- 界面截图：`WT_SHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts --project=offline --headed`，输出到 `test-results/ui-shots/`（需有界面的浏览器以确认原生权限框）。
- 提交前运行以下检查（同[发布工作流](../.github/workflows/release.yml)）：

```bash
bun run lint
bun run compile
bun run check:parity
bun run check:locale
bun run check:locale --locale=zh-TW
bun run test
```

### 常用命令

| 命令                                                        | 说明                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bun run dev`、`dev:edge`、`dev:firefox`                    | 开发模式，修改后自动重载（Edge、Firefox 仅本地开发，不公开发行）                   |
| `bun run build`、`build:edge`、`build:firefox`、`build:all` | 构建到 `.output/<浏览器>-mv3/`（仅公开发行 Chrome，其余供本地开发与 CI 兼容构建）  |
| `bun run zip`、`zip:edge`、`zip:firefox`、`zip:all`         | 打包 zip 到 `.output/`（发布工作流仅运行 `bun run zip` 生成 Chrome 打包中间物）    |
| `bun run pack:crx`                                          | 由 Chrome zip 打包 crx                                                             |
| `bun run test`、`test:watch`、`coverage`                    | 单元测试（Vitest）、监听模式、覆盖率                                               |
| `bun run test:e2e`、`test:e2e:live`                         | 端到端测试（Playwright）、线上冒烟，均先构建                                       |
| `bun run compile`、`lint`、`lint:firefox`、`format`         | 类型检查（vue-tsc）、ESLint、web-ext lint、Prettier                                |
| `bun run check:locale`、`check:parity`                      | 词典自检、简繁对照                                                                 |
| `bun run harvest`、`coverage:locale`                        | 采集界面文本、统计词典覆盖率                                                       |
| `bun run icons`                                             | 由 `assets/icon.svg` 生成 `public/icon/*.png`（内嵌位图超过 512px 时先压缩并写回） |

`bun test`、`bun build` 是 Bun 自带命令，本项目脚本一律用 `bun run`。

<details>
<summary><b>词典维护</b></summary>

1. 先读[术语表](GLOSSARY.md)：翻译原则、格式、术语表、词典写法。术语参照 GitHub 官方中文文档与 Pro Git 中文版；社区词库 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese)（GPL-3.0）只用于发现漏收的原文，不搬运译文。
2. 简体词典在 `src/locales/zh-CN/`，繁体词典在 `src/locales/zh-TW/`（同名文件、同键同结构，译文按[繁体术语表](GLOSSARY.zh-TW.md)从英文翻译），按页面类型分文件（`static` / `scoped` / `regexp` / `ignore` / `attributeRules` / `inline` / `mergeText`，字段说明见 `src/core/types.ts`），由 `index.ts` 注册。较大的组拆成子目录 `<组>/<名>.ts`，由 `<组>.ts` 用 `mergeDictionaries` 合并；子目录里没有默认导出的模块是共用工具。
3. 自检：`bun run check:locale src/locales/zh-CN/<文件>.ts`；不带文件时检查全部词典（含子文件），另查 static 冲突、同一页面类型的 scoped 冲突、未合并的子文件、未注册的主文件；加 `--redundant` 列出可删的 scoped（全局 static 已有相同译文）。繁体加 `--locale=zh-TW`（给出 `src/locales/zh-TW/` 下的文件时可省略），另扫描源码里所有含中文的字符串与模板字面量（含替换函数、模块内常量、helpers.ts 与 `src/locales/shared/`；注释与抛出的错误信息除外）：简体字报错，大陆用语与弯引号警告。改动简体词典后同步繁体，`bun run check:parity [文件...]` 逐项对照两边的键、正则、属性规则、行内句、导出与注册顺序。
4. 采集界面文本：`bun run harvest [--areas issues,pulls]`，按 `scripts/harvest-urls.json` 访问公开页面（未登录），输出 `.harvest/raw/<区域>.json`。访问要克制，避免触发限流。
5. 统计覆盖率：`bun run coverage:locale [--raw <目录>]... [--all] [--unused]`，输出 `.harvest/digest/<区域>.txt`（未翻译文本，按出现页面数排序）与 `coverage.json`；页面类型按当前路由规则重新判断，相邻文本节点与引擎一样先整组匹配、未命中再逐段统计（需用新版 harvest 采集的数据）。`--unused` 另输出 `unused.txt`：采集页面上从未用到的词条，可能已过时，删除前人工核对。
6. 正则规则写单元测试：`tests/unit/locales/<区域>.test.ts`。

</details>

<details>
<summary><b>测试</b></summary>

```bash
bun run test            # 单元测试（Vitest）
bun run coverage        # 单元测试覆盖率
bun run test:e2e        # 构建后运行端到端测试（Playwright 加载 .output/chrome-mv3）
bun run test:e2e:live   # 线上冒烟：访问 github.com/vuejs/core，截图存 test-results/
```

端到端测试首次运行前安装浏览器：`bunx playwright install chromium`。

- 离线测试：`github.com` 请求由 `tests/e2e/fixtures/` 中仿 GitHub 结构的页面应答，覆盖界面翻译、用户内容保持原文、属性、动态插入与 React 改写、忽略区域内的界面块（评论中的建议块、应用权限选择器）、`<relative-time>`、标题、设置联动（总开关、排除路径、自定义词条，含后台休眠后）、弹出页。
- 线上冒烟仅在环境变量 `E2E_LIVE=1` 时执行。`bun run test:e2e:live` 从 `tests/e2e/live.env` 读取环境变量，该文件不入库：首次运行前把 `tests/e2e/live.env.example` 复制为 `tests/e2e/live.env`，并将 `E2E_LIVE` 改为 `1`。
- 报告：`playwright-report/`；失败时的 trace 与截图：`test-results/`。

</details>

<details>
<summary><b>目录结构</b></summary>

```text
.github/                 议题模板、发布工作流
assets/icon.svg          图标源文件
docs/GLOSSARY.md         翻译规范与术语表
docs/GLOSSARY.zh-TW.md   繁体翻译规范与术语表
docs/PRIVACY.md          隐私说明
public/_locales/         扩展名称、说明的多语言文本
public/icon/             扩展图标（bun run icons 生成）
scripts/                 采集、覆盖率、词典校验、图标渲染、crx 打包脚本
src/
  core/                  匹配器、URL → 页面类型、忽略规则、翻译引擎
  locales/zh-CN/         简体中文词典
  locales/zh-TW/         繁体中文词典（与简体同结构）
  locales/shared/        简繁共用的时间、拼接工具
  i18n/                  扩展界面文案（简体、繁体、英文）
  shared/                设置存储、消息协议等共用模块
  components/            弹出页与选项页共用组件
  components/ui/         基础控件：按钮（含水波纹）、输入框、多行输入框、下拉框、开关
  entrypoints/           background、content、词典脚本、popup、options
tests/
  unit/                  单元测试
  e2e/                   端到端测试与离线夹具
wxt.config.ts            WXT 配置与 manifest
```

</details>

## 发布

推送标记 `v<版本>`（与 `package.json` 的 `version` 一致）后，[发布工作流](../.github/workflows/release.yml)依次检查（lint、类型、词典、单元测试）、运行 `bun run zip` 在 `.output/` 生成 Chrome ZIP 打包中间物、用 `bun run pack:crx` 签名生成 CRX，并发布 GitHub 发行版（先建草稿，产物传完后发布）；版本号带 `-`（如 `v1.0.0-beta.1`）时为预发行版。在存储库的「操作」页手动运行时只检查、打包，产物在运行记录的工件里。

当前工作流上传的发行资产仅包含 Chrome CRX 与校验和文件，不再上传 Firefox、Edge、额外源码包或扩展 ZIP；GitHub 按标签自动提供的源码归档仍会保留。Chrome 应用商店上传包可直接从已发布的 `web-chinese-translator-<版本>-chrome.crx` 提取内部 ZIP 负载提交，确保商店版本与 CRX 负载一致。

| 产物                                         | 说明                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `web-chinese-translator-<版本>-chrome.crx`   | Chrome CRX3 扩展包（适用于允许自行分发安装的环境；普通用户推荐从 Chrome 商店安装） |
| `SHA256SUMS.txt`                             | 公开 CRX 的 SHA-256，校验：`sha256sum -c SHA256SUMS.txt`                           |

<details>
<summary><b>存储库机密与签名</b></summary>

| 机密              | 用途                                 | 未配置时                 |
| ----------------- | ------------------------------------ | ------------------------ |
| `CRX_PRIVATE_KEY` | crx 签名私钥（RSA PEM），决定扩展 ID | 停止发布，需配置固定私钥 |

- 生成私钥：`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out crx-key.pem`，文件内容填入 `CRX_PRIVATE_KEY`。私钥不提交到存储库（`.gitignore` 已忽略 `*.pem`）；更换私钥后扩展 ID 随之改变。
- 本地打包 crx：`bun run pack:crx --key crx-key.pem .output/web-chinese-translator-<版本>-chrome.zip`，在 zip 旁生成同名 `.crx`；不带 `--key` 时读环境变量 `CRX_PRIVATE_KEY`。
- 发布工作流通过 `--expected-id` 核对固定扩展 ID，密钥不匹配时不会生成新 CRX。分叉项目使用自己的签名密钥时，需同步修改工作流中的 `CRX_EXPECTED_ID`。

</details>
