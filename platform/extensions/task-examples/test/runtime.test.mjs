import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply, runTrainingProcess } from '../src/runtime.ts'

function write(root, file, text) { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path }
function temporary(t) { const root = mkdtempSync(join(tmpdir(), 'task-example-runtime-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
function environment(t, values) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
}
function toolContext(config, install = apply, advertisedUrl = 'http://localhost/assistant/') {
  let tool, fetchHandler, guard, preStep
  install({ tools: { register(value) { tool = value }, guard(value) { guard = value } }, on(event, handler) { if (event === 'agent/pre-step') preStep = handler },
    connection: { fetch: { register(value) { fetchHandler = value.fetch } } }, webApp: { getAdvertisedUrl: () => advertisedUrl } }, config)
  const execute = (args, session = 'session-1', signal = new AbortController().signal) => tool.execute(args, { agent: { session: { header: { id: session, agentPreset: config.kind === 'training' ? 'autonomous-training-researcher' : config.kind === 'inspection' ? 'daily-inspection-assistant' : 'multi-step-research-analyst' } } }, signal })
  return { get tool() { return tool }, execute, download: url => fetchHandler(new Request(new URL(url, 'http://localhost'))), guard, preStep }
}
async function http(t, reply) {
  const server = createServer(reply)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('工具提交合法JSON Schema，原生只读限制仅作用于业务Preset，Judge保持独立', () => {
  const ctx = toolContext({ kind: 'inspection' })
  assert.deepEqual(ctx.tool.parameters.required, ['action'])
  assert.equal(ctx.tool.parameters.properties.action.required, undefined)
  let allow
  const subject = { session: { header: { agentPreset: 'daily-inspection-assistant' } }, ctx: { tools: { restrict(value) { allow = value.allow } } } }
  ctx.preStep({ agent: subject }, () => undefined)
  assert.deepEqual(allow, ['task_inspection'])
  assert.match(ctx.guard({ name: 'write', agent: subject }), /只允许/)
  assert.equal(ctx.guard({ name: 'task_inspection', agent: subject }), undefined)
  const judge = { session: { header: { agentPreset: 'harness-eval-judge' } }, ctx: { tools: { restrict() { throw new Error('Judge不应被限制') } } } }
  ctx.preStep({ agent: judge }, () => undefined)
  assert.equal(ctx.guard({ name: 'write', agent: judge }), undefined)
})

test('巡检经实际HTTP读资产，并行分页完整保留；未读完拒交付、报告可回读、其他Session不可改任务', async t => {
  const root = temporary(t); environment(t, { DSH_HOME: root })
  const rows = Array.from({ length: 5 }, (_, index) => ({ asset_id: `asset-000${index + 1}`, hostname: `设备${index + 1}`, asset_type: '基本台账', risk_score: index }))
  const url = await http(t, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(rows)) })
  const ctx = toolContext({ kind: 'inspection', assetUrl: url }), started = await ctx.execute({ action: 'start' })
  await assert.rejects(ctx.execute({ action: 'report', run_id: started.run_id }), /尚未读取全部设备/)
  await Promise.all([0, 2, 4].map(cursor => ctx.execute({ action: 'page', run_id: started.run_id, cursor })))
  const report = await ctx.execute({ action: 'report', run_id: started.run_id })
  assert.equal(report.source_kind, 'basic_mock'); assert.equal(report.device_count, 5); assert.match(report.markdown, /未连接或检测真实设备/)
  assert.equal((await ctx.download(report.download_url)).status, 200)
  assert.equal(await (await ctx.download(report.download_url)).text(), report.markdown)
  assert.equal(await (await ctx.download(report.csv_url)).text(), report.csv)
  await assert.rejects(ctx.execute({ action: 'status', run_id: started.run_id }, 'other-session'), /另一 Session/)
  assert.equal((await ctx.download(`/assistant/api/task-examples/artifact?run_id=${started.run_id}&file=..%2Fstate.json`)).status, 400)
})

test('装配到新智能体时，限制绑定新Preset而不沿用来源身份', () => {
  const ctx = toolContext({ kind: 'inspection', presetId: 'inspection-delivery-demo' })
  let restricted = false
  const agent = { session: { header: { agentPreset: 'inspection-delivery-demo' } }, ctx: { tools: { restrict() { restricted = true } } } }
  ctx.preStep({ agent }, () => undefined)
  assert.equal(restricted, true)
  assert.match(ctx.guard({ name: 'write', agent }), /只允许/)
  assert.equal(ctx.guard({ name: 'task_inspection', agent }), undefined)
})

test('源码及巡检Candidate使用原生公开地址生成产物链接，保留代理前缀并可回读真实文件', async t => {
  environment(t, { DSH_HOME: temporary(t) })
  const rows = Array.from({ length: 5 }, (_, index) => ({ asset_id: `asset-000${index + 1}`, hostname: `设备${index + 1}`, asset_type: '基本台账', risk_score: index }))
  const source = await http(t, (_req, res) => res.end(JSON.stringify(rows)))
  const generated = await import('../../../evolution/experiments/EXP-inspection-delivery-demo-003-r1c42f11c4f9a/candidate/dsh/managed/task-example-tools.mjs')
  for (const install of [apply, generated.apply]) for (const advertisedUrl of ['https://public.example/', 'https://public.example/assistant/', 'https://public.example/hep/business/inspection-delivery-demo/']) {
    const ctx = toolContext({ kind: 'inspection', assetUrl: source }, install, advertisedUrl)
    const started = await ctx.execute({ action: 'start' })
    for (const cursor of [0, 2, 4]) await ctx.execute({ action: 'page', run_id: started.run_id, cursor })
    const report = await ctx.execute({ action: 'report', run_id: started.run_id })
    for (const [field, file, content] of [['download_url', 'report.md', report.markdown], ['csv_url', 'devices.csv', report.csv]]) {
      const url = new URL(report[field])
      assert.equal(url.origin + url.pathname, advertisedUrl + 'api/task-examples/artifact')
      assert.equal(url.searchParams.get('run_id'), started.run_id)
      assert.equal(url.searchParams.get('file'), file)
      const downloaded = await ctx.download(url.href)
      assert.equal(downloaded.status, 200)
      assert.equal(await downloaded.text(), content)
    }
  }
})

test('代码变体仅额外放行明确绑定的工作流工具，原子业务工具仍可调用', () => {
  const ctx = toolContext({ kind: 'inspection', presetId: 'inspection-delivery-demo', workflowTool: 'inspection_code_only' })
  let allowed
  const agent = { session: { header: { agentPreset: 'inspection-delivery-demo' } }, ctx: { tools: { restrict(value) { allowed = value.allow } } } }
  ctx.preStep({ agent }, () => undefined)
  assert.deepEqual(allowed, ['task_inspection', 'inspection_code_only'])
  assert.equal(ctx.guard({ name: 'inspection_code_only', agent }), undefined)
  assert.equal(ctx.guard({ name: 'task_inspection', agent }), undefined)
  assert.match(ctx.guard({ name: 'other_workflow', agent }), /只允许/)
  for (const workflowTool of ['*', '../tool', '', ['inspection_code_only']]) {
    assert.throws(() => toolContext({ kind: 'inspection', workflowTool }), /明确的工具名/)
  }
})

test('巡检上游缺失设备时拒绝造全量报告', async t => {
  environment(t, { DSH_HOME: temporary(t) })
  const url = await http(t, (_req, res) => res.end('[]'))
  await assert.rejects(toolContext({ kind: 'inspection', assetUrl: url }).execute({ action: 'start' }), /范围不完整/)
})

test('资料研究固定首次读取正文，缺少来源时拒交付', async t => {
  environment(t, { DSH_HOME: temporary(t) }); let requests = 0
  const url = await http(t, (_req, res) => { requests++; res.end('实际HTTP资料正文：只讨论任务机制。') })
  const ctx = toolContext({ kind: 'research', sourceUrls: [url + '/one', url + '/two'] }), start = await ctx.execute({ action: 'start' })
  await ctx.execute({ action: 'collect', run_id: start.run_id, source: url + '/one' })
  assert.equal((await ctx.execute({ action: 'collect', run_id: start.run_id, source: url + '/one' })).reused_snapshot, true)
  assert.equal(requests, 1)
  await assert.rejects(ctx.execute({ action: 'report', run_id: start.run_id }), /还有资料未读取/)
  await ctx.execute({ action: 'collect', run_id: start.run_id, source: url + '/two' })
  const summaries = { [url + '/one']: '资料一说明任务机制。', [url + '/two']: '资料二说明任务机制。' }
  for (const comparison of [undefined, '', '   ']) await assert.rejects(ctx.execute({ action: 'report', run_id: start.run_id, summaries, comparison }), /跨来源比较结论/)
  const comparison = '两份资料均描述任务机制，但用途不同；当前平台应借鉴预算内迭代和恢复方式，不据资料声称已验证运行收益。'
  const report = await ctx.execute({ action: 'report', run_id: start.run_id, summaries, comparison })
  assert.equal(report.source_count, 2); assert.match(report.markdown, /读取时间/)
  assert.ok(report.markdown.indexOf(comparison) < report.markdown.indexOf('资料一说明任务机制。'))
  const saved = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'task-example-artifacts', start.run_id, 'state.json'), 'utf8'))
  assert.equal(saved.comparison, comparison); assert.deepEqual(saved.summaries, summaries)
  const resumed = toolContext({ kind: 'research', sourceUrls: [url + '/one', url + '/two'] })
  assert.equal((await resumed.execute({ action: 'status', run_id: start.run_id })).completed, true)
  const content = await (await resumed.download(report.download_url)).text()
  assert.equal(content, report.markdown); assert.equal(createHash('sha256').update(content).digest('hex'), report.report_sha256)
})

