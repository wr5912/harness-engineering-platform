import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertCandidateAssets, validateCandidateChanges } from '../src/agents/candidate-assets.ts'
import { assertAssetPath, BOOTSTRAP_ENV } from '../src/tasks/files.ts'

const program = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const template = readFileSync(join(program, 'runtime/adapters/dsh-container/verification-home-controls/locked-bootstrap.env'))
const id = 'EXP-test-agent-027-m-r0123456789ab', prefix = `evolution/experiments/${id}/candidate/`
function fixture(t, sdk = false) {
  process.env.HARNESS_PROGRAM_ROOT = program
  const root = mkdtempSync(join(tmpdir(), 'candidate-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, bytes) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes) }
  write(`evolution/experiments/${id}/change.yaml`, `agent_id: test-agent\nexperiment_id: ${id}\n`)
  write(prefix + 'harness.yaml', `loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: test-agent\n  profile_patch: dsh/managed/patch.yml\n${sdk ? '  profile: sdk\n' : ''}`)
  write(prefix + 'dsh/presets/test-agent/agent.cordis.yml', '- name: test\n')
  write(prefix + 'dsh/managed/patch.yml', '- name: test\n  config: !!js value => value\n')
  write(prefix + BOOTSTRAP_ENV, template)
  return { root, write, file: path => join(root, prefix, path), change: (path, content) => ({ rel: prefix + path, content }) }
}

test('仅注释型规范占位可作为资产，其他环境文件和 LLM 凭据仍被拒绝', t => {
  const fx = fixture(t)
  assert.equal(assertCandidateAssets(fx.root, id).profile, 'web')
  assert.doesNotThrow(() => assertAssetPath(BOOTSTRAP_ENV, template))
  for (const path of ['.env', 'dsh/managed/.env', 'dsh/workspace/.env.local', 'dsh/workspace/key.llm-api-key']) assert.throws(() => assertAssetPath(path, template))
  for (const bytes of [Buffer.alloc(0), Buffer.from('VALUE=x\n'), Buffer.concat([template, Buffer.from('\n')])]) assert.throws(() => assertAssetPath(BOOTSTRAP_ENV, bytes), /逐字节一致/)
})

test('完整输出预检拒绝删除、移动和二进制破坏入口，原树保持不变', t => {
  const fx = fixture(t)
  for (const path of [BOOTSTRAP_ENV, 'harness.yaml', 'dsh/managed/patch.yml', 'dsh/presets/test-agent/agent.cordis.yml']) {
    assert.throws(() => validateCandidateChanges(fx.root, id, [fx.change(path, null)]), /Candidate/)
    assert.throws(() => validateCandidateChanges(fx.root, id, [fx.change(path, null), fx.change(path + '.moved', readFileSync(fx.file(path)))]), /Candidate/)
  }
  assert.throws(() => validateCandidateChanges(fx.root, id, [fx.change('dsh/managed/patch.yml', Buffer.from([0, 255]))]), /Candidate/)
  assertCandidateAssets(fx.root, id)
  rmSync(fx.file(BOOTSTRAP_ENV))
  assert.throws(() => validateCandidateChanges(fx.root, id, [fx.change('new.txt', 'unrelated')]), error => error.details.path === BOOTSTRAP_ENV)
  assert.doesNotThrow(() => validateCandidateChanges(fx.root, id, [fx.change(BOOTSTRAP_ENV, template)]))
})

test('目录、符号链接和 SDK/分析模式分别遵守实际挂载合同', t => {
  const fx = fixture(t)
  rmSync(fx.file(BOOTSTRAP_ENV)); mkdirSync(fx.file(BOOTSTRAP_ENV))
  assert.throws(() => assertCandidateAssets(fx.root, id), /Candidate/)
  rmSync(fx.file(BOOTSTRAP_ENV), { recursive: true }); symlinkSync('/nonexistent/bootstrap', fx.file(BOOTSTRAP_ENV))
  assert.throws(() => assertCandidateAssets(fx.root, id), /Candidate/)
  rmSync(fx.file(BOOTSTRAP_ENV))
  assert.doesNotThrow(() => assertCandidateAssets(fx.root, id, false))
  const sdk = fixture(t, true); rmSync(sdk.file(BOOTSTRAP_ENV))
  assert.equal(assertCandidateAssets(sdk.root, id).profile, 'sdk')
})
