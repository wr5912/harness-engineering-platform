import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {prepareDeploymentFirewall} from '../firewall.mts'

function fixture(mode, check) {
  const dir=mkdtempSync(join(tmpdir(),'hep-firewall-'))
  const previous={PATH:process.env.PATH,HEP_FIREWALL_MODE:process.env.HEP_FIREWALL_MODE,HEP_FIREWALL_LOG:process.env.HEP_FIREWALL_LOG}
  const log=join(dir,'calls.jsonl')
  const script=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');const tool=path.basename(process.argv[1]),args=process.argv.slice(2),mode=process.env.HEP_FIREWALL_MODE;
fs.appendFileSync(process.env.HEP_FIREWALL_LOG,JSON.stringify([tool,...args])+'\\n');
if(tool==='ip'){console.log(JSON.stringify([{ifname:'eth1',addr_info:[{local:'172.16.138.170'}]}]));process.exit(0)}
if(tool==='ufw'){if(mode==='ufw'){console.log(args[0]==='status'?'Status: active':'Rule added');process.exit(0)}process.exit(1)}
if(args.includes('--state'))process.exit(mode==='off'||mode==='ufw'?1:0);
if(args.some(x=>x.startsWith('--get-zone-of-interface'))) {if(mode==='unassigned'){console.error('no zone');process.exit(2)}console.log('internal');process.exit(0)}
if(args.includes('--get-default-zone')) {console.log('public');process.exit(0)}
if(args.some(x=>x.startsWith('--query-port')))process.exit(args.some(x=>x.includes('18120'))?0:1);
if(mode==='denied')process.exit(13);console.log('success');
`
  for(const command of ['firewall-cmd','ufw','ip'])writeFileSync(join(dir,command),script,{mode:0o755})
  Object.assign(process.env,{PATH:dir,HEP_FIREWALL_MODE:mode,HEP_FIREWALL_LOG:log})
  try {check(()=>JSON.parse('['+readFileSync(log,'utf8').trim().split('\n').join(',')+']'))}
  finally {for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}rmSync(dir,{recursive:true,force:true})}
}

test('firewalld 按实际网卡区域补齐网关端口，即时和持久配置独立检查且不 reload',()=>fixture('firewalld',calls=>{
  assert.match(prepareDeploymentFirewall('172.16.138.170',[18120,53105,53105]),/internal/)
  const changes=calls().filter(row=>row.some(value=>value.startsWith('--add-port')))
  assert.deepEqual(changes,[['firewall-cmd','--zone=internal','--add-port=53105/tcp'],['firewall-cmd','--zone=internal','--permanent','--add-port=53105/tcp']])
  assert.ok(!calls().flat().includes('--reload'))
}))

test('UFW 仅放行当前部署入口，未活动防火墙时保留远端核验提示',()=>{
  fixture('ufw',calls=>{
    assert.match(prepareDeploymentFirewall('172.16.138.170',[18120,53105]),/UFW/)
    assert.deepEqual(calls().filter(row=>row[0]==='ufw'&&row[1]==='allow'),[
      ['ufw','allow','to','172.16.138.170','port','18120','proto','tcp'],
      ['ufw','allow','to','172.16.138.170','port','53105','proto','tcp']])
  })
  fixture('off',()=>assert.match(prepareDeploymentFirewall('172.16.138.170',[18120,53105]),/仍需从客户端核对/))
})

test('网卡未显式分配区域时使用 firewalld 默认区域',()=>fixture('unassigned',calls=>{
  assert.match(prepareDeploymentFirewall('172.16.138.170',[18120,53105]),/public/)
  assert.ok(calls().some(row=>row.includes('--get-default-zone')))
  assert.ok(calls().filter(row=>row.some(value=>value.startsWith('--add-port'))).every(row=>row.includes('--zone=public')))
}))

test('无法写入防火墙或监听地址不属于当前主机时明确失败',()=>fixture('denied',()=>{
  assert.throws(()=>prepareDeploymentFirewall('172.16.138.170',[18120,53105]),/防火墙配置失败/)
  assert.throws(()=>prepareDeploymentFirewall('172.16.138.171',[18120,53105]),/无法找到监听地址/)
}))
