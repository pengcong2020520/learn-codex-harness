import { RuntimePool } from './pool.mjs';
import { RuntimeRouter, assertToolOwner } from './router.mjs';
import { RuntimeStore } from './store.mjs';
import { isolationMode, prepareDirectories, secureTree } from './directories.mjs';
import { currentIdentity, runOwner } from '../accounts/context.mjs';
import { prepareRun, finishRun } from '../codex/runtime.mjs';
import { prepareCodexConfig } from '../codex/config.mjs';
import { installSkills, verifySkills } from '../codex/skills.mjs';
import { CodexConnection } from '../codex/connection.mjs';
import { MemoryService } from '../memory/index.mjs';
import { RunMaintenance } from '../maintenance/index.mjs';

export function createRuntimes({ config, data, agent, tools, cli, redact, log, isolated = isolationMode({ log }), store = data.runtimeStore || new RuntimeStore(data.pool, data.scope.instanceId, config.root), connection = options => new CodexConnection(options) }) {
  let sessions, messages, router;
  const pool = new RuntimePool({
    assertEnabled: owner => store.assertEnabled(owner),
    isBusy: async owner => {
      if ([...(sessions?.sessions.values() || [])].some(session => session.ownerId === owner && session.activeTurnId)) return true;
      return runOwner(owner, async () => (await data.jobs.list(null, { history: false })).some(job => ['queued', 'starting', 'running', 'steering'].includes(job.status)));
    },
    onLost: (owner, error) => messages?.failOwner(owner, error),
    onRemoved: owner => sessions?.invalidateOwner(owner),
    create: async (owner, signal) => {
      const record = await store.ensure(owner);
      signal.throwIfAborted();
      const paths = prepareDirectories(config.root, record, { isolated, workspace: agent.workspacePath });
      const launch = { ...config.launch, args: [...config.launch.args], env: { ...config.launch.env } };
      const runtime = await prepareRun(launch, config.root, { ...paths, instructions: agent.instructions });
      Object.assign(runtime, { ownerId: owner, uid: record.uid, gid: record.uid, isolated });
      // 所有可变 Skill 状态、原生路径和记忆核验结果属于这个运行环境。
      const userAgent = Object.create(agent);
      userAgent.runtime = runtime; userAgent.descriptorWorkspace = agent.workspacePath;
      const userConfig = { ...config, launch, codexHome: paths.codexHome, agent: userAgent };
      const rpc = connection({ launch, runtime, redact, cli, log });
      const memory = new MemoryService({ rpc, config: userConfig, sessions, redact });
      const maintenance = new RunMaintenance({ root: config.root, runtime, sessions, runsDir: paths.runsDir, log });
      let closed;
      const close = () => closed ||= (async () => { await rpc.close(); await maintenance.close(); finishRun(runtime.runDir); })();
      const abort = () => { void close(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        prepareCodexConfig(userConfig, tools.configuration());
        installSkills(userAgent, paths.codexHome);
        secureTree(paths.codexHome, record.uid, isolated);
        secureTree(runtime.runDir, record.uid, isolated);
        signal.throwIfAborted();
        await rpc.open();
        signal.throwIfAborted();
        const verify = async () => {
          const skills = await verifySkills(rpc, userAgent, runtime.workspaceDir);
          await tools.verify(tools.registry, undefined, rpc);
          await memory.verify();
          await userAgent.activate(tools.registry.compatibilityVersion, skills);
        };
        if (tools.serial) await tools.serial(verify); else await verify();
        await store.assertEnabled(owner);
        signal.throwIfAborted();
        const value = { rpc, runtime, agent: userAgent, memory, close, maintenance };
        rpc.toolHandler = async (params, context) => {
          signal.throwIfAborted();
          await store.assertEnabled(owner);
          return runOwner(owner, async () => {
            const permissionContext = tools.gate?.forTurn(params.threadId, params.turnId);
            const task = permissionContext && await data.jobs.get(permissionContext.taskId);
            assertToolOwner(owner, task, sessions.sessions.get(params.threadId));
            if (sessions.getTurn(params.threadId, params.turnId)?.status !== 'inProgress') throw new Error('工具请求不属于执行中轮次。');
            return pool.withOwner(owner, () => tools.registry.call(params, { ...context, permissionContext }));
          });
        };
        router.attach(value, owner);
        // 原生历史 cwd 已是稳定用户目录；按用户清理运行日志，不触碰原生历史。
        await maintenance.start();
        signal.throwIfAborted();
        return value;
      } catch (error) { await close(); throw error; }
    },
  });
  router = new RuntimeRouter(pool);
  return {
    pool, rpc: router, store,
    agent: router.agent(agent),
    memory: Object.fromEntries(['snapshot', 'summary', 'contribute'].map(method => [method, (...args) => pool.withOwner(currentIdentity().userId, value => value.memory[method](...args))])),
    attach(services) { ({ sessions, messages } = services); router.sessions = sessions;
      router.ownerOf = async thread => {
        const row = await data.repository.conversation(thread);
        return row.owner_id;
      };
    },
    async beforeTurn() {
      const value = router.current();
      const current = await verifySkills(value.rpc, value.agent, value.runtime.workspaceDir);
      if (JSON.stringify(current) !== JSON.stringify(value.agent.availableSkills)) throw new Error('Skill 有效集合已变化，请受控重启后新建会话。');
    },
    async open(onError) {
      pool.on('error', onError);
      const unlisten = await store.listen(owner => pool.disable(owner), onError);
      pool.startSweeper();
      return async () => { await pool.close(); await unlisten(); };
    },
  };
}
