import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { collectEntries, verifyEntries } from '../manifest.mts'
import { copyTree, run, tarCreate, tarExtract } from '../fsutil.mts'
import { rewriteDeploymentAddress, rewriteKnownPaths, scanKnownOldPaths } from '../paths.mts'
import { ensureDshScopeLink } from '../runtime.mts'
import { assertRealWorkspace, inspectDataRoot } from '../data.mts'
import { pack } from '../pack.mts'
import { verifyDeployment } from '../verify.mts'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'hep-deploy-test-'))
  return { root, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('部署核对检查唯一绑定的原生工作区，不要求首次使用标记', async () => {
  const { root, close } = workspace()
  try {
    const dataRoot = join(root, 'data')
    const storage = join(dataRoot, '.local/platform-home/storages/workspace.json')
    mkdirSync(join(storage, '..'), { recursive: true })
    const check = async (ids, workspaces, defaultWorkspaceId) => {
      writeFileSync(storage, JSON.stringify({ global: { workspaceIds: ids, defaultWorkspaceId }, tables: { workspaces } }))
      const result = await verifyDeployment({ prefix: join(root, 'program'), dataRoot })
      return result.checks.find(check => check.id === 'default-workspace')
    }
    assert.equal((await check(['bound'], { bound: { path: dataRoot } })).status, 'ok')
    assert.equal((await check(['bound'], { bound: { path: dataRoot } }, 'bound')).status, 'ok')
    assert.equal((await check(['bound'], { bound: { path: root } })).status, 'mismatch')
    assert.equal((await check(['bound'], {})).status, 'mismatch')
    assert.equal((await check(['bound', 'other'], { bound: { path: dataRoot }, other: { path: root } })).status, 'mismatch')
  } finally { close() }
})

test('安装和验证默认使用当前用户的独立程序及数据目录，允许显式覆盖', () => {
  const { root, close } = workspace()
  try {
    const home = join(root, 'home')
    const bundle = join(root, 'bundle')
    mkdirSync(home)
    mkdirSync(bundle)
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, package: { arch: process.arch === 'arm64' ? 'arm64' : 'amd64' }, files: [],
    }))
    const cli = new URL('../cli.mts', import.meta.url).pathname
    const invoke = args => spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    })
    const planned = invoke(['install', '--bundle-root', bundle, '--dry-run', '--json'])
    assert.equal(planned.status, 0, planned.stderr)
    const expectedProgram = join(home, 'work', 'harness-engineering-platform-data')
    const expectedData = join(home, 'harness-engineering-platform-data')
    assert.equal(JSON.parse(planned.stdout).prefix, expectedProgram)
    assert.equal(JSON.parse(planned.stdout).dataRoot, expectedData)
    assert.equal(existsSync(join(home, 'work')), false)
    const verified = invoke(['verify', '--json'])
    assert.equal(verified.status, 1)
    const checks = JSON.parse(verified.stdout).checks
    assert(checks.find(check => check.id === 'program-integrity').detail.includes(expectedProgram))
    assert(checks.find(check => check.id === 'profile').detail.startsWith(expectedData + '/'))
    const custom = invoke(['install', '--bundle-root', bundle, '--dry-run', '--json',
      '--prefix', join(root, 'custom-program'), '--data-root', join(root, 'custom-data')])
    assert.equal(custom.status, 0, custom.stderr)
    assert.equal(JSON.parse(custom.stdout).prefix, join(root, 'custom-program'))
    assert.equal(JSON.parse(custom.stdout).dataRoot, join(root, 'custom-data'))
  } finally { close() }
})

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
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], gateway: {
      host: '172.16.138.228', port: 53105, publicOrigin: 'http://172.16.138.228:53105',
      managementUrl: 'http://172.16.138.228:18120/hep/', sharedSecretFile: join(root, 'secret'),
    } }))
    assert.equal(rewriteDeploymentAddress(root, '172.16.138.52', 18121, 53106), true)
    const result = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(result.gateway.host, '172.16.138.52')
    assert.equal(result.gateway.port, 53106)
    assert.equal(result.gateway.publicOrigin, 'http://172.16.138.52:53106')
    assert.equal(result.gateway.managementUrl, 'http://172.16.138.52:18121/hep/')
    assert.equal(result.gateway.sharedSecretFile, join(root, 'secret'))
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
    mkdirSync(join(assets, 'git', 'root', 'usr', 'bin'), { recursive: true })
    writeFileSync(join(assets, 'git', 'root', 'usr', 'bin', 'git'), '')
    const libc = join(assets, 'git', 'root', 'libc.so.6')
    writeFileSync(libc, '')
    assert.throws(() => pack(options), /使用目标系统 glibc/)
    rmSync(libc)
    mkdirSync(join(assets, 'python', 'lib'), { recursive: true })
    const pythonLibc = join(assets, 'python', 'lib', 'libc.so.6')
    writeFileSync(pythonLibc, '')
    assert.throws(() => pack(options), /使用目标系统 glibc/)
    rmSync(pythonLibc)
    const archiveRoot = join(root, 'python-archive')
    mkdirSync(archiveRoot)
    writeFileSync(join(archiveRoot, 'libm.so.6'), '')
    const pythonArchive = join(assets, 'python', 'python.tar.gz')
    tarCreate(archiveRoot, pythonArchive)
    assert.throws(() => pack(options), /Python 离线归档包含 glibc/)
    rmSync(pythonArchive)
    writeFileSync(join(assets, 'git', 'git'), '#!/bin/sh\nexit 9\n')
    chmodSync(join(assets, 'git', 'git'), 0o755)
    assert.throws(() => pack({ ...options, arch: process.arch === 'arm64' ? 'arm64' : 'amd64' }), /退出码 9/)
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
    const userPatch = join(root, '.local/platform-home/profiles/harness-platform/cordis.patch.yml')
    mkdirSync(join(userPatch, '..'), { recursive: true })
    writeFileSync(userPatch, 'baseURL: /home/old/data/provider\n')
    const report = rewriteKnownPaths(root, [
      { from: '/home/old', to: '/home/new' },
      { from: '/home/old/data', to: '/home/new/data' },
    ])
    assert.ok(report.changed.length >= 4)
    assert.equal(scanKnownOldPaths(root, ['/home/old']).length, 0)
    const instance = JSON.parse(readFileSync(join(root, '.local', 'instances', 'agent-1', 'instance.json'), 'utf8'))
    assert.equal(instance.asset_root, '/home/new/data')
    assert.match(instance.home_directory, /^\/home\/new\/data\//)
    assert.match(readFileSync(userPatch, 'utf8'), /\/home\/new\/data\/provider/)
  } finally { close() }
})

