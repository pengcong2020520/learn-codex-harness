---
name: prototype-builder
description: 用户要把 Agent 线框或高保真设计实现成可交互的单文件 HTML 原型时使用；不用于改变设计需求、开发后端或部署真实产品。
---

先读 [总流程与产物约定](../agent-design-flow/SKILL.md)。所有路径相对于用户自己的工作区；只新建版本，不覆盖历史文件。使用最新且已获用户确认的输入版本；较新的未确认版本不能替代确认记录。当前阶段经用户明确选择「继续」后才进入下一阶段；「修改」重做当前步，「结束」保存进度并停止。

# 单文件交互原型

改编自官方 web-artifacts-builder；来源与修改见 [NOTICE.md](NOTICE.md)，许可证见 [LICENSE.txt](LICENSE.txt)。官方 [初始化脚本](scripts/init-artifact.sh)、[打包脚本](scripts/bundle-artifact.sh) 和 `scripts/shadcn-components.tar.gz` 原样保留，不在 K1 执行联网安装。

## 选择实现方式

- **复杂方式**：多个页面共享同一份任务数据、有路由、或有多步表单时，使用官方 React、TypeScript、Vite、Tailwind、shadcn/ui 技术栈，用 Parcel 和 html-inline 打成单文件。发红包的选人、改额、确认、回执、记录要共享同一任务状态，不能分别写成互不相干的静态页。
- **简单方式**：其余情况直接生成单个 HTML，内嵌 CSS、JS 和示例数据。简单线框评审页无需引入构建链。

方式选择只影响实现，不改变 PRD、线框和已确认主题；读取 frontend-design 的结构提案确认记录。最终产物为 `prototype-v1.html`，后续 `prototype-v<n>.html`。构建项目和临时输出位于隔离的临时目录，不放进只能新建的 `outputs/`。

## 复杂方式的两种环境

**用户本地开发侧**：可以按官方方式用 npm 安装工具链。脚本实为 pnpm 命令：初始化脚本在缺少 pnpm 时执行 `npm install -g pnpm`，随后通过 pnpm 创建 Vite 工程、安装 Tailwind/shadcn 等依赖；打包脚本也会安装 Parcel 和 html-inline。不可把脚本描述成“仅 npm”或“无需联网”。先检查本地 Node（本仓库要求 ≥24）、包管理器、联网授权与仓库依赖规则，在独立原型项目中操作，不改脚手架的依赖清单。

从 Skill 目录运行初始化命令，参数为新的临时工程路径，再在生成工程根目录运行打包脚本：

```bash
bash scripts/init-artifact.sh <临时原型工程目录>
cd <临时原型工程目录>
bash <此Skill目录>/scripts/bundle-artifact.sh
```

初始化后的 `src/` 开发 React/TS，入口保留 `index.html`。官方打包脚本会清理工程内的 `dist` 和 `bundle.html`，所以只在本次专用临时工程执行。成功后核对 `bundle.html` 的离线完整性，将它作为新版本 `prototype-v<n>.html` 保存，不覆盖既有产物。

**工作室运行时（K3）**：使用预装好的模板和依赖，不联网。模板与构建工具可在用户拉取脚手架时安装，或放进 Docker 镜像；这属于 K3。原样官方脚本带安装动作，不能直接在运行时调用。由 K3 提供使用预装依赖的离线构建入口；未提供时停止复杂构建并说明缺口，不能降级成不满足共享数据要求的假交互，也不能修改服务端安装依赖。

## 两种方式共同遵守

HTML 必须是可离线打开的单文件，只用系统字体栈。每屏使用 `<section data-screen="<id>" data-state="<状态>" data-group="<分组>">`；支持 `#screen=<id>&state=<状态>` 只显示对应屏，且监听地址变化。内嵌 `design-outline`（`application/json`），结构与总流程一致。固定状态词表为 default、first-use、permission、loading、empty、error、recovery；自定义状态列入大纲。工作室中嵌入预览，不截图。

路由必须与屏幕定位兼容：`#screen=<id>&state=<状态>` 是外部预览入口，优先于上次保存的路由。每个状态提供可重复装载的独立示例数据；直接进入确认页或回执页时，也要补齐演示所需的上游任务数据。用户从入口操作时按真实顺序共享数据，修改后应反映在确认、回执和记录中。不要依赖真实接口或联网请求。

React 等动态页面也把 `design-outline` 作为静态 `application/json` 脚本写进最终 HTML，供工作室不执行页面 JS 就能读取。检查打包后的文件，而不是只看源码：页面和状态齐全，所有 `data-screen`、`data-state`、`data-group` 对应正确，hash 直接打开与变化都可定位，图标、资源、代码和样例数据均已内嵌。

检查总览和每个状态的操作，关闭网络后完整打开单文件；复杂流程验证至少一条任务从入口到结果的数据一致性。运行环境不支持验证时明确写未验证和原因，不把编译成功当成交互通过。用嵌入预览交付，不截图，不把构建成功自动视为用户确认。
