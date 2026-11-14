import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { installRuntime } from '../runtime.mts'
import { install } from '../install.mts'
import { updateBundle } from '../bundle-update.mts'
import { copyTree } from '../fsutil.mts'
import { collectEntries } from '../manifest.mts'
import { findVerifiedImage, inspectImageArchive, loadVerifiedImage, verifyImageInfo } from '../image.mts'

const root = mkdtempSync(join(tmpdir(), 'hep-install-test-'))
test.after(() => rmSync(root, { recursive: true, force: true }))
const write = (path, value, executable = false) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, value)
  if (executable) chmodSync(path, 0o755)
}
function bundle(name) {
  const path = join(root, name)
  write(join(path, 'offline/node/bin/node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, true)
  write(join(path, 'offline/git/git'), '#!/bin/sh\necho git-version-bundled\n', true)
  write(join(path, 'offline/python/site/hep_install_probe.py'), 'VALUE = 42\n')
  write(join(path, 'offline/python/site/yaml.py'), '# 外部解释器依赖夹具\n')
  write(join(path, 'offline/python/bin/python3'), '#!/bin/sh\nunset PYTHONHOME\nexec /usr/bin/python3 "$@"\n', true)
  write(join(path, 'offline/pnpm/bin/pnpm'), '#!/bin/sh\necho 11.28.5\n', true)
  write(join(path, 'offline/dsh/apps/cli/lib/bin.js'), 'console.log("0.2.2-rc.2")\n')
  write(join(path, 'program/platform/plugin/package.json'), JSON.stringify({peerDependencies:{'@deepseek-ai/dsh-client-connection':'0.2.2-rc.2'}}))
  writeLauncher(path, 'import os, sys\nsys.exit(int(os.environ.get("HEP_TEST_PREPARE_FAILURE", "0")))\n')
  return path
}
function writeLauncher(path, code) {
  write(join(path, 'program/platform/fixture.py'), code)
  write(join(path, 'program/platform/dsh-platform'), '#!/bin/sh\nunset PYTHONHOME\nexec /usr/bin/python3 "$(dirname "$0")/fixture.py" "$@"\n', true)
}
function manifest(path, image) {
  write(join(path, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, package: { arch: process.arch === 'arm64' ? 'arm64' : 'amd64' },
    source: { home: '/original-home', programRoot: '/original-program' },
    runtime: {}, files: collectEntries(path, ['manifest.json']), image,
  }))
}
const options = (path, prefix) => ({ bundleRoot: path, prefix, dataRoot: prefix + '-data', skipImage: false,
  skipPrepare: false, allowFixtureData: false, strictPaths: false, start: false, dryRun: false, json: false, port: 18120 })

test('npm 全局布局的 pnpm 入口被解引用后仍从包目录启动并支持安装目录迁移', () => {
  const path = bundle('pnpm-global-layout'), prefix = join(root, 'pnpm-global-program')
  write(join(path, 'offline/pnpm/bin/pnpm'), '#!/usr/bin/env node\nrequire("../dist/probe.cjs")\n', true)
  write(join(path, 'offline/pnpm/lib/node_modules/pnpm/package.json'), JSON.stringify({ bin: { pnpm: 'bin/pnpm.cjs' } }))
  write(join(path, 'offline/pnpm/lib/node_modules/pnpm/bin/pnpm.cjs'), 'require("../dist/probe.cjs")\n')
  write(join(path, 'offline/pnpm/lib/node_modules/pnpm/dist/probe.cjs'), 'console.log("11.28.5")\n')
  copyTree(join(path, 'program'), prefix)
  const runtime = installRuntime(path, prefix, prefix + '-data')
  assert.equal(runtime.versions.pnpm, '11.28.5')
  const moved = prefix + '-moved'
  renameSync(prefix, moved)
  const result = spawnSync(join(moved, 'runtime/pnpm/bin/pnpm'), ['--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '11.28.5')
})

test('全量更新保留现场身份、配置和会话，删除旧业务资产；prepare 失败恢复后可重试', async () => {
  const path = bundle('full-update-bundle'), prefix = join(root, 'full-update-program'), dataRoot = prefix + '-data'
  write(join(path, 'data/workspace.json'), JSON.stringify({ id: 'source-workspace', extensions: [{ id: 'new-extension', path: 'mcp' }] }))
  write(join(path, 'data/config/site.json'), 'source-config')
  write(join(path, 'data/agents/new-asset'), 'current-working-tree')
  manifest(path)
  const m = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))
  m.data = { sensitive: true }; write(join(path, 'manifest.json'), JSON.stringify(m))
  write(join(prefix, '.local/installation.json'), '{"old":true}')
  write(join(prefix, 'old-program'), 'old')
  write(join(dataRoot, 'workspace.json'), JSON.stringify({ id: 'target-workspace', legacyRoots: ['/old-root'], extensions: [{ id: 'removed-extension' }] }))
  write(join(dataRoot, 'config/site.json'), 'target-config')
  write(join(dataRoot, '.local/platform-home/sessions/saved'), 'target-session')
  write(join(dataRoot, 'agents/removed-asset'), 'obsolete')
  const opts = { ...options(path, prefix), allowFixtureData: true }
  assert.equal((await updateBundle({ ...opts, dryRun: true })).status, 'planned')
  assert.equal(readFileSync(join(prefix, 'old-program'), 'utf8'), 'old')
  process.env.HEP_TEST_PREPARE_FAILURE = '3'
  try { await assert.rejects(updateBundle(opts), /已恢复原安装.*prepare 失败/) }
  finally { delete process.env.HEP_TEST_PREPARE_FAILURE }
  assert.equal(readFileSync(join(prefix, 'old-program'), 'utf8'), 'old')
  assert.equal(readFileSync(join(dataRoot, 'agents/removed-asset'), 'utf8'), 'obsolete')
  assert.equal(existsSync(prefix + '.update-lock'), false)
  const firewall = join(root, 'update-firewall-bin'), previousPath = process.env.PATH
  write(join(firewall, 'firewall-cmd'), '#!/bin/sh\ncase "$*" in --state) exit 0;; --get-zone-of-interface=*) echo public; exit 0;; *--query-port=*) exit 1;; *) exit 13;; esac\n', true)
  write(join(firewall, 'ip'), '#!/bin/sh\necho \'[{"ifname":"lo","addr_info":[{"local":"127.0.0.1"}]}]\'\n', true)
  process.env.PATH = firewall + ':' + previousPath
  try { await assert.rejects(updateBundle({ ...opts, start: true, host: '127.0.0.1' }), /已恢复原安装.*防火墙配置失败/) }
  finally { process.env.PATH = previousPath }
  assert.equal(readFileSync(join(prefix, 'old-program'), 'utf8'), 'old')
  assert.equal(readFileSync(join(dataRoot, '.local/platform-home/sessions/saved'), 'utf8'), 'target-session')
  const result = await updateBundle(opts)
  assert.equal(result.status, 'updated'); assert.equal(result.prepare, 'ok')
  assert.equal(readFileSync(join(dataRoot, 'agents/new-asset'), 'utf8'), 'current-working-tree')
  assert.equal(existsSync(join(dataRoot, 'agents/removed-asset')), false)
  assert.equal(JSON.parse(readFileSync(join(dataRoot, 'workspace.json'), 'utf8')).id, 'target-workspace')
  assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, 'workspace.json'), 'utf8')).extensions, [{ id: 'new-extension', path: 'mcp' }])
  assert.ok(JSON.parse(readFileSync(join(dataRoot, 'workspace.json'), 'utf8')).legacyRoots.includes('/old-root'))
  assert.equal(readFileSync(join(dataRoot, 'config/site.json'), 'utf8'), 'target-config')
  assert.equal(readFileSync(join(dataRoot, '.local/platform-home/sessions/saved'), 'utf8'), 'target-session')
  assert.equal(readFileSync(join(result.backups.dataRoot, 'agents/removed-asset'), 'utf8'), 'obsolete')
  assert.equal(readFileSync(join(result.backups.prefix, 'old-program'), 'utf8'), 'old')
})

