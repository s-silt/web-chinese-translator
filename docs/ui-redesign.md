# 网页汉化助手 界面与交互优化设计

范围：Popup、模型配置与首次引导、Options 导航、反馈与容错。保留所有现有能力，不改后台消息协议（只复用已有消息）。

## 1. 设计理念

- **一屏回答三个问题**：扩展开着吗？这一页现在是什么状态？我下一步点哪里？Popup 顶部回答第一个，状态卡回答第二个，状态卡里的主按钮回答第三个。
- **两种翻译分开显示**：本地词典（免费、离线、确定）用绿色「词典」标签；模型翻译（调用接口、可能产生费用）用主题色「模型」标签。两者在 Popup 中各占一行，各有自己的状态和开关。
- **禁用必须说明原因**：灰掉的开关下方一行小字写明原因和解决入口（「未配置模型 · 去配置」「需要网站访问权限 · 授权」）。
- **渐进披露**：高频操作直接展示，低频开关收进「更多」，并记住展开状态。
- **主题只改变量**：cyber 和 glass 只改 `--gcn-*` 变量和少量装饰，组件结构相同，切换时不重排。

## 2. 信息架构

### Popup（320px）

```
Header     品牌 + 版本 | 主题按钮(非 cyber) | 全局总开关（大号）
StatusCard 当前站点 origin + 状态徽章
           [主按钮：翻译本页 / 恢复原文 / 继续翻译]  [排除本站]
           失败/暂停/上限/敏感页/范围外 的说明行与修复按钮
Engines    词典行：GitHub 词典状态（已翻译/已排除/未就绪/未授权）
           模型行：模型名或「未配置」 + 本站自动翻译开关
More ▸     自动弹窗 / 网页悬浮入口 / 视频字幕 / 输入翻译（各带禁用原因）
Footer     本站设置 → | 模型设置 → | 设置齿轮
Toast
```

### Options 导航分组

| 分组 | 条目（沿用现有锚点） |
| --- | --- |
| 常规 | 常用设置 `wt-general-title`、外观 `appearance-title` |
| 翻译 | 模型连接 `wt-title` |
| 词典 | 网站与词典 `wt-dictionary-title`、GitHub 规则 `github-title` |
| 高级 | 关于 `about-title` |

Firefox 构建只有 GitHub 规则与关于，分组标题照常显示，空组不显示。

## 3. 关键改进点

1. **总开关移到 Header 右侧并放大**。它是使用频率最高、影响最大的控件，现在和其他开关同级。
2. **状态卡 + 单一主按钮**。原来「翻译本页」是开关，语义含糊（关掉等于恢复原文？）。改为按钮，文字随状态变化：翻译本页 → 恢复原文；暂停或额度上限（budgetCapped）时为「继续翻译」，普通本页上限只能恢复原文（与原行为一致）。按钮执行中显示「正在处理…」并禁用，避免重复点击。
3. **词典 / 模型双引擎行**。解决两类翻译混淆：每行有类型标签、状态和各自的操作。
4. **禁用原因行**。`!configurationReady`、未配置模型、范围外、总开关关闭时，开关下方显示原因和一键修复入口。
5. **「更多」折叠区**。4 个低频开关收起，展开状态存入 `localStorage`（`gcn:popup-more-open`）。
6. **具体的 Toast**。「已排除当前站点 example.com」「已恢复原文」「模型连接成功，延迟 280ms」「密钥无效（401）」。Toast 系统已支持参数，只需新增文案键。
7. **敏感页面明确提示**。复用 `isSensitivePage()`，状态卡显示「当前页面已跳过翻译（账户、支付、邮件等敏感页面）」，不再只是灰按钮。
8. **模型配置预设 + 连接状态徽章**。Options 模型页顶部加服务商卡片（DeepSeek / OpenAI / Claude / 自定义），点选只填 Base URL，不覆盖已有密钥；连接状态徽章区分已连接、密钥无效、超时、无法连接、未配置。保存并测试时显示延迟。
9. **导航分组**。Options 侧栏按常规 / 翻译 / 词典 / 高级分组，减少横向标签的扫描成本。
10. **从 Popup 直达本站设置**。Footer 的「本站设置」打开 `options.html#wt-dictionary-title`，「模型设置」打开 `#wt-title`。

## 4. Popup 结构草图

```
┌──────────────────────────────────────┐
│ [logo] 网页汉化助手 v0.2.0   ◐   [●━] │  ← 总开关
├──────────────────────────────────────┤
│ github.com                 ● 已翻译   │
│ ┌──────────────────┐ ┌────────────┐  │
│ │    恢复原文       │ │  排除本站   │  │
│ └──────────────────┘ └────────────┘  │
│ ⚠ 3 段翻译失败              [全部重试] │
├──────────────────────────────────────┤
│ [词典] GitHub 界面词库       已翻译    │
│ [模型] deepseek-chat                  │
│        本站自动翻译              [━●] │
├──────────────────────────────────────┤
│ 更多功能                           ▾  │
│   自动弹窗                       [●━] │
│   网页悬浮入口                   [●━] │
│   视频字幕翻译                   [━●] │
│   输入翻译                       [━●] │
│   未配置模型 · 去配置                 │
├──────────────────────────────────────┤
│ 本站设置 →   模型设置 →            ⚙  │
└──────────────────────────────────────┘
```

未配置模型时，模型行变成引导卡：

