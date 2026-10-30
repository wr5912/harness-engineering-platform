import assert from 'node:assert/strict'
import test from 'node:test'
import { total } from './total.ts'
test('金额在乘法后保留两位小数', () => {
  assert.equal(total(3, 0.333), 1)
  assert.equal(total(2, 12.5), 25)
})
