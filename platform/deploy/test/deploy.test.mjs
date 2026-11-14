import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { collectEntries, sha256File, verifyEntries } from '../manifest.mts'
import { copyTree, run, tarCreate, tarExtract } from '../fsutil.mts'
import { rewriteDeploymentAddress, rewriteKnownPaths, scanKnownOldPaths } from '../paths.mts'
import { ensureDshScopeLink } from '../runtime.mts'
import { assertRealWorkspace, inspectDataRoot } from '../data.mts'
import { pack } from '../pack.mts'
import { verifyDeployment } from '../verify.mts'
import { install } from '../install.mts'
import { copyDataState } from '../state.mts'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'hep-deploy-test-'))
  return { root, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('文件 SHA 保留空文件、二进制、跨块末尾和连续调用的完整摘要', () => {
  const { root, close } = workspace()
  try {
    for (const size of [0, 1, 65535, 65536, 65537, 131089]) {
      const bytes = Buffer.alloc(size)
      for (let index = 0; index < size; index++) bytes[index] = index % 251
      const file = join(root, `binary ${size}.bin`)
      writeFileSync(file, bytes)
      const expected = createHash('sha256').update(bytes).digest('hex')
      assert.equal(sha256File(file), expected)
      assert.equal(sha256File(file), expected)
    }
    symlinkSync('binary 65537.bin', join(root, 'linked.bin'))
    assert.equal(sha256File(join(root, 'linked.bin')), sha256File(join(root, 'binary 65537.bin')))
    assert.throws(() => sha256File(join(root, 'missing.bin')), error => error.code === 'ENOENT')
    assert.throws(() => sha256File(root), error => error.code === 'EISDIR')
  } finally { close() }
})

test('256MiB 文件散列不增加整文件大小的进程峰值内存', () => {
  const { root, close } = workspace()
  try {
    const file = join(root, 'sparse.bin')
    writeFileSync(file, '')
    truncateSync(file, 256 * 1024 * 1024)
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const {sha256File}=await import(process.argv[1]);
      const before=process.resourceUsage().maxRSS;
      const digest=sha256File(process.argv[2]);
      console.log(JSON.stringify({digest,extraPeakKiB:process.resourceUsage().maxRSS-before}));
    `, new URL('../manifest.mts', import.meta.url).href, file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(result.stdout)
    assert.equal(observed.digest, 'a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484')
    assert.ok(observed.extraPeakKiB < 32 * 1024, `散列额外峰值 ${observed.extraPeakKiB} KiB 超过固定缓冲预算`)
  } finally { close() }
})

test('超过2GiB的稀疏文件仍包含最后不足一块的全部字节', () => {
  const { root, close } = workspace()
  try {
    const file = join(root, 'large.bin')
    writeFileSync(file, '')
    truncateSync(file, 2 * 1024 * 1024 * 1024 + 17)
    assert.equal(sha256File(file), 'd9378e43c0e666027848e63668ba0a821b4726843e366626946e3823b477299e')
  } finally { close() }
})

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
    mkdirSync(join(dataRoot, 'config'), { recursive: true })
    writeFileSync(join(dataRoot, 'config/assistant-workspace.json'), JSON.stringify({ workspaceRoot: '..' }))
    assert.equal((await check(['bound'], { bound: { path: root } })).status, 'ok')
    assert.equal((await check(['bound'], { bound: { path: dataRoot } })).status, 'mismatch')
    const profile = join(dataRoot, '.local/platform-home/profiles/harness-platform/harness-platform.patch.yml')
    mkdirSync(join(profile, '..'), { recursive: true })
    const profileCheck = async skills => {
      writeFileSync(profile, `customSkillDirs: [${JSON.stringify(skills)}]\n`)
      return (await verifyDeployment({ prefix: join(root, 'program'), dataRoot })).checks.find(check => check.id === 'profile-skills')
    }
    assert.equal((await profileCheck(join(dataRoot, '.local/platform-home/.agents/skills'))).status, 'ok')
    assert.equal((await profileCheck(join(dataRoot, '.agents/skills'))).status, 'mismatch')
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

test('NAT 安装分别保存本机监听与公开入口，管理与业务链接使用公网主机', () => {
  const { root, close } = workspace()
  try {
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config/sites.json'), '{"platform":"/hep/"}')
    rewriteDeploymentAddress(root, '127.0.0.1', 18121, 53106, 'https://platform.example/hep/')
    const file = join(root, 'config/business-access.json'), before = readFileSync(file, 'utf8')
    const result = JSON.parse(before)
    assert.equal(result.gateway.host, '127.0.0.1')
    assert.equal(result.gateway.port, 53106)
    assert.equal(result.gateway.managementUrl, 'https://platform.example/hep/')
    assert.equal(result.gateway.publicOrigin, 'http://platform.example:53106')
    assert.throws(() => rewriteDeploymentAddress(root, '127.0.0.1', 18121, 53106, 'https://user:password@platform.example/hep/'))
    assert.equal(readFileSync(file, 'utf8'), before)
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

test('真实数据工作区不要求持有管理助手的 Skill', () => {
  const { root, close } = workspace()
  try {
    assert.equal(inspectDataRoot(root).kind, 'fixture')
    assert.throws(() => assertRealWorkspace(root), /不是完整工作区/)
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-test', legacyRoots: [] }))
    writeFileSync(join(root, 'AGENTS.md'), '# test\n')
    assert.equal(assertRealWorkspace(root).kind, 'workspace')
    assert.equal(assertRealWorkspace(root).skills, 0)
    mkdirSync(join(root, '.agents', 'skills', 'demo'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n')
    const check = assertRealWorkspace(root)
    assert.equal(check.kind, 'workspace')
    assert.equal(check.skills, 1)
    assert.equal(existsSync(join(root, 'agents')), false)
    assert.equal(existsSync(join(root, 'evolution')), false)
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

test('完整包携带原生设置、会话及匹配的目标插件依赖，排除准备机平台链接', () => {
  const { root, close } = workspace()
  try {
    const program = join(root, 'program'), data = join(root, 'data'), assets = join(root, 'assets')
    const write = (path, content) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
    for (const [repo, file] of [[program, 'platform/deploy/install.sh'], [data, 'workspace.json']]) {
      write(join(repo, file), '{}')
      write(join(repo, '.gitignore'), '.local/\n')
      const git = (...args) => run('git', ['-C', repo, ...args])
      git('init', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid')
      git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
      git('add', '.'); git('commit', '-m', 'fixture')
    }
    const patch = '.local/platform-home/profiles/harness-platform/cordis.patch.yml'
    write(join(data, patch), '- id: llm-pi-ai\n  config: {}\n')
    write(join(data, '.local/platform-home/sessions/private'), 'session-state')
    write(join(data, '.local/credentials/models.llm-api-key'), '{}')
    for (const path of ['node/stub', 'pnpm/stub', 'python/stub', 'dsh/apps/cli/lib/bin.js',
      'program/platform/plugin/node_modules/stub', 'program/runtime/adapters/dsh-web/node_modules/stub']) write(join(assets, path), '')
    write(join(assets, 'git/git'), '#!/bin/sh\necho git-fixture\n'); chmodSync(join(assets, 'git/git'), 0o755)
    const profile = '.local/platform-home/profiles/harness-platform'
    const manifest = JSON.stringify({ dependencies: { 'dsh-example': '1.0.0' }, dsh: { profile: { bundles: ['dsh-example'] } } })
    write(join(data, profile, 'package.json'), manifest)
    write(join(data, profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const options = { programRoot: program, dataRoot: data, assetsDir: assets, out: join(root, 'out'), arch: 'amd64',
      includeImage: false, includeData: true, allowDirty: true, keepStaging: false, allowFixtureData: true }
    assert.throws(() => pack(options), /管理助手插件离线资源与当前配置不一致/)
    write(join(assets, 'data', profile, 'package.json'), manifest)
    write(join(assets, 'data', profile, 'pnpm-lock.yaml'), 'stale lock\n')
    assert.throws(() => pack(options), /管理助手插件离线资源与当前配置不一致/)
    write(join(assets, 'data', profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    assert.throws(() => pack(options), /离线资源缺少管理助手插件依赖：dsh-example/)
    write(join(assets, 'data', profile, 'node_modules/dsh-example/index.js'), 'export default true\n')
    const platformLink = join(assets, 'data', profile, 'node_modules/@ai-agent-harness/harness-platform')
    mkdirSync(join(platformLink, '..'), { recursive: true }); symlinkSync(program, platformLink)
    const result = pack(options)
    const unpacked = join(root, 'unpacked')
    tarExtract(result.archive, unpacked)
    assert.equal(readFileSync(join(unpacked, 'data', patch), 'utf8'), readFileSync(join(data, patch), 'utf8'))
    assert.equal(existsSync(join(unpacked, 'data/.local/platform-home/sessions')), true)
    assert.equal(existsSync(join(unpacked, 'data/.local/credentials/models.llm-api-key')), true)
    assert.equal(readFileSync(join(unpacked, 'data', profile, 'package.json'), 'utf8'), manifest)
    assert.equal(existsSync(join(unpacked, 'data', profile, 'node_modules/dsh-example/index.js')), true)
    assert.equal(existsSync(join(unpacked, 'data', profile, 'node_modules/@ai-agent-harness/harness-platform')), false)
    write(join(program, 'platform/deploy/install.sh'), '# current installer\n')
    write(join(data, 'workspace.json'), '{"id":"current-workspace"}')
    write(join(data, 'agents/new-agent.txt'), 'uncommitted-agent')
    const current = pack({ ...options, out: join(root, 'working-tree-out'), includeWorkingTree: true })
    const currentRoot = join(root, 'working-tree-unpacked')
    tarExtract(current.archive, currentRoot)
    assert.equal(readFileSync(join(currentRoot, 'program/platform/deploy/install.sh'), 'utf8'), '# current installer\n')
    assert.equal(readFileSync(join(currentRoot, 'data/agents/new-agent.txt'), 'utf8'), 'uncommitted-agent')
    assert.equal(JSON.parse(readFileSync(join(currentRoot, 'data/workspace.json'), 'utf8')).id, 'current-workspace')
    assert.equal(existsSync(join(currentRoot, 'data/.local/platform-home/sessions')), true)
    const currentManifest = JSON.parse(readFileSync(join(currentRoot, 'manifest.json'), 'utf8'))
    assert.equal(currentManifest.package.snapshot, 'working-tree')
    assert.equal(currentManifest.data.dirty, true)
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

test('重叠路径只替换原文一次，合法目标和同值映射不被旧HOME扫描误拒绝', () => {
  const { root, close } = workspace()
  try {
    const file = join(root, 'workspace.json')
    writeFileSync(file, JSON.stringify({ data: '/home/old/data/agents', unchanged: '/home/old/kept/file', home: '/home/old/other', boundary: '/home/old/data-extra' }))
    const mappings = [{ from: '/home/old', to: '/home/new' }, { from: '/home/old/data', to: '/home/old/restored-$&' }, { from: '/home/old/kept', to: '/home/old/kept' }]
    const report = rewriteKnownPaths(root, mappings)
    const value = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(value, { data: '/home/old/restored-$&/agents', unchanged: '/home/old/kept/file', home: '/home/new/other', boundary: '/home/new/data-extra' })
    assert.deepEqual(report.oldReferences, [])
    assert.deepEqual(scanKnownOldPaths(root, ['/home/old', '/home/old/data'], mappings.map(item => item.to)), [])
    value.leftover = '/home/old/forgotten'
    writeFileSync(file, JSON.stringify(value))
    assert.deepEqual(scanKnownOldPaths(root, ['/home/old'], mappings.map(item => item.to)), [{ file, pattern: '/home/old' }])
    assert.throws(() => rewriteKnownPaths(root, [{ from: '/same', to: '/a' }, { from: '/same', to: '/b' }]), /不同目标/)
  } finally { close() }
})

test('strict-paths安装接受仍位于旧HOME中的完整目标路径，保留字面特殊字符', () => {
  const { root, close } = workspace()
  try {
    const bundle = join(root, 'bundle'), prefix = join(root, 'program-$&'), dataRoot = join(root, 'data-$&')
    const write = (path, content, mode = 0o600) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content, { mode }) }
    write(join(bundle, 'program/platform/plugin/package.json'), JSON.stringify({ peerDependencies: { '@deepseek-ai/dsh-client-connection': 'fixture-runtime' } }))
    const oldHome = tmpdir(), oldProgram = join(oldHome, 'source-program'), oldData = join(oldHome, 'source-data')
    write(join(bundle, 'data/workspace.json'), JSON.stringify({ id: 'workspace-path-test', program: oldProgram, data: join(oldData, 'agents/item'), home: join(oldHome, 'other') }))
    for (const path of ['node/bin/node', 'pnpm/bin/pnpm', 'git/git', 'python/bin/python3']) write(join(bundle, 'offline', path), '#!/bin/sh\nprintf "%s\\n" fixture-runtime\n', 0o755)
    write(join(bundle, 'offline/dsh/apps/cli/lib/bin.js'), '')
    write(join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
      package: { name: 'fixture', version: '1', commit: 'fixture', dirty: false, arch: process.arch === 'arm64' ? 'arm64' : 'amd64', createdAt: 'fixture' },
      source: { home: oldHome, programRoot: oldProgram, dataRoot: oldData }, runtime: {}, data: { sensitive: false }, files: collectEntries(bundle) }))
    const report = install({ bundleRoot: bundle, prefix, dataRoot, port: 18120, skipImage: true, skipPrepare: true, allowFixtureData: true, strictPaths: true, start: false, dryRun: false, json: true })
    assert.equal(report.status, 'installed'); assert.deepEqual(report.oldReferences, [])
    const actual = JSON.parse(readFileSync(join(dataRoot, 'workspace.json'), 'utf8'))
    assert.equal(actual.program, prefix); assert.equal(actual.data, join(dataRoot, 'agents/item'))
    assert.ok(!actual.home.startsWith(oldHome + '/'))
  } finally { close() }
})


test('迁移保留数据身份、MCP 配置及外置原生 HOME 文件，缓存与进程文件重新生成', () => {
  const { root, close } = workspace()
  const previous = process.env.HARNESS_MANAGER_DSH_HOME
  try {
    const source = join(root, 'source'), target = join(root, 'target'), home = join(root, 'manager')
    const write = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, value) }
    for (const path of ['config/mcp-manager.json', '.local/agent-access/state.json', '.local/credentials/models.llm-api-key', 'mcp/.local/runs/one.json']) write(join(source, path), path)
    for (const path of ['.local/build-cache/obsolete', 'mcp/.local/cache/source/obsolete', '.local/platform-service/status.json']) write(join(source, path), 'transient')
    for (const path of ['AGENTS.md', '.agents/skills/sample/SKILL.md', 'profiles/harness-platform/cordis.patch.yml', 'sessions/private', 'storages/workspace.json']) write(join(home, path), path)
    write(join(home, 'profiles/harness-platform/node_modules/obsolete'), 'regenerate')
    process.env.HARNESS_MANAGER_DSH_HOME = home
    copyDataState(source, target)
    for (const path of ['config/mcp-manager.json', '.local/agent-access/state.json', '.local/credentials/models.llm-api-key', 'mcp/.local/runs/one.json']) assert.equal(readFileSync(join(target, path), 'utf8'), path)
    for (const path of ['AGENTS.md', '.agents/skills/sample/SKILL.md', 'profiles/harness-platform/cordis.patch.yml', 'sessions/private', 'storages/workspace.json']) assert.equal(readFileSync(join(target, '.local/platform-home', path), 'utf8'), path)
    for (const path of ['.local/build-cache', 'mcp/.local/cache', '.local/platform-service', '.local/platform-home/profiles/harness-platform/node_modules']) assert.equal(existsSync(join(target, path)), false)
    write(join(source, '.local/artifacts/agent-deployments/export.tar.gz'), 'installation archive')
    write(join(source, '.local/asset-dependencies/old/node_modules/cache'), 'dependency cache')
    copyDataState(source, target, false, ['.local/artifacts/agent-deployments', '.local/asset-dependencies'])
    assert.equal(existsSync(join(target, '.local/artifacts/agent-deployments')), false)
    assert.equal(existsSync(join(target, '.local/asset-dependencies')), false)
    assert.equal(readFileSync(join(target, 'mcp/.local/runs/one.json'), 'utf8'), 'mcp/.local/runs/one.json')
    // 更新保留现场状态时，不套用打包的介质排除项。
    copyDataState(source, target, false)
    assert.equal(readFileSync(join(target, '.local/artifacts/agent-deployments/export.tar.gz'), 'utf8'), 'installation archive')
  } finally {
    if (previous === undefined) delete process.env.HARNESS_MANAGER_DSH_HOME; else process.env.HARNESS_MANAGER_DSH_HOME = previous
    close()
  }
})
