import test from 'node:test'
import assert from 'node:assert/strict'
import {controlledDiagnosticProposal} from './controlled-diagnostic-proposal.ts'
import {diagnosticProposalService} from './diagnostic-services.ts'
globalThis.fetch=()=>{throw new Error('fixture禁止上游')}
const mappings={portEvidence:['master','get_soc_asset_port_evidence',{ip:'192.0.2.2',port:80,protocol:'tcp'}]}
function fixture(proposal){let calls=0;const context={signal:new AbortController().signal,shared:{diagnostic_loop:{round:2},causes:[],facts:{}},progress(){}};const services={describe:async()=>({readonly:true,inputSchema:{type:'object'}}),validateSchema:(_s,a)=>a.port===80,propose:async()=>{calls++;return {proposal,model:{provider:'fixture',model:'fixture'}}}};return {context,services,calls:()=>calls}}
test('fixture：只接受剧本绑定参数，目录外写入和越界参数均拒绝',async()=>{
 for(const proposal of [{check:'delete_soc_layer_by_id',args:{id:1},reason:'删除'},{check:'portEvidence',args:{ip:'192.0.2.3',port:80,protocol:'tcp'},reason:'越界'}]){
  const f=fixture(proposal);await assert.rejects(controlledDiagnosticProposal(f.services,mappings,{available_checks:['portEvidence','delete_soc_layer_by_id']},{connections:{master:'master'}},f.context),/超出/)
 }
 const f=fixture({check:'portEvidence',args:mappings.portEvidence[2],reason:'区分监听缺口'})
 assert.equal((await controlledDiagnosticProposal(f.services,mappings,{available_checks:['portEvidence']},{connections:{master:'master'}},f.context)).check,'portEvidence')
 assert.equal(f.context.shared.diagnostic_loop.proposals[0].status,'returned')
})
test('fixture：无合规能力不调用模型，原生模型服务真正消费流式结果',async()=>{
 const f=fixture(null);assert.equal((await controlledDiagnosticProposal(f.services,mappings,{available_checks:['delete_soc_layer_by_id']},{connections:{}},f.context)).check,null);assert.equal(f.calls(),0)
 let prepared=0
 const infer=diagnosticProposalService({prepareCall:async()=>{prepared++;return {config:{},async *stream(){yield {type:'text-delta',text:'{"check":null,"reason":"无能力"}'};yield {type:'finish',reason:{kind:'stop'}}}}}},()=>({provider:'fixture',model:'fixture'}))
 assert.equal((await infer({choices:[]},f.context.signal)).proposal.check,null);assert.equal(prepared,1)
})
test('提议独立预算：模型超预算时收口为不继续，不抛给执行器', async () => {
  const context = { signal: new AbortController().signal, shared: { diagnostic_loop: { round: 3, proposal_budget_ms: 40 }, causes: [], facts: {} }, progress() {} }
  const services = { describe: async () => ({ readonly: true, inputSchema: { type: 'object' } }), validateSchema: () => true,
    propose: () => new Promise(() => {}) }
  const result = await controlledDiagnosticProposal(services, { portEvidence: ['master', 'get_soc_asset_port_evidence', { ip: '192.0.2.2', port: 80, protocol: 'tcp' }] },
    { available_checks: ['portEvidence'] }, { connections: { master: 'master' } }, context)
  assert.equal(result.check, null)
  assert.match(result.reason, /独立预算 40ms/)
  assert.equal(context.shared.diagnostic_loop.proposals.at(-1).status, 'timeout')
})
