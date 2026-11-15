---
name: flow-walkthrough
description: 用户要在开发完成后、部署之前巡查本机真实产品、收集页面反馈或回归上一轮修复时使用；不用于原型评审、跳过计划直接截图或擅自部署。
---

# 本机真实产品巡查

先读 [总流程与产物约定](../agent-design-flow/SKILL.md)。本 Skill 仅由用户本机的编码助手执行，输入为已确认 PRD、设计大纲、已实现功能与实际运行版本，不属于工作室运行时。记录放 app/design/<项目 id>/walkthrough/，默认不提交 Git；版本只新增，不覆盖。

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

## 执行条件与计划确认

确认核心流程已开发完成、本机服务可启动、示例账号可登录。先读取 PRD、设计大纲及已有测试结果，按真实顺序列流程分组、页面、状态、复现步骤、输入数据和预期结果，覆盖 PRD 涉及的权限、空态、加载、接口失败、模型超时、重新连接与恢复。

计划写 walkthrough-plan-v<n>.json：schemaVersion=1、projectId、mode="product"、round、source（实际版本标识及序号）、prd、previousRound、confirmation（status、confirmedAt、confirmedBy）、groups。每组有 id/title/order/screens；每屏有 id/title/position/states/actions/reproduce，reproduce 按状态记录有序操作步骤。向用户完整展示，等明确确认后才能操作产品、截图或生成走查页。计划变动新建版本重新确认，确认时新建含真实确认人和时间的快照，不覆写提案；确认计划不授权真实外部消息、付费等行为。

用脚手架的 deploy/walkthrough.sh 运行 Chromium 采集和固定走查页模板。实际运行产品，页面加载到可操作状态后检查 DOM，选择真实控件按步骤复现，截图并采集控制台错误、失败请求（方法、脱敏路径、状态码）、明显慢请求和布局问题。不得记录密钥、口令、Cookie、认证头或个人数据。只用示例账号和数据；额外外部写入需另获授权。

无法复现的页面或状态标“无法复现”并说明原因，不能拿设计图或编造画面代替真实截图。产品启动或登录失败时先报告、修复到能运行，不把局部结果称为完整巡查。执行结束关闭本轮创建的浏览器资源，不关用户已有页面。

## 走查页、反馈与保存

生成可离线打开的 r<n>/index.html，截图和必要资源内嵌，只用系统字体。左侧按流程分组列目录；主体每组按操作顺序排列屏幕卡片，左边真实截图（可放大），右边名称、状态、复现方式、诊断、反馈框与“可以 / 待改 / 阻塞”。每组末尾另有流程反馈。没有聊天区，不用标签条；一屏布局，卡片区域局部滚动。截图上不叠加任何标签或按钮，说明与“放大”放在截图下方。底部显示本轮计数与保存状态，提供导出 Markdown、导出 JSON，以及“汇总与验收”入口；在汇总中由用户填写验收人，逐屏通过或明确填写排出本期的理由，再点击“确认本轮巡查通过”记录确认时间；不放“按反馈修复”，修复由编码助手按导出的反馈完成。

每次输入和标记变化自动保存到 localStorage，键包含 projectId、轮次和实际产品版本。成功后才显示“已保存”；禁用或容量不足时提示未保存并保留导出能力。缓存不等于文件存档；导出 JSON 保存为 walkthrough-r<n>-v<k>.json，初始采集记录保存在 r<n>/walkthrough-r<n>.json，确认通过后导出含 complete 的新版本，均只新增。导入数据仅解析字段并以 textContent 展示，不执行用户内容。

JSON 必须包含 schemaVersion=1、projectId、mode="product"、round、saveVersion、status（in-progress/complete）、已确认 plan、source、previousRound、createdAt、savedAt、reviewer、groups、unmatchedPrevious、conclusion。时间为真实 ISO 8601 或 null，路径相对本机设计目录，不放本机绝对路径。

每组保存 id/title/order、feedback（text/updatedAt）、previousFeedback、screens。每屏保存稳定 id/title/position/actions，每个状态保存 state、reproduce、screenshot（实际截图 data URL，无法复现时 null）、diagnostics、unavailableReason、changeStatus、changeEvidence、feedback（text/mark/updatedAt）、previousFeedback。mark 只能是 null、可以、待改、阻塞；空文字有效，标记独立保存。历史反馈项保留 round/text/mark/updatedAt，组级 mark 为 null。反馈原话包含原换行，不改写成 AI 摘要。

Markdown 与 JSON 都导出版本、分组、页面、状态、复现、诊断、当前标记和原话、历轮原话、变更证据及结论，方便交给编码助手。导出前校验结构、项目和状态，文件名不含路径穿越。用户未明确确认不得把 status 改为 complete，conclusion 的确认人和时间不能代填。

## 分类修复与下一轮回归

