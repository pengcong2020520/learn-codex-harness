---
name: theme-factory
description: 用户要为已确认 Agent 线框选择主题、从参考图提炼主题或再出三套主题时使用；不用于改页面结构、直接生成高保真或制作通用演示文稿。
---

先读 [总流程与产物约定](../agent-design-flow/SKILL.md)。所有路径相对于用户自己的工作区；只新建版本，不覆盖历史文件。使用最新且已获用户确认的输入版本；较新的未确认版本不能替代确认记录。当前阶段经用户明确选择「继续」后才进入下一阶段；「修改」重做当前步，「结束」保存进度并停止。

# 用真实线框选主题

改编来源、修改范围和许可证见 [NOTICE.md](NOTICE.md)、[LICENSE.txt](LICENSE.txt)。保留官方预设、明确选择后应用及自定义主题的方法。输入是最新已确认线框（初版 `wireframe-v1.html`）、PRD、用户受众和参考资料。

## 进入阶段前先问参考图

进入本阶段前，在聊天里询问是否上传参考的风格或主题图片，提供“上传参考图”“不用，直接出选项”快捷回复。支持多张和拖拽上传，也可粘贴或选择文件；预览区不再放上传入口。

- **上传参考图**：只用 `config/models.json` 中 `inputs` 含 `image` 且适用于当前对话的模型看图，开发侧路径相对于 `app/`。核对可用模型后分析色彩、字号节奏、圆角、间距、阴影与受众特征；不照搬参考图的页面结构。没有合适模型时说明无法看图，请用户用文字描述或改选 AI 出三套，不声称已分析图片。上传文件沿用扩展名和文件头校验。
- **两道三选一**：视觉风格、配色与字体各一道选择题。视觉风格的版式密度、控件形态和质感完全不同；配色与字体的色相、明暗和字体气质完全不同，不能只换名称。视觉风格仍保持已确认的页面、字段分组、按钮位置与跳转关系，不以风格选择暗改结构。参考图同样用于生成这两道题的候选。

## 官方 10 套预设

按需读对应文件，保留原始参考，不依赖其中字体已安装：

| 名称 | 预设 |
|---|---|
| Ocean Depths / 海洋深处 | [ocean-depths.md](themes/ocean-depths.md) |
| Sunset Boulevard / 日落大道 | [sunset-boulevard.md](themes/sunset-boulevard.md) |
| Forest Canopy / 森林冠层 | [forest-canopy.md](themes/forest-canopy.md) |
| Modern Minimalist / 现代极简 | [modern-minimalist.md](themes/modern-minimalist.md) |
| Golden Hour / 金色时刻 | [golden-hour.md](themes/golden-hour.md) |
| Arctic Frost / 北极霜色 | [arctic-frost.md](themes/arctic-frost.md) |
| Desert Rose / 沙漠玫瑰 | [desert-rose.md](themes/desert-rose.md) |
| Tech Innovation / 科技创新 | [tech-innovation.md](themes/tech-innovation.md) |
| Botanical Garden / 植物花园 | [botanical-garden.md](themes/botanical-garden.md) |
| Midnight Galaxy / 午夜星河 | [midnight-galaxy.md](themes/midnight-galaxy.md) |

实际字体只用系统字体栈，以字重、字号和间距还原意图；预设中的专用字体仅作参考，不下载字体。允许生成具名自定义主题，先展示，再由用户明确选定。

## 样页与换一换

