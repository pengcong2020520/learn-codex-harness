---
name: flow-walkthrough
description: 用户要按真实用户顺序走查已确认原型、收集反馈或复核上一轮修改时使用；不用于跳过计划直接截图、擅自实现修改或部署产品。
---

先读 [总流程与产物约定](../agent-design-flow/SKILL.md)。所有路径相对于用户自己的工作区；只新建版本，不覆盖历史文件。使用最新且已获用户确认的输入版本；较新的未确认版本不能替代确认记录。当前阶段经用户明确选择「继续」后才进入下一阶段；「修改」重做当前步，「结束」保存进度并停止。

# 全流程走查

## 用户提示词原文

（用户提供、已实测的提示词原文）
现在产品的核心流程已经开发完成，我要做一轮完整的页面走查。请根据现有 PRD 和已经实现的功能，实际运行产品，按用户真实使用产品的先后顺序梳理流程，截取所有核心页面和关键状态，并生成一个本地的流程走查页面。

要求：
1. 按照用户的实际使用流程分组。每组一个小标题，从上往下看完就是一次完整的产品体验；
2. 除了正常页面，还要覆盖重要的流程分支，以及不同的页面状态；
3. 每一屏都要标注页面名称、当前状态和复现方式，并提供一个反馈输入框，以及「可以」「待改」「阻塞」三个快捷标记；
4. 每一组最后增加一个流程反馈输入框，用来记录反馈；
5. 所有反馈输入后自动保存在本地；
6. 支持导出 Markdown、导出 JSON，可以直接交给 AI 修改；
7. 在新一轮走查页中保留上一轮的反馈原话，并给改动过的页面加上标记，方便逐条回归验证。
先不要开始截图。先列出你准备覆盖的流程分组、页面和状态，等我确认之后再执行。

## 两种方式与先确认计划

