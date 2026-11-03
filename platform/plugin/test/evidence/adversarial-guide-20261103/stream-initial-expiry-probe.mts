import { once } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../platform/plugin/node_modules/esbuild/lib/main.js'
const base=resolve('.local/audit-guide-20261103'), root=mkdtempSync(join(base,'stream-root-'))
const outfile=join(base,'external-stream-probe.mjs')
await build({entryPoints:['platform/plugin/src/instances/external/index.ts'],outfile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'})
const external=await import('file://'+outfile)
const timers=new Set<any>(), servers:any[]=[]
let riskCalls=0, expiresAt='', serial=0, dispatchAt=''
const realAppend=fs.appendFileSync
fs.appendFileSync=((...args:any[])=>{if(String(args[1]).includes('\"operation\":\"session:events\"')&&String(args[1]).includes('\"stage\":\"dispatching\"'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);return (realAppend as any)(...args)}) as typeof fs.appendFileSync
syncBuiltinESMExports()
const caller=()=>({subjectId:'platform-owner',source:'fixture',expiresAt:new Date(Date.now()+60000).toISOString()})
const controller=new AbortController()
let handler:any
const observations:any={scope:'隔离本地外部边界；真实登记、验证、HTTP事件代理，不操作现有服务',checks:[]}
try {
 mkdirSync(join(root,'config'));writeFileSync(join(root,'config/business-access.json'),JSON.stringify({schemaVersion:1,enabled:true,agents:[]}))
 const upstream=createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c
  res.setHeader('content-type','application/json')
  if(req.url==='/api/info')return res.end(JSON.stringify({version:'2.2.5',pid:process.pid}))
  if(req.url==='/api/session')return res.end(JSON.stringify({data:req.method==='POST'?{id:'ses_probe'}:[]}))
  if(req.url==='/api/event'){
   dispatchAt=new Date().toISOString()
   res.writeHead(200,{'content-type':'text/event-stream'});let n=0
   const tick=()=>res.write('data: '+JSON.stringify({type:'message',data:{sessionID:'ses_probe',n:++n,at:new Date().toISOString()}})+'\n\n')
   tick();const timer=setInterval(tick,50);timers.add(timer);res.on('close',()=>{clearInterval(timer);timers.delete(timer)});return
  }
  res.writeHead(404);res.end('{}')
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');servers.push(upstream)
 const rpc=external.createExternalInstancesHandler(root), owner={principal:{kind:'owner'}}
 const call=async(action:string,input:any)=>{const r=await rpc(action,input,controller.signal,owner);if(!r.ok)throw Error(JSON.stringify(r.error));return r.value}
 const revision=async()=> (await call('list',{})).revision
 const saved=await call('save',{revision:await revision(),requestId:'save-probe',agent:{id:'probe-agent',name:'probe',system:'fixture',owner:'fixture'},instance:{id:'probe-one',name:'probe',framework:'opencode',endpoint:`http://127.0.0.1:${(upstream.address() as any).port}`,managementMode:'externally-managed',usageMode:'shared'},policy:{enabled:true,subjects:['A','platform-owner'],actions:['agent:access','session:create','session:events']}})
 await call('verify',{id:'probe-one',revision:await revision(),requestId:'verify-probe'});await call('enable',{id:'probe-one',revision:await revision(),requestId:'enable-probe'})
 const create=await call('invoke',{id:'probe-one',operation:'session:create',requestId:'create-probe'})
 const risk=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const q=JSON.parse(body);riskCalls++;expiresAt=new Date(Date.now()+250).toISOString();res.setHeader('content-type','application/json');res.end(JSON.stringify({version:1,scope:q.scope,level:'low',constraints:{deniedOperations:[]},expiresAt}))})
 risk.listen(0,'127.0.0.1');await once(risk,'listening');servers.push(risk)
 const path=join(root,'config/business-access.json'), config=JSON.parse(readFileSync(path,'utf8'));config.riskAssessment={endpoint:`http://127.0.0.1:${(risk.address() as any).port}/risk`};writeFileSync(path,JSON.stringify(config))
 handler=external.createExternalAccessHandler(root,{authenticate:async()=>caller()})
 const gateway=createServer((req,res)=>void handler(req,res));gateway.listen(0,'127.0.0.1');await once(gateway,'listening');servers.push(gateway)
 const response=await fetch(`http://127.0.0.1:${(gateway.address() as any).port}/api/external-instances/v1/probe-one/events?sessionId=${create.sessionId}`,{signal:controller.signal})
 const reader=response.body!.getReader(), decoder=new TextDecoder();let afterExpiry:any, text=''
 const deadline=Date.now()+1300
 while(Date.now()<deadline){const next=await reader.read();if(next.done)break;text+=decoder.decode(next.value);const blocks=text.split('\n\n');text=blocks.pop()!;for(const block of blocks){if(!block.startsWith('data: '))continue;const x=JSON.parse(block.slice(6));if(Date.parse(x.data.at)>Date.parse(expiresAt)+350){afterExpiry=x;break}}if(afterExpiry)break}
 observations.dispatchAt=dispatchAt;observations.dispatchAfterExpiryMs=dispatchAt?Date.parse(dispatchAt)-Date.parse(expiresAt):0;observations.injectedExternalBoundary='仅事件访问记录appendFileSync增加400ms同步延迟，真实函数和网络派发路径未替换';observations.httpStatus=response.status;observations.riskCalls=riskCalls;observations.riskExpiresAt=expiresAt;observations.eventAfterExpiry=afterExpiry??null;observations.confirmed=!!afterExpiry;observations.overrunMs=afterExpiry?Date.parse(afterExpiry.data.at)-Date.parse(expiresAt):0
 await reader.cancel()
} finally {controller.abort();handler?.close();fs.appendFileSync=realAppend;syncBuiltinESMExports();for(const timer of timers)clearInterval(timer);for(const server of servers){server.closeAllConnections();server.close()}rmSync(root,{recursive:true,force:true})}
writeFileSync(join(base,'stream-initial-expiry-probe.json'),JSON.stringify(observations,null,2)+'\n')
console.log(JSON.stringify(observations))
