# 事项整理助手 PRD

章节参考 github/spec-kit 的 spec-template（MIT），仅为自动测试与前端测试的虚构产品夹具。

## 1 产品概述
把个人输入的零散事项整理成清单，由本人确认后保存。只面向 Web，不发送外部消息、不执行事项。

## 2 用户与场景
已登录用户在每日开始时整理工作，只能查看自己的事项。没有查看权限时说明原因并提供返回入口。

## 3 用户故事与验收
P1：记录今日事项。Given 已登录且有权限，When 输入“整理周报”和“确认会议议程”并整理，Then 在确认页看到相同内容；修改后，确认页和保存结果随之更新。
P1：确认并保存。Given 清单已整理，When 本人点击确认保存，Then 显示加载状态，完成后展示结果并能返回列表找到记录。
P1：错误恢复。Given 输入为空，When 整理，Then 说明需要填写事项，保留可编辑输入。Given 保存结果不明，When 查看恢复页，Then 提示先核对结果，不自动重发。

## 4 页面清单与核心流程

- 1. web-list｜事项列表｜Web｜daily｜状态：default, empty, first-use, permission。操作：输入事项 → #screen=web-create&state=default；查看空列表 → #screen=web-list&state=empty；首次使用 → #screen=web-list&state=first-use；权限说明 → #screen=web-list&state=permission。

- 2. web-create｜输入事项｜Web｜daily｜状态：default, error。操作：整理并检查 → #screen=web-review&state=default；查看输入错误 → #screen=web-create&state=error；返回列表 → #screen=web-list&state=default。

- 3. web-review｜确认清单｜Web｜daily｜状态：default, loading。操作：修改事项 → #screen=web-create&state=default；确认保存 → #screen=web-review&state=loading；查看保存结果 → #screen=web-result&state=default；查看恢复状态 → #screen=web-result&state=recovery。

- 4. web-result｜保存结果｜Web｜daily｜状态：default, recovery。操作：返回列表 → #screen=web-list&state=default；核对保存结果 → #screen=web-result&state=default。

列表主区展示事项，顶部新建；输入页主区是带标签的多行输入，底部整理与返回；确认页主区为待保存内容，底部修改与确认保存；结果页主区为保存回执，底部返回列表。四屏、十个状态，稳定标识不得随视觉修改变更。

## 5 边界情况
首次使用给示例与输入入口；空列表解释无数据；权限不足不暴露他人事项；输入错误保留内容；加载可直接定位供检查；恢复状态先核对保存结果，不自动提交。

## 6 功能需求
FR-001 输入与编辑事项，空白输入明确报错。FR-002 整理结果在确认前可修改，不自动持久化。FR-003 本人确认后保存，加载态有结果与恢复入口。FR-004 列表、确认和结果使用同一份事项。FR-005 归属由服务端认定，不接受请求体自称用户。FR-006 所有错误说明下一步。

## 7 关键实体
事项清单：id、正文、归属、保存状态、创建时间，来源为用户输入，只有属主可见，沿用既有账号数据生命周期。原型数据仅内存演示，真实持久化需要开发。

## 8 非功能需求
1440×900 和 1280×720 一屏布局、长内容区域内滚动、文字至少 12px、键盘焦点可见。数据通过已认证接口取得，不在静态资源放私有内容。不新增模型成本门槛。

## 9 成功标准
SC-001 4 屏 10 状态全部可直接定位。SC-002 从输入到确认、结果、列表的正文一致。SC-003 未确认不能保存，权限拒绝不泄漏数据。按上述 Given/When/Then 验收。

## 10 已确认假设
测试用户仅管理本人事项，使用既有模型；用户明确认可此范围。原型不接真实接口，代码包会列出待开发持久化能力。

## 11 本期不做
团队共享、外部消息、提醒调度、自动执行事项；由用户自行处理清单。
