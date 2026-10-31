import { createServer } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
// CLI 与工作台共用的浏览器可用模块，从 shared/ 直接提供，不复制一份。
const sharedModules = { '/app/session-events.js': fileURLToPath(new URL('../shared/session-events.mjs', import.meta.url)) };
// Demo N 的源码快照位于仓库 stages/ 下；课程构建也从这里取目录，避免两处各写一份。
export const stageDirs = ['s01-single-turn','s02-multi-turn','s03-agent-core','s04-data-layer','s05-knowledge-layer'].map(name => `stages/${name}`);
export const defaultTargets = [
  ...[1,2,3,4,5].map(n => ({ id:`s0${n}`,name:`s0${n}`,root:path.resolve(root,'..',stageDirs[n-1]),live:n>=3,port:4310+n })),
  {id:'project',name:'当前项目',root,live:true,port:4317}
];
const readRoutes = new Set(['/health','/workbench','/sessions','/state','/events','/tools','/memory','/preferences','/workspace','/workspace/read','/resources/read','/knowledge','/knowledge/pages','/knowledge/read','/knowledge/job']);
const writeRoutes = new Set(['/sessions','/sessions/resume','/messages','/queue/continue','/preferences','/knowledge/search','/knowledge/index','/knowledge/source']);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json; charset=utf-8'};
function connection(target) {
  if (!target?.live) throw new Error('此版本使用 CLI，请查看教学操作。');
  const c=JSON.parse(readFileSync(path.join(target.root,'.data/connection.json'),'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(c.url) || typeof c.token!=='string' || c.token.length<16) throw new Error('服务连接信息无效。');
  return c;
}
function fail(status,message){return Object.assign(new Error(message),{status});}
export function createWorkbench({targets=defaultTargets,port=4320,staticRoot=publicRoot}={}) {
  const sessions=new Map();const streams=new Set();
  let origin;
  const server=createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    res.setHeader('cross-origin-resource-policy','same-origin');res.setHeader('x-frame-options','DENY');
    try{
      const allowedHosts=[new URL(origin).host,`localhost:${server.address().port}`];
      if(!allowedHosts.includes(req.headers.host))throw fail(403,'拒绝未知 Host。');
      const url=new URL(req.url,origin);
      if(url.pathname.startsWith('/api/')){
        if(req.headers['sec-fetch-site']==='cross-site')throw fail(403,'仅允许工作台同源访问。');
        if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)throw fail(403,'拒绝跨源请求。');
        if(req.method==='OPTIONS')throw fail(403,'不提供跨源访问。');
        if(url.pathname==='/api/bootstrap'&&req.method==='GET'){
          for(const [id,s] of sessions)if(s.expires<Date.now())sessions.delete(id);
          let id=(req.headers.cookie||'').match(/(?:^|;\s*)workbench_session=([a-f0-9]{64})(?:;|$)/)?.[1];
          if(!sessions.has(id)){if(sessions.size>=256)throw fail(429,'本地浏览器连接过多。');id=randomBytes(32).toString('hex');}
          sessions.set(id,{expires:Date.now()+8*60*60*1000});
          res.setHeader('set-cookie',`workbench_session=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800`);
          return send(200,{targets:targets.map(({id,name,live,port})=>({id,name,live,port}))});
        }
        const cookie=(req.headers.cookie||'').match(/(?:^|;\s*)workbench_session=([a-f0-9]{64})(?:;|$)/)?.[1];
        const session=sessions.get(cookie);
        if(!session||session.expires<Date.now())throw fail(401,'工作台会话已过期，请刷新页面。');
        if(req.headers['x-workbench']!=='1')throw fail(403,'缺少工作台请求标识。');
        if(req.method==='POST'&&req.headers.origin!==`http://${req.headers.host}`)throw fail(403,'写操作必须来自工作台页面。');
        if(url.pathname==='/api/status'&&req.method==='GET'){
          const result=await Promise.all(targets.map(async t=>{
            if(!t.live)return {id:t.id,status:'cli'};
            try {const c=connection(t);const r=await fetch(c.url+'/health',{headers:{authorization:`Bearer ${c.token}`},redirect:'error',signal:AbortSignal.timeout(1500)});
              const body=await r.json();return{id:t.id,status:r.ok?'ready':'degraded',model:body.model,queueBackend:body.queueBackend};
            }catch{return{id:t.id,status:'offline'};}
          }));return send(200,{targets:result});
        }
        const match=url.pathname.match(/^\/api\/agent\/([a-z0-9]+)(\/.*)$/);
        const target=targets.find(t=>t.id===match?.[1]);const route=match?.[2];
        if(!target || !(req.method==='GET'?readRoutes.has(route):req.method==='POST'&&writeRoutes.has(route)))throw fail(404,'接口不存在。');
        let c;try{c=connection(target);}catch{throw fail(503,'Agent 未启动；请按页面连接说明启动对应版本。');}
        let body;
        if(req.method==='POST'){
          if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail(415,'需要 JSON 请求。');
          let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>512*1024)throw fail(413,'请求超过 512 KiB。');chunks.push(chunk);}body=Buffer.concat(chunks);
          try{const value=JSON.parse(body);if(!value||Array.isArray(value)||typeof value!=='object')throw 0;}catch{throw fail(400,'JSON 无效。');}
        }
        const controller=new AbortController();const timer=route==='/events'?null:setTimeout(()=>controller.abort(),20000);
        res.once('close',()=>{controller.abort();clearTimeout(timer);});
        let upstream;
        try{upstream=await fetch(c.url+route+url.search,{method:req.method,headers:{authorization:`Bearer ${c.token}`,...(body?{'content-type':'application/json'}:{}),...(route==='/events'&&req.headers['last-event-id']?{'last-event-id':req.headers['last-event-id']}:{})},body,signal:controller.signal,redirect:'error'});}
        catch{clearTimeout(timer);throw fail(502,req.method==='POST'?'请求结果未确认。请刷新任务状态核对，不要盲目重复提交。':'暂时无法连接 Agent，请检查服务端。');}
        if(route==='/events'&&upstream.ok){
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform',connection:'keep-alive'});res.flushHeaders();streams.add(res);
          try{for await(const chunk of upstream.body){if(res.destroyed)break;if(res.writableLength>1024*1024)throw Error('slow');res.write(chunk);}}
          catch{/* Client reconnects and reads a fresh snapshot. */}finally{streams.delete(res);res.end();}return;
        }
        try{const value=await upstream.json();return send(upstream.status,value);}finally{clearTimeout(timer);}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw fail(405,'不支持此方法。');
      let requested=decodeURIComponent(url.pathname);if(requested==='/')requested='/app/index.html';if(requested==='/course'||requested==='/course/')requested='/course/index.html';
      if(!/^\/(app|course)\//.test(requested)||requested.includes('/briefs/')||requested.includes('/modules/')||requested.includes('/_')||!mime[path.extname(requested)])throw fail(404,'文件不存在。');
      const base=realpathSync(staticRoot),shared=sharedModules[requested],file=shared||realpathSync(path.resolve(base,'.'+requested));
      if(!shared&&(!file.startsWith(base+path.sep)||!statSync(file).isFile()))throw fail(404,'文件不存在。');
      // Course uses trusted inline quiz handlers from the selected teaching Skill.
      res.setHeader('content-security-policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.writeHead(200,{'content-type':mime[path.extname(requested)],'cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
    }catch(error){if(!res.headersSent)send(error.status||(error.code==='ENOENT'?404:500),{error:{message:error.status?error.message:'页面或服务暂不可用。'}});else res.end();}
  });
  return {server,async listen(){await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});origin=`http://127.0.0.1:${server.address().port}`;return origin;},async close(){for(const stream of streams)stream.end();await new Promise(ok=>{server.close(ok);server.closeAllConnections();});}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const value=Number(process.env.WORKBENCH_PORT||4320);if(!Number.isInteger(value)||value<1||value>65535)throw Error('WORKBENCH_PORT 无效。');
  const app=createWorkbench({port:value});console.log(`Agent 工作台 ${await app.listen()} · 教学 /course/`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close().then(()=>process.exit(0)));
}
