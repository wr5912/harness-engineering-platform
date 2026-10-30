import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { dump, load } from 'js-yaml'

process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
process.env.HARNESS_PYTHON ||= '/usr/bin/python3'
const built = mkdtempSync(join(tmpdir(), 'compute-build-freeze-module-'))
await build({ stdin: { contents: "export * from './src/agents/compute-build.ts'; export * from './src/agents/compute-freeze.ts'; export * from './src/tasks/files.ts'; export * from './src/tasks/llm-key.ts'", resolveDir: new URL('../', import.meta.url).pathname, loader: 'ts' }, outfile: join(built, 'module.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createComputeBuildHandler, inspectComputeBuild, createComputeFreezeHandler, candidateDigest, containsLiteralLlmKey } = await import(`file://${join(built, 'module.mjs')}`)
test.after(() => rmSync(built, { recursive: true, force: true }))
const id = 'EXP-alpha-002-r222222222222', exp = `evolution/experiments/${id}`, base = `${exp}/candidate`
const hash = value => createHash('sha256').update(value).digest('hex')
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
function git(root, args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim() }
const block = (id, title, answer = '正常') => `#### ${id} ${title}\n\n**用户输入**\n\n> 查询${title}\n\n**预期**\n\n${answer}\n\n`
const caseHash = (case_id, title, answer = '正常') => hash(JSON.stringify({ case_id, expected_behavior: answer, inputs: [`查询${title}`], title }))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'compute-build-freeze-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'config/sources.json', JSON.stringify({ schema_version: '1.0', sources: { [id]: { agent_id: 'alpha', candidate_root: `${base}/dsh` } } }, null, 2) + '\n')
  write(root, `${base}/harness.yaml`, 'name: alpha\n')
  write(root, `${exp}/change.yaml`, dump({ experiment_id: id, agent_id: 'alpha', compute_variant: { case_hashes: { 'U-ONE-001': caseHash('U-ONE-001', '状态') } } }))
  write(root, `${exp}/hypothesis.md`, '# 研究\n')
  write(root, `${exp}/decision.md`, '# Decision\ninconclusive\n')
  write(root, 'agents/alpha/evaluation.md', '# 评测\n\n## 查询\n\n' + block('U-ONE-001', '状态') + block('U-OTHER-001', '其他'))
  write(root, 'unrelated.txt', '原始内容\n')
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']); git(root, ['add', '.']); git(root, ['commit', '-m', 'initial'])
  return { root, change: () => load(readFileSync(join(root, `${exp}/change.yaml`), 'utf8')) }
}
const source = `import {defineWorkflow, registerWorkflowTool, runWorkflow} from '@harness-platform/workflow-runtime';
export const name='compute-workflow'; export const inject=['tools','llm'];
const workflow=defineWorkflow({id:'asset-alerts',toolName:'query_asset_alerts',description:'查询',inputSchema:{type:'object'},async run(context){return runWorkflow(context,[{id:'asset',run:(_v,c)=>c.callTool('get_asset',c.input)},{id:'alerts',run:(v,c)=>c.callTool('list_alerts',{assetId:v.asset.id})}])}});
export function apply(ctx:any){registerWorkflowTool(ctx,workflow)}\n`
test('VAR身份可独立构建和冻结，保留计划及原始资产身份', async t => {
  const f = fixture(t), variant = 'VAR-alpha-001-r123456abcdef', variantExp = `evolution/experiments/${variant}`, candidate = `${variantExp}/candidate`
  const change = f.change()
  renameSync(join(f.root, exp), join(f.root, variantExp))
  write(f.root, `${variantExp}/change.yaml`, dump({ ...change, experiment_id: variant }))
  write(f.root, `${candidate}/dsh/managed/compute-workflow/index.ts`, source)
  const handler = createComputeBuildHandler(f.root)
  const digest = candidateDigest(join(f.root, candidate))
  const preview = await handler('preview', { experiment_id: variant, expected_candidate_sha256: digest })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const built = await handler('build', { experiment_id: variant, expected_candidate_sha256: digest, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(built.ok, true, JSON.stringify(built))
  assert.equal(built.value.experiment_id, variant)
  const freeze = createComputeFreezeHandler(f.root), frozenPreview = await freeze('preview', { experiment_id: variant })
  assert.equal(frozenPreview.ok, true, JSON.stringify(frozenPreview))
  const frozen = await freeze('freeze', frozenPreview.value.freeze_input)
  assert.equal(frozen.ok, true, JSON.stringify(frozen))
  const fixed = load(git(f.root, ['show', `HEAD:${variantExp}/change.yaml`]))
  assert.equal(fixed.experiment_id, variant)
  assert.deepEqual(fixed.compute_variant.case_hashes, change.compute_variant.case_hashes)
})

test('固定编译不执行Candidate，生成的独立ESM可真实导入并执行LangGraph', async t => {
  const f = fixture(t), handler = createComputeBuildHandler(f.root), path = `${base}/dsh/managed/compute-workflow/index.ts`
  write(f.root, path, source)
  let candidate = candidateDigest(join(f.root, base))
  const preview = await handler('preview', { experiment_id: id, expected_candidate_sha256: candidate })
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(existsSync(join(f.root, path.replace('.ts', '.mjs'))), false)
  const result = await handler('build', { experiment_id: id, expected_candidate_sha256: candidate, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(inspectComputeBuild(f.root, id).verified, true)
  const plugin = await import(`file://${join(f.root, base, result.value.output_path)}`)
  let tool
  plugin.apply({ tools: { register(value) { tool = value }, async execute(input) { return { isError: false, value: input.name === 'get_asset' ? { id: 'asset-1' } : { alerts: ['alert-2'] } } } } })
  const value = await tool.execute({ asset: '真实资产' }, { signal: new AbortController().signal, callId: 'call', token: Symbol(), agent: { session: { id: 'session' } } })
  assert.equal(value.ok, true); assert.equal(value.result.alerts.alerts[0], 'alert-2')
  assert.equal(value.graph_execution.build_digest, result.value.build_digest)
  assert.equal(value.graph_execution.esm_sha256, result.value.esm_sha256)
  write(f.root, path, source + '// 修改源码\n')
  assert.equal(inspectComputeBuild(f.root, id).verified, false)
  const marker = join(f.root, 'candidate-executed')
  write(f.root, path, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'executed');\n` + source)
  assert.equal((await handler('preview', { experiment_id: id })).ok, true)
  assert.equal(existsSync(marker), false)
})
test('TypeScript错误与陈旧预览不得保存制品或回执', async t => {
  const f = fixture(t), handler = createComputeBuildHandler(f.root), path = `${base}/dsh/managed/compute-workflow/index.ts`
  write(f.root, path, 'export const value: number = "bad"\n')
  assert.equal((await handler('preview', { experiment_id: id })).error.code, 'build_failed')
  write(f.root, path, source)
  const candidate = candidateDigest(join(f.root, base)), preview = await handler('preview', { experiment_id: id })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  write(f.root, path, source + '// 并行修改\n')
  assert.equal((await handler('build', { experiment_id: id, expected_candidate_sha256: candidate, expected_preview_sha256: preview.value.preview_sha256 })).error.code, 'conflict')
  assert.equal(existsSync(join(f.root, path.replace('.ts', '.mjs'))), false)
})
test('固定组合绑定可编入独立ESM，原生派发使用稳定alias并拒绝MCP业务错误', async t => {
  const f = fixture(t), handler = createComputeBuildHandler(f.root)
  const binding = { group_id: 'group-test', group_target_digest: 'a'.repeat(64), tool_name: 'mcp__compositions__asset_query',
    compositionId: 'asset-query', versionId: 'b'.repeat(64), expectedImplementationDigest: 'c'.repeat(64), input_schema: { type: 'object' } }
  const text = source.replace("inputSchema:{type:'object'},", `inputSchema:{type:'object'},fixedCompositions:{get_asset:${JSON.stringify(binding)}},`)
  write(f.root, `${base}/dsh/managed/compute-workflow/index.ts`, text)
  const candidate = candidateDigest(join(f.root, base)), preview = await handler('preview', { experiment_id: id })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const built = await handler('build', { experiment_id: id, expected_candidate_sha256: candidate, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(built.ok, true, JSON.stringify(built))
  const plugin = await import(`file://${join(f.root, base, built.value.output_path)}`)
  const registered = new Map(), dispatched = []
  plugin.apply({ tools: { register(value) { registered.set(value.name, value) }, async execute(input) {
    dispatched.push(input.name)
    return { isError: false, value: { isError: true, content: [{ type: 'text', text: '实际MCP业务错误' }] } }
  } } })
  assert.equal([...registered.keys()].filter(name => name.startsWith('hep_fixed_')).length, 1)
  const result = await registered.get('query_asset_alerts').execute({}, { signal: new AbortController().signal, callId: 'outer', token: Symbol(), agent: { session: { id: 'session' } } })
  assert.equal(result.ok, false)
  assert.equal(dispatched.length, 1)
  assert.match(dispatched[0], /^hep_fixed_[0-9a-f]{32}$/)
  assert.equal(result.graph_execution.trace[0].status, 'failed')
  assert.equal(result.graph_execution.build_digest, built.value.build_digest)
})
test('局部冻结保留无关暂存/工作树，只纳入目标来源条目和所选新增Case，不执行hooks', async t => {
  const f = fixture(t), freeze = createComputeFreezeHandler(f.root)
  write(f.root, 'unrelated.txt', '无关暂存\n'); git(f.root, ['add', 'unrelated.txt']); write(f.root, 'unrelated.txt', '无关工作树\n')
  const indexBefore = git(f.root, ['show', ':unrelated.txt'])
  write(f.root, `${base}/new.ts`, 'export const task = true\n')
  const catalog = JSON.parse(readFileSync(join(f.root, 'config/sources.json'))); catalog.sources[id].note = '本任务'; catalog.sources.unrelated = { note: '其他修改' }
  write(f.root, 'config/sources.json', JSON.stringify(catalog, null, 2) + '\n')
  const evaluation = '# 评测\n\n## 查询\n\n' + block('U-ONE-001', '状态') + block('U-OTHER-001', '其他', '无关变化') + '## 资产告警\n\n' + block('U-NEW-001', '新查询')
  write(f.root, 'agents/alpha/evaluation.md', evaluation)
  const change = f.change(); change.compute_variant.case_hashes['U-NEW-001'] = caseHash('U-NEW-001', '新查询'); write(f.root, `${exp}/change.yaml`, dump(change))
  write(f.root, '.git/hooks/pre-commit', '#!/bin/sh\ntouch hook-executed\nexit 1\n')
  chmodSync(join(f.root, '.git/hooks/pre-commit'), 0o755)
  const preview = await freeze('preview', { experiment_id: id })
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.match(preview.value.diff, /新查询/); assert.doesNotMatch(preview.value.diff, /无关变化|其他修改/)
  const result = await freeze('freeze', preview.value.freeze_input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), result.value.commit)
  assert.equal(git(f.root, ['show', ':unrelated.txt']), indexBefore)
  assert.equal(readFileSync(join(f.root, 'unrelated.txt'), 'utf8'), '无关工作树\n')
  const frozenEval = git(f.root, ['show', 'HEAD:agents/alpha/evaluation.md'])
  assert.match(frozenEval, /新查询/); assert.doesNotMatch(frozenEval, /无关变化/)
  assert.equal(readFileSync(join(f.root, 'agents/alpha/evaluation.md'), 'utf8'), evaluation)
  assert.equal(JSON.parse(git(f.root, ['show', 'HEAD:config/sources.json'])).sources.unrelated, undefined)
  assert.equal(existsSync(join(f.root, 'hook-executed')), false)
  assert.equal(git(f.root, ['diff', '--cached', '--name-only']), 'unrelated.txt')
})
test('拒绝目标暂存、陈旧HEAD和他人的index锁，绝不清理别人的锁', async t => {
  const f = fixture(t), freeze = createComputeFreezeHandler(f.root)
  write(f.root, `${base}/harness.yaml`, 'name: staged\n'); git(f.root, ['add', `${base}/harness.yaml`])
  assert.equal((await freeze('preview', { experiment_id: id })).error.code, 'conflict')
  git(f.root, ['restore', '--staged', `${base}/harness.yaml`])
  const preview = await freeze('preview', { experiment_id: id }); assert.equal(preview.ok, true, JSON.stringify(preview))
  write(f.root, '.git/index.lock', 'other-owner')
  assert.equal((await freeze('freeze', preview.value.freeze_input)).error.code, 'conflict')
  assert.equal(readFileSync(join(f.root, '.git/index.lock'), 'utf8'), 'other-owner')
  rmSync(join(f.root, '.git/index.lock'))
  git(f.root, ['commit', '--allow-empty', '-m', 'parallel commit'])
  assert.equal((await freeze('freeze', preview.value.freeze_input)).error.code, 'conflict')
})
test('研究资料随目标冻结并可恢复，监督数据不进入Candidate且运行记录与其他对象不入提交', async t => {
  const f = fixture(t), freeze = createComputeFreezeHandler(f.root)
  const archive = `${exp}/evaluation/evidence/kev-training/train.jsonl`, report = `${exp}/evaluation/observations.md`
  write(f.root, archive, '{"state":"输入","label":"query"}\n')
  write(f.root, report, '# 观察\n本轮功能验证\n')
  write(f.root, `${exp}/runs/run-current/evidence.json`, '{"observed":true}\n')
  write(f.root, `${exp}/evaluation/cache/transient.txt`, '临时状态\n')
  write(f.root, 'evolution/experiments/EXP-other-001/evaluation/report.json', '{"other":true}\n')
  write(f.root, 'unrelated.txt', '无关暂存\n'); git(f.root, ['add', 'unrelated.txt']); write(f.root, 'unrelated.txt', '无关工作树\n')
  const indexBefore = git(f.root, ['show', ':unrelated.txt'])
  const preview = await freeze('preview', { experiment_id: id })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.value.files.find(item => item.path === archive)?.sha256, hash(readFileSync(join(f.root, archive))))
  assert.ok(preview.value.files.some(item => item.path === report))
  assert.equal(preview.value.files.some(item => /\/runs\/|\/cache\/|EXP-other/.test(item.path)), false)
  assert.equal((await freeze('freeze', preview.value.freeze_input)).ok, true)
  assert.equal(git(f.root, ['show', `HEAD:${archive}`]), '{"state":"输入","label":"query"}')
  assert.match(git(f.root, ['show', `HEAD:${report}`]), /功能验证/)
  const committed = git(f.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
  assert.doesNotMatch(committed, /\/runs\/|\/cache\/|EXP-other|unrelated\.txt/)
  assert.equal(git(f.root, ['show', ':unrelated.txt']), indexBefore)
  assert.equal(readFileSync(join(f.root, 'unrelated.txt'), 'utf8'), '无关工作树\n')
  assert.equal(existsSync(join(f.root, base, 'train.jsonl')), false)
})
test('评估归档变化会使旧冻结预览失效，不移动HEAD或污染索引', async t => {
  const f = fixture(t), freeze = createComputeFreezeHandler(f.root), archive = `${exp}/evaluation/evidence/report.json`
  write(f.root, archive, '{"accuracy":0.5}\n')
  const head = git(f.root, ['rev-parse', 'HEAD']), preview = await freeze('preview', { experiment_id: id })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  write(f.root, archive, '{"accuracy":0.25}\n')
  const result = await freeze('freeze', preview.value.freeze_input)
  assert.equal(result.ok, false); assert.equal(result.error.code, 'conflict')
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), head)
  assert.equal(git(f.root, ['diff', '--cached', '--name-only']), '')
  assert.equal(readFileSync(join(f.root, archive), 'utf8'), '{"accuracy":0.25}\n')
})
test('共同基准可显式选真实Case批量冻结240个文件，无须伪造算力计划', { timeout: 45_000 }, async t => {
  const f = fixture(t), freeze = createComputeFreezeHandler(f.root), change = f.change()
  delete change.compute_variant
  write(f.root, `${exp}/change.yaml`, dump(change))
  write(f.root, `${base}/harness.yaml`, 'name: bootstrap-baseline\n')
  for (let index = 0; index < 240; index++) write(f.root, `${base}/dsh/managed/fixtures/${index}.txt`, `资产 ${index}\n`)
  assert.equal((await freeze('preview', { experiment_id: id })).error.code, 'invalid_request')
  const preview = await freeze('preview', { experiment_id: id, case_ids: ['U-ONE-001'] })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.ok(preview.value.files.length >= 240)
  assert.equal(preview.value.case_hashes['U-ONE-001'], caseHash('U-ONE-001', '状态'))
  const result = await freeze('freeze', preview.value.freeze_input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(load(git(f.root, ['show', `HEAD:${exp}/change.yaml`])).compute_variant, undefined)
  assert.equal(git(f.root, ['status', '--porcelain']), '')
})
test('合法环境引用能冻结，LLM API Key常量拒绝且不输出值', async t => {
  const f = fixture(t), freeze = createComputeFreezeHandler(f.root)
  const path = `${base}/dsh/managed/check.sh`
  write(f.root, path, 'export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"\nLOCAL_LLM_API_KEY=$LOCAL_LLM_API_KEY\n')
  write(f.root, `${base}/model.ts`, 'const config = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };\n')
  const preview = await freeze('preview', { experiment_id: id })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal((await freeze('freeze', preview.value.freeze_input)).ok, true)
  const literal = 'fixture-llm-secret-value'
  write(f.root, path, `export DEEPSEEK_API_KEY="${literal}"\n`)
  const rejected = await freeze('preview', { experiment_id: id })
  assert.equal(rejected.error.code, 'secret_rejected')
  assert.equal(JSON.stringify(rejected).includes(literal), false)
  assert.equal(containsLiteralLlmKey('notes.md', 'LOCAL_LLM_API_KEY=sk-secret'), true)
  assert.equal(containsLiteralLlmKey('config.json', JSON.stringify({ OPENAI_API_KEY: literal })), true)
  assert.equal(containsLiteralLlmKey('config.yaml', 'OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY'), false)
  assert.equal(containsLiteralLlmKey('local.llm-api-key', '{}'), true)
})