function trainingFixture(t) {
  const root = temporary(t), home = join(root, 'home'), dsh = join(root, 'dsh'), bin = join(root, 'bin')
  environment(t, { HOME: home, DSH_HOME: dsh, PATH: `${bin}:${process.env.PATH}` })
  for (const file of ['prepare.py', 'pyproject.toml', 'uv.lock']) write(dsh, 'autoresearch/' + file, '固定测试输入\n')
  write(dsh, 'autoresearch/train.py', '# fixture metric: 1.5\n'); write(dsh, 'autoresearch/upstream-train.fixture', '# fixture metric: 1.5\n')
  for (const file of ['tokenizer/tokenizer.pkl', 'tokenizer/token_bytes.pt', 'data/shard_00000.parquet', 'data/shard_06542.parquet']) write(home, '.cache/autoresearch/' + file, '基本测试夹具\n')
  const runner = '#!' + process.execPath + '\n' + `// 仅模拟外部训练命令边界，不表示真实GPU训练。\nconst fs=require('fs'),path=require('path');const action=path.basename(process.argv[1]),args=process.argv.slice(2);\n` +
    `if(action==='nvidia-smi')console.log('TEST-FIXTURE-GPU');\n` +
    `else if(action==='git'){if(args[0]==='rev-parse')console.log('228791fb499afffb54b46200aca536f79142f117');else if(args[0]==='show')process.stdout.write(fs.readFileSync('upstream-train.fixture'));}\n` +
    `else if(args[0]==='--version')console.log('uv-test-fixture');\n` +
    `else if(args.includes('train.py')){const text=fs.readFileSync('train.py','utf8');if(text.includes('change-fixed'))fs.appendFileSync('prepare.py','夹具变更');if(text.includes('fail')){console.log('partial fixture output');console.error('token=fixture-placeholder');process.exitCode=1}else console.log('val_bpb: '+(/metric: ([0-9.]+)/.exec(text)||[])[1]);}\n`
  for (const command of ['nvidia-smi', 'git', 'uv']) chmodSync(write(root, 'bin/' + command, runner), 0o700)
  return { root, home, dsh, ctx: toolContext({ kind: 'training' }) }
}

