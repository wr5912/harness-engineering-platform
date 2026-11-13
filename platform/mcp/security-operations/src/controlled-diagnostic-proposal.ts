import { canonical } from './diagnostic-context.ts'

/** 剧本允许目录先于模型；分组标签不能授权操作。 */
export async function controlledDiagnosticProposal(services: any, mappings: Record<string, any[]>, input: any, config: any, context: any) {
 if (!services.describe || !services.propose || !services.validateSchema) throw new Error('提议服务或真实Schema校验器未装载')
 const choices: any[]=[]
 for (const check of input.available_checks ?? []) {
  const entry=mappings[check]
  if(!entry) continue
  const capability=await services.describe(config.connections[entry[0]],entry[1],context.signal)
  if(capability.readonly!==true || !services.validateSchema(capability.inputSchema,entry[2])) continue
  choices.push({check,operation:entry[1],args:entry[2],inputSchema:capability.inputSchema})
 }
 if(!choices.length) return {check:null,reason:'允许目录内无尚未尝试且已核GET合同/参数的能力'}
 const loop=context.shared.diagnostic_loop
 const attempt={round:loop.round,status:'unknown',choices:choices.map(x=>x.check)}
 loop.proposals??=[];loop.proposals.push(attempt)
 context.progress({status:'running',result:{kind:'diagnostic-proposal',attempts:loop.proposals}})
 // 提议使用独立有界预算：必须早于外层执行器 deadline 收口，超时/中止不抛给 LFX。
 const budgetMs = Number(context.shared?.diagnostic_loop?.proposal_budget_ms ?? 30000)
 let reply
 let timer
 const budget = new Promise((_resolve, reject) => {
  timer = setTimeout(() => reject(Object.assign(new Error(`提议超出独立预算 ${budgetMs}ms`), { name: 'TimeoutError' })), budgetMs)
 })
 try {
  reply=await Promise.race([services.propose({choices,candidates:context.shared.causes,facts:Object.values(context.shared.facts)},
    AbortSignal.any([context.signal, AbortSignal.timeout(budgetMs)])), budget])
 } catch (error: any) {
  clearTimeout(timer)
  attempt.status='timeout'
  attempt.error=String(error?.message ?? error)
  return {check:null,reason:`提议在独立预算 ${budgetMs}ms 内未返回或被中止；本次不继续、不重试，保留已保存事实并收口`}
 }
 Object.assign(attempt,{status:'returned',model:reply.model,proposal:reply.proposal})
 clearTimeout(timer)
 const proposal=reply.proposal, selected=choices.find(choice=>choice.check===proposal?.check)
 if(proposal?.check===null) return {check:null,reason:String(proposal.reason??'无合规的区分检查')}
 if(!selected || typeof proposal.reason!=='string' || !proposal.reason.trim() || canonical(proposal.args)!==canonical(selected.args)
  || !services.validateSchema(selected.inputSchema,proposal.args)) throw new Error('提议超出剧本GET目录、冻结对象/参数或真实Schema')
 return {check:selected.check,reason:proposal.reason}
}
