// Verbatim excerpts from project-evolution/demo1/05-app-server.mjs.
export const singleTurnSources = [
  {
    "file": "05-app-server.mjs",
    "start": 45,
    "code": "  const { workspace, args, catalogFile } = await prepareRun(launch, root);\n  if (catalogFile) console.log(\"已自动生成模型目录：\", catalogFile);\n  const eventFile = path.join(workspace, \"protocol.jsonl\");\n  const child = spawn(process.execPath, [cli, ...args], {\n    cwd: workspace, stdio: [\"pipe\", \"pipe\", \"pipe\"], env: launch.env\n  });\n  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });\n  const errors = createInterface({ input: child.stderr, crlfDelay: Infinity });"
  },
  {
    "file": "05-app-server.mjs",
    "start": 74,
    "code": "  function request(method, params) {\n    if (fatalError) return Promise.reject(fatalError);\n    const id = ++sequence;\n    return new Promise((resolve, reject) => {\n      const timer = setTimeout(() => fail(new Error(`App Server 请求超时：${method}`)), launch.timeoutMs);\n      pending.set(id, { resolve, reject, timer });\n      try { send({ id, method, params }); } catch (error) { fail(error); }\n    });"
  },
  {
    "file": "05-app-server.mjs",
    "start": 180,
    "code": "    await request(\"initialize\", {\n      clientInfo: { name: \"app_server_project\", title: \"App Server Project\", version: \"1.0.0\" },\n      capabilities: null\n    });\n    send({ method: \"initialized\", params: {} });\n    console.log(\"App Server 握手成功（不代表 API Key 已通过验证）。\");"
  },
  {
    "file": "05-app-server.mjs",
    "start": 145,
    "code": "  function selectThread(result) {\n    threadId = result.thread.id;\n    console.log(\"Thread id:\", threadId);\n    console.log(\"服务端选择的模型：\", redact(result.model));\n    console.log(\"服务端选择的服务商：\", redact(result.modelProvider));\n  }\n  async function startThread() {\n    selectThread(await request(\"thread/start\", { ...threadOptions, cwd: workspace }));\n  }"
  },
  {
    "file": "05-app-server.mjs",
    "start": 155,
    "code": "    if (!threadId) await startThread();\n    const turn = { threadId, id: null, answers: new Map(), buffer: [], completed: Promise.withResolvers() };\n    turn.completed.promise.catch(() => {});\n    activeTurn = turn;\n    const timer = setTimeout(() => fail(new Error(\"App Server 本轮调用超时；已停止连接，实际执行状态需检查日志，不自动重发。\")), launch.timeoutMs);\n    console.log(\"正在等待模型回复……\");\n    try {\n      const result = await request(\"turn/start\", {\n        threadId, input: [{ type: \"text\", text: prompt, text_elements: [] }]\n      });\n      turn.id = result.turn.id;\n      console.log(\"turn id:\", turn.id);\n      for (const message of turn.buffer) handleTurnEvent(message);\n      turn.buffer = [];\n      // RPC 响应仅表示受理；每一轮都必须等自己的 turn/completed。\n      await turn.completed.promise;"
  },
  {
    "file": "05-app-server.mjs",
    "start": 84,
    "code": "  function handleTurnEvent(message) {\n    const turn = activeTurn;\n    if (!turn || message.params?.threadId !== turn.threadId) return;\n    // turn/start 的通知可能早于 RPC 响应到达，先暂存，拿到 ID 后再严格匹配。\n    if (!turn.id) { turn.buffer.push(message); return; }\n    const eventTurnId = message.params.turnId || message.params.turn?.id;\n    if (eventTurnId !== turn.id) return;\n    if (message.method === \"item/agentMessage/delta\") {\n      const id = message.params.itemId;\n      turn.answers.set(id, (turn.answers.get(id) || \"\") + message.params.delta);\n    }\n    if (message.method === \"item/completed\" && message.params.item?.type === \"agentMessage\") {\n      turn.answers.set(message.params.item.id, message.params.item.text);\n    }\n    if (message.method === \"turn/completed\") {\n      if (message.params.turn.status === \"completed\") turn.completed.resolve(message.params.turn);\n      else turn.completed.reject(new Error(redact(message.params.turn.error || { status: message.params.turn.status })));"
  },
  {
    "file": "05-app-server.mjs",
    "start": 194,
    "code": "  } finally {\n    closing = true;\n    for (const waiter of pending.values()) clearTimeout(waiter.timer);\n    process.removeListener(\"SIGINT\", cancel);\n    process.removeListener(\"SIGTERM\", cancel);\n    lines.close();\n    errors.close();\n    child.stdin.end();\n    child.kill(\"SIGTERM\");\n    const force = setTimeout(() => child.kill(\"SIGKILL\"), 1500);\n    force.unref();\n    await exited;\n    clearTimeout(force);\n    finishRun(workspace);\n    console.log(\"协议日志：\", eventFile);"
  }
];
