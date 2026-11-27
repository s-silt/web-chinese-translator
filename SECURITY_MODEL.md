# 威胁模型：s-silt/web-chinese-translator（网页汉化助手）

## 依据与范围

- 安全审查覆盖整个仓库，包括运行时代码、依赖、构建发布脚本和测试；不添加路径排除。
- 维护者确认的边界：全部列举的资产与攻击者都重要，无范围外项或已接受风险，无独立基础设施仓库。代码推断不能视作维护者认可的风险。
- 实现依据：`README.md`、`docs/PRIVACY.md`、`wxt.config.ts` 及下述组件代码。隐私文档是项目对数据处理的说明，不是对缺陷的风险豁免。
- 基础设施：仓库内只有 GitHub Actions 构建发布配置，未发现服务器部署代码；维护者确认没有独立基础设施仓库。

## 系统与信任边界

WXT / Vue 的 Manifest V3 浏览器扩展。Chrome、Edge 提供 GitHub 与 26 组站点的离线词典替换，以及用户自配 OpenAI 兼容接口的模型翻译、输入翻译和阅读辅助；Firefox 140+ 只启用 GitHub 本地汉化。项目没有应用后端，第三方模型接口由用户配置。

主要数据流：不可信网页 DOM → 隔离世界内容脚本 → 扩展后台 → 用户配置的模型接口 → 后台 → 页面译文或编辑器。GitHub 的 MAIN world Turbo 桥与页面共享运行环境。扩展设置页另可写配置和凭据；独立文本翻译窗口把用户主动输入的文本交给后台，不读取当前标签页。构建发布链把源码和依赖变成可安装的签名扩展。

| Component | 覆盖代码 | 信任边界 |
| --- | --- | --- |
| GitHub Localizer | `src/core/`、`src/locales/`、`src/entrypoints/content.ts`、`turbo-bridge.content.ts`、`locale-zh-cn.ts`、`locale-zh-tw.ts`、`src/shared/locale*.ts` | github.com / gist / githubstatus 的共享 DOM；Turbo 桥运行在 MAIN world，不能把页面状态当作特权来源。 |
| Web Translation Content | `src/entrypoints/web-translate.ts`、`input-frame.ts`；`src/translation/` 中 controller、dom、dom-walker、panel、floating、selection、subtitles、input-*、document-*、chat-input、discord-input、video-chat-input、reading-signals、clipboard 等页面侧模块 | 用户授权的 HTTP(S) 页面、编辑器、iframe、字幕和页面脚本不可信；模型结果写回 DOM 或草稿。 |
| Background | `src/entrypoints/background.ts`；`src/translation/background.ts`、client、transport、provider、request-options、secrets、persistent-cache、context-memory、registration、config、messages、queue、scheduler、manual-page、dictionaries/ 等后台模块 | 持有 API Key 和自定义请求头、执行网络请求和动态脚本注册；接收内容脚本及扩展页的消息。 |
| Extension UI | `src/entrypoints/options/`、`popup/`、`translate/`、`src/translation/text-window.ts`、`src/components/`、`src/i18n/` | 扩展来源的设置页、弹窗和文本翻译窗口；设置页有配置和凭据写权限，文本窗口有独立消息授权边界。 |
| Shared | `src/shared/` 中 settings、custom-entries、messages、tab-messages、github、extension 等公共模块 | 复用的存储、消息、设置及页面兼容逻辑；locale 专用加载器归 GitHub Localizer。 |
| Build & Release | `scripts/`、`wxt.config.ts`、`package.json`、`bun.lock`、`.github/workflows/`、`.github/dependabot.yml` | 依赖与工作流进入发布产物；发布流程可接触 CRX 签名及 AMO 凭据。测试也在扫描范围，按其触及的组件或构建发布边界归类。 |

## 入口与可达者

- 获得站点授权后，网站及嵌入帧控制的文本、属性、输入与富文本编辑器、字幕、标题、DOM 事件进入内容脚本；页面可读写共享 DOM 属性，观察扩展写回的译文。
- GitHub 页面脚本可接触 MAIN world Turbo 桥和 DOM 事件；这些输入不应扩大到扩展后台权限。
- 内容脚本通过 `runtime.onMessage` / `onConnect` 请求后台工作；浏览器提供的 sender 身份、标签页、frame、document 和来源用于权限判断。页面或其他扩展尝试伪造消息属于攻击面，不假定其可绕过浏览器隔离。
- 用户可通过扩展页、右键菜单、快捷键修改配置、开启功能、翻译当前页或选区；自定义词条及词典进入本地替换路径。
- 后台访问用户配置来源的 `/chat/completions`、`/responses`、`/models`；接口响应可能恶意、畸形或过大。
- 发布标签、依赖更新、CI 工作流及构建脚本影响发布包完整性。

## 资产与敏感度

