import { AppError } from '../../../shared/errors.mjs';
export async function hubRoute(hub, method, pathname, readBody) {
  const ok = body => ({ status: 200, body });
  if (method === 'GET' && pathname === '/hub') return ok({ resources: hub.visible() });
  if (method === 'GET' && pathname === '/me/plan') return ok(await hub.plan());
  if (method === 'POST' && pathname === '/hub/skills') return { status: 201, body: await hub.upload(await readBody()) };
  if (method === 'POST' && pathname === '/hub/plans/assign') {
    const { username, plan, ...rest } = await readBody();
    if (Object.keys(rest).length) throw new AppError('只接受 username、plan。', 400);
    return ok(await hub.assign(username, plan));
  }
  const skillRead = pathname.match(/^\/hub\/skills\/([^/]+)$/);
  if (method === 'GET' && skillRead) return ok(await hub.readSkill(decodeURIComponent(skillRead[1])));
  const route = pathname.match(/^\/hub\/(knowledge|skills)\/([^/]+)\/(grants|publish|share|approve|reject)(?:\/([^/]+))?$/);
  if (!route) throw new AppError('接口不存在。', 404);
  const [, plural, encoded, action, target] = route, id = decodeURIComponent(encoded), type = plural === 'skills' ? 'skill' : 'knowledge';
  if (method === 'DELETE' && action === 'grants' && target) return ok(await hub.revoke(type, id, decodeURIComponent(target)));
  if (target) throw new AppError('接口不存在。', 404);
  if (method === 'GET' && action === 'grants') return ok({ grants: await hub.grants(type, id) });
  if (type === 'knowledge' && action === 'publish' && ['POST', 'DELETE'].includes(method)) return ok(await hub.publish(id, method === 'POST'));
  if (method !== 'POST') throw new AppError('接口不存在。', 404);
  const body = await readBody();
  if (type === 'knowledge' && action === 'grants' && Object.keys(body).join(',') === 'username') return ok(await hub.grantKnowledge(id, body.username));
  if (type === 'skill' && action === 'share' && Object.keys(body).join(',') === 'usernames') return { status: 202, body: await hub.shareSkill(id, body.usernames) };
  if (type === 'skill' && ['approve', 'reject'].includes(action) && !Object.keys(body).length) return ok(await hub.reviewSkill(id, action === 'approve'));
  throw new AppError('接口或请求字段无效。', 400);
}
