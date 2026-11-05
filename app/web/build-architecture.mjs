import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const out=fileURLToPath(new URL('./public/course/assets/',import.meta.url));
const c={bg:'#FAFAF7',ink:'#202C35',muted:'#617079',line:'#D9E1E3',red:'#B34B38',rose:'#FFF0E9',blue:'#33658A',ice:'#EEF5FA',green:'#296E62',mint:'#EDF6F1',white:'#FFFFFF'};
const esc=s=>String(s).replace(/[&<>"']/g,v=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[v]));
let a=[];
function rect(x,y,w,h,fill=c.white,stroke=c.line,r=16){a.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);}
function text(s,x,y,size=26,color=c.ink,weight=400,anchor='start'){a.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`);}
function lines(arr,x,y,size=25,color=c.muted,gap=36){arr.forEach((s,i)=>text(s,x,y+i*gap,size,color));}
function line(x1,y1,x2,y2,color=c.blue,dashed=false,arrow=true){a.push(`<path d="M${x1},${y1} L${x2},${y2}" fill="none" stroke="${color}" stroke-width="2.5" ${dashed?'stroke-dasharray="7 6"':''} ${arrow?`marker-end="url(#${color===c.red?'red':color===c.green?'green':'arrow'})"`:''}/>`);}
function label(s,x,y,color=c.muted,size=20){text(s,x,y,size,color,500,'middle');}
function badge(s,x,y,w=110,fill=c.rose,color=c.red){rect(x,y,w,32,fill,fill,8);text(s,x+w/2,y+22,18,color,650,'middle');}
function panel(x,y,w,h,title,sub,fill=c.white,color=c.ink){rect(x,y,w,h,fill);text(title,x+28,y+46,29,color,650);if(sub)text(sub,x+28,y+82,21,c.muted);}
const data=[
 {n:1,title:'先打通一次问答',desc:'我们负责发起与验收，Codex 负责调用模型。先让一轮任务完整结束。',app:'单轮客户端',appLines:['读取输入，启动本机 Codex','发出请求，匹配事件，核对终态'],entry:['终端输入','一个问题'],engine:['组织模型调用','管理会话与本轮上下文'],detail:'一次请求，沿这五步走完',take:'收到回包 ≠ 已经答完；只有本轮成功结束，才能交付答案。'},
 {n:2,title:'让同一段对话继续下去',desc:'增加输入排队与会话恢复；每轮只发送新输入，历史由 Codex 保管。',app:'多轮客户端',appLines:['FIFO 排队：上一轮结束再发下一条','复用 Thread，按 Turn 匹配事件'],entry:['连续输入','多条消息'],engine:['复用同一个 Thread','原生历史提供上下文'],detail:'比 S01 多出来的，是顺序、复用与恢复',take:'我们的程序管输入顺序；Codex 管上下文。会话恢复不等于长期记忆。'},
 {n:3,title:'用配置装配一个能做事的 Agent',desc:'增加角色、Skills、工具与资料边界；服务常驻，终端通过 HTTP / SSE 接入。',app:'Agent 服务',appLines:['校验配置，装配角色与工具白名单','管理会话、任务队列和执行事件'],entry:['终端客户端','HTTP / SSE'],engine:['加载原生 Skills','经 MCP 调用本地工具'],detail:'角色说清做什么，Skill 提供方法，工具负责实际执行',take:'写作助手是测试案例。可复用的是角色、方法、工具与资料边界的装配方式。'},
 {n:4,title:'让任务与产物有据可查',desc:'把业务记录迁入 PostgreSQL，增加 Redis 唤醒和资源版本；原生历史仍归 Codex。',app:'Agent 服务 + 数据层',appLines:['任务与 outbox 在同一事务中提交','调度执行，登记产物版本及来源'],entry:['终端客户端','HTTP / SSE'],engine:['继续复用执行循环','经 MCP 调用资源工具'],detail:'四类数据，各自只承担一份明确的职责',take:'PostgreSQL 是业务状态的依据；Redis 负责唤醒，不能代替任务数据库。'},
 {n:5,title:'让知识可用，也让访问有边界',desc:'增加可信任务上下文与统一门禁，把原文组织成 Wiki，或按配置使用 RAG。',app:'Agent 服务 + 通用门禁',appLines:['由服务端签发 Task / Turn 身份','校验工具、资源归属与知识库授权'],entry:['任务 / 维护入口','HTTP / SSE'],engine:['组织模型与工具循环','dynamicTools 回调到产品侧'],detail:'每次操作先过门禁，再进入相应的知识路径',take:'模型可以提出操作，但不能授予权限；Wiki 和 RAG 都要保留可追溯的原文依据。'}
];
function main(d){
 a=[];a.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1040" viewBox="0 0 1600 1040" role="img" aria-labelledby="title desc"><title id="title">S0${d.n} 总架构：${esc(d.title)}</title><desc id="desc">${esc(d.desc)} 蓝色为我们的程序，绿色为 Codex 原生能力，橙色突出本阶段新增机制。上方展示请求与返回方向，下方展开职责和数据归属。</desc><defs>${[['arrow',c.blue],['red',c.red],['green',c.green]].map(([id,color])=>`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join('')}</defs><g font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif">`);
 rect(0,0,1600,1040,c.bg,c.bg,0);badge('S0'+d.n,48,40,80,c.red,c.white);text('冲量 AI  /  云端 Agent 脚手架',148,63,21,c.muted);text(d.title,48,128,46,c.ink,700);text(d.desc,48,174,26,c.muted);
 badge('我们的程序',48,204,134,c.ice,c.blue);badge('Codex 原生能力',198,204,172,c.mint,c.green);badge('本阶段新增',386,204,142);text('实线：请求 / 调用     虚线：事件 / 结果',1552,226,20,c.muted,400,'end');
 rect(48,280,180,184,c.white);label('用户',138,324,c.ink,30);label(d.entry[0],138,370,c.muted,23);label(d.entry[1],138,408,c.muted,21);
 rect(308,280,500,184,c.ice,'#ADC6D8');text(d.app,336,324,30,c.blue,650);lines(d.appLines,336,372,25,c.ink,38);
 rect(920,280,350,184,c.mint,'#ADCFC4');text('Codex App Server',948,324,29,c.green,650);lines(d.engine,948,372,24,c.ink,38);
 rect(1380,280,172,184,c.white);label('模型服务',1466,324,c.ink,27);label('理解上下文',1466,372,c.muted,22);label('判断下一步',1466,410,c.muted,22);
 line(228,350,306,350);line(308,396,230,396,c.blue,true);label('输入',268,337,c.blue,18);label('结果',268,426,c.muted,18);
 line(808,350,918,350);line(920,396,810,396,c.green,true);label('JSON-RPC',864,331,c.blue,18);label('事件 / 回包',864,426,c.green,18);
 line(1270,350,1378,350,c.green);line(1380,396,1272,396,c.green,true);label('模型请求',1324,331,c.green,18);label('模型响应',1324,426,c.muted,18);
 text('本机独立进程 · stdio 通信',948,490,19,c.muted);text(d.detail,48,543,29,c.ink,650);
}
for(const d of data){main(d);
 if(d.n===1){
  const seq=[['01','建立连接',['启动 App Server','initialize → initialized']],['02','建立会话',['thread/start','得到 Thread ID']],['03','开始本轮',['turn/start','发送用户输入']],['04','接收过程',['文本片段 / 状态通知','匹配 Thread + Turn']],['05','检查终态',['turn/completed','确认 status = completed']]];
  seq.forEach(([n,t,b],i)=>{const x=48+i*306;rect(x,577,280,180,i===4?c.rose:c.white,i===4?'#D8A18F':c.line);text(n,x+22,613,20,c.red,650);text(t,x+22,656,29,c.ink,650);lines(b,x+22,696,20,c.muted,31);if(i<4)line(x+280,665,x+304,665);});
  panel(48,785,736,115,'我们的程序保存','运行日志 .runs；失败或超时必须如实返回',c.ice,c.blue);
  panel(816,785,736,115,'Codex 保存','原生会话状态 .data/codex；本阶段不开放工具',c.mint,c.green);
 }
 if(d.n===2){
  panel(48,577,460,323,'① 先排队','由我们的程序管理',c.rose,c.red);
  ['消息 A  →  本轮执行','消息 B  →  等待 A 结束','消息 C  →  等待 B 结束'].forEach((s,i)=>{rect(76,686+i*59,404,44,c.white,c.line,9);text(s,96,716+i*59,23);});
  panel(548,577,460,323,'② 复用会话','同一个 Thread，每轮有独立 Turn',c.white,c.ink);
  ['Turn 1：第一次问答','Turn 2：只发第二条新输入','Turn 3：继续沿用上下文'].forEach((s,i)=>text(s,576,716+i*59,25,i===1?c.red:c.ink));
  panel(1048,577,504,323,'③ 恢复历史','由 Codex 原生保存',c.mint,c.green);
  lines(['退出后重新进入','选择已有 Thread','thread/resume 恢复会话','继续发送下一轮输入'],1076,707,25,c.ink,45);
  line(508,745,546,745,c.red);line(1008,745,1046,745,c.green);
 }
 if(d.n===3){
  panel(48,577,484,323,'配置：决定怎样工作','Agent 定义经过校验后生效',c.rose,c.red);
  lines(['角色：任务与行为边界','Skills：做事的方法说明','工具白名单：允许哪些操作','资料绑定：可读 / 可创建的目录'],76,710,25,c.ink,47);
  panel(568,577,484,323,'执行：把调用变成动作','Codex → MCP → 本地 Registry',c.rose,c.red);
  lines(['① 检查工具是否允许','② 校验调用参数','③ 执行读文件 / 写文件 / 搜索','④ 把工具结果交回 Codex'],596,710,25,c.ink,47);
  panel(1088,577,464,323,'结果：各自保存','文件与会话有不同归属',c.white,c.ink);
  lines(['workspace：资料与生成文件','本地 JSON：业务任务状态','Codex：原生会话与上下文','Skill 不会自动扩大工具权限'],1116,710,23,c.muted,47);
 }
 if(d.n===4){
  const cards=[['PostgreSQL','业务事实的依据',['会话 / 任务 / outbox','资源 ID / 版本 / 来源','任务和 outbox 同事务落库'],c.rose,c.red],['Redis','调度唤醒',['提醒服务有任务待执行','唤醒后从 PG 读取任务','不承担完整历史或任务真相'],c.rose,c.red],['文件系统','保存正文',['workspace：原文与产物','.data/files：不可变正文','元数据与来源关系登记到 PG'],c.ice,c.blue],['Codex 原生存储','保存会话上下文',['.data/codex','SQLite / JSONL','历史不搬入业务任务库'],c.mint,c.green]];
  cards.forEach(([t,s,b,fill,color],i)=>{const x=48+i*380;panel(x,577,364,266,t,s,fill,color);lines(b,x+28,714,21,c.ink,43);});
  rect(48,863,1504,42,c.white,c.line,9);text('任务提交：写入 PG → Redis 唤醒 → 读取任务执行 → 回写状态；跨 PG、Redis、文件的操作不构成一个事务。',70,891,23,c.muted);
 }
 if(d.n===5){
  rect(48,577,1504,87,c.rose,'#D8A18F');text('统一门禁',76,616,29,c.red,650);text('服务端可信身份  ∩  工具白名单  ∩  资源归属 / KB 授权  ∩  当前任务范围',280,615,27,c.ink,550);text('dynamicTools 回调与 HTTP 操作共用检查；模型填写的身份字段不授予权限。',280,645,21,c.muted);
  line(420,664,420,699,c.red);line(1180,664,1180,699,c.red);
  panel(48,702,736,148,'Wiki · 默认路径','原文 → Codex + Skill 维护 → 修订校验 → 当前有效页面',c.white,c.ink);
  text('基于来源版本维护；并发修订以版本校验决定能否生效。',76,821,23,c.muted);
  panel(816,702,736,148,'RAG · 可选路径','原文 → 分块 / 向量 + BM25 → 按生效模式检索',c.white,c.ink);
  text('需要额外配置；索引失败保留旧版本，不自动切换 Wiki。',844,821,23,c.muted);
  text('继续复用 S04 的 PG / Redis / 文件；Codex 保存原生历史。挂载知识库时禁用原生记忆。',48,895,25,c.muted);
 }
 rect(48,934,1504,67,'#24333C','#24333C',13);text(d.take,76,977,27,c.white,550);
 text('CHONGLIANG AI',48,1025,15,c.muted,650);text('逻辑职责图 · S0'+d.n+' 当前阶段实现 · 非云端部署拓扑',1552,1025,17,c.muted,400,'end');
 a.push('</g></svg>');fs.writeFileSync(out+`s0${d.n}-architecture.svg`,a.join('\n')+'\n');
}
console.log('Generated S01–S05 architecture SVGs.');
