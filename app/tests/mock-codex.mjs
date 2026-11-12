export const mock = `
import {createInterface} from 'node:readline';
import {createToolService} from './server/modules/tools/loader.mjs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const registry=await createToolService(dirname(fileURLToPath(import.meta.url)));
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const threads=new Map(); let number=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const p=m.params||{};
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'mock'}});
 if(m.method==='config/read') {
  const file=readFileSync(process.env.CODEX_HOME+'/config.toml','utf8');
  const value=k=>JSON.parse(file.match(new RegExp('^'+k+' = (.+)$','m'))[1]);
  send({id:m.id,result:{config:{features:{memories:value('memories'),shell_tool:false,apply_patch_freeform:false},memories:Object.fromEntries(['use_memories','generate_memories','extract_model','consolidation_model','min_rollout_idle_hours'].map(k=>[k,value(k)]))}}});
 }
 if(m.method==='thread/memoryMode/set') send({id:m.id,result:{}});
 if(m.method==='skills/list') send({id:m.id,result:{data:[{cwd:process.cwd(),skills:[],errors:[]}]}});
 if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:[{name:'project_tools',runtimeStatus:'connected',tools:Object.fromEntries(registry.specs.map(t=>[t.name,t])),toolsError:null}],nextCursor:null}});
 if(m.method==='thread/list') send({id:m.id,result:{data:[...threads.values()],nextCursor:null}});
 if(m.method==='thread/start') {const thread={id:'thread-'+(threads.size+1),cwd:p.cwd,turns:[]}; threads.set(thread.id,thread);send({id:m.id,result:{thread,model:'unit-model',modelProvider:'project_api'}});}
 if(m.method==='thread/resume') send({id:m.id,result:{thread:threads.get(p.threadId),model:'unit-model',modelProvider:'project_api'}});
 if(m.method==='turn/start') {
  const thread=threads.get(p.threadId); const turn={id:'turn-'+(++number),status:'inProgress',items:[]}; thread.turns.push(turn);
  send({method:'turn/started',params:{threadId:thread.id,turn}});
  const user={id:'user-'+number,type:'userMessage',clientId:p.clientUserMessageId,content:p.input}; turn.items.push(user);
  send({method:'item/started',params:{threadId:thread.id,turnId:turn.id,item:user}});
  send({id:m.id,result:{turn:{id:turn.id,status:'inProgress',items:[]}}});
  ['mock ', 'reply ', turn.id].forEach((delta,index)=>setTimeout(()=>{
   send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:'answer-'+turn.id,delta}});
  },30*(index+1)));
  setTimeout(()=>{
   const item={id:'answer-'+turn.id,type:'agentMessage',text:'mock reply '+turn.id}; turn.items.push(item);turn.status='completed';
   send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});
   send({method:'turn/completed',params:{threadId:thread.id,turn}});
  },150);
 }
 if(m.method==='turn/steer') send({id:m.id,result:{turnId:p.expectedTurnId}});
});
`;
