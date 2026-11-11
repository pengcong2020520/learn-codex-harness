// 测试用的无头 Chrome：最小 CDP 客户端，章节长文与阶段演示的浏览器测试共用。
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const chrome=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(file=>file&&fs.existsSync(file));

// 最小 CDP 客户端：一个浏览器连接，扁平会话。
// CI cold-starts several Chrome processes at once; first launch can exceed 15 s there.
export async function browser(t){
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'handbook-chrome-'));
 const proc=spawn(chrome,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-gpu','--window-size=1280,900','about:blank'],{stdio:['ignore','ignore','pipe']});
 const exited=new Promise(r=>proc.once('exit',r));
 t.after(async()=>{proc.kill();await exited;fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Chrome 没有在 60 秒内启动')),60000);proc.stderr.on('data',d=>{text+=d;const m=text.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});proc.on('exit',code=>reject(Error(`Chrome 退出：${code}`)));});
 const ws=new WebSocket(endpoint);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});t.after(()=>ws.close());
 let id=0;const pending=new Map(),listeners=[];
 ws.onmessage=({data})=>{const msg=JSON.parse(data);if(msg.id&&pending.has(msg.id)){const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);msg.error?reject(Error(msg.error.message)):resolve(msg.result);}else for(const fn of listeners)fn(msg);};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params)=>send(method,params,sessionId);const errors=[];
 listeners.push(msg=>{if(msg.sessionId!==sessionId)return;if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);if(msg.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(msg.params.type))errors.push(msg.params.args.map(a=>a.value??a.description).join(' '));if(msg.method==='Log.entryAdded'&&['error','warning'].includes(msg.params.entry.level))errors.push(msg.params.entry.text+(msg.params.entry.url?` ${msg.params.entry.url}`:''));});
 await Promise.all([page('Runtime.enable'),page('Log.enable'),page('Page.enable')]);
 async function open(url,{reduceMotion=false}={}){await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduceMotion?'reduce':'no-preference'}]});const loaded=new Promise(r=>listeners.push(m=>{if(m.sessionId===sessionId&&m.method==='Page.loadEventFired')r();}));await page('Page.navigate',{url});await loaded;}
 async function run(source){const {result,exceptionDetails}=await page('Runtime.evaluate',{expression:`(async()=>{${source}})()`,awaitPromise:true,returnByValue:true});if(exceptionDetails)throw Error(exceptionDetails.exception?.description||exceptionDetails.text);return result.value;}
 async function clickNavigate(selector){
  const loaded=new Promise(resolve=>listeners.push(message=>{if(message.sessionId===sessionId&&message.method==='Page.loadEventFired')resolve();}));
  await page('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)}).click()`});
  await loaded;
 }
 const shot=async()=>(await page('Page.captureScreenshot',{format:'png'})).data;
 const viewport=(width,height)=>page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 const beforeLoad=source=>page('Page.addScriptToEvaluateOnNewDocument',{source});
 const key=async(key,windowsVirtualKeyCode)=>{await page('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode});await page('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode});};
 const hover=async selector=>{
  const point=await run(`const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};`);
  await page('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
 };
 return {open,run,errors,shot,viewport,beforeLoad,clickNavigate,key,hover};
}
export const helpers=`const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)],sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(fn,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await sleep(30);}return false;};`;
