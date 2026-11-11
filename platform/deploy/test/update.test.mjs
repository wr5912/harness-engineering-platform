import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { readUpdateActivity, updatePlatform } from '../update.mts'
import { managedState, processBirth, restoreManagedProcess } from '../../lifecycle.mts'
import { createCompositionExecutionStore } from '../../plugin/src/mcp/execution-receipts.ts'

function fixture(t, { target = 'index.js', initialBusy = [], afterBuildBusy = [], failBuild = false, conflict = false, failVerify = false } = {}) {
  const base = resolve('.local/deploy-update-tests'); mkdirSync(base, { recursive: true })
  const programRoot = mkdtempSync(join(base, 'case-')), dataRoot = join(programRoot, 'data')
  t.after(() => rmSync(programRoot, { recursive: true, force: true }))
  const write = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value) }
  write(join(dataRoot, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-update-test', legacyRoots: [] }))
  write(join(programRoot, 'platform/plugin/src/index.ts'), 'source')
  const live = join(programRoot, 'platform/plugin/lib', target); write(live, 'old-code')
  const state = { pid: 123, birth: 'birth', programRoot, dataRoot, url: 'http://127.0.0.1:18120/hep/', host: '127.0.0.1', port: 18120, log: 'log', phase: 'running', detached: true }
  const events = []; let inspections = 0, verifications = 0
  const observation = busy => ({ state, workspaceId: 'workspace-update-test', environment: {}, busy })
  const services = {
    async inspect() { inspections++; return observation(inspections > 1 ? afterBuildBusy : initialBusy) },
    async build(_options, stage) {
      events.push('build')
      if (failBuild) throw Error('fixture build failed')
      const source = join(stage, 'new.js'); write(source, 'new-code')
      if (conflict) write(live, 'parallel-code')
      return [{ source, target: live }]
    },
    async lifecycle(action) { events.push(action) },
    async verify() { verifications++; events.push('verify'); if (failVerify && verifications === 1) throw Error('fixture verification failed'); return observation([]) },
  }
  return { options: { programRoot, dataRoot }, services, events, live, programRoot, get inspections() { return inspections } }
}

test('更新预览只核对，不创建stage、构建、启停或改制品', async t => {
  const f = fixture(t)
  const report = await updatePlatform({ ...f.options, dryRun: true }, f.services)
  assert.equal(report.status, 'planned'); assert.deepEqual(f.events, []); assert.equal(f.inspections, 1)
  assert.equal(existsSync(join(f.programRoot, '.local/platform-updates')), false)
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code')
})

test('已有在途对象时构建核对差异，需要重启则拒绝应用，不取消任务', async t => {
  const busy = [{ kind: 'session', id: 'session-running', state: 'running' }]
  const f = fixture(t, { initialBusy: busy, afterBuildBusy: busy })
  const report = await updatePlatform(f.options, f.services)
  assert.equal(report.status, 'busy'); assert.deepEqual(report.busy, busy); assert.deepEqual(f.events, ['build'])
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code')
  assert.equal(report.activation, 'none')
  const preview = fixture(t, { initialBusy: busy })
  assert.equal((await updatePlatform({ ...preview.options, dryRun: true }, preview.services)).status, 'busy')
  assert.deepEqual(preview.events, [])
})

test('构建后再次发现任务时保留stage和live，不执行停止', async t => {
  const f = fixture(t, { afterBuildBusy: [{ kind: 'sdk', id: 'sdk-1', state: 'starting' }] })
  const report = await updatePlatform(f.options, f.services)
  assert.equal(report.status, 'busy'); assert.ok(existsSync(report.stage)); assert.deepEqual(f.events, ['build'])
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code'); assert.equal(JSON.parse(readFileSync(report.receipt)).status, 'busy')
})

test('明确允许中断会话时重载并保留在途清单，业务任务仍阻止重载', async t => {
  const sessions = [{ kind: 'session', id: 'active', state: 'running' }, { kind: 'assistant', id: 'active', state: 'pending' }]
  const f = fixture(t, { initialBusy: sessions, afterBuildBusy: sessions })
  const report = await updatePlatform({ ...f.options, interruptSessions: true }, f.services)
  assert.equal(report.status, 'applied'); assert.equal(report.activation, 'managed-restart')
  assert.deepEqual(report.busy, sessions); assert.deepEqual(f.events, ['build', 'stop', 'start', 'verify'])
  for (const kind of ['sdk', 'evaluation', 'workflow', 'composition']) {
    const busy = [...sessions, { kind, id: 'business', state: 'running' }]
    const blocked = fixture(t, { initialBusy: busy, afterBuildBusy: busy })
    assert.equal((await updatePlatform({ ...blocked.options, interruptSessions: true }, blocked.services)).status, 'busy')
    assert.deepEqual(blocked.events, ['build']); assert.equal(readFileSync(blocked.live, 'utf8'), 'old-code')
  }
})

test('隔离构建失败不影响运行制品，失败回执和目录保留', async t => {
  const f = fixture(t, { failBuild: true })
  await assert.rejects(updatePlatform(f.options, f.services), /fixture build failed/)
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code'); assert.deepEqual(f.events, ['build'])
  const directory = join(f.programRoot, '.local/platform-updates')
  const stage = readdirSync(directory).find(name => name !== 'update.lock')
  assert.equal(JSON.parse(readFileSync(join(directory, stage, 'receipt.json'))).status, 'failed')
})

test('构建期间并行制品修改保留原样，不被更新覆盖', async t => {
  const f = fixture(t, { conflict: true })
  await assert.rejects(updatePlatform(f.options, f.services), /构建期间变化/)
  assert.equal(readFileSync(f.live, 'utf8'), 'parallel-code'); assert.deepEqual(f.events, ['build'])
})

test('源码或stage在准备期间变化时拒绝应用，不停止平台', async t => {
  const f = fixture(t), build = f.services.build
  f.services.build = async (...args) => { const entries = await build(...args); writeFileSync(join(f.programRoot, 'platform/plugin/src/index.ts'), 'parallel-source'); return entries }
  await assert.rejects(updatePlatform(f.options, f.services), /构建期间变化/)
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code'); assert.deepEqual(f.events, ['build'])
  const stageCase = fixture(t), stageBuild = stageCase.services.build, inspect = stageCase.services.inspect
  let stageSource
  stageCase.services.build = async (...args) => { const entries = await stageBuild(...args); stageSource = entries[0].source; return entries }
  stageCase.services.inspect = async (...args) => { if (stageSource) writeFileSync(stageSource, 'parallel-stage'); return inspect(...args) }
  await assert.rejects(updatePlatform(stageCase.options, stageCase.services), /应用前来源或制品摘要变化/)
  assert.equal(readFileSync(stageCase.live, 'utf8'), 'old-code'); assert.deepEqual(stageCase.events, ['build'])
})

test('仅客户端变化原子应用并核验，保持原PID且不启停', async t => {
  const f = fixture(t, { target: 'client.js' })
  const report = await updatePlatform(f.options, f.services)
  assert.equal(report.status, 'applied'); assert.equal(report.activation, 'native-hmr')
  assert.deepEqual(f.events, ['build', 'verify']); assert.equal(readFileSync(f.live, 'utf8'), 'new-code')
  assert.equal(readFileSync(join(report.stage, 'backup/0'), 'utf8'), 'old-code')
})

test('显式客户端更新保留并行数据扩展与服务端制品，不激活待重载服务端', async t => {
  const busy = [{ kind: 'session', id: 'active', state: 'running' }]
  const f = fixture(t, { target: 'client.js', initialBusy: busy, afterBuildBusy: busy }), build = f.services.build, inspect = f.services.inspect
  const preview = await updatePlatform({ ...f.options, clientOnly: true, dryRun: true }, f.services)
  assert.equal(preview.status, 'planned'); assert.deepEqual(preview.busy, busy); assert.deepEqual(f.events, [])
  const source = join(f.options.dataRoot, 'mcp/src/index.ts'), server = join(f.programRoot, 'platform/plugin/lib/index.js')
  mkdirSync(join(source, '..'), { recursive: true }); writeFileSync(source, 'old-extension'); writeFileSync(server, 'old-server')
  writeFileSync(join(f.options.dataRoot, 'workspace.json'), JSON.stringify({ extensions: [{ path: 'mcp' }] }))
  f.services.inspect = async (...args) => ({ ...await inspect(...args), pendingActivation: true })
  f.services.build = async (...args) => {
    const entries = await build(...args)
    writeFileSync(source, 'parallel-extension'); writeFileSync(server, 'parallel-server')
    return entries
  }
  const report = await updatePlatform({ ...f.options, clientOnly: true }, f.services)
  assert.equal(report.activation, 'native-hmr'); assert.equal(report.pid, 123)
  assert.deepEqual(report.changed, ['platform/plugin/lib/client.js']); assert.deepEqual(f.events, ['build', 'verify'])
  assert.equal(readFileSync(source, 'utf8'), 'parallel-extension'); assert.equal(readFileSync(server, 'utf8'), 'parallel-server')
})

test('显式客户端更新拒绝其他目标，客户端并行冲突仍拒绝应用', async t => {
  const server = fixture(t)
  await assert.rejects(updatePlatform({ ...server.options, clientOnly: true }, server.services), /仅客户端更新包含其他目标/)
  assert.equal(readFileSync(server.live, 'utf8'), 'old-code'); assert.deepEqual(server.events, ['build'])
  const client = fixture(t, { target: 'client.js', conflict: true })
  await assert.rejects(updatePlatform({ ...client.options, clientOnly: true }, client.services), /构建期间变化/)
  assert.equal(readFileSync(client.live, 'utf8'), 'parallel-code'); assert.deepEqual(client.events, ['build'])
})

test('显式客户端更新验证失败时原子回滚，不启停平台', async t => {
  const f = fixture(t, { target: 'client.js', failVerify: true })
  await assert.rejects(updatePlatform({ ...f.options, clientOnly: true }, f.services), /旧制品已恢复并核验/)
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code'); assert.deepEqual(f.events, ['build', 'verify', 'verify'])
})

test('在途会话和任务不阻止无需启停的客户端与SDK worker更新', async t => {
  const busy = [{ kind: 'session', id: 'session-running', state: 'running' }, { kind: 'sdk', id: 'sdk-running', state: 'running' }]
  for (const target of ['client.js', 'sdk-worker.js']) {
    const f = fixture(t, { target, initialBusy: busy, afterBuildBusy: busy })
    const report = await updatePlatform(f.options, f.services)
    assert.equal(report.status, 'applied'); assert.equal(report.pid, 123)
    assert.equal(report.activation, target === 'client.js' ? 'native-hmr' : 'next-sdk-operation')
    assert.deepEqual(report.busy, busy); assert.deepEqual(f.events, ['build', 'verify'])
    assert.equal(readFileSync(f.live, 'utf8'), 'new-code')
  }
})

test('独立SDK worker变化作用于下一次操作，不停止平台', async t => {
  const f = fixture(t, { target: 'sdk-worker.js' })
  const report = await updatePlatform(f.options, f.services)
  assert.equal(report.activation, 'next-sdk-operation'); assert.deepEqual(f.events, ['build', 'verify'])
})

test('服务端变化使用原管理器定向停止启动，再核对在线身份', async t => {
  const f = fixture(t)
  const report = await updatePlatform(f.options, f.services)
  assert.equal(report.activation, 'managed-restart'); assert.deepEqual(f.events, ['build', 'stop', 'start', 'verify'])
  assert.equal(readFileSync(f.live, 'utf8'), 'new-code')
})

test('渲染后的 Profile 模板随程序更新，核验失败一并恢复', async t => {
  for (const failVerify of [false, true]) {
    const f = fixture(t, { failVerify }), build = f.services.build
    const target = join(f.options.dataRoot, '.local/platform-home/profiles/harness-platform/harness-platform.patch.yml')
    mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, 'old-profile')
    f.services.build = async (...args) => {
      const entries = await build(...args), source = join(args[1], 'profile.yml')
      writeFileSync(source, 'new-profile'); return [...entries, { source, target }]
    }
    if (failVerify) await assert.rejects(updatePlatform(f.options, f.services), /旧制品已恢复并核验/)
    else assert.equal((await updatePlatform(f.options, f.services)).activation, 'managed-restart')
    assert.equal(readFileSync(target, 'utf8'), failVerify ? 'old-profile' : 'new-profile')
  }
})

