---
name: agent-design-flow
description: 用户要设计 Agent 的 Web 或 App 页面、启动或继续分阶段设计并生成代码与落地包时使用；不用于直接修改运行中的服务端或生产部署。
---

# Agent 设计流程

先确定用户自己的工作区和项目 id，再按七个阶段推进。项目 id 使用稳定的小写字母、数字与连字符，不接受绝对路径或 `..`。不要把资料和反馈放进脚手架源码目录。开发侧与工作室使用同一套阶段约定，运行时补充规则见各 Skill 末尾。只有管理员能进入工作室，一份脚手架只有一个设计项目，多个管理员共用；一份脚手架就是一个产品，先在本机设计和落地，再部署到服务器。

## 七个阶段与确认点

资料卡由前端提交；工作室只有 design 一个工作流，从澄清起执行六步。

| 阶段 / Skill | 输入 | 产出 | 请用户确认什么 |
|---|---|---|---|
| 1 资料卡 / [agent-brief](../agent-brief/SKILL.md) | 用户想法、资料、参考图；工作室读 inputs/drafts/brief.json | 资料卡草稿 | 定位、核心任务、范围 |
| 2 澄清 / agent-brief | 资料卡、附件、已答问题 | clarify-r1.json、brief-v1.md | 最多 3 轮、每轮最多 5 题；信息完整可直接 final；确认资料卡具体版本 |
| 3 PRD / [prd-spec](../prd-spec/SKILL.md) | 已确认资料卡 | prd-v1.md | 需求、页面、流程、验收与本期不做 |
| 4 低保真 / [lofi-wireframe](../lofi-wireframe/SKILL.md) | 已确认 PRD | wireframe-v1.html、qa/lofi-review-v1.json | 页面、按钮去向和状态覆盖，布局及自审结果 |
| 5 主题 / [theme-factory](../theme-factory/SKILL.md) | 已确认线框、参考图或受众信息 | themes-r1.json、theme-sample-v1.html、theme-v1.json | 风格、配色字体两道三选一的组合及令牌 |
| 6 高保真 / [frontend-design](../frontend-design/SKILL.md) + [prototype-builder](../prototype-builder/SKILL.md) | 已确认 PRD、线框、主题 | prototype-v1.html、structure-changes-v1.json、qa/hifi-review-v1.json | 结构提案先确认；完整原型、逐屏逐状态自审与布局结果 |
| 7 代码与落地 / [design-handoff](../design-handoff/SKILL.md) | 各阶段相互匹配的已确认版本 | package-v1/、qa/package-check.json | 文件清单、检查、开发缺口和本机指引；工作流末步完成不代表包获确认或已部署 |

每个确认点都提供三种操作：**继续**（明确确认当前具体版本后进入下一步）、**修改**（按反馈生成当前步的新版本并重新展示）、**结束**（保存当前版本和反馈，停止推进）。沉默、看过预览、下载文件都不是确认。工作室在页面里逐步展示线框、主题和高保真；预览不能用截图替代。

回到上游修改后，保留历史产物，标明受影响的下游版本需要重新核对；不得继续使用已失配的确认记录。用户单独调用阶段 Skill 时也先检查依赖和确认记录。代码包确认后结束设计；本机落地由脚手架自带的固定命令执行，不自动落地或发布。落地后删除工作室，设计记录保存到 `app/design/<产品 id>/`；需要更深入的开发时，由用户本地的 Codex 或 Claude Code 接着做。

## 产物约定（其他 Skill 与 K3 前端共同遵守）

项目目录固定为 `outputs/design/<项目 id>/`。工作区的 `outputs/` 只能新建、不能覆盖。每个文件族使用正整数版本，初版如下：

| 文件 | 内容 |
|---|---|
| `clarify-r1.json` | 澄清轮次、是否结束、最多 5 个问题；第 3 轮必须 final=true |
| `brief-v1.md` | 资料卡正文与结构化 JSON |
| `prd-v1.md` | 完整 PRD |
| `wireframe-v1.html` | 低保真线框 |
| `themes-r1.json` | 第 1 轮视觉风格与配色字体各三套令牌、累计候选历史 |
| `theme-sample-v1.html` | 从定位 hash 的 `theme=` 参数读取令牌、即时换肤的单文件样页 |
| `theme-v1.json` | 用户选定的主题令牌 |
| `prototype-v1.html` | 高保真交互原型及逐屏对照 |
| `structure-changes-v1.json` | 结构调整提案与确认依据，无调整也写明 |
| `qa/lofi-review-v1.json`、`qa/hifi-review-v1.json` | 每屏每状态的检查项、结论与证据，关联实际布局报告 |
| `qa/package-check.json` | check_agent_package 的真实结果；修订保存在各新包 qa/ 下，不覆盖首份项目摘要 |
| `package-v1/…` | 不可变代码与落地包，含 manifest.json、agent/（含 ui/）、design/、DEPLOY.md、PROMPT.md；文件哈希、确认记录和最低目标版本随包保存 |
| `decisions-v1.json` | 阶段确认、修改意见、结束位置和累计澄清轮数 |

