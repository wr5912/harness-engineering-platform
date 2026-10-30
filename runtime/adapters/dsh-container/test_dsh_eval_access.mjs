import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('API 评测执行器支持免认证入口并保留历史 Token 握手校验', async () => {
  let mode = 'plain', rpcCalls = 0, basePath = '/'
  const server = createServer(async (request, response) => {
    if (request.url.startsWith(basePath + 'api/')) {
      rpcCalls += 1
      assert.equal(request.headers.cookie || '', mode === 'token' ? 'dsh=test-only' : '')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      assert.equal(body.method, 'workspace/create')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ result: { ok: true, value: { workspace: { workspaceId: 'test-workspace', path: '/work/harness/workspace' } } } }))
      return
    }
    assert.equal(request.url.split('?')[0], basePath)
    response.statusCode = mode === 'denied' ? 403 : ['token', 'missing-cookie'].includes(mode) ? 303 : 200
    if (mode === 'token') response.setHeader('set-cookie', 'dsh=test-only; Path=/')
    response.end('test-only')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    for (basePath of ['/', '/assistant/']) {
      for (mode of ['plain', 'token', 'missing-cookie', 'denied', 'token-without-redirect']) {
        rpcCalls = 0
        const child = spawn(process.execPath, [new URL('./dsh-eval-api.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.stdin.end(JSON.stringify({ auth_url: origin + basePath + (mode === 'plain' || mode === 'denied' ? '' : '?token=test-only'), workspace: '/work/harness/workspace', preset_id: 'test', judge_preset_id: 'test-judge', evidence_root: '/tmp/unused-eval-access-evidence', cases: [], timeout_ms: 1000 }))
        const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
        assert.equal(code, ['plain', 'token'].includes(mode) ? 0 : 2, mode + ': ' + stderr)
        assert.equal(rpcCalls, ['plain', 'token'].includes(mode) ? 1 : 0, mode)
        if (code === 0) assert.deepEqual(JSON.parse(stdout).rows, [])
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('研究入口的上下文、运行、比较与实例子进程沿用 HARNESS_PYTHON', t => {
  const root = mkdtempSync(join(tmpdir(), 'research-interpreter-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const adapter = join(root, 'runtime/adapters/dsh-container'), workspace = join(root, 'platform/plugin/src')
  const bin = join(root, 'bin'), log = join(root, 'calls.jsonl')
  for (const directory of [adapter, workspace, bin]) mkdirSync(directory, { recursive: true })
  copyFileSync(new URL('./research-tool.mts', import.meta.url), join(adapter, 'research-tool.mts'))
  copyFileSync(new URL('../../../platform/plugin/src/workspace.ts', import.meta.url), join(workspace, 'workspace.ts'))
  copyFileSync(new URL('../../../platform/plugin/src/version-id.ts', import.meta.url), join(workspace, 'version-id.ts'))
  const python = execFileSync(process.env.HARNESS_PYTHON || 'python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'python3'), '#!/bin/sh\necho unavailable-python3 >&2\nexit 77\n', { mode: 0o755 })
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo fixture-commit; fi\n', { mode: 0o755 })
  // 保留真实入口和子进程调度，仅用临时脚本替代资产、Run 与容器边界。
  const child = `import json,os,sys
from pathlib import Path
with open(os.environ["INTERPRETER_TEST_LOG"],"a") as output:
    output.write(json.dumps({"script":Path(__file__).name,"args":sys.argv[1:],"python":sys.executable})+"\\n")
name=Path(__file__).name
if name=="source_contract.py":
    result={"source_id":"experiment:fixture","agent_id":"fixture","experiment_id":"fixture","experiment_root":os.environ["HARNESS_ASSET_ROOT"],"candidate_root":os.environ["HARNESS_ASSET_ROOT"],"image":{}}
elif name=="run_record.py":
    result={"experiments":[],"evaluation_path":"evaluation.md"} if sys.argv[3]=="index" else {"cases":[]}
elif name=="dsh-eval": result={"run_id":"run-fixture"}
else: result={"instances":[{"name":"fixture","source_id":"experiment:fixture","state":"stopped"}]}
print(json.dumps(result))
`
  for (const name of ['source_contract.py', 'run_record.py', 'dsh-eval', 'dsh-dev']) writeFileSync(join(adapter, name), child)
  for (const args of [
    ['context', '--source', 'experiment:fixture'],
    ['run', '--source', 'experiment:fixture', '--case', 'U-BASIC-001'],
    ['review', '--left', 'run-a', '--right', 'run-b'],
    ['instance', '--source', 'experiment:fixture', '--restart', '--name', 'fixture'],
  ]) {
    const result = spawnSync(process.execPath, [join(adapter, 'research-tool.mts'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HARNESS_PYTHON: python,
        HARNESS_ASSET_ROOT: root, HARNESS_PROGRAM_ROOT: root, INTERPRETER_TEST_LOG: log },
    })
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`)
    assert.doesNotThrow(() => JSON.parse(result.stdout))
  }
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(new Set(calls.map(call => call.script)), new Set(['source_contract.py', 'run_record.py', 'dsh-eval', 'dsh-dev']))
  assert.deepEqual(new Set(calls.map(call => call.python)), new Set([python]))
  assert(calls.some(call => call.script === 'dsh-dev' && call.args[0] === 'up'))
  assert(calls.some(call => call.script === 'run_record.py' && call.args[2] === 'compare'))
})