- **原型走查**：K1 的主要方式，不截图。读取已确认原型（初版 `prototype-v1.html`）和 PRD。走查页每一屏用 iframe 按定位约定嵌入原型的实时状态，保留交互。原文中的“实际运行产品、截图”在此方式替换为运行原型和嵌入预览，其余 7 条全部执行。
- **真实产品走查**：仅用户本地开发侧执行，实际运行产品并截图。参考 [官方 webapp-testing 的 Playwright 做法](https://github.com/anthropics/skills/tree/main/skills/webapp-testing)：先检查服务与运行方式，页面加载后等待可用状态（适用时等待 networkidle），检查已渲染 DOM 确定选择器，按真实操作复现状态、截图，结束后关闭浏览器。K5 会完善执行 Skill；K1 不提供或声称已具备真实产品自动走查能力。运行中的工作室不得启动真实产品开发或改服务端。

两种方式都先列分组、页面、状态和复现方式，写 `walkthrough-plan-v1.json`（后续 `walkthrough-plan-v<n>.json`），把范围完整展示给用户。保留“先不要开始……等我确认之后再执行”的门禁；用户未确认计划前，不生成走查页、不截图、不执行产品操作。用户修改范围时生成计划新版本重新确认。计划确认不等于允许发送真实消息、付费或其他外部写入。

## JSON 契约（供 K3 前端读取）

计划使用以下完整结构。每个组列所有目标屏，`states` 用字符串数组与大纲一致；`reproduce` 的每个 key 对应一个状态，值是按顺序执行的中文步骤数组；`actions[].to` 与设计大纲相同。

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "mode": "prototype",
  "round": 1,
  "source": {"artifact":"prototype-v1.html","version":1},
  "prd": "prd-v1.md",
  "previousRound": null,
  "confirmation": {"status":"proposed","confirmedAt":null,"confirmedBy":null},
  "groups": [
    {
      "id":"main-flow","title":"完成任务","order":1,
      "screens":[
        {
          "id":"task-list","title":"任务列表","position":1,
          "actions":[{"label":"查看空列表","to":"#screen=task-list&state=empty"}],
          "states":["default","empty"],
          "reproduce":{
            "default":["打开原型，定位任务列表的 default 状态"],
            "empty":["打开原型，定位任务列表的 empty 状态"]
          }
        }
      ]
    }
  ]
}
```

计划一经确认不能覆写：生成下一号计划，`confirmation.status` 改为 `confirmed` 并记录真实时间和确认人，结构保持与用户确认的计划完全相同；若范围变化则重新确认。以下反馈示例的 `plan` 演示引用一个已确认的 v1，实际使用真实已确认文件名。

走查轮次与每次自动保存使用同一结构，文件初版为 `walkthrough-r1.json`；进行中的自动保存为 `walkthrough-r1-v1.json`，随后保存版本递增：

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "mode": "prototype",
  "round": 1,
  "saveVersion": 1,
  "status": "in-progress",
  "plan": "walkthrough-plan-v1.json",
  "source": {"artifact":"prototype-v1.html","version":1},
  "previousRound": null,
  "createdAt": "2026-11-14T12:00:00Z",
  "savedAt": "2026-11-14T12:00:00Z",
  "reviewer": "项目用户",
  "groups": [
    {
      "id":"main-flow","title":"完成任务","order":1,
      "feedback":{"text":"","updatedAt":null},
      "previousFeedback":[],
      "screens":[
        {
          "id":"task-list","title":"任务列表","position":1,
          "actions":[{"label":"查看空列表","to":"#screen=task-list&state=empty"}],
          "states":[
            {
              "state":"default",
              "reproduce":["打开原型，定位任务列表的 default 状态"],
              "preview":{"kind":"iframe","artifact":"prototype-v1.html","hash":"#screen=task-list&state=default","screenshot":null},
              "htmlHash":null,
              "changeStatus":"unknown",
              "changeEvidence":null,
              "feedback":{"text":"","mark":null,"updatedAt":null},
              "previousFeedback":[]
            },
            {
              "state":"empty",
              "reproduce":["打开原型，定位任务列表的 empty 状态"],
              "preview":{"kind":"iframe","artifact":"prototype-v1.html","hash":"#screen=task-list&state=empty","screenshot":null},
              "htmlHash":null,
              "changeStatus":"unknown",
              "changeEvidence":null,
              "feedback":{"text":"","mark":null,"updatedAt":null},
              "previousFeedback":[]
            }
          ]
        }
      ]
    }
  ],
  "unmatchedPrevious": [],
  "conclusion": {"text":"","confirmedAt":null,"confirmedBy":null}
}
```

字段规则：

- `schemaVersion` 固定 1；`mode` 为 `prototype` 或 `product`；`round`、`saveVersion`、`source.version` 是正整数；`status` 为 `in-progress` 或 `complete`。路径相对项目目录，不含用户本机绝对路径；时间为 ISO 8601 或 null，不能冒填。
- `confirmation.status` 为 `proposed` 或 `confirmed`；反馈的 `plan` 必须指向已确认计划。`previousRound` 为上一轮完成 JSON 的相对路径，首轮 null。`source` 在 product 模式表示开发侧提供的版本标识文件及序号。
- `feedback.mark` 只能是 null、`可以`、`待改`、`阻塞`。`text` 保存反馈原话（包含换行），空文本也是有效值，标记独立保存；每组末尾的流程反馈也必须保存。
- `previousFeedback` 为 `{ "round":1, "text":"反馈原话", "mark":"待改", "updatedAt":"ISO 时间或 null" }` 的数组；组反馈条目的 mark 为 null。按时间保留历史，不覆盖为本轮编辑值。`unmatchedPrevious` 为 `{ "groupId":"旧分组", "screenId":"旧屏或 null", "state":"旧状态或 null", "previousFeedback":[] }` 数组，用于保留被删除或重命名后无法匹配的旧反馈，不能丢弃原话。
- 原型 `preview.kind` 为 `iframe`，`artifact` 和 `hash` 定位原型，`screenshot` 为 null；产品模式 kind 为 `screenshot`，screenshot 为内嵌图片 data URL，artifact 和 hash 可为 null。原型运行时不请求截图。
- `htmlHash` 为 `sha256:<64 位十六进制>` 或 null；`changeStatus` 为 `modified`、`unchanged`、`unknown`、`new`。`changeEvidence` 为 null，或 `{ "method":"html-sha256", "previousHash":"sha256:…", "currentHash":"sha256:…" }`，或 `{ "method":"change-list", "artifact":"开发侧改动清单文件", "entry":"对应条目原文" }`。新屏为 new；没有可比证据为 unknown，不当作已修改或未修改。
- `conclusion` 是用户对本轮结果的明确确认；只有实际确认才写时间和确认人并设 status 为 complete。待改 / 阻塞项须逐条解决、回归或经用户明确排出本期范围，不能由模型自动结项。

