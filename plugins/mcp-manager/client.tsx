window.__ModuleLoader__.load({
  id: 'dsh-web-mcp-manager',
  factory(require) {
    const React = require('react')
    const { useEffect, useState } = React
    const formName = 'mcp-session-manager'
    const defaultSpec = 'http://172.16.138.232:18087/v3/api-docs/mcp'
    const emptyServer = () => ({ id: '', description: '', specUrl: '', authType: 'credential',
      apiKey: '', authHeader: 'Authorization', loginUrl: '', loginUsername: '', loginPassword: '', loginTokenPath: 'data.token',
      enabled: true, tools: { mode: 'all', names: [] } })
    const commonHeaders = ['Authorization', 'X-API-Key', 'Api-Key', 'X-Auth-Token']
    const emptyGroup = () => ({ id: '', members: [] })
    const duplicateMemberIds = members => [...new Set(members.map(member => member.serverId)
      .filter((serverId, index, ids) => ids.indexOf(serverId) !== index))]
    const button = (label, action, disabled = false) => <button type="button" onClick={action} disabled={disabled}>{label}</button>
    const styles = `
      .mcp-manager{--mcp-ink:var(--hep-text,var(--dsw-alias-label-primary,#20344c));--mcp-muted:var(--hep-muted,var(--dsw-alias-label-secondary,#607186));--mcp-line:var(--hep-border,var(--dsw-alias-border-l3,#dfe6ee));--mcp-tint:var(--hep-surface-muted,color-mix(in srgb,var(--mcp-surface) 96%,#0075ca));--mcp-blue:var(--hep-primary,#0075ca);--mcp-link:var(--hep-link,#0075ca);--mcp-surface:var(--hep-surface,var(--dsw-alias-bg-layer-1,#fff));--mcp-active:var(--hep-primary-soft,color-mix(in srgb,var(--mcp-surface) 92%,var(--mcp-blue)));width:100%;max-width:1200px;margin:20px auto 40px;color:var(--mcp-ink);font-size:14px;line-height:1.6}
      body[data-ds-dark-theme] .mcp-manager{--mcp-link:var(--hep-link,var(--dsw-alias-link,#7aaaff))}
      .mcp-manager *{box-sizing:border-box}
      .mcp-manager button,.mcp-manager input,.mcp-manager select{font:inherit}
      .mcp-manager button{cursor:pointer;min-height:40px;padding:8px 12px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-surface);color:var(--mcp-ink);line-height:1.4;transition:background var(--hep-motion-fast,140ms),border-color var(--hep-motion-fast,140ms),box-shadow var(--hep-motion-fast,140ms),transform var(--hep-motion-fast,140ms)}
      .mcp-manager button:hover:not(:disabled){background:var(--mcp-tint);border-color:color-mix(in srgb,var(--mcp-blue) 32%,var(--mcp-line))}
      .mcp-manager button:active:not(:disabled){transform:translateY(1px)}
      .mcp-manager button:disabled{cursor:not-allowed;opacity:.5}
      .mcp-manager :is(button,input,select,summary):focus-visible{outline:2px solid var(--mcp-blue);outline-offset:3px}
      .mcp-manager .mcp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px;padding:20px 24px;background:var(--mcp-tint);border:1px solid var(--mcp-line);border-radius:var(--hep-radius,12px)}
      .mcp-manager .mcp-toolbar strong{display:block;font-size:14px}.mcp-manager .mcp-toolbar p{margin:4px 0 0;color:var(--mcp-muted)}
      .mcp-manager .mcp-primary{border-color:var(--mcp-blue);background:var(--mcp-blue);color:#fff;padding:9px 16px;font-weight:600;white-space:nowrap}
      .mcp-manager .mcp-primary:hover:not(:disabled){background:var(--hep-primary-hover,#0063ab);border-color:var(--hep-primary-hover,#0063ab)}
      .mcp-manager .mcp-shell{min-width:0}
      .mcp-manager .mcp-tabs{display:flex;gap:24px;margin-bottom:24px;border-bottom:1px solid var(--mcp-line);overflow-x:auto}
      .mcp-manager .mcp-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--mcp-muted);padding:12px 0;white-space:nowrap;font-weight:500}
      .mcp-manager .mcp-tabs button[aria-current=page]{border-color:var(--mcp-blue);color:var(--mcp-link);font-weight:600}
      .mcp-manager .mcp-tabs small{margin-left:6px;padding:2px 6px;border-radius:6px;background:var(--mcp-tint);color:inherit;font-size:12px;font-variant-numeric:tabular-nums}
      .mcp-manager .mcp-content{min-width:0}
      .mcp-manager h3{margin:0;color:var(--mcp-ink);line-height:1.4;overflow-wrap:anywhere;font-size:16px}
      .mcp-manager .mcp-muted{color:var(--mcp-muted);line-height:1.6;overflow-wrap:anywhere}
      .mcp-manager .mcp-layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:24px;align-items:start}
      .mcp-manager .mcp-card{min-width:0;border:1px solid var(--mcp-line);border-radius:var(--hep-radius,12px);background:var(--mcp-surface);padding:24px}
      .mcp-manager .mcp-sidebar{padding:8px;background:var(--mcp-tint);border-color:transparent}
      .mcp-manager .mcp-list-item{display:block;width:100%;margin:0 0 4px;padding:12px;border-color:transparent;background:transparent;text-align:left;color:var(--mcp-ink)}
      .mcp-manager .mcp-list-item:hover:not(:disabled){background:var(--mcp-surface);border-color:transparent}.mcp-manager .mcp-list-item[aria-current=true]{background:var(--mcp-surface);border-color:var(--mcp-line);box-shadow:0 2px 8px #16395908;color:var(--mcp-link)}
      .mcp-manager .mcp-list-item strong{display:block;overflow-wrap:anywhere;font-weight:600}.mcp-manager .mcp-list-item small{display:block;margin-top:4px;color:var(--mcp-muted);font-size:12px;overflow-wrap:anywhere}
      .mcp-manager .mcp-service-search{display:grid;gap:6px;padding:8px 4px 12px;color:var(--mcp-muted);font-size:12px}.mcp-manager .mcp-service-search input{width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-surface);color:var(--mcp-ink)}
      .mcp-manager .mcp-service-count{display:block;padding:4px 8px 10px;color:var(--mcp-muted);font-size:12px}.mcp-manager .mcp-mobile-service-picker{display:none}
      .mcp-manager .mcp-service-facts{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;color:var(--mcp-muted);font-size:12px}
      .mcp-manager .mcp-list-item .mcp-service-facts{display:grid;gap:2px}
      .mcp-manager .mcp-service-facts>span{overflow-wrap:anywhere}
      .mcp-manager .mcp-add{width:100%;margin-top:8px;border:1px dashed var(--mcp-line);background:transparent;color:var(--mcp-link);padding:10px;font-weight:500}
      .mcp-manager .mcp-card-head{display:flex;align-items:start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:20px;border-bottom:1px solid var(--mcp-line)}
      .mcp-manager .mcp-card-head>div{min-width:0}.mcp-manager .mcp-card-head p{margin:6px 0 0}.mcp-manager .mcp-card-head .mcp-switch{flex:none;margin:0}
      .mcp-manager .mcp-card-head .mcp-actions{margin:0}.mcp-manager .mcp-card-head .mcp-switch{align-self:center}
      .mcp-manager .mcp-service-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0 16px}
      .mcp-manager .mcp-service-summary article{display:grid;align-content:start;gap:6px;min-width:0;padding:14px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-tint)}
      .mcp-manager .mcp-service-summary strong{font-size:16px;line-height:1.4;overflow-wrap:anywhere}.mcp-manager .mcp-service-summary small{color:var(--mcp-muted);font-size:12px;overflow-wrap:anywhere}
      .mcp-manager .mcp-service-scope{margin:0 0 16px;padding:12px 14px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-tint);color:var(--mcp-muted);font-size:12px}
      .mcp-manager .mcp-service-tabs{display:flex;gap:20px;overflow-x:auto;border-bottom:1px solid var(--mcp-line)}
      .mcp-manager .mcp-service-tabs button{flex:none;padding:12px 0;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--mcp-muted)}
      .mcp-manager .mcp-service-tabs button[aria-current=page]{border-bottom-color:var(--mcp-blue);color:var(--mcp-link);font-weight:600}
      .mcp-manager .mcp-discovered-list{list-style:none;margin:16px 0 0;padding:0}.mcp-manager .mcp-discovered-list li{display:flex;align-items:start;justify-content:space-between;gap:16px;margin:0 0 12px;padding:16px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px)}
      .mcp-manager .mcp-discovered-list li>div{min-width:0;overflow-wrap:anywhere}.mcp-manager .mcp-discovered-list li p{margin:6px 0 0;font-size:12px}.mcp-manager .mcp-discovered-list li button{flex:none}
      .mcp-manager .mcp-section{padding-top:24px}.mcp-manager .mcp-section+.mcp-section{margin-top:24px;border-top:1px solid var(--mcp-line)}
      .mcp-manager .mcp-section h3{margin-bottom:16px}.mcp-manager .mcp-section>p{margin:0 0 16px}
      .mcp-manager .mcp-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px}
      .mcp-manager label.mcp-field{display:grid;gap:8px;min-width:0;color:var(--mcp-ink);font-weight:500}
      .mcp-manager .mcp-field input,.mcp-manager .mcp-field select{width:100%;min-width:0;min-height:40px;padding:8px 12px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-surface);color:var(--mcp-ink);font-weight:400;transition:border-color var(--hep-motion-fast,140ms),box-shadow var(--hep-motion-fast,140ms)}
      .mcp-manager .mcp-field input:focus,.mcp-manager .mcp-field select:focus{border-color:var(--mcp-blue);box-shadow:0 0 0 3px var(--mcp-active)}
      .mcp-manager .mcp-field small{font-size:12px;color:var(--mcp-muted);font-weight:400}
      .mcp-manager .mcp-wide{grid-column:1/-1}.mcp-manager .mcp-switch,.mcp-manager .mcp-check{display:flex;align-items:center;gap:10px;cursor:pointer}
      .mcp-manager .mcp-switch input,.mcp-manager .mcp-check input{width:16px;height:16px;flex:none;accent-color:var(--mcp-blue)}
      .mcp-manager .mcp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:20px}
      .mcp-manager .mcp-danger{color:var(--hep-danger,var(--dsw-alias-danger-text,#bd3a42));border-color:color-mix(in srgb,var(--hep-danger,var(--dsw-alias-danger-text,#bd3a42)) 25%,var(--mcp-line))}
      .mcp-manager .mcp-note{padding:16px;border-radius:var(--hep-control-radius,8px);background:var(--mcp-tint);color:var(--mcp-muted)}
      .mcp-manager .mcp-status{margin:0 0 20px;padding:12px 16px;border-left:3px solid var(--mcp-blue);border-radius:0 8px 8px 0;background:var(--mcp-active);color:var(--mcp-ink);overflow-wrap:anywhere}
      .mcp-manager .mcp-link{display:block;min-width:0;max-width:100%;overflow-wrap:anywhere;padding:10px 12px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-tint);color:var(--mcp-link)}
      .mcp-manager .mcp-server-tools{border-bottom:1px solid var(--mcp-line);margin-top:12px;background:var(--mcp-surface)}
      .mcp-manager .mcp-server-tools summary{display:flex;align-items:center;gap:8px;cursor:pointer;padding:12px 0;font-weight:500;list-style:none;overflow-wrap:anywhere}
      .mcp-manager .mcp-server-tools summary::-webkit-details-marker{display:none}.mcp-manager .mcp-server-tools summary::before{content:'▸';flex:none;color:var(--mcp-link);transition:transform var(--hep-motion-fast,140ms)}.mcp-manager .mcp-server-tools[open] summary::before{transform:rotate(90deg)}
      .mcp-manager .mcp-server-tools summary .mcp-muted{margin-left:auto;flex:none;font-size:12px}
      .mcp-manager .mcp-tool-body{padding:4px 0 16px}.mcp-manager .mcp-tool-body p{margin:0 0 12px}
      .mcp-manager .mcp-tool-body h4{margin:16px 0 6px;font-size:13px;line-height:1.4}
      .mcp-manager .mcp-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:320px;overflow:auto;margin-top:12px}
      .mcp-manager .mcp-check{min-width:0;overflow-wrap:anywhere;padding:10px;border-radius:var(--hep-control-radius,8px);background:var(--mcp-tint);font-size:13px}
      .mcp-manager .mcp-result{max-height:420px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:16px 0 0;padding:20px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-tint);color:var(--mcp-ink);font-size:13px;line-height:1.7}
      .mcp-manager .mcp-catalog{list-style:none;margin:0;padding:0}.mcp-manager .mcp-catalog li{padding:16px 0;border-top:1px solid var(--mcp-line);overflow-wrap:anywhere}.mcp-manager .mcp-catalog li:first-child{border-top:0}.mcp-manager .mcp-catalog strong{display:block}.mcp-manager .mcp-catalog small{display:block;margin-top:4px;color:var(--mcp-muted);font-size:12px}
      .mcp-manager .mcp-source{padding:16px 0;border-top:1px solid var(--mcp-line)}.mcp-manager .mcp-source:first-child{border-top:0}
      .mcp-manager .mcp-empty{text-align:center;padding:64px 24px;color:var(--mcp-muted)}.mcp-manager .mcp-empty strong{display:block;color:var(--mcp-ink);font-size:16px}
      @media(max-width:1000px){.mcp-manager .mcp-layout{grid-template-columns:200px minmax(0,1fr);gap:20px}}
      @media(max-width:760px){.mcp-manager .mcp-toolbar{align-items:start;flex-direction:column;padding:16px}.mcp-manager .mcp-tabs{gap:20px}.mcp-manager .mcp-layout{grid-template-columns:minmax(0,1fr)}.mcp-manager .mcp-service-layout>.mcp-sidebar{display:none}.mcp-manager .mcp-mobile-service-picker{display:flex;align-items:end;gap:8px;min-width:0}.mcp-manager .mcp-mobile-service-picker label{display:grid;gap:5px;min-width:0;flex:1;color:var(--mcp-muted);font-size:12px}.mcp-manager .mcp-mobile-service-picker select{width:100%;min-width:0;min-height:44px;padding:8px;border:1px solid var(--mcp-line);border-radius:var(--hep-control-radius,8px);background:var(--mcp-surface);color:var(--mcp-ink)}.mcp-manager .mcp-service-summary{grid-template-columns:minmax(0,1fr)}.mcp-manager .mcp-card-head .mcp-actions{width:100%}.mcp-manager .mcp-card-head .mcp-actions>button{flex:1}.mcp-manager .mcp-fields,.mcp-manager .mcp-tools{grid-template-columns:minmax(0,1fr)}.mcp-manager .mcp-card{padding:16px}.mcp-manager .mcp-sidebar{padding:8px}}
      @media(pointer:coarse){.mcp-manager button,.mcp-manager .mcp-field input,.mcp-manager .mcp-field select{min-height:44px}.mcp-manager .mcp-switch input,.mcp-manager .mcp-check input{width:20px;height:20px}}
      @media(prefers-reduced-motion:reduce){.mcp-manager button,.mcp-manager input,.mcp-manager select,.mcp-manager summary::before{transition:none}.mcp-manager button:active:not(:disabled){transform:none}}
    `

    function Manager({ view, form, write, publishedService, selectedServerId, onSelectServerId, onOpenView, onValidationError, toolbarTarget, renderToolbar, PasswordInput }) {
      const state = form?.state
      const input = (value, change, props = {}) => props.type === 'password' && !props.readOnly && PasswordInput
        ? <PasswordInput value={value ?? ''} onChange={event => change(event.target.value)} {...props} />
        : <input value={value ?? ''} onChange={event => change(event.target.value)} {...props} />
      const [draft, setDraft] = useState(null)
      const draftBase = React.useRef('')
      const [discovered, setDiscovered] = useState({})
      const [discoveredResources, setDiscoveredResources] = useState({})
      const [selected, setSelected] = useState('')
      const [sources, setSources] = useState(null)
      const [sourceId, setSourceId] = useState('')
      const [specName, setSpecName] = useState('')
      const [specUrl, setSpecUrl] = useState(defaultSpec)
      const [toolName, setToolName] = useState('')
      const [argumentsText, setArgumentsText] = useState('{}')
      const [uriText, setUriText] = useState('')
      const [result, setResult] = useState(null)
      const [catalog, setCatalog] = useState(null)
      const [status, setStatus] = useState('')
      const [checks, setChecks] = useState({})
      const [recoveryDraft, setRecoveryDraft] = useState(null)
      const [copiedDraft, setCopiedDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [localPage, setLocalPage] = useState('servers')
      const [activeServer, setActiveServer] = useState(0)
      const [serverQuery, setServerQuery] = useState('')
      const [servicePane, setServicePane] = useState('tools')
      const [activeGroup, setActiveGroup] = useState(0)
      const [tokenVisible, setTokenVisible] = useState(false)
      const page = ['servers', 'groups', 'connection'].includes(view) ? view : localPage
      const setPage = next => { setLocalPage(next); if (next === 'servers') onValidationError?.() }
      const openDiagnostic = (serverId, name) => { setSelected(serverId); if (name) setToolName(name); if (onOpenView) onOpenView('connection', serverId); else setPage('connection') }
      useEffect(() => {
        if (state?.status !== 'ready') return
        const latest = { servers: structuredClone(state.value.servers ?? []),
          groups: structuredClone(state.value.groups ?? []), sharedToken: state.value.sharedToken ?? '', revision: state.revision }
        const contents = value => JSON.stringify({ servers: value.servers, groups: value.groups, sharedToken: value.sharedToken })
        setDraft(previous => {
          const incoming = contents(latest)
          const current = previous && contents(previous)
          if (previous && current !== draftBase.current && current !== incoming) return previous
          draftBase.current = incoming
          return latest
        })
      }, [state?.value, state?.revision, state?.status])
      useEffect(() => { setChecks({}) }, [state?.revision])
      useEffect(() => {
        if (!draft || state?.status !== 'ready') return
        const dirty = JSON.stringify({ servers: draft.servers, groups: draft.groups, sharedToken: draft.sharedToken })
          !== JSON.stringify({ servers: state.value.servers ?? [], groups: state.value.groups ?? [], sharedToken: state.value.sharedToken ?? '' })
        if (!dirty && !recoveryDraft) return
        const protect = event => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', protect)
        return () => window.removeEventListener('beforeunload', protect)
      }, [draft, state?.value, state?.status, recoveryDraft])
      useEffect(() => {
        if (!selectedServerId || !draft) return
        const servers = [...draft.servers, ...(publishedService ? [publishedService] : [])]
        const index = servers.findIndex(server => server.id === selectedServerId)
        if (index >= 0) setActiveServer(current => current === index ? current : index)
      }, [selectedServerId, draft?.servers, publishedService?.id])
      if (view === 'summary') return <>通过 OpenAPI 规范生成 MCP tools/resources，并管理分组链接。</>
      if (!draft || !state) return <p>正在读取 MCP 配置…</p>

      const visibleServers = [...draft.servers, ...(publishedService ? [publishedService] : [])]
      const filteredServers = visibleServers.map((server, index) => ({ server, index })).filter(({ server }) =>
        `${server.serverName ?? ''} ${server.id ?? ''} ${server.description ?? ''}`.toLowerCase().includes(serverQuery.trim().toLowerCase()))
      const addServer = () => { setActiveServer(draft.servers.length); setServicePane('connection'); onSelectServerId?.(); setDraft(previous => ({ ...previous, servers: [...previous.servers, emptyServer()] })) }
      const clearCheck = id => { if (id) setChecks(previous => { const next = { ...previous }; delete next[id]; return next }) }
      const serverDraftChanged = server => !server.platformComposition && JSON.stringify(server) !== JSON.stringify((state.value.servers ?? []).find(item => item.id === server.id))
      const checkOf = server => server && !serverDraftChanged(server) && checks[server.id]?.revision === state.revision ? checks[server.id] : null
      const editServer = (index, field, value) => {
        clearCheck(draft.servers[index]?.id)
        if (field === 'id' && selectedServerId === draft.servers[index]?.id) {
          setActiveServer(index)
          onSelectServerId?.(value)
        }
        setDraft(previous => {
        const next = structuredClone(previous)
        next.servers[index][field] = value
        return next
        })
      }
      const switchServerType = (index, type) => {
        clearCheck(draft.servers[index]?.id)
        setDraft(previous => {
        const next = structuredClone(previous)
        const current = next.servers[index]
        const saved = (state.value.servers ?? []).find(server => server.id === current.id)
        const restore = saved && (type === 'openapi' ? 'specUrl' in saved : !('specUrl' in saved))
        const source = restore ? structuredClone(saved) : type === 'openapi' ? emptyServer()
          : { url: '', headers: [], tools: { mode: 'all', names: [] } }
        next.servers[index] = { ...source, id: current.id, description: current.description ?? '',
          serverName: current.serverName, enabled: current.enabled }
        return next
        })
      }
      const editGroup = (index, update) => setDraft(previous => {
        const next = structuredClone(previous)
        update(next.groups[index])
        return next
      })
      const diagnosticServer = draft.servers.find(server => server.id === selected) ?? draft.servers[0]
      const diagnosticId = diagnosticServer?.id ?? ''
      const call = async (action, extra = {}) => {
        setBusy(true)
        setStatus('')
        if (action === 'test') setCatalog(null)
        try {
          const response = await fetch('/api/mcp-manager', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serverId: diagnosticId, action, ...extra }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
          setResult(action === 'test' ? null : data)
          if (action === 'sources' || action === 'create' || action === 'refresh' || action === 'toggle') {
            const list = action === 'sources' ? data : await callSources(diagnosticId)
            setSources(list)
          }
          if (action === 'test') {
            setCatalog({ serverId: diagnosticId, data })
            setDiscovered(previous => ({ ...previous,
              [diagnosticId]: data.tools?.map(tool => tool.name) ?? [] }))
            setDiscoveredResources(previous => ({ ...previous, [diagnosticId]: {
              resourceUris: data.resources?.unavailable ? undefined : data.resources?.resources?.map(item => item.uri),
              resourceTemplates: data.resourceTemplates?.unavailable ? undefined : data.resourceTemplates?.resourceTemplates?.map(item => item.uriTemplate),
            } }))
            setChecks(previous => ({ ...previous, [diagnosticId]: { at: new Date().toLocaleString(), revision: state.revision, tools: data.tools?.length ?? 0,
              kind: (state.value.servers ?? []).find(server => server.id === diagnosticId)?.specUrl ? 'openapi' : 'mcp' } }))
          }
          setStatus(action === 'test' ? '配置解析与工具发现成功；新会话仍需单独验证。'
            : '上游操作已返回；请检查下方结果和新会话。')
        } catch (error) { if (action === 'test') setChecks(previous => ({ ...previous, [diagnosticId]: { at: new Date().toLocaleString(), revision: state.revision, failed: true } })); setStatus(String(error)) }
        finally { setBusy(false) }
      }
      const callSources = async serverId => {
        const response = await fetch('/api/mcp-manager', { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serverId, action: 'sources' }) })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
        return data
      }
      const callTool = action => {
        try { void call(action, { sourceId, toolName, arguments: JSON.parse(argumentsText) }) }
        catch (error) { setStatus(`工具参数 JSON 无效：${String(error)}`) }
      }
      const save = async () => {
        setBusy(true)
        setStatus('')
        try {
          for (const [index, server] of draft.servers.entries()) {
            const invalid = message => { setActiveServer(index); onSelectServerId?.(server.id); setServicePane('connection'); setPage('servers'); throw new Error(`第 ${index + 1} 项服务：${message}`) }
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(server.id)) invalid('ID 须为 1–32 个字母、数字、下划线或连字符')
            if (!('specUrl' in server)) {
              if (server.enabled !== false && !server.url) invalid('请填写 MCP URL')
              continue
            }
            if (server.enabled !== false && !server.specUrl) invalid('请填写 OpenAPI 接口规范地址')
            if (!server.specUrl) continue
            const url = new URL(server.specUrl)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('OpenAPI 接口规范地址须为 HTTP(S) URL')
            if (server.authType === 'credential' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(server.authHeader ?? 'Authorization')) throw new Error('凭据 Header 字段名无效')
            if (server.authType === 'login') {
              if (server.enabled !== false && (!server.loginUrl || !server.loginUsername || !server.loginPassword || !server.loginTokenPath)) throw new Error('请填写完整的登录授权信息')
              if (!server.loginUrl) continue
              const loginUrl = new URL(server.loginUrl)
              if (!['http:', 'https:'].includes(loginUrl.protocol) || loginUrl.username || loginUrl.password || loginUrl.hash) throw new Error('登录接口地址须为 HTTP(S) URL')
              if (!server.loginTokenPath.split('.').every(part => /^[A-Za-z_][\w-]*$/.test(part))) throw new Error('凭据字段路径无效')
            }
          }
          const response = await write([
            { op: 'set', path: ['servers'], value: draft.servers },
            { op: 'set', path: ['groups'], value: draft.groups },
            { op: 'set', path: ['sharedToken'], value: draft.sharedToken },
          ], draft.revision)
          setStatus(response.ok ? '配置已保存。请新建会话验证连接与工具发现。'
            : `保存失败：${response.error.message}`)
          if (response.ok) setCatalog(null)
          if (response.ok) setChecks({})
        } catch (error) { setStatus(String(error)) }
        finally { setBusy(false) }
      }
      const toggleSelection = (groupIndex, serverId, field, value) => editGroup(groupIndex, group => {
        let member = group.members.find(item => item.serverId === serverId)
        if (!member) { member = { serverId, names: [], resourceUris: [], resourceTemplates: [] }; group.members.push(member) }
        const current = member[field] ?? []
        member[field] = current.includes(value) ? current.filter(item => item !== value) : [...current, value]
        group.members = group.members.filter(item => item.names?.length || item.resourceUris?.length || item.resourceTemplates?.length)
      })
      const mergeDuplicateMembers = groupIndex => editGroup(groupIndex, group => {
        const firstByServer = new Map()
        group.members = group.members.filter(member => {
          const first = firstByServer.get(member.serverId)
          if (!first) { firstByServer.set(member.serverId, member); return true }
          for (const field of ['names', 'resourceUris', 'resourceTemplates']) {
            first[field] = [...new Set([...(first[field] ?? []), ...(member[field] ?? [])])]
          }
          return false
        })
      })
      const sourceList = Array.isArray(sources) ? sources : sources?.items ?? sources?.data ?? []
      const isDirty = JSON.stringify(draft.servers) !== JSON.stringify(state.value.servers ?? [])
        || JSON.stringify(draft.groups) !== JSON.stringify(state.value.groups ?? [])
        || draft.sharedToken !== (state.value.sharedToken ?? '')
      const incomingContent = JSON.stringify({ servers: state.value.servers ?? [], groups: state.value.groups ?? [], sharedToken: state.value.sharedToken ?? '' })
      const conflict = isDirty && (draft.revision !== state.revision || draftBase.current !== incomingContent)
      const draftContent = JSON.stringify(draft)
      const currentServerIndex = selectedServerId ? visibleServers.findIndex(server => server.id === selectedServerId) : activeServer
      const editingServer = visibleServers[currentServerIndex]
      const currentCheck = checkOf(editingServer)
      const currentTools = currentCheck && !currentCheck.failed ? (catalog?.serverId === editingServer?.id ? catalog.data.tools ?? [] : (discovered[editingServer?.id] ?? []).map(name => ({ name }))) : []
      const editingGroup = draft.groups[activeGroup]
      const duplicateIds = editingGroup ? duplicateMemberIds(editingGroup.members) : []
      const savedGroup = (state.value.groups ?? []).find(group => group.id === editingGroup?.id)
      const savedDuplicateIds = savedGroup ? duplicateMemberIds(savedGroup.members) : []
      const linkReady = !!savedGroup && !duplicateIds.length && !savedDuplicateIds.length
        && !!state.value.sharedToken && draft.sharedToken === state.value.sharedToken

      return <section className="mcp-manager">
        <style>{styles}</style>
        {toolbarTarget && renderToolbar ? renderToolbar(isDirty ? <button className="harness-primary" type="button" onClick={save} disabled={busy || !state.writable}>保存更改</button> : null, toolbarTarget) : <div className="mcp-toolbar">
          <div><strong>MCP 服务与分组配置</strong><p>保存后新建会话验证连接和工具发现。</p></div>
          <button className="mcp-primary" type="button" onClick={save} disabled={busy || !state.writable || !isDirty}>保存更改</button>
        </div>}
        {conflict && <div className="mcp-note" role="alert">配置已在其他位置更新，当前草稿已保留。原版本保存会发生配置版本冲突。
          <div className="mcp-actions">{button('复制本地草稿', async () => { try { await navigator.clipboard.writeText(draftContent); setCopiedDraft(draftContent); setStatus('本地草稿已复制。') } catch { setStatus('无法复制草稿，请检查浏览器剪贴板权限。') } })}
            {button('读取最新配置', () => { setRecoveryDraft(structuredClone(draft)); draftBase.current = incomingContent; setDraft({ servers: structuredClone(state.value.servers ?? []), groups: structuredClone(state.value.groups ?? []), sharedToken: state.value.sharedToken ?? '', revision: state.revision }); setCopiedDraft('') }, copiedDraft !== draftContent)}</div>
        </div>}
        {recoveryDraft && <div className="mcp-note">之前的草稿已保留，可复制后手工对照最新配置。
          <div className="mcp-actions">{button('复制保留草稿', async () => { await navigator.clipboard.writeText(JSON.stringify(recoveryDraft)) })}</div>
        </div>}
        {status && <p className="mcp-status" role="status">{status}</p>}
        <div className="mcp-shell">
          {!view && <nav className="mcp-tabs" aria-label="MCP 配置管理页面">
            <button type="button" aria-current={page === 'servers' ? 'page' : undefined} onClick={() => setPage('servers')}>MCP 服务器 <small>{draft.servers.length}</small></button>
            <button type="button" aria-current={page === 'groups' ? 'page' : undefined} onClick={() => setPage('groups')}>工具分组 <small>{draft.groups.length}</small></button>
            <button type="button" aria-current={page === 'connection' ? 'page' : undefined} onClick={() => setPage('connection')}>工具与资源</button>
          </nav>}
          <div className="mcp-content">
            {page === 'servers' && <>
              <div className="mcp-layout mcp-service-layout">
                <aside className="mcp-card mcp-sidebar" aria-label="服务器列表">
                  <label className="mcp-service-search">查找服务<input type="search" value={serverQuery} onChange={event => setServerQuery(event.target.value)} placeholder="查找服务或用途" /></label>
                  <span className="mcp-service-count">服务 · {visibleServers.length}</span>
                  {filteredServers.map(({ server, index }) => <button key={index} className="mcp-list-item" data-server-id={server.id} type="button" aria-current={currentServerIndex === index ? 'true' : undefined} onClick={() => { setActiveServer(index); setServicePane('tools'); onSelectServerId?.(server.id) }}>
                    <strong>{server.platformComposition ? server.description || '工具组合编排（已发布）' : server.serverName || server.id || '新服务器'}</strong><small>{server.platformComposition ? '由已发布组合生成' : server.description || '用途未填写'}</small>
                    <span className="mcp-service-facts"><span>{server.platformComposition ? '已发布工具目录' : server.enabled === false ? '配置已停用' : serverDraftChanged(server) ? '当前修改未保存' : '配置已启用'}</span><span>{serverDraftChanged(server) ? '保存当前配置后再检查' : checkOf(server)?.failed ? '检查失败，连接与工具发现待核对' : checkOf(server) ? `${checkOf(server).kind === 'openapi' ? '规范已读取' : '连接成功'} · 已发现 ${checkOf(server).tools} 个工具` : '连接与工具发现待检查'}</span><span>{checkOf(server) ? `最近检查 ${checkOf(server).at}` : '本页尚未检查当前配置'}</span></span>
                  </button>)}
                  {visibleServers.length > 0 && filteredServers.length === 0 && <p className="mcp-muted">没有匹配的服务，请调整搜索内容。</p>}
                  <button className="mcp-add" type="button" onClick={addServer}>＋ 新增服务器</button>
                </aside>
                <div className="mcp-mobile-service-picker"><label>当前服务<select value={editingServer ? currentServerIndex : -1} onChange={event => { const index = Number(event.target.value); setActiveServer(index); setServicePane('tools'); onSelectServerId?.(visibleServers[index]?.id) }}>
                  <option value={-1}>请选择服务</option>{visibleServers.map((server, index) => <option key={index} value={index}>{server.platformComposition ? server.description || server.id : server.serverName || server.id || '新服务器'}</option>)}
                </select></label><button type="button" onClick={addServer}>接入服务</button></div>
                {editingServer?.platformComposition ? <div className="mcp-card">
                  <div className="mcp-card-head"><div><h3>{editingServer.description || '工具组合编排（已发布）'}</h3><p className="mcp-muted">已发布组合生成的服务，在「工具组合编排」工作区管理版本与发布。</p></div></div>
                  <div className="mcp-service-facts" aria-label="当前服务检查范围"><span>配置：已发布工具目录</span><span>连接与工具发现：待检查</span><span>最近检查：本页尚未检查当前配置</span><span>验证范围：已发布目录可见；实际连接、调用和业务结果待验证</span></div>
                  <section className="mcp-section"><h3>已发布工具</h3>{editingServer.publishedTools?.length ? <ul className="mcp-catalog">{editingServer.publishedTools.map(tool => <li key={tool.toolName || tool.name}><strong>{tool.toolName || tool.name}</strong>{tool.description && <small>{tool.description}</small>}</li>)}</ul> : <p className="mcp-muted">当前目录没有可列出的工具。</p>}</section>
                </div> : editingServer ? <div className="mcp-card">
                  <div className="mcp-card-head"><div><h3>{editingServer.serverName || editingServer.id || '新服务器'}</h3><p className="mcp-muted">{editingServer.description || editingServer.id || '填写 ID 与 OpenAPI 规范地址后保存'}</p></div>
                    <div className="mcp-actions"><button type="button" disabled={busy || !editingServer.id || serverDraftChanged(editingServer) || editingServer.enabled === false} onClick={() => void callTest(editingServer.id)}>连接测试</button><button className="mcp-primary" type="button" disabled={!editingServer.id} onClick={() => openDiagnostic(editingServer.id)}>调试工具</button><label className="mcp-switch"><input type="checkbox" checked={editingServer.enabled !== false} onChange={event => editServer(currentServerIndex, 'enabled', event.target.checked)} />启用</label></div>
                  </div>
                  <div className="mcp-service-summary" aria-label="当前服务状态">
                    <article><small>连接状态</small><strong>{serverDraftChanged(editingServer) ? '配置未保存' : currentCheck?.failed ? '检查失败' : currentCheck ? currentCheck.kind === 'openapi' ? '规范已读取' : '连接成功' : '待检查'}</strong><small>{currentCheck ? `最近检查 ${currentCheck.at}` : '本页尚未检查当前配置'}</small></article>
                    <article><small>工具发现</small><strong>{currentCheck && !currentCheck.failed ? `${currentCheck.tools} 个工具` : '待核对'}</strong><small>{currentCheck && !currentCheck.failed ? '已枚举工具定义' : '尚无可用的发现结果'}</small></article>
                    <article><small>业务验证范围</small><strong>未验证</strong><small>请核对实际调用与目标业务结果</small></article>
                  </div>
                  <p className="mcp-service-scope">{serverDraftChanged(editingServer) ? '当前配置未保存，保存后可重新检查连接与工具。' : currentCheck?.failed ? '本次检查失败，连接与工具发现仍待核对；实际调用和业务结果待验证。' : currentCheck ? '仅确认接口读取或工具枚举；实际调用和业务结果待验证。' : '尚未检查当前配置；连接、工具发现和实际调用均待验证。'}</p>
                  <nav className="mcp-service-tabs" aria-label="服务详情"><button type="button" aria-current={servicePane === 'tools' ? 'page' : undefined} onClick={() => setServicePane('tools')}>工具与调试</button><button type="button" aria-current={servicePane === 'connection' ? 'page' : undefined} onClick={() => setServicePane('connection')}>连接配置</button><button type="button" aria-current={servicePane === 'recent' ? 'page' : undefined} onClick={() => setServicePane('recent')}>最近检查</button></nav>
                  {servicePane === 'tools' && <section className="mcp-section"><h3>已发现的工具</h3>{currentTools.length ? <ul className="mcp-discovered-list">{currentTools.map(tool => <li key={tool.name}><div><strong>{tool.name}</strong>{tool.description && <p className="mcp-muted">{tool.description}</p>}</div><button type="button" onClick={() => openDiagnostic(editingServer.id, tool.name)}>调试</button></li>)}</ul> : <p className="mcp-muted">{currentCheck?.failed ? '最近一次检查失败，暂不能列出当前配置的工具。' : '当前配置尚无已验证的工具目录。保存配置后运行连接测试，才能显示实际发现的工具。'}</p>}</section>}
                  {servicePane === 'recent' && <section className="mcp-section"><h3>最近检查</h3><p>{currentCheck ? `${currentCheck.at} · ${currentCheck.failed ? '检查失败，连接与工具发现待核对' : `${currentCheck.kind === 'openapi' ? '规范已读取' : '连接成功'}，发现 ${currentCheck.tools} 个工具`}` : '本页尚未检查当前配置。'}</p><p className="mcp-muted">检查结果只对应本次保存的服务配置；不代表工具调用或业务验证通过。</p></section>}
                  {servicePane === 'connection' && <>
                  <section className="mcp-section"><h3>基本信息</h3><div className="mcp-fields">
                    <label className="mcp-field">ID{input(editingServer.id, value => editServer(currentServerIndex, 'id', value), { placeholder: '例如 sec-ops-api' })}</label>
                    <label className="mcp-field">描述（可选）{input(editingServer.description, value => editServer(currentServerIndex, 'description', value))}</label>
                    <label className="mcp-field">直连服务名称（可选）{input(editingServer.serverName, value => editServer(currentServerIndex, 'serverName', value))}<small>为空时使用服务 ID；分组链接使用分组 ID 作为连接名。</small></label>
                    <label className="mcp-field">接入方式<select value={'specUrl' in editingServer ? 'openapi' : 'mcp'} onChange={event => switchServerType(currentServerIndex, event.target.value)}>
                      <option value="openapi">OpenAPI 接口规范</option><option value="mcp">现成 MCP 连接</option>
                    </select></label>
                  </div></section>
                  {'specUrl' in editingServer ? <section className="mcp-section"><h3>OpenAPI 接口</h3><p className="mcp-muted">保存后，接口规范中的操作会自动生成 MCP 工具或资源；服务器内全部开放。规范先匿名读取，遇 401/403 再用已配置的授权重试；业务接口始终按授权方式调用。</p><div className="mcp-fields">
                    <label className="mcp-field mcp-wide">OpenAPI 接口规范地址{input(editingServer.specUrl, value => editServer(currentServerIndex, 'specUrl', value), { placeholder: defaultSpec })}</label>
                    <label className="mcp-field">授权方式<select value={editingServer.authType || (editingServer.apiKey ? 'legacy' : 'credential')} onChange={event => editServer(currentServerIndex, 'authType', event.target.value)}>
                      {!editingServer.authType && editingServer.apiKey && <option value="legacy">按规范匹配（旧配置）</option>}
                      <option value="credential">凭据授权</option><option value="login">用户名密码登陆授权</option>
                    </select></label>
                    {editingServer.authType === 'login' ? <>
                      <label className="mcp-field mcp-wide">登录接口地址{input(editingServer.loginUrl, value => editServer(currentServerIndex, 'loginUrl', value), { placeholder: 'https://…/login' })}</label>
                      <label className="mcp-field">用户名{input(editingServer.loginUsername, value => editServer(currentServerIndex, 'loginUsername', value), { autoComplete: 'username' })}</label>
                      <label className="mcp-field">密码{input(editingServer.loginPassword, value => editServer(currentServerIndex, 'loginPassword', value), { type: 'password', autoComplete: 'new-password' })}</label>
                      <label className="mcp-field">登录响应中的凭据字段{input(editingServer.loginTokenPath, value => editServer(currentServerIndex, 'loginTokenPath', value), { placeholder: 'token 或 data.access_token' })}</label>
                      <p className="mcp-muted mcp-wide">以 JSON 的 username、password 字段登录；凭据按 OpenAPI 安全声明发送，401 时重新登录一次。</p>
                    </> : <>
                      <label className="mcp-field">凭据 Header 字段<select value={commonHeaders.includes(editingServer.authHeader ?? 'Authorization') ? (editingServer.authHeader ?? 'Authorization') : 'custom'} onChange={event => editServer(currentServerIndex, 'authHeader', event.target.value === 'custom' ? '' : event.target.value)}>
                        {commonHeaders.map(name => <option key={name} value={name}>{name}</option>)}<option value="custom">自定义字段</option>
                      </select></label>
                      {!commonHeaders.includes(editingServer.authHeader ?? 'Authorization') && <label className="mcp-field">自定义 Header 字段名{input(editingServer.authHeader, value => editServer(currentServerIndex, 'authHeader', value), { placeholder: 'X-Custom-Token' })}</label>}
                      <label className="mcp-field mcp-wide">凭据（可选）{input(editingServer.apiKey, value => editServer(currentServerIndex, 'apiKey', value), { type: 'password', autoComplete: 'new-password' })}<small>默认将凭据原文写入 Authorization；若接口要求 Bearer，请在凭据中包含 Bearer 前缀。</small></label>
                    </>}
                  </div></section> : <><section className="mcp-section"><h3>连接设置</h3><p className="mcp-muted">填写 Streamable HTTP MCP URL；需要鉴权时添加请求 Header，例如 Authorization: Bearer …。保存后新建会话生效。</p><div className="mcp-fields">
                    <label className="mcp-field mcp-wide">MCP URL{input(editingServer.url, value => editServer(currentServerIndex, 'url', value), { placeholder: 'https://…/mcp' })}</label>
                    {(editingServer.headers ?? []).map((header, index) => <React.Fragment key={index}>
                      <label className="mcp-field">Header 名称 {index + 1}{input(header.name, value => editServer(currentServerIndex, 'headers', editingServer.headers.map((item, at) => at === index ? { ...item, name: value } : item)), { placeholder: 'Authorization' })}</label>
                      <label className="mcp-field">Header 值 {index + 1}{input(header.value, value => editServer(currentServerIndex, 'headers', editingServer.headers.map((item, at) => at === index ? { ...item, value } : item)), { type: 'password', autoComplete: 'new-password' })}</label>
                      <div className="mcp-wide">{button(`删除 Header ${index + 1}`, () => editServer(currentServerIndex, 'headers', editingServer.headers.filter((_, at) => at !== index)))}</div>
                    </React.Fragment>)}
                    <div className="mcp-wide">{button('＋ 添加请求 Header', () => editServer(currentServerIndex, 'headers', [...(editingServer.headers ?? []), { name: '', value: '' }]))}</div>
                  </div></section>
                  <section className="mcp-section"><h3>工具范围</h3><div className="mcp-fields">
                    <label className="mcp-field">开放方式<select value={editingServer.tools?.mode ?? 'all'} onChange={event => editServer(currentServerIndex, 'tools', { mode: event.target.value, names: editingServer.tools?.names ?? [] })}>
                      <option value="all">全部工具</option><option value="selected">仅指定工具</option>
                    </select></label>
                    {editingServer.tools?.mode === 'selected' && <label className="mcp-field mcp-wide">工具原名（逗号分隔）{input((editingServer.tools.names ?? []).join(', '), value => editServer(currentServerIndex, 'tools', { mode: 'selected', names: value.split(',').map(name => name.trim()).filter(Boolean) }))}</label>}
                  </div><p className="mcp-muted">工具仍受业务 Guard 限制；子智能体的 toolFilter 可按角色进一步收紧。</p></section></>}
                  </>}
                  <div className="mcp-actions"><button className="mcp-danger" type="button" onClick={() => {
                    if (!window.confirm(`删除服务器「${editingServer.serverName || editingServer.id}」及其分组引用？`)) return
                    const serverId = editingServer.id
                    clearCheck(serverId)
                    const nextIndex = Math.max(0, currentServerIndex - 1)
                    onSelectServerId?.(visibleServers.filter((_, at) => at !== currentServerIndex)[nextIndex]?.id)
                    setDraft(previous => ({ ...previous, servers: previous.servers.filter((_, at) => at !== currentServerIndex), groups: previous.groups.map(group => ({ ...group, members: group.members.filter(member => member.serverId !== serverId) })) }))
                    setActiveServer(nextIndex)
                  }}>删除服务器</button></div>
                </div> : <div className="mcp-card mcp-empty"><strong>{selectedServerId ? '指定服务不存在' : '暂无服务器'}</strong><p>{selectedServerId ? '请选择其他服务，或检查此链接。' : '从左侧新增一个 MCP 服务器。'}</p></div>}
              </div>
            </>}
            {page === 'groups' && <>
              <div className="mcp-card" style={{ marginBottom: 16 }}>
                <h3>统一访问 Token</h3><p className="mcp-muted">分组和智能体 MCP 链接共用。未生成时链接不接受访问；更换并保存后旧 Token 立即失效。</p>
                <div className="mcp-fields"><label className="mcp-field mcp-wide">Token{input(draft.sharedToken, () => {}, { type: tokenVisible ? 'text' : 'password', readOnly: true, placeholder: '尚未生成', autoComplete: 'off', id: 'mcp-shared-token' })}</label></div>
                <div className="mcp-actions">
                  {button(draft.sharedToken ? '重新生成 Token' : '生成 Token', () => {
                    if (draft.sharedToken && !window.confirm('更换 Token 并保存后，旧 Token 立即失效。继续？')) return
                    const bytes = new Uint8Array(32)
                    window.crypto.getRandomValues(bytes)
                    setDraft(previous => ({ ...previous, sharedToken: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') }))
                    setStatus('新 Token 已生成；请点击「保存更改」使其生效。')
                  })}
                  {button(tokenVisible ? '隐藏' : '显示', () => setTokenVisible(value => !value), !draft.sharedToken)}
                  {button('复制 Token', async () => { try { await navigator.clipboard.writeText(draft.sharedToken); setStatus('Token 已复制。') } catch { setTokenVisible(true); setStatus('当前浏览器无法自动复制，请显示后手动复制。') } }, !draft.sharedToken)}
                </div>
              </div>
              <div className="mcp-layout">
                <aside className="mcp-card mcp-sidebar" aria-label="分组列表">
                  {draft.groups.map((group, index) => <button key={index} className="mcp-list-item" type="button" aria-current={activeGroup === index ? 'true' : undefined} onClick={() => setActiveGroup(index)}>
                    <strong>{group.id || '新分组'}</strong><small>{group.members.reduce((count, member) => count + (member.names?.length ?? 0), 0)} 个工具 · {group.members.reduce((count, member) => count + (member.resourceUris?.length ?? 0), 0)} 个资源 · {group.members.reduce((count, member) => count + (member.resourceTemplates?.length ?? 0), 0)} 个模板</small>
                  </button>)}
                  <button className="mcp-add" type="button" onClick={() => { setActiveGroup(draft.groups.length); setDraft(previous => ({ ...previous, groups: [...previous.groups, emptyGroup()] })) }}>＋ 新增分组</button>
                </aside>
                {editingGroup ? <div className="mcp-card">
                  <div className="mcp-card-head"><div><h3>{editingGroup.id || '新分组'}</h3><p className="mcp-muted">仅开放此组勾选的工具与资源。</p></div></div>
                  <section className="mcp-section"><div className="mcp-fields"><label className="mcp-field">分组 ID{input(editingGroup.id, value => editGroup(activeGroup, group => { group.id = value }))}</label></div>
                    {/^[A-Za-z0-9_-]{1,32}$/.test(editingGroup.id) && <div className="mcp-actions"><span className="mcp-muted">MCP 链接</span>{linkReady && <code className="mcp-link">{new URL(`mcp/groups/${editingGroup.id}/v2`, document.baseURI).href}</code>}
                      {button('复制分组链接', async () => { try { await navigator.clipboard.writeText(new URL(`mcp/groups/${editingGroup.id}/v2`, document.baseURI).href); setStatus('分组链接已复制。') } catch { setStatus('当前浏览器无法自动复制，请手动复制上方链接。') } }, !linkReady)}</div>}
                    {editingGroup.id && !/^[A-Za-z0-9_-]{1,32}$/.test(editingGroup.id) && <p className="mcp-muted">分组 ID 须为 1–32 个字母、数字、下划线或连字符。</p>}
                    {!!duplicateIds.length && <div className="mcp-note">服务 {duplicateIds.join('、')} 在此分组中有重复成员，v2 链接不可用。合并会对工具、资源 URI 和资源模板取并集，并改变旧版分组的目标摘要；请保存后重新发现工具。
                      <div className="mcp-actions">{button('合并同源成员', () => mergeDuplicateMembers(activeGroup))}</div></div>}
                    {!duplicateIds.length && !!savedDuplicateIds.length && <p className="mcp-muted">重复成员已在草稿中合并；保存并等待配置刷新后，v2 链接才可使用。</p>}
                    {!savedGroup && !duplicateIds.length && <p className="mcp-muted">此分组尚未保存；保存后才会生成可用链接。</p>}
                    {!!savedGroup && !duplicateIds.length && !savedDuplicateIds.length && !state.value.sharedToken && <p className="mcp-muted">请生成并保存统一访问 Token 后使用分组链接。</p>}
                    {!!savedGroup && !duplicateIds.length && !savedDuplicateIds.length && !!state.value.sharedToken && draft.sharedToken !== state.value.sharedToken && <p className="mcp-muted">新 Token 尚未保存；保存后再复制分组链接。</p>}
                    {linkReady && isDirty && <p className="mcp-muted">当前草稿尚未保存；链接仍使用上次保存的配置。</p>}
                    <p className="mcp-muted">通过 Authorization: Bearer &lt;统一访问 Token&gt; 调用。DSH 中将连接名设为分组 ID，模型可见工具名以该分组为前缀；超长工具名由 DSH 缩短。</p>
                  </section>
                  <section className="mcp-section"><h3>选择工具与资源</h3><p className="mcp-muted">发现使用上次保存的服务配置；已保存的选择始终显示。</p>
                    {visibleServers.map((server, index) => {
                      const members = editingGroup.members.filter(item => item.serverId === server.id)
                      const selected = Object.fromEntries(['names', 'resourceUris', 'resourceTemplates'].map(field =>
                        [field, [...new Set(members.flatMap(member => member[field] ?? []))]]))
                      const needsMerge = members.length > 1
                      const resources = discoveredResources[server.id]
                      const discoveredNames = server.platformComposition ? (server.publishedTools ?? []).map(tool => tool.toolName || tool.name).filter(Boolean) : discovered[server.id]
                      const sections = [
                        { field: 'names', title: '工具', items: [...new Set([...selected.names, ...(discoveredNames ?? [])])], discovered: discoveredNames },
                        { field: 'resourceUris', title: '资源 URI', items: [...new Set([...selected.resourceUris, ...(resources?.resourceUris ?? [])])], discovered: resources?.resourceUris },
                        { field: 'resourceTemplates', title: '资源模板', items: [...new Set([...selected.resourceTemplates, ...(resources?.resourceTemplates ?? [])])], discovered: resources?.resourceTemplates },
                      ]
                      const selectedCount = selected.names.length + selected.resourceUris.length + selected.resourceTemplates.length
                      return <details className="mcp-server-tools" key={index}>
                        <summary>{server.serverName || server.id || '新服务器'}<span className="mcp-muted">{selectedCount} 个已选{server.enabled === false ? ' · 已停用' : ''}</span></summary>
                        <div className="mcp-tool-body">
                          <p className="mcp-muted">服务器 ID：{server.id || '未设置 ID'}{server.enabled === false ? '。此来源已停用，所选能力不会通过分组开放。' : ''}{needsMerge ? '。此来源有重复成员，请先合并再编辑选择。' : ''}</p>
                          {!server.platformComposition && <button className="mcp-quiet" type="button" onClick={() => { setSelected(server.id); void callTest(server.id) }} disabled={busy || !server.id || server.enabled === false}>发现工具与资源</button>}
                          {sections.map(section => <section key={section.field}><h4>{section.title}</h4>
                            {section.items.length ? <div className="mcp-tools">{section.items.map(item => <label className="mcp-check" key={item}><input type="checkbox" checked={selected[section.field].includes(item)} disabled={needsMerge} onChange={() => toggleSelection(activeGroup, server.id, section.field, item)} />{item}{selected[section.field].includes(item) && Array.isArray(section.discovered) && !section.discovered.includes(item) && <span className="mcp-muted">（当前未发现）</span>}</label>)}</div>
                              : <p className="mcp-muted">{section.discovered === undefined ? '尚未发现，或此服务未提供该列表。' : '没有可选项目。'}</p>}
                            {section.discovered === undefined && selected[section.field].length > 0 && <p className="mcp-muted">已保存的选择尚无法通过当前发现结果核对。</p>}
                          </section>)}
                        </div>
                      </details>
                    })}
                    {editingGroup.members.filter(member => !visibleServers.some(server => server.id === member.serverId)).map(member => <p className="mcp-note" key={member.serverId}>已选来源 {member.serverId} 不在服务列表中；请恢复该服务或取消此分组引用。</p>)}
                    {!visibleServers.length && <p className="mcp-note">请先添加 MCP 服务器。</p>}
                  </section>
                  <div className="mcp-actions"><button className="mcp-danger" type="button" onClick={() => {
                    if (!window.confirm(`删除分组「${editingGroup.id}」？`)) return
                    setDraft(previous => ({ ...previous, groups: previous.groups.filter((_, at) => at !== activeGroup) }))
                    setActiveGroup(Math.max(0, activeGroup - 1))
                  }}>删除分组</button></div>
                </div> : <div className="mcp-card mcp-empty"><strong>暂无分组</strong><p>从左侧新增工具与资源分组。</p></div>}
              </div>
            </>}
            {page === 'connection' && <>
              <div className="mcp-card">
                <h3>连接检查</h3><p className="mcp-muted">测试使用上次保存的服务器配置。</p>
                <div className="mcp-fields"><label className="mcp-field">服务器<select value={diagnosticId} onChange={event => { setSelected(event.target.value); setSources(null); setResult(null); setCatalog(null); setUriText('') }}>
                  {draft.servers.map((server, index) => <option key={index} value={server.id}>{server.serverName || server.id || '新服务器'}</option>)}
                </select></label></div>
                <div className="mcp-actions">{button('发现工具与资源', () => call('test'), busy || !diagnosticId)}</div>
              </div>
              {diagnosticServer?.specUrl ? <div className="mcp-card" style={{ marginTop: 16 }}>
                <h3>OpenAPI 来源</h3><p className="mcp-muted">{diagnosticServer.specUrl}</p>
              </div> : diagnosticServer?.managementUrl ? <div className="mcp-card" style={{ marginTop: 16 }}>
                <div className="mcp-card-head"><div><h3>OpenAPI 来源</h3><p className="mcp-muted">管理 API：{diagnosticServer.managementUrl}</p></div>{button('读取来源', () => call('sources'), busy || !diagnosticId)}</div>
                <section className="mcp-section"><h3>添加来源</h3><div className="mcp-fields">
                  <label className="mcp-field">来源名称{input(specName, setSpecName)}</label>
                  <label className="mcp-field">OpenAPI specification URL{input(specUrl, setSpecUrl)}</label>
                </div><div className="mcp-actions">{button('创建来源', () => call('create', { name: specName, specUrl }), busy || !specName || !diagnosticId)}</div></section>
                {sourceList.length > 0 && <section className="mcp-section"><h3>现有来源</h3>{sourceList.map(source => <div className="mcp-source" key={source.id}>
                  <strong>{source.name}</strong><p className="mcp-muted">ID：{source.id} · {source.status ?? '状态未知'}</p>
                  <div className="mcp-actions">{button('组件', () => { setSourceId(String(source.id)); void call('components', { sourceId: String(source.id) }) }, busy)}
                    {button('刷新', () => call('refresh', { sourceId: String(source.id) }), busy)}
                    {button(source.enabled ? '停用来源' : '启用来源', () => call('toggle', { sourceId: String(source.id), enabled: !source.enabled }), busy)}
                    {button('日志', () => call('logs', { sourceId: String(source.id) }), busy)}</div>
                </div>)}</section>}
                <section className="mcp-section"><h3>工具操作</h3><div className="mcp-fields">
                  <label className="mcp-field">来源 ID{input(sourceId, setSourceId)}</label>
                  <label className="mcp-field">工具名称{input(toolName, setToolName)}</label>
                  <label className="mcp-field mcp-wide">工具参数 JSON{input(argumentsText, setArgumentsText)}</label>
                </div><div className="mcp-actions">{button('预览请求', () => callTool('preview'), busy || !sourceId || !toolName)}
                  {button('执行工具', () => callTool('invoke'), busy || !sourceId || !toolName)}</div></section>
              </div> : <div className="mcp-card" style={{ marginTop: 16 }}><h3>现成 MCP 连接</h3><p className="mcp-muted">该服务器按已保存的 MCP URL 和请求 Header 连接。</p></div>}
              {catalog?.serverId === diagnosticId && <div className="mcp-card" style={{ marginTop: 16 }}>
                <h3>{diagnosticServer?.specUrl ? 'OpenAPI 生成的 MCP 能力' : '现成 MCP 服务的能力'}</h3>
                {[
                  { title: '工具', items: catalog.data.tools ?? [] },
                  { title: 'Resources', items: catalog.data.resources?.resources ?? [], unavailable: catalog.data.resources?.unavailable },
                  { title: 'Resource Templates', items: catalog.data.resourceTemplates?.resourceTemplates ?? [], unavailable: catalog.data.resourceTemplates?.unavailable },
                ].map(section => <section className="mcp-section" key={section.title}>
                  <h3>{section.title}（{section.items.length}）</h3>
                  {section.unavailable ? <p className="mcp-muted">服务未提供该列表，或读取失败。</p>
                    : section.items.length ? <ul className="mcp-catalog">{section.items.map((item, index) => <li key={index}>
                      <strong>{item.name || item.uri || item.uriTemplate}</strong>
                      {(item.uri || item.uriTemplate || item.description) && <small>{[item.uri || item.uriTemplate, item.description].filter(Boolean).join(' · ')}</small>}
                    </li>)}</ul> : <p className="mcp-muted">没有可列出的项目。</p>}
                </section>)}
                <section className="mcp-section"><h3>调用工具</h3><div className="mcp-fields">
                  <label className="mcp-field">工具<select value={toolName} onChange={event => setToolName(event.target.value)}><option value="">请选择工具</option>{(catalog.data.tools ?? []).map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}</select></label>
                  <label className="mcp-field mcp-wide">调用参数 JSON{input(argumentsText, setArgumentsText)}</label>
                </div><div className="mcp-actions">{button('测试工具', () => callTool('callTool'), busy || !toolName)}</div></section>
                <section className="mcp-section"><h3>读取 Resource</h3>
                  <div className="mcp-fields"><label className="mcp-field mcp-wide">Resource URI{input(uriText, setUriText)}</label></div>
                  <div className="mcp-actions">{button('读取 Resource', () => call('readResource', { uri: uriText }), busy || !uriText)}</div>
                </section>
              </div>}
              {result && <div className="mcp-card" style={{ marginTop: 16 }}><h3>操作结果</h3><pre className="mcp-result">{JSON.stringify(result, null, 2)}</pre></div>}
            </>}
          </div>
        </div>
      </section>

      async function callTest(serverId) {
        setBusy(true)
        setStatus('')
        setCatalog(null)
        try {
          const response = await fetch('/api/mcp-manager', { method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId, action: 'test' }) })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error)
          setCatalog({ serverId, data })
          setDiscovered(previous => ({ ...previous, [serverId]: data.tools?.map(tool => tool.name) ?? [] }))
          setDiscoveredResources(previous => ({ ...previous, [serverId]: {
            resourceUris: data.resources?.unavailable ? undefined : data.resources?.resources?.map(item => item.uri),
            resourceTemplates: data.resourceTemplates?.unavailable ? undefined : data.resourceTemplates?.resourceTemplates?.map(item => item.uriTemplate),
          } }))
          setChecks(previous => ({ ...previous, [serverId]: { at: new Date().toLocaleString(), revision: state.revision, tools: data.tools?.length ?? 0,
            kind: (state.value.servers ?? []).find(server => server.id === serverId)?.specUrl ? 'openapi' : 'mcp' } }))
          setStatus(`${serverId} 已发现 ${data.tools?.length ?? 0} 个工具、${data.resources?.resources?.length ?? 0} 个资源、${data.resourceTemplates?.resourceTemplates?.length ?? 0} 个模板。`)
        } catch (error) { setChecks(previous => ({ ...previous, [serverId]: { at: new Date().toLocaleString(), revision: state.revision, failed: true } })); setStatus(String(error)) }
        finally { setBusy(false) }
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.configForms.whileServed([formName], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item', id: 'mcp-session-manager', order: 50,
        label: () => 'MCP 配置管理',
      }, props => <Manager {...props} write={(ops, revision) => ctx.remote.settings.mutate(formName, ops, revision)} />))), 'mcp-manager: page')
    }
    return { apply, inject: ['slots', 'configForms', 'remote', 'remote.settings'] }
  },
})
