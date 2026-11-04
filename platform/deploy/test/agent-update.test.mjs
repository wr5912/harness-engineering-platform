import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyAgentUpdate, prepareAgentUpdate } from '../agent-update.mts'

const hash = text => createHash('sha256').update(text).digest('hex')
function fixture(t, experimentId = 'EXP-test-agent-027-m-r123456789abc') {
  const base = mkdtempSync(join(tmpdir(), 'hep agent update '))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const prefix = join(base, 'program'), dataRoot = join(base, 'remote'), local = join(base, 'local')
  const instance = 'test-instance', agentId = 'test-agent'
  const relative = `evolution/experiments/${experimentId}`, path = 'candidate/dsh/workspace/AGENTS.md'
  for (const root of [dataRoot, local]) { mkdirSync(join(root, relative, 'candidate/dsh/workspace'), { recursive: true }); writeFileSync(join(root, relative, path), root === local ? 'new' : 'old') }
  mkdirSync(join(prefix, '.local'), { recursive: true }); writeFileSync(join(prefix, '.local/installation.json'), '{}')
  mkdirSync(join(dataRoot, '.local/instances', instance), { recursive: true })
  const identity = join(dataRoot, '.local/instances', instance, 'instance.json')
  writeFileSync(identity, JSON.stringify({ agent_id: agentId, source_kind: 'experiment', source_id: `experiment:${experimentId}`, asset_root: dataRoot }))
  const manifest = join(base, 'manifest.json'), input = { agentId, experimentId, instance, files: [{ path, expectedSha256: hash('old') }] }
  writeFileSync(manifest, JSON.stringify(input))
  return { prefix, dataRoot, local, relative, path, identity, manifest, input }
}

test('m/f 与旧 ID 共用更新入口，拒绝错 Agent、缺随机后缀及 VAR', t => {
  for (const id of ['EXP-test-agent-027-m-r123456789abc', 'EXP-test-agent-027-f-r123456789abc', 'EXP-test-agent-027-r123456789abc', 'EXP-test-agent-001']) {
    const f = fixture(t, id), update = prepareAgentUpdate(f.local, f.manifest)
    assert.equal(applyAgentUpdate({ ...f, dryRun: true }, update).status, 'planned')
    for (const invalid of ['EXP-other-027-m-r123456789abc', 'EXP-test-agent-027-m', 'VAR-test-agent-027-r123456789abc']) {
      assert.throws(() => applyAgentUpdate(f, { ...update, experimentId: invalid }), /身份无效/)
    }
  }
})

test('只更新实际差异，保留权限、私有备份与回执；dry-run 和重复执行不写入', t => {
  const f = fixture(t), update = prepareAgentUpdate(f.local, f.manifest), remote = join(f.dataRoot, f.relative, f.path)
  const inode = statSync(remote).ino, mode = statSync(remote).mode & 0o777
  assert.equal(applyAgentUpdate({ ...f, dryRun: true }, update).status, 'planned')
  assert.equal(statSync(remote).ino, inode); assert.equal(existsSync(join(f.prefix, '.local/deploy-agent-updates')), false)
  const result = applyAgentUpdate(f, update)
  assert.equal(result.status, 'updated'); assert.equal(result.activation, 'pending'); assert.equal(result.bytes, 3)
  assert.equal(readFileSync(remote, 'utf8'), 'new'); assert.equal(readFileSync(join(result.backup, '0'), 'utf8'), 'old')
  assert.equal(statSync(result.backup).mode & 0o777, 0o700); assert.equal(statSync(join(result.backup, '0')).mode & 0o777, 0o600)
  assert.equal(statSync(remote).mode & 0o777, mode)
  assert.equal(applyAgentUpdate(f, update).status, 'unchanged')
  assert.equal(readdirSync(join(f.prefix, '.local/deploy-agent-updates')).length, 1)
})

test('版本、摘要、路径和符号链接预检失败时不覆盖任何资产', t => {
  const f = fixture(t), update = prepareAgentUpdate(f.local, f.manifest), remote = join(f.dataRoot, f.relative, f.path)
  assert.throws(() => applyAgentUpdate(f, { ...update, files: [{ ...update.files[0], sha256: hash('wrong') }] }), /摘要不符/)
  writeFileSync(remote, 'parallel change'); assert.throws(() => applyAgentUpdate(f, update), /已变化/)
  assert.equal(readFileSync(remote, 'utf8'), 'parallel change')
  writeFileSync(f.identity, JSON.stringify({ agent_id: 'other' })); assert.throws(() => applyAgentUpdate(f, update), /不符/)
  for (const path of ['../escape', 'candidate/dsh/../escape', 'candidate/dsh/.env.secret', 'candidate/dsh/test.llm-api-key', '.local/instances/foo', '/absolute']) {
    writeFileSync(f.manifest, JSON.stringify({ ...f.input, files: [{ path, expectedSha256: null }] }))
    assert.throws(() => prepareAgentUpdate(f.local, f.manifest), /仅接受/)
  }
  writeFileSync(f.manifest, JSON.stringify({ ...f.input, files: [{ path: 'candidate/dsh/workspace/link', expectedSha256: null }] }))
  symlinkSync('/missing-target', join(f.local, f.relative, 'candidate/dsh/workspace/link'))
  assert.throws(() => prepareAgentUpdate(f.local, f.manifest), /符号链接/)
})

test('写入中失败会恢复已替换文件并保存失败回执', t => {
  const f = fixture(t), long = `candidate/dsh/workspace/${'a'.repeat(245)}`
  for (const root of [f.local, f.dataRoot]) writeFileSync(join(root, f.relative, long), root === f.local ? 'new2' : 'old2')
  writeFileSync(f.manifest, JSON.stringify({ ...f.input, files: [...f.input.files, { path: long, expectedSha256: hash('old2') }] }))
  const update = prepareAgentUpdate(f.local, f.manifest)
  assert.throws(() => applyAgentUpdate(f, update), /已恢复原文件/)
  assert.equal(readFileSync(join(f.dataRoot, f.relative, f.path), 'utf8'), 'old')
  assert.equal(readFileSync(join(f.dataRoot, f.relative, long), 'utf8'), 'old2')
  const receipt = join(f.prefix, '.local/deploy-agent-updates', readdirSync(join(f.prefix, '.local/deploy-agent-updates'))[0], 'receipt.json')
  assert.equal(JSON.parse(readFileSync(receipt)).status, 'rolled-back')
})

test('远端使用安装器 Node 执行工具的相同源码，含空格路径保持准确', t => {
  const f = fixture(t), update = prepareAgentUpdate(f.local, f.manifest)
  const source = readFileSync(new URL('../agent-update.mts', import.meta.url), 'utf8')
  const result = execFileSync(process.execPath, ['--input-type=module-typescript', '-'], {
    input: source + `\nconsole.log(JSON.stringify(applyAgentUpdate(${JSON.stringify({ ...f, dryRun: true })}, ${JSON.stringify(update)})))`, encoding: 'utf8',
  })
  assert.equal(JSON.parse(result).status, 'planned')
})
