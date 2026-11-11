import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBrowserInput } from '../src/assistant/browser.ts'
import { assistantActionContract } from '../src/assistant/tool-contracts.ts'

test('页面核验输入只允许登记目标和受限定位器', () => {
  const value = parseBrowserInput({
    target: { kind: 'platform', page: 'mcp' },
    actions: [{ action: 'click', locator: { kind: 'role', value: 'button', name: '发现工具', exact: true } }],
    screenshot: { scope: 'viewport' },
  })
  assert.equal(value.target.kind, 'platform')
  assert.throws(() => parseBrowserInput({
    target: { kind: 'platform', page: 'mcp' },
    actions: [{ action: 'click', locator: { kind: 'css', value: '.danger' } }],
  }))
  assert.throws(() => parseBrowserInput({
    target: { kind: 'url', url: 'http://127.0.0.1:18120' },
  }))
  const contract = assistantActionContract('browser', 'inspect')
  assert.equal(contract.input_schema.$defs.locator.properties.kind.enum.includes('test_id'), true)
})
