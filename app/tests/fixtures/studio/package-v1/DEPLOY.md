# 本机落地与部署

这是虚构产品的测试代码包，静态检查通过不代表功能完成。使用包含 Agent 静态前端和 deploy/land.sh 的脚手架。

1. 核对 manifest 与确认记录。在 app/ 执行 bash deploy/land.sh --package <包相对 app 的目录>；检查通过后重建并切换产品。
2. 前端按 design/prototype-v2.html，后端按 design/prd-v1.md 完成需要开发项。
3. npm run agent:check -- agents/task-helper/agent.json；按目标仓库已有测试与构建命令验证，不虚构构建命令。
4. 按仓库启动文档本机运行，示例账号验证登录、输入、确认、保存和归属。
5. flow-walkthrough 先给计划等确认，再截图、诊断、生成走查页，等待反馈；在 app/ 运行 bash deploy/walkthrough.sh <确认的计划.json>。
6. 按前端、后端、整体分类修复，下一轮保留原话与已修改证据，等待用户回归。
7. 巡查通过后 npm run production:check，通过后按授权部署。
8. 远程部署在本机 app/ 使用 npm run deploy -- --host root@<服务器地址>；或将已验证代码推到自己的 Git 仓库，在服务器检出并按现有文档运行 bash deploy/install.sh。设计记录保存在 app/design/task-helper/，不提交密钥。
