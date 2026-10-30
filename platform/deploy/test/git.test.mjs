import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertGitBundle, collectSystemGit, copyGitBundle } from '../git.mts'
import { run } from '../fsutil.mts'

test('系统 Git 收集使用宿主 glibc，完整执行初始化、归档与离线克隆', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-git-'))
  try {
    const bundle = join(root, 'git bundle')
    const { path: git } = collectSystemGit(bundle)
    assertGitBundle(bundle)
    assert.match(run(git, ['--version']), /^git version /)
    const repository = join(root, 'repository'), archive = join(root, 'source.bundle'), restored = join(root, 'restored')
    run(git, ['init', '-b', 'main', repository])
    writeFileSync(join(repository, 'asset'), 'offline asset\n')
    run(git, ['-C', repository, 'add', '.'])
    run(git, ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'])
    run(git, ['-C', repository, 'bundle', 'create', archive, '--all'])
    run(git, ['clone', archive, restored])
    assert.equal(run(git, ['-C', restored, 'show', 'HEAD:asset']), 'offline asset\n')
    assert.equal(run(git, ['-C', restored, 'status', '--porcelain']), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('外部 Git 资源在复制前拒绝混用 glibc，包括符号链接和两种架构加载器', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-git-check-'))
  try {
    const source = join(root, 'source'), destination = join(root, 'destination'), lib = join(source, 'root', 'lib')
    mkdirSync(join(source, 'root', 'usr', 'bin'), { recursive: true })
    mkdirSync(lib)
    writeFileSync(join(source, 'git'), '#!/bin/sh\necho git-fixture\n', { mode: 0o755 })
    writeFileSync(join(source, 'root', 'usr', 'bin', 'git'), '')
    writeFileSync(join(lib, 'libpcre2-8.so.0'), '')
    writeFileSync(join(lib, 'libz.so.1'), '')
    assertGitBundle(source)
    for (const name of ['libc.so.6', 'libpthread.so.0', 'libm-2.31.so', 'ld-linux-aarch64.so.1', 'ld-linux-x86-64.so.2']) {
      const path = join(lib, name)
      symlinkSync('missing-on-purpose', path)
      assert.throws(() => copyGitBundle(source, destination), /使用目标系统 glibc/)
      assert.equal(existsSync(destination), false)
      rmSync(path)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('不同 PATH 来源统一包内 Git 布局，复制后不依赖原二进制路径', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-git-path-'))
  const originalPath = process.env.PATH
  try {
    for (const custom of [false, true]) await t.test(custom ? '自定义 PATH 中的真实 ELF' : '/usr/bin/git', () => {
      const source = join(root, custom ? 'custom bin' : 'system bin')
      mkdirSync(source)
      copyFileSync('/usr/bin/git', join(source, 'git'))
      process.env.PATH = custom ? `${source}:/usr/bin:/bin` : '/usr/bin:/bin'
      const bundle = join(root, custom ? 'custom bundle' : 'system bundle')
      const collected = collectSystemGit(bundle)
      assertGitBundle(bundle)
      const copied = copyGitBundle(bundle, `${bundle} copied`)
      rmSync(source, { recursive: true, force: true })
      assert.equal(run(collected.path, ['--version']).trim(), collected.version)
      assert.equal(run(copied.path, ['--version']).trim(), collected.version)
    })
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  }
})

test('安装器生成工具与三个入口不污染程序Git，源码修改及普通新增文件仍可见', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-installed-git-'))
  try {
    const git = args => run('git', ['-C', root, ...args])
    git(['init', '-b', 'main'])
    git(['config', 'core.excludesFile', '/dev/null'])
    copyFileSync(new URL('../../../.gitignore', import.meta.url), join(root, '.gitignore'))
    const source = 'runtime/adapters/dsh-container/evaluation-wait.mts'
    mkdirSync(join(root, 'runtime/adapters/dsh-container'), { recursive: true })
    copyFileSync(new URL('../../../' + source, import.meta.url), join(root, source))
    git(['add', '.'])
    git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', '安装来源夹具'])
    const python = process.env.HARNESS_PYTHON || process.env.HEP_PYTHON || 'python3'
    const script = 'import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from run_record import git_version; print(json.dumps(git_version(Path(sys.argv[2]))))'
    const version = () => JSON.parse(run(python, ['-c', script,
      new URL('../../../runtime/adapters/dsh-container/', import.meta.url).pathname, root]))
    const commit = git(['rev-parse', 'HEAD']).trim()
    const clean = () => {
      assert.equal(git(['status', '--porcelain']), '')
      assert.deepEqual(version(), { commit, dirty: false, changed_path_count: 0 })
    }
    clean()
    // 与 installRuntime 当前输出一致；文件仅模拟安装布局，不执行工具夹具。
    for (const path of ['bin/dsh', 'bin/hep-env.sh', 'bin/hep-start', 'runtime/dsh/apps/cli/lib/bin.js',
      'runtime/git/git', 'runtime/node/bin/node', 'runtime/pnpm/bin/pnpm', 'runtime/python/bin/python3',
      'runtime/python-site/yaml/__init__.py']) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), 'installed runtime fixture\n')
    }
    clean()
    writeFileSync(join(root, source), '修改已跟踪的适配器源码\n')
    assert.equal(version().dirty, true)
    assert.match(git(['status', '--porcelain']), /evaluation-wait\.mts/)
    copyFileSync(new URL('../../../' + source, import.meta.url), join(root, source))
    clean()
    for (const path of ['bin/new-tool.mts', 'runtime/adapters/dsh-container/new-source.mts']) {
      writeFileSync(join(root, path), 'export const source = true\n')
      assert.equal(version().dirty, true)
      assert.ok(git(['status', '--porcelain', '--untracked-files=all']).includes(path))
      rmSync(join(root, path))
      clean()
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
