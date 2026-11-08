import { currentIdentity, runOwner } from '../accounts/context.mjs';
import { routedRequest, validateRoute } from './routing.mjs';
import { AppError } from '../../../shared/errors.mjs';
import { withShardUser } from './fence.mjs';
const actions = new Set(['read','search','pages','resource']);
export function attachKnowledge(app, runtime) {
  const { knowledge, resources, permissionHub: hub, gate } = app;
  if (!knowledge) return;
  const originals = Object.fromEntries(['read','search','pages'].map(m => [m, knowledge[m].bind(knowledge)]));
  const resourceRead = resources.readById.bind(resources);
  const authorize = async (action, args) => {
    if (!actions.has(action)) throw new Error('内部知识接口只读。');
    if (action === 'resource') {
      const row = await resources.get(args.id); resources.authorize(row); return row.owner_id;
    }
    return (await knowledge.kb(args.kbId)).owner_id;
  };
  const local = async (action, args, owner) => {
    // Existing owner turns/indexing may finish after dispatch is paused; new HTTP admission is already closed.
    if (currentIdentity()?.userId === owner) runtime.assertPrimary?.(owner); else await runtime.admit(owner);
    runtime.inflight ||= new Map(); runtime.inflight.set(owner, (runtime.inflight.get(owner) || 0) + 1);
    try {
      return await withShardUser(owner, async () => {
        if (action === 'search' && args.queryVector) return knowledge.rag.search(knowledge, await knowledge.kb(args.kbId), args.query, args.limit, args.queryVector);
        return action === 'resource' ? resourceRead(args.id, args.options) : originals[action](action === 'pages' ? args.kbId : args);
      });
    } finally { runtime.inflight.set(owner, runtime.inflight.get(owner) - 1); }
  };
  runtime.readKnowledge = async ({ action, args, requester, revision }) => {
    return runOwner(requester, () => hub.withUser(requester, () => gate.run(gate.operator(requester), async () => {
      // Second fresh Hub snapshot at the owner, before touching its disk.
      const owner = await authorize(action, args);
      validateRoute(runtime.cache, owner, runtime.nodeId, revision);
      await runtime.admit(owner);
      return local(action, args, owner);
    })));
  };
  const dispatch = async (action, args) => {
    const owner = await authorize(action, args); // First Hub decision on the grantee's primary.
    const requester = currentIdentity().userId;
    if (action === 'search') {
      const { kbId, query, limit = 5 } = args;
      if (typeof query !== 'string' || !query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new AppError('查询或 limit 无效。');
      args = { kbId, query, limit };
      // Authoritative mount metadata decides RAG; requester pays query embedding on its own primary.
      const mode = (await knowledge.query('SELECT effective_mode FROM agent_data.knowledge_mounts WHERE instance_id=$1 AND kb_id=$3 AND agent_id=$4 AND $2::uuid IS NOT NULL', [kbId, knowledge.agent.definition.agent.id])).rows[0]?.effective_mode;
      if (owner !== requester && mode === 'rag') {
        if (!knowledge.rag) throw new AppError('RAG 配置不可用。', 503);
        args.queryVector = await withShardUser(requester, async () => (await knowledge.rag.embeddings.generate([query], knowledge.gate?.current()))[0]);
      }
    }
    return routedRequest({ cache: runtime.cache, userId: owner, nodeId: runtime.nodeId, members: runtime.coordination.members,
      local: () => local(action, args, owner),
      remote: async (address, route) => {
        const result = await runtime.call(address, '/internal/knowledge', { action, args, requester, revision: route.revision });
        return result;
      } });
  };
  for (const action of ['read','search','pages']) knowledge[action] = args => dispatch(action, action === 'pages' ? { kbId: args } : args);
  resources.readById = (id, options) => dispatch('resource', { id, options });
}