test('完整包携带原生用户设置和专用凭据，排除 HOME 运行态', () => {
  const { root, close } = workspace()
  try {
    const program = join(root, 'program'), data = join(root, 'data'), assets = join(root, 'assets')
    const write = (path, content) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
    for (const [repo, file] of [[program, 'platform/deploy/install.sh'], [data, 'workspace.json']]) {
      write(join(repo, file), '{}')
      const git = (...args) => run('git', ['-C', repo, ...args])
      git('init', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid')
      git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
      git('add', '.'); git('commit', '-m', 'fixture')
    }
    const patch = '.local/platform-home/profiles/harness-platform/cordis.patch.yml'
    write(join(data, patch), '- id: llm-pi-ai\n  config: {}\n')
    write(join(data, '.local/platform-home/sessions/private'), 'excluded')
    write(join(data, '.local/credentials/models.llm-api-key'), '{}')
    for (const path of ['node/stub', 'pnpm/stub', 'python/stub', 'dsh/apps/cli/lib/bin.js',
      'program/platform/plugin/node_modules/stub', 'program/runtime/adapters/dsh-web/node_modules/stub']) write(join(assets, path), '')
    write(join(assets, 'git/git'), '#!/bin/sh\necho git-fixture\n'); chmodSync(join(assets, 'git/git'), 0o755)
    const result = pack({ programRoot: program, dataRoot: data, assetsDir: assets, out: join(root, 'out'), arch: 'amd64',
      includeImage: false, includeData: true, allowDirty: true, keepStaging: false, allowFixtureData: true })
    const unpacked = join(root, 'unpacked')
    tarExtract(result.archive, unpacked)
    assert.equal(readFileSync(join(unpacked, 'data', patch), 'utf8'), readFileSync(join(data, patch), 'utf8'))
    assert.equal(existsSync(join(unpacked, 'data/.local/platform-home/sessions')), false)
    assert.equal(existsSync(join(unpacked, 'data/.local/credentials/models.llm-api-key')), true)
  } finally { close() }
})

test('安装到新数据根自动初始化启用的网关，重装保留主动关闭和登记', () => {
  const { root, close } = workspace()
  try {
    rewriteDeploymentAddress(root, '172.16.138.170', 18120, 53107)
    const file = join(root, 'config/business-access.json')
    const access = JSON.parse(readFileSync(file))
    assert.equal(access.enabled, true)
    assert.equal(access.gateway.host, '172.16.138.170')
    assert.equal(access.gateway.port, 53107)
    assert.equal(access.gateway.publicOrigin, 'http://172.16.138.170:53107')
    assert.equal(access.gateway.managementUrl, 'http://172.16.138.170:18120/hep/')
    const secret = readFileSync(join(root, access.gateway.sharedSecretFile))
    assert.ok(secret.length >= 32)
    access.enabled = false
    access.gateway.instances.push({ agentId: 'test', instanceId: 'existing', accessMode: 'anonymous' })
    writeFileSync(file, JSON.stringify(access))
    rewriteDeploymentAddress(root, '172.16.138.171', 18120)
    const next = JSON.parse(readFileSync(file))
    assert.equal(next.enabled, false)
    assert.deepEqual(next.gateway.instances, access.gateway.instances)
    assert.deepEqual(readFileSync(join(root, next.gateway.sharedSecretFile)), secret)
  } finally { close() }
})
