import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { dump, load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

const output = mkdtempSync(join(tmpdir(), 'harness-runtime-tests-'))
await build({ entryPoints: { harness: new URL('../src/models/harness-runtime.ts', import.meta.url).pathname, binding: new URL('../src/models/binding-runtime.ts', import.meta.url).pathname }, outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm' })
const { parseHarnessRuntime, projectHarnessPresets, resolveHarnessRuntime } = await import(`file://${join(output, 'harness.mjs')}`)
const { apply } = await import(`file://${join(output, 'binding.mjs')}`)
test.after(() => rmSync(output, { recursive: true, force: true }))
const main = { provider: 'provider-a', model: 'main-model', reasoningEffort: 'high' }
const child = { provider: 'provider-b', model: 'review-model' }
const assets = { workspace: 'dsh/workspace', preset_root: 'dsh/presets', managed_root: 'dsh/managed', preset_id: 'main-role', preset_file: 'main-role/agent.cordis.yml' }
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-runtime-data-')), id = 'EXP-sample-agent-001-r0123456789ab'
  const candidate = join(root, 'evolution/experiments', id, 'candidate')
  function write(path, body) { const file = join(candidate, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body) }
  write('harness.yaml', dump({ loadable_assets: assets, model_bindings: { main, presets: { reviewer: child } }, role_instructions: { 'main-role': 'dsh/workspace/AGENTS.md', reviewer: 'dsh/workspace/roles/reviewer.md' }, ...extra }))
  write('dsh/workspace/AGENTS.md', '主角色正文 {{literal}}')
  write('dsh/workspace/roles/reviewer.md', '只读复核角色')
  write('dsh/presets/main-role/agent.cordis.yml', '- id: scoped\n  name: cordis:group\n  group: true\n  config:\n    - id: review\n      name: "@deepseek-ai/dsh-tool-subagent"\n      config:\n        provider: spawn\n        toolName: review\n        agentPreset: reviewer\n        agentOptions: { provider: old, model: old, reasoningEffort: old, maxTokens: 2048 }\n        modelSelectionSettings: true\n- id: conditional\n  disabled: !!js process.platform === "win32"\n  name: fixture-conditional\n')
  write('dsh/presets/reviewer/agent.cordis.yml', '[]\n')
  writeFileSync(join(dirname(candidate), 'change.yaml'), dump({ agent_id: 'sample-agent', experiment_id: id }))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, candidate, write }
}

test('运行声明严格引用所选Candidate，旧来源不产生新投影，角色与项目路径不越界', t => {
  assert.equal(parseHarnessRuntime(dump({ loadable_assets: assets })), undefined)
  const f = fixture(t)
  assert.equal(resolveHarnessRuntime(f.root, 'sample-agent', f.candidate).main_preset, 'main-role')
  assert.throws(() => resolveHarnessRuntime(f.root, 'other-agent', f.candidate), /Agent 不一致/)
  for (const extra of [{ project_workspace: { path: '../outside' } }, { role_instructions: { reviewer: '/etc/passwd' } }, { model_bindings: { main, presets: { 'main-role': child } } }]) assert.throws(() => parseHarnessRuntime(dump({ loadable_assets: assets, ...extra })))
  f.write('dsh/workspace/linked-target.md', '原始角色')
  symlinkSync(join(f.candidate, 'dsh/workspace/linked-target.md'), join(f.candidate, 'dsh/workspace/linked.md'))
  f.write('harness.yaml', dump({ loadable_assets: assets, role_instructions: { 'main-role': 'dsh/workspace/linked.md' } }))
  assert.throws(() => resolveHarnessRuntime(f.root, 'sample-agent', f.candidate), /符号链接/)
})

test('原生固定Preset委派在分组内投影完整子模型，保留来源与JS表达式', t => {
  const f = fixture(t), runtime = resolveHarnessRuntime(f.root, 'sample-agent', f.candidate)
  const before = readFileSync(join(f.candidate, runtime.preset_files['main-role']), 'utf8'), destination = join(f.root, 'runtime-presets')
  projectHarnessPresets(f.candidate, destination, runtime)
  const projectedText = readFileSync(join(destination, 'main-role/agent.cordis.yml'), 'utf8')
  assert.match(projectedText, /!!js|!<tag:yaml.org,2002:js>/)
  const normalized = projectedText.replace(/!!js|!<tag:yaml.org,2002:js>/g, '')
  const rows = load(normalized), delegation = rows[0].config[0].config
  assert.deepEqual(delegation.agentOptions, { ...child, maxTokens: 2048 })
  assert.equal(delegation.modelSelectionSettings, false)
  assert.deepEqual(rows.find(row => row.id === 'harness-model-binding').config.selection, main)
  assert.match(rows.find(row => row.id === 'harness-model-binding').config.roleFile, /^\/opt\/harness-candidate\/dsh\/workspace\/AGENTS.md$/)
  assert.equal(readFileSync(join(f.candidate, runtime.preset_files['main-role']), 'utf8'), before)
})

test('原生waterfall前置绑定同时校正提示词变量与请求，清除继承推理档位且保持其他参数', async t => {
  const ctx = new Context(); new SystemPrompt(ctx, {})
  t.after(() => ctx.fiber.dispose())
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => ({ ...await next(), variables: { ...assembly.variables, provider: 'old', model: 'old', other: 'retained' } }))
  ctx.on('agent/request', async (request, next) => ({ ...await next(), provider: 'old', model: 'old', reasoningEffort: 'max' }))
  apply(ctx, { presetId: 'reviewer', selection: child })
  const assembly = await ctx.systemPrompt.assemble({})
  assert.equal(assembly.variables.provider, child.provider)
  assert.equal(assembly.variables.model, child.model)
  assert.equal(assembly.variables.other, 'retained')
  const request = await ctx.waterfall('agent/request', { turn: 1, step: 0 }, () => Promise.resolve({ provider: 'initial', model: 'initial', temperature: 0.2 }))
  assert.deepEqual(request, { ...child, temperature: 0.2 })
  assert.deepEqual(child, { provider: 'provider-b', model: 'review-model' })
})