test('安装环境不依赖解包目录，特殊路径按原值进入 shell，Git 失败时明确拒绝', () => {
  const path = bundle('runtime-bundle')
  const prefix = join(root, "program space ' $(touch SHOULD_NOT_EXIST)")
  const data = join(root, "data ' $HOME `touch ALSO_NOT_EXIST`")
  write(join(path, 'offline/git/git'), '#!/bin/sh\nexit 9\n', true)
  assert.throws(() => installRuntime(path, prefix + '-failed', data), /缺少可执行的 Git/)
  write(join(path, 'offline/git/git'), '#!/bin/sh\necho git-version-bundled\n', true)
  copyTree(join(path, 'program'), prefix)
  const installed = installRuntime(path, prefix, data)
  assert.notEqual(installed.versions.git, 'unknown')
  assert.ok(installed.git.startsWith(prefix))
  renameSync(path, path + '-moved')
  const result = spawnSync('/bin/sh', ['-c', '. "$1/bin/hep-env.sh"; "$HEP_NODE" -p "JSON.stringify([process.env.HARNESS_PROGRAM_ROOT, process.env.HARNESS_ASSET_ROOT])"; git --version; "$HEP_PYTHON" -c "import hep_install_probe; print(hep_install_probe.VALUE)"', 'sh', prefix], { cwd: root, env: { ...process.env, HARNESS_ASSET_ROOT: '' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]), [prefix, data])
  assert.match(result.stdout, /git-version-bundled/)
  assert.match(result.stdout, /42/)
  assert.ok(!existsSync(join(root, 'SHOULD_NOT_EXIST')) && !existsSync(join(root, 'ALSO_NOT_EXIST')))
})

