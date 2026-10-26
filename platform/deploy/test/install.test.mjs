import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { installRuntime } from '../runtime.mts'
import { install } from '../install.mts'
import { copyTree } from '../fsutil.mts'
import { collectEntries } from '../manifest.mts'
import { inspectImageArchive, loadVerifiedImage, verifyImageInfo } from '../image.mts'

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
  write(join(path, 'offline/dsh/apps/cli/lib/bin.js'), 'console.log("0.2.1-rc.2")\n')
  write(join(path, 'program/platform/plugin/package.json'), JSON.stringify({peerDependencies:{'@deepseek-ai/dsh-client-connection':'0.2.1-rc.2'}}))
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
  const result = spawnSync('/bin/sh', ['-c', '. "$1/bin/hep-env.sh"; "$HEP_NODE" -p "JSON.stringify([process.env.HARNESS_PROGRAM_ROOT, process.env.HARNESS_ASSET_ROOT])"; git --version; "$HEP_PYTHON" -c "import hep_install_probe; print(hep_install_probe.VALUE)"', 'sh', prefix], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]), [prefix, data])
  assert.match(result.stdout, /git-version-bundled/)
  assert.match(result.stdout, /42/)
  assert.ok(!existsSync(join(root, 'SHOULD_NOT_EXIST')) && !existsSync(join(root, 'ALSO_NOT_EXIST')))
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

test('安装后启动沿用目标主机与平台端口', () => {
  const path = bundle('start-bundle'), prefix = join(root, 'start-program'), output = join(root, 'start-arguments.json')
  writeLauncher(path, 'import json, os, sys\nif sys.argv[1] == "start":\n    open(os.environ["HEP_TEST_START_FILE"], "w").write(json.dumps(sys.argv[2:]))\n')
  manifest(path)
  process.env.HEP_TEST_START_FILE = output
  try { install({ ...options(path, prefix), host: '127.0.0.1', port: 18121, start: true }) }
  finally { delete process.env.HEP_TEST_START_FILE }
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), ['--host', '127.0.0.1', '--port', '18121'])
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
  write(join(fakeBin, 'docker'), `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='load') console.log(process.env.HEP_TEST_LOAD); else if(a[0]==='version') console.log('amd64'); else console.log(JSON.stringify([{Id:a.at(-1)==='other:tag'?'${other}':'${id}',Architecture:'${process.arch === 'arm64' ? 'arm64' : 'amd64'}',Config:{Labels:{'org.ai-agent-harness.dsh.image-build-fingerprint':'expected'}}}]));\n`, true)
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
    assert.equal(install(options(path, prefix)).image.id, id)
    manifest(path, { archive: 'image.tar', tag: 'hep:a', id, fingerprint: 'wrong', arch: process.arch === 'arm64' ? 'arm64' : 'amd64' })
    assert.throws(() => install(options(path, prefix + '-failed')), /指纹不符/)
    assert.equal(existsSync(prefix + '-failed'), false)
  } finally { process.env.PATH = previous; delete process.env.HEP_TEST_LOAD }
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
  assert.match(verifyImageInfo(info, { fingerprint: 'wrong' }).join(''), /指纹不符/)
  assert.throws(() => inspectImageArchive(archive, 'hep:poc'), /标准标签/)
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
