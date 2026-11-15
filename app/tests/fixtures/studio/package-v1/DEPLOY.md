# 本机落地与部署

这是虚构产品的测试代码包，静态检查通过不代表功能完成。目标为包含 K2、K3a 与 K3b-0 能力的脚手架 2a561f0；K4 尚未提供，当前不能宣称可自动落地。

1. 核对 manifest 与确认记录。在 app/ 查看 K4 实际帮助后使用 docker compose run --rm land 或 npm run design:land 选择包；当前命令未提供，停止此步骤，不编造参数或脚本。
2. 前端按 design/prototype-v2.html，后端按 design/prd-v1.md 完成需要开发项。
3. npm run agent:check -- agents/task-helper/agent.json；按目标仓库已有测试与构建命令验证，不虚构构建命令。
4. 按仓库启动文档本机运行，示例账号验证登录、输入、确认、保存和归属。
5. flow-walkthrough 先给计划等确认，再截图、诊断、生成走查页，等待反馈；K5 工具尚未提供时用本机可用浏览器并说明。
6. 按前端、后端、整体分类修复，下一轮保留原话与已修改证据，等待用户回归。
7. 巡查通过后 npm run production:check，通过后按授权部署。
8. 远程部署在本机 app/ 使用 npm run deploy -- --host root@<服务器地址>；或将已验证代码推到自己的 Git 仓库，在服务器检出并按现有文档运行 bash deploy/install.sh。设计记录保存在 app/design/task-helper/，不提交密钥。
