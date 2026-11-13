import { createHash } from 'node:crypto'

/** 两种报告共用的离线展示层；不读取文件、网络、运行状态或重新判断业务结论。 */
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const secretKey = /password|passwd|token|api.?key|secret|private.?key|credential|authorization|cookie/i
const fields = new Set(`kind status executionStatus execution_status completeness result_status conclusion business_conclusion business_status businessStatus run_id runId id node_id nodeId path check title name label description message reason error summary recommendation recommendations next_check recovery terminal active_checks_executed executed completed response_verified source_timezone recorded_at observed_at received_at started_at finished_at completed_at checked_at generated_at generatedAt frozen_at from to timestamp timeBasis evaluatedAt observedAt receivedAt validUntil expiresAt validity supportsOnline reasonCode type source connections connection_fingerprints graphConnection version publishedVersion report_id reportId source_sha256 snapshot_sha256 projection_sha256 content_sha256 templateId templateName templateVersion template_id template_name template_version reportTime report_time checkedAt checkTime check_time baselineType reportType reportSubject subject reportVersion baselineTemplateId baselineTemplateName baselineTemplateVersion baselineReportId template release_version items item_count count total totalGroups totalAlerts totalMembers affectedAssets findings vulnerabilities severity cve cveId riskLevel result normal abnormal unknown not_applicable failed partial incomplete unavailable observed unknown_count failed_count not_checked coverage passed_count failed_count checked_count unchecked_count not_applicable_count missing_report_count scope requested checks counts facts stateEvidence signals sourceEvidence input target asset observer assetId asset_id assetRef hostAssetId hostname asset_name assetName ip primary_ip srcIp dstIp sourceIp targetIp address vid uniqueKey assetType status source_id source_session_id parent_session_id user_message_id endpoint protocol port mode ruleId rule_id ruleName rule_name connectionId layerId networkTier deptId assetIds ips cidrs assetTypes layerIds networkTiers deptIds all online onlineBasis onlineWindowMinutes heartbeatWindowSeconds lastSeenAt lastProbeAt probeState current state applicable applicable_count passed failed normalCount abnormalCount unknownCount notApplicableCount failedCount totalCount coverageCount collection_count intakeMode collectionState collectionStatus collectionBindings collectionConfigs hasCollectionBinding groups modelId deviceId response observation response_status management_status binding_count plugins metrics ownershipVerified consistency addressIdentity execution_point services service raw_receipt_refs receipt_id run_id node_id operation operationId capability capability_version capabilityVersion observerAssetId targetAssetId sourceAssetId model evidence notes gaps resultGap sourceRef source_ref evidence_ref evidence_refs reference references reference_id original_ref snapshot_id snapshotId receipt_ref report_ref source_uri sourceUri authority identity source_type source_kind event_id issue_id impact priority owner assigned_to reviewed_at reviewed_by review review_status manual_review symptoms symptom symptom_id symptoms_count additional_anomalies additional_anomaly_count located_count partially_located_count pending_count recovery_passed_count diagnosis_count location_status recovery_status causes cause_id causeId hypotheses hypothesis support refutation supporting refuting conditions condition_groups conditionGroups conjunction logic field field_name fieldName operator expected actual expected_value actual_value value value_type valueType expected_type actual_type outcome explanation matched supported contradicted conflict cause status_label business_path businessPath business_paths path_nodes pathNodes nodes edges links chains fault_chains faultChains correlations common_causes commonCauses topology dispositions disposition recovery_records recoveryRecords verifications verification actions action action_status advice suggestions records environment details_count normalized_status executionPoint code sourceTime source_time sourceTimeZone response_time observed_time execution_time report_generated_at blocked complete unverified skipped not_executed available execution_records process audit evidence_count evidenceCount asset_count assetCount evidence_until_utc receipt_hash_scope source_snapshot_sha256 status_summary result_complete first_seen last_seen original_timezone raw_status rendered_at reviewed publication_version template_version snapshot_version releaseVersion business_result reported_state exact_matches member_count memberCount complete source_observations source_time_evidence groupMemberResponses located partially_located pending_verification support_conditions rebuttal rebuttal_conditions acceptance_records source_appendix report run readiness passFlag notCheckedReason templateScopeMatched applicableCount coverageReason itemId applicabilityReason conditionError consistency observations record vulnerabilityId sourceAssetIds sources errors ruleType via reachable verdict natApplied viaSrcIp viaDstIp routeOnlyPath policy hops policy_error path_observed_at policy_observed_at rules_frozen_at report_path saved_path unknownEvidence inconclusive active_probes_executed activeProbes unavailable successNoMatch unified_conclusion conclusionVersion currentStatus currentStatusCode impactLevel basis businessCritical durationHours confirmedImpact note incidentSummary impactScope rootCause statusCode supportingFacts contradictingFacts primaryRecommendation followupRecommendations escalation required conditions trigger recommendationLifecycle stopStatus failed notExecuted noData partialFailures stopStatusCode verificationMethod evidenceRefs partialFailures sideChannelPolicy corroboration platformOnly recommendationId category completionCriteria stateLabel prerequisites authorization risk objects boundary text factId actionStatus evidenceStatus observedAt rawReceiptRefs`.split(/\s+/))
const checkNames = new Set(['status', 'baseline', 'vulnerabilities', 'reachability', 'routine', 'deep', 'soc-state', 'alerts', 'management'])

