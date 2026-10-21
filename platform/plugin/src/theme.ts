import { baseTheme } from './styles/base.ts'
import { homePageTheme } from './home/style.ts'
import { agentPageTheme } from './agents/style.ts'
import { computePlanningTheme } from './agents/compute-planning-style.ts'
import { evaluationPageTheme } from './evaluation/style.ts'
import { mcpPageTheme } from './mcp/style.ts'
import { assistantTheme } from './assistant/style.ts'

// 公共规则在前，页面只维护所属布局与状态。
export const platformTheme = [baseTheme, homePageTheme, agentPageTheme, computePlanningTheme, evaluationPageTheme, mcpPageTheme, assistantTheme].join('\n')