同一文件族内编号最大的就是最新版本；按数字比较，例如 v10 大于 v9，不能按字符串或修改时间排序。澄清与主题候选分别独立计轮。编号已存在就新建下一号，不覆盖、不复用。新建失败或结果不明时先核对已有文件，不能把失败当成功。最新版本不等于已确认版本，下游同时核对 `decisions-v<n>.json` 的具体文件及其输入版本。

普通阶段的意见保存在递增的 `decisions-v<n>.json`，保留用户原话；不依赖聊天记录作为唯一存档。前端草稿可覆盖，但不能覆盖或冒充已确认产物。所有步骤先读 `inputs/drafts/project.json` 的 `{id,name}`；草稿只是输入，确认必须有用户明确操作依据。

确认记录示例（时间用 ISO 8601；确认人来自当前已认证用户或本地用户明确指定的称呼，不要求个人邮箱）：

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "clarificationRounds": 1,
  "currentStage": "prd",
  "events": [
    {
      "stage": "brief",
      "operation": "continue",
      "artifact": "brief-v1.md",
      "inputs": [],
      "confirmedAt": "2026-11-14T12:00:00Z",
      "confirmedBy": "项目用户",
      "feedback": "按资料卡继续"
    }
  ]
}
```

`operation` 只用 `continue`、`modify`、`end`；后两者的 `confirmedAt` 为 null，事件另外记录 `recordedAt`。每份记录保留既有事件原文并追加本次意见。资料卡与 PRD 共用 `clarificationRounds`，合计最多 3 轮，不分别各问 3 轮。阶段验收确认不计入澄清轮数。

### 屏幕定位与大纲

线框、原型、主题样页每一屏必须标注：

```html
<section data-screen="task-list" data-state="default" data-group="main-flow"></section>
<script type="application/json" id="design-outline">
{"groups":[{"id":"main-flow","title":"完成任务","order":1,"screens":[{"id":"task-list","title":"任务列表","position":1,"actions":[{"label":"新建任务","to":"#screen=task-create&state=default"}],"states":["default","empty"]},{"id":"task-create","title":"创建任务","position":2,"actions":[{"label":"返回列表","to":"#screen=task-list&state=default"}],"states":["default"]}]}]}
</script>
```

- `groups:[{ id, title, order, screens:[{ id, title, position, actions:[{ label, to }], states:[…] }] }]` 是固定结构。`order`、`position` 为从 1 开始的整数；`states` 是状态名字符串数组。`to` 是指向已有屏幕和状态的定位 hash，不使用随意的自然语言目的地。
- `data-screen` 在同一产物大纲内唯一；一个屏幕的不同状态共用 id，`(id,state)` 在 HTML 中唯一，`data-group` 对应分组 id。id 在版本间稳定；双端用 `web-`、`app-` 前缀区分。新增结构须经用户确认。
- 固定状态词表：default、first-use、permission、loading、empty、error、recovery。只覆盖 PRD 涉及的状态；其他状态可以自定义，但须列入大纲。每个状态都有可直接展示的示例数据，不能无限停在加载态。
- 打开即是产品的一屏，无定位 hash 时显示流程入口，不显示顶部总览。`#screen=<id>&state=<状态>` 仅显示目标屏及状态；初次加载和 `hashchange` 都生效。未知定位显示中文错误与返回入口，不默默跳回默认页。参数按 URL 规则编码和解码。默认收起的评审切换器承载分组、名称、位置、操作去向与悬停提示；平铺查看全部作为可选模式，只有此模式允许整页滚动。
- 主题样页保留源线框 id 与状态，同一套 section 用 CSS 变量换肤，不复制三份屏幕；候选元数据用 `sourceScreenId` 记录源线框。每个 `(id,state)` 仍唯一。
- 工作室读取 `design-outline` 生成左侧目录；目录、实际 section、按钮 `to` 必须互相对应。把 JSON 内的 `<` 转义为 `\u003c`，防止内容提前结束 script。

### 单文件与嵌入安全

