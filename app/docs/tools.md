# 文件工具

`list_files` 浏览获准读取的目录，省略 `path` 返回允许范围的入口；`inputs/`、`./inputs`、`./inputs/` 按 `inputs` 处理，`./` 等同于省略路径。规范化发生在授权和资源状态过滤之前。只移除目录的 `./` 前缀和末尾 `/`，内部空段、`..`、隐藏路径、绝对路径、反斜杠、控制字符仍被拒绝，报错说明具体原因。范围外目录会提示规范路径及可浏览范围。符号链接、硬链接等原有边界保持不变。

`read_file` 读取并登记获准资料，返回 `resourceId`、`versionId`。`write_file` 新建文件，不覆盖。普通文本支持 md / txt / html；json / js / css 仅在 `outputs.directory` 内且由 `outputs.formats` 显式声明时可读写，读取仍需对应资料源的 `read` 授权。三种格式均遵守 256 KiB 文本上限，JSON 写入前必须通过 `JSON.parse` 校验，失败返回 400「产物 JSON 格式不正确。」。新增产物格式不扩大预览、上传或草稿的范围。推荐按已读取路径声明来源：

```json
{
  "path": "outputs/summary.md",
  "content": "整理后的内容",
  "source_versions": [{"path": "inputs/report.md"}]
}
```

`source_versions` 也支持 `{resourceId, versionId}`，同一数组可混用两种写法，每项选一种。路径方式取写入事务中的当前登记版本；尚未登记需先 `read_file`。需要固定到之前读取的版本时使用 ID。两种方式均检查读权限、归属、资源状态和上游依赖；输出目录的写入权不自动授予读取权。

错误标明 `source_versions 第 N 项`，从 1 开始，并区分路径不存在、尚未登记、没有读权限、resourceId 不存在、versionId 不属于该资源和版本过期。前两类 ID 错误提示可能抄错号码，只有确实属于该资源的旧版本才提示“资料已有更新，请重新读取”。参数 schema 拒绝非法项时也标明项号。

来源声明不代表自动事实核查，也不会自动捕获未声明的引用。持久化与失效传播见[数据层说明](data-layer.md)。

工作室可声明 `check_design` 和 `check_agent_package`，分别校验 HTML 布局及 Agent 代码包；参数、报告路径和运行边界见[设计校验说明](design-check.md)。

代码包前端只认 `agent/ui/`，并须在 `agent/agent.json` 声明 `agent.ui`（例如 `{ "entry": "ui/index.html", "title": "页面标题" }`）。包根 `ui/` 下的文件报错 `ui-location`；有 `agent/ui/` 文件但未声明 `agent.ui` 时，报错 `ui-undeclared`，因为这些前端不会被 `/app/` 提供。
