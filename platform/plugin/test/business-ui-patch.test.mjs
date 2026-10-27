import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { load } from 'js-yaml'
import { createBusinessRuntimePatch } from '../lib/business-runtime.js'

const require = createRequire(import.meta.url)
const profile = readFileSync(require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'), 'utf8')
const profileIds = new Set([...profile.matchAll(/^\s+- id: ([a-z][\w-]+)\s*$/gm)].map(match => match[1]))
const binding = { workspaceId: 'workspace-test', agentId: 'daily-inspection-assistant', instanceId: 'tt', runtimeGeneration: 'generation', sourceDigest: 'digest' }

test('平台 Bundle 关闭工作区添加界面，保留原生目录服务供会话导航使用', () => {
  const patch = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  assert.ok(profileIds.has('directory-picker'))
  assert.equal(patch.find(item => item.id === 'directory-picker').disabled, true)
  assert.equal(patch.flatMap(item => item.insert ?? []).find(item => item.id === 'platform-directory-picker').name, '@deepseek-ai/dsh-host-directory-picker-browse')
})

test('业务 Patch 关闭原生预设选择和目录选择流，保留 DSH 工作区会话导航', () => {
  const patch = createBusinessRuntimePatch({ assetRoot: '/assets', stateRoot: '/state', sharedSecretFile: '/secret', coordinatorOrigin: 'http://host', binding }, '/business-runtime.js')
  const disabled = new Set(patch.filter(item => item.disabled).map(item => item.id))
  for (const id of ['ui-agent-preset', 'directory-picker']) {
    assert.ok(profileIds.has(id), `锁定版 DSH Profile 缺少 ${id}`)
    assert.ok(disabled.has(id), `${id} 必须被业务 Patch 关闭`)
  }
  for (const id of ['workspace', 'workspace-controller', 'ui-workspace', 'ui-conversation', 'session-log-download']) {
    assert.ok(profileIds.has(id), `锁定版 DSH Profile 缺少 ${id}`)
    assert.ok(!disabled.has(id), `${id} 须保留原生 Workspace/Session 路径`)
  }
  const runtime = patch.flatMap(item => item.insert ?? []).find(item => item.id === 'business-runtime')
  assert.ok(runtime.inject.includes('workspaceRegistry'))
})
