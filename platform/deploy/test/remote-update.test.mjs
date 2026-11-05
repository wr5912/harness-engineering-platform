import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyUpdate, decodeUpdate, encodeUpdate, inspectUpdate, prepareDependencyDelta, refreshMinimalData, updateRemote } from '../remote-update.mts'

const hash = value => createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'hep-update-test-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const target = { prefix: join(base, 'program'), dataRoot: join(base, 'data') }
  const repositories = Object.values(target).map(root => {
    mkdirSync(root); execFileSync('git', ['init', '-q', root]); writeFileSync(join(root, 'asset'), 'old')
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline'])
    const before = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()
    return { root, before, commit: before, files: [{ path: 'asset', before: hash('old'), content: Buffer.from('new').toString('base64'), mode: 0o644 }] }
  })
  mkdirSync(join(target.prefix, '.local'))
  writeFileSync(join(target.prefix, '.local/installation.json'), JSON.stringify({ schemaVersion: 1, files: [], package: {}, data: {} }))
  return { target, update: { repositories, artifacts: [] } }
}

test('增量更新保留 inode、现场配置及无关改动；dry-run 和重试不覆盖', t => {
  const { target, update } = fixture(t), file = join(target.prefix, 'asset'), inode = statSync(file).ino
  mkdirSync(join(target.dataRoot, 'config')); writeFileSync(join(target.dataRoot, 'config/local.json'), 'live')
  writeFileSync(join(target.dataRoot, 'unrelated'), 'parallel')
  assert.equal(applyUpdate({ ...target, dryRun: true }, update).status, 'planned')
  assert.equal(readFileSync(file, 'utf8'), 'old')
  const report = applyUpdate(target, update)
  assert.equal(report.status, 'updated'); assert.equal(report.files, 2)
  assert.equal(readFileSync(file, 'utf8'), 'new'); assert.equal(statSync(file).ino, inode)
  assert.equal(readFileSync(join(target.dataRoot, 'config/local.json'), 'utf8'), 'live')
  assert.equal(readFileSync(join(target.dataRoot, 'unrelated'), 'utf8'), 'parallel')
  assert.equal(statSync(report.backup).mode & 0o777, 0o700)
  assert.equal(applyUpdate(target, update).status, 'unchanged')
  assert.equal(inspectUpdate(target).program, update.repositories[0].before)
})

test('本机安装目录复用增量工具，冻结提交、预演、应用和重试均保留现场数据', t => {
  const { target } = fixture(t)
  const sources = [target.prefix, target.dataRoot].map(root => {
    const source = `${root}-source`
    execFileSync('git', ['clone', '-q', root, source])
    writeFileSync(join(source, 'asset'), 'new')
    return source
  })
  const program = sources[0]
  for (const directory of ['platform/plugin', 'runtime/adapters/dsh-web']) {
    mkdirSync(join(program, directory, 'node_modules'), { recursive: true })
    writeFileSync(join(program, directory, '.gitignore'), 'node_modules/\nlib/\nbusiness/\n')
  }
  writeFileSync(join(program, 'platform/plugin/build.mjs'), `import {mkdirSync,writeFileSync} from 'node:fs';
for (const directory of ['lib','business','../../runtime/adapters/dsh-web/lib']) {mkdirSync(directory,{recursive:true});writeFileSync(directory+'/index.js','built')}\n`)
  for (const source of sources) {
    execFileSync('git', ['-C', source, 'add', '.'])
    execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'update'])
  }
  mkdirSync(join(target.prefix, 'bin')); writeFileSync(join(target.prefix, 'bin/hep-env.sh'), 'export HEP_OFFLINE=1\n')
  mkdirSync(join(target.prefix, 'runtime/node/bin'), { recursive: true })
  symlinkSync(process.execPath, join(target.prefix, 'runtime/node/bin/node'))
  mkdirSync(join(target.dataRoot, 'config')); writeFileSync(join(target.dataRoot, 'config/local.json'), 'private-local')
  // 来源工作树的未提交内容不得混入冻结的安装更新。
  writeFileSync(join(program, 'asset'), 'uncommitted')
  assert.equal(updateRemote(undefined, { ...target, dryRun: true }, ...sources), 0)
  assert.equal(readFileSync(join(target.prefix, 'asset'), 'utf8'), 'old')
  assert.equal(updateRemote(undefined, target, ...sources), 0)
  for (const root of [target.prefix, target.dataRoot]) assert.equal(readFileSync(join(root, 'asset'), 'utf8'), 'new')
  assert.equal(readFileSync(join(target.prefix, 'platform/plugin/lib/index.js'), 'utf8'), 'built')
  assert.equal(readFileSync(join(target.dataRoot, 'config/local.json'), 'utf8'), 'private-local')
  assert.equal(updateRemote(undefined, target, ...sources), 0)
})

