---
name: agent-brief
description: 用户要填写 Agent 资料卡、梳理定位与核心任务或补充设计前的信息时使用；不用于直接写代码、替代 PRD 或一般聊天。
---

先读 [总流程与产物约定](../agent-design-flow/SKILL.md)。所有路径相对于用户自己的工作区；只新建版本，不覆盖历史文件。使用最新且已获用户确认的输入版本；较新的未确认版本不能替代确认记录。当前阶段经用户明确选择「继续」后才进入下一阶段；「修改」重做当前步，「结束」保存进度并停止。

# 资料卡与深度引导

先发出下方空白资料卡让用户填写，说明可以只填一部分。不要在用户回应前擅自填完。已有信息先保留，避免重复询问。

| 字段 | 用户填写 |
|---|---|
| Agent 名称 | |
| 一句话定位 | |
| 目标用户与使用场景 | |
| 要解决的核心任务（可多个） | |
| 交付物形式 | |
| 资料来源（上传、知识库、联网） | |
| 需要人确认的环节 | |
| 端（Web / App / 两者） | |
| 必须有的页面或功能 | |
| 明确不做的事 | |
| 参考产品或参考图 | |
| 成功标准 | |
| 对模型的要求（看图、联网、成本） | |
| 权限与隐私要求 | |

## 澄清和确认

对空缺或含糊字段追问，每轮最多 5 个问题，每题给 2–4 个有明确差异的选项，标出推荐项及理由，同时允许自由回答。问题围绕会改变范围、页面、权限、验收的选择；已明确内容不重新提问。

与 PRD 共用最多约 3 轮澄清预算，读取并更新 `decisions-v<n>.json` 的 `clarificationRounds`。在有限轮次内把推断、冲突和关键选择一起呈现。推断只有经用户认可才写成已确认字段。用户说“以后再说”的内容记为本期不做或假设，附原话和理由。到轮数上限仍有影响行为或权限的分歧，说明阻塞并让用户选择修改范围或结束，不编造认可，也不继续无限追问。

理解后直接写入完整资料卡，产出 `outputs/design/<项目 id>/brief-v1.md`（后续递增）。正文按上述字段组织，附同内容 JSON；标出每个字段来自用户提供还是引导推断，推断均已获认可。最后展示资料卡请用户确认具体版本，再进入 PRD。

结构化 JSON 形状如下；生成时每个字段都使用 `{ "value": ..., "source": "user" 或 "inferred", "evidence": "用户依据或认可原话" }`，示例值须换成项目实际内容，不把空值当确认。列表字段的 value 为数组，模型与隐私字段可用对象。

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "clarificationRounds": 1,
  "fields": {
    "name": {"value":"任务助手","source":"user","evidence":"名称叫任务助手"},
    "positioning": {"value":"帮助个人整理任务","source":"user","evidence":"帮我整理任务"},
    "audienceAndScenarios": {"value":["个人每日规划"],"source":"inferred","evidence":"用户认可个人每日规划"},
    "coreTasks": {"value":["记录和查看任务"],"source":"user","evidence":"记录并查看任务"},
    "deliverables": {"value":["任务清单"],"source":"user","evidence":"输出清单"},
    "sources": {"value":["手动输入"],"source":"user","evidence":"先手动输入"},
    "confirmationPoints": {"value":["清单保存前"],"source":"user","evidence":"保存前确认"},
    "platforms": {"value":["Web"],"source":"user","evidence":"只做 Web"},
    "requiredPagesAndFeatures": {"value":["任务列表","创建任务"],"source":"inferred","evidence":"用户认可这两页"},
    "outOfScope": {"value":["团队协作"],"source":"user","evidence":"团队协作以后再说，本期聚焦个人"},
    "references": {"value":[],"source":"user","evidence":"没有参考产品"},
    "successCriteria": {"value":["能完成创建并在列表找到新任务"],"source":"user","evidence":"先保证这条流程"},
    "modelRequirements": {"value":{"image":false,"web":false,"cost":"使用现有配置"},"source":"user","evidence":"不用看图联网"},
    "permissionsAndPrivacy": {"value":{"visibility":"仅本人","retention":"用户主动删除前保留"},"source":"inferred","evidence":"用户认可仅本人可见及保留方式"}
  }
}
```
