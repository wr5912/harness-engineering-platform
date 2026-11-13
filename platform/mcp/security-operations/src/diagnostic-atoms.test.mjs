import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeDiagnosticAtoms,businessConfirmCriteria} from './diagnostic-atoms.ts'
import {evaluateCandidate} from './diagnostic-context.ts'
const binding={objectId:'pair:192.0.2.1->192.0.2.2',sourceId:'master',receiptId:'receipt',ip:'192.0.2.2',port:80,protocol:'tcp'}
// 内部适配合同fixture：现场AjaxResult未声明data结构，不能作为SOC成功payload证据。
const observation=predicate=>({ip:'192.0.2.2',port:80,protocol:'tcp',sourceId:'collector',observedAt:'2026-11-10T09:00:00Z',validity:'VALID',applicability:'applicable',predicate,value:predicate==='listener-state'?'not-listening':'stopped'})
test('内部适配合同：平台关联目标到冻结pair，不要求SOC返回pair ID；复合确认走生产评估器',()=>{
 const atoms=normalizeDiagnosticAtoms({items:[observation('listener-state'),observation('service-state')]},binding)
 const rule={id:'service-not-listening',title:'服务未监听',support:[],refute:[],confirm:businessConfirmCriteria['service-not-listening']}
 assert.equal(evaluateCandidate(rule,atoms,binding.objectId).status,'confirmed')
 assert.notEqual(evaluateCandidate(rule,atoms.slice(0,1),binding.objectId).status,'confirmed')
 assert.equal(normalizeDiagnosticAtoms({items:[{...observation('listener-state'),ip:'192.0.2.3'}]},binding).length,0)
 assert.equal(normalizeDiagnosticAtoms({code:403,msg:'没有业务访问权限'},binding).length,0)
 assert.equal(normalizeDiagnosticAtoms({online:false},binding).length,0)
})
