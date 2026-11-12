import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const adapterDir = dirname(fileURLToPath(import.meta.url))
const expected = ['node', '--expose-internals', '/opt/dsh/apps/cli/lib/bin.js']
// 模板不含任何仓库内默认路径：来源相关的值必须由调用方注入。这里用占位值，
// 先断言"不注入即失败关闭"，再用占位值核对启动向量本身。
const required = {
  DSH_IMAGE_TAG: 'ai-agent-harness/dsh:000000000',
  DSH_ADAPTER_HOST: '/tmp/placeholder/adapter',
  DSH_WEB_ADAPTER_HOST: '/tmp/placeholder/dsh-web',
  DSH_WEB_PROFILE_MANIFEST_HOST: '/tmp/placeholder/web-profile.package.json',
  DSH_WEB_PROFILE_SEED_DIR_HOST: '/tmp/placeholder/profile-seed',
  DSH_MANAGED_PATCH: '/opt/dsh-managed/placeholder.patch.yml',
  DSH_EVALUATION_PATCH: '/opt/dsh-adapter/evaluation-registry.patch.yml',
  DSH_WORKSPACE_HOST: '/tmp/placeholder/workspace',
  DSH_PRESETS_HOST: '/tmp/placeholder/presets',
  DSH_MANAGED_HOST: '/tmp/placeholder/managed',
  DSH_EVAL_TARGET_PRESET: 'placeholder-agent',
}
function composeConfig(mode, env) {
  return spawnSync('docker', [
    'compose', '-f', join(adapterDir, `${mode}.compose.yaml`), 'config', '--format', 'json',
  ], {
    cwd: adapterDir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
}
for (const mode of ['verification']) {
  const missing = composeConfig(mode, {})
  assert.notEqual(missing.status, 0,
    `${mode}: compose must fail closed when the source-injected variables are absent`)
  assert.match(missing.stderr, /required variable/, `${mode}: failure must name the missing variable`)
  const result = composeConfig(mode, required)
  assert.equal(result.status, 0, `Compose ${mode} config must parse`)
  const config = JSON.parse(result.stdout)
  assert.deepEqual(config.services.dsh.entrypoint, expected,
    `${mode}: only the main dsh service may expose Node internals`)
  assert.deepEqual(config.services.dsh.command.slice(0, 6), [
    '--profile', 'web', '--patch', required.DSH_MANAGED_PATCH,
    '--patch', required.DSH_EVALUATION_PATCH,
  ])
  assert.ok(config.services.dsh.command.includes('/opt/dsh-adapter/verification-home-controls/web-base-path.patch.yml'))
  assert.ok(config.services.dsh.volumes.some(volume =>
    volume.target === '/opt/dsh-web' && volume.source === required.DSH_WEB_ADAPTER_HOST && volume.read_only))
  const managedModules = config.services.dsh.volumes.find(volume => volume.target === '/opt/node_modules')
  assert.equal(managedModules.read_only, true)
  assert.equal(config.services['home-init'].volumes.find(volume => volume.target === '/var/lib/dsh/profiles/node_modules').source, managedModules.source)
  assert.equal(config.services.dsh.environment.DSH_EVAL_TARGET_PRESET, required.DSH_EVAL_TARGET_PRESET)
  assert.deepEqual(config.services['home-init'].entrypoint,
    ['node', '/opt/dsh-adapter/prepare-verification-home.mjs'])
  assert.equal(config.services.dsh.environment.NODE_OPTIONS, undefined,
    `${mode}: NODE_OPTIONS may not alter the startup vector`)
  assert.equal(config.services['home-init'].environment.NODE_OPTIONS, undefined)
  assert.ok(!config.services.dsh.volumes.some(volume =>
    volume.target === '/opt/dsh/node_modules/@deepseek-ai'),
  `${mode}: no root-scope alias volume may shadow the installation tree`)
  const volumeTargets = new Set(config.services.dsh.volumes.map(volume => volume.target))
  assert.ok(volumeTargets.has('/var/lib/dsh/node_modules'))
  assert.ok(volumeTargets.has('/var/lib/dsh/profiles/node_modules'))
  for (const target of [
    '/var/lib/dsh/profiles/web/package.json',
    '/var/lib/dsh/profiles/web/node_modules',
  ]) {
    assert.ok(volumeTargets.has(target), `${mode}: ${target} must be controlled`)
  }
}
console.log(JSON.stringify({ status: 'exact-main-dsh-startup-vectors-verified', modes: 1 }))
