import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'

const platform = new URL('../', import.meta.url).pathname
const project = new URL('../../', import.meta.url).pathname
const hep = join(platform, 'hep')
const deploy = join(platform, 'dsh-deploy')

function run(command, args, cwd = project) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, HEP_ROOT: project } })
}

test('hep help and version provide a stable JSON surface', () => {
  const help = run(hep, ['--help', '--json'])
  assert.equal(help.status, 0, help.stderr)
  const value = JSON.parse(help.stdout)
  assert.equal(value.schema_version, 1)
  assert.equal(value.name, 'hep')
  assert.ok(value.domains.some(item => item.id === 'agent'))
  assert.equal(value.contract.json, '--json')
  const version = run(hep, ['--version', '--json'])
  assert.equal(version.status, 0, version.stderr)
  assert.match(JSON.parse(version.stdout).version, /\d+\.\d+/)
})

test('hep delegates deployment help without loading plugin dependencies', () => {
  const result = run(hep, ['deploy', '--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dsh-deploy/)
})

test('clean archive can show dsh-deploy help before dependency installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-clean-archive-'))
  try {
    const archive = join(root, 'platform.tar')
    const files = run('git', ['ls-files', '-co', '--exclude-standard', '-z'])
    assert.equal(files.status, 0, files.stderr)
    const packed = spawnSync('tar', ['--null', '-T', '-', '-cf', archive], { cwd: project, input: files.stdout, encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const checkout = join(root, 'platform')
    mkdirSync(checkout)
    const unpack = run('tar', ['-xf', archive, '-C', checkout])
    assert.equal(unpack.status, 0, unpack.stderr)
    assert.ok(existsSync(join(checkout, 'platform/dsh-deploy')))
    const result = run(join(checkout, 'platform/dsh-deploy'), ['--help'], checkout)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /dsh-deploy/)
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|js-yaml/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unknown hep command has a machine-readable error', () => {
  const result = run(hep, ['unknown', '--json'])
  assert.equal(result.status, 2)
  const value = JSON.parse(result.stdout)
  assert.equal(value.status, 'failed')
  assert.equal(value.error.code, 'unknown_command')
})

test('hep mcp exposes read-only catalog and composition receipts', () => {
  const dataRoot = join(project, '..', 'harness-engineering-platform-data')
  const catalog = run(hep, ['mcp', 'catalog', '--data-root', dataRoot, '--json'])
  assert.equal(catalog.status, 0, catalog.stderr)
  const catalogValue = JSON.parse(catalog.stdout)
  assert.equal(catalogValue.status, 'succeeded')
  assert.equal(catalogValue.value.registered_count, 11)
  assert.ok(catalogValue.value.manager.server_ids.includes('ai-soc-master'))
  const shown = run(hep, ['mcp', 'show', '--data-root', dataRoot, '--id', 'inspection-baseline', '--json'])
  assert.equal(shown.status, 0, shown.stderr)
  const shownValue = JSON.parse(shown.stdout)
  assert.equal(shownValue.value.composition.id, 'inspection-baseline')
})