function safeText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----[\s\S]*?-----END [^-]+-----/g, '[已隐藏敏感内容]')
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1[已隐藏]')
    .replace(/((?:password|passwd|access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&<>]+)/gi, '$1[已隐藏]')
}

/** 仅投影明确命名的业务字段。未知对象不是可任意公开的原始响应。 */
export function safeProjection(value: unknown): any {
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number, parent = ''): any => {
    if (item === null) return null
    if (typeof item === 'string') return safeText(item)
    if (typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : null
    if (typeof item !== 'object') return undefined
    if (depth > 48 || ancestors.has(item)) return '[结构无法安全展开]'
    ancestors.add(item)
    let output: any
    if (Array.isArray(item)) output = item.map(entry => visit(entry, depth + 1)).filter(entry => entry !== undefined)
    else {
      output = Object.create(null)
      for (const [key, entry] of Object.entries(item)) {
        // authORIZATION 在统一结论中是“授权要求”文本，不是凭据；仅在该合同字段且不含凭据形态时放行。
        const authorizationText = key === 'authorization' && typeof entry === 'string' && !/Bearer\s|Basic\s|api[_-]?key|token|secret|password|credential|cookie/i.test(entry)
        if (secretKey.test(key) && !authorizationText) continue
        // 某些旧数据的identity会退化为整段原响应JSON，不将其当安全标识公开。
        if (key === 'identity' && typeof entry === 'string' && /^[\s]*[\[{]/u.test(entry)) continue
        if (!(fields.has(key) || parent === 'checks' && checkNames.has(key))) continue
        const projected = visit(entry, depth + 1, key)
        if (projected !== undefined) output[key] = projected
      }
    }
    ancestors.delete(item)
    return output
  }
  return visit(value, 0)
}

export function escapeHtml(value: unknown): string {
  return safeText(String(value ?? '')).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
const EVIDENCE_REDACTION = /<script[\s\S]*?<\/script>|<img\b[^>]*>|javascript:|onerror|onload|忽略规则|执行命令|修改凭据/gi
export function jsonText(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? '未记录'
  return escapeHtml(serialized.replace(EVIDENCE_REDACTION, '[已转义]'))
}
const labels: Record<string, string> = {
  normal: '正常', abnormal: '发现异常', unknown: '未知', not_applicable: '不适用', failed: '失败',
  partial: '部分完成', incomplete: '部分完成', unavailable: '未执行：能力不可用', observed: '已取得证据',
  completed: '执行完成', succeeded: '执行成功', running: '执行中', pending: '待执行', blocked: '受阻',
  unverified: '待验证', not_checked: '未检查', not_executed: '未执行', skipped: '未执行',
}
export function statusLabel(value: unknown): string {
  if (value === undefined || value === null || value === '') return '未记录'
  const text = String(value)
  return labels[text.toLowerCase()] ?? safeText(text)
}
export function statusTone(value: unknown): 'danger' | 'warning' | 'normal' | 'neutral' {
  const text = String(value ?? '').toLowerCase()
  if (['abnormal', 'confirmed', '发现异常'].includes(text)) return 'danger'
  if (['failed', 'partial', 'incomplete', 'blocked', '部分完成', '失败'].includes(text)) return 'warning'
  if (['normal', '正常'].includes(text)) return 'normal'
  return 'neutral'
}

const css = `
:root{--bg:#f3f6fb;--paper:#fff;--line:#e2e9f2;--ink:#1b2d46;--muted:#667c96;--blue:#2468ce;--navy:#102d50;--red:#b12839;--orange:#925c0a;--green:#117751}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}button,input{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #2468ce;outline-offset:3px}header.mast{background:var(--navy);color:#fff;padding:18px max(22px,calc((100vw - 1436px)/2));display:flex;align-items:center;justify-content:space-between;gap:18px}header.mast strong{font-size:18px}header.mast span{font-size:12px;color:#b8cbe0}.wrap,.shell{max-width:1480px;margin:22px auto 60px;padding:0 22px}.report-inspection{max-width:1420px}.card,.panel{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:22px 24px;box-shadow:0 3px 14px #1a2d4d0b;margin-bottom:18px;min-width:0}.card.overview,.overview{background:linear-gradient(115deg,#fff,#f5f9ff)}h1{font-size:27px;margin:0 0 8px;line-height:1.4}h2{font-size:19px;margin:0 0 14px}h3{font-size:15px;margin:0 0 9px}h4{font-size:14px;margin:12px 0 7px}p{margin:8px 0;overflow-wrap:anywhere}a{color:var(--blue)}.row,.panel-head,.page-title{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.page-title{align-items:flex-start}.page-title>div{min-width:0}.muted,.note,.sub,.thin,.tiny,small{color:var(--muted)}.tiny,.note,.sub,.thin,small{font-size:12px;overflow-wrap:anywhere}.report-meta{font-size:12px;color:var(--muted);margin-top:12px;overflow-wrap:anywhere}.grid,.cols,.detail-grid,.metrics,.kpis{display:grid;gap:16px;min-width:0}.cols,.grid.two,.grid.half,.detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.metrics{grid-template-columns:repeat(6,minmax(0,1fr));margin:18px 0}.report-inspection .metrics,.kpis{grid-template-columns:repeat(5,minmax(0,1fr))}.metric,.kpi{border:1px solid var(--line);border-radius:10px;padding:16px;background:white;min-width:0}.metric b,.metric strong,.kpi strong{display:block;font-size:29px;font-weight:750;line-height:1.3;overflow-wrap:anywhere}.metric span,.kpi label{display:block;font-size:13px;margin:7px 0 5px}.metric small,.kpi small{display:block;line-height:1.5}.pill,.tag{display:inline-block;font-size:12px;font-weight:700;border-radius:6px;padding:3px 9px;white-space:normal}.danger,.pill.danger,.tag.red{background:#fce8ea;color:var(--red)}.warning,.warn,.pill.warning,.pill.warn,.tag.orange{background:#fff2dc;color:var(--orange)}.normal,.good,.pill.normal,.pill.good,.tag.green{background:#e1f5ec;color:var(--green)}.neutral,.pill.neutral,.tag.gray{background:#edf1f6;color:#65768d}.info,.blue,.tag.blue{background:#eaf1ff;color:#225eac}.metric .danger,.metric .warning,.metric .normal,.kpi .danger,.kpi .warning,.kpi .normal{background:none}.headline,.intro,.notice,.important,.warn-box,.alert{padding:15px 18px;border:1px solid #dbe7f9;border-radius:9px;background:#f1f6ff;margin:14px 0}.warn-box,.alert{background:#fff8e9;border-color:#f0e1be}.summary-key{display:flex;gap:10px 22px;align-items:center;flex-wrap:wrap}.summary-key>b{font-size:20px}.tone-danger{color:var(--red)}.tone-warning{color:var(--orange)}.tone-normal{color:var(--green)}.tone-neutral{color:var(--muted)}.pane,.evidence-summary,.priority{border:1px solid var(--line);border-radius:9px;padding:16px;margin-bottom:12px;min-width:0}.priority{display:flex;gap:14px;align-items:flex-start}.priority-index{min-width:30px;min-height:30px;border-radius:8px;display:grid;place-items:center;background:#edf1f6}.table-wrap{overflow-x:auto;max-width:100%}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:12px 13px;overflow-wrap:anywhere}th{background:#f4f7fb;color:#536981;font-size:12px}tbody tr.selected{background:#edf4ff}.clickrow{cursor:pointer}.clickrow:hover{background:#f5f9ff}.tabs,.filters,.report-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.tabs{border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:20px}.tab,.filter-chip,.btn,.action{border:1px solid #cbd9e9;border-radius:8px;background:#fff;color:#29496d;padding:9px 13px;min-height:38px}.tab.active,.filter-chip.active,.primary{background:var(--navy);border-color:var(--navy);color:#fff}.btn.primary,.action.primary{background:var(--blue);border-color:var(--blue)}.link{border:0;background:none;color:var(--blue);padding:5px 0;min-height:34px;text-align:left}.filters input{border:1px solid #cbd9e9;border-radius:8px;padding:10px;min-width:220px;max-width:100%}.report-actions{justify-content:flex-end;margin-bottom:14px}.action-error,.print-failure{color:var(--red);font-size:12px}.empty{padding:18px;color:var(--muted);border:1px dashed #cbd7e7;border-radius:8px;background:#f8fafe}.detail{margin-top:16px}.detail h3{scroll-margin-top:20px}.kv{display:grid;grid-template-columns:minmax(115px,1fr) minmax(0,3fr);gap:7px 12px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}pre,.evidence,.code{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;background:#122641;color:#dbe7fa;border-radius:8px;padding:15px;max-height:500px;overflow:auto;margin:10px 0}.appendix summary{cursor:pointer;font-weight:700;padding:8px 0}.coverage-row+.coverage-row{margin-top:15px;padding-top:15px;border-top:1px solid var(--line)}.coverage-title{display:flex;justify-content:space-between;gap:12px;font-size:12px}.coverage-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:8px 0}.coverage-track{height:8px;border-radius:8px;background:#eaf0f7;display:block;overflow:hidden}.coverage-track i{display:block;height:100%;background:#8997ab}.tone-normal .coverage-track i{background:#14916a}.tone-danger .coverage-track i{background:#d23a48}.tone-warning .coverage-track i{background:#d97706}.path-nodes{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.path-node{padding:12px 16px;border:1px solid var(--line);background:#f5f8fc;border-radius:9px;min-width:145px}.foot{font-size:11px;color:var(--muted);display:flex;gap:15px;justify-content:space-between;flex-wrap:wrap;margin-top:20px;overflow-wrap:anywhere}.source-boundary{margin-top:20px;color:var(--muted);font-size:12px}.judgment{border:1px solid var(--line);border-radius:9px;padding:10px 14px;margin:10px 0}.value-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cause-choice{width:100%;text-align:left;margin:6px 0}.cause-choice.active{border-color:var(--blue);background:#f1f6ff}dialog{width:min(850px,94vw);max-height:90vh;overflow:auto;border:1px solid var(--line);border-radius:12px;padding:22px;color:var(--ink);background:#fff}dialog::backdrop{background:#10233e80}.dialog-head{display:flex;justify-content:space-between;gap:15px;align-items:center;position:sticky;top:0;background:white}.dialog-head h2{margin:0}[hidden]{display:none!important}
@media(max-width:1050px){.report-inspection .metrics,.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:1000px){.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.cols,.grid.two,.grid.half,.detail-grid{grid-template-columns:minmax(0,1fr)}}@media(max-width:650px){.wrap,.shell{padding:0 12px;margin-top:12px}.card,.panel{padding:16px}.grid.two,.cols,.detail-grid{grid-template-columns:minmax(0,1fr)}.metrics,.report-inspection .metrics,.kpis,.coverage-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.metric b,.metric strong,.kpi strong{font-size:24px}h1{font-size:23px}.tabs .tab{flex:1 1 45%}.filters input{width:100%;min-width:0}.kv{grid-template-columns:1fr}.value-grid{grid-template-columns:1fr}.mast span{display:none}}
@page{size:A4;margin:14mm 12mm 15mm}@media print{body{background:#fff;font-size:11px}.mast,.no-print,button,.report-actions,dialog{display:none!important}.wrap,.shell{max-width:none;width:100%;margin:0;padding:0}.card,.panel,.pane{border:0;box-shadow:none;border-radius:0;padding:0;margin:0 0 16px}.cols,.grid.two,.grid.half,.detail-grid,.value-grid{display:block}.metrics,.report-inspection .metrics,.kpis{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.metric,.kpi{padding:9px}.metric b,.metric strong,.kpi strong{font-size:19px}.table-wrap{overflow:visible}table{font-size:10px;table-layout:fixed}thead{display:table-header-group}tr{break-inside:avoid}h1,h2,h3,h4{break-after:avoid}pre,.evidence,.code{max-height:none!important;overflow:visible!important;background:#f1f3f7!important;color:#172b45!important;border:1px solid #d7dfeb;font-size:9px;white-space:pre-wrap!important;overflow-wrap:anywhere!important}.source-boundary,.foot{font-size:9px}}
`

const script = String.raw`(() => {
'use strict';
const all=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
let returnFocus=null;
function selectEvidence(id){
 const panels=all('[data-evidence-panel]');
 const panel=panels.find(node=>node.getAttribute('data-evidence-panel')===id);
 if(!panel)return;
 panels.forEach(node=>node.hidden=node!==panel);
 all('tr[data-record]').forEach(row=>row.classList.toggle('selected',row.getAttribute('data-record')===id));
 const prompt=document.getElementById('inspection-evidence-prompt');if(prompt)prompt.hidden=true;
 const heading=panel.querySelector('h3,[data-evidence-heading]');
 if(heading){heading.setAttribute('tabindex','-1');heading.focus();heading.scrollIntoView({block:'nearest'});}
}
const rows=all('tr[data-record]');
const search=document.getElementById('report-search');
let category='全部';
function applyFilter(){
 const needle=(search&&search.value||'').trim().toLocaleLowerCase();
 const visible=rows.filter(row=>{
  const hit=(category==='全部'||row.getAttribute('data-category')===category)&&(!needle||(row.getAttribute('data-search')||row.textContent||'').toLocaleLowerCase().includes(needle));
  row.hidden=!hit;return hit;
 });
 const empty=document.getElementById('no-matches');if(empty)empty.hidden=visible.length!==0;
 const status=document.getElementById('filter-status');if(status)status.textContent='显示 '+visible.length+' / '+rows.length+' 条；筛选不改变原报告与打印内容。';
 const inspection=document.querySelector('[data-report-kind="inspection"]')?.getAttribute('data-report-kind')==='inspection';
 const selected=visible.find(row=>row.classList.contains('selected'))||(inspection?undefined:visible[0]);
 if(selected){const id=selected.getAttribute('data-record');all('[data-evidence-panel]').forEach(p=>p.hidden=p.getAttribute('data-evidence-panel')!==id);rows.forEach(r=>r.classList.toggle('selected',r===selected));}
 else {all('[data-evidence-panel]').forEach(p=>p.hidden=true);if(inspection)rows.forEach(r=>r.classList.remove('selected'));}
 const prompt=document.getElementById('inspection-evidence-prompt');if(prompt)prompt.hidden=!!selected;
}
if(search)search.addEventListener('input',applyFilter);
all('[data-filter]').forEach(button=>button.addEventListener('click',()=>{
 category=button.getAttribute('data-filter')||'全部';
 all('[data-filter]').forEach(b=>{const on=b===button;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});applyFilter();
}));
rows.forEach(row=>{row.addEventListener('click',()=>selectEvidence(row.getAttribute('data-record')));row.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target===row){event.preventDefault();selectEvidence(row.getAttribute('data-record'));}});});
all('[data-open-evidence]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();selectEvidence(button.getAttribute('data-open-evidence'));}));
const tabs=all('[data-tab]');
function selectTab(button){
 const id=button.getAttribute('data-tab');
 tabs.forEach(tab=>{const on=tab===button;tab.classList.toggle('active',on);tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;});
 all('[data-view]').forEach(panel=>panel.hidden=panel.getAttribute('data-view')!==id);
}
tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectTab(tab));tab.addEventListener('keydown',event=>{
 let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;
 if(next!==undefined){event.preventDefault();selectTab(tabs[next]);tabs[next].focus();}
});});
const causes=all('[data-cause-select]');
function selectCause(button){
 const id=button.getAttribute('data-cause-select');
 causes.forEach(b=>{const on=b===button;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});
 all('[data-cause-panel]').forEach(panel=>panel.hidden=panel.getAttribute('data-cause-panel')!==id);
}
causes.forEach((button,index)=>{button.addEventListener('click',()=>selectCause(button));button.addEventListener('keydown',event=>{
 let next;if(event.key==='ArrowDown'||event.key==='ArrowRight')next=(index+1)%causes.length;else if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=(index+causes.length-1)%causes.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=causes.length-1;
 if(next!==undefined){event.preventDefault();selectCause(causes[next]);causes[next].focus();}
});});
const dialog=document.getElementById('evidence-dialog'),body=document.getElementById('evidence-dialog-body');
all('[data-show-evidence]').forEach(button=>button.addEventListener('click',()=>{
 const template=document.getElementById('evidence-content-'+button.getAttribute('data-show-evidence'));
 if(!template||!body||!dialog)return;returnFocus=button;body.replaceChildren(template.content.cloneNode(true));
 if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
}));
function closeDialog(){if(!dialog)return;if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');if(returnFocus&&returnFocus.isConnected)returnFocus.focus();}
all('[data-close-dialog]').forEach(button=>button.addEventListener('click',closeDialog));
if(dialog){dialog.addEventListener('click',event=>{if(event.target===dialog)closeDialog();});dialog.addEventListener('close',()=>{if(returnFocus&&returnFocus.isConnected)returnFocus.focus();});}
const urls=new Set(),timers=new Set();
const printButton=document.getElementById('open-print'),printError=document.getElementById('print-error');
if(printButton)printButton.addEventListener('click',()=>{
 let url=null,popup=null;
 try{
  const payload=document.getElementById('report-print-payload');if(!payload)throw new Error('没有保存完整打印版');
  const bytes=Uint8Array.from(atob(payload.textContent.trim()),char=>char.charCodeAt(0));
  url=URL.createObjectURL(new Blob([bytes],{type:'text/html;charset=utf-8'}));urls.add(url);
  popup=window.open('about:blank','_blank');if(!popup)throw new Error('浏览器阻止了打印窗口，请允许本页弹窗后重试');
  popup.opener=null;popup.location.replace(url);
  const timer=setInterval(()=>{if(popup.closed){clearInterval(timer);timers.delete(timer);URL.revokeObjectURL(url);urls.delete(url);}},750);timers.add(timer);
  if(printError)printError.textContent='已打开全部内容的独立打印版，请在新窗口使用浏览器打印或保存PDF。';
 }catch(error){if(url){URL.revokeObjectURL(url);urls.delete(url);}if(popup&&!popup.closed)popup.close();if(printError)printError.textContent=error.message||'打开打印版失败';}
});
window.addEventListener('pagehide',()=>{timers.forEach(clearInterval);urls.forEach(url=>URL.revokeObjectURL(url));});
if(rows.length)applyFilter();
})();`

export interface ReportDocumentOptions {
  kind: 'inspection' | 'fault'
  title: string
  subtitle?: string
  runId?: string
  generatedAt?: string
  snapshot?: unknown
  content: string
  printContent: string
  interaction?: 'inspection' | 'fault'
}

export function renderDocument(options: ReportDocumentOptions): string {
  const snapshot = safeProjection(options.snapshot ?? {})
  const projectionHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  const title = escapeHtml(options.title)
  const subtitle = escapeHtml(options.subtitle ?? '已保存结果 · 只读报告')
  const scope = `data-report-kind="${options.kind}" data-template-version="security-report-reference/1"`
  const heading = /<h1(?:\s|>)/i.test(options.content) ? '' : `<section class="page-title"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></section>`
  const footer = `<footer class="foot"><span>安全展示投影 SHA-256：${projectionHash}</span><span>仅呈现本次已保存结果 · 未记录不等于不存在</span></footer>`
  const meta = `<p class="report-meta">原运行：${escapeHtml(options.runId ?? '未记录')} · 生成时间：${escapeHtml(options.generatedAt ?? '未记录')} · 人工复核：未记录</p>`
  const boundary = '<p class="source-boundary">本文仅公开声明的业务字段与安全投影，不是完整上游原始响应；源观测时间、响应时间与执行时间分别记录。未知不表示正常，支持线索不等于确认根因，报告生成不等于故障已修复或业务恢复。</p>'
  const printCsp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  const printDocument = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${printCsp}"><meta name="referrer" content="no-referrer"><title>${title} · 全量打印版</title><style>${css}\nbody{background:#fff}.wrap{max-width:1100px}.card,.panel{box-shadow:none}pre{max-height:none;overflow:visible}</style></head><body><main class="wrap report-${options.kind}" ${scope}><h1>${title} · 全量打印版</h1><p class="muted">${subtitle} · 全部安全内容，不受页签或筛选影响</p>${meta}${options.printContent}${boundary}${footer}</main></body></html>`
  const printPayload = Buffer.from(printDocument, 'utf8').toString('base64')
  const scriptHash = createHash('sha256').update(script).digest('base64')
  const csp = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><title>${title}</title><style>${css}</style></head><body><header class="mast"><strong>安全运营 / ${title}</strong><span>已保存结果 · 单次报告 · 独立 HTML</span></header><main class="wrap report-${options.kind}" ${scope}>${heading}<div class="report-actions no-print"><button type="button" class="btn primary" id="open-print">打开独立打印版 / 保存 PDF</button><span role="status" id="print-error" class="action-error"></span></div>${options.content}${meta}${boundary}${footer}</main><dialog id="evidence-dialog" aria-labelledby="evidence-dialog-title"><div class="dialog-head"><h2 id="evidence-dialog-title">本次已保存安全证据</h2><button type="button" class="btn" data-close-dialog>关闭</button></div><div id="evidence-dialog-body"></div></dialog><script id="report-print-payload" type="application/octet-stream">${printPayload}</script><script>${script}</script></body></html>`
}