test('离线平台安装装载 LFX，整体迁移后仍使用随包解释器与依赖', () => {
  const path = bundle('lfx-runtime-bundle'), prefix = join(root, 'lfx-program')
  const lock = 'lfx==1.13.1\n'
  write(join(path, 'program/platform/mcp/lfx/requirements.txt'), lock)
  write(join(path, 'program/platform/mcp/lfx/hep_lfx.py'), 'VALUE = 43\n')
  copyTree(join(path, 'program'), prefix)
  assert.throws(() => installRuntime(path, prefix, prefix + '-data'), /缺少锁定的 LFX 1.13.1/)
  write(join(path, 'offline/python/site/lfx-1.13.1.dist-info/METADATA'), 'Metadata-Version: 2.1\nName: lfx\nVersion: 1.13.1\n')
  installRuntime(path, prefix, prefix + '-data')
  const digest = createHash('sha256').update(lock).digest('hex')
  assert.equal(readFileSync(join(prefix, '.local/lfx', digest, '.ready'), 'utf8'), digest)
  const moved = prefix + '-moved'
  renameSync(prefix, moved)
  const result = spawnSync(join(moved, '.local/lfx', digest, 'bin/python'), ['-c', 'import hep_install_probe; from importlib.metadata import version; print(hep_install_probe.VALUE, version("lfx"))'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /42 1.13.1/)
})

test('安装 prepare 使用同一环境；失败清理后可以原命令重试', () => {
  const path = bundle('retry-bundle'), prefix = join(root, 'retry-program')
  writeLauncher(path, 'import hep_install_probe, os, sys\nassert hep_install_probe.VALUE == 42\nsys.exit(int(os.environ.get("HEP_TEST_PREPARE_FAILURE", "0")))\n')
  manifest(path)
  process.env.HEP_TEST_PREPARE_FAILURE = '3'
  try { assert.throws(() => install(options(path, prefix)), /prepare 失败/) }
  finally { delete process.env.HEP_TEST_PREPARE_FAILURE }
  assert.equal(existsSync(prefix), false)
  assert.equal(install(options(path, prefix)).prepare, 'ok')
})

test('安装公开入口先校验，干运行也拒绝凭据与片段且不创建目录', () => {
  const path = bundle('public-url-bundle'), prefix = join(root, 'public-url-program')
  writeLauncher(path, 'import sys\n')
  manifest(path)
  for (const publicUrl of ['https://user:password@platform.example/hep/', 'https://platform.example/hep/#fragment']) {
    assert.throws(() => install({ ...options(path, prefix), host: '127.0.0.1', publicUrl, dryRun: true }))
    assert.equal(existsSync(prefix), false)
  }
})

test('安装拒绝 Python 携带 glibc，工具版本失败保留具体命令和原因', () => {
  const path = bundle('python-libc-bundle')
  const libc = join(path, 'offline/python/lib/libc.so.6')
  write(libc, '')
  assert.throws(() => installRuntime(path, join(root, 'python-libc-program'), join(root, 'python-libc-data')), /使用目标系统 glibc/)
  rmSync(libc)
  write(join(path, 'offline/pnpm/bin/pnpm'), '#!/bin/sh\necho incompatible-runtime >&2\nexit 9\n', true)
  assert.throws(() => installRuntime(path, join(root, 'pnpm-failed-program'), join(root, 'pnpm-failed-data')),
    /pnpm.*退出码 9.*incompatible-runtime/)
})

test('安装后启动放行平台和网关端口并启用自启动；防火墙失败保留目录且不启动', () => {
  const path = bundle('start-bundle'), prefix = join(root, 'start-program'), output = join(root, 'start-arguments.json'), autostart = join(root, 'autostart-arguments.json')
  writeLauncher(path, 'import json, os, sys\nif sys.argv[1] == "prepare":\n    config = os.path.join(os.environ["HARNESS_ASSET_ROOT"], "config")\n    os.makedirs(config, exist_ok=True)\n    open(os.path.join(config, "business-access.json"), "w").write(json.dumps({"enabled": True, "gateway": {"port": 53105}}))\nif sys.argv[1] == "start":\n    open(os.environ["HEP_TEST_START_FILE"], "w").write(json.dumps(sys.argv[2:]))\nif sys.argv[1] == "autostart":\n    open(os.environ["HEP_TEST_AUTOSTART_FILE"], "w").write(json.dumps(sys.argv[2:]))\n')
  const fakeBin = join(root, 'start-firewall-bin'), calls = join(root, 'start-firewall-calls.jsonl')
  write(join(fakeBin, 'firewall-cmd'), `#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.HEP_TEST_FIREWALL_LOG,JSON.stringify(a)+'\\n');if(a.includes('--state'))process.exit(0);if(a.some(x=>x.startsWith('--get-zone-of-interface'))){console.log('public');process.exit(0)}if(a.some(x=>x.startsWith('--query-port')))process.exit(1);process.exit(process.env.HEP_TEST_FIREWALL_DENY==='yes'?13:0);\n`, true)
  write(join(fakeBin, 'ip'), `#!${process.execPath}\nconsole.log(JSON.stringify([{ifname:'lo',addr_info:[{local:'127.0.0.1'}]}]));\n`, true)
  manifest(path)
  const previousPath = process.env.PATH
  process.env.PATH = fakeBin + ':' + previousPath
  process.env.HEP_TEST_START_FILE = output
  process.env.HEP_TEST_AUTOSTART_FILE = autostart
  process.env.HEP_TEST_FIREWALL_LOG = calls
  try {
    install({ ...options(path, prefix), host: '127.0.0.1', port: 18121, start: true })
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), ['--host', '127.0.0.1', '--port', '18121'])
    assert.deepEqual(JSON.parse(readFileSync(autostart, 'utf8')), ['enable'])
    const changes = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.some(value => value.startsWith('--add-port')))
    assert.deepEqual(changes, [
      ['--zone=public', '--add-port=18121/tcp'], ['--zone=public', '--permanent', '--add-port=18121/tcp'],
      ['--zone=public', '--add-port=53105/tcp'], ['--zone=public', '--permanent', '--add-port=53105/tcp'],
    ])
    rmSync(output)
    process.env.HEP_TEST_FIREWALL_DENY = 'yes'
    assert.throws(() => install({ ...options(path, prefix + '-denied'), host: '127.0.0.1', start: true }), /安装目录已保留.*防火墙配置失败/)
    assert.ok(existsSync(prefix + '-denied') && existsSync(prefix + '-denied-data'))
    assert.equal(existsSync(output), false)
  } finally {
    process.env.PATH = previousPath
    delete process.env.HEP_TEST_START_FILE
    delete process.env.HEP_TEST_AUTOSTART_FILE
    delete process.env.HEP_TEST_FIREWALL_LOG
    delete process.env.HEP_TEST_FIREWALL_DENY
  }
})

