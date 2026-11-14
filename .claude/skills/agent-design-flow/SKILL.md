---
name: agent-design-flow
description: 用户要设计 Agent 的 Web 或 App 页面、启动或继续分阶段设计并生成代码与落地包时使用；不用于直接修改运行中的服务端或生产部署。
---

# Agent 设计流程

先确定用户自己的工作区和项目 id，再按七个阶段推进。项目 id 使用稳定的小写字母、数字与连字符，不接受绝对路径或 `..`。不要把资料和反馈放进脚手架源码目录。此套 Skill 位于开发侧；K3 才接入工作室运行时。只有管理员能进入工作室，一份脚手架只有一个设计项目，多个管理员共用；一份脚手架就是一个产品，先在本机设计和落地，再部署到服务器。

## 七个阶段与确认点

| 阶段 / Skill | 输入 | 产出 | 请用户确认什么 |
|---|---|---|---|
| 1 资料卡 / [agent-brief](../agent-brief/SKILL.md) | 用户想法、资料、参考图 | `brief-v1.md` | 定位、核心任务、范围、推断与假设 |
| 2 PRD / [prd-spec](../prd-spec/SKILL.md) | 已确认资料卡 | `prd-v1.md` | 完整需求、页面、流程、验收与本期不做 |
| 3 低保真 / [lofi-wireframe](../lofi-wireframe/SKILL.md) | 已确认 PRD | `wireframe-v1.html` | 分组、页面结构、按钮去向与状态覆盖 |
| 4 主题 / [theme-factory](../theme-factory/SKILL.md) | 已确认线框、参考图或受众信息 | `themes-r1.html`、`theme-v1.json` | 明确选择一套或组合后确认令牌 |
| 5 高保真 / [frontend-design](../frontend-design/SKILL.md) + [prototype-builder](../prototype-builder/SKILL.md) | PRD、已确认线框与主题 | `prototype-v1.html`、`structure-changes-v1.md` | 结构调整先单独确认；完成后确认原型和逐屏对照表 |
| 6 全流程走查 / [flow-walkthrough](../flow-walkthrough/SKILL.md) | 已确认原型、PRD、上一轮反馈 | `walkthrough-plan-v1.json`、`walkthrough-v1.html`、`walkthrough-r1.json` | 先确认计划再执行；逐屏反馈处理后确认走查结论 |
| 7 代码与落地包 / [design-handoff](../design-handoff/SKILL.md) | 各阶段已确认且相互匹配的最终版本 | `package-v1/`：manifest、完整 Agent（含 ui/）、design/、DEPLOY.md、PROMPT.md | 代码与原型对应、检查与确认记录真实、缺口明确、落地步骤和部署手册可核对 |

每个确认点都提供三种操作：**继续**（明确确认当前具体版本后进入下一步）、**修改**（按反馈生成当前步的新版本并重新展示）、**结束**（保存当前版本和反馈，停止推进）。沉默、看过预览、下载文件都不是确认。工作室在页面里逐步展示线框、主题、高保真和走查；预览不能用截图替代。

回到上游修改后，保留历史产物，标明受影响的下游版本需要重新核对；不得继续使用已失配的确认记录。用户单独调用阶段 Skill 时也先检查依赖和确认记录。代码包确认后结束设计；本机落地由脚手架自带的固定命令执行，不自动落地或发布。落地后删除工作室，设计记录保存到 `app/design/<产品 id>/`；需要更深入的开发时，由用户本地的 Codex 或 Claude Code 接着做。

## 产物约定（其他 Skill 与 K3 前端共同遵守）

项目目录固定为 `outputs/design/<项目 id>/`。工作区的 `outputs/` 只能新建、不能覆盖。每个文件族使用正整数版本，初版如下：

| 文件 | 内容 |
|---|---|
| `brief-v1.md` | 资料卡正文与结构化 JSON |
| `prd-v1.md` | 完整 PRD |
| `wireframe-v1.html` | 低保真线框 |
| `themes-r1.html` | 第 1 轮三套主题及历史候选记录 |
| `theme-v1.json` | 用户选定的主题令牌 |
| `prototype-v1.html` | 高保真交互原型及逐屏对照 |
| `structure-changes-v1.md` | 结构调整提案与确认依据，无调整也写明 |
| `walkthrough-plan-v1.json` | 走查范围和复现计划 |
| `walkthrough-v1.html` | 走查页，含内嵌原型、反馈和导出能力 |
| `walkthrough-r1.json` | 第 1 轮完成时的反馈快照 |
| `package-v1/…` | 不可变代码与落地包，含 manifest.json、agent/（含 ui/）、design/、DEPLOY.md、PROMPT.md；文件哈希、确认记录和最低目标版本随包保存 |
| `decisions-v1.json` | 阶段确认、修改意见、结束位置和累计澄清轮数 |

