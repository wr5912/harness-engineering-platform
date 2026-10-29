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
