import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { fusionDifference, prepareFusion, resolveFusion, confirmFusion, recoverFusion, fusionOperationStatus } from '../src/agents/fusion-operations.ts'
import { sha256 } from '../src/tasks/files.ts'

const main = 'EXP-test-agent-027-m-r0123456789ab', feature = 'EXP-test-agent-027-f-r123456789abc'
const prefix = id => `evolution/experiments/${id}/candidate`
function write(root, path, content) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); return file }
function git(root, ...args) { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
function commit(root) { git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD') }
function fixture(t, count = 0) {
  const root = mkdtempSync(join(tmpdir(), 'fusion fixture ')); t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@example.invalid')
  write(root, '.gitignore', '.local/\n')
  write(root, `evolution/experiments/${main}/change.yaml`, `experiment_id: ${main}\nagent_id: test-agent\n`)
  write(root, `${prefix(main)}/input.txt`, 'base\n')
  write(root, `${prefix(main)}/merge.txt`, 'one\ntwo\nthree\nfour\nfive\n')
  for (let i = 0; i < count; i++) write(root, `${prefix(main)}/same-${i}.txt`, `same ${i}\n`)
  const base = commit(root)
  cpSync(join(root, prefix(main)), join(root, prefix(feature)), { recursive: true })
  write(root, `evolution/experiments/${feature}/change.yaml`, `experiment_id: ${feature}\nagent_id: test-agent\nparent_experiment_id: ${main}\nparent_ref: git:${base}\n`)
  write(root, `${prefix(feature)}/input.txt`, 'feature\n')
  write(root, `${prefix(feature)}/merge.txt`, 'ONE\ntwo\nthree\nfour\nfive\n')
  const ref = commit(root)
  write(root, `${prefix(main)}/merge.txt`, 'one\ntwo\nthree\nfour\nFIVE\n')
  const request = { agent_id: 'test-agent', parent_experiment_id: feature, parent_ref: `git:${ref}`, target_experiment_id: main }
  return { root, request, base, target: path => join(root, prefix(main), path) }
}
const metadata = async () => `experiment_id: ${main}\nagent_id: test-agent\ncreation: {status: integrating}\n`

test('固定来源＋真实 dirty 目标三方合并：复制、保留、删除、二进制和执行位', async t => {
  const fx = fixture(t)
  write(fx.root, `${prefix(feature)}/new.bin`, Buffer.from([0, 128, 255])); chmodSync(join(fx.root, prefix(feature), 'new.bin'), 0o755)
  write(fx.root, `${prefix(main)}/target.txt`, 'dirty target')
  fx.request.parent_ref = `git:${commit(fx.root)}`
  const before = readFileSync(fx.target('merge.txt'))
  const diff = fusionDifference(fx.root, fx.request)
  assert.equal(diff.base.ref, `git:${fx.base}`)
  assert.equal(diff.files.find(row => row.path === 'merge.txt').kind, 'auto-merged')
  assert.equal(diff.files.find(row => row.path === 'target.txt').kind, 'target-only')
  assert.equal(existsSync(join(fx.root, '.local')), false, 'preview 无持久写入')
  const op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
  assert.deepEqual(readFileSync(fx.target('merge.txt')), before)
  const input = { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, confirmed: true }
  const result = await confirmFusion(fx.root, input, metadata)
  assert.equal(readFileSync(fx.target('merge.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour\nFIVE\n')
  assert.equal(readFileSync(fx.target('target.txt'), 'utf8'), 'dirty target')
  assert.deepEqual(readFileSync(fx.target('new.bin')), Buffer.from([0, 128, 255]))
  assert.ok(statSync(fx.target('new.bin')).mode & 0o111)
  assert.deepEqual(await confirmFusion(fx.root, input, () => { throw new Error('不得重放') }), result)
  assert.equal(fusionOperationStatus(fx.root, op.operation_id).recovery_state, 'applied')
  recoverFusion(fx.root, { ...input, recovery: 'rollback' })
  assert.deepEqual(readFileSync(fx.target('merge.txt')), before)
  assert.equal(existsSync(fx.target('new.bin')), false)
})

test('无祖先不猜测；冲突仅导入同一操作的已知输出，摘要和路径不匹配拒绝', async t => {
  const fx = fixture(t)
  write(fx.root, `evolution/experiments/${feature}/change.yaml`, `experiment_id: ${feature}\nagent_id: test-agent\n`)
  fx.request.parent_ref = `git:${commit(fx.root)}`
  let op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
  assert.equal(op.base.verified, false); assert.equal(op.conflicts.length, 2)
  const input = () => ({ operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, confirmed: true })
  await assert.rejects(() => confirmFusion(fx.root, input(), metadata), /未解决/)
  assert.throws(() => resolveFusion(fx.root, { ...input(), resolutions: [{ path: '../outside', decision: 'delete', reason: 'x' }] }), /路径/)
  const content = 'reviewed\n'
  write(op.bundle_path, 'result/input.txt', content)
  assert.throws(() => resolveFusion(fx.root, { ...input(), resolutions: [{ path: 'input.txt', decision: 'result', expected_result_sha256: '0'.repeat(64), reason: '复核' }] }), /摘要/)
  op = resolveFusion(fx.root, { ...input(), resolutions: [{ path: 'input.txt', decision: 'result', expected_result_sha256: sha256(content), reason: 'BC 复核' }, { path: 'merge.txt', decision: 'target', reason: '保留目标' }] })
  assert.equal(op.conflicts.length, 0)
  await confirmFusion(fx.root, input(), metadata)
  assert.equal(readFileSync(fx.target('input.txt'), 'utf8'), content)
})

test('文件重命名与目标修改冲突显式列出；删除、格式校验失败和目标漂移保留资产', async t => {
  const fx = fixture(t)
  rmSync(join(fx.root, prefix(feature), 'input.txt'))
  write(fx.root, `${prefix(feature)}/renamed.txt`, 'base\n')
  fx.request.parent_ref = `git:${commit(fx.root)}`
  write(fx.root, `${prefix(main)}/input.txt`, 'target edit\n')
  let op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
  assert.equal(op.conflicts.filter(row => row.kind === 'rename-conflict').length, 2)
  op = resolveFusion(fx.root, { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, resolutions: [{ path: 'input.txt', decision: 'delete', reason: '采用新路径' }, { path: 'renamed.txt', decision: 'source', reason: '采用新路径' }] })
  const input = { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, confirmed: true }
  await assert.rejects(() => confirmFusion(fx.root, input, async () => { throw new Error('invalid syntax') }), /syntax/)
  assert.equal(readFileSync(fx.target('input.txt'), 'utf8'), 'target edit\n')
  write(fx.root, `${prefix(main)}/parallel.txt`, 'parallel')
  await assert.rejects(() => confirmFusion(fx.root, input, metadata), /Candidate 已变化/)
  rmSync(fx.target('parallel.txt'))
  await confirmFusion(fx.root, input, metadata)
  assert.equal(existsSync(fx.target('input.txt')), false)
  assert.equal(readFileSync(fx.target('renamed.txt'), 'utf8'), 'base\n')
  write(fx.root, `${prefix(main)}/renamed.txt`, 'parallel')
  assert.throws(() => recoverFusion(fx.root, { ...input, recovery: 'rollback' }), /并行修改/)
  assert.equal(readFileSync(fx.target('renamed.txt'), 'utf8'), 'parallel')
})

test('草稿快照变更、链接与 LLM Key 拒绝写入', async t => {
  const fx = fixture(t)
  let op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
  write(op.bundle_path, 'source/input.txt', 'tampered')
  assert.throws(() => resolveFusion(fx.root, { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, resolutions: [{ path: 'input.txt', decision: 'source', reason: '采用' }] }), /快照/)
  op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
  assert.throws(() => resolveFusion(fx.root, { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, resolutions: [{ path: 'input.txt', decision: 'content', content: `OPENAI_API_KEY=sk-${'x'.repeat(40)}`, reason: 'invalid fixture' }] }), /Key/)
  symlinkSync('/tmp', fx.target('link'))
  assert.throws(() => fusionDifference(fx.root, fx.request), /符号链接/)
})

test('规范 .env 同时进入固定来源与工作树融合，含变量的文件拒绝融合', async t => {
  const fx = fixture(t), path = 'dsh/workspace/.env'
  const template = readFileSync(fileURLToPath(new URL('../../../runtime/adapters/dsh-container/verification-home-controls/locked-bootstrap.env', import.meta.url)))
  process.env.HARNESS_PROGRAM_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
  write(fx.root, `${prefix(feature)}/${path}`, template)
  write(fx.root, `${prefix(main)}/${path}`, template)
  fx.request.parent_ref = `git:${commit(fx.root)}`
  assert.ok(fusionDifference(fx.root, fx.request).files.some(row => row.path === path))
  const op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
  await confirmFusion(fx.root, { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, confirmed: true }, metadata)
  assert.deepEqual(readFileSync(fx.target(path)), template)
  write(fx.root, `${prefix(main)}/${path}`, 'VALUE=x\n')
  assert.throws(() => fusionDifference(fx.root, fx.request), /逐字节一致/)
  write(fx.root, `${prefix(main)}/${path}`, template)
  write(fx.root, `${prefix(feature)}/${path}`, 'VALUE=x\n')
  fx.request.parent_ref = `git:${commit(fx.root)}`
  assert.throws(() => fusionDifference(fx.root, fx.request), /逐字节一致/)
})

test('270 文件机械阶段五次重复：不把复制全文交给模型，记录真实耗时', async t => {
  const samples = []
  for (let n = 0; n < 5; n++) {
    const fx = fixture(t, 268), start = performance.now()
    const diff = fusionDifference(fx.root, fx.request)
    assert.equal(diff.files.length, 270)
    const op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
    await confirmFusion(fx.root, { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, confirmed: true }, metadata)
    samples.push(Math.round(performance.now() - start))
    assert.doesNotMatch(JSON.stringify(op), /ONE\\n|feature\\n/, '工具回执不传复制文件正文')
  }
  samples.sort((a, b) => a - b)
  assert.ok(samples[2] < 30_000, `median=${samples[2]}ms`)
  t.diagnostic(`270 files, five mechanical stages (ms): ${samples.join(', ')}; median=${samples[2]}; model calls=0 (isolated mechanical test)`)
})

test('文件与目录互换、执行位变更，以及删除后回滚', async t => {
  const fx = fixture(t)
  rmSync(join(fx.root, prefix(feature), 'input.txt'))
  write(fx.root, `${prefix(feature)}/input.txt/nested.txt`, 'nested\n')
  chmodSync(join(fx.root, prefix(feature), 'merge.txt'), 0o755)
  fx.request.parent_ref = `git:${commit(fx.root)}`
  let op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
  assert.equal(op.conflicts.length, 2)
  op = resolveFusion(fx.root, { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, resolutions: [{ path: 'input.txt', decision: 'delete', reason: '改为目录' }, { path: 'input.txt/nested.txt', decision: 'source', reason: '采用目录内资产' }] })
  const input = { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, confirmed: true }
  await confirmFusion(fx.root, input, metadata)
  assert.equal(readFileSync(fx.target('input.txt/nested.txt'), 'utf8'), 'nested\n')
  assert.ok(statSync(fx.target('merge.txt')).mode & 0o111)
  recoverFusion(fx.root, { ...input, recovery: 'rollback' })
  assert.equal(readFileSync(fx.target('input.txt'), 'utf8'), 'base\n')
  assert.equal(statSync(fx.target('merge.txt')).mode & 0o111, 0)
})

test('真实子进程中断：混合状态只回滚，全部写入后可补记完成；普通写入失败自动回滚', async t => {
  for (const point of ['first', 'metadata', 'error']) {
    const fx = fixture(t), before = readFileSync(fx.target('merge.txt'), 'utf8')
    chmodSync(join(fx.root, prefix(feature), 'input.txt'), 0o755)
    git(fx.root, 'add', '.'); git(fx.root, 'commit', '-qm', 'source executable')
    fx.request.parent_ref = 'git:' + git(fx.root, 'rev-parse', 'HEAD')
    const op = prepareFusion(fx.root, fx.request, {}, 'snapshot')
    const input = { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256, confirmed: true }
    const script = `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync; let count = 0;
      fs.renameSync = (a, b) => {
        if (b.startsWith(${JSON.stringify(join(fx.root, prefix(main)) + '/')})) {
          count++;
          if (${JSON.stringify(point)} === 'error' && count === 2) throw Object.assign(new Error('fixture failure'), {code:'EIO'});
        }
        rename(a, b);
        if (${JSON.stringify(point)} === 'first' && b.startsWith(${JSON.stringify(join(fx.root, prefix(main)) + '/')}) && count === 1 || ${JSON.stringify(point)} === 'metadata' && b === ${JSON.stringify(join(fx.root, `evolution/experiments/${main}/change.yaml`))}) process.exit(79);
      }; syncBuiltinESMExports();
      const { confirmFusion } = await import(${JSON.stringify(new URL('../src/agents/fusion-operations.ts', import.meta.url).href)});
      try { await confirmFusion(${JSON.stringify(fx.root)}, ${JSON.stringify(input)}, async () => ${JSON.stringify(await metadata())}); }
      catch (e) { if (${JSON.stringify(point)} !== 'error') throw e; }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(result.status, point === 'error' ? 0 : 79, result.stderr)
    const status = fusionOperationStatus(fx.root, op.operation_id)
    assert.equal(status.state, point === 'error' ? 'rolled-back' : 'applying')
    if (point === 'metadata') {
      assert.equal(status.recovery_state, 'applied')
      assert.equal(recoverFusion(fx.root, { ...input, recovery: 'complete' }).state, 'applied')
    } else {
      if (point === 'first') {
        assert.equal(status.recovery_state, 'mixed')
        assert.throws(() => recoverFusion(fx.root, { ...input, recovery: 'complete' }), /全部/)
        recoverFusion(fx.root, { ...input, recovery: 'rollback' })
      }
      assert.equal(readFileSync(fx.target('merge.txt'), 'utf8'), before)
      assert.equal(readFileSync(fx.target('input.txt'), 'utf8'), 'base\n')
      assert.equal(statSync(fx.target('input.txt')).mode & 0o111, 0)
    }
  }
})

test('已迁移身份沿既有迁移映射读取历史共同祖先，不用当前 HEAD 代替', t => {
  const fx = fixture(t), agent = 'security-operations-expert'
  const old = `EXP-${agent}-027-reab20c48f610`, current = `EXP-${agent}-027-m-reab20c48f610`, source = `EXP-${agent}-027-f-r058697202fb8`
  write(fx.root, `evolution/experiments/${old}/change.yaml`, `experiment_id: ${old}\nagent_id: ${agent}\n`)
  write(fx.root, `${prefix(old)}/file.txt`, 'base\n')
  const base = commit(fx.root)
  write(fx.root, `evolution/experiments/${source}/change.yaml`, `experiment_id: ${source}\nagent_id: ${agent}\nparent_experiment_id: ${old}\nparent_ref: git:${base}\n`)
  write(fx.root, `${prefix(source)}/file.txt`, 'source\n')
  const ref = commit(fx.root)
  write(fx.root, `evolution/experiments/${current}/change.yaml`, `experiment_id: ${current}\nagent_id: ${agent}\n`)
  write(fx.root, `${prefix(current)}/file.txt`, 'base\n')
  const diff = fusionDifference(fx.root, { agent_id: agent, parent_experiment_id: source, parent_ref: `git:${ref}`, target_experiment_id: current })
  assert.deepEqual(diff.base, { experiment_id: old, ref: `git:${base}`, verified: true })
  assert.equal(diff.files[0].kind, 'source-only')
})