test('原地构建与stage相同但尚未激活时仍定向重载；在途任务阻止重载', async t => {
  for (const busy of [[], [{ kind: 'session', id: 'inflight', state: 'running' }]]) {
    const f = fixture(t, { initialBusy: busy, afterBuildBusy: busy })
    writeFileSync(f.live, 'new-code')
    const inspect = f.services.inspect
    f.services.inspect = async (...args) => ({ ...await inspect(...args), pendingActivation: true })
    const report = await updatePlatform(f.options, f.services)
    assert.deepEqual(report.changed, [])
    assert.equal(report.status, busy.length ? 'busy' : 'applied')
    assert.equal(report.activation, busy.length ? 'none' : 'managed-restart')
    assert.deepEqual(f.events, busy.length ? ['build'] : ['build', 'stop', 'start', 'verify'])
  }
})

test('应用后核验失败恢复旧制品和原启动参数，不改源码或数据', async t => {
  const f = fixture(t, { failVerify: true })
  await assert.rejects(updatePlatform(f.options, f.services), /旧制品已恢复并核验/)
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code')
  assert.equal(readFileSync(join(f.programRoot, 'platform/plugin/src/index.ts'), 'utf8'), 'source')
  assert.deepEqual(f.events, ['build', 'stop', 'start', 'verify', 'stop', 'restore', 'verify'])
})

