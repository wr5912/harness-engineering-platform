import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repository = process.env.HARNESS_ASSET_ROOT || fileURLToPath(new URL('../../../', import.meta.url))
const program = process.env.HARNESS_PROGRAM_ROOT
const python = process.env.HARNESS_PYTHON || process.env.PYTHON || 'python3'

test('安全运营当前评估来源完整，业务 Case 与单一事实源保持一致', () => {
  assert.ok(program, '测试需要 HARNESS_PROGRAM_ROOT')
  const agent = join(repository, 'agents/security-operations-expert')
  const evaluation = join(agent, 'evaluation.md')
  const text = readFileSync(evaluation, 'utf8')
  // 复用平台解析器；业务清单及其预期随数据仓库一起演进。
  const loaded = JSON.parse(execFileSync(python, ['-c', `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("evaluation_contract", sys.argv[1])
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
print(json.dumps(contract.load_evaluation(Path(sys.argv[2])), ensure_ascii=False))
`, join(program, 'runtime/research/evaluation_contract.py'), evaluation], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 10_000,
  }))
  const headings = [...text.matchAll(/^#### (U-[A-Z0-9-]+) (.+)$/gm)]
  const sourceIds = headings.map(match => match[1])
  assert.equal(existsSync(join(agent, 'definition.md')), false)
  assert.deepEqual(loaded.case_ids, sourceIds)
  assert.equal(new Set(sourceIds).size, sourceIds.length)
  assert.ok(sourceIds.length > 0)
  for (const [index, id] of sourceIds.entries()) {
    assert.match(id, /^U-[A-Z]+-\d{3}$/)
    const item = loaded.cases[id]
    assert.deepEqual(Object.keys(item).sort(), ['case_id', 'expected_behavior', 'inputs', 'title'])
    assert.equal(item.title, headings[index][2])
    assert.ok(item.inputs.length && item.inputs.every(input => input.trim()))
    assert.ok(item.expected_behavior.trim())
  }
  assert.ok(loaded.catalog.every(item => item.scene && item.scene !== '未分组'))
  const sourceFast = headings.filter((match, index) => {
    const block = text.slice(match.index + match[0].length, headings[index + 1]?.index ?? text.length)
    return block.trimStart().startsWith('**评估档位：** `fast`')
  }).map(match => match[1])
  assert.deepEqual(loaded.catalog.filter(item => item.fast).map(item => item.case_id), sourceFast)
  for (const retired of ['**执行器', '**工具边界', '**副作用预算', 'Experiment 评估选择',
    'T-MIGRATION-SOURCE', 'T-DSH-LOAD-CYCLE', 'T-CONTRACT-STATIC', 'T-CONTRACT-LIVE']) {
    assert.equal(text.includes(retired), false)
  }
  assert.deepEqual(globSync('EXP-*/evaluation/plan.yaml', { cwd: join(repository, 'evolution/experiments') }), [])
})
