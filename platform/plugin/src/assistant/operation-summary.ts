export interface OperationMeta {
  kind: 'platform-operation'
  domain: string
  action: string
  input?: Record<string, any>
  proposal_id?: string
  preview?: unknown
  result?: any
  error?: string
  state: 'awaiting_confirmation' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
}

const titles: Record<string, string> = {
  'migrations/inspect': '清点迁移来源', 'migrations/read': '读取迁移来源文件', 'migrations/preview': '核对迁移资产映射', 'migrations/apply': '生成迁移资产', 'migrations/status': '查询迁移进度',
  'migrations/resolve': '记录迁移待办解决依据',
  'assets/build-preview': '核对资产构建', 'assets/build': '构建智能体插件', 'assets/dependencies/prepare': '准备智能体依赖',
  'documents/read': '读取知识文档',
  'research/read-reference': '读取研究方法', 'research/validate': '检查研究资产', 'legacy/inspect': '清点导入来源', 'decision/preview': '核对研究结论', 'decision/update': '保存研究结论',
  context: '读取工作区与任务目标', describe: '读取操作用法', list: '查询智能体', detail: '读取智能体详情',
  'tasks/capabilities': '查找可复用能力', 'assets/read-fixed': '读取固定版本文件', 'assets/diff': '比较版本资产',
  'features/read-source': '读取版本说明', 'features/preview': '整理版本特性方案', 'features/apply': '保存版本特性',
  'cases/read': '读取测试用例', 'cases/list': '查询测试用例', 'cases/create': '新增测试用例', 'cases/update': '修改测试用例',
  'edit/read': '读取资产文件', 'edit/preview': '核对资产修改', 'edit/apply': '保存资产修改',
  'eval/preview': '核对评测范围', 'eval/start': '启动评测', 'eval/status': '查询评测进度', 'eval/cancel': '取消评测',
  'runs/index': '查询运行记录', 'runs/show': '读取运行详情', 'runs/report': '读取评测报告', 'runs/read-file': '读取运行文件', 'runs/trace': '读取执行轨迹',
  'tasks/assembly-preview': '核对能力装配', 'tasks/assembly-apply': '装配复用能力',
  'compute-variants/context': '读取算力变体进度', 'compute-variants/preview': '核对算力变体计划', 'compute-variants/create': '创建探索性算力变体', 'compute-variants/rename': '修改变体名称',
  'compute-variants/build-preview': '核对工作流构建', 'compute-variants/build': '构建工作流代码', 'compute-variants/freeze-preview': '预览本地数据冻结差异', 'compute-variants/freeze': '冻结本次数据差异', 'compute-variants/compare': '比较任务效果与资源',
  'datasets/source': '读取决策样本来源', 'datasets/preview': '核对待保存决策样本', 'datasets/apply': '保存待复核决策样本', 'datasets/list': '查询决策样本集',
  new: '创建智能体资产', create: '从固定父版派生', configuration: '读取 MCP 配置', saveConfiguration: '保存 MCP 配置',
  callTool: '调用 MCP 工具', callPublishedComposition: '执行工具组合', test: '测试工具连接',
  'control/status': '读取业务运行权限', 'control/saveConfiguration': '保存业务开放规则',
  'control/restrict': '收紧业务操作', 'control/reassess': '重新评估风险', 'control/release': '复评并解除所选限制',
}

