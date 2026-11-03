import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = mkdtempSync(resolve('.local/audit-guide-20261103/sdk-utf8-'))
const dir = join(root, 'operation'); mkdirSync(dir)
const cli = join(root, 'fake-cli.mjs')
writeFileSync(cli, `const raw=Buffer.from(JSON.stringify({type:'result',profile:'sdk',name:'audit-instance',status:'completed',final_response:'你好'})+'\\n');const at=raw.indexOf(Buffer.from('你'));process.stdout.write(raw.subarray(0,at+1));setTimeout(()=>process.stdout.write(raw.subarray(at+1)),60);`)
writeFileSync(join(dir, 'worker.json'), JSON.stringify({ root, program: root, cli, secret_env_keys: [], model_policy: false }))
writeFileSync(join(dir, 'operation.json'), JSON.stringify({ id: 'audit-utf8', instance_id: 'audit-instance', source: 'experiment:EXP-audit-001', status: 'starting', events: [] }))
writeFileSync(join(dir, 'input.json'), '{}')
const child = spawnSync(process.execPath, [resolve('platform/plugin/src/sdk/worker.ts'), dir], { env: { ...process.env, HARNESS_PYTHON: process.execPath }, encoding: 'utf8', timeout: 5000 })
const operation = JSON.parse(readFileSync(join(dir, 'operation.json'), 'utf8'))
const result = { childExit: child.status, expected: '你好', actual: operation.final_response, operationStatus: operation.status, correct: operation.final_response === '你好', stderrEmpty: child.stderr === '' }
writeFileSync(resolve('.local/audit-guide-20261103/runtime-sdk-utf8-repro.json'), JSON.stringify(result, null, 2)+'\n')
console.log(JSON.stringify(result))
