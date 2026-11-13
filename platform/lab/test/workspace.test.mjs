import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { doctorLab, initializeLab, planUpdate, readLab, repositoryNames, statusLab } from '../workspace.mts'

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hep-lab-test-')), destination = join(root, 'lab'), repositories = {}
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const key of Object.keys(repositoryNames)) {
    const path = join(root, `${key}-source`)
    mkdirSync(path)
    git(path, 'init', '-b', 'main'); git(path, 'config', 'user.name', 'Lab Test'); git(path, 'config', 'user.email', 'lab@example.invalid')
    writeFileSync(join(path, 'README.md'), 'fixture\n')
    writeFileSync(join(path, '.gitignore'), '.env\nsessions/\nnode_modules/\n')
    if (key === 'platform_manager_dsh_home') { mkdirSync(join(path, 'profiles/web'), { recursive: true }); writeFileSync(join(path, 'profiles/web/package.json'), '{"dsh":{"profile":{"bundles":[]}}}\n') }
    if (key === 'business_agents') { mkdirSync(join(path, 'agents/demo'), { recursive: true }); writeFileSync(join(path, 'agents/demo/harness.yaml'), 'schema_version: 1\n') }
    git(path, 'add', '.'); git(path, 'commit', '-qm', 'fixture')
    repositories[key] = { url: path, ref: 'main', commit: git(path, 'rev-parse', 'HEAD') }
  }
  const data = repositories.data.url
  mkdirSync(join(data, 'registry/agents'), { recursive: true })
  writeFileSync(join(data, 'registry/agents/demo.yaml'), `agent_id: demo\nsource_repository: ${repositories.business_agents.url}\nsource_commit: ${repositories.business_agents.commit}\nagent_path: agents/demo\n`)
  git(data, 'add', '.'); git(data, 'commit', '-qm', 'registry')
  repositories.data.commit = git(data, 'rev-parse', 'HEAD')
  return { root, destination, repositories }
}
test('四仓固定SHA并列检出、重复执行幂等，check-only完全不落盘', t => {
  const f = fixture(t)
  const plan = initializeLab({ ...f, checkOnly: true })
  assert.equal(plan.check_only, true); assert.equal(existsSync(f.destination), false)
  const first = initializeLab(f)
  assert.equal(first.validation.valid, true, JSON.stringify(first.validation))
  assert.equal(first.validation.agent_count, 1)
  assert.equal(first.manifest.initializer_version, 2)
  assert.equal(first.manifest.paths.dsh_home, join(f.destination, 'platform-manager-dsh-home'))
  assert.equal(first.manifest.paths.business_agents_root, join(f.destination, 'business-agents'))
  assert.equal('runtime' in first.manifest, false)
  assert.equal(existsSync(join(f.destination, 'hep-lab.yaml')), true)
  assert.equal(existsSync(join(f.destination, '.hep-lab')), false)
  const before = readFileSync(join(f.destination, 'hep-lab.yaml'), 'utf8')
  initializeLab({ ...f, reuse: true })
  assert.equal(readFileSync(join(f.destination, 'hep-lab.yaml'), 'utf8'), before)
  assert.equal(doctorLab(f.destination).valid, true)
  assert.equal(statusLab(f.destination).repositories.business_agents.matches_lock, true)
  assert.equal(planUpdate(f.destination).repositories.every(item => !item.changed), true)
})
test('只提供数据仓库时从 locks/repositories.yaml 推导其余三库', t => {
  const f = fixture(t), data = f.repositories.data.url
  mkdirSync(join(data, 'locks'), { recursive: true })
  writeFileSync(join(data, 'locks/repositories.yaml'), `repositories:
  platform:
    url: ${f.repositories.platform.url}
    commit: ${f.repositories.platform.commit}
  platform_manager_dsh_home:
    url: ${f.repositories.platform_manager_dsh_home.url}
    commit: ${f.repositories.platform_manager_dsh_home.commit}
  business_agents:
    url: ${f.repositories.business_agents.url}
    commit: ${f.repositories.business_agents.commit}
`)
  git(data, 'add', '.'); git(data, 'commit', '-qm', 'repository locks')
  const repositories = { data: { url: data, commit: git(data, 'rev-parse', 'HEAD') } }
  const result = initializeLab({ ...f, repositories })
  assert.equal(result.validation.valid, true, JSON.stringify(result.validation))
  for (const key of ['platform', 'platform_manager_dsh_home', 'business_agents']) assert.equal(result.manifest.repositories[key].commit, f.repositories[key].commit)
  assert.equal(result.manifest.repositories.data.commit, repositories.data.commit)
})
test('check-only 不为推导锁定临时下载数据仓库', t => {
  const f = fixture(t), repositories = { data: f.repositories.data }
  assert.throws(() => initializeLab({ ...f, repositories, checkOnly: true }), /check-only.*不能 clone\/fetch/)
  assert.equal(existsSync(f.destination), false)
})
test('CLI 只传数据仓库参数即可初始化四库工作区', t => {
  const f = fixture(t), data = f.repositories.data.url
  mkdirSync(join(data, 'locks'), { recursive: true })
  writeFileSync(join(data, 'locks/repositories.yaml'), `repositories:
  platform:
    url: ${f.repositories.platform.url}
    commit: ${f.repositories.platform.commit}
  platform_manager_dsh_home:
    url: ${f.repositories.platform_manager_dsh_home.url}
    commit: ${f.repositories.platform_manager_dsh_home.commit}
  business_agents:
    url: ${f.repositories.business_agents.url}
    commit: ${f.repositories.business_agents.commit}
`)
  git(data, 'add', '.'); git(data, 'commit', '-qm', 'repository locks')
  const cli = new URL('../cli.mts', import.meta.url).pathname
  const result = spawnSync(process.execPath, [cli, 'init', '--destination', f.destination, '--data-repository', data, '--data-commit', git(data, 'rev-parse', 'HEAD'), '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, 'succeeded')
  assert.equal(output.manifest.repositories.business_agents.commit, f.repositories.business_agents.commit)
})
test('dirty工作树、非空目录、origin和版本冲突均保留用户内容', t => {
  const f = fixture(t); initializeLab(f)
  const path = join(f.destination, 'business-agents/README.md')
  writeFileSync(path, '用户修改\n')
  assert.throws(() => initializeLab({ ...f, reuse: true }), /未提交/)
  assert.equal(readFileSync(path, 'utf8'), '用户修改\n')
  assert.throws(() => planUpdate(f.destination), /未提交/)
  assert.equal(doctorLab(f.destination).valid, false)
  const other = join(f.root, 'not-empty'); mkdirSync(other); writeFileSync(join(other, 'user.txt'), 'keep')
  assert.throws(() => initializeLab({ ...f, destination: other }), /非 hep-lab/)
  assert.equal(readFileSync(join(other, 'user.txt'), 'utf8'), 'keep')
  git(join(f.destination, 'business-agents'), 'remote', 'set-url', 'origin', f.repositories.data.url)
  assert.throws(() => initializeLab({ ...f, reuse: true }), /未提交|origin/)
})
test('浮动分支冻结实际 SHA，固定提交不受来源分支后续移动影响', t => {
  const f = fixture(t)
  const floating = Object.fromEntries(Object.entries(f.repositories).map(([key, { url, ref }]) => [key, { url, ref }]))
  assert.throws(() => initializeLab({ ...f, repositories: floating }), /缺少 commit/)
  const result = initializeLab({ ...f, repositories: floating, allowFloatingRef: true })
  assert.equal(result.manifest.repositories.business_agents.commit, f.repositories.business_agents.commit)
  const source = f.repositories.business_agents.url
  writeFileSync(join(source, 'README.md'), 'new branch head\n')
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'advance branch')
  const pinned = initializeLab({ ...f, destination: join(f.root, 'other') })
  assert.equal(pinned.manifest.repositories.business_agents.commit, f.repositories.business_agents.commit)
  assert.equal(initializeLab({ ...f, destination: join(f.root, 'other'), reuse: true }).validation.valid, true)
})
test('原生 Profile 只读取 Cordis 入口与 patch，不把包管理元数据作为配置', t => {
  const f = fixture(t), home = f.repositories.platform_manager_dsh_home.url
  writeFileSync(join(home, 'profiles/web/pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\n')
  writeFileSync(join(home, 'profiles/web/metadata.yaml'), 'description: profile metadata\n')
  writeFileSync(join(home, 'profiles/web/cordis.yml'), '[]\n')
  writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), '[]\n')
  git(home, 'add', '.'); git(home, 'commit', '-qm', 'native profile')
  f.repositories.platform_manager_dsh_home.commit = git(home, 'rev-parse', 'HEAD')
  assert.equal(initializeLab(f).validation.valid, true)
  assert.equal(doctorLab(f.destination).valid, true)
})
test('lock不一致先拒绝，不写入目标仓库或用户文件', t => {
  const f = fixture(t), data = f.repositories.data.url
  mkdirSync(join(data, 'locks'), { recursive: true })
  writeFileSync(join(data, 'locks/repositories.yaml'), `repositories:\n  business_agents:\n    url: ${f.repositories.business_agents.url}\n    commit: ${'a'.repeat(40)}\n`)
  git(data, 'add', '.'); git(data, 'commit', '-qm', 'bad lock'); f.repositories.data.commit = git(data, 'rev-parse', 'HEAD')
  assert.throws(() => initializeLab(f), /输入与仓库锁定/)
  assert.equal(existsSync(join(f.destination, 'business-agents')), false)
  assert.equal(existsSync(join(f.destination, 'hep-lab.yaml')), false)
})
test('拒绝已移除的元数据目录', t => {
  const f = fixture(t)
  mkdirSync(join(f.destination, '.hep-lab'), { recursive: true })
  assert.throws(() => initializeLab(f), /已移除的 \.hep-lab 元数据目录/)
})
test('doctor拒绝tracked凭据、嵌套repo和Registry错绑', t => {
  const f = fixture(t); initializeLab(f)
  const business = join(f.destination, 'business-agents')
  git(business, 'config', 'user.name', 'Lab Test'); git(business, 'config', 'user.email', 'lab@example.invalid')
  writeFileSync(join(business, '.env'), 'KEY=fixture\n'); git(business, 'add', '-f', '.env'); git(business, 'commit', '-qm', 'unsafe')
  mkdirSync(join(business, 'nested')); git(join(business, 'nested'), 'init', '-b', 'main')
  const report = doctorLab(f.destination)
  assert.equal(report.valid, false)
  // 仓库状态冲突同样会阻断；精确治理检查使用与当前HEAD匹配的清单。
  const manifest = readLab(f.destination); manifest.repositories.business_agents.commit = git(business, 'rev-parse', 'HEAD')
  rmSync(join(business, 'nested'), { recursive: true })
  const config = JSON.stringify(manifest)
  writeFileSync(join(f.destination, 'hep-lab.yaml'), config)
  const unsafe = doctorLab(f.destination)
  assert.ok(unsafe.issues.some(item => item.code === 'runtime_or_secret_path'))
  assert.ok(unsafe.issues.some(item => item.code === 'agent_reference'))
  mkdirSync(join(business, 'nested')); git(join(business, 'nested'), 'init', '-b', 'main')
  writeFileSync(join(business, '.gitignore'), '.env\nsessions/\nnode_modules/\nnested/\n')
  git(business, 'add', '.gitignore'); git(business, 'commit', '-qm', 'ignore nested'); manifest.repositories.business_agents.commit = git(business, 'rev-parse', 'HEAD')
  writeFileSync(join(f.destination, 'hep-lab.yaml'), JSON.stringify(manifest))
  assert.ok(doctorLab(f.destination).issues.some(item => item.code === 'nested_repository'))
})
test('输入拒绝含凭据URL、选项伪装、短SHA和符号链接目的地', t => {
  const f = fixture(t)
  for (const url of ['https://user:password@example.invalid/repo', '-upload-pack=bad', 'https://example.invalid/repo?token=secret']) {
    const repositories = structuredClone(f.repositories); repositories.data.url = url
    assert.throws(() => initializeLab({ ...f, repositories, checkOnly: true }), /地址/)
  }
  const repositories = structuredClone(f.repositories); repositories.data.commit = 'abc'
  assert.throws(() => initializeLab({ ...f, repositories }), /40 位/)
  const link = join(f.root, 'link'); symlinkSync(f.root, link)
  assert.throws(() => initializeLab({ ...f, destination: join(link, 'lab') }), /符号链接/)
})
test('CLI不接受update执行和未知参数，不回显Git凭据诊断', t => {
  const cli = new URL('../cli.mts', import.meta.url).pathname
  for (const args of [['update', '--lab', '/missing'], ['status', '--lab', '/missing', '--force'], ['init', '--destination', '/missing'], ['init', '--destination', '/missing', '--isolate-runtime']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.ok(result.stderr.startsWith('hep-lab:'))
  }
})
test('CLI版本、JSON错误和请求ID符合稳定入口合同', t => {
  const cli = new URL('../cli.mts', import.meta.url).pathname
  const version = spawnSync(process.execPath, [cli, '--version', '--json'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  const versionValue = JSON.parse(version.stdout)
  assert.equal(versionValue.schema_version, 1)
  assert.equal(versionValue.name, 'hep-lab')
  assert.match(versionValue.version, /^\d+\.\d+\.\d+$/)
  assert.match(versionValue.revision, /^[0-9a-f]{40}$/)
  const failed = spawnSync(process.execPath, [cli, 'status', '--lab', '/missing', '--json', '--request-id', 'req-contract'], { encoding: 'utf8' })
  assert.equal(failed.status, 2)
  assert.equal(failed.stderr, '')
  const failure = JSON.parse(failed.stdout)
  assert.equal(failure.schema_version, 1)
  assert.equal(failure.request_id, 'req-contract')
  assert.equal(failure.error.code, 'invalid_input')
  const parseFailure = spawnSync(process.execPath, [cli, 'status', '--json', '--unknown'], { encoding: 'utf8' })
  assert.equal(parseFailure.status, 2)
  assert.equal(parseFailure.stderr, '')
  assert.equal(JSON.parse(parseFailure.stdout).error.code, 'invalid_input')
})
test('doctor只解析原生Profile，报告不存在引用与机器依赖并容许tokens.txt', t => {
  const f = fixture(t), home = f.repositories.platform_manager_dsh_home.url
  writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), '- id: fixture\n  config:\n    value: !!js process.exit(99)\n')
  writeFileSync(join(home, 'tokens.txt'), '词元文件\n')
  git(home, 'add', '.'); git(home, 'commit', '-qm', 'native expression'); f.repositories.platform_manager_dsh_home.commit = git(home, 'rev-parse', 'HEAD')
  assert.equal(initializeLab(f).validation.valid, true)
  const localHome = join(f.destination, 'platform-manager-dsh-home')
  writeFileSync(join(localHome, 'profiles/web/cordis.patch.yml'), '- id: fixture\n  name: /path-that-does-not-exist/plugin.mjs\n')
  const issue = doctorLab(f.destination)
  assert.ok(issue.issues.some(item => item.code === 'profile_configuration'))
  writeFileSync(join(localHome, 'profiles/web/package.json'), '{"dsh":{"profile":{"bundles":[]}},"dependencies":{"fixture":"file:/machine/plugin.tgz"}}')
  assert.ok(doctorLab(f.destination).issues.some(item => item.code === 'profile_configuration' && item.message.includes('绝对路径')))
})
test('损坏YAML只输出格式错误，不泄漏正文内容', t => {
  const f = fixture(t); initializeLab(f)
  writeFileSync(join(f.destination, 'hep-lab.yaml'), 'secret: [DO_NOT_PRINT_THE_PAYLOAD')
  assert.throws(() => readLab(f.destination), error => error.message.includes('YAML') && !error.message.includes('DO_NOT_PRINT'))
})
