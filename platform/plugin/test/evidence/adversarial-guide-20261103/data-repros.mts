import {build} from '../../platform/plugin/node_modules/esbuild/lib/main.js'
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {trainingFixture} from '../../platform/plugin/test/fixtures/decision-training.mjs'
const base=resolve('.local/audit-guide-20261103'), out=join(base,'compiled')
mkdirSync(out,{recursive:true})
await build({entryPoints:['platform/plugin/src/evaluation/datasets.ts','platform/plugin/src/agents/compute-training.ts'],outdir:out,bundle:true,platform:'node',format:'esm'})
const {createDecisionDatasetHandler}=await import('file://'+join(out,'evaluation/datasets.js'))
const {inspectDecisionTraining}=await import('file://'+join(out,'agents/compute-training.js'))
mkdirSync(join(base,'fixtures'),{recursive:true});const fixture=mkdtempSync(join(base,'fixtures/dataset-isolation-'));mkdirSync(join(fixture,'evolution/datasets'),{recursive:true})
const healthy={id:'decision-dataset-11111111-1111-4111-8111-111111111111',run_id:'run-11111111-1111-4111-8111-111111111111',path:'evidence/U-EXAMPLE/trace.jsonl',created_at:'2026-11-03T00:00:00.000Z',records:[{state:{messages:[{role:'user',content:'synthetic read-only task'}]},questions:{route:{type:'choice',instructions:'Choose a route',criteria:{A:'one',B:'two'}}},_meta:{id:'decision-11111111111111111111111111111111',label_status:'suggested'}}]}
writeFileSync(join(fixture,'evolution/datasets',healthy.id+'.json'),JSON.stringify(healthy))
const handle=createDecisionDatasetHandler(fixture), before=await handle('datasets/list',{include_eligibility:false}), beforeRead=await handle('datasets/read',{dataset_id:healthy.id})
const corruptId='decision-dataset-22222222-2222-4222-8222-222222222222'
writeFileSync(join(fixture,'evolution/datasets',corruptId+'.json'),'{invalid-json')
let after:any, readAfter:any;try{after=await handle('datasets/list',{run_id:healthy.run_id,include_eligibility:false})}catch(e:any){after={error_code:e.code,message:e.message}}
try{readAfter=await handle('datasets/read',{dataset_id:healthy.id})}catch(e:any){readAfter={error_code:e.code,message:e.message}}
const trainRoot=mkdtempSync(join(base,'fixtures/training-source-'));mkdirSync(trainRoot,{recursive:true})
const f=trainingFixture(trainRoot,['run-fixed'])
for(const [split,row] of Object.entries(f.rows) as any){row._meta.run_id='run-foreign';row._meta.label_status='suggested';row.questions.route.label='NOT_A_DEFINED_CANDIDATE';delete row.questions.route.answer;f.receipt.datasets[split]=f.file(split+'.jsonl',JSON.stringify(row)+'\n')}
f.save()
const training=await inspectDecisionTraining(trainRoot,f.plan)
const report={datasetIsolation:{beforeHealthyCount:before.datasets.length,beforeReadRecords:beforeRead.dataset.records.length,afterFilteredHealthyList:after,afterHealthyRead:readAfter},trainingSource:{declaredSourceRuns:f.receipt.source_run_ids,actualRowSource:'run-foreign',rowLabelStatus:'suggested',invalidLabel:'NOT_A_DEFINED_CANDIDATE',result:training}}
writeFileSync(join(base,'data-repros.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
