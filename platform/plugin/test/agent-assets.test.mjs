import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { load as loadYaml } from 'js-yaml'

const repo = new URL('../../../', import.meta.url).pathname
const plugin = new URL('../', import.meta.url).pathname
const temporaryBuild = mkdtempSync(join(tmpdir(), 'agent-assets-build-'))
for (const entry of ['asset-diff', 'create-agent']) await build({ entryPoints: [join(plugin, `src/agents/${entry}.ts`)], outfile: join(temporaryBuild, `${entry}.mjs`), bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/dsh-client-connection'] })
const { readAssetDiff, readFixedAsset } = await import(`file://${temporaryBuild}/asset-diff.mjs`)
const { createAgent } = await import(`file://${temporaryBuild}/create-agent.mjs`)
const first = 'EXP-first-agent-001-r111111111111', second = 'EXP-first-agent-002-r222222222222'
function write(file, body) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body) }
function git(root, args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim() }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-assets-fixture-'))
  write(join(root, `evolution/experiments/${first}/change.yaml`), `agent_id: first-agent\nbaseline_ref: none:first-experiment\n`)
  write(join(root, `evolution/experiments/${first}/candidate/keep.md`), 'same\n')
  write(join(root, `evolution/experiments/${first}/candidate/change.md`), 'old\n')
  write(join(root, `evolution/experiments/${first}/candidate/remove.md`), 'removed\n')
  git(root, ['init']); git(root, ['config', 'user.name', 'Test']); git(root, ['config', 'user.email', 'test@example.invalid']); git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture'])
  const commit = git(root, ['rev-parse', 'HEAD'])
  write(join(root, `evolution/experiments/${second}/change.yaml`), `agent_id: first-agent\nbaseline_ref: git:${commit}\nparent_experiment_id: ${first}\n`)
  write(join(root, `evolution/experiments/${second}/candidate/keep.md`), 'same\n')
  write(join(root, `evolution/experiments/${second}/candidate/change.md`), 'new\n')
  write(join(root, `evolution/experiments/${second}/candidate/add.md`), 'added\n')
  return { root, commit }
}
function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }

test('固定 Baseline 的增删改和单文件补丁来自实际 Git，比较保持只读', async () => {
  const { root, commit } = fixture()
  try {
    const before = git(root, ['status', '--porcelain'])
    const value = success(await readAssetDiff(root, { experiment_id: second, path: 'change.md' }))
    assert.equal(value.left.source, `git:${commit}`)
    assert.deepEqual(value.summary, { added: 1, removed: 1, modified: 1, unchanged: 1 })
    assert.match(value.selected.diff, /-old\n\+new/)
    assert.equal(git(root, ['status', '--porcelain']), before)
    write(join(root, `evolution/experiments/${first}/candidate/change.md`), 'later working change\n')
    const fixed = success(await readAssetDiff(root, { experiment_id: second, path: 'change.md' }))
    assert.equal(fixed.selected.before, 'old\n')
    const working = success(await readAssetDiff(root, { experiment_id: second, against: first, path: 'change.md' }))
    assert.equal(working.selected.before, 'later working change\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('同 Agent 比较排除环境凭据与依赖，首版空 Baseline 和二进制可说明', async () => {
  const { root } = fixture()
  try {
    write(join(root, `evolution/experiments/${second}/candidate/.env`), 'private-environment')
    write(join(root, `evolution/experiments/${second}/candidate/local.llm-api-key`), 'private')
    write(join(root, `evolution/experiments/${second}/candidate/node_modules/package.js`), 'dependency')
    write(join(root, `evolution/experiments/${second}/candidate/icon.bin`), Buffer.from([0, 1, 2]))
    const value = success(await readAssetDiff(root, { experiment_id: second, against: first, path: 'icon.bin' }))
    assert.equal(value.selected.kind, 'binary')
    assert.equal(value.files.some(file => /\.env|llm-api-key|node_modules/.test(file.path)), false)
    assert.equal(success(await readAssetDiff(root, { experiment_id: first })).summary.added, 3)
    write(join(root, 'evolution/experiments/EXP-other-agent-001-r333333333333/change.yaml'), 'agent_id: other-agent\n')
    assert.equal((await readAssetDiff(root, { experiment_id: second, against: 'EXP-other-agent-001-r333333333333' })).ok, false)
    assert.equal((await readAssetDiff(root, { experiment_id: second, path: '../../outside' })).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('差异预览脱敏、符号链接与取消边界', async () => {
  const { root } = fixture()
  try {
    const secret = ['sk', 'a'.repeat(32)].join('-')
    write(join(root, `evolution/experiments/${second}/candidate/change.md`), `new\nAPI_KEY=${secret}\n`)
    const value = success(await readAssetDiff(root, { experiment_id: second, path: 'change.md' }))
    assert.equal(JSON.stringify(value).includes(secret), false)
    symlinkSync('/etc/passwd', join(root, `evolution/experiments/${second}/candidate/link.txt`))
    assert.equal((await readAssetDiff(root, { experiment_id: second })).error.code, 'path_rejected')
    const signal = AbortSignal.abort()
    assert.equal((await readAssetDiff(root, { experiment_id: second }, signal)).error.code, 'aborted')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('同一资产树在 Git 和目录递归顺序不同时仍具有相同来源摘要', async () => {
  const { root } = fixture()
  try {
    write(join(root, `evolution/experiments/${first}/candidate/a/z.md`), 'nested\n')
    write(join(root, `evolution/experiments/${first}/candidate/a-b.md`), 'sibling\n')
    git(root, ['add', `evolution/experiments/${first}`]); git(root, ['commit', '-m', 'ordered assets'])
    const commit = git(root, ['rev-parse', 'HEAD'])
    write(join(root, `evolution/experiments/${first}/change.yaml`), `agent_id: first-agent\nbaseline_ref: git:${commit}\nparent_experiment_id: ${first}\n`)
    const value = success(await readAssetDiff(root, { experiment_id: first }))
    assert.deepEqual(value.summary, { added: 0, removed: 0, modified: 0, unchanged: 5 })
    assert.equal(value.left.digest, value.right.digest)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('中文与 emoji 按 UTF-8 字节预算完整截断，截断标记依据脱敏后文本', async () => {
  const { root } = fixture()
  try {
    write(join(root, `evolution/experiments/${second}/candidate/change.md`), '中文🙂'.repeat(30000))
    const value = success(await readAssetDiff(root, { experiment_id: second, path: 'change.md' }))
    assert.equal(value.selected.truncated, true)
    assert.ok(Buffer.byteLength(value.selected.after, 'utf8') <= 128 * 1024)
    assert.equal(value.selected.after.includes('\uFFFD'), false)
    assert.ok('中文🙂'.repeat(30000).startsWith(value.selected.after))
    write(join(root, `evolution/experiments/${second}/candidate/large.json`), JSON.stringify({ api_key: '仅用于测试脱敏后的长度'.repeat(10000) }))
    const redacted = success(await readAssetDiff(root, { experiment_id: second, path: 'large.json' }))
    assert.equal(redacted.selected.truncated, false)
    assert.match(redacted.selected.after, /REDACTED/)
    assert.ok(Buffer.byteLength(redacted.selected.after) < 100)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('固定资产读取核对来源身份并保持只读，不受后续工作树变更影响', async () => {
  const { root, commit } = fixture()
  try {
    const payload = { agent_id: 'first-agent', experiment_id: first, ref: `git:${commit}` }
    write(join(root, `evolution/experiments/${first}/candidate/change.md`), 'dirty working tree\n')
    const before = git(root, ['status', '--porcelain'])
    const listing = success(await readFixedAsset(root, payload))
    assert.equal(listing.commit, commit); assert.equal(listing.files.length, 3)
    assert.match(listing.candidate_digest, /^[a-f0-9]{64}$/)
    assert.equal(listing.candidate_digest_basis, 'git-object-path-mode')
    assert.match(listing.notes.join('\n'), /不能与.*candidate_sha256/)
    const value = success(await readFixedAsset(root, { ...payload, path: 'change.md' }))
    assert.equal(value.selected.content, 'old\n'); assert.equal(value.selected.kind, 'text')
    assert.match(value.selected.sha256, /^[a-f0-9]{64}$/)
    assert.equal(value.candidate_digest, listing.candidate_digest)
    assert.equal(git(root, ['status', '--porcelain']), before)
    for (const input of [{ agent_id: 'other-agent' }, { ref: 'HEAD' }, { path: '../change.yaml' }, { path: '/etc/passwd' }, { path: 'a/../change.md' }, { path: 'a\\b' }]) {
      assert.equal((await readFixedAsset(root, { ...payload, ...input })).error.code, 'invalid_request')
    }
    assert.equal((await readFixedAsset(root, { ...payload, path: 'missing.md' })).error.code, 'not_found')
    assert.equal((await readFixedAsset(root, { ...payload, ref: `git:${'f'.repeat(40)}` })).error.code, 'baseline_unavailable')
    assert.equal((await readFixedAsset(root, payload, AbortSignal.abort())).error.code, 'aborted')
    write(join(root, `evolution/experiments/${first}/change.yaml`), 'agent_id: other-agent\n')
    git(root, ['add', '.']); git(root, ['commit', '-m', 'mismatched identity'])
    assert.equal((await readFixedAsset(root, { ...payload, ref: `git:${git(root, ['rev-parse', 'HEAD'])}` })).error.code, 'invalid_request')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('固定资产排除凭据并明确二进制、过大和截断文本，不跟随符号链接', async () => {
  const { root } = fixture()
  try {
    const candidate = join(root, `evolution/experiments/${first}/candidate`)
    const secret = ['sk', 'c'.repeat(32)].join('-')
    for (const path of ['.env', '.env.local', 'local.llm-api-key', 'node_modules/ignored.js']) write(join(candidate, path), 'excluded')
    write(join(candidate, 'token.txt'), `API_KEY=${secret}\n`)
    write(join(candidate, 'binary.bin'), Buffer.from([0, 1, 2]))
    write(join(candidate, 'text.txt'), '中文🙂'.repeat(30000))
    write(join(candidate, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
    git(root, ['add', '.']); git(root, ['commit', '-m', 'bounded assets'])
    const payload = { agent_id: 'first-agent', experiment_id: first, ref: `git:${git(root, ['rev-parse', 'HEAD'])}` }
    const listing = success(await readFixedAsset(root, payload))
    assert.equal(listing.files.some(file => /\.env|llm-api-key|node_modules/.test(file.path)), false)
    assert.equal((await readFixedAsset(root, { ...payload, path: '.env' })).error.code, 'invalid_request')
    assert.equal(JSON.stringify(success(await readFixedAsset(root, { ...payload, path: 'token.txt' }))).includes(secret), false)
    const binary = success(await readFixedAsset(root, { ...payload, path: 'binary.bin' })).selected
    assert.equal(binary.kind, 'binary'); assert.equal(binary.content, null)
    const large = success(await readFixedAsset(root, { ...payload, path: 'large.txt' })).selected
    assert.equal(large.kind, 'oversize'); assert.equal(large.content, null); assert.equal(large.truncated, true)
    const text = success(await readFixedAsset(root, { ...payload, path: 'text.txt' })).selected
    assert.equal(text.kind, 'text'); assert.equal(text.truncated, true)
    assert.ok(Buffer.byteLength(text.content, 'utf8') <= 128 * 1024); assert.equal(text.content.includes('\uFFFD'), false)
    symlinkSync('/etc/passwd', join(candidate, 'link.txt'))
    git(root, ['add', '.']); git(root, ['commit', '-m', 'reject links'])
    assert.equal((await readFixedAsset(root, { ...payload, ref: `git:${git(root, ['rev-parse', 'HEAD'])}` })).error.code, 'path_rejected')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'new-agent-fixture-'))
  process.env.HARNESS_PROGRAM_ROOT = root
  process.env.HARNESS_ASSET_ROOT = root
  const files = ['runtime/adapters/dsh-container/dsh-dev', 'runtime/adapters/dsh-container/source_contract.py', 'runtime/adapters/dsh-container/workspace_paths.py', 'runtime/adapters/dsh-container/scenario_analysis.py',
    'runtime/adapters/dsh-container/source.lock.json', 'runtime/adapters/dsh-container/Dockerfile', 'runtime/adapters/dsh-container/apt-mirror.sh', 'runtime/adapters/dsh-container/build-image.sh', 'runtime/adapters/dsh-container/dsh-cli.sh',
    'runtime/adapters/dsh-container/verification-home-controls/locked-bootstrap.env', 'runtime/adapters/dsh-container/verification-home-controls/web-profile.package.json',
    'runtime/research/validate_experiment.py', 'runtime/research/evaluation_contract.py']
  for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); copyFileSync(join(repo, file), join(root, file)) }
  for (const folder of ['agents', 'evolution/experiments']) mkdirSync(join(root, folder), { recursive: true })
  write(join(root, 'runtime/adapters/dsh-container/sources.json'), JSON.stringify({ schema_version: '1.1', sources: {} }))
  return root
}
const input = { agent_id: 'daily-assistant', name: '日常工作助手', description: '帮助整理日常工作事项。', role: '请根据用户提供的基本事项，整理简明的待办清单；缺少时间时先补问。' }

test('新建向导复用真实 CLI 并保存角色、标准来源与用例，不启动实例', async () => {
  const root = createFixture()
  try {
    const business = { id: 'U-BUSINESS-001', title: '整理事项', inputs: '整理用户给定的两件事项', expected_behavior: '只依据给定信息列出两件事项', fast: true }
    const value = success(await createAgent(root, { ...input, evaluation_cases: [business] }))
    assert.match(value.experiment_id, /^EXP-daily-assistant-001-r[0-9a-f]{12}$/)
    assert.equal(value.started, false)
    const experiment = join(root, 'evolution/experiments', value.experiment_id)
    const role = readFileSync(join(experiment, 'candidate/dsh/workspace/AGENTS.md'), 'utf8')
    assert.match(role, /日常工作助手/); assert.ok(role.includes(input.role)); assert.doesNotMatch(role, /用于验证 DSH Harness/)
    const preset = loadYaml(readFileSync(join(experiment, 'candidate/dsh/presets/daily-assistant/agent.cordis.yml'), 'utf8'))
    assert.ok(preset.find(item => item.id === 'persona').config.prefix.includes(input.name))
    assert.equal(preset.find(item => item.id === 'persona').config.prefix.includes(input.role), false)
    const evaluation = readFileSync(join(root, 'agents/daily-assistant/evaluation.md'), 'utf8')
    assert.match(evaluation, /U-ROLE-001/); assert.match(evaluation, /日常工作助手/)
    for (const id of ['U-IDENTITY-001', 'U-ROLE-001', business.id]) assert.equal(evaluation.split(`#### ${id} `).length - 1, 1)
    assert.ok(evaluation.includes(business.expected_behavior))
    const sources = JSON.parse(readFileSync(join(root, 'runtime/adapters/dsh-container/sources.json'), 'utf8'))
    assert.equal(sources.sources[value.experiment_id].agent_id, input.agent_id)
    assert.deepEqual(sources.sources[value.experiment_id].required_env_names, ['DEEPSEEK_API_KEY'])
    assert.equal(readdirSync(root).some(name => name.startsWith('.platform-agent-create-')), false)
    const again = await createAgent(root, { ...input, role: 'different' })
    assert.equal(again.error.code, 'conflict'); assert.equal(readFileSync(join(experiment, 'candidate/dsh/workspace/AGENTS.md'), 'utf8'), role)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('实际创建入口与任务预检共用Case合同，非法业务Case不落盘', async () => {
  const root = createFixture()
  try {
    const original = readFileSync(join(root, 'runtime/adapters/dsh-container/sources.json'), 'utf8')
    const business = { id: 'U-ASSET-PAGES-001', title: '完整分页', inputs: '读取全部分页', expected_behavior: '覆盖五台模拟设备' }
    const invalidCases = [
      [{ ...business, id: 'U-IDENTITY-001' }], [{ ...business, id: 'U-ROLE-001' }], [business, business],
      [{ ...business, title: '完整分页\n额外标题' }], [{ ...business, expected_behavior: '完整结果\n# 额外标题' }],
      Array.from({ length: 31 }, (_, i) => ({ ...business, id: `U-BUSINESS-${i}` })),
      [{ ...business, inputs: '设备'.repeat(5000) }],
    ]
    for (const evaluation_cases of invalidCases) assert.equal((await createAgent(root, { ...input, evaluation_cases })).error.code, 'invalid_request')
    assert.equal(existsSync(join(root, 'agents', input.agent_id)), false)
    assert.deepEqual(readdirSync(join(root, 'evolution/experiments')), [])
    assert.equal(readFileSync(join(root, 'runtime/adapters/dsh-container/sources.json'), 'utf8'), original)
    assert.equal(readdirSync(root).some(name => name.startsWith('.platform-agent-create-')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('新建失败完整回滚，输入凭据、取消和并发重名不会覆盖资产', async () => {
  const root = createFixture()
  try {
    const original = readFileSync(join(root, 'runtime/adapters/dsh-container/sources.json'), 'utf8')
    assert.equal((await createAgent(root, { ...input, agent_id: '../outside' })).ok, false)
    assert.equal((await createAgent(root, { ...input, role: ['sk', 'b'.repeat(32)].join('-') })).error.code, 'secret_rejected')
    assert.equal((await createAgent(root, input, AbortSignal.abort())).error.code, 'aborted')
    const validator = join(root, 'runtime/research/validate_experiment.py')
    const validScript = readFileSync(validator, 'utf8')
    writeFileSync(validator, 'raise RuntimeError("controlled validation failure")\n')
    assert.equal((await createAgent(root, input)).ok, false)
    assert.equal(existsSync(join(root, 'agents', input.agent_id)), false)
    assert.deepEqual(readdirSync(join(root, 'evolution/experiments')), [])
    assert.equal(readFileSync(join(root, 'runtime/adapters/dsh-container/sources.json'), 'utf8'), original)
    writeFileSync(validator, validScript)
    const results = await Promise.all([createAgent(root, input), createAgent(root, input)])
    assert.equal(results.filter(item => item.ok).length, 1)
    assert.equal(results.filter(item => !item.ok && item.error.code === 'conflict').length, 1)
    assert.equal(Object.keys(JSON.parse(readFileSync(join(root, 'runtime/adapters/dsh-container/sources.json'), 'utf8')).sources).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

process.on('exit', () => rmSync(temporaryBuild, { recursive: true, force: true }))