用户提供反馈后逐条分类：前端（视觉、交互和页面状态）、后端（接口、权限、数据与任务执行）、整体（跨页面和跨服务流程）。结合诊断定位原因，记录反馈原话、分类、改动文件与验证，不能凭截图直接认定后端原因；结构或范围变动先请用户决定。修复真实产品后再进入下一轮，不能擅自把待改或阻塞改成可以。

新一轮先列计划、等确认，按稳定 groupId、screenId、state 关联历史，完整保留上一轮和更早的原话。删除或重命名而无法关联的项留在 unmatchedPrevious（groupId/screenId/state/previousFeedback），显示给用户，不能吞掉反馈。

changeStatus 使用 modified、unchanged、unknown、new；changeEvidence 记录实际代码改动清单条目及版本，或同条件渲染后可比的 DOM/CSS 摘要。只有可靠证据才显示“已修改”；没有证据标“待核对”，不能根据反馈文字变化判断改动。公共样式、脚本、接口变化也要纳入证据；只有截图像素差异不足以证明已修复。

逐项复现上一轮待改 / 阻塞项，由用户作本轮判断；所有未解决项修复并回归或由用户明确排出本期范围后，才确认巡查通过。然后运行 npm run production:check，通过后按部署手册和用户授权部署。巡查通过、生产检查通过和部署成功分别记录，不能互相替代。

## 在本机采集

把经确认的计划保存为 `app/design/<产品 id>/walkthrough/plan-v1.json`。每个状态在已有 reproduce 原话之外还要填写 capture：steps 以同源 open 开始，随后可 click、wait 或 fill，ready 是只有抵达目标状态才会出现的可见元素。无法安全复现时在该状态填 unavailableReason。选择器来自实际运行的 DOM。测试口令用 fromEnv 引用本次进程的 WALKTHROUGH_INPUT_ 变量。巡查容器仅连接本机产品的 Caddy。

```bash
cd app
bash deploy/walkthrough.sh design/<产品 id>/walkthrough/plan-v1.json
bash deploy/walkthrough.sh design/<产品 id>/walkthrough/plan-v2.json <上轮导出的反馈.json>
```

打开同目录 r1/index.html，可放大原始 PNG、反馈、刷新恢复和导出。退出码 0 表示全部状态采集成功，2 表示已生成走查页但有未复现状态，1 表示计划或运行失败。每轮目录只新建一次。下一轮填写整数 previousRound、递增 round，保留稳定页面与状态 id。

## 计划和反馈 JSON 示例

以下仅展示字段结构，示例确认信息不能代替用户实际确认。初版为 walkthrough-plan-v1.json、r1/index.html、walkthrough-r1.json，后续按数字版本递增。

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "mode": "product",
  "round": 1,
  "source": {
    "artifact": "product-build-v1.json",
    "version": 1
  },
  "prd": "prd-v1.md",
  "previousRound": null,
  "confirmation": {
    "status": "confirmed",
    "confirmedAt": "2026-11-14T12:00:00Z",
    "confirmedBy": "示例用户"
  },
  "groups": [
    {
      "id": "main-flow",
      "title": "整理事项",
      "order": 1,
      "screens": [
        {
          "id": "web-list",
          "title": "事项列表",
          "position": 1,
          "states": [
            "default"
          ],
          "actions": [],
          "capture": {
            "default": {
              "steps": [{"open": "/app/"}, {"wait": "#items"}],
              "ready": "#items"
            }
          },
          "reproduce": {
            "default": [
              "登录示例账号",
              "打开事项列表"
            ]
          }
        }
      ]
    }
  ]
}
```

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "mode": "product",
  "round": 1,
  "saveVersion": 1,
  "status": "in-progress",
  "plan": "walkthrough-plan-v1.json",
  "source": {
    "artifact": "product-build-v1.json",
    "version": 1
  },
  "previousRound": null,
  "createdAt": "2026-11-14T12:00:00Z",
  "savedAt": "2026-11-14T12:00:00Z",
  "reviewer": "示例用户",
  "groups": [
    {
      "id": "main-flow",
      "title": "整理事项",
      "order": 1,
      "feedback": {
        "text": "",
        "updatedAt": null
      },
      "previousFeedback": [],
      "screens": [
        {
          "id": "web-list",
          "title": "事项列表",
          "position": 1,
          "actions": [],
          "states": [
            {
              "state": "default",
              "reproduce": [
                "登录示例账号",
                "打开事项列表"
              ],
              "screenshot": null,
              "diagnostics": [],
              "unavailableReason": "此处仅演示结构，执行后须填实际截图或不能复现的原因。",
              "changeStatus": "unknown",
              "changeEvidence": null,
              "feedback": {
                "text": "",
                "mark": null,
                "updatedAt": null
              },
              "previousFeedback": []
            }
          ]
        }
      ]
    }
  ],
  "unmatchedPrevious": [],
  "conclusion": {
    "text": "",
    "confirmedAt": null,
    "confirmedBy": null
  }
}
```