```
│ [模型] 未配置                          │
│ 配置后可整页翻译、划词、字幕、输入翻译    │
│ [ 1 分钟完成配置 → ]                    │
```

## 5. 组件

| 文件 | 作用 |
| --- | --- |
| `src/entrypoints/popup/App.vue` | 新布局，总开关进 Header |
| `src/entrypoints/popup/PageStatusCard.vue` | 新：状态卡，主按钮、排除本站、失败重试、敏感/范围外说明 |
| `src/entrypoints/popup/TranslationControls.vue` | 改：双引擎行 + 「更多」折叠 + 禁用原因 |
| `src/components/ui/UiBadge.vue` | 新：状态徽章（tone: neutral / success / attention / danger / accent），从 Popup 原 `.state` 样式抽出 |
| `src/entrypoints/options/ModelPresets.vue` | 新：服务商预设卡片 |
| `src/entrypoints/options/ConnectionStatus.vue` | 新：连接状态徽章 + 测试连接按钮 |

逻辑仍在 `usePopup.ts` / `useTranslationControls.ts`；新增：

- `useTranslationControls`：`sensitive`、`excludeSite()`（`wt:set-site-excluded`）、`siteExcluded`、`modelName`、`disabledReason`、`openOptionsAt(hash)`。
- 连接测试：Options 里在 `wt:test` 前后记时，按 `reply.code`（`auth`、`timeout`、`network`、`not_found`、`rate_limited`、`server`）映射文案。

## 6. 样式调整

在 `theme.css` 增加（cyber/glass 各自覆盖）：

```css
--gcn-engine-dict-fg / --gcn-engine-dict-bg     /* 词典标签：沿用 success 色 */
--gcn-engine-model-fg / --gcn-engine-model-bg   /* 模型标签：accent 色 */
--gcn-card-bg / --gcn-card-border / --gcn-card-radius
--gcn-duration-theme: 160ms                       /* 主题切换过渡 */
```

- cyber：状态卡用 `--gcn-surface` + 1px accent 角标（复用 options 面板的 `::before/::after` 角标，缩小为 8px）；主按钮带 `0 0 12px #55e5ff40` 光晕。
- glass：状态卡 `backdrop-filter: blur(var(--gcn-surface-blur))`，圆角 14px；主按钮占满宽度（已有规则）。
- 主题切换无闪烁：首屏已经由 `initUiPreferences()` 在挂载前应用；切换时只给 `background-color, color, border-color` 加 `--gcn-duration-theme` 过渡，`prefers-reduced-motion` 下关闭。不要给 `*` 加过渡。

## 7. 模型配置与首次引导流程

1. Popup 检测到 `baseUrl` 或 `model` 为空 → 模型行显示引导卡 →「1 分钟完成配置」打开 `options.html#wt-title`。
2. Options 模型页顶部显示预设卡片。点选：
   - DeepSeek：`https://api.deepseek.com`
   - OpenAI：`https://api.openai.com/v1`
   - Claude：`https://api.anthropic.com/v1`（Anthropic 的 OpenAI 兼容端点）【待验证：模型列表接口是否可用】
   - 自定义：清空 Base URL，聚焦输入框
   只写 Base URL 和接口类型（chat-completions），模型名留空，提示用「获取模型」。不预填模型名，避免模型下线后出错。
3. 用户填 API Key → 点「获取模型」或手动填写 → 「保存并连接」（已有）。
4. 保存后自动 `wt:test`：
   - 成功：徽章「已连接 · 280ms」。单独点「测试连接」时另弹 Toast「模型连接成功，延迟 280ms」；「保存并连接」已有行内结果，不再弹 Toast。
   - `auth`：「密钥无效」，提示检查 API Key。
   - `timeout`：「连接超时」，提示检查网络或换模型。
   - `network`：「无法连接」，提示检查 Base URL。
   - `not_found`：「地址或模型不存在」。
   - `rate_limited`：「请求过于频繁」。
   - 其他：显示后台返回的 `error` 原文。
5. 徽章状态只在本次打开的设置页内有效（不持久化）；未测试时按配置是否完整显示「未测试」或「未配置」。

## 实现后的调整

- 失败重试：内容脚本的 `status.auto` 在本站自动翻译与手动「翻译本页」时都为真，因此两种情况都可「全部重试」。暂停或达到上限时引擎不接受单独重试，失败行改为说明：可追加额度时提示点「继续翻译」，段数上限时提示无法重试。
- 只有页面主状态、GitHub 状态与连接状态三个徽章是读屏状态区（`UiBadge live`），避免 1.5 秒轮询时反复朗读。
- 加载阶段徽章显示「加载中」，不再先闪「自动翻译未开启」。
- 敏感页面徽章显示「已跳过」。
- GitHub 页面的词典行始终显示 GitHub 汉化引擎的状态（已翻译、已排除等）。

## 不在本轮实现（后续）

- 自定义词条批量编辑与导入预览（需要改 `useCustomEntries` 的导入流程，先解析成 diff 再确认）。
- 排除规则输入后预览匹配（需要一个当前标签页 URL 输入框 + `isPathExcluded` 实时计算）。
- 大页面实时进度（内容脚本的 `PageTranslationStatus` 没有已完成/总数字段，需扩展协议）。
- 浮动入口已有位置记忆（`FloatingPosition`），自定义外观留待后续。
