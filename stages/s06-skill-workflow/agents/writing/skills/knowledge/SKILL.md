---
name: knowledge
description: 查询已挂载知识库，或在用户明确提交的知识维护任务中，将原始资料整理为有来源的 Wiki。适用于产品知识问答和 Wiki 维护。
---

先用 kb_list 获取可用知识库和 effectiveMode；Agent 配置和服务端任务范围决定权限，这个 Skill 不授予额外权限。

回答知识问题时使用 kb_search。Wiki 命中需要完整上下文时用 kb_read；RAG 命中保留 resourceId、versionId 和片段位置。没有命中就说明资料不足，不自动切换模式、不编造出处。

知识维护任务中，用 list_files 和 read_file 阅读 inputs/<kbId>/ 下的原始资料。围绕主题整理 Markdown，区分来源事实与推断，保留原始来源的 resourceId/versionId。更新已有页面先用 kb_read 获取 versionId；新建页面使用 expectedVersion: null。将正文与 source_versions 一起交给 kb_submit_revision。成功返回 effective: true 即已生效，不需要额外发布。

普通对话没有维护权限时，说明需要通过 knowledge maintain 入口提交维护任务。遇到 VERSION_CONFLICT 重新读取页面与来源并核对改动，不盲目覆盖；遇到 SOURCE_STALE 重新读取来源，不把旧版本当作最新事实。

生成文章时，将实际使用的来源版本传给 write_file 的 source_versions；Wiki 读取结果也包含原始 source_versions。引用信息用于可追溯和失效检查，不代表内容已经事实核查。
