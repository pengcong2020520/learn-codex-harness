import { withShardUser } from '../sharding/fence.mjs';
import { skillSignature } from '../hub/skills.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { userFileOperation } from './user-files.mjs';
import { RuntimePool } from './pool.mjs';
import { RuntimeRouter, assertToolOwner } from './router.mjs';
import { RuntimeStore } from './store.mjs';
import { isolationMode, prepareDirectories } from './directories.mjs';
import { currentIdentity, runOwner } from '../accounts/context.mjs';
import { prepareRun, finishRun } from '../codex/runtime.mjs';
import { prepareCodexConfig } from '../codex/config.mjs';
import { installSkills, verifySkills } from '../codex/skills.mjs';
import { CodexConnection } from '../codex/connection.mjs';
import { MemoryService } from '../memory/index.mjs';
import { RunMaintenance } from '../maintenance/index.mjs';

export function createRuntimes({ config, data, agent, tools, cli, redact, log, permissionHub, isolated = isolationMode({ log }), store = data.runtimeStore || new RuntimeStore(data.pool, data.scope.instanceId, config.root), connection = options => new CodexConnection(options) }) {
  let sessions, messages, router;
  store.sharding = config.sharding;
  const skillSync = new Map();
  const serialSkills = (owner, operation) => {
    const next = (skillSync.get(owner) || Promise.resolve()).catch(() => {}).then(operation);
    skillSync.set(owner, next);
    next.finally(() => { if (skillSync.get(owner) === next) skillSync.delete(owner); }).catch(() => {});
    return next;
  };
  const pool = new RuntimePool({
    log,
    shouldRestart: async (owner, value) => {
      if (!permissionHub || [...(sessions?.sessions.values() || [])].some(s => s.ownerId === owner && s.activeTurnId)) return false;
      return skillSignature(await permissionHub.allowedSkills(owner)) !== value.skillSignature || await permissionHub.nativeSearch(owner) !== value.nativeSearch;
    },
    assertEnabled: async owner => { config.generation?.assert(); config.sharding?.assertPrimary(owner); return store.assertEnabled(owner); },
    isBusy: async owner => {
      if ([...(sessions?.sessions.values() || [])].some(session => session.ownerId === owner && session.activeTurnId)) return true;
      return runOwner(owner, async () => (await data.jobs.list(null, { history: false })).some(job => ['queued', 'starting', 'running', 'steering'].includes(job.status)));
    },
    onLost: (owner, error) => messages?.failOwner(owner, error),
    onRemoved: owner => sessions?.invalidateOwner(owner),
    create: async (owner, signal) => serialSkills(owner, async () => {
      config.generation?.assert();
      const record = await store.ensure(owner);
      if (isolated) await store.migrateLegacy(record, { isolated, workspace: agent.workspacePath });
      signal.throwIfAborted();
      const paths = prepareDirectories(config.root, record, { isolated, workspace: agent.workspacePath });
      const launch = { ...config.launch, args: [...config.launch.args], env: { ...config.launch.env } };
      const nativeSearch = permissionHub ? await permissionHub.nativeSearch(owner) : true;
      if (!nativeSearch) { launch.args = launch.args.map(arg => arg.startsWith('web_search=') ? 'web_search="disabled"' : arg); launch.webSearch = 'disabled'; }
      const selectedSkills = permissionHub ? await permissionHub.allowedSkills(owner) : agent.skills;
      let runtime, installed;
      if (isolated) {
        // 只把必要配置和服务自有 Skill 内容交给用户辅助；不传服务环境或数据库密钥。
        const prepared = await userFileOperation(record.uid, 'prepare', {
          config: { root: config.root, codexHome: paths.codexHome, memory: config.memory,
            launch: { args: launch.args, catalog: launch.catalog, env: {} } },
          paths, instructions: agent.instructions, servicePid: process.pid, mcp: tools.configuration(),
          skills: selectedSkills.map(skill => ({ ...skill, contents: skill.contents || (skill.source
            ? Object.fromEntries(skill.files.map(name => [name, fs.readFileSync(path.join(skill.source, name)).toString('base64')])) : undefined) })),
        });
        runtime = prepared.runtime; installed = new Map(prepared.installed);
        launch.env = { ...launch.env, ...prepared.env };
      } else runtime = await prepareRun(launch, config.root, { ...paths, instructions: agent.instructions });
      Object.assign(runtime, { ownerId: owner, uid: record.uid, gid: record.uid, isolated });
      // 所有可变 Skill 状态、原生路径和记忆核验结果属于这个运行环境。
      const userAgent = Object.create(agent);
      userAgent.skills = selectedSkills;
      userAgent.assertCurrent = () => agent.assertCurrent();
      userAgent.permissionHub = permissionHub;
      userAgent.installedSkills = installed; userAgent.runtime = runtime; userAgent.descriptorWorkspace = agent.workspacePath;
      const userConfig = { ...config, launch, codexHome: paths.codexHome, runtimeUid: isolated ? record.uid : process.getuid?.(), runtimeIsolated: isolated, agent: userAgent };
      const rpc = connection({ launch, runtime, redact, cli, log });
      const memory = new MemoryService({ rpc, config: userConfig, sessions, redact });
      const maintenance = new RunMaintenance({ root: config.root, runtime, sessions, runsDir: paths.runsDir, log });
      let closed;
      const value = { rpc, runtime, agent: userAgent, memory, maintenance, nativeSearch, skillSignature: skillSignature(selectedSkills),
        close: () => closed ||= (async () => { await rpc.close(); await maintenance.close(); await finishRun(runtime.runDir, process.pid, runtime); })() };
      // 启动中 abort/核验失败也必须走同一关闭期限，不能因 close 挂起永占名额。
      const close = () => pool.closeValue(value);
      const abort = () => { void close().catch(error => pool.emit('error', error)); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        if (!isolated) {
          prepareCodexConfig(userConfig, tools.configuration());
          installSkills(userAgent, paths.codexHome);
        }
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
        rpc.toolHandler = async (params, context) => {
          signal.throwIfAborted();
          config.generation?.assert();
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
    }),
  });
  router = new RuntimeRouter(pool, { isolated });
  router.generation = config.generation;
  return {
    pool, rpc: router, store,
    async waitSkills(owner) { await skillSync.get(owner); },
    async syncSkills(owners) {
      for (const owner of new Set(owners)) if (!config.sharding || await config.sharding.canDispatch(owner)) await withShardUser(owner, () => serialSkills(owner, async () => {
        const selected = await permissionHub.allowedSkills(owner);
        const existing = (await data.pool.query('SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2', [data.scope.instanceId, owner])).rows[0];
        if (!existing && !selected.length) return;
        const record = existing || await store.ensure(owner);
        if (isolated) await store.migrateLegacy(record, { isolated, workspace: agent.workspacePath });
        const paths = prepareDirectories(config.root, record, { isolated, workspace: agent.workspacePath });
        const skills = selected.map(skill => ({ ...skill, contents: skill.contents || (skill.source
          ? Object.fromEntries(skill.files.map(name => [name, fs.readFileSync(path.join(skill.source, name)).toString('base64')])) : undefined) }));
        if (isolated) await userFileOperation(record.uid, 'skills', { skills, codexHome: paths.codexHome });
        else installSkills({ skills }, paths.codexHome);
        // 不改运行中 Agent 的集合/指纹。下个空闲租约检测差异，关闭后重建该用户进程。
      }));
    },
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
      if (permissionHub && (skillSignature(await permissionHub.allowedSkills(currentIdentity().userId)) !== value.skillSignature || await permissionHub.nativeSearch(currentIdentity().userId) !== value.nativeSearch))
        throw Object.assign(new Error('Skill 集合已变化，等待该用户当前轮次完成后受控重启。'), { code: 'HUB_RESTART_PENDING' });
      const current = await verifySkills(value.rpc, value.agent, value.runtime.workspaceDir);
      if (JSON.stringify(current) !== JSON.stringify(value.agent.availableSkills)) throw new Error('Skill 有效集合已变化，请受控重启后新建会话。');
    },
    async open(onError) {
      pool.on('error', onError);
      // LISTEN 断开会失去账号禁用通知，仍须触发全局故障路径。
      const unlisten = await store.listen(owner => pool.disable(owner), onError);
      pool.startSweeper();
      return async () => { await pool.close(); await unlisten(); };
    },
  };
}
