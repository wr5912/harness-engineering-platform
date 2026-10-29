import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { collectEntries } from '../manifest.mts'

const hash = value => createHash('sha256').update(value).digest('hex')
export function write(path, text, mode) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, mode ? { mode } : {}) }
export function command(name, args, cwd) { const result = spawnSync(name, args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim() }
export function elf(arch) { const bytes = Buffer.alloc(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18); return bytes }
export function fixture(t, arch = 'amd64') {
  const root = mkdtempSync(join(tmpdir(), 'standalone-pack-')), program = join(root, 'program'), data = join(root, 'data'), resources = join(root, 'resources'), out = join(root, 'out')
  const before = process.env.HARNESS_PYTHON
  process.env.HARNESS_PYTHON = process.execPath
  t.after(() => { if (before === undefined) delete process.env.HARNESS_PYTHON; else process.env.HARNESS_PYTHON = before; rmSync(root, { recursive: true, force: true }) })
  const id = 'EXP-alpha-001', candidate = join(data, 'evolution/experiments', id, 'candidate'), fingerprint = 'f'.repeat(64), tag = `dsh:fixture-${arch}`
  write(join(data, 'evolution/experiments', id, 'change.yaml'), `experiment_id: ${id}\nagent_id: alpha\n`)
  write(join(candidate, 'harness.yaml'), 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: alpha-main\n  profile_patch: dsh/managed/alpha.patch.yml\ncredential_environment_keys: [TEST_MODEL_KEY]\n')
  write(join(candidate, 'dsh/workspace/AGENTS.md'), '# 初版\n')
  write(join(candidate, 'dsh/workspace/.env'), 'TEST_MODEL_KEY="synthetic-fixture-value"\n')
  write(join(candidate, 'dsh/presets/alpha-main/agent.cordis.yml'), '[]\n')
  write(join(candidate, 'dsh/managed/alpha.patch.yml'), '[]\n')
  write(join(data, 'agents/other/private.md'), '其他业务资料，不应进入包')
  write(join(candidate, 'RuntimeHOME/sessions/private.jsonl'), '旧会话，不应进入包')
  command('git', ['init', '-q'], data)
  command('git', ['add', '.'], data)
  command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', '原始测试资产'], data)
  write(join(candidate, 'dsh/workspace/AGENTS.md'), '# 当前已保存且未提交的业务规则\n')
  write(join(program, 'runtime/adapters/dsh-container/source_contract.py'), `console.log(JSON.stringify({tag:${JSON.stringify(tag)},fingerprint:${JSON.stringify(fingerprint)}}))`)
  for (const name of ['standalone-bootstrap.js', 'standalone-plugin.js', 'standalone-bridge.js', 'standalone-knowledge.js']) write(join(program, 'platform/plugin/lib', name), 'export {}\n')
  symlinkSync(new URL('../../plugin/node_modules', import.meta.url), join(program, 'platform/plugin/node_modules'), 'dir')
  write(join(program, 'runtime/adapters/dsh-web/lib/container-webserver.mjs'), 'export {}\n')
  write(join(program, 'runtime/adapters/dsh-container/runtime-compat/index.mjs'), 'export {}\n')
  mkdirSync(join(program, 'platform/deploy'), { recursive: true })
  copyFileSync(new URL('../bootstrap-docker.sh', import.meta.url), join(program, 'platform/deploy/bootstrap-docker.sh'))
  mkdirSync(join(program, 'platform/deploy/agent/runtime'), { recursive: true })
  for (const name of ['agent', 'install.sh']) copyFileSync(new URL(`../agent/runtime/${name}`, import.meta.url), join(program, 'platform/deploy/agent/runtime', name))
  const image = join(root, 'image'), config = JSON.stringify({ architecture: arch, os: 'linux', config: { Labels: { 'org.ai-agent-harness.dsh.image-build-fingerprint': fingerprint } } })
  const imageId = hash(config)
  write(join(image, imageId + '.json'), config)
  write(join(image, 'manifest.json'), JSON.stringify([{ Config: imageId + '.json', RepoTags: [tag], Layers: [] }]))
  mkdirSync(join(resources, 'images'), { recursive: true })
  command('tar', ['-C', image, '-cf', join(resources, 'images/dsh-runtime.tar'), 'manifest.json', imageId + '.json'])
  const dockerFiles = join(root, 'docker-files')
  write(join(dockerFiles, 'docker/docker'), elf(arch), 0o755)
  write(join(dockerFiles, 'docker/dockerd'), elf(arch), 0o755)
  mkdirSync(join(resources, 'docker'), { recursive: true })
  command('tar', ['-C', dockerFiles, '-czf', join(resources, 'docker/docker-fixture.tgz'), 'docker'])
  write(join(resources, 'docker/docker-compose'), elf(arch), 0o755)
  const resourceManifest = { schemaVersion: 1, arch, createdAt: '2026-10-29T00:00:00Z', image: { tag, id: `sha256:${imageId}`, arch, fingerprint, archive: 'images/dsh-runtime.tar' }, docker: { files: collectEntries(join(resources, 'docker')) }, dependencies: [] }
  write(join(resources, 'resources.json'), JSON.stringify(resourceManifest))
  return { root, candidate, program, data, resources, out, id, input: { programRoot: program, assetRoot: data, agentId: 'alpha', experimentId: id, arch, mode: 'online', resourcesDir: resources, out } }
}
