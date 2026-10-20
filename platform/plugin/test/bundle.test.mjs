import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

test('客户端产物使用 DSH ModuleLoader 和共享 React，导出可装载插件', () => {
  let registration
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { registration = value } } },
  })
  assert.equal(registration.id, '@ai-agent-harness/harness-platform')
  const dependencies = []
  const require = createRequire(import.meta.url)
  const plugin = registration.factory(name => {
    dependencies.push(name)
    return name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(name)
  })
  assert.deepEqual(new Set(dependencies), new Set(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']))
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(Array.from(plugin.inject), ['connection', 'slots', 'layout', 'workspaces', 'uiWorkspace', 'uiSession', 'sessions', 'conversation'])
})