test('没有GPU和依赖时真实预检明确拒绝，不能返回训练指标', async t => {
  const root = temporary(t); mkdirSync(join(root, 'empty-bin'))
  environment(t, { DSH_HOME: join(root, 'dsh'), HOME: join(root, 'home'), PATH: join(root, 'empty-bin') })
  const result = await toolContext({ kind: 'training' }).execute({ action: 'baseline' })
  assert.equal(result.ready, false); assert.equal(result.checks.nvidia_gpu, false); assert.equal(result.status, 'training-resource-unavailable')
  assert.equal(result.val_bpb, undefined); assert.equal(result.best, undefined)
})

test('训练真实runtime在外部命令夹具下验证一次基线、三个候选、失败回退和日志；不能重开基线绕预算', async t => {
  const { ctx, dsh } = trainingFixture(t), baseline = await ctx.execute({ action: 'baseline' })
  assert.equal(baseline.attempt.status, 'keep')
  for (const [field, file] of [['results_url', 'results.tsv'], ['best_code_url', 'best-train.py']]) {
    const url = new URL(baseline[field])
    assert.equal(url.origin + url.pathname, 'http://localhost/assistant/api/task-examples/artifact')
    assert.equal(url.searchParams.get('run_id'), baseline.run_id)
    assert.equal(url.searchParams.get('file'), file)
    assert.equal((await ctx.download(url.href)).status, 200)
  }
  await assert.rejects(ctx.execute({ action: 'baseline' }), /已使用一次基线/)
  const first = await ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture metric: 1.2\n' })
  assert.equal(first.attempt.status, 'keep')
  const second = await ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture metric: 1.7\n' })
  assert.equal(second.attempt.status, 'discard'); assert.match(readFileSync(join(dsh, 'autoresearch/train.py'), 'utf8'), /metric: 1.2/)
  const failed = await ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture fail\n' })
  assert.equal(failed.attempt.status, 'failed'); assert.equal(failed.candidates_used, 3)
  assert.match(readFileSync(join(dsh, 'autoresearch/train.py'), 'utf8'), /metric: 1.2/)
  assert.match(readFileSync(join(dsh, 'task-example-artifacts', baseline.run_id, 'attempt-3/stdout.log'), 'utf8'), /partial fixture output/)
  assert.doesNotMatch(readFileSync(join(dsh, 'task-example-artifacts', baseline.run_id, 'attempt-3/stderr.log'), 'utf8'), /fixture-placeholder/)
  await assert.rejects(ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture metric: 0.1\n' }), /最多三次/)
  await assert.rejects(ctx.execute({ action: 'baseline' }), /已使用一次基线/)
})

test('跨attempt数据与固定评估不能重新取摘要放宽；候选篡改固定输入不接受指标', async t => {
  const { ctx, home, dsh } = trainingFixture(t), baseline = await ctx.execute({ action: 'baseline' })
  const file = join(home, '.cache/autoresearch/tokenizer/tokenizer.pkl'), original = readFileSync(file)
  writeFileSync(file, '已改变的夹具')
  await assert.rejects(ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture metric: 1.0\n' }), /与基线不一致/)
  writeFileSync(file, original)
  const result = await ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture change-fixed metric: 1.0\n' })
  assert.equal(result.attempt.status, 'failed'); assert.equal(result.attempt.val_bpb, undefined); assert.equal(result.fixed_inputs_changed, true)
  assert.match(readFileSync(join(dsh, 'autoresearch/train.py'), 'utf8'), /metric: 1.5/)
  await assert.rejects(ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture metric: 0.5\n' }), /状态未确认/)
})

test('训练总时限持续生效，不能在剩余不足时重置', async t => {
  const { ctx, dsh } = trainingFixture(t), baseline = await ctx.execute({ action: 'baseline' })
  const path = join(dsh, 'task-example-artifacts', baseline.run_id, 'state.json'), value = JSON.parse(readFileSync(path, 'utf8'))
  value.created_at = new Date(Date.now() - 60 * 60_000 - 1).toISOString(); writeFileSync(path, JSON.stringify(value))
  await assert.rejects(ctx.execute({ action: 'candidate', run_id: baseline.run_id, train_py: '# fixture metric: 1.0\n' }), /总时限已到/)
})

test('训练执行器timeout与cancel清理子进程组并保留部分输出', async t => {
  const root = temporary(t)
  const code = `const {spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));console.log('started');setInterval(()=>{},1000)`
  for (const cancel of [false, true]) {
    const pidPath = join(root, cancel ? 'cancel.pid' : 'timeout.pid'), controller = new AbortController()
    const timer = cancel ? setTimeout(() => controller.abort(), 300) : undefined
    await assert.rejects(runTrainingProcess(process.execPath, ['-e', code, pidPath], { timeout: cancel ? 5000 : 300, signal: controller.signal }), error => error.code === (cancel ? 'cancelled' : 'timeout') && error.stdout.includes('started'))
    if (timer) clearTimeout(timer)
    const pid = Number(readFileSync(pidPath, 'utf8')); await delay(100)
    let live = false
    try { live = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z' } catch {}
    assert.equal(live, false, `留下子进程 ${pid}`)
  }
})

test('中断恢复保留已消耗候选次数，恢复最佳代码而不重复发起训练', async t => {
  const { ctx, dsh } = trainingFixture(t), baseline = await ctx.execute({ action: 'baseline' })
  const base = join(dsh, 'task-example-artifacts'), path = join(base, baseline.run_id, 'state.json'), value = JSON.parse(readFileSync(path, 'utf8'))
  value.candidates_used = 1
  value.attempts.push({ index: 1, kind: 'candidate', status: 'running', owner_pid: 2147483000, process_id: 2147483000, script_sha256: 'unknown-interrupted-code' })
  writeFileSync(path, JSON.stringify(value)); writeFileSync(join(dsh, 'autoresearch/train.py'), '# interrupted fixture code\n')
  write(base, 'training.lock', JSON.stringify({ run_id: baseline.run_id, owner_pid: 2147483000 }))
  const status = await ctx.execute({ action: 'status', run_id: baseline.run_id })
  assert.equal(status.candidates_used, 1); assert.equal(status.attempts[1].status, 'interrupted'); assert.equal(status.attempts[1].rollback, 'restored')
  assert.match(readFileSync(join(dsh, 'autoresearch/train.py'), 'utf8'), /metric: 1.5/)
  assert.equal(existsSync(join(base, 'training.lock')), false)
  assert.match(readFileSync(join(base, baseline.run_id, 'results.tsv'), 'utf8'), /interrupted/)
  await assert.rejects(ctx.execute({ action: 'baseline' }), /已使用一次基线/)
})

test('共享训练目录的独占锁避免两个Session同时覆盖train.py', async t => {
  const { ctx, dsh } = trainingFixture(t), lock = write(dsh, 'task-example-artifacts/training.lock', JSON.stringify({ run_id: 'other-task', owner_pid: process.pid }))
  await assert.rejects(ctx.execute({ action: 'baseline' }), /工作区已占用/)
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).run_id, 'other-task')
  assert.match(readFileSync(join(dsh, 'autoresearch/train.py'), 'utf8'), /metric: 1.5/)
})


test('调研显式固定资料快照仅只读本地文件并核对摘要，不进行在线回退', async t => {
  const previousCwd = process.cwd(), root = temporary(t)
  environment(t, { DSH_HOME: join(root, 'dsh') }); process.chdir(root); t.after(() => process.chdir(previousCwd))
  const texts = ['固定提交一：自主训练研究，MIT。', '固定提交二：多步骤任务，非商业许可。']
  const documents = texts.map((text, index) => ({ url: `https://example.invalid/fixed-commit-${index}/README.md`, path: `references/source-${index}.md`, sha256: createHash('sha256').update(text).digest('hex') }))
  documents.forEach((document, index) => write(root, document.path, texts[index]))
  const originalFetch = globalThis.fetch; let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('快照模式不应联网') }; t.after(() => { globalThis.fetch = originalFetch })
  const ctx = toolContext({ kind: 'research', sourceDocuments: documents }), start = await ctx.execute({ action: 'start' })
  assert.equal(start.source_kind, 'fixed_public_document_snapshot')
  for (const document of documents) {
    const result = await ctx.execute({ action: 'collect', run_id: start.run_id, source: document.url })
    assert.equal(result.source_kind, 'fixed_public_document_snapshot'); assert.equal(result.sha256, document.sha256)
  }
  const report = await ctx.execute({ action: 'report', run_id: start.run_id, comparison: '前者是需要实际训练环境的研究循环，后者是长任务业务；MIT与非商业许可边界不同，本次只比较固定资料，没有验证项目效果。', summaries: Object.fromEntries(documents.map((document, index) => [document.url, texts[index]])) })
  assert.match(report.markdown, /没有实时访问网站/); assert.equal(report.source_kind, 'fixed_public_document_snapshot'); assert.equal(requests, 0)
  const started = await ctx.execute({ action: 'start' }); write(root, documents[0].path, '已变化正文')
  await assert.rejects(ctx.execute({ action: 'collect', run_id: started.run_id, source: documents[0].url }), /摘要不匹配/)
  assert.equal(requests, 0)
  await assert.rejects(ctx.execute({ action: 'report', run_id: started.run_id, summaries: {} }), /还有资料未读取/)
})

test('资料来源配置不得混用在线与快照，也不允许越出references目录', async t => {
  environment(t, { DSH_HOME: temporary(t) })
  const document = { url: 'https://example.invalid/fixed/README.md', path: 'references/source.md', sha256: '0'.repeat(64) }
  await assert.rejects(toolContext({ kind: 'research', sourceUrls: [document.url], sourceDocuments: [document] }).execute({ action: 'start' }), /不能与在线来源同时配置/)
  await assert.rejects(toolContext({ kind: 'research', sourceDocuments: [{ ...document, path: '../outside.md' }] }).execute({ action: 'start' }), /配置无效/)
})

test('研究Candidate实际生成制品要求比较结论，保存产物仍保留两份真实固定资料依据', async t => {
  const candidate = new URL('../../../evolution/experiments/EXP-multi-step-research-analyst-001-r97fa04b7c613/candidate/dsh/', import.meta.url)
  const generated = await import(new URL('managed/task-example-tools.mjs', candidate))
  const previousCwd = process.cwd(); process.chdir(fileURLToPath(new URL('workspace/', candidate))); t.after(() => process.chdir(previousCwd))
  environment(t, { DSH_HOME: temporary(t) })
  const documents = [
    { url: 'https://raw.githubusercontent.com/karpathy/autoresearch/228791fb499afffb54b46200aca536f79142f117/README.md', path: 'references/autoresearch-readme.md', sha256: '3958fd4195ac2f98ed35c4eaa4f3028a335165ee24945e96426c408d25793a41' },
    { url: 'https://raw.githubusercontent.com/EvovexAI/EvoFlow/d921e63c6a771089db1c514a5dcd4cbc36cf95cf/README.md', path: 'references/evoflow-readme.md', sha256: 'c0695756b1e44eabd15202868c1badde44527170206315bf35bc44c2c428a8bb' },
  ]
  const ctx = toolContext({ kind: 'research', sourceDocuments: documents }, generated.apply)
  assert.equal(ctx.tool.parameters.properties.comparison.type, 'string')
  const start = await ctx.execute({ action: 'start' })
  for (const document of documents) assert.equal((await ctx.execute({ action: 'collect', run_id: start.run_id, source: document.url })).sha256, document.sha256)
  const summaries = { [documents[0].url]: '固定资料描述单GPU训练实验；MIT。', [documents[1].url]: '固定资料描述长任务规划与恢复；PolyForm Noncommercial 1.0.0，商用需书面授权。' }
  await assert.rejects(ctx.execute({ action: 'report', run_id: start.run_id, summaries }), /跨来源比较结论/)
  // 本测试仅验证生成制品的输入、持久化与下载，不把这段人工输入当成模型效果。
  const comparison = '两者分别服务训练实验和长任务业务。当前平台可借鉴固定预算内保留/回退与规划/恢复机制，继续复用DSH；本次未执行训练或验证外部业务效果。'
  const result = await ctx.execute({ action: 'report', run_id: start.run_id, summaries, comparison })
  const downloaded = await (await ctx.download(result.download_url)).text()
  assert.equal(result.source_kind, 'fixed_public_document_snapshot'); assert.equal(downloaded, result.markdown)
  assert.ok(downloaded.indexOf(comparison) < downloaded.indexOf('### 来源 1'))
  for (const document of documents) { assert.ok(downloaded.includes(document.url)); assert.ok(downloaded.includes(document.sha256)) }
})
