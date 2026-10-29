import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { fixture, write, command } from '../../deploy/test/agent-fixture.mjs'
import { pdfBytes } from './document-fixtures.mjs'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))

function runWorker(worker, command, input) {
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { cwd: dirname(worker), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const progress = [], output = []
    let result, error
    child.stdout.on('data', bytes => output.push(bytes.toString()))
    child.stderr.on('data', bytes => output.push(bytes.toString()))
    const timeout = setTimeout(() => { child.kill('SIGKILL'); error = new Error('真实构建导出进程未按时完成') }, 20000)
    child.on('message', message => {
      if (message.type === 'progress') progress.push(message.progress)
      else if (message.type === 'result') result = message.result
      else if (message.type === 'error') error = new Error(message.message)
    })
    child.once('error', failure => { clearTimeout(timeout); reject(failure) })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (error) reject(error)
      else if (code !== 0 || result === undefined) reject(new Error(`真实构建导出进程退出：${code}\n${output.join('')}`))
      else resolve({ result, progress, output: output.join('') })
    })
    child.send({ type: 'run', command, input })
  })
}

test('真实构建的导出 Worker 移动位置后通过 IPC 预览和离线打包，资源按显式程序根装配', async t => {
  const artifact = join(pluginRoot, 'lib/agent-deployment-worker.js')
  assert.ok(existsSync(artifact), '请先运行 platform/plugin 的 pnpm build，测试直接使用其真实 Worker 制品')
  const f = fixture(t), relocated = join(f.root, 'relocated-worker')
  mkdirSync(relocated)
  write(join(relocated, 'package.json'), '{"type":"module"}\n')
  symlinkSync(join(pluginRoot, 'node_modules'), join(relocated, 'node_modules'), 'dir')
  const worker = join(relocated, 'agent-deployment-worker.js')
  copyFileSync(artifact, worker)
  copyFileSync(join(pluginRoot, 'lib/document-parser-worker.js'), join(relocated, 'document-parser-worker.js'))
  const reference = 'https://docs.example.test/reference/guide.pdf'
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), `# 已保存业务\n\n[运行规则](${reference})\n`)
  write(join(f.candidate, 'dsh/workspace/knowledge/guide.pdf'), pdfBytes(['真实构建离线参考资料']))
  const secret = 'private-compiled-worker-fixture'
  const input = { ...f.input, mode: 'offline', seed: { modelPatch: [], mcp: { servers: [], groups: [], sharedToken: 'fixture-mcp' }, environment: { TEST_MODEL_KEY: secret } },
    knowledgeSources: [{ url: reference, path: 'dsh/workspace/knowledge/guide.pdf' }] }
  const preview = await runWorker(worker, 'preview', input)
  assert.equal(preview.result.resourceReady, true)
  assert.equal(preview.result.agentId, 'alpha')
  assert.equal(preview.result.experimentId, f.id)
  assert.equal(JSON.stringify(preview).includes(secret), false)
  const packed = await runWorker(worker, 'pack', { ...input, expectedCandidateSha256: preview.result.candidateSha256 })
  assert.equal(packed.result.manifest.kind, 'standalone-agent')
  assert.equal(packed.result.manifest.source.candidateSha256, preview.result.candidateSha256)
  assert.equal(packed.result.manifest.knowledge.sources.length, 1)
  assert.equal(packed.result.manifest.knowledge.missing.length, 0)
  assert.equal(packed.result.manifest.knowledge.sources[0].format, 'pdf')
  assert.ok(packed.result.manifest.knowledge.sources[0].readableSha256)
  assert.equal(statSync(packed.result.archive).mode & 0o777, 0o600)
  assert.equal(JSON.stringify(packed).includes(secret), false)
  assert.ok(packed.progress.some(value => value.stage === 'completed'))
  const extracted = join(f.root, 'compiled-worker-package')
  mkdirSync(extracted)
  command('tar', ['-xzf', packed.result.archive, '-C', extracted])
  command('sha256sum', ['-c', 'SHA256SUMS', '--quiet'], extracted)
  assert.equal(readFileSync(join(extracted, 'agent'), 'utf8'), readFileSync(join(f.program, 'platform/deploy/agent/runtime/agent'), 'utf8'))
  assert.equal(readFileSync(join(extracted, 'install.sh'), 'utf8'), readFileSync(join(f.program, 'platform/deploy/agent/runtime/install.sh'), 'utf8'))
  assert.equal(JSON.parse(readFileSync(join(extracted, 'config-seed/environment.llm-api-key'), 'utf8')).TEST_MODEL_KEY, secret)
  assert.equal(existsSync(join(f.candidate, 'dsh/workspace/knowledge/offline')), false)
})