test('Managed 阻塞委派从唯一角色声明投影模型，来源不重复维护路由', t => {
  const f = fixture(t)
  const plugins = [{ id: 'reviewer', name: '/opt/dsh-managed/reviewer.mjs', config: { harnessModelRole: 'reviewer', agentOptions: { maxTokens: 2048 } } }]
  f.write('dsh/presets/main-role/agent.cordis.yml', dump(plugins))
  const source = readFileSync(join(f.candidate, 'dsh/presets/main-role/agent.cordis.yml'), 'utf8')
  for (const [index, selected] of [child, { provider: 'new-provider', model: 'new-reviewer', reasoningEffort: 'high' }].entries()) {
    const runtime = resolveHarnessRuntime(f.root, 'sample-agent', f.candidate)
    runtime.model_bindings.presets.reviewer = selected
    const destination = join(f.root, `projected-${index}`)
    projectHarnessPresets(f.candidate, destination, runtime)
    const projected = load(readFileSync(join(destination, 'main-role/agent.cordis.yml'), 'utf8'))[0].config
    assert.equal(projected.agentPreset, 'reviewer')
    assert.deepEqual(projected.agentOptions, { maxTokens: 2048, ...selected })
    assert.equal(readFileSync(join(f.candidate, 'dsh/presets/main-role/agent.cordis.yml'), 'utf8'), source)
  }
})

test('Managed 委派拒绝未知角色、外部入口、冲突 Preset 和重复路由', t => {
  const f = fixture(t), runtime = resolveHarnessRuntime(f.root, 'sample-agent', f.candidate)
  const inputs = [
    { name: '/opt/dsh-managed/reviewer.mjs', config: { harnessModelRole: 'missing' } },
    { name: '/opt/other/reviewer.mjs', config: { harnessModelRole: 'reviewer' } },
    { name: '/opt/dsh-managed/../reviewer.mjs', config: { harnessModelRole: 'reviewer' } },
    { name: '/opt/dsh-managed/reviewer.mjs', config: { harnessModelRole: 'reviewer', agentPreset: 'main-role' } },
    { name: '/opt/dsh-managed/reviewer.mjs', config: { harnessModelRole: 'reviewer', agentOptions: { provider: 'duplicate' } } },
  ]
  for (const [index, plugin] of inputs.entries()) {
    f.write('dsh/presets/main-role/agent.cordis.yml', dump([{ id: 'reviewer', ...plugin }]))
    assert.throws(() => projectHarnessPresets(f.candidate, join(f.root, `invalid-${index}`), runtime), /harnessModelRole|model_bindings/)
  }
})