test('冲突、现场配置、目录越界和符号链接在写入前拒绝', t => {
  const { target, update } = fixture(t), file = join(target.prefix, 'asset')
  writeFileSync(file, 'parallel'); assert.throws(() => applyUpdate(target, update), /冲突/)
  writeFileSync(file, 'old')
  for (const path of ['../escape', '/absolute', '.git/HEAD']) {
    update.repositories[0].files[0].path = path
    assert.throws(() => applyUpdate(target, update), /路径无效/)
  }
  update.repositories[0].files[0].path = 'asset'
  update.repositories[1].files[0].path = 'config/test.json'
  assert.throws(() => applyUpdate(target, update), /现场配置/)
  update.repositories[1].files[0].path = 'asset'
  rmSync(file); symlinkSync(join(target.dataRoot, 'asset'), file)
  assert.throws(() => applyUpdate(target, update), /符号链接/)
  assert.equal(readFileSync(join(target.dataRoot, 'asset'), 'utf8'), 'old')
})

test('Git 推进失败恢复已写文件和安装清单，留下回执并释放锁', t => {
  const { target, update } = fixture(t), manifest = join(target.prefix, '.local/installation.json'), original = readFileSync(manifest)
  update.repositories[1].commit = 'f'.repeat(40)
  assert.throws(() => applyUpdate(target, update), /已回滚/)
  for (const repo of update.repositories) assert.equal(readFileSync(join(repo.root, 'asset'), 'utf8'), 'old')
  assert.deepEqual(readFileSync(manifest), original)
  assert.equal(existsSync(join(target.prefix, '.local/deploy-update.lock')), false)
})

test('Git 增量包推进两仓 HEAD 并保留现场脏改动', t => {
  const { target, update } = fixture(t)
  const pending = join(target.prefix, '.local/deploy-activation.json')
  const snapshot = { state: { pid: 123 }, sessions: ['kept-session'] }
  writeFileSync(pending, JSON.stringify({ ...target, commit: update.repositories[0].before, snapshot }))
  for (const [index, repo] of update.repositories.entries()) {
    const source = `${repo.root}-source`
    execFileSync('git', ['clone', '-q', repo.root, source])
    writeFileSync(join(source, 'asset'), 'new')
    execFileSync('git', ['-C', source, 'add', '.'])
    execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'update'])
    repo.commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD']).toString().trim()
    const bundle = join(source, 'delta.bundle')
    execFileSync('git', ['-C', source, 'bundle', 'create', bundle, 'HEAD', `^${repo.before}`])
    repo.bundle = readFileSync(bundle).toString('base64')
    writeFileSync(join(repo.root, 'untracked'), `keep-${index}`)
  }
  assert.equal(applyUpdate(target, update).status, 'updated')
  assert.deepEqual(JSON.parse(readFileSync(pending)), { ...target, commit: update.repositories[0].commit, snapshot })
  for (const [index, repo] of update.repositories.entries()) {
    assert.equal(execFileSync('git', ['-C', repo.root, 'rev-parse', 'HEAD']).toString().trim(), repo.commit)
    assert.equal(readFileSync(join(repo.root, 'untracked'), 'utf8'), `keep-${index}`)
    assert.equal(execFileSync('git', ['-C', repo.root, 'diff', '--name-only']).toString(), '')
  }
})

test('实例预检重建的 Web 制品必须可复现，更新后修订清单；篡改和脏源码仍拒绝', t => {
  const { target, update } = fixture(t)
  const adapter = join(target.prefix, 'runtime/adapters/dsh-web'), path = 'runtime/adapters/dsh-web/lib/index.mjs'
  mkdirSync(join(adapter, 'lib'), { recursive: true })
  writeFileSync(join(adapter, '.gitignore'), 'lib/\n')
  writeFileSync(join(adapter, 'source.txt'), 'rebuilt-with-local-dependency-path')
  writeFileSync(join(adapter, 'build.mjs'), `import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; const output=process.argv[3]; mkdirSync(output,{recursive:true}); writeFileSync(join(output,'index.mjs'),readFileSync('source.txt'))`)
  execFileSync('git', ['-C', target.prefix, 'add', 'runtime'])
  execFileSync('git', ['-C', target.prefix, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'builder'])
  for (const repo of update.repositories) { repo.before = repo.commit = execFileSync('git', ['-C', repo.root, 'rev-parse', 'HEAD']).toString().trim(); repo.files = [] }
  const manifest = join(target.prefix, '.local/installation.json')
  const original = JSON.stringify({ schemaVersion: 1, files: [{ path: `program/${path}`, sha256: hash('packaged-with-other-path'), mode: 0o644 }], package: {}, data: {} })
  writeFileSync(manifest, original)
  writeFileSync(join(target.prefix, path), 'rebuilt-with-local-dependency-path')
  assert.deepEqual(inspectUpdate(target).revalidated, [path])
  assert.equal(applyUpdate({ ...target, dryRun: true }, update).status, 'planned')
  assert.equal(readFileSync(manifest, 'utf8'), original)
  const report = applyUpdate(target, update)
  assert.equal(report.status, 'updated'); assert.equal(report.files, 0)
  assert.deepEqual(report.revalidatedArtifacts, [path])
  assert.equal(inspectUpdate(target).revalidated.length, 0)
  assert.equal(readFileSync(join(report.backup, 'installation.json'), 'utf8'), original)
  writeFileSync(join(target.prefix, path), 'tampered')
  assert.throws(() => inspectUpdate(target), /无法复现/)
  writeFileSync(join(adapter, 'source.txt'), 'dirty')
  assert.throws(() => inspectUpdate(target), /源码有现场修改/)
})