test('停止命令失败但原进程仍可核验时保持旧制品，不重复启动', async t => {
  const f = fixture(t)
  f.services.lifecycle = async action => { f.events.push(action); throw Error('fixture stop failed') }
  await assert.rejects(updatePlatform(f.options, f.services), /旧制品已恢复并核验/)
  assert.equal(readFileSync(f.live, 'utf8'), 'old-code'); assert.deepEqual(f.events, ['build', 'stop', 'verify'])
})

async function activityFixture(t, responses) {
  const f = fixture(t)
  mkdirSync(join(f.options.dataRoot, '.local/credentials'), { recursive: true })
  writeFileSync(join(f.options.dataRoot, '.local/credentials/admin.json'), JSON.stringify({ username: 'fixture', password: 'fixture' }))
  const requested = []
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.connection, 'close', '启停前后的核验必须使用新连接')
    if (request.url === '/hep/login') {
      const pending = responses.login?.()
      if (pending) { response.writeHead(pending); response.end(); return }
      const name = `dsh-auth-${createHash('sha256').update(request.headers.host).digest('base64url')}`
      response.writeHead(303, { 'set-cookie': [`${name}=fixture; Path=/hep/`, 'harness_platform_session=; Max-Age=0; Path=/'] }); response.end(); return
    }
    assert.match(request.headers.cookie, /^dsh-auth-[A-Za-z0-9_-]+=fixture$/)
    const endpoint = request.url.replace(/^\/hep\/(api|harness-platform)\//, '')
    requested.push(endpoint)
    let value = endpoint === 'inventory' ? { root: f.options.dataRoot, workspace: { id: 'workspace-update-test', root: f.options.dataRoot } } : responses[endpoint]
    if (typeof value === 'function') {
      let body = ''; for await (const chunk of request) body += chunk
      value = await value(JSON.parse(body).payload)
    }
    response.writeHead(value === undefined ? 503 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value === undefined ? {} : { result: { ok: true, value } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const state = { url: `http://127.0.0.1:${server.address().port}/hep/` }
  return { ...f, state, requested }
}

test('启动 bootstrap 尚未装载登录路由时等待装载，错误凭据立即失败', async t => {
  let attempts = 0
  const f = await activityFixture(t, { login: () => ++attempts < 2 ? 404 : undefined,
    'session/list': { items: [] }, 'agents/eval/list': { jobs: [] }, 'agents/sdk/list': [] })
  assert.deepEqual(await readUpdateActivity(f.options, f.state, 'workspace-update-test'), [])
  assert.equal(attempts, 2)
  const denied = await activityFixture(t, { login: () => 401 })
  await assert.rejects(readUpdateActivity(denied.options, denied.state, 'workspace-update-test'), /HTTP 401/)
})

test('在线只读核对覆盖原生会话、管理提案和评测、SDK任务，不从摘要推断空闲', async t => {
  const f = await activityFixture(t, {
    'session/list': { items: [{ sessionId: 'session-active', running: true }, { sessionId: 'assistant-active', running: false, projections: { values: { harnessPlatformAssistant: { workspace_id: 'workspace-update-test', running_proposals: 1, pending_submissions: 0 } } } }] },
    'agents/eval/list': { jobs: [{ job_id: 'eval-active', status: 'cancelling' }] },
    'agents/sdk/list': [{ id: 'sdk-active', status: 'starting' }],
  })
  const busy = await readUpdateActivity(f.options, f.state, 'workspace-update-test')
  assert.deepEqual(busy.map(item => [item.kind, item.id]), [['session', 'session-active'], ['assistant', 'assistant-active'], ['evaluation', 'eval-active'], ['sdk', 'sdk-active']])
  assert.equal(f.requested.includes('assistant/status'), false)
  assert.ok(f.requested.every(endpoint => ['inventory', 'session/list', 'assistant/status', 'agents/eval/list', 'agents/sdk/list'].includes(endpoint)))
})

test('读取失败或状态缺失不被当作空闲', async t => {
  const f = await activityFixture(t, { 'session/list': { items: [] }, 'agents/eval/list': { jobs: [] } })
  await assert.rejects(readUpdateActivity(f.options, f.state, 'workspace-update-test'), /只读核对失败/)
  const malformed = await activityFixture(t, { 'session/list': { items: [] }, 'agents/eval/list': { jobs: [{ job_id: 'broken' }] }, 'agents/sdk/list': [] })
  await assert.rejects(readUpdateActivity(malformed.options, malformed.state, 'workspace-update-test'), /评测运行状态不完整/)
})

test('新版助手在途计数直接取自原生投影，不装载历史管理会话', async t => {
  const sessions = [
    { sessionId: 'idle', running: false, proposals: 0, submissions: 0 },
    { sessionId: 'proposal', running: false, proposals: 1, submissions: 0 },
    { sessionId: 'submission', running: false, proposals: 0, submissions: 1 },
    { sessionId: 'native', running: true, proposals: 0, submissions: 0 },
  ].map(({ proposals, submissions, ...session }) => ({ ...session, projections: { values: { harnessPlatformAssistant: {
    workspace_id: 'workspace-update-test', running_proposals: proposals, pending_submissions: submissions,
  } } } }))
  const f = await activityFixture(t, { 'session/list': { items: sessions }, 'agents/eval/list': { jobs: [] }, 'agents/sdk/list': [] })
  assert.deepEqual((await readUpdateActivity(f.options, f.state, 'workspace-update-test')).map(item => [item.kind, item.id]), [
    ['assistant', 'proposal'], ['assistant', 'submission'], ['session', 'native'],
  ])
  assert.equal(f.requested.includes('assistant/status'), false)
  sessions[0].projections.values.harnessPlatformAssistant.running_proposals = -1
  await assert.rejects(readUpdateActivity(f.options, f.state, 'workspace-update-test'), /缺少在途计数/)
  assert.equal(f.requested.includes('assistant/status'), false)
})

test('明确允许中断会话时不枚举历史，仍核对评测和 SDK 任务并标明未枚举', async t => {
  const f = await activityFixture(t, {
    'agents/eval/list': { jobs: [{ job_id: 'eval-active', status: 'running' }] },
    'agents/sdk/list': [{ id: 'sdk-active', status: 'starting' }],
  })
  assert.deepEqual(await readUpdateActivity({ ...f.options, interruptSessions: true }, f.state, 'workspace-update-test'), [
    { kind: 'session', id: '*', state: 'interruption-authorized-not-enumerated' },
    { kind: 'evaluation', id: 'eval-active', state: 'running' },
    { kind: 'sdk', id: 'sdk-active', state: 'starting' },
  ])
  assert.ok(!f.requested.includes('session/list'))
  assert.ok(!f.requested.includes('assistant/status'))
  const failed = await activityFixture(t, { 'agents/eval/list': { jobs: [] } })
  await assert.rejects(readUpdateActivity({ ...failed.options, interruptSessions: true }, failed.state, 'workspace-update-test'), /只读核对失败/)
})

test('仅客户端更新保留会话且不枚举历史，仍核对工作区和业务任务', async t => {
  const f = await activityFixture(t, {
    'agents/eval/list': { jobs: [{ job_id: 'eval-active', status: 'running' }] },
    'agents/sdk/list': [],
  })
  const busy = await readUpdateActivity({ ...f.options, clientOnly: true }, f.state, 'workspace-update-test')
  assert.deepEqual(busy, [
    { kind: 'session', id: '*', state: 'client-update-preserved-not-enumerated' },
    { kind: 'evaluation', id: 'eval-active', state: 'running' },
  ])
  assert.deepEqual(f.requested, ['inventory', 'agents/eval/list', 'agents/sdk/list'])
  await assert.rejects(readUpdateActivity({ ...f.options, clientOnly: true }, f.state, 'wrong-workspace'), /在线工作区身份不符/)
  const failed = await activityFixture(t, { 'agents/eval/list': { jobs: [] } })
  await assert.rejects(readUpdateActivity({ ...failed.options, clientOnly: true }, failed.state, 'workspace-update-test'), /只读核对失败/)
  const update = fixture(t, { target: 'client.js', afterBuildBusy: busy })
  const report = await updatePlatform({ ...update.options, clientOnly: true }, update.services)
  assert.equal(report.status, 'applied')
  assert.equal(report.activation, 'native-hmr')
  assert.deepEqual(update.events, ['build', 'verify'])
})

test('继承助手投影的子会话只核对原生运行状态，不走普通管理会话路由', async t => {
  const sessions = { items: [{ sessionId: 'child', origin: 'subagent', running: false,
    projections: { values: { harnessPlatformAssistant: { workspace_id: 'workspace-update-test' } } } }] }
  const f = await activityFixture(t, { 'session/list': sessions, 'agents/eval/list': { jobs: [] }, 'agents/sdk/list': [] })
  assert.deepEqual(await readUpdateActivity(f.options, f.state, 'workspace-update-test'), [])
  assert.equal(f.requested.includes('assistant/status'), false)
  sessions.items[0].running = true
  assert.deepEqual(await readUpdateActivity(f.options, f.state, 'workspace-update-test'), [{ kind: 'session', id: 'child', state: 'running' }])
})

test('Run准备中与未知观察均阻止更新，兼容旧评测响应', async t => {
  const f = await activityFixture(t, {
    'session/list': { items: [] },
    'agents/eval/list': { runs: [{ run_id: 'run-created', status: 'completed' }], pending: [{ run_id: 'run-preparing', status: 'preparing' }, { legacy_id: 'old-unknown', status: 'unknown' }], errors: [] },
    'agents/sdk/list': [],
  })
  const busy = await readUpdateActivity(f.options, f.state, 'workspace-update-test')
  assert.deepEqual(busy.map(item => [item.id, item.state]), [['run-preparing', 'preparing'], ['old-unknown', 'unknown']])
})

test('局部损坏的评测控制记录不能被更新器当作空闲', async t => {
  const f = await activityFixture(t, {
    'session/list': { items: [] }, 'agents/sdk/list': [],
    'agents/eval/list': { runs: [], pending: [], errors: [{ path: 'evaluation-jobs/broken.json', message: '无法核对' }] },
  })
  await assert.rejects(readUpdateActivity(f.options, f.state, 'workspace-update-test'), /评测状态存在未核对项/)
  const malformed = await activityFixture(t, {
    'session/list': { items: [] }, 'agents/sdk/list': [],
    'agents/eval/list': { runs: [], pending: [], errors: {} },
  })
  await assert.rejects(readUpdateActivity(malformed.options, malformed.state, 'workspace-update-test'), /在途状态响应不完整/)
})

test('历史证据读取错误只在原任务终态且进程已消失时允许更新，不改写记录', async t => {
  const id = 'f10d4400-ab8b-4cf1-8f27-93660869caf3'
  const f = await activityFixture(t, {
    'session/list': { items: [] }, 'agents/sdk/list': [],
    'agents/eval/list': { runs: [], pending: [], errors: [{ path: `evaluation-jobs/${id}.json`, code: 'run_read_failed' }] },
  })
  const folder = join(f.options.dataRoot, '.local/evaluation-jobs'); mkdirSync(folder, { recursive: true })
  const path = join(folder, `${id}.json`), job = { job_id: id, workspace_id: 'workspace-update-test', asset_root: f.options.dataRoot,
    status: 'failed', pid: 2147483647, process_start: '123' }
  const before = JSON.stringify(job); writeFileSync(path, before)
  assert.deepEqual(await readUpdateActivity(f.options, f.state, 'workspace-update-test'), [])
  assert.equal(readFileSync(path, 'utf8'), before)
  for (const change of [{ status: 'running' }, { workspace_id: 'other' }, { pid: undefined }, { pid: process.pid, process_start: processBirth(process.pid) }]) {
    writeFileSync(path, JSON.stringify({ ...job, ...change }))
    await assert.rejects(readUpdateActivity(f.options, f.state, 'workspace-update-test'), /评测状态存在未核对项/)
  }
})

test('已受理组合阻止更新，完成后可继续；只读核对不重新执行上游', async t => {
  const responses = { 'session/list': { items: [] }, 'agents/eval/list': { jobs: [] }, 'agents/sdk/list': [] }
  const f = await activityFixture(t, responses), store = createCompositionExecutionStore(f.options.dataRoot)
  let release, calls = 0, queries = 0
  const pending = store.execute('composition-pending', { composition_id: 'fixture', version: 'published', revision: 'fixture', input_sha256: 'fixture', config_sha256: 'fixture', implementation_sha256: 'fixture' }, async () => {
    calls++; await new Promise(resolve => { release = resolve }); return { completed: true }
  })
  t.after(() => release())
  responses['mcp/compositionExecution'] = payload => { queries++; return store.read(payload.execution_id) }
  const inspect = f.services.inspect
  f.services.inspect = async options => ({ ...await inspect(options), busy: await readUpdateActivity(options, f.state, 'workspace-update-test') })
  const busy = await updatePlatform(f.options, f.services)
  assert.equal(busy.status, 'busy'); assert.deepEqual(busy.busy, [{ kind: 'composition', id: 'composition-pending', state: 'running' }]); assert.deepEqual(f.events, ['build'])
  assert.equal(calls, 1); assert.equal(queries, 2)
  release(); await pending
  const applied = await updatePlatform(f.options, f.services)
  assert.equal(applied.status, 'applied'); assert.equal(calls, 1); assert.ok(queries >= 3)
  assert.ok(!f.requested.includes('mcp/executeComposition'))
})

test('旧磁盘running以服务器unknown为准，无回执时兼容没有新端点的版本', async t => {
  const responses = { 'session/list': { items: [] }, 'agents/eval/list': { jobs: [] }, 'agents/sdk/list': [] }
  const f = await activityFixture(t, responses)
  assert.deepEqual(await readUpdateActivity(f.options, f.state, 'workspace-update-test'), [])
  const directory = join(f.options.dataRoot, '.local/mcp-composition-executions'); mkdirSync(directory, { recursive: true })
  assert.deepEqual(await readUpdateActivity(f.options, f.state, 'workspace-update-test'), [])
  assert.ok(!f.requested.includes('mcp/compositionExecution'))
  const receipt = { execution_id: 'old-composition', workspace_id: 'workspace-update-test', state: 'running' }
  writeFileSync(join(directory, 'old-composition.json'), JSON.stringify(receipt))
  responses['mcp/compositionExecution'] = payload => ({ ...receipt, execution_id: payload.execution_id, state: 'unknown' })
  assert.deepEqual(await readUpdateActivity(f.options, f.state, 'workspace-update-test'), [])
  assert.equal(JSON.parse(readFileSync(join(directory, 'old-composition.json'), 'utf8')).state, 'running')
})

test('组合回执或只读查询失败时拒绝空闲判断', async t => {
  const responses = { 'session/list': { items: [] }, 'agents/eval/list': { jobs: [] }, 'agents/sdk/list': [] }
  const f = await activityFixture(t, responses), directory = join(f.options.dataRoot, '.local/mcp-composition-executions')
  mkdirSync(directory, { recursive: true }); const file = join(directory, 'composition-broken.json')
  writeFileSync(file, '{')
  await assert.rejects(readUpdateActivity(f.options, f.state, 'workspace-update-test'), /回执无法读取/)
  writeFileSync(file, JSON.stringify({ execution_id: 'composition-broken', workspace_id: 'workspace-update-test', state: 'running' }))
  await assert.rejects(readUpdateActivity(f.options, f.state, 'workspace-update-test'), /只读核对失败：mcp\/compositionExecution/)
  responses['mcp/compositionExecution'] = { execution_id: 'different', workspace_id: 'workspace-update-test', state: 'responded' }
  await assert.rejects(readUpdateActivity(f.options, f.state, 'workspace-update-test'), /组合执行状态不完整/)
})

test('SDK未知状态仍有属于该操作的worker时保留在途状态', async t => {
  const responses = { 'session/list': { items: [] }, 'agents/eval/list': { jobs: [] }, 'agents/sdk/list': [] }
  const f = await activityFixture(t, responses)
  const directory = join(f.options.dataRoot, '.local/sdk-operations/sdk-unknown')
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', directory], { stdio: 'ignore' })
  await once(worker, 'spawn'); t.after(() => worker.kill())
  responses['agents/sdk/list'] = [{ id: 'sdk-unknown', instance_id: 'sdk-fixture', status: 'unknown', worker_pid: worker.pid }]
  const busy = await readUpdateActivity(f.options, f.state, 'workspace-update-test')
  assert.deepEqual(busy, [{ kind: 'sdk', id: 'sdk-unknown', state: 'unknown-live' }])
})

test('受管恢复直接复用原命令、HOME与地址，不依赖当前源码重新渲染Profile', async t => {
  const f = fixture(t), probe = createServer()
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const script = join(f.programRoot, 'previous-runtime.mjs'), service = join(f.options.dataRoot, '.local/platform-service')
  mkdirSync(service, { recursive: true })
  writeFileSync(script, `import {createServer} from 'node:http'; createServer((_q,r)=>{r.end(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,dshHome:process.env.DSH_HOME,args:process.argv.slice(2)}))}).listen(Number(process.env.UPDATE_TEST_PORT),'127.0.0.1')`)
  const patch = join(f.options.dataRoot, '.local/platform-home/profiles/harness-platform/harness-platform.patch.yml')
  const environment = { ...process.env, HARNESS_PROGRAM_ROOT: f.programRoot, HARNESS_ASSET_ROOT: f.options.dataRoot, HOME: join(f.programRoot, 'original-home'), DSH_HOME: join(f.options.dataRoot, '.local/platform-home'), UPDATE_TEST_PORT: String(port) }
  const state = { pid: 123, birth: 'previous-process', programRoot: f.programRoot, dataRoot: f.options.dataRoot, host: '127.0.0.1', port, url: `http://127.0.0.1:${port}/hep/`, log: join(service, 'platform.log'), phase: 'running', detached: true }
  const command = [process.execPath, script, '--profile', 'harness-platform', '--patch', patch]
  const restored = await restoreManagedProcess(state, command, environment)
  t.after(async () => { try { process.kill(-restored.pid, 'SIGTERM') } catch {} for (let i = 0; i < 100 && processBirth(restored.pid) === restored.birth; i++) await delay(20) })
  const response = await fetch(restored.url), runtime = await response.json()
  assert.equal(runtime.cwd, f.options.dataRoot); assert.equal(runtime.home, environment.HOME); assert.equal(runtime.dshHome, environment.DSH_HOME)
  assert.deepEqual(runtime.args, command.slice(2)); assert.equal(managedState(f.options.dataRoot, f.programRoot).pid, restored.pid)
  assert.equal(existsSync(join(service, 'operation.lock')), false)
  await assert.rejects(restoreManagedProcess(state, command, environment), /已有受管进程/)
})
