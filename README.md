<h1 align="center">
  <img src="public/icon/128.png" width="72" height="72" alt=""><br>
  网页汉化助手
</h1>

<p align="center">
  用你自己的模型接口，把任意网页翻译成中文<br>
  <sub>整页翻译、划词、字幕、输入框和搜索框翻译；常用网站和 GitHub 另有离线界面词典。内容只在你配置接口并授权的站点上发送。</sub>
</p>

<p align="center">
  <a href="https://github.com/s-silt/web-chinese-translator/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/s-silt/web-chinese-translator/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/s-silt/web-chinese-translator/releases/latest">最新版本</a> &nbsp;·&nbsp; <a href="https://chromewebstore.google.com/detail/gbjmhoaejahffdnefecjfgkoifggpdhe">Chrome 应用商店</a> &nbsp;·&nbsp; Chrome / Edge（MV3）&nbsp;·&nbsp; Firefox 140+（仅 GitHub 汉化）&nbsp;·&nbsp; <a href="LICENSE">MIT</a>
</p>

<p align="center"><img src="docs/images/popup.png" width="760" alt="弹出页：经典浅色、毛玻璃深色、赛博、GitHub 页面未配置模型"></p>

| 核心能力 | 说明 |
| --- | --- |
| **网页翻译** | 接入 OpenAI 兼容接口（DeepSeek、OpenAI、Claude 或自建中继），整页或逐站自动翻译，滚动到哪翻到哪 |
| **阅读与输入** | 划词翻译与释义、视频字幕、聊天输入框和网页搜索框的草稿多语言互译 |
| **离线界面词典** | 26 组常用网站（Cursor、Claude、Vercel、Linear 等）和 GitHub 的菜单按钮直接本地替换，不调用模型 |
| **可控** | 总开关、排除本站、单页上限、运行范围名单；状态和失败原因写在弹出页上 |

```text
页面文字 ──► 已授权站点 + 已配置接口 ──► 你的模型接口 ──► 原位替换    按需发送
    │                    │
    │         敏感页面、排除网站、无痕窗口：不发送
    │
    └──► 界面词典（常用网站 / GitHub / 自定义）──► 原位替换        不联网
```

## 快速开始

1. Chrome 从 [Chrome 应用商店](https://chromewebstore.google.com/detail/gbjmhoaejahffdnefecjfgkoifggpdhe) 安装，商店版自动更新。
2. 也可以手动安装：从 [Releases](https://github.com/s-silt/web-chinese-translator/releases/latest) 下载 `web-chinese-translator-<版本>-chrome.zip` 并解压，打开 `chrome://extensions`，开启「开发者模式」，「加载已解压的扩展程序」，选择解压出的文件夹。
3. 点弹出页「1 分钟完成配置」：选服务商预设，填 API Key 和模型名，点「保存并连接」。连接徽章显示延迟，失败时写明原因。
4. 打开任意英文网页，点弹出页「翻译本页」；常去的网站打开「本站自动翻译」。

Edge 用 `-edge.zip`，在 `edge://extensions` 加载；Firefox 安装 `-firefox.xpi`。手动安装的版本更新时替换原目录文件并点「重新加载」，换目录会丢失配置。发布页附 `SHA256SUMS.txt` 供核对。

| 任务 | 入口 |
| --- | --- |
| 翻译或恢复当前页 | 弹出页主按钮，或 `Alt+T` |
| 某个网站一直自动翻译 | 弹出页「本站自动翻译」 |
| 某个网站不调用模型 | 弹出页「排除本站」（本地词典仍生效） |
| 翻译选中文字 | 选中后右键「翻译选中文字」，或 `Alt+S` |
| 翻译输入框或搜索框草稿 | 设置页开启「输入翻译」，可选预览后按替换键（默认 `Tab`，可在设置页修改）或停止输入后自动替换，也可直接按 `Alt+Y`（macOS `Command+Shift+Y`）替换 |
| 长文翻到一半停住 | 设置页调高「单页翻译上限」，或点「继续翻译」 |
| 补充或改写界面词条 | 设置页「网站与词典」；GitHub 在「GitHub 规则」 |
| 完整说明 | [使用说明](docs/USAGE.md) |

## 默认行为与边界

- **模型翻译默认关闭。** 不内置模型地址或密钥；内容只在你开启的功能和授权的站点上发给你配置的接口，费用由你与服务方约定。
- **单页有上限。** 默认每页约 5 万字，可在设置页改为 2 万到 20 万或不限；达到后其余内容保留原文。
- **界面词典不联网。** 常用网站和 GitHub 的界面词条在本机替换；GitHub 词典另有简繁两套，详见 [使用说明](docs/USAGE.md#github-汉化)。
- **敏感页面跳过。** 账户、付款、邮件等页面不自动翻译，弹出页显示「已跳过」；识别是启发式的，不保证全覆盖。
- **API Key 明文存本机。** 存在扩展的 IndexedDB，与接口来源绑定，不随账号同步。
- **不处理。** 跨域 iframe、关闭的 Shadow DOM、图像字幕；无痕窗口中扩展不运行。

权限、数据与网络请求见 [隐私说明](docs/PRIVACY.md)。

## 开发

```bash
bun install
bun run lint && bun run compile && bun run check:parity && bun run check:locale && bun run test
bun run build      # 加载 .output/chrome-mv3
```

需要 Bun 1.3+、Node.js 22.13+。改词典先读 [术语表](docs/GLOSSARY.md)，简繁同步。其余见 [开发与发布](docs/DEVELOPMENT.md)。问题请提 [Issues](https://github.com/s-silt/web-chinese-translator/issues/new/choose)。

## 致谢与许可

术语参照 [GitHub 官方中文文档](https://docs.github.com/zh) 与 [Pro Git 中文版](https://git-scm.com/book/zh/v2)。[MIT](LICENSE) © 2026 github-chinese contributors、web-chinese-translator contributors；第三方许可见 [THIRD_PARTY_NOTICES.txt](public/THIRD_PARTY_NOTICES.txt)。