/** 只翻译实际字段；接口返回、资产创建和任务通过是不同结果。 */
export function operationSummary(meta: OperationMeta, phase = 'result') {
  const input = meta.input ?? {}
  let value = meta.result
  let error = meta.error
  const receipts: any[] = []
  for (let n = 0; n < 6 && value && typeof value === 'object'; n++) {
    receipts.push(value)
    error ??= value.error?.message ?? (typeof value.error === 'string' ? value.error : undefined)
    if ((value.kind === 'platform-operation' || typeof value.state === 'string') && value.result !== undefined) value = value.result
    else if (value.ok === true && value.value !== undefined) value = value.value
    else break
  }
  const action = meta.action
  const instanceReceipt = meta.domain === 'instances' ? receipts.find(item => typeof item.operation === 'string' && typeof item.name === 'string') : undefined
  const instanceOperation = instanceReceipt?.operation ?? input.operation
  let title = action === 'list' ? ({ agents: '查询智能体', instances: '查询实例', mcp: '查询 MCP 工具与组合' } as Record<string, string>)[meta.domain] : meta.domain === 'instances' && action === 'run' ? ({ create: '创建实例', start: '启动实例', stop: '停止实例', restart: '重启实例', delete: '删除实例' } as Record<string, string>)[instanceOperation] : meta.domain === 'instances' && action === 'preview' ? '核对实例操作范围' : titles[action]
  title ??= action || `平台${meta.domain}操作`
  if (action === 'describe' && typeof value?.action === 'string') title += `：${titles[value.action] ?? value.action}`
  const file = input.path ?? value?.selected?.path
  const agent = value?.agent?.name ?? value?.agent?.manifest?.name ?? input.agent_id
  const version = /-(\d{3})(?:-r[0-9a-f]{12})?$/.exec(input.experiment_id ?? value?.experiment?.id ?? '')?.[1]
  const target = file ? String(file).split('/').at(-1) : input.variant_name ?? value?.variant_name ?? input.name ?? input.toolName ?? (agent ? `${agent}${version ? ` · 版本 ${version}` : ''}` : version ? `版本 ${version}` : undefined)
  if (target) title += `：${target}`
  if (meta.state === 'failed' || value?.ok === false || value?.isError === true) return { title, outcome: error || value?.checks?.find((check: any) => check.ok === false)?.message || '操作失败，请展开查看实际回执', failed: true }
  if (meta.state === 'unknown') return { title, outcome: error || '结果未知，请先核对实际状态', failed: true }
  if (meta.state === 'cancelled') return { title, outcome: '已取消', failed: false }
  if (meta.state === 'awaiting_confirmation') return { title, outcome: '等待确认', failed: false }
  if (meta.state === 'running' && meta.result === undefined) return { title, outcome: '正在执行', failed: false }
  if (phase !== 'result') return { title, outcome: phase === 'preparing' ? '正在准备参数' : '正在执行', failed: false }
  let outcome = '已收到回执，可展开查看'
  if (action === 'context' && value?.workspace) outcome = '已读取当前工作区与固定任务目标'
  else if (action === 'describe' && value?.input_schema) outcome = '已取得该操作的参数要求'
  else if (action === 'features/apply' && Array.isArray(value?.features)) outcome = `已保存 ${value.features.length} 项特性`
  else if (action === 'datasets/apply' && Array.isArray(value?.dataset?.records)) outcome = `已保存 ${value.dataset.records.length} 条候选样本，标签待复核`
  else if (meta.domain === 'instances' && action === 'preview' && instanceReceipt) {
    const plan = instanceReceipt.plan ?? instanceReceipt
    const source = /-(\d{3})(?:-r[0-9a-f]{12})?$/.exec(plan.source_id ?? '')?.[1]
    outcome = `已核对${source ? `版本 ${source}` : '所选来源'}${plan.port ? `、端口 ${plan.port}` : ''}；尚未执行实例操作`
  } else if (meta.domain === 'instances' && action === 'run' && instanceReceipt) {
    // CLI 最后一条 JSON 可能只是工作区提示；运行状态来自同一回执的容器观察。
    const observed = receipts.flatMap(item => Array.isArray(item.json_objects) ? item.json_objects : []).find(item => item?.name === instanceReceipt.name && typeof item.dsh_running === 'boolean')
    outcome = observed ? `DSH 当前${observed.dsh_running ? '正在运行' : '未运行'}${observed.port ? `，端口 ${observed.port}` : ''}；业务效果仍需核验` : '实例命令已执行，最终状态需查询实例核对'
  }
  else if (action === 'tasks/capabilities' && Array.isArray(value?.sources)) outcome = `找到 ${value.sources.length} 个资产来源${Array.isArray(value.mcp) ? `、${value.mcp.length} 个 MCP 连接` : ''}；尚未验证运行效果`
  else if (action === 'detail' && value?.experiment) outcome = `已读取版本${version ? ` ${version}` : ''}${Array.isArray(value.evaluation?.cases) ? `、${value.evaluation.cases.length} 个测试用例` : ''}`
  else if (action === 'eval/status') outcome = ({ running: '评测运行中', queued: '评测等待执行', completed: '评测已结束，结果以运行报告为准', failed: '评测执行失败', cancelled: '评测已取消', interrupted: '评测已中断，已保留现有证据' } as Record<string, string>)[value?.status] ?? '评测状态尚未明确'
  else if (action === 'eval/start' && value?.job_id) outcome = '评测已启动'
  else if (action === 'eval/preview') outcome = '已核对评测范围，尚未启动运行'
  else if (action === 'new' || action === 'create') outcome = value?.experiment_id ? '已创建研究版本，业务效果仍需评测' : outcome
  else if (action === 'edit/preview' && Array.isArray(value?.edits)) outcome = `已核对 ${value.edits.length} 份文件修改；尚未写入`
  else if (action === 'edit/apply' && value) outcome = '已保存资产修改'
  else if (action === 'compute-variants/rename' && value?.variant_name) outcome = `已保存变体名称：${value.variant_name}`
  else if (action === 'decision/update' && value) outcome = '已保存研究结论与依据'
  else if (action === 'decision/preview' && value) outcome = '已核对研究结论及状态变更；尚未写入'
  else if (action === 'documents/read' && Array.isArray(value?.blocks)) outcome = `已读取 ${value.filename ?? '文档'} 的 ${value.blocks.length} 个正文片段${value.has_more ? '，尚有后续内容' : '，正文读取完毕'}${value.warnings?.length ? '；请核对提取说明' : ''}`
  else if (action === 'research/read-reference' && value?.content) outcome = '已读取当前数据工作区中的研究方法'
  else if (action === 'research/validate' && typeof value?.valid === 'boolean') outcome = value.valid ? '研究资产格式检查通过；业务效果需依据实际评测' : '研究资产检查发现问题，请查看实际回执'
  else if (action === 'legacy/inspect' && value) outcome = '来源清点已返回；未执行导入内容'
  else if (action === 'migrations/inspect' && value) outcome = '已固定并清点来源；等待行为映射'
  else if (action === 'migrations/read' && value) outcome = '已读取来源文件；请核对引用与后续内容'
  else if (action === 'migrations/preview' && value) outcome = '已核对迁移计划和目标；尚未生成资产'
  else if (action === 'migrations/apply' && value) outcome = '迁移资产已生成；装载与任务验证继续办理'
  else if (action === 'migrations/status' && value) outcome = value.completed === true ? '已取得当前资产的迁移验证结果，请核对适用范围' : '已读取实际迁移进度与待办项'
  else if (action === 'migrations/resolve' && value) outcome = '已记录当前资产的解决依据；关键任务验证仍以真实 Run 为准'
  else if (action === 'assets/build-preview' && value) outcome = '已核对源码、依赖及构建产物；尚未写入'
  else if (action === 'assets/build' && value) outcome = '构建已返回；实际装载与业务效果仍需验证'
  else if (action === 'assets/dependencies/prepare' && value) outcome = '依赖准备已返回；请核对目标环境与缺口'
  else if (action === 'assets/read-fixed' && value?.files) outcome = value.selected ? '已读取固定文件内容' : `已列出 ${value.files.length} 个固定版本文件`
  else if (action === 'context') outcome = '已读取当前工作区与固定任务目标'
  else if (action === 'runs/index' && Array.isArray(value?.experiments)) outcome = `查到 ${value.experiments.length} 个版本、${value.experiments.reduce((count: number, experiment: any) => count + (Array.isArray(experiment.runs) ? experiment.runs.length : 0), 0)} 条运行记录`
  else if (action === 'list' && Array.isArray(value?.agents)) outcome = `查到 ${value.agents.length} 个智能体`
  else if (meta.domain === 'instances' && action === 'list' && Array.isArray(value?.instances)) outcome = `查到 ${value.instances.length} 个实例`
  else if (meta.domain === 'mcp' && action === 'list' && Array.isArray(value?.connections)) outcome = `查到 ${value.connections.length} 个连接${Array.isArray(value.compositions) ? `、${value.compositions.length} 个工具组合` : ''}`
  else {
    const items = ['agents', 'instances', 'cases', 'runs', 'datasets', 'items'].map(key => value?.[key]).find(Array.isArray)
    if (items) outcome = `已读取 ${items.length} 项`
    else if (['edit/read', 'runs/read-file', 'runs/report', 'features/read-source', 'cases/read'].includes(action) && value !== undefined) outcome = '已读取内容'
  }
  if (value?.ready === false) outcome = `尚未交付：${value.checks?.find((check: any) => check.ok === false)?.message ?? '检查未通过'}`
  return { title, outcome, failed: value?.ready === false || ['failed', 'interrupted'].includes(value?.status) }
}
