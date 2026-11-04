import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fstabForBind, planRelocation, relocate } from '../relocate.mts'

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'hep relocate '))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const prefix = join(base, 'program'), fromDataRoot = join(base, 'old data'), dataRoot = join(base, 'new data')
  for (const dir of [join(prefix, '.local'), join(prefix, 'bin'), join(prefix, 'platform'), fromDataRoot]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(prefix, '.local/installation.json'), '{}')
  writeFileSync(join(prefix, 'bin/hep-env.sh'), `export HARNESS_ASSET_ROOT=\${HARNESS_ASSET_ROOT:-'${fromDataRoot}'}\n`)
  writeFileSync(join(prefix, 'platform/lifecycle.mts'), 'export const managedState = () => undefined; export const ownsPort = () => false')
  writeFileSync(join(fromDataRoot, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-kept', legacyRoots: ['/historical/data'] }))
  return { prefix, fromDataRoot, dataRoot }
}

test('迁移计划拒绝覆盖、嵌套和缺失安装身份，dry-run 不修改文件', async t => {
  const options = fixture(t)
  const original = readFileSync(join(options.prefix, 'bin/hep-env.sh'), 'utf8')
  assert.equal(planRelocation(options).mode, 'rename')
  assert.equal((await relocate({ ...options, dryRun: true })).status, 'planned')
  assert.equal(existsSync(options.dataRoot), false)
  assert.equal(readFileSync(join(options.prefix, 'bin/hep-env.sh'), 'utf8'), original)
  assert.equal(existsSync(join(options.prefix, '.local/deploy-relocations')), false)
  writeFileSync(join(options.prefix, 'bin/hep-env.sh'), "export HARNESS_ASSET_ROOT=wrong\n")
  await assert.rejects(relocate({ ...options, dryRun: true }), /启动定位不一致/)
  writeFileSync(join(options.prefix, 'bin/hep-env.sh'), original)
  assert.throws(() => planRelocation({ ...options, dataRoot: join(options.fromDataRoot, 'nested') }), /相互独立/)
  mkdirSync(options.dataRoot)
  writeFileSync(join(options.dataRoot, 'user-file'), 'keep')
  assert.throws(() => planRelocation(options), /已占用/)
  assert.equal(readFileSync(join(options.dataRoot, 'user-file'), 'utf8'), 'keep')
  rmSync(join(options.prefix, '.local/installation.json'))
  assert.throws(() => planRelocation(options), /缺少安装清单/)
})

test('持久 bind 挂载转义路径、声明源挂载依赖、重复执行不重复写入且拒绝冲突', () => {
  const before = 'LABEL=storage /srv/storage ext4 defaults 0 2\n'
  const after = fstabForBind(before, '/srv/storage/old data', '/root/new data')
  assert.match(after, /old\\040data \/root\/new\\040data none bind,x-systemd.requires-mounts-for=/)
  assert.equal(fstabForBind(after, '/srv/storage/old data', '/root/new data'), after)
  assert.throws(() => fstabForBind('/different /root/new\\040data none bind 0 0\n', '/srv/storage/old data', '/root/new data'), /冲突/)
})

test('prepare 失败恢复原目录、启动定位和工作区历史，私有回执保留失败', async t => {
  const options = fixture(t)
  writeFileSync(join(options.prefix, 'platform/dsh-platform'), '#!/bin/sh\nexit 9\n', { mode: 0o755 })
  const workspace = readFileSync(join(options.fromDataRoot, 'workspace.json'), 'utf8')
  const env = readFileSync(join(options.prefix, 'bin/hep-env.sh'), 'utf8')
  // 以独立子进程 HOME 避免触碰开发用户的真实定位文件。
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const module = fileURLToPath(new URL('../relocate.mts', import.meta.url))
  const code = `import {relocate} from ${JSON.stringify(module)}; try {await relocate(${JSON.stringify(options)})} catch (e) {console.log(e.message)}`
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: join(options.prefix, 'test-home') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(result, /已恢复原定位/)
  assert.equal(realpathSync(options.fromDataRoot), options.fromDataRoot)
  assert.equal(existsSync(options.dataRoot), false)
  assert.equal(readFileSync(join(options.fromDataRoot, 'workspace.json'), 'utf8'), workspace)
  assert.equal(readFileSync(join(options.prefix, 'bin/hep-env.sh'), 'utf8'), env)
  const { readdirSync } = await import('node:fs')
  const backup = join(options.prefix, '.local/deploy-relocations', readdirSync(join(options.prefix, '.local/deploy-relocations'))[0])
  assert.equal(JSON.parse(readFileSync(join(backup, 'receipt.json'))).status, 'rolled-back')
  assert.equal(statSync(backup).mode & 0o777, 0o700)
  assert.equal(statSync(join(backup, '0')).mode & 0o777, 0o600)
  assert.match(readFileSync(join(backup, 'lifecycle.log'), 'utf8'), /prepare 失败/)
  assert.equal(statSync(join(backup, 'lifecycle.log')).mode & 0o777, 0o600)
})

test('同文件系统迁移保留 inode、历史 Session 和挂载别名，重复执行幂等', async t => {
  const options = fixture(t)
  writeFileSync(join(options.prefix, 'platform/dsh-platform'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const header = '{"type":"session/header","cwd":"/historical/data"}\n'
  writeFileSync(join(options.fromDataRoot, 'session-history'), header)
  const inode = statSync(options.fromDataRoot).ino
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const module = fileURLToPath(new URL('../relocate.mts', import.meta.url))
  const code = `import {relocate} from ${JSON.stringify(module)}; console.log(JSON.stringify(await relocate(${JSON.stringify(options)}))); console.log(JSON.stringify(await relocate(${JSON.stringify(options)})))`
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: join(options.prefix, 'test-home') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const reports = result.trim().split('\n').map(JSON.parse)
  assert.equal(reports[0].status, 'relocated')
  assert.equal(reports[1].status, 'unchanged')
  assert.equal(statSync(options.dataRoot).ino, inode)
  assert.equal(realpathSync(options.fromDataRoot), options.dataRoot)
  assert.equal(readFileSync(join(options.dataRoot, 'session-history'), 'utf8'), header)
  assert.deepEqual(JSON.parse(readFileSync(join(options.dataRoot, 'workspace.json'))).legacyRoots, ['/historical/data', options.fromDataRoot])
  assert.equal(JSON.parse(readFileSync(join(options.prefix, 'test-home/.config/harness-engineering-platform/workspace.json'))).assetRoot, options.dataRoot)
})

test('远端工具源码可由安装器 Node 以 TypeScript stdin 执行，参数含空格不改变路径', async t => {
  const options = fixture(t)
  const { execFileSync } = await import('node:child_process')
  const source = readFileSync(new URL('../relocate.mts', import.meta.url), 'utf8')
  const input = source + '\nconsole.log(JSON.stringify(await relocate(JSON.parse(process.argv[2]))))\n'
  const result = execFileSync(process.execPath, ['--input-type=module-typescript', '-', JSON.stringify({ ...options, dryRun: true })], { input, encoding: 'utf8' })
  assert.equal(JSON.parse(result).dataRoot, options.dataRoot)
  assert.equal(JSON.parse(result).status, 'planned')
  assert.equal(existsSync(options.dataRoot), false)
})

test('中断迁移按匹配回执恢复平台，核对原生工作区和会话后才标记完成', async t => {
  const options = fixture(t)
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const module = fileURLToPath(new URL('../relocate.mts', import.meta.url))
  writeFileSync(join(options.prefix, 'platform/dsh-platform'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const code = `
    import { relocate } from ${JSON.stringify(module)};
    import * as fs from 'node:fs'; import {createServer} from 'node:http';
    const options=${JSON.stringify(options)};
    const first=await relocate(options);
    const receipt=first.backup+'/receipt.json';
    fs.writeFileSync(receipt,JSON.stringify({...first,status:'recovery-required',sessionsPreserved:1,sessionIds:['kept'],platform:{host:'127.0.0.1',port:18121,publicUrl:'http://public.example/hep/'}}));
    fs.mkdirSync(options.prefix+'/.local/deploy-relocations/unfinished-backup');
    const credentials=options.dataRoot+'/.local/credentials';fs.mkdirSync(credentials,{recursive:true});
    fs.writeFileSync(credentials+'/admin.json',JSON.stringify({username:'test-user',password:'test-password'}));
    const storage=options.dataRoot+'/.local/platform-home/storages';fs.mkdirSync(storage,{recursive:true});
    fs.writeFileSync(storage+'/workspace.json',JSON.stringify({global:{workspaceIds:['one']},tables:{workspaces:{one:{path:options.dataRoot}}}}));
    const server=createServer((req,res)=>{if(req.url==='/login'){res.writeHead(303,{'set-cookie':'test-session=fixture'});res.end()}else{res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{ok:true,value:{items:[{sessionId:'kept',running:false}]}}}))}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const flag=options.prefix+'/started';
    // fixture 使用首次导入的生命周期模块；其函数每次读取标记。
    globalThis.__relocationTestState={flag,url:'http://127.0.0.1:'+server.address().port+'/'};
    fs.writeFileSync(options.prefix+'/platform/dsh-platform','#!/bin/sh\\nprintf "%s\\\\n" "$*" > "'+options.prefix+'/start-args"\\ntouch "'+flag+'"\\n',{mode:0o755});
    try{const result=await relocate({...options,resume:true});console.log(JSON.stringify(result))}finally{server.closeAllConnections();server.close()}
  `
  writeFileSync(join(options.prefix, 'platform/lifecycle.mts'), `import {existsSync} from 'node:fs'; export const managedState=()=>{const s=globalThis.__relocationTestState;return s&&existsSync(s.flag)?{pid:123,host:'127.0.0.1',port:1,url:s.url}:undefined}; export const ownsPort=()=>true`)
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: join(options.prefix, 'test-home') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const report = JSON.parse(result)
  assert.equal(report.status, 'relocated')
  assert.equal(report.resumed, true)
  assert.equal(report.sessionsPreserved, 1)
  assert.equal(readFileSync(join(options.prefix, 'start-args'), 'utf8').trim(), 'start --host 127.0.0.1 --port 18121 --public-url http://public.example/hep/')
})

test('启动后的连接错误保留新数据与平台，按回执继续核对而不回滚', async t => {
  const options = fixture(t)
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const module = fileURLToPath(new URL('../relocate.mts', import.meta.url))
  writeFileSync(join(options.prefix, 'platform/lifecycle.mts'), 'export const managedState=()=>({pid:123,host:"127.0.0.1",port:18121,url:"http://fixture.invalid/"}); export const ownsPort=()=>true')
  writeFileSync(join(options.prefix, 'platform/dsh-platform'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "' + join(options.prefix, 'commands') + '"\n', { mode: 0o755 })
  mkdirSync(join(options.fromDataRoot, '.local/credentials'), { recursive: true })
  writeFileSync(join(options.fromDataRoot, '.local/credentials/admin.json'), JSON.stringify({ username: 'test-user', password: 'test-password' }))
  const code = `
    import {relocate} from ${JSON.stringify(module)};
    let calls=0;
    globalThis.fetch=async()=>{calls++;if(calls===1)return {status:303,headers:{getSetCookie:()=>['test=fixture']}};if(calls===2)return {status:200,json:async()=>({result:{ok:true,value:{items:[{sessionId:'kept',running:false}]}}})};throw new TypeError('fetch failed')};
    try{await relocate(${JSON.stringify(options)})}catch(e){console.log(e.message)}
  `
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: join(options.prefix, 'test-home') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(result, /--resume/)
  assert.equal(realpathSync(options.fromDataRoot), options.dataRoot)
  assert.equal(readFileSync(join(options.prefix, 'commands'), 'utf8'), 'stop\nprepare\nstart\n')
  const { readdirSync } = await import('node:fs')
  const backup = join(options.prefix, '.local/deploy-relocations', readdirSync(join(options.prefix, '.local/deploy-relocations'))[0])
  const receipt = JSON.parse(readFileSync(join(backup, 'receipt.json')))
  assert.equal(receipt.status, 'recovery-required')
  assert.deepEqual(receipt.sessionIds, ['kept'])
  assert.equal(receipt.platform.port, 18121)
})
