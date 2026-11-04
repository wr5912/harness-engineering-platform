import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { dump } from 'js-yaml'

process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
const built = mkdtempSync(join(tmpdir(), 'compute-assets-module-'))
await build({ stdin: { contents: "export * from './src/agents/compute-assets.ts'; export {createAgentsHandler} from './src/agents/index.ts'; export {sha256,candidateDigest} from './src/tasks/files.ts'", resolveDir: new URL('../', import.meta.url).pathname, loader: 'ts' }, outfile: join(built, 'module.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/dsh-client-connection'] })
const { previewComputeAssets, applyComputeAssets, createAgentsHandler, sha256, candidateDigest } = await import(`file://${join(built, 'module.mjs')}`)
test.after(() => rmSync(built, { recursive: true, force: true }))
const id = 'VAR-alpha-001-r123456abcdef', exp = `evolution/experiments/${id}`, base = `${exp}/candidate`
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'compute-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, text) => { const file = join(root, base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  mkdirSync(join(root, exp), { recursive: true })
  writeFileSync(join(root, exp, 'change.yaml'), dump({ experiment_id: id, agent_id: 'alpha', compute_variant: { generation: { entry_path: 'dsh/managed/compute-workflow/index.ts' } } }))
  put('harness.yaml', 'name: alpha\ncredential_environment_keys: []\nloadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: alpha\n  preset_file: alpha/preset.yml\n  profile_patch: dsh/managed/alpha.patch.yml\n')
  put('dsh/managed/alpha.patch.yml', 'plugin: /opt/dsh-managed/adapter.ts\n')
  put('dsh/presets/alpha/preset.yml', 'preset: alpha\n')
  put('dsh/managed/compute-workflow/index.ts', "import {value} from '../adapter.ts'; export {value}\n")
  put('dsh/managed/adapter.ts', "import {common} from './common/value.ts'; export const value = common; export const mode = 'shared'\n")
  put('dsh/managed/shared/index.ts', 'export const unrelated = 1\n')
  put('dsh/managed/common/value.ts', 'export const common = 1\n')
  put('dsh/managed/common/skill.ts', "export const skillPath = '.agents/skills/required/SKILL.md'\n")
  put('dsh/managed/guide.md', '[适配器](adapter.ts)\n')
  put('dsh/managed/binary.bin', Buffer.from([0xff, 0xfe, 0xfd]))
  put('dsh/workspace/.agents/skills/required/SKILL.md', '# 仍需动态调用的业务能力\n')
  put('dsh/workspace/.agents/skills/replaced/SKILL.md', '# 已由编译流程替代\n')
  const handler = createAgentsHandler(root)
  const rpc = async (endpoint, body) => {
    const result = await handler(endpoint, body, new AbortController().signal)
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value
  }
  const read = path => readFileSync(join(root, base, path), 'utf8')
  const edit = (path, rest = {}) => ({ path, expected_sha256: sha256(read(path)), ...rest })
  const request = { edits: [edit('dsh/managed/adapter.ts', { move_to: 'dsh/managed/compute-workflow/models/adapter.ts' }), edit('dsh/workspace/.agents/skills/replaced/SKILL.md', { content: null })], required_paths: ['dsh/workspace/.agents/skills/required/SKILL.md', 'dsh/managed/common/value.ts'] }
  return { root, put, read, edit, request, rpc, digest: () => candidateDigest(join(root, base)) }
}
test('归拢同步入口、相对公共依赖和Profile引用，删除明确替代的Skill，预览零写入且重复应用幂等', async t => {
  const f = fixture(t), before = f.digest(), preview = previewComputeAssets(f.root, id, f.request)
  assert.equal(f.digest(), before)
  assert.ok(preview.references.some(ref => ref.to === 'dsh/managed/common/value.ts'))
  assert.ok(preview.references.some(ref => ref.to === 'dsh/workspace/.agents/skills/required/SKILL.md'))
  assert.equal((await applyComputeAssets(f.root, preview, preview.preview_sha256, f.rpc)).readback, true)
  assert.match(f.read('dsh/managed/compute-workflow/index.ts'), /\.\/models\/adapter\.ts/)
  assert.match(f.read('dsh/managed/compute-workflow/models/adapter.ts'), /\.\.\/\.\.\/common\/value\.ts/)
  assert.match(f.read('dsh/managed/compute-workflow/models/adapter.ts'), /mode = 'shared'/)
  assert.match(f.read('dsh/managed/alpha.patch.yml'), /\/opt\/dsh-managed\/compute-workflow\/models\/adapter\.ts/)
  assert.match(f.read('dsh/managed/guide.md'), /\]\(\.\/compute-workflow\/models\/adapter\.ts\)/)
  assert.equal(existsSync(join(f.root, base, 'dsh/managed/adapter.ts')), false)
  assert.equal(existsSync(join(f.root, base, 'dsh/workspace/.agents/skills/replaced/SKILL.md')), false)
  assert.ok(f.read('dsh/workspace/.agents/skills/required/SKILL.md'))
  assert.ok(f.read('dsh/managed/common/value.ts'))
  const compiled = await build({ entryPoints: [join(f.root, base, 'dsh/managed/compute-workflow/index.ts')], bundle: true, write: false, platform: 'node', format: 'esm' })
  assert.match(compiled.outputFiles[0].text, /common = 1/)
  const after = f.digest()
  assert.equal((await applyComputeAssets(f.root, preview, preview.preview_sha256, f.rpc)).reused, true)
  assert.equal(f.digest(), after)
})
test('来源变化、目标冲突、越界、仍被引用和动态保留依赖均拒绝且不覆盖', t => {
  const f = fixture(t), before = f.digest()
  assert.throws(() => previewComputeAssets(f.root, id, { ...f.request, edits: [{ ...f.request.edits[0], expected_sha256: '0'.repeat(64) }] }), /来源摘要/)
  assert.throws(() => previewComputeAssets(f.root, id, { ...f.request, edits: [{ ...f.request.edits[0], move_to: 'dsh/managed/compute-workflow/index.ts' }] }), /目标已存在/)
  assert.throws(() => previewComputeAssets(f.root, id, { ...f.request, edits: [{ ...f.request.edits[0], move_to: '../outside.ts' }] }), /路径必须/)
  assert.throws(() => previewComputeAssets(f.root, id, { ...f.request, edits: [f.edit('dsh/managed/common/value.ts', { content: null })], required_paths: [] }), /仍有依赖引用/)
  assert.throws(() => previewComputeAssets(f.root, id, { ...f.request, edits: [f.edit('dsh/workspace/.agents/skills/required/SKILL.md', { content: null })] }), /明确依赖/)
  assert.throws(() => previewComputeAssets(f.root, id, { ...f.request, edits: [f.edit('dsh/workspace/.agents/skills/required/SKILL.md', { content: null })], required_paths: [] }), /仍有依赖引用/)
  assert.throws(() => previewComputeAssets(f.root, id, { ...f.request, edits: [f.edit('dsh/presets/alpha/preset.yml', { content: null })] }), /明确依赖/)
  assert.equal(f.digest(), before)
})
test('实际TS工具入口可在临时工作区预览与应用，不需要平台运行实例', t => {
  const f = fixture(t), cli = new URL('../../../runtime/research/compute-assets.mts', import.meta.url).pathname
  const request = join(f.root, 'request.json'), previewPath = join(f.root, 'preview.json')
  writeFileSync(request, JSON.stringify(f.request))
  const run = (method, file, extra = []) => {
    const result = spawnSync(process.execPath, ['--experimental-transform-types', cli, method, '--asset-root', f.root, '--experiment-id', id, '--request', file, ...extra], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout)
  }
  const digest = f.digest(), preview = run('preview', request)
  assert.equal(f.digest(), digest)
  writeFileSync(previewPath, JSON.stringify(preview))
  assert.equal(run('apply', previewPath, ['--expected-preview-sha256', preview.preview_sha256]).readback, true)
  assert.equal(run('apply', previewPath, ['--expected-preview-sha256', preview.preview_sha256]).reused, true)
})
test('已生成预览遇到并行写入或被篡改时不保存', async t => {
  const f = fixture(t), preview = previewComputeAssets(f.root, id, f.request)
  await assert.rejects(() => applyComputeAssets(f.root, { ...preview, required_paths: [] }, preview.preview_sha256, f.rpc), /预览摘要/)
  f.put('dsh/managed/compute-workflow/models/adapter.ts', '// parallel\n')
  await assert.rejects(() => applyComputeAssets(f.root, preview, preview.preview_sha256, f.rpc), /Candidate 已变化/)
  assert.equal(f.read('dsh/managed/compute-workflow/models/adapter.ts'), '// parallel\n')
  assert.ok(f.read('dsh/managed/adapter.ts'))
})
test('dry期间新增依赖或修改计划时整批拒绝，不覆盖并行内容', async t => {
  for (const target of ['candidate', 'plan']) {
    const f = fixture(t), preview = previewComputeAssets(f.root, id, f.request), before = f.digest()
    const rpc = (endpoint, body) => {
      const pending = f.rpc(endpoint, body)
      if (endpoint === 'edit/apply') {
        if (target === 'candidate') f.put('dsh/managed/parallel.ts', "export const skill = '.agents/skills/replaced/SKILL.md'\n")
        else writeFileSync(join(f.root, exp, 'change.yaml'), readFileSync(join(f.root, exp, 'change.yaml'), 'utf8') + '\n# parallel\n')
      }
      return pending
    }
    await assert.rejects(() => applyComputeAssets(f.root, preview, preview.preview_sha256, rpc), /已变化/)
    assert.ok(f.read('dsh/managed/adapter.ts'))
    assert.ok(f.read('dsh/workspace/.agents/skills/replaced/SKILL.md'))
    if (target === 'candidate') assert.match(f.read('dsh/managed/parallel.ts'), /replaced/)
    else assert.equal(f.digest(), before)
  }
})
test('批次中途写入失败沿现有edit事务恢复移动、删除及引用，可用原预览继续', async t => {
  const f = fixture(t), preview = previewComputeAssets(f.root, id, f.request), before = f.digest()
  const original = fs.renameSync
  fs.renameSync = (from, to) => { if (String(to).endsWith('/dsh/managed/alpha.patch.yml')) throw Error('fixture-write-failure'); return original(from, to) }
  syncBuiltinESMExports()
  try { await assert.rejects(() => applyComputeAssets(f.root, preview, preview.preview_sha256, f.rpc)) }
  finally { fs.renameSync = original; syncBuiltinESMExports() }
  assert.equal(f.digest(), before)
  assert.equal((await applyComputeAssets(f.root, preview, preview.preview_sha256, f.rpc)).readback, true)
})
