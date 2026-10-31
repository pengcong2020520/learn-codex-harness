#!/usr/bin/env bash
# 一次跑完全部协议探针。换版本：./run-all.sh --cli /path/to/node_modules/@openai/codex/bin/codex.js
set -e
cd "$(dirname "$0")"
export PATH=/workspace/tools/node24/bin:$PATH
node probe.mjs "$@"            # 注册/原生工具、时序与门禁、超时与中断、已删除工具（#24808）
node probe-multi.mjs "$@"      # 多连接广播（#35894）、共用进程隔离、每用户进程开销、MCP 热重载
node probe-ext.mjs "$@"        # hooks / 插件 / 技能意外加载（项目默认启动参数）
node probe-ext.mjs --hardened "$@"   # 同上，加 features.hooks=false、features.plugins=false