维护者确认以下资产都重要，不因存放在本机或仅用于开发而排除：

1. API Key 和自定义请求头：本机 IndexedDB `web-translator-secrets` 中明文存储，不同步，按接口的协议、主机和端口绑定；应仅发送给用户授权的对应来源。
2. 网页、选区、草稿、字幕、标题、邻近上下文和近期阅读线索：可能包含账号、支付、邮件、内部系统及用户秘密；排除站点和运行范围必须受控，授权与撤销必须生效。
3. 页面及编辑器完整性：词条和模型结果不能引入可执行脚本、越权消息或非预期发送，尤其是带登录会话的 GitHub 页面。
4. 本机数据：持久译文缓存可能含原文、标识符或网址，默认最多约 2 万条 / 20 MiB，30 天后不再命中，物理删除可能滞后；近期阅读线索保存在 `storage.session`，最多 12 条、30 分钟，每次最多附带 4 条跨标签页线索。设置可能经 `storage.sync` 同步，自定义词条和翻译配置使用 `storage.local`。
5. 文本翻译窗口的原稿、译文和剪贴板：文本仅由用户主动输入或粘贴；窗口关闭不恢复草稿，不写持久译文缓存。复制后的系统剪贴板由系统管理。
6. 发布完整性与供应链：CRX 私钥、AMO 凭据、源码及二进制发布包、校验和，以及 CI 的仓库写权限。

## 攻击者

以下攻击者均在范围内：恶意授权网页；恶意或被攻破的模型服务/中继；试图伪造消息或篡改共享 DOM 的页面脚本与其他扩展；能读取本机浏览器配置目录的本地攻击者；恶意依赖、Action 或发布链参与者。

保留浏览器隔离的真实前提：普通网页不天然拥有扩展 API，其他扩展也不天然能读取本扩展 IndexedDB；发现应说明实际所需权限与前提。本地攻击者仍在范围内，但不能仅据此提高扫描器的可利用性判断。

## 已有控制与预期行为

以下是代码或项目文档说明的控制，不代表这些控制已通过独立安全验证：

- `wxt.config.ts` 禁止无痕运行；GitHub 与内置词典站点有固定来源权限，其余来源通过 optional_host_permissions 授权。Firefox 不启用模型功能。
- `src/translation/background.ts` 区分扩展页面、顶层内容脚本、输入 iframe 和文本窗口；iframe 检查 tab / frame / document / origin；配置写入仅允许扩展页。后台返回给页面的配置不应含凭据。
- `page-policy.ts` / `site-scope.ts` 实施排除域名、子域名和运行范围；敏感页面启发式限制自动翻译、划词、主动陪读与线索记录。隐私文档明确：敏感页上仅显式右键可发送所选文字，且不附带标题、邻近上下文或近期线索；排除站点禁止包括右键在内的全部模型发送。
- 独立文本窗口不读取文本的原网站，文档明确其不按粘贴来源套用站点排除规则；这项明确的用户操作应与网页自动采集区分。
- `secrets.ts` 将凭据绑定接口来源；`transport.ts` 的请求设置 `credentials: omit`、`redirect: error`、`referrerPolicy: no-referrer`，设超时和约 1 MiB 的响应大小限制。
- 普通译文可落盘；敏感页、携带近期阅读线索的请求与文本窗口不使用持久译文缓存。清缓存会取消进行中请求并阻止旧写入恢复；更换接口、删除密钥或关闭功能并不自动删除旧缓存，见隐私文档。
- 字典资源使用动态 URL；构建插件移除 Vue 静态片段的 HTML 插入路径。CI 与发布工作流固定 Action 提交并限制权限；发布凭据仅用于发布边界。

## 范围外与已接受风险

维护者确认：无。API Key 明文存储、敏感页识别的启发式限制、持久缓存、脚本和测试都不自动视作已接受风险。文档披露的主动发送行为用于判断是否存在越过预期边界，不作为相关安全缺陷的整体豁免。

## 复核规则与待确认项

- 从扫描器严重度出发；扫描器已经权衡实际利用前提和影响，复核时不重新推测可利用性。
- 仅维护者确认的范围、资产或风险事实可以调整优先级。当前所有攻击者均在范围内、无风险豁免，预计绝大多数发现维持扫描器严重度；难利用或未验证的发现不升级。
- 筛选标签：Component、CWE、Browser、CVE、Compliance Scope（合规范围）。Component 使用上表稳定名称，CVE 仅在适用时赋值。Compliance Scope 仅记录有依据的适用法规或合规边界，不据漏洞类别擅自认定法规适用，也不把它当作合规认证结论。
- 开放问题：尚未指定具体合规框架或适用地区；有依据时填写 Compliance Scope，否则保留为“未指定”。维护此模型时，代码推断与维护者确认或更正的事实分开记录。
