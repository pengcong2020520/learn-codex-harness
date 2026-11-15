# 工作室测试夹具

事项整理助手：4 屏、10 状态，覆盖输入→确认→保存结果→列表，含首次、权限、空态、错误、加载、恢复。仅虚构测试数据。所有 qa/*fixture-layout.json 和 review 均为假 Codex 的固定响应，不代表实际浏览器已通过；实际检查由 layout-check.browser.mjs 执行并单独报告。package-v1 的保存功能明确待开发，静态包检查不等于产品完成。

项目与资料卡草稿：project.json、brief.json；clarify.json 为第 2 轮回答；theme.json 为双选草稿；feedback.md 为聊天 feedback 原话样本，不是草稿；structure-changes.json 为逐项结构决定草稿。clarify-r1/r2/r3 演示两次 revise 后 final，clarify-final-r1 演示资料完整直接结束。themes-r1、3 个 theme-sample、theme-v1 演示进入 hifi 后保存的选择与确认；prototype-v2 只改确认页文案，id/大纲稳定。

前端测试可直接加载这些文件与 studio-contract/schemas，同一 schema 不需要另造字段。JSON 正反例与跨文件引用、哈希由 studio.test.mjs 校验；实际工作流与工具写入由 studio-workflow.test.mjs 覆盖。
