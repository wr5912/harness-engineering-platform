import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {workflowRuns} from '../src/mcp/workflow-runs.ts'
test('平台生产存储：同版本冻结范围持久追加并拒绝范围变化/未知重放',async()=>{
 const root=mkdtempSync(join(tmpdir(),'diagnostic-resume-')),store=workflowRuns(root),request={config:{workflow:'check'},input:{asset:{ip:'192.0.2.1'}},catalog:{},version:{versionId:'fixed',implementationDigest:'fixed'},compositionId:'check',executionId:'first'},workflow={responseMode:'complete'}
 const prepare=async()=>({scope:{requested:request.input},facts:{},receipts:{},rounds:[],connection_fingerprints:{master:'fixed'},diagnostic_loop:{round:0,attempts:{}}})
 const first=await store.start(request,workflow,async c=>{c.shared.facts.original={id:'original',source:'receipt'};c.shared.rounds.push({id:'round-1'});c.shared.diagnostic_loop.attempts.original={status:'unknown'};c.progress({status:'completed'});return {result:{saved:true}}},prepare)
 const second=await store.start({...request,input:{...request.input,resume_run_id:first.run_id},executionId:'second'},workflow,async c=>{assert.equal(c.shared.facts.original.source,'receipt');assert.equal(c.shared.rounds.length,1);assert.match(c.shared.diagnostic_loop.stop_reason,/未知/);assert.equal(c.shared.diagnostic_id,first.run_id);return {result:{replayed:false}}},prepare)
 assert.equal(second.status,'completed');assert.equal(second.result.replayed,false)
 await assert.rejects(store.start({...request,input:{asset:{ip:'192.0.2.2'},resume_run_id:first.run_id},executionId:'changed'},workflow,async()=>{throw new Error('不可执行')},prepare),/不能改变/)
})
