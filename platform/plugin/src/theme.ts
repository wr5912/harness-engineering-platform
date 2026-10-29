import { baseTheme } from './styles/base.ts'
import { homePageTheme } from './home/style.ts'
import { agentPageTheme } from './agents/style.ts'
import { computePlanningTheme } from './agents/compute-planning-style.ts'
import { evaluationPageTheme } from './evaluation/style.ts'
import { mcpPageTheme } from './mcp/style.ts'
import { assistantTheme } from './assistant/style.ts'
import { workbenchTheme } from './styles/workbench.ts'
import { searchSelectTheme } from './components/search-select.tsx'
import { detailDrawerTheme } from './components/detail-drawer.tsx'
import { loadingIndicatorTheme } from './components/loading-indicator.tsx'
import { overviewChartsTheme } from './components/overview-charts.tsx'

// 公共规则在前，页面只维护所属布局与状态。
export const platformTheme = [baseTheme, homePageTheme, agentPageTheme, computePlanningTheme, evaluationPageTheme, mcpPageTheme, assistantTheme, workbenchTheme, searchSelectTheme, detailDrawerTheme, loadingIndicatorTheme, overviewChartsTheme].join('\n')
