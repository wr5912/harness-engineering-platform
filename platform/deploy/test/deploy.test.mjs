import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectEntries, verifyEntries } from '../manifest.mts'
import { rewriteKnownPaths, scanKnownOldPaths } from '../paths.mts'
import { ensureDshScopeLink } from '../runtime.mts'
import { assertRealWorkspace, inspectDataRoot } from '../data.mts'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'hep-deploy-test-'))
  return { root, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('manifest 校验文件、符号链接与额外文件', () => {
  const { root, close } = workspace()
  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'node'), 'node')
    symlinkSync('bin/node', join(root, 'node-link'))
    const entries = collectEntries(root)
    assert.equal(verifyEntries(root, entries).length, 0)
    writeFileSync(join(root, 'extra'), 'x')
    assert.match(verifyEntries(root, entries).join('\n'), /清单外文件：extra/)
  } finally { close() }
})

test('manifest 允许显式忽略清单自身', () => {
  const { root, close } = workspace()
  try {
    writeFileSync(join(root, 'a'), 'a')
    writeFileSync(join(root, 'manifest.json'), '{}')
    const entries = collectEntries(root)
    assert.deepEqual(verifyEntries(root, entries, ['manifest.json']), [])
  } finally { close() }
})

test('识别真实工作区与夹具数据根', () => {
  const { root, close } = workspace()
  try {
    assert.equal(inspectDataRoot(root).kind, 'fixture')
    assert.throws(() => assertRealWorkspace(root), /不是完整工作区/)
    mkdirSync(join(root, 'agents'), { recursive: true })
    mkdirSync(join(root, 'evolution'), { recursive: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    mkdirSync(join(root, '.agents', 'skills', 'demo'), { recursive: true })
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-test', legacyRoots: [] }))
    writeFileSync(join(root, 'AGENTS.md'), '# test\n')
    writeFileSync(join(root, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n')
    const check = assertRealWorkspace(root)
    assert.equal(check.kind, 'workspace')
    assert.equal(check.skills, 1)
  } finally { close() }
})

test('安装器为 DSH 构建树补齐 dsh-scope 链接', () => {
  const { root, close } = workspace()
  try {
    mkdirSync(join(root, 'packages', 'core', 'scope'), { recursive: true })
    ensureDshScopeLink(root)
    assert.equal(realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-scope')), join(root, 'packages', 'core', 'scope'))
  } finally { close() }
})

test('路径映射重写实例登记、Compose 与配置', () => {
  const { root, close } = workspace()
  try {
    mkdirSync(join(root, '.local', 'instances', 'agent-1'), { recursive: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-test', legacyRoots: ['/home/old/data'] }))
    writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify({ gateway: { sharedSecretFile: '/home/old/data/.local/secret' } }))
    writeFileSync(join(root, '.local', 'instances', 'agent-1', 'instance.json'), JSON.stringify({
      asset_root: '/home/old/data',
      home_directory: '/home/old/data/.local/instances/agent-1/dsh-home',
      mounts: { managed: '/home/old/data/evolution/x/candidate/dsh/managed' },
    }))
    writeFileSync(join(root, '.local', 'instances', 'agent-1', 'compose.yaml'), 'source: /home/old/data\n')
    const report = rewriteKnownPaths(root, [
      { from: '/home/old', to: '/home/new' },
      { from: '/home/old/data', to: '/home/new/data' },
    ])
    assert.ok(report.changed.length >= 4)
    assert.equal(scanKnownOldPaths(root, ['/home/old']).length, 0)
    const instance = JSON.parse(readFileSync(join(root, '.local', 'instances', 'agent-1', 'instance.json'), 'utf8'))
    assert.equal(instance.asset_root, '/home/new/data')
    assert.match(instance.home_directory, /^\/home\/new\/data\//)
  } finally { close() }
})