test('最小数据只更新管理资产；保留本地智能体及配置，不导入完整研究历史', t => {
  const { target } = fixture(t), source = target.prefix, minimal = target.dataRoot
  for (const path of ['AGENTS.md', '.agents/skills/test/SKILL.md', 'docs/reference.md', 'agents/source-only/asset', 'evolution/source-only/result']) {
    mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), path)
  }
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'full source'])
  mkdirSync(join(minimal, 'agents/local'), { recursive: true }); writeFileSync(join(minimal, 'agents/local/asset'), 'keep')
  writeFileSync(join(minimal, 'workspace.json'), 'local identity')
  refreshMinimalData(minimal, source)
  assert.equal(readFileSync(join(minimal, '.agents/skills/test/SKILL.md'), 'utf8'), '.agents/skills/test/SKILL.md')
  assert.equal(existsSync(join(minimal, 'agents/source-only')), false)
  assert.equal(existsSync(join(minimal, 'evolution')), false)
  assert.equal(readFileSync(join(minimal, 'agents/local/asset'), 'utf8'), 'keep')
  assert.equal(readFileSync(join(minimal, 'workspace.json'), 'utf8'), 'local identity')
  const before = execFileSync('git', ['-C', minimal, 'rev-parse', 'HEAD'])
  refreshMinimalData(minimal, source)
  assert.deepEqual(execFileSync('git', ['-C', minimal, 'rev-parse', 'HEAD']), before)
})

test('离线依赖增量只携带缺少的纯 JS 依赖，保留目标架构已有二进制', t => {
  const { target } = fixture(t), directory = 'platform/plugin', base = join(target.prefix, directory)
  mkdirSync(join(base, 'node_modules/.pnpm/native/node_modules/native'), { recursive: true })
  mkdirSync(join(base, 'node_modules/.pnpm/pure/node_modules/pure'), { recursive: true })
  writeFileSync(join(base, 'node_modules/.pnpm/native/node_modules/native/addon.node'), Buffer.from([127, 69, 76, 70]))
  writeFileSync(join(base, 'node_modules/.pnpm/native/node_modules/native/package.json'), '{"name":"native"}')
  writeFileSync(join(base, 'node_modules/.pnpm/pure/node_modules/pure/index.js'), 'export const value = 1')
  writeFileSync(join(base, 'node_modules/.pnpm/pure/node_modules/pure/package.json'), '{"name":"pure","bin":{"pure":"index.js"}}')
  symlinkSync('.pnpm/native/node_modules/native', join(base, 'node_modules/native'))
  symlinkSync('.pnpm/pure/node_modules/pure', join(base, 'node_modules/pure'))
  writeFileSync(join(base, 'package.json'), JSON.stringify({ dependencies: { pure: '1', native: '1' } }))
  writeFileSync(join(base, 'pnpm-lock.yaml'), 'lock')
  writeFileSync(join(base, 'node_modules/.pnpm/lock.yaml'), 'lock')
  execFileSync('git', ['-C', target.prefix, 'add', `${directory}/package.json`, `${directory}/pnpm-lock.yaml`])
  execFileSync('git', ['-C', target.prefix, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'dependency contract'])
  const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64'
  const delta = prepareDependencyDelta(target.prefix, directory, ['native'], otherArch)
  const files = execFileSync('tar', ['-tzf', '-'], { input: Buffer.from(delta.archive, 'base64') }).toString()
  assert.match(files, /pure\/index.js/); assert.doesNotMatch(files, /addon.node/)
  assert.equal(delta.bins.pure, '../pure/index.js')
  assert.throws(() => prepareDependencyDelta(target.prefix, directory, [], otherArch), /架构二进制/)
  writeFileSync(join(base, 'node_modules/.pnpm/lock.yaml'), 'stale')
  assert.throws(() => prepareDependencyDelta(target.prefix, directory, ['native'], otherArch), /锁文件不一致/)
})