同一文件族内编号最大的就是最新版本；按数字比较，例如 v10 大于 v9，不能按字符串或修改时间排序。主题候选和走查分别独立计轮。编号已存在就新建下一号，不覆盖、不复用。新建失败或结果不明时先核对已有文件，不能把失败当成功。最新版本不等于已确认版本，下游同时核对 `decisions-v<n>.json` 的具体文件及其输入版本。

反馈自动保存采用追加快照：轮次进行中写 `walkthrough-r<n>-v<k>.json`，k 每次保存递增；本轮完成后新建一次 `walkthrough-r<n>.json`，随后只在下一轮写入。恢复时先找最大轮次，再找该轮最大的保存版本或完成文件。普通阶段的意见保存在递增的 `decisions-v<n>.json`；不依赖聊天记录作为唯一存档。所有反馈和候选历史也在用户工作区。

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

`operation` 只用 `continue`、`modify`、`end`；后两者的 `confirmedAt` 为 null，事件另外记录 `recordedAt`。每份记录保留既有事件原文并追加本次意见。资料卡与 PRD 共用 `clarificationRounds`，合计最多约 3 轮，不分别各问 3 轮。阶段验收确认不计入澄清轮数。

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
- 无定位 hash 时按组和顺序平铺所有屏幕与状态，顶部展示流程总览。有 `#screen=<id>&state=<状态>` 时仅显示目标屏及状态，隐藏总览与其他屏；初次加载和 `hashchange` 都生效。未知定位显示中文错误与返回总览入口，不默默跳回默认页。参数按 URL 规则编码和解码。
- 主题对比中同一线框重复三次，为样页 id 增加候选前缀（如 `a-task-list`），候选元数据用 `sourceScreenId` 记录原线框 id；正式原型恢复并保留线框 id。不能让三套样页共用同一 `(id,state)`。
- 工作室读取 `design-outline` 生成左侧目录；目录、实际 section、按钮 `to` 必须互相对应。把 JSON 内的 `<` 转义为 `\u003c`，防止内容提前结束 script。

### 单文件与嵌入安全

设计预览产物的所有 HTML 单文件、可离线完整打开：CSS、脚本、示例数据和所需图片全部内嵌，不加载 CDN、远程字体、远程模块或接口；字体只用系统字体栈。不得用外部文件引用凑成“单文件”。走查页将原型全文内嵌，再以带定位 hash 的 data URL 放入 iframe，避免依赖另一个 HTML 文件。实现时验证离线下的定位和交互。第 7 阶段 `agent/ui/` 是实际前端，接入按 K2 约定：JS / CSS 分文件，不使用内联脚本和样式，不引用外部资源，遵守正式页面 CSP；不把原型示例数据写死为业务结果。

模型生成内容视为不可信。工作室文本用 `textContent`；HTML 在带 `sandbox` 的 iframe 中预览，不加 `allow-same-origin`，服务端配合 CSP `sandbox`；需要交互时仅按宿主能力开放 `allow-scripts` 等必要权限。反馈区在可信宿主中，不在不可信原型里；不要让原型直接读写工作区或读取父页面。导入 JSON 校验字段、版本、项目与屏幕标识，用户文字作为文本呈现。

## 两种运行环境

- **工作室运行时（K3）**：只用已授权工具在用户工作区创建产物，通过工作室页面嵌入预览、保存反馈。复杂原型使用预装模板与离线构建链，不执行联网安装。工作室生成代码包，不修改服务端代码，不部署、不扩张权限。包内包含完整 Agent 与按原型实现的前端、部署手册和本地编码助手提示词，不含宿主机脚本。宿主保存、预览或模板能力缺失时明确说明缺口，保留产物并停止依赖该能力的步骤，不能声称已经保存。
- **用户本地 Codex / Claude Code**：在授权工作区写产物，开发侧可以按官方方式用 npm 安装构建工具，但不能越过仓库依赖约束。临时源码和构建中间件在 `outputs/` 外的隔离目录；最终单文件才写入新版本。单独打开走查 HTML 时自动存浏览器本地存储，支持导出后放回用户工作区。本机按 K4 固定命令（暂定 `docker compose run --rm land` 或 app/ 下的 `npm run design:land`）落地，再验证和部署。K2 / K4 未提供时不能伪称接入或落地成功。K5 将提供 `build-from-design`；未提供时仍可按包内 PROMPT.md 直接核对、落地、完成需要开发项，并用 flow-walkthrough 的真实产品模式走查。
