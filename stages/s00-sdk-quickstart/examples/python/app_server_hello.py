"""选读：用官方 Python SDK（openai-codex）驱动 Codex。

它在底层启动的是 `codex app-server`，通过 stdio 收发 JSON-RPC，和 s01 起我们自己写的客户端是同一层；
而 Node 示例用的 TypeScript SDK，底层是一轮一个进程的 `codex exec`。

运行（在 s00 目录，需要 Python 3.10+）：
  python3 -m venv .venv-python
  .venv-python/bin/pip install -r examples/python/requirements.txt
  .venv-python/bin/python examples/python/app_server_hello.py "用一句话解释什么是 harness"
"""
import os
import sys
from pathlib import Path

from openai_codex import Codex, CodexConfig, Sandbox

ROOT = Path(__file__).resolve().parents[2]


def load_env(path):
    # 与 Node 示例一样读取本阶段的 .env（只认 KEY=VALUE 行）；终端里已经设置的变量优先。
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        key = key.strip()
        if sep and key and not key.startswith("#") and key not in os.environ:
            os.environ[key] = value.strip().strip("\"'")


def config():
    # 默认复用 npx codex login 的登录；填了 CODEX_API_KEY 时，用 .env 里的地址和模型直连，配置方式与 s01 相同。
    if not os.environ.get("CODEX_API_KEY"):
        return None
    base_url, model = os.environ.get("CODEX_BASE_URL"), os.environ.get("CODEX_MODEL")
    if not base_url or not model:
        sys.exit("使用 API Key 时，.env 里还要填写 CODEX_BASE_URL 和 CODEX_MODEL。")
    # 密钥只经子进程环境传给 Codex（env_key），不写进启动参数。
    return CodexConfig(config_overrides=(
        'model_provider="project_api"',
        f"model={model!r}".replace("'", '"'),
        'model_providers.project_api.name="Project API"',
        f"model_providers.project_api.base_url={base_url!r}".replace("'", '"'),
        'model_providers.project_api.env_key="CODEX_API_KEY"',
        'model_providers.project_api.wire_api="responses"',
        "model_providers.project_api.requires_openai_auth=false",
    ))


load_env(ROOT / ".env")
prompt = " ".join(sys.argv[1:]) or "用一句话解释什么是 harness。不要调用工具。"

with Codex(config=config()) as codex:
    thread = codex.thread_start(sandbox=Sandbox.read_only, cwd=str(ROOT))
    turn = thread.turn(prompt)
    methods = []
    for event in turn.stream():
        # 事件名就是 App Server 推来的 JSON-RPC 通知：turn/started、item/agentMessage/delta、turn/completed……
        if event.method not in methods:
            methods.append(event.method)
        if event.method == "item/agentMessage/delta" and event.payload.delta:
            print(event.payload.delta, end="", flush=True)
    print()
    print("对话 ID：", thread.id)
    print("这一轮收到的通知：", "、".join(methods))