test('包内 Git 可用时优先使用，包内和系统均不可用时明确失败', () => {
  const path = bundle('git-bundle')
  copyTree(join(path, 'program'), join(root, 'git-program'))
  assert.equal(installRuntime(path, join(root, 'git-program'), join(root, 'git-data')).versions.git, 'git-version-bundled')
  write(join(path, 'offline/git/git'), '#!/bin/sh\nexit 9\n', true)
  const previous = process.env.PATH
  const system = join(root, 'unusable-system')
  write(join(system, 'python3'), '#!/bin/sh\necho Python\n', true)
  write(join(system, 'git'), '#!/bin/sh\nexit 8\n', true)
  process.env.PATH = system
  try { assert.throws(() => installRuntime(path, join(root, 'no-git-program'), join(root, 'no-git-data')), /缺少可执行的 Git/) }
  finally { process.env.PATH = previous }
})

test('Docker 归档识别标签、ID、多标签同镜像，并拒绝歧义和身份不符', () => {
  const fakeBin = join(root, 'docker-bin'), id = 'sha256:' + 'a'.repeat(64), other = 'sha256:' + 'b'.repeat(64)
  write(join(fakeBin, 'docker'), `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='load') console.log(process.env.HEP_TEST_LOAD); else if(a[0]==='version') console.log('amd64'); else console.log(JSON.stringify([{Id:a.at(-1)==='other:tag'?'${other}':'${id}',Architecture:'${process.arch === 'arm64' ? 'arm64' : 'amd64'}',Os:'linux',Config:{Labels:{'org.ai-agent-harness.dsh.image-build-fingerprint':'expected'}}}]));\n`, true)
  const previous = process.env.PATH
  process.env.PATH = fakeBin + ':' + previous
  try {
    for (const output of ['Loaded image: hep:latest', `Loaded image ID: ${id}`, 'Loaded image: hep:a\nLoaded image: hep:b']) {
      process.env.HEP_TEST_LOAD = output
      assert.equal(loadVerifiedImage('archive.tar', {}).id, id)
    }
    process.env.HEP_TEST_LOAD = 'Loaded image: hep:a\nLoaded image: other:tag'
    assert.throws(() => loadVerifiedImage('archive.tar', {}), /2 个/)
    assert.equal(loadVerifiedImage('archive.tar', { tag: 'hep:a' }).id, id)
    process.env.HEP_TEST_LOAD = 'Loaded image: hep:a'
    assert.throws(() => loadVerifiedImage('archive.tar', { id: other }), /ID 不符/)
    assert.throws(() => loadVerifiedImage('archive.tar', { fingerprint: 'wrong' }), /指纹不符/)
    const path = bundle('image-bundle'), prefix = join(root, 'image-program')
    write(join(path, 'image.tar'), 'external docker boundary fixture')
    manifest(path, { archive: 'image.tar' })
    assert.throws(() => install({ ...options(path, prefix), dryRun: true }), /镜像身份不完整/)
    manifest(path, { archive: 'image.tar', tag: 'hep:a', id, fingerprint: 'expected', arch: process.arch === 'arm64' ? 'arm64' : 'amd64' })
    const reused = install(options(path, prefix))
    assert.equal(reused.image.id, id)
    assert.equal(reused.image.reused, true)
    manifest(path, { archive: 'image.tar', tag: 'hep:a', id, fingerprint: 'wrong', arch: process.arch === 'arm64' ? 'arm64' : 'amd64' })
    assert.throws(() => install(options(path, prefix + '-failed')), /指纹不符/)
    assert.equal(existsSync(prefix + '-failed'), false)
  } finally { process.env.PATH = previous; delete process.env.HEP_TEST_LOAD }
})

