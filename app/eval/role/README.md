# 角色提示词评估

改动角色提示词（`agents/writing/role.md`）或 Skill 时，用这套固定场景比较新旧两版：质量不能下降，token 要下降。

## 场景

| 场景 | 目录 | 考察点 |
|---|---|---|
| 本地写文档 | `scenarios/s1-local-doc` | 读本地需求与评审纪要写设计文档；两份资料有出入时以评审结论为准 |
| 写公众号文章 | `scenarios/s2-wechat` | 用用户口述的观点与经历成文；不虚构经历、不贩卖焦虑、结尾互动 |
| 信息调研并整理成文档 | `scenarios/s3-research` | 对比三家候选；指出资料冲突；联网搜索失败时如实说明、不编造来源 |
| 写汇报材料 | `scenarios/s4-report` | 结论先行、数据准确；如实写出未达成的目标和原因；支持事项可决策 |

每个场景的 `scenario.json` 写明用户原话、硬性检查和盲评重点；`inputs/` 是放进工作区的资料（虚构示例，链接都用 `.example` 保留域名，资料以外的链接一律视为编造）。

## 运行

需要与正式服务相同的数据层（PostgreSQL / Redis）和模型配置。每次运行都新建临时项目目录和数据身份，不影响正在运行的服务；**会真实调用模型、产生费用**。

```bash
# 两个版本交替运行，每个场景各 5 次；--capture 额外记录每次请求的组成
npm run eval:role -- --variant current=agents/writing --variant slim=<候选 Agent 包目录> --repeat 5 --capture

# 硬性检查 + token 统计 + 盲评（默认用 deepseek-v4-pro，交换先后各评一次），生成 report.md
npm run eval:role:score -- --dir .runs/eval-role/<时间> --baseline current --candidate slim
# 换评审模型（须与 .env 里的 CODEX_BASE_URL 同一服务商）；只看硬性检查与 token 加 --no-judge
npm run eval:role:score -- --dir .runs/eval-role/<时间> --judge-model <模型名>
```

- **交付物**取 outputs/ 下最后写入的 .md / .txt（模型常先写长稿、再另存精简的 `_v2` 作为定稿）。
- **盲评**用流式请求（评审模型推理几分钟，非流式会被当作超时断开），断线、限流和服务端错误自动重试；每次评审结果存到 `<运行目录>/judge/<评审模型>/` 下，重新打分直接复用，不重复花费。
- 报告只记运行目录名，不写本机路径，可以直接放进 `docs/reports/`。

## 判定

- **质量是红线**：每个场景的硬性检查通过率不低于基线，盲评中候选的负场不多于胜场。
- **token 必须下降**：四个场景的平均总 token 合计低于基线。
- 推理 token 每次波动很大（同一场景两次可差 50% 以上），所以每个场景至少跑 5 次再比较平均值，并同时看输入 token（直接受提示词长短影响）。

## 历次评估

- 2026-11-02 角色精简（三轮，DeepSeek）：token 降 15%–21%，质量问题未完全排除，保持当前角色。见 [报告](../../../docs/reports/role-slimming-2026-11-02/REPORT.md)。
