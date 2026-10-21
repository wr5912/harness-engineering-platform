import type { PageId, PlatformNavigation } from './protocol.ts'

const pages: PageId[] = ['home', 'conversations', 'agents', 'evaluation', 'instances', 'gateway', 'mcp']
const fields = ['agent_id', 'experiment_id', 'run_id', 'case_id', 'job_id', 'instance_name', 'source_id', 'server_id', 'composition_id', 'version_id', 'tab'] as const
const runTabs = ['report', 'results', 'trace', 'files', 'datasets'] as const

export function readNavigation(hash: string): PlatformNavigation {
  const [path, query] = hash.replace(/^#\/?/, '').split('?')
  const page = pages.includes(path as PageId) ? path as PageId : 'home'
  const result: PlatformNavigation = { page }
  const params = new URLSearchParams(query)
  for (const field of fields) {
    const value = params.get(field)
    if (value && /^[A-Za-z0-9_.:-]{1,200}$/.test(value)) result[field] = value
  }
  const runTab = params.get('run_tab')
  if (page === 'evaluation' && result.tab === 'runs' && result.run_id && !result.case_id && runTabs.includes(runTab as typeof runTabs[number])) result.run_tab = runTab as typeof runTabs[number]
  const listView = params.get('list_view')
  if (listView === 'agents' || listView === 'variants') result.list_view = listView
  const version = params.get('version')
  if (version === 'draft' || version === 'published') result.version = version
  if (params.get('intent') === 'start_eval') result.intent = 'start_eval'
  return result
}

export function navigationHash(target: PlatformNavigation) {
  const params = new URLSearchParams()
  for (const field of fields) if (target[field]) params.set(field, target[field])
  if (target.page === 'evaluation' && target.tab === 'runs' && target.run_id && !target.case_id && target.run_tab && target.run_tab !== 'report' && runTabs.includes(target.run_tab)) params.set('run_tab', target.run_tab)
  if (target.list_view === 'agents' || target.list_view === 'variants') params.set('list_view', target.list_view)
  if (target.version === 'draft' || target.version === 'published') params.set('version', target.version)
  if (target.intent === 'start_eval') params.set('intent', target.intent)
  return `#/${target.page}${params.size ? `?${params}` : ''}`
}
