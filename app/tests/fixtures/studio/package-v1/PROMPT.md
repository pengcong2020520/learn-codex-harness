# 给本地编码助手的指令

先读 AGENTS.md，再读 outputs/design/task-helper/package-v1/ 的 manifest.json、DEPLOY.md 以及 design/ 中已确认的资料卡、PRD、线框、主题和 prototype-v2.html。核对 SHA-256、输入依赖、版本与确认。本包为测试夹具，开发与部署尚未执行。

1. 落地命令：在 app/ 执行 bash deploy/land.sh --package <包相对 app 的目录>。失败或结果不明先核对，不自动重试，不执行包内宿主机脚本。
2. 按设计开发：前端按 prototype-v2.html 全部四屏十状态；后端按 prd-v1.md 的 FR、实体、归属和验收实现。结构改变先提案确认。
3. 检查与构建：运行 npm run agent:check -- agents/task-helper/agent.json，及目标仓库已有测试、构建命令，记录退出码和未运行项。
4. 本机运行：使用仓库现有启动方式和示例账号实际验证完整流程，不发送外部消息，不做付费操作。
5. 读取 .agents/skills/flow-walkthrough/SKILL.md（Claude Code 对应 .claude/skills/flow-walkthrough/SKILL.md），先列分组、页面、状态与复现计划，等用户确认，再实际截图与诊断并生成本机走查页；提供反馈框、可以/待改/阻塞、分组反馈、自动保存、导出 MD/JSON，然后等用户反馈。K5 脚本与模板未提供时用本机可用浏览器手段并如实说明。
6. 按反馈归类为前端、后端或整体，结合诊断修复，逐条说明，不自行关闭待改项。
7. 下一轮回归先确认计划，保留反馈原话与有证据的已修改标记，由用户判断；无法匹配项也保留。
8. 巡查通过后 production:check：npm run production:check，失败先修复。
9. 按 DEPLOY.md 及用户授权部署，保留 app/design/task-helper/，不把包生成当成已部署。

## 需要开发

- web-list：真实清单查询与空态、首次使用、权限拒绝；输入为当前认证会话，输出仅属主清单，验证无法读取他人数据。
- web-create：整理工作流调用、空白错误与内容保留；输入事项正文，输出待确认清单，不能自动保存。
- web-review：真实确认保存、加载与失败恢复；接口设计沿用服务端身份和门禁，结果不明先核对，不能自动重发。
- web-result：真实保存回执与结果核对、返回列表；与输入及确认内容一致，禁止静态成功提示。

当前前端只有登录核对及编辑导航起点；完整状态、SSE、后端持久化、测试、构建、本机运行、巡查与部署均待实施，不宣称完整产品可用。