test('已有标准 Runtime 镜像身份匹配时直接复用，不重复导入归档', () => {
  const fakeBin = join(root, 'reuse-image-bin'), id = 'sha256:' + 'c'.repeat(64)
  write(join(fakeBin, 'docker'), `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='image' && a[1]==='inspect') console.log(JSON.stringify([{Id:'${id}',Architecture:'${process.arch === 'arm64' ? 'arm64' : 'amd64'}',Os:'linux',Config:{Labels:{'org.ai-agent-harness.dsh.image-build-fingerprint':'expected'}}}])); else process.exit(1);\n`, true)
  const previous = process.env.PATH
  process.env.PATH = fakeBin + ':' + previous
  try {
    assert.equal(findVerifiedImage({ tag: 'hep:standard', id, arch: process.arch === 'arm64' ? 'arm64' : 'amd64', fingerprint: 'expected' })?.id, id)
    assert.equal(findVerifiedImage({ tag: 'hep:standard', id, arch: process.arch === 'arm64' ? 'arm64' : 'amd64', fingerprint: 'wrong' }), undefined)
  } finally { process.env.PATH = previous }
})

test('打包前从 Docker 归档核对标签、配置摘要、架构和构建指纹', () => {
  const dir = join(root, 'archive-fixture'), archive = join(root, 'archive-fixture.tar')
  const config = JSON.stringify({ architecture: 'arm64', os: 'linux', config: { Labels: {
    'org.ai-agent-harness.dsh.image-build-fingerprint': 'expected',
  } } })
  const digest = createHash('sha256').update(config).digest('hex')
  write(join(dir, `${digest}.json`), config)
  write(join(dir, 'manifest.json'), JSON.stringify([{ Config: `${digest}.json`, RepoTags: ['hep:standard'], Layers: [] }]))
  assert.equal(spawnSync('tar', ['-C', dir, '-cf', archive, 'manifest.json', `${digest}.json`]).status, 0)
  const info = inspectImageArchive(archive, 'hep:standard')
  assert.equal(info.id, `sha256:${digest}`)
  assert.deepEqual(verifyImageInfo(info, { arch: 'arm64', fingerprint: 'expected' }), [])
  for (const changed of [{ id: 'hep:latest' }, { id: 'sha256:' + '0'.repeat(64) }, { arch: 'amd64' }, { os: 'windows' }, { labels: {} }]) {
    assert.ok(verifyImageInfo({ ...info, ...changed }, { id: info.id, arch: 'arm64', fingerprint: 'expected' }).length, JSON.stringify(changed))
  }
  assert.match(verifyImageInfo(info, { fingerprint: 'wrong' }).join(''), /指纹不符/)
  assert.throws(() => inspectImageArchive(archive, 'hep:poc'), error => {
    assert.ok(error.message.includes(archive))
    assert.match(error.message, /期望 hep:poc 唯一匹配，实际匹配 0 项，归档标签 hep:standard/)
    return true
  })
  write(join(dir, 'manifest.json'), JSON.stringify(Array(2).fill({ Config: `${digest}.json`, RepoTags: ['hep:standard'], Layers: [] })))
  assert.equal(spawnSync('tar', ['-C', dir, '-cf', archive, 'manifest.json', `${digest}.json`]).status, 0)
  assert.throws(() => inspectImageArchive(archive, 'hep:standard'), /实际匹配 2 项/)
  write(join(dir, 'manifest.json'), JSON.stringify([{ Config: `${digest}.json`, RepoTags: ['hep:standard'], Layers: [] }]))
  write(join(dir, `${digest}.json`), config + '\n')
  assert.equal(spawnSync('tar', ['-C', dir, '-cf', archive, 'manifest.json', `${digest}.json`]).status, 0)
  assert.throws(() => inspectImageArchive(archive, 'hep:standard'), error => {
    assert.ok(error.message.includes(archive))
    assert.ok(error.message.includes(`期望 sha256:${digest}，实际 sha256:${createHash('sha256').update(config + '\n').digest('hex')}`))
    return true
  })
  write(join(dir, `${digest}.json`), config)
  const oci = JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${digest}` }, layers: [] })
  const ociDigest = createHash('sha256').update(oci).digest('hex')
  write(join(dir, 'blobs/sha256', ociDigest), oci)
  write(join(dir, 'index.json'), JSON.stringify({ manifests: [{ digest: `sha256:${ociDigest}` }] }))
  assert.equal(spawnSync('tar', ['-C', dir, '-cf', archive, 'manifest.json', `${digest}.json`, 'index.json', 'blobs']).status, 0)
  assert.equal(inspectImageArchive(archive, 'hep:standard').id, `sha256:${ociDigest}`)
  const nested = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${ociDigest}` }] })
  const nestedDigest = createHash('sha256').update(nested).digest('hex')
  write(join(dir, 'blobs/sha256', nestedDigest), nested)
  write(join(dir, 'index.json'), JSON.stringify({ manifests: [{ digest: `sha256:${nestedDigest}` }] }))
  assert.equal(spawnSync('tar', ['-C', dir, '-cf', archive, 'manifest.json', `${digest}.json`, 'index.json', 'blobs']).status, 0)
  assert.equal(inspectImageArchive(archive, 'hep:standard').id, `sha256:${nestedDigest}`)
})

