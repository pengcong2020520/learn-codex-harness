---
name: build-from-design
description: 从已交付的 Agent 代码包完成本机落地，按确认的 PRD 与高保真实现业务功能，启动产品并交给真实产品巡查。适用于设计工作室交付后的开发和接续开发。
---

# 按确认设计开发产品

读取仓库 AGENTS.md、包内 manifest.json、PROMPT.md、DEPLOY.md。按清单的 artifacts 找到经确认且相互匹配的 PRD、原型、主题和结构变更。核对产品 id、包版本、目标工作区与开发缺口；已有落地记录从当前代码和验证记录接续。

1. 在目标脚手架的 app/ 执行 `bash deploy/land.sh --package <相对 app 的代码包目录>`。唯一项目的最新包可省略参数。安装器核对清单和内容，保留部署模型和账号配置。若中断，先核对 .land/receipt.json、agents/、design/ 和本项目容器状态；核对清楚后再手动继续。
2. 逐条对照 PRD 验收场景与确认原型，列出已有能力和需要实现的前端、后端与跨页流程。将前端写在 agents/<id>/ui/，复用同源 SDK、服务端身份、数据归属和任务门禁。保存、恢复、失败和空态均用真实接口验证。结构改变须按设计约定记录。
3. 在 app/ 运行 `npm run agent:check -- agents/<id>/agent.json` 以及与改动对应的测试。按仓库启动说明重建本机产品，使用示例账号实际登录，从产品首页走完核心流程，并核对数据和回执。记录构建版本、运行入口、实际结果和未验证状态。
4. 核心流程可运行后使用 [flow-walkthrough](../flow-walkthrough/SKILL.md)。把巡查计划与截图存入 design/<产品 id>/walkthrough/，按授权复现，交付本地走查页。收到反馈后保留原话并逐条归入前端、后端或整体流程，记录修改文件和复验结果。新一轮从导出的 JSON 关联反馈并重新采集真实截图。
5. 用户确认产品巡查通过后运行 `npm run production:check`，依据目标环境的部署授权执行 DEPLOY.md。保留设计记录与验收结论。
