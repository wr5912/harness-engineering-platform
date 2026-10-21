export type HomeMode = 'general' | 'build' | 'evaluate' | 'improve' | 'manage'
export const PLATFORM_SLOGAN = '让智能体真正可用，持续变好。'
export const HOME_SUBTITLE = '描述目标，协同构建、评测与改进，也能处理实例和工具管理。'
export const GENERAL_PLACEHOLDER = '例如：检查巡检助手的评测结果，定位遗漏并提出改进方案。'
export const HOME_MODES = [
  { id: 'build', label: '构建智能体', action: '开始构建' },
  { id: 'evaluate', label: '评测效果', action: '开始评测' },
  { id: 'improve', label: '改进能力', action: '开始改进' },
  { id: 'manage', label: '管理实例与工具', action: '开始管理' },
] as const
export const DEMO_AGENT = 'daily-inspection-assistant'
export const DEMO_CASE = 'U-ASSET-PAGES-001'
export const DEMO_BUILD_PROMPT = '帮我构建一个基础台账整理智能体。只整理用户提供的模拟资产清单，不连接外部设备：DEMO-01、DEMO-02、DEMO-03、DEMO-04、DEMO-05 的状态均为“台账已记录”。请生成包含全部设备和数量汇总的 Markdown 报告，明确它不是实时设备健康检测。先复用已有能力，配置业务测试，实际评测后交付可使用的实例与报告。'

/** 入口只决定任务目标；执行继续使用既有助手提案、真实工具与确认机制。 */
export function homeTaskRequest(mode: HomeMode, prompt: string): { prompt: string; context: Record<string, unknown> } {
  const task = prompt.trim()
  if (mode === 'general') {
    if (!task) throw new Error('请先描述你的问题或任务。')
    return { prompt: task, context: { page: 'home', entry_intent: 'general' } }
  }
  if (mode === 'build') {
    return { prompt: task || '请先了解我要构建的业务智能体的用途、输入、可复用资产和业务测试。信息不足时集中询问，明确目标与来源后展示完整任务范围；经确认再创建、评测和交付，不把预览当成完成。', context: {
      page: 'home', skill: 'task-builder', workflow: 'creation', entry_intent: 'build',
    } }
  }
  if (mode === 'evaluate') {
    return { prompt: task || '请先查询当前工作区的智能体、版本、已有测试用例和运行记录，帮助我确定评测目标。先利用已有信息，仍有歧义时集中询问必要信息；明确并固定来源版本、测试用例和评判口径，说明环境与执行范围，经整体确认后开展真实评测，保存并解释实际结果。缺少用例或运行条件时先说明，不将预览当作评测通过。', context: {
      page: 'home', skill: 'agent-maintenance', workflow: 'evaluation', entry_intent: 'evaluate',
    } }
  }
  if (mode === 'improve') {
    return { prompt: task || '请先查询当前工作区的智能体、已有能力和运行记录，帮助我确定值得改进或优化的任务。先利用已有信息，仍有歧义时集中询问必要信息；固定来源版本、原始证据与评判口径，提出明确的目标、评测、执行范围和预算后，再请求整体确认。在最多 3 轮“分析问题→修改→复测”内改进，条件不足或达到预算时如实停止。', context: {
      page: 'home', skill: 'task-builder', workflow: 'improvement', entry_intent: 'improve',
      max_repair_rounds: 3,
    } }
  }
  return { prompt: task || '请先查询当前工作区的实例与 MCP 工具状态，帮助我确定需要管理的对象和操作。核对实际配置、影响范围与预览；任何写操作须经确认，完成后以真实回执和重新读取的状态说明结果。', context: {
    page: 'home', entry_intent: 'manage',
  } }
}