test('安装 shell 在成功、失败、dry-run 后清理临时目录并保留退出码；CLI 拒绝未知选项', () => {
  const path = bundle('shell-bundle'), temporary = join(root, 'temporary')
  mkdirSync(temporary)
  const installer = new URL('../install.sh', import.meta.url)
  write(join(path, 'install.sh'), readFileSync(installer), true)
  write(join(path, 'program/platform/deploy/cli.mts'), 'process.exit(process.argv.includes("--fail-fixture") ? 7 : 0)\n')
  for (const args of [[], ['--dry-run'], ['--fail-fixture']]) {
    const result = spawnSync('/bin/sh', [join(path, 'install.sh'), ...args], { env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8' })
    assert.equal(result.status, args.includes('--fail-fixture') ? 7 : 0, result.stderr)
    assert.deepEqual(readdirSync(temporary), [])
  }
  for (const args of [['install', '--install-docker'], ['pack', '--arch'], ['install', '--skip-image=typo'], ['install', '--bundle-root', path, '--host', 'bad'], ['install', '--bundle-root', path, '--gateway-port', '53106'], ['install', '--bundle-root', path, '--port', '18121']]) {
    const result = spawnSync(process.execPath, [new URL('../cli.mts', import.meta.url).pathname, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /不支持的选项|需要值|只能使用|IPv4|需要同时指定/)
  }
})
