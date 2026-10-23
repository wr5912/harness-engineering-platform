import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectEntries, verifyEntries } from '../manifest.mts'
import { copyTree, tarCreate } from '../fsutil.mts'
import { rewriteDeploymentAddress, rewriteKnownPaths, scanKnownOldPaths } from '../paths.mts'
import { ensureDshScopeLink } from '../runtime.mts'
import { assertRealWorkspace, inspectDataRoot } from '../data.mts'
import { pack } from '../pack.mts'

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

test('无过滤目录复制保留符号链接，已有目标仍复制目录内容', () => {
  const { root, close } = workspace()
  try {
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'file'), 'value')
    symlinkSync('file', join(source, 'link'))
    const fresh = join(root, 'fresh')
    copyTree(source, fresh)
    assert.equal(readFileSync(join(fresh, 'link'), 'utf8'), 'value')
    const existing = join(root, 'existing')
    mkdirSync(existing)
    copyTree(source, existing)
    assert.equal(readFileSync(join(existing, 'file'), 'utf8'), 'value')
  } finally { close() }
})

test('安装时将业务网关和管理入口绑定到目标主机与空闲端口', () => {
  const { root, close } = workspace()
  try {
    const file = join(root, 'config', 'business-access.json')
    mkdirSync(join(root, 'config'))
    writeFileSync(file, JSON.stringify({ enabled: true, gateway: {
      host: '172.16.138.228', port: 53105, publicOrigin: 'http://172.16.138.228:53105',
      managementUrl: 'http://172.16.138.228:18120/hep/', sharedSecretFile: '/root/data/secret',
    } }))
    assert.equal(rewriteDeploymentAddress(root, '172.16.138.52', 18121, 53106), true)
    const result = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(result.gateway.host, '172.16.138.52')
    assert.equal(result.gateway.port, 53106)
    assert.equal(result.gateway.publicOrigin, 'http://172.16.138.52:53106')
    assert.equal(result.gateway.managementUrl, 'http://172.16.138.52:18121/hep/')
    assert.equal(result.gateway.sharedSecretFile, '/root/data/secret')
  } finally { close() }
})

test('敏感安装包归档仅允许打包用户读取，覆盖旧归档也保持权限', () => {
  const { root, close } = workspace()
  try {
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'credential'), 'secret')
    const archive = join(root, 'bundle.tar.gz')
    writeFileSync(archive, '', { mode: 0o644 })
    tarCreate(source, archive)
    assert.equal(statSync(archive).mode & 0o777, 0o600)
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

test('打包时拒绝未构建的 DSH 和缺少二进制的 Git 资源', () => {
  const { root, close } = workspace()
  try {
    const program = join(root, 'program'), assets = join(root, 'assets')
    for (const name of ['platform', 'runtime', 'plugins']) mkdirSync(join(program, name), { recursive: true })
    mkdirSync(join(program, 'platform', 'deploy'), { recursive: true })
    writeFileSync(join(program, 'platform', 'deploy', 'install.sh'), '#!/bin/sh\n')
    for (const path of ['program/platform/plugin/node_modules', 'program/runtime/adapters/dsh-web/node_modules', 'node', 'pnpm', 'git/root']) {
      mkdirSync(join(assets, path), { recursive: true })
    }
    const options = { programRoot: program, assetsDir: assets, out: join(root, 'out'), arch: 'arm64',
      includeImage: false, includeData: false, allowDirty: true, keepStaging: false, allowFixtureData: false }
    assert.throws(() => pack(options), /缺少已构建的 DSH CLI/)
    mkdirSync(join(assets, 'dsh', 'apps', 'cli', 'lib'), { recursive: true })
    writeFileSync(join(assets, 'dsh', 'apps', 'cli', 'lib', 'bin.js'), '')
    writeFileSync(join(assets, 'git', 'git'), '#!/bin/sh\n')
    assert.throws(() => pack(options), /Git 离线资源缺少可执行入口或包内二进制/)
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