## 走查页、自动保存与导出

经计划确认后生成 `walkthrough-v1.html`，后续版本递增。按组从上到下展示每个屏幕状态，标注名称、状态、复现步骤，附反馈输入框与「可以」「待改」「阻塞」。每组末尾附流程反馈框。页面顶部展示分组总览，操作顺序与 PRD 一致。

HTML 必须是可离线打开的单文件，只用系统字体栈。每屏使用 `<section data-screen="<id>" data-state="<状态>" data-group="<分组>">`；支持 `#screen=<id>&state=<状态>` 只显示对应屏，且监听地址变化。内嵌 `design-outline`（`application/json`），结构与总流程一致。固定状态词表为 default、first-use、permission、loading、empty、error、recovery；自定义状态列入大纲。工作室中嵌入预览，不截图。

走查页本身的大纲覆盖计划中的每屏每状态，section 包住相应 iframe 和反馈表单。原型全文内嵌在单个走查 HTML 中，以 data URL 加定位 hash 创建 iframe；iframe 使用 sandbox，不加 allow-same-origin。不能外链 `prototype-v<n>.html` 后声称单文件可离线。反馈控件留在走查页或可信宿主，父页面无需读取不可信 iframe 的 DOM。

- **工作室运行时**：反馈通过 K3 提供的可信宿主保存能力自动写入用户工作区 `walkthrough-r<n>-v<k>.json`，每次成功保存新建一份，完成时写一次 `walkthrough-r<n>.json`。不让原型 iframe 自行传路径、用户身份或取得文件写权限。宿主确认保存成功才显示“已保存”；失败显示原因并允许导出，结果不明先核对，不自动重复写。K1 不定义或虚构已存在的保存 API。
- **单独打开 HTML**：浏览器本地存储自动保存，键包含项目 id、轮次、原型版本，避免不同项目互相覆盖。若存储被禁用或容量不足，提示未保存并保留可导出内容。回到工作室时导入导出的 JSON，再追加到用户工作区；不能把浏览器缓存当工作区存档。
- **两种方式都支持导出 Markdown 和 JSON**：JSON 保留上述完整结构；Markdown 按组、屏、状态输出版本、复现方式、当前标记和原话、上一轮原话及修改证据，可直接交给 AI 修改。导出控件在可信宿主或独立走查页，不能让原型 iframe 发起不受控下载。导入只用解析后的数据及 textContent，不执行导入内容。

## 新一轮回归

导入上一轮 JSON，先校验 schemaVersion、projectId、字段类型和标记枚举，按稳定的组 id、屏 id、状态匹配，原样显示全部历史反馈；重命名或删除项移到 unmatchedPrevious 并显示，不能吞掉。

判断页面是否改动过：对两轮同一 `(screenId,state)` 的原型 HTML 片段用相同序列化方式算 SHA-256（不含走查反馈、保存时间），比较哈希；动态原型需在同一示例数据装载后由构建侧提供片段或摘要，不能比较空 React 根节点。公共 CSS、脚本或主题变化也会影响页面；遇到片段无法覆盖的变化读取开发侧完整改动清单，或标 unknown 待核对。不要用反馈文字变化判断页面改动。

有可靠改动证据的页面显示“已修改”，并注明证据；未变更、全新、未知分别显示，状态变化也明确指出。对上轮待改 / 阻塞项逐条复现，保持原话并让用户作本轮判断。提出修改只能生成新原型和走查版本，不能直接覆写历史；涉及结构变化回到 frontend-design 的确认门禁。
