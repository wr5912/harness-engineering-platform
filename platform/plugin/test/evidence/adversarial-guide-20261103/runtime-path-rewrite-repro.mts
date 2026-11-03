import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { rewriteKnownPaths } from '../../platform/deploy/paths.mts'
const sandbox = mkdtempSync(resolve('.local/audit-guide-20261103/path-map-'))
const oldHome = join(sandbox, 'old-home'), newHome = join(sandbox, 'new-home')
const oldData = join(oldHome, 'data'), targetData = join(oldHome, 'restored-data')
mkdirSync(join(targetData, 'config'), { recursive: true })
writeFileSync(join(targetData, 'config/business-access.json'), JSON.stringify({ gateway: { sharedSecretFile: join(oldData, '.local/credentials/business.key') } }))
const report = rewriteKnownPaths(targetData, [{ from: oldHome, to: newHome }, { from: oldData, to: targetData }])
const actual = JSON.parse(readFileSync(join(targetData, 'config/business-access.json'), 'utf8')).gateway.sharedSecretFile
const expected = join(targetData, '.local/credentials/business.key')
const result = { scenario: '跨用户安装时显式选择源HOME下的新数据根', correct: actual === expected, actual, expected, oldReferenceCount: report.oldReferences.length }
writeFileSync(resolve('.local/audit-guide-20261103/runtime-path-rewrite-repro.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
