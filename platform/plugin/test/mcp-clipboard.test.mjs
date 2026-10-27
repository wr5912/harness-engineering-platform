import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [new URL('../../../plugins/mcp-manager/clipboard.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs' })).outputFiles[0].text

test('复制兼容原生剪贴板、HTTP 页面及权限拒绝，失败清理并恢复焦点', async () => {
  for (const mode of ['native', 'missing', 'denied', 'failed', 'throw']) {
    const copied = [], events = [], module = { exports: {} }
    const input = { style: {}, value: '', select() { events.push('select') }, remove() { events.push('remove') } }
    vm.runInNewContext(source, { module, exports: module.exports,
      navigator: mode === 'missing' ? {} : { clipboard: { async writeText(value) {
        if (mode !== 'native') throw new Error('denied')
        copied.push(value)
      } } },
      document: { activeElement: { focus(options) { assert.equal(options.preventScroll, true); events.push('focus') } },
        createElement: () => input, body: { appendChild() { events.push('append') } },
        execCommand(command) {
          assert.equal(command, 'copy')
          if (mode === 'throw') throw new Error('unsupported')
          if (mode === 'failed') return false
          copied.push(input.value)
          return true
        } },
    })
    if (['failed', 'throw'].includes(mode)) await assert.rejects(module.exports.copyText('分组链接'))
    else { await module.exports.copyText('分组链接'); assert.deepEqual(copied, ['分组链接']) }
    assert.deepEqual(events, mode === 'native' ? [] : ['append', 'select', 'remove', 'focus'])
  }
})
