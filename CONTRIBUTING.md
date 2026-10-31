# 参与开发

## 目录分工

- `app/`：持续开发的完整项目。新功能和缺陷修复都先落在这里。
- `stages/`：教学快照，默认冻结。只有影响教学正确性的问题才回补到对应阶段；回补后必须在 `app` 下运行 `npm run course:build`，让课程里的源码摘录与哈希同步。
- 阶段章节 README 的 `javascript` / `sql` 代码块必须逐行摘自本阶段源码（可省略行，用 `// …` 标注），`stages/verify.mjs` 会检查。
- `docs/reports/`：带日期的分析报告，生成后不再修改；结论过期时写新报告。
- 验证记录（`stages/verification.json`、`app/docs/verification/`、`app/web/verification*.json`）由脚本生成，不手工编辑。

## 分支

`main` 始终保持可运行、CI 通过。所有改动从 `main` 拉分支，通过 PR 合并：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat/` | 新能力 | `feat/sse-delta-events` |
| `fix/` | 缺陷修复 | `fix/steer-gate` |
| `docs/` | 文档与课程内容 | `docs/s03-tools` |
| `refactor/` | 不改变行为的结构调整 | `refactor/http-module` |
| `chore/` | 构建、CI、依赖 | `chore/ci-cache` |

一个分支只做一件事，保持小而可审查。

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，描述用中文：

```text
<类型>(<范围>): <做了什么>

<为什么这样做；影响与验证方式>
```

- 类型：`feat` `fix` `docs` `refactor` `test` `chore` `perf`
- 范围：`app` `web` `course` `stages` `s00`–`s05` `ci` 等，可省略
- 示例：`fix(app): steer 失败时不再撤销活动轮次的权限门禁`

## 提交前检查

```bash
npm test   # 仓库根目录：全部离线测试、工作台测试、课程一致性、阶段文档与隐私检查
```

改动涉及 PostgreSQL / Redis、真实 Codex 或 RAG 时，另外运行对应的集成验证（见 `stages/README.md` 与 `app/README.md`），并在 PR 中写明运行了什么、结果如何。

## 密钥与本地数据

- 不提交 `.env`、`.data/`、`.runs/`、各项目根目录下的 `workspace/`；`.gitignore` 已覆盖。
- 新增配置项时同步更新对应目录的 `.env.example`，只写占位值。
- 测试里需要密钥形态的数据时，使用明显的假值（如 `sk-test-...`、`example.invalid`）。

## 隐私

仓库公开发布，提交内容和提交信息都不能带个人信息：

- 提交邮箱用 GitHub 的 noreply 地址：`git config user.email <ID>+<用户名>@users.noreply.github.com`（在 GitHub 的 Settings → Emails 查看），并建议打开 “Block command line pushes that expose my email”。
- 文档、命令示例和生成的验证记录里不写本机绝对路径（`/Users/…`、`/home/…`、`/var/folders/…`），用相对路径、`<仓库根目录>` 或 `$TMPDIR`。研究协议的结果文件写出前会自动替换（`app/tests/research-protocol/redact.mjs`）。
- 不写真实服务器地址、个人邮箱和账号；部署示例用 `root@<服务器地址>`。
- `npm run privacy`（也包含在 `npm test` 和 CI 中）扫描所有已跟踪文件。确属示例的行，在行内加 `privacy-check: allow`。

## 标签与版本

- `baseline-YYYY-MM-DD`：重大调整前的基线快照。
- `vX.Y.Z`：对外发布的版本，遵循语义化版本。