设计预览产物的所有 HTML 单文件、可离线完整打开：CSS、脚本、示例数据和所需图片全部内嵌，不加载 CDN、远程字体、远程模块或接口；字体只用系统字体栈。不得用外部文件引用凑成“单文件”。实现时验证离线下的定位和交互。第 7 阶段 `agent/ui/` 是实际前端，接入按 K2 约定：JS / CSS 分文件，不使用内联脚本和样式，不引用外部资源，遵守正式页面 CSP；不把原型示例数据写死为业务结果。

模型生成内容视为不可信。工作室文本用 `textContent`；HTML 在带 `sandbox` 的 iframe 中预览，不加 `allow-same-origin`，服务端配合 CSP `sandbox`；需要交互时仅按宿主能力开放 `allow-scripts` 等必要权限。反馈区在可信宿主中，不在不可信原型里；不要让原型直接读写工作区或读取父页面。导入 JSON 校验字段、版本、项目与屏幕标识，用户文字作为文本呈现。

## 两种运行环境

- **工作室运行时（K3）**：只用已授权工具在用户工作区创建产物，通过工作室页面嵌入预览、保存反馈。复杂原型使用 build_prototype 离线编译，再用 check_design 核对。工作室生成代码包，不修改服务端代码，不部署、不扩张权限。包内包含完整 Agent 与按原型实现的前端、部署手册和本地编码助手提示词，不含宿主机脚本。宿主保存、预览或模板能力缺失时明确说明缺口，保留产物并停止依赖该能力的步骤，不能声称已经保存。
- **用户本地 Codex / Claude Code**：在授权工作区写产物，开发侧可以按官方方式用 npm 安装构建工具，但不能越过仓库依赖约束。临时源码和构建中间件在 `outputs/` 外的隔离目录；最终单文件才写入新版本。本机在 app/ 使用 bash deploy/land.sh --package <包目录> 落地，再按已确认设计开发、巡查和部署。

## 聊天、意见与阶段页面

- 聊天采用一问一答，只给摘要并指向预览，不堆长文。执行中有默认收起、可展开的“思考中”，展示当前步骤与执行进度摘要；不要求披露模型内部推理。确认和修改通过快捷回复，也可直接用自然语言说。
- 意见要立刻生效：运行中用 `steer` 追加意见，等待确认时用 `revise` 重做当前步。前端只有一个“发意见”入口，由服务端根据状态选择，不能把意见只留在聊天记录里。
- 工作室的资料卡、澄清两个页面不显示聊天；表单与页面操作直接提交。其他阶段保留聊天，预览区和聊天区尽量占满可用空间，不添加说明条、操作条或标注框。
- 澄清最多 3 轮，以表单形式出现，每轮最多 5 题，每题带选项和推荐项；累计轮数写入确认记录，不另起一套计数。
- 预览不使用标签条，用醒目的左侧目录按分组、屏和状态导航。Web 遵守一屏原则，1440×900、1280×720 不出现整页滚动，长内容在区域内滚动。侧栏用 `<`、`>` 轻量收起和展开。
- 低保真、主题样页、高保真在展示前必须通过 [layout-qa](../layout-qa/SKILL.md)。生成不等于通过；布局错误最多自动修 2 轮，仍有错误则如实列出，不标成已通过。

## 设计结束后在本机推进

落地 → 开发 → 本机运行 → 巡查 → 修复 → 部署。先按包内 PROMPT.md 核对 K4 固定落地命令，前端按确认原型、后端按 PRD 开发，执行检查与构建，再启动真实产品。开发完成后、部署前在本机使用 [flow-walkthrough](../flow-walkthrough/SKILL.md)：先列计划等用户确认，再操作截图、收集反馈，按前端 / 后端 / 整体归类修复、回归；巡查通过后才运行 production:check 和部署。巡查产物保存到 app/design/<项目 id>/walkthrough/，不属于工作室工作流或工作室产物约定。使用 bash deploy/walkthrough.sh 运行确认计划，打开轮次目录的 index.html 填写并导出反馈。

## 在工作室运行时

采用 studio-contract 约定的 inputs/drafts/ 草稿与产物格式，按 role.md 和本步 goal 读取输入、记录版本及反馈。开发侧的脚本与模板归档不随运行时副本携带，运行时不执行脚本；用 check_design 代替本机布局脚本。简单方式直接写 HTML；复杂原型使用 build_prototype 离线编译 React JSX、Tailwind 与 shadcn 组件。运行时的主题阶段只生成候选、样页和检查结果，用户在前端确认双选后由 hifi 开头核对草稿并保存 theme 版本，再检查实际组合并制作原型。结构化草稿及固定触发文字以 studio-contract 为唯一来源。写入或工具结果不明先核对，不自动重试；结束只回一两句摘要与产物位置。
