import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { preflightGatewayRegistration, updateGatewayRegistration } from '../src/business-control/registration.ts'

for (const identityMode of ['development', 'published']) test(`CLI 与平台更新${identityMode}匿名实例来源，保留其它实例`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-registration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const digest = 'sha256:' + 'a'.repeat(64), next = 'sha256:' + 'b'.repeat(64)
  const registration = { agentId: 'example', instanceId: 'probe', sourceId: 'experiment:EXP-example-001',
    sourceDigest: digest, accessMode: 'anonymous', identityMode }
  const config = { schemaVersion: 1, enabled: false, gateway: { host: '127.0.0.1', port: 53105,
    publicOrigin: 'http://business.example:53105', instances: [{ ...registration, instanceId: 'other' }] } }
  const directory = join(root, '.local/instances/probe'), access = join(root, 'config/business-access.json')
  mkdirSync(directory, { recursive: true }); mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-fixture' }))
  writeFileSync(access, JSON.stringify(config))
  const manifest = { workspace_id: 'workspace-fixture', asset_root: root, agent_id: 'example', source_id: registration.sourceId,
    web_base_path: '/agents/example/instances/probe/', business_control: { runtime_generation: 'generation-fixture',
      source_digest: digest, identity_mode: identityMode, access_mode: 'anonymous', origin: 'http://127.0.0.1:18500' } }
  const save = () => writeFileSync(join(directory, 'instance.json'), JSON.stringify(manifest))
  save()
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types',
    '../runtime/adapters/dsh-container/business.ts', '--register', root, 'probe', ...args], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' }))
  await preflightGatewayRegistration(root, registration)
  assert.equal(cli().url, 'http://business.example:53105/agents/example/instances/probe/')
  await updateGatewayRegistration(root, registration)
  manifest.business_control.source_digest = next; save()
  assert.equal(cli(digest).url, 'http://business.example:53105/agents/example/instances/probe/')
  await updateGatewayRegistration(root, { ...registration, sourceDigest: next }, false, digest)
  const rows = JSON.parse(readFileSync(access, 'utf8')).gateway.instances
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.instanceId === 'probe').sourceDigest, next)
  assert.equal(rows.find(row => row.instanceId === 'other').sourceDigest, digest)
  await assert.rejects(preflightGatewayRegistration(root, { ...registration, sourceDigest: 'unrelated' }), /拒绝覆盖/)
  await assert.rejects(preflightGatewayRegistration(root, { ...registration, sourceDigest: next, identityMode: identityMode === 'development' ? 'published' : 'development' }), /拒绝覆盖/)
})

test('CLI 删除经共享事务移除网关登记，保留 HOME 和其它实例', t => {
  const root = mkdtempSync(join(tmpdir(), 'business-delete-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, '.local/instances/probe'), access = join(root, 'config/business-access.json')
  const digest = 'sha256:' + 'a'.repeat(64)
  const registration = { agentId: 'example', instanceId: 'probe', sourceId: 'experiment:EXP-example-001', sourceDigest: digest }
  mkdirSync(directory, { recursive: true }); mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'runtime/adapters/dsh-container'), { recursive: true })
  writeFileSync(join(directory, 'instance.json'), JSON.stringify({ agent_id: 'example', source_id: registration.sourceId,
    business_control: { source_digest: digest } }))
  writeFileSync(join(directory, 'home-marker'), 'retained')
  writeFileSync(access, JSON.stringify({ schemaVersion: 1, enabled: false, gateway: { instances: [registration, { ...registration, instanceId: 'other' }] } }))
  // 仅替换 Docker 删除边界，实际运行 CLI 与共享网关事务。
  writeFileSync(join(root, 'runtime/adapters/dsh-container/dsh-dev'), `import json,os
from pathlib import Path
def load_instance(name):
    path = Path(os.environ['HARNESS_ASSET_ROOT']) / '.local/instances' / name / 'instance.json'
    return path.parent,json.loads(path.read_text())
def delete_instance(name,manifest):
    path,_ = load_instance(name)
    (path / 'instance.json').unlink()
    return {'name':name,'deleted':True,'home_preserved':True}
`)
  const result = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types',
    '../runtime/adapters/dsh-container/business.ts', '--delete', root, 'probe'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, HARNESS_PROGRAM_ROOT: root, HARNESS_INSTANCE_STATE_ROOT: '', XDG_STATE_HOME: '' },
  }))
  assert.equal(result.deleted, true)
  assert.equal(readFileSync(join(directory, 'home-marker'), 'utf8'), 'retained')
  assert.deepEqual(JSON.parse(readFileSync(access, 'utf8')).gateway.instances.map(row => row.instanceId), ['other'])
})
