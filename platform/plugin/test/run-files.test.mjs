import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { unzipSync } from 'fflate'

const plugin = new URL('../', import.meta.url).pathname
const runId = 'run-11111111-1111-4111-8111-111111111111'
const relativeRun = `evolution/experiments/EXP-test-agent-001/runs/${runId}`
const built = mkdtempSync(join(tmpdir(), 'run-files-build-'))
await build({ entryPoints: [join(plugin, 'src/agents/run-files.ts')], outfile: join(built, 'server.mjs'), bundle: true, platform: 'node', format: 'esm' })
const api = await import(`file://${join(built, 'server.mjs')}`)

function write(file, content) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content) }
function fixture(status = 'completed') {
  const root = mkdtempSync(join(tmpdir(), 'run-files-fixture-'))
  const run = join(root, relativeRun)
  write(join(run, 'run.yaml'), `run_id: ${runId}\nstatus: ${status}\n`)
  return { root, run }
}
const hash = data => createHash('sha256').update(data).digest('hex')
const request = (query, signal) => new Request(`http://platform.invalid/api/harness-platform/runs/download?run_id=${runId}&${query}`, { signal })

test('Run 来源目录保留历史格式并仅接受十二位随机后缀', async t => {
  const root = mkdtempSync(join(tmpdir(), 'run-files-names-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const suffix of ['random', 'r0123456789a', 'r0123456789abc', 'r0123456789AB']) {
    write(join(root, `evolution/experiments/EXP-test-agent-002-${suffix}/runs/${runId}/report.md`), '不应被识别。')
  }
  await assert.rejects(() => api.readRunReport(root, runId), error => error.code === 'not_found')
  const valid = `evolution/experiments/EXP-test-agent-002-r0123456789ab/runs/${runId}`
  write(join(root, valid, 'report.md'), '固定随机后缀报告。')
  assert.deepEqual(await api.readRunReport(root, runId), { path: `${valid}/report.md`, content: '固定随机后缀报告。', present: true })
  // 同一 Run 出现在旧编号来源时仍应报告真实冲突，不忽略历史记录。
  write(join(root, relativeRun, 'report.md'), '历史报告。')
  await assert.rejects(() => api.readRunReport(root, runId), error => error.code === 'conflict')
})

test('VAR Run保留真实目录身份并可读取报告与证据', async t => {
  const root = mkdtempSync(join(tmpdir(), 'variant-run-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = `evolution/experiments/VAR-test-agent-001-r123456abcdef/runs/${runId}`
  write(join(root, path, 'report.md'), '变体报告。')
  write(join(root, path, 'run.yaml'), `run_id: ${runId}\nstatus: completed\n`)
  write(join(root, path, 'evidence/U-CASE-001/trace.jsonl'), '{"event":"variant"}\n')
  assert.deepEqual(await api.readRunReport(root, runId), { path: `${path}/report.md`, content: '变体报告。', present: true })
  assert.ok((await api.listRunFiles(root, runId)).files.some(row => row.path.endsWith('trace.jsonl')))
})

test('报告缺失保持可读，动态列出实际归因文件，未封存拒绝完整包', async t => {
  const { root, run } = fixture('running')
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await api.readRunReport(root, runId), { path: `${relativeRun}/report.md`, content: '', present: false })
  write(join(run, 'evidence/analysis/scene-01/attempt-02/trace.jsonl'), '{"event":"repair"}\n')
  const files = await api.listRunFiles(root, runId)
  assert.equal(files.sealed, false)
  assert.ok(files.files.some(row => row.path.endsWith('attempt-02/trace.jsonl')))
  assert.ok(files.coverage.missing.includes('report.md'))
  const response = await api.createRunDownloadHandler(root)(request('kind=archive'))
  assert.equal(response.status, 409)
})

test('完整 ZIP 保留超过 64 KiB 的尾部和所有动态证据，脱敏且源文件不变', async t => {
  const { root, run } = fixture('failed')
  t.after(() => rm(root, { recursive: true, force: true }))
  const large = JSON.stringify({ body: 'x'.repeat(80 * 1024), token: 'fixture-secret', last: '完整尾部' }) + '\n'
  const trace = join(run, 'evidence/U-CASE-001/trace.jsonl')
  write(trace, large)
  write(join(run, 'report.md'), '# 报告\n\nBearer fixture-auth-secret\n')
  write(join(run, 'evidence/analysis/scene-01/attempt-02/checks.json'), '{"trace_available":false,"password":"fixture-password"}\n')
  write(join(run, 'binary.bin'), Buffer.from([0, 1, 2, 255]))
  const preview = await api.previewRunFile(root, runId, `${relativeRun}/evidence/U-CASE-001/trace.jsonl`)
  assert.equal(preview.truncated, true)
  assert.ok(Buffer.byteLength(preview.content) <= 64 * 1024)
  const download = api.createRunDownloadHandler(root)
  const response = await download(request('kind=archive'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
  const exported = Buffer.from(archive[`${runId}/evidence/U-CASE-001/trace.jsonl`]).toString()
  assert.ok(exported.includes('完整尾部'))
  assert.equal(exported.includes('fixture-secret'), false)
  assert.ok(exported.includes('[REDACTED]'))
  assert.deepEqual(Buffer.from(archive[`${runId}/binary.bin`]), Buffer.from([0, 1, 2, 255]))
  assert.ok(archive[`${runId}/evidence/analysis/scene-01/attempt-02/checks.json`])
  const manifest = JSON.parse(Buffer.from(archive['export-manifest.json']).toString())
  const item = manifest.files.find(row => row.path === 'evidence/U-CASE-001/trace.jsonl')
  assert.equal(item.source_sha256, hash(large))
  assert.equal(item.export_sha256, hash(exported))
  assert.equal(item.redacted, true)
  assert.equal(readFileSync(trace, 'utf8'), large)
  assert.ok(!Buffer.from(archive[`${runId}/report.md`]).toString().includes('fixture-auth-secret'))
  const single = await download(request(`kind=file&path=${encodeURIComponent('evidence/U-CASE-001/trace.jsonl')}`))
  assert.equal(single.status, 200)
  assert.ok((await single.text()).includes('完整尾部'))
})

test('路径越界、符号链接、未知 Run 与已取消下载返回明确失败', async t => {
  const { root, run } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  write(join(root, 'outside.txt'), 'outside')
  const download = api.createRunDownloadHandler(root)
  assert.equal((await download(request('kind=file&path=../../../../outside.txt'))).status, 400)
  symlinkSync(join(root, 'outside.txt'), join(run, 'linked.txt'))
  assert.equal((await download(request('kind=file&path=linked.txt'))).status, 400)
  assert.equal((await download(request('kind=archive'))).status, 400)
  await assert.rejects(() => api.listRunFiles(root, runId), /符号链接/)
  const abort = new AbortController(); abort.abort()
  assert.equal((await download(request('kind=archive', abort.signal))).status, 499)
  assert.equal((await download(new Request('http://platform.invalid/?run_id=run-22222222-2222-4222-8222-222222222222&kind=report'))).status, 404)
})

test('采集覆盖区分空轨迹、采集失败与未请求场景归因', async t => {
  const { root, run } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  write(join(run, 'inputs.lock.json'), JSON.stringify({ review_mode: 'none', evaluation_cases: [{ case_id: 'U-CASE-001' }] }))
  write(join(run, 'evidence/U-CASE-001/trace.jsonl'), '')
  let files = await api.listRunFiles(root, runId)
  assert.equal(files.coverage.trace_present, false)
  assert.equal(files.coverage.attribution_status, 'not_requested')
  assert.ok(files.coverage.missing.some(path => path.includes('U-CASE-001/trace.jsonl')))
  write(join(run, 'inputs.lock.json'), '{"review_mode":"ai"}')
  write(join(run, 'evidence/analysis/scene-01/attempt-01/trace.jsonl'), '{"event":"fixture"}\n')
  write(join(run, 'evidence/analysis/scene-01/attempt-01/checks.json'), '{"trace_available":false}')
  files = await api.listRunFiles(root, runId)
  assert.equal(files.coverage.trace_present, false)
  assert.equal(files.coverage.attribution_status, 'missing')
  write(join(run, 'evidence/analysis/scene-01/attempt-01/checks.json'), '{"trace_available":true}')
  files = await api.listRunFiles(root, runId)
  assert.equal(files.coverage.trace_present, true)
  assert.equal(files.coverage.attribution_status, 'collected')
})