1. 从最新已确认线框选 2–3 屏核心页面与同一组状态，用真实文案和控件。产品不足 2 屏时展示全部并说明原因，不虚构页面。
2. 两道题放在聊天选择卡片中，每题三个完全不同的候选，各自带“换一换”，也支持自然语言选择。换一换只更新当前题的三个选项，保留另一题的选择；新选项不与已展示过的重复。
3. 每轮产出 `themes-r1.json`（后续 `themes-r<n>.json`），字段包含 `schemaVersion`、`round`、`wireframe`、`samples`（`sourceScreenId`、`state`）、`styles` 与 `themes`（各三个 `id`、`name`、`rationale`、`tokens`）、`shownHistory`（累计两题所有已展示候选及令牌）。先读历史轮次，比较规范化令牌和视觉方向；不能只改名或预设用完后循环。
4. 同时产出一个可换肤的单文件样页 `theme-sample-v1.html`，后续 `theme-sample-v<n>.html`。左侧目录切换核心样页，不用标签条，不并排复制三套屏幕。点选候选后把当前“风格 × 主题”的合并令牌传给样页，即时换肤；未选定的演示组合不算用户确认。
5. 样页从定位 hash 的 `theme=` 参数读取 base64url 编码的 JSON 令牌，与 `screen`、`state` 并存；首载和 `hashchange` 都处理。解码 UTF-8 JSON 后校验字段和类型，只把白名单令牌映射为 CSS 变量，用 `style.setProperty` 更新，不拼 HTML 或整段样式，不接受 `url()` 或外部资源。错误令牌显示中文提示，不悄悄当作已选主题。
6. 两道题都选定后，核对组合效果与对比度，请用户确认，再写 `theme-v1.json`（后续 `theme-v<n>.json`），保存风格和主题的两个候选 id、来源轮次与确认记录。只有一道题选定时不能写最终主题文件。

HTML 必须是可离线打开的单文件，只用系统字体栈。每屏使用 `<section data-screen="<id>" data-state="<状态>" data-group="<分组>">`；支持 `#screen=<id>&state=<状态>` 只显示对应屏，且监听地址变化。内嵌 `design-outline`（`application/json`），结构与总流程一致。固定状态词表为 default、first-use、permission、loading、empty、error、recovery；自定义状态列入大纲。工作室中嵌入预览，不截图。

样页沿用源线框 id 与状态，`sourceScreenId` 保留映射；同一套 section 通过 CSS 变量换肤，所有 `(screen,state)` 唯一。无定位时显示第一个核心样页，指定定位时仅展示目标屏。

主题令牌 JSON 必须包含如下类别；具体值按用户选择生成，不能把示例默认套给所有产品：

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "name": "清晰任务",
  "source": {"round":1,"candidateIds":["r1-style-a","r1-theme-b"],"combination":"视觉风格 A + 配色与字体 B","wireframe":"wireframe-v1.html"},
  "confirmedAt": "2026-11-14T12:00:00Z",
  "confirmedBy": "项目用户",
  "tokens": {
    "colors": {"background":"#ffffff","surface":"#f3f5f7","text":"#182434","muted":"#4b5b70","border":"#b6c2cf","primary":"#2455a4","onPrimary":"#ffffff","focus":"#2455a4","success":"#146b45","warning":"#805400","error":"#b42318","info":"#2455a4","disabled":"#e1e5eb"},
    "typography": {"headingFamily":"system-ui, sans-serif","bodyFamily":"system-ui, sans-serif","monoFamily":"ui-monospace, monospace","sizes":{"caption":12,"body":16,"h3":20,"h2":28,"h1":36},"weights":{"body":400,"heading":600},"lineHeights":{"body":1.5,"heading":1.2}},
    "radii": {"small":4,"medium":8,"large":12},
    "spacing": {"xs":4,"sm":8,"md":16,"lg":24,"xl":32},
    "shadows": {"none":"none","raised":"0 2px 8px rgb(24 36 52 / 12%)"}
  }
}
```

数字尺寸单位为 px，行高为倍数；颜色及状态色、字号层级、圆角、间距、阴影缺一不可。确认人和时间来自实际确认记录，禁止套用示例。不要使用官方 `theme-showcase.pdf`，真实线框样页已经替代它。

## 展示前的布局门槛

交付前必须通过 [layout-qa](../layout-qa/SKILL.md)，首版和每次改版同样检查全部屏幕与状态。运行时调用 `check_design`（K3a-2 提供），开发侧运行 `node app/scripts/layout-check.mjs <html>`；错误修好再展示，不能把生成成功当成校验通过。
