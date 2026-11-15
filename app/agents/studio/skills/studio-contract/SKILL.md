---
name: studio-contract
description: 工作室各阶段生成或读取 JSON、主题样页、确认记录与代码包时使用；不用于取代用户确认、服务端授权或真实质量检查。
---

# 工作室产物契约

先用 skill_read 读 agent-design-flow。此目录的 schemas/*.schema.json 是工作室 Agent 和 K3b-2 前端共用的 JSON Schema（draft-07）；以本地注册的 $id 和相对 $ref 解析，不从网络下载。additionalProperties=false：不得临时发明字段。write_file 仅检查 JSON 语法，不执行这些 schema；生成方逐字段核对，前端用同一批 schema 验证。schema 通过不代表业务正确、用户已确认或布局通过。

## 目录、草稿与版本

每步先 read_file inputs/drafts/project.json，严格匹配 [project schema](schemas/project.schema.json)：`{"id":"task-helper","name":"事项整理助手"}`。id 仅小写字母开头、数字与连字符，最长 48；它只用于输出目录，不能建立身份和权限。项目目录为 outputs/design/<id>/。只新建版本，数字排序，不覆盖、不按文件修改时间选确认版本。

结构化草稿以本节为唯一来源，均位于 inputs/drafts/，仅保留以下五种：

| 草稿 | 内容 | 前端何时写、怎么触发 |
|---|---|---|
| project.json | `{id,name}` | 建立项目时写入 |
| brief.json | 资料卡，字段遵循 agent-brief | 提交资料卡时写入 |
| clarify.json | `{round,answers:[{id,text}]}`，id 对应当前问题 | 前端写完后发 revise，固定文字“提交第 n 轮澄清答案”（n 为草稿 round），可附用户补充；答案以草稿为准，revise 文字只是触发 |
| theme.json | `{styleId,themeId,round}`，跨轮选择另含 styleRound/themeRound | 用户选好两题并点“确认，生成高保真”时，前端先写草稿，再 continue 进入 hifi；“换一换”走 revise，固定文字“换一换：风格”或“换一换：主题”，theme 步只换对应的一题 |
| structure-changes.json | `{items:[{id,decision,feedback}]}`，decision 为 accept/reject | 前端写完后发 revise，固定文字“按结构改动决定生成”；核对提案 id 并按逐项决定处理 |

除 project 和初始 brief 外按触发场景读取，不把缺文件当成功读取；当前动作所需草稿缺失或无效时停下说明，不能自行补选。先列目录再读取，未知草稿不得擅自解释成授权；身份、权限与确认依据来自服务端和用户明确操作。聊天意见只有 feedback 一条通道，运行中 steer、等待时 revise，作为本轮输入的文字到达；Agent 必须把收到的意见原话记进 decisions。附件文本在 inputs/uploads/，图片用附件。

正式产物与 schema / 可读取完整示例：

| 文件族 | Schema | 示例 |
|---|---|---|
| clarify-r<n>.json | [clarify](schemas/clarify.schema.json) | [clarify](examples/clarify.json) |
| themes-r<n>.json | [themes](schemas/themes.schema.json) | [themes](examples/themes.json) |
| theme-v<n>.json | [theme](schemas/theme.schema.json) | [theme](examples/theme.json) |
| structure-changes-v<n>.json | [structure-changes](schemas/structure-changes.schema.json) | [structure-changes](examples/structure-changes.json) |
| qa/lofi-review-v<n>.json、qa/hifi-review-v<n>.json | [review](schemas/review.schema.json) | [review](examples/review.json) |
| decisions-v<n>.json | [decisions](schemas/decisions.schema.json) | [decisions](examples/decisions.json) |
| package-v<n>/manifest.json | [manifest](schemas/manifest.schema.json) | [manifest](examples/manifest.json) |
| qa/package-check.json，修订 qa/package-check-v<n>.json | [package-check](schemas/package-check.schema.json) | [package-check](examples/package-check.json) |

示例仅虚构数据与假 Codex 固定报告，不可照抄为真实用户确认或工具通过结果。工具自行生成的 qa/* 布局原始报告遵循 check_design 实际返回结构，不能把它覆盖成这里的自审报告。原始 Agent 配置遵循脚手架 AgentDefinition schema，资料卡内嵌 JSON 遵循 agent-brief，不为已有来源发明另一套字段。

## 澄清

schemaVersion=1，projectId 对应项目，round 为 1–3，final 是布尔值，questions 最多 5 题。每题 id 稳定且唯一、text 含具体问题和推荐理由，options 2–4 项，恰好一项 recommended=true，allowFree=true。选项 label 唯一，允许用户自由输入。round=3 必须 final=true；final=true 时 questions=[]。资料完整首轮即可结束：

```json
{"schemaVersion":1,"projectId":"task-helper","round":1,"final":true,"questions":[]}
```

收到“提交第 n 轮澄清答案”的 revise 触发后，读取 clarify.json 核对当前轮次与问题 id，以草稿答案产生下一轮，不能重新编号以规避 3 轮。final 只表示停止出题；范围/权限分歧必须记录，不能因为到上限而虚构认可。brief 与 PRD 共用 decisions.clarificationRounds，不另起计数。revise 附带“信息已足够，停止补充提问”（或同义的提前结束文字）时，下一份 clarify 直接写 final=true，questions 为空；未决事项记入 decisions。

## 风格、主题与换肤

styles 和 themes 各恰好 3 项，均包含 id、name、traits（中文特征数组）、tokens。同一轮候选 id 唯一，历史 id 永不复用。shown 是累计已展示 id，shownHistory 是包含 kind=style/theme 的完整历史候选；两者 id 集合一致、历史内容不改写。换一换仅替换一题，另一题仍引用原 id；既比 id，也比规范化 tokens 和视觉方向，不能换名字复用旧方案。

wireframe 指向确认线框，screens 列 2–3 个核心屏的 sourceScreenId/state（产品不足两屏就全取并说明）。samples 恰好 3 项，逐个记录样页 artifact、styleId、themeId、designReport。路径相对项目目录。三套主题各用当前风格组成一次检查；无风格选择时可用对应风格。check_design 不支持 hash 参数，所以每套组合写不同版本的 theme-sample-v<n>.html，把默认组合实际写入 :root 后检查。样页都保留换肤能力；检查不同组合不能复用同一个未经切换的报告。

固定 CSS 变量词表，字段、单位与枚举详见 [style-tokens](schemas/style-tokens.schema.json)、[theme-tokens](schemas/theme-tokens.schema.json)。必须填全，不添加任意 CSS 属性：

- 风格：--layout-density（0.85/1/1.15）、--radius-sm、--radius-md、--space-xs/sm/md/lg/xl、--control-height、--control-border-width、--shadow-raised。尺寸为 schema 限定的 px 字符串，阴影仅允许固定枚举。
- 主题颜色：--bg、--surface、--surface-2、--border、--text、--muted、--accent、--accent-hover、--accent-soft、--on-accent、--success、--warning、--warning-soft、--danger、--focus、--disabled，均六位十六进制颜色。
- 主题文字：--font-body、--font-heading、--font-mono（只允许系统栈）、--font-size-caption/body/h1/h2/h3、--font-weight-body/heading、--line-height-body/heading。最小字号 12px，字号 px，行高倍数字符串。颜色通过 schema 不等于对比度合格，实际组合仍须自审。

样页读 `#screen=<id>&state=<state>&theme=<base64url(JSON{style,theme})>`。style 与 theme 是上述完整令牌对象，不是候选 id；宿主从候选解析后编码。UTF-8 字节经 base64url 编码，无 padding；初载与 hashchange 都解码、校验顶层仅 style/theme、两组全量键、类型、枚举和颜色。先完成整组验证，再逐项 document.documentElement.style.setProperty，未知键、url()、脚本、外部资源、缺字段一律拒绝。错误显示中文提示并明确当前展示默认组合，不默默把失败当作选择成功；每次从完整默认值重置，避免上轮令牌残留。用户文字用 textContent，不拼 HTML 或整段 CSS。

theme 步只产出 themes-r<n>.json、样页和检查结果，然后停在确认点。hifi 开头读取 inputs/drafts/theme.json，核对两个 id 与来源轮次都存在于最新 themes-r<n>.json 或其 shownHistory 的对应轮次；缺失或无效就停下说明，不能自行选择。确认依据来自用户点击“确认，生成高保真”后服务端的 continue。所选组合已有通过的样页检查报告就直接引用；没有就先新建默认令牌为该组合的 theme-sample-v<n>.html 并 check_design，读取 reportPath 完整报告，仅 status=completed 且 errors=0 才继续。有确定问题按既有规则最多修 2 轮，每轮新样页重新检查；仍失败或工具不可用就停在确认点，如实报告未通过或未验证，不写主题文件、不做原型，工具不可用不自动重试。检查通过后只写一份 theme-v<n>.json，记录两个来源轮次与 id、wireframe、sample、完整 style/theme、实际完整 designReport 和 confirmationEvidence；designReport 永不为 null，时间/确认人未知保留 null，不冒填。然后再做原型，不能借三套候选检查推断所有九种组合已通过。

## 结构改动与质量记录

结构提案 version 对应文件名；prototype 指向修改依据。items 中 id 唯一、change 具体描述、reason 含 PRD 条目及必要映射、affects 是已有屏 id 数组；没有改动写空数组。提案不等于同意；逐项决定写 decisions 的反馈与依赖，确认前不应用，范围变动先更新 PRD/线框。

review 的 stage 为 lofi/hifi，version 与对应被审产物版本一致；artifact、prd、inputs 使用项目相对路径。designReports 保存实际 artifact/reportPath/status/errors/warnings。items 必须覆盖 PRD 每个屏和状态，每项为：

```json
{"screen":"web-review","state":"loading","check":"加载与恢复","conclusion":"pass","evidence":"prototype-v1.html#screen=web-review&state=loading 可定位；核对结果与恢复按钮分别指向已存在的结果状态。"}
```

conclusion/result 为 pass、fail、unverified；证据写定位、元素、操作链和真实检查依据，不写空泛“已检查”。pass 要求所有 items 为 pass，至少一个完整 designReport 且 errors=0，remaining=[]。失败写剩余项，未运行写 unverified。不能拿 fixture 报告代替真实结果。自动修最多 2 轮，逐轮新产物、真实布局报告与自审报告。报告记录 warning，即使工具 0 错误也检查 12px 字号和产品完整性。

## 确认与包清单

decisions 与 agent-design-flow 的示例一致：schemaVersion、projectId、clarificationRounds、currentStage、events。event 包含 stage、operation（continue/modify/end）、artifact、inputs、confirmedAt、confirmedBy、feedback；modify/end 的 confirmedAt/confirmedBy=null，另有 recordedAt。原话与历史事件追加保存，不改写；没有可信身份或时间时为 null，用户明确操作的原话仍保留。时间是 UTC ISO 字符串，禁止套用示例时间。多个事件可引用同一产物，但不能把草稿、推荐项、静态校验结果当确认。

manifest 与 design-handoff 一致。files 唯一路径、无绝对路径、点路径、符号链接或包外引用，完整列出除 manifest 自己之外的普通文件；sha256 必须是最终字节 64 位小写十六进制，从 write_file 的 artifact.revision 或 read_file 的 revision 获取。artifacts 的 path/inputs 在 files 中可解析，source 对应设计原文件；版本和确认来自真实记录，候选资源可无单独确认。projectId/productId 一致，agentId 单独校验。最低目标版本和能力依源码核对，K4 未实现时明确标缺，不写“可落地”。landing 只允许固定来源和动作，无任意命令或钩子。

生成目标 Agent 时可用 skill_read 读取 [可通过当前检查的 Agent 结构示例](resources/agent-example.json)，逐项改成用户产品的角色、Skill、工具、数据绑定和工作流；示例的空绑定不是所有产品的默认权限。不能在工作室读取不存在的宿主机源码路径或凭空声明未支持字段。

当前 check_agent_package 调用 agent:check 时以代码包为根，必须在包根提供 config/models.json。通过 skill_read 读取 [受信模型目录快照](resources/models.json)，原样写入包内并计入 manifest；快照只供静态能力验证，不含密钥，落地不得用它覆盖真实部署配置。目标模型能力需由本地编码助手再次核对。

前端只在 agent/ui/，必须在 agent/agent.json 声明 ui.entry=ui/index.html 和 title，JS/CSS 分离。调用 check_agent_package 后保存实际包路径、ok、errors、issues、status、reason；completed 时 errors 必须等于 issues 数且 ok 等价于 errors=0，工具未运行则 status=unverified、ok=false、reason 说明，不以 errors=0 谎报通过。报告默认放项目 qa/package-check.json；已有则编号新文件。包内如收录 QA，存已检查候选的实际结果并生成新包清单，最终另查新包，防止报告与 manifest 循环哈希。不得把上一包报告当成新包通过证据。

## 在工作室运行时

产物自带的页面目录或说明只在单独打开时显示；被嵌入时（`window.top !== window.self`）隐藏，导航由工作室左侧目录提供。

用 skill_read 读取本目录 schema 和 examples；采用前端 inputs/drafts/ 草稿，按以上规则核对。用 check_design 代替本机脚本。prototype-builder 复杂方式等 K3c 离线模板，此前只用简单方式并说明限制；开发侧的脚本与模板归档不随运行时副本携带，运行时不执行脚本；工作室没有 shell 或宿主机执行权限。所有路径受服务端授权约束，schema 不能扩张权限。结束只回一两句摘要与产物位置。