test('旧安装清单只按 Git 精确核对修订；不能用现场源码替换清单', t => {
  const { target, update } = fixture(t), before = update.repositories[0].before
  writeFileSync(join(target.prefix, 'asset'), 'committed update')
  execFileSync('git', ['-C', target.prefix, 'add', 'asset'])
  execFileSync('git', ['-C', target.prefix, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'source update'])
  update.repositories[0].before = update.repositories[0].commit = execFileSync('git', ['-C', target.prefix, 'rev-parse', 'HEAD']).toString().trim()
  update.repositories.forEach(repo => repo.files = [])
  const manifest = join(target.prefix, '.local/installation.json')
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, files: [{ path: 'program/asset', type: 'file', sha256: hash('old'), mode: 0o644 }], package: { commit: before }, data: {} }))
  assert.equal(applyUpdate(target, update).status, 'updated')
  assert.equal(JSON.parse(readFileSync(manifest)).files[0].sha256, hash('committed update'))
  const legacy = JSON.parse(readFileSync(manifest)); legacy.package.commit = before; legacy.files[0].sha256 = hash('old')
  writeFileSync(manifest, JSON.stringify(legacy)); writeFileSync(join(target.prefix, 'asset'), 'uncommitted change')
  assert.throws(() => inspectUpdate(target), /未确认修改/)
})

test('离线准备损坏依赖后，从工具备份验证恢复并重建可执行入口', t => {
  const { target, update } = fixture(t), directory = 'platform/plugin'
  const backup = join(target.prefix, '.local/deploy-updates/previous'), modules = join(backup, 'node_modules-0')
  const packagePath = '.pnpm/native/node_modules/native'
  mkdirSync(join(target.prefix, directory, 'node_modules'), { recursive: true })
  mkdirSync(join(modules, packagePath), { recursive: true })
  writeFileSync(join(target.prefix, directory, 'package.json'), '{"dependencies":{"native":"1"}}')
  writeFileSync(join(modules, packagePath, 'cli.js'), 'original target executable')
  symlinkSync(packagePath, join(modules, 'native'))
  writeFileSync(join(backup, 'receipt.json'), JSON.stringify({ status: 'updated', dependencies: [directory] }))
  writeFileSync(join(backup, 'installation.json'), JSON.stringify({ files: [
    { path: `program/${directory}/node_modules/native`, type: 'symlink', target: packagePath },
    { path: `program/${directory}/node_modules/${packagePath}/cli.js`, type: 'file', sha256: hash('original target executable') },
  ] }))
  const archive = execFileSync('tar', ['-czf', '-', '-C', modules, 'native'])
  update.repositories.forEach(repo => repo.files = [])
  update.dependencies = [{ directory, archive: archive.toString('base64'), remove: ['native'], bins: { native: '../native/cli.js' } }]
  assert.equal(inspectUpdate(target).dependencyBases[directory], modules)
  assert.throws(() => applyUpdate(target, update), /install-deps/)
  assert.equal(applyUpdate({ ...target, installDeps: true }, update).status, 'updated')
  assert.equal(readFileSync(join(target.prefix, directory, 'node_modules/.bin/native'), 'utf8'), 'original target executable')
  assert.deepEqual(inspectUpdate(target).repairDependencies, [])
})

test('分条压缩包完整还原 Git 包和去重文件，缺失内容不会写入', t => {
  const { target, update } = fixture(t)
  const content = update.repositories[0].files[0].content, id = hash(Buffer.from(content, 'base64'))
  update.blobs = { [id]: content }
  update.repositories[0].files[0].content = `@${id}`
  const restored = decodeUpdate(encodeUpdate(update))
  assert.deepEqual(restored, update)
  delete restored.blobs[id]
  assert.throws(() => applyUpdate(target, restored), /内容缺失/)
  assert.equal(readFileSync(join(target.prefix, 'asset'), 'utf8'), 'old')
  assert.equal(applyUpdate(target, decodeUpdate(encodeUpdate(update))).status, 'updated')
})

test('工作区与安装目录更新保留各自入口，目标不完整时不触发更新', () => {
  const cli = new URL('../cli.mts', import.meta.url).pathname
  const invoke = args => execFileSync(process.execPath, [cli, 'update', ...args], { encoding: 'utf8', stdio: 'pipe' })
  assert.throws(() => invoke(['--program-root', '/tmp/hep-pull-no-such-program-jy45a6e', '--data-root', '/tmp/hep-pull-no-such-data-jy45a6e', '--dry-run']), error => /ENOENT/.test(error.stderr))
  assert.throws(() => invoke(['--prefix', '/tmp/unused']), error => /update 需要 --prefix 和 --remote-data-root/.test(error.stderr))
  assert.throws(() => invoke(['--ssh', 'invalid target', '--prefix', '/tmp/unused', '--remote-data-root', '/tmp/unused']), error => /SSH 目标无效/.test(error.stderr))
})
