import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { runtimeRequire } from '../src/resolve-runtime.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-dependencies-'))
  const previous = process.env.HARNESS_DSH_ENTRY
  t.after(() => {
    if (previous === undefined) delete process.env.HARNESS_DSH_ENTRY
    else process.env.HARNESS_DSH_ENTRY = previous
    rmSync(root, { recursive: true, force: true })
  })
  const module = (directory, name) => {
    const path = join(directory, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    writeFileSync(join(path, 'index.js'), '')
    return join(path, 'index.js')
  }
  const entry = join(root, 'bin.js')
  writeFileSync(entry, '')
  process.env.HARNESS_DSH_ENTRY = entry
  return { root, entry, module }
}

test('从同一 CLI 的原生 bundle/Agent 解析服务并保留启动来源', t => {
  const f = fixture(t)
  for (const [owner, dependency] of [
    ['dsh-base', 'dsh-session-query-sqlite'], ['dsh-web-app', 'dsh-client-connection'],
    ['dsh-sdk-app', 'dsh-sdk-client'], ['dsh-agent', 'dsh-scope'],
  ]) {
    const anchor = f.module(f.root, '@deepseek-ai/' + owner)
    const target = f.module(dirname(anchor), '@deepseek-ai/' + dependency)
    assert.equal(runtimeRequire('@deepseek-ai/' + dependency).resolve('@deepseek-ai/' + dependency), target)
    assert.equal(process.env.HARNESS_DSH_ENTRY, realpathSync(f.entry))
  }
})

test('显式容器依赖锚点不替换平台 Runtime 来源', t => {
  const f = fixture(t)
  const anchor = f.module(f.root, '@deepseek-ai/dsh-agent')
  const target = f.module(dirname(anchor), '@deepseek-ai/dsh-scope')
  assert.equal(runtimeRequire('@deepseek-ai/dsh-scope', anchor).resolve('@deepseek-ai/dsh-scope'), target)
  assert.equal(process.env.HARNESS_DSH_ENTRY, f.entry)
})
