# 课程全景与术语表交付记录

## 页面结构

- `/course/overview.html`：教程目标与学习路线图 → Codex / 自有程序分工 → 导论六个问题 → 阶段滑块、架构图、新增模块与学习入口 → s11 请求路径及模块首次出现阶段 → 五种学习入口的用途。
- `/course/glossary.html`：即时搜索 → 阶段筛选 → intro、s00–s11 分组 → 术语、别名、简短解释 → 可展开的详细解释、相关术语与 GitHub 出处。
- 阶段滑块默认 s11；支持原生方向键、Home / End、左右按钮和阶段刻度；架构图使用固定比例容器，切换时保持图高稳定。页面支持减少动态效果偏好。
- 术语搜索只匹配 term、aka、short，不搜索 detail 或 source；搜索与阶段筛选共同生效，无结果时显示提示。相关术语跳转会自动解除遮住目标的筛选并展开详情；直接打开锚点同样有效。
- 课程首页顶部新增“第一次来？先看全景”；首页、长文、阶段演示、工作台左栏均加入全景和术语表入口。
- 阶段演示从同一份 glossary.json 生成“本阶段新术语”。长文在构建时精确匹配 term / aka，替换悬停解释并链接术语表；不匹配项保留原解释，不修改 modules 源文件。

## 数据与构建

- 标题、概括、s11 请求路径与模块首次出现阶段来自 `stages/build-architecture.mjs` 的导出；新增模块和阶段目录来自 `stages/changes.json`。
- 六个问题从 `stages/introduction.md` 的对应表格提取；表格结构不再符合预期时构建报错。
- 所有术语内容来自现有 `app/web/curriculum/glossary.json`，没有改动这份输入数据。校验包括阶段、term 唯一性、related 引用和 source 文件存在性，另检查字段形状、锚点冲突与 source 越界。
- 当前长文只发布了 s01–s09。其他阶段的长文入口明确显示“长文待补充 · 查看已发布目录”，链接到现有目录，不创建不存在的章节锚点。机制课入口沿用课程首页已有的“暂无机制课程”处理。
- 开始任务时，仓库中不存在任务描述里的 `docs/images/learning-roadmap.svg` 和 `stages/build-roadmap.mjs`。新增 `app/web/build-course-roadmap.mjs`，从现有阶段数据生成确定性 SVG；课程构建维护 docs 中的 SVG，再读取并复制到课程 assets。`--check` 同时检查源图与副本。
- 新页面的全部动态文本经过转义；交互脚本为同源 JS，未加入内联脚本、内联事件或外部加载资源。GitHub 仅作为用户点击的出处链接。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `app/web/course-data.mjs` | 术语校验、稳定锚点、文本转义、GitHub URL、长文术语替换 |
| `app/web/build-course-pages.mjs` | 全景与术语表的构建渲染、导论问题提取 |
| `app/web/build-course-roadmap.mjs` | 基于阶段数据的路线图生成器 |
| `app/web/build-curriculum.mjs` | 接入校验、两页生成、术语关联、路线图生成与复制、过期检查 |
| `app/web/build-changes-page.mjs` | 阶段新术语及导航；复用仓库 URL 前缀 |
| `app/web/public/course/overview.html` | 生成的全景页 |
| `app/web/public/course/overview.js` | 阶段切换、按钮与辅助信息同步 |
| `app/web/public/course/overview.css` | 全景和术语表的响应式样式 |
| `app/web/public/course/glossary.html` | 生成的术语表页 |
| `app/web/public/course/glossary.js` | 搜索、筛选、空状态、锚点展开与定位 |
| `docs/images/learning-roadmap.svg` | 生成的路线图源文件 |
| `app/web/public/course/assets/learning-roadmap.svg` | 课程使用的路线图副本 |
| `app/web/public/course/_reader.html` | 首页导航及首次阅读入口模板 |
| `app/web/public/course/_handbook.html` | 长文导航模板 |
| `app/web/public/course/index.html` | 重建后的课程首页 |
| `app/web/public/course/handbook.html` | 重建后的长文，包含数据驱动的术语解释与链接 |
| `app/web/public/course/changes.html` | 重建后的阶段演示，包含术语行和导航 |
| `app/web/public/course/reader.css` | 首页醒目入口及窄屏导航 |
| `app/web/public/course/handbook.css` | 术语链接样式及窄屏导航 |
| `app/web/public/course/changes.css` | 阶段术语行及导航适配 |
| `app/web/public/app/main.js` | 工作台左栏课程入口 |
| `app/web/public/app/styles.css` | 工作台底部入口布局 |
| `app/web/tests/course-pages.test.mjs` | 数据校验、生成内容、转义、链接和 CSP 静态检查 |
| `app/web/tests/course-pages-browser.test.mjs` | 新页面与长文术语的浏览器交互测试 |
| `app/web/tests/browser.mjs` | 复用现有 CDP 客户端，增加真实键盘和鼠标悬停操作 |
| `app/web/tests/stages-browser.test.mjs` | 在既有工作台布局测试中检查新增入口可见性 |
| `docs/reports/course-overview-glossary.md` | 本交付记录 |

已有未跟踪输入 `app/web/curriculum/glossary.json` 在任务开始时就存在；本次只读取，没有改写。未修改 `stages/`，未添加依赖，未执行 git commit。

## 验证结果

已通过：

```sh
node app/web/build-curriculum.mjs
node app/web/build-curriculum.mjs --check
node --test app/web/tests/course-pages.test.mjs app/web/tests/curriculum.test.mjs
node --test --test-name-pattern '长文静态' app/web/tests/handbook.test.mjs
git diff --check
```

单元测试 28 项通过；既有长文静态检查 1 项通过。新增脚本及修改后的工作台脚本通过 `node --check`。当前构建输出为 24 个机制课时、9 个长文章节、92 个术语；长文中 43 处术语匹配数据并生成链接，85 处未匹配项保留原定义。这些是本次检查结果，页面不依赖这些固定数量。

## 无法在沙箱验证的部分

已尝试执行 `node --test app/web/tests/course-pages-browser.test.mjs`。三项用例均在 `createWorkbench().listen()` 时被沙箱阻止，报 `listen EPERM: operation not permitted 127.0.0.1`，尚未进入浏览器断言；不能视为交互验证通过。

请在沙箱外运行：

```sh
node --test app/web/tests/course-pages-browser.test.mjs
node --test app/web/tests/handbook.test.mjs app/web/tests/demos.test.mjs app/web/tests/stages-browser.test.mjs
```

待实际验证：s05 图片及新增模块、原生键盘与按钮切换、图高稳定、Thread 搜索、s04 筛选、跨筛选术语跳转、长文真实悬停解释、移动端横向溢出、工作台入口可见性，以及浏览器运行时 CSP。浏览器测试使用现有无头 Chrome/CDP；没有找到 Chrome 时会跳过，可通过 `CHROME_PATH` 指定已安装浏览器。
