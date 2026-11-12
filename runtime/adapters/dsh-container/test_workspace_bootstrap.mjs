import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('只读 workspace 的子文件挂载必须有实体占位，规范占位保持只读', t => {
  const image = process.env.HARNESS_TEST_DSH_IMAGE
  if (!image) return t.skip('通过 HARNESS_TEST_DSH_IMAGE 指定已有标准镜像；不构建镜像')
  const workspace = mkdtempSync(join(tmpdir(), 'harness-bootstrap-'))
  const template = fileURLToPath(new URL('./verification-home-controls/locked-bootstrap.env', import.meta.url))
  const name = `harness-bootstrap-${process.pid}-${Date.now()}`
  t.after(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    rmSync(workspace, { recursive: true, force: true })
  })
  const run = () => spawnSync('docker', ['run', '--rm', '--name', name, '--network', 'none', '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${workspace},dst=/work/harness/workspace,readonly`,
    '--mount', `type=bind,src=${template},dst=/work/harness/workspace/.env,readonly`, image,
    '-c', 'cat /work/harness/workspace/.env && ! (printf changed > /work/harness/workspace/.env)'],
  { encoding: 'utf8', timeout: 60_000 })
  const missing = run()
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /read-only file system|read only file system/)
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  writeFileSync(join(workspace, '.env'), readFileSync(template))
  const restored = run()
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal(restored.stdout, readFileSync(template, 'utf8'))
  assert.deepEqual(readFileSync(join(workspace, '.env')), readFileSync(template))
})

test('UID 1000 初始化全新依赖卷后，Managed 插件只读复用同一镜像依赖', t => {
  const image = process.env.HARNESS_TEST_DSH_IMAGE
  if (!image) return t.skip('通过 HARNESS_TEST_DSH_IMAGE 指定已有标准镜像；不构建镜像')
  const adapter = dirname(fileURLToPath(import.meta.url))
  const home = mkdtempSync(join(tmpdir(), 'harness-home-init-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  const volume = `harness-home-init-${process.pid}-${Date.now()}`
  t.after(() => {
    spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' })
    rmSync(home, { recursive: true, force: true })
  })
  const run = args => spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', ...args],
    { encoding: 'utf8', timeout: 60_000 })
  for (let attempt = 0; attempt < 2; attempt++) {
    const initialized = run([
      '--mount', `type=bind,src=${adapter},dst=/opt/dsh-adapter,readonly`,
      '--mount', `type=bind,src=${adapter}/verification-home-controls,dst=/opt/dsh-verification-controls,readonly`,
      '--mount', `type=bind,src=${home},dst=/var/lib/dsh`,
      '--mount', `type=volume,src=${volume},dst=/var/lib/dsh/profiles/node_modules`,
      '--env', 'DSH_HARNESS_MODE=verification', '--entrypoint', 'node', image,
      '/opt/dsh-adapter/prepare-verification-home.mjs',
    ])
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.match(initialized.stdout, /controlled-home-targets-prepared/)
  }
  const resolved = run(['--mount', `type=volume,src=${volume},dst=/opt/node_modules,readonly`,
    '--entrypoint', 'node', image, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      import {writeFileSync} from 'node:fs';
      assert.equal(process.getuid(),1000);
      const require=createRequire('/opt/dsh-managed/probe.cjs');
      for(const name of ['@deepseek-ai/schemastery','@deepseek-ai/dsh-llm','@deepseek-ai/cordis']) assert.ok(require.resolve(name));
      assert.throws(()=>writeFileSync('/opt/node_modules/probe','forbidden'),e=>['EROFS','EACCES'].includes(e.code));
    `])
  assert.equal(resolved.status, 0, resolved.stderr)
})
