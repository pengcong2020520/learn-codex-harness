---
name: theme-factory
description: 用户要为已确认 Agent 线框选择主题、从参考图提炼主题或再出三套主题时使用；不用于改页面结构、直接生成高保真或制作通用演示文稿。
---

先读 [总流程与产物约定](../agent-design-flow/SKILL.md)。所有路径相对于用户自己的工作区；只新建版本，不覆盖历史文件。使用最新且已获用户确认的输入版本；较新的未确认版本不能替代确认记录。当前阶段经用户明确选择「继续」后才进入下一阶段；「修改」重做当前步，「结束」保存进度并停止。

# 用真实线框选主题

改编来源、修改范围和许可证见 [NOTICE.md](NOTICE.md)、[LICENSE.txt](LICENSE.txt)。保留官方预设、明确选择后应用及自定义主题的方法。输入是最新已确认线框（初版 `wireframe-v1.html`）、PRD、用户受众和参考资料。

## 两个入口

- **上传参考图**：只用 `config/models.json` 中 `inputs` 含 `image` 且适用于当前对话的模型看图，开发侧路径相对于 `app/`。核对可用模型后分析色彩、字号节奏、圆角、间距、阴影与受众特征；不照搬参考图的页面结构。没有合适模型时说明无法看图，请用户用文字描述或改选 AI 出三套，不声称已分析图片。上传文件沿用扩展名和文件头校验。
- **AI 出三套**：从预设或自定义方向提出三套明显不同、贴合产品与受众的方案。区别至少体现在色彩关系、明暗、字体角色或控件质感上，不仅换名称；说明每套为什么适合本产品。参考图入口同样整理出三套可选方案，可包含忠实提炼和有理由的变体。

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

1. 从最新线框选 2–3 屏核心页面（如入口、主要任务、结果），选同一组状态，用真实文案和控件。产品不足 2 屏时展示全部并说明原因，不虚构页面。
2. 同一组样页分别套三套主题，保持布局、字段、按钮和去向不变。产出 `themes-r1.html`，后续 `themes-r<n>.html`：三套并排，每套显示名称、色板、字体组合、选择理由、套用后的样页。
3. 每轮在 HTML 内另嵌 `theme-candidates` JSON，字段为 `round`、`wireframe`、`samples`（`sourceScreenId`、`state`）、`candidates`（`id`、`name`、`rationale`、`tokens`）、`shownHistory`（累计各轮候选及令牌）。可用令牌规范化 JSON 的摘要辅助去重，但还要比较视觉方向，不能只判断名字。
4. 用户说“换一换，再出三套”时，读取历史所有 `themes-r<n>.html` 的候选记录；新的三套不能与展示过的主题重复，也不能只是换名。10 套预设用尽后给新的自定义主题，不循环冒充新方案。
5. 必须等用户明确选择后才应用。支持“A 的配色 + B 的字体”，组合后核对对比度和一致性，展示结果请用户确认，不能擅自替用户选定。选定后新建 `theme-v1.json`。

HTML 必须是可离线打开的单文件，只用系统字体栈。每屏使用 `<section data-screen="<id>" data-state="<状态>" data-group="<分组>">`；支持 `#screen=<id>&state=<状态>` 只显示对应屏，且监听地址变化。内嵌 `design-outline`（`application/json`），结构与总流程一致。固定状态词表为 default、first-use、permission、loading、empty、error、recovery；自定义状态列入大纲。工作室中嵌入预览，不截图。

样页使用候选前缀 id，例如 `a-task-list`，`sourceScreenId` 保留源线框 id，组与跳转按相同前缀映射，避免定位命中三屏。无定位时三套并排；指定定位时仅展示某候选的目标样页。

主题令牌 JSON 必须包含如下类别；具体值按用户选择生成，不能把示例默认套给所有产品：

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "name": "清晰任务",
  "source": {"round":1,"candidateIds":["r1-a"],"combination":"整套采用","wireframe":"wireframe-v1.html"},
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
