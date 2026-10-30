import assert from 'node:assert/strict'
import test from 'node:test'
import { guardToolArguments } from '../src/assistant/tool-argument-guard.ts'

const delta = (argumentsDelta, index = 0) => ({ type: 'tool-call-delta', index, id: `call-${index}`, name: 'edit', argumentsDelta })
const end = arguments_ => ({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-0', name: 'edit', arguments: arguments_ } })
async function collect(chunks) {
  const output = []
  let closed = false
  async function* source() { try { yield* chunks } finally { closed = true } }
  for await (const chunk of guardToolArguments(source())) output.push(chunk)
  assert.ok(closed, '退出必须关闭上游迭代器')
  return output
}
const failure = output => output.at(-1).reason.failure

test('交错调用、跨增量转义与字符串内的括号保持原样', async () => {
  const arguments_ = JSON.stringify({ old_string: '中\\文"' + '{['.repeat(100), new_string: 'ok' })
  const chunks = [{ type: 'block-start', index: 0, blockType: 'tool-call' }, delta('{', 1),
    ...Array.from(arguments_, char => delta(char)), delta('}', 1), end(arguments_),
    { type: 'finish', reason: { kind: 'tool-calls' } }]
  assert.deepEqual(await collect(chunks), chunks)
})

test('现场同类的 2900 层畸形输入在第 129 层停止，后续工具块不再下发', async () => {
  const input = '{"file_path":"fixture.txt","old_string":' + '{",":{":":'.repeat(1450)
  assert.ok(input.length < 21000)
  const chunks = [...Array.from(input, char => delta(char)), end(input)]
  const output = await collect(chunks)
  assert.equal(failure(output).code, 'TOOL_ARGUMENT_LIMIT')
  assert.match(failure(output).message, /128 层/)
  assert.ok(output.length < 800, '不能等到读取整个深层参数后再失败')
  assert.ok(!output.some(chunk => chunk.type === 'block-end'))
})

test('深度 128 允许、129 拒绝；没有增量的完整工具块也受检查', async () => {
  const allowed = '['.repeat(128) + '0' + ']'.repeat(128)
  const chunks = [...Array.from(allowed, char => delta(char)), end(allowed)]
  assert.deepEqual(await collect(chunks), chunks)
  assert.deepEqual(await collect([end(allowed)]), [end(allowed)])
  const output = await collect([end('['.repeat(129) + '0' + ']'.repeat(129))])
  assert.equal(failure(output).code, 'TOOL_ARGUMENT_LIMIT')
  assert.equal(output.length, 1)
})

test('累计字节上限按工具区分，长字符串正常通过，超过 1 MiB 停止', async () => {
  const allowed = '"' + 'a'.repeat(1024 * 1024 - 2) + '"'
  const chunks = [delta(allowed, 0), delta(allowed, 1)]
  assert.deepEqual(await collect(chunks), chunks)
  const output = await collect([delta(allowed.slice(0, -1)), delta('中"'), end(allowed)])
  assert.equal(failure(output).code, 'TOOL_ARGUMENT_LIMIT')
  assert.match(failure(output).message, /1 MiB/)
  assert.ok(!output.some(chunk => chunk.type === 'block-end'))
})

test('普通文本、上游错误和调用者取消不被改写或重试', async () => {
  const chunks = [{ type: 'text-delta', index: 0, text: '正常回复' },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'upstream timeout' } } }]
  assert.deepEqual(await collect(chunks), chunks)
  const abort = new Error('cancelled')
  async function* source() { yield delta('{'); throw abort }
  await assert.rejects(async () => { for await (const _ of guardToolArguments(source())) {} }, error => error === abort)
})
