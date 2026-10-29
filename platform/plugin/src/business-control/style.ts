export const businessControlStyle = `
.harness-gateway-page .harness-page-heading{margin:0 0 28px}
.harness-gateway-page .harness-page-heading>div{min-width:0}
.harness-gateway-page .harness-page-heading h1{margin:0 0 4px;font-size:30px}
.harness-gateway-page .harness-page-heading p{font-size:14px}
.harness-gateway-page .harness-gateway-refresh{display:inline-flex;align-items:center;gap:8px;border-color:var(--hep-border);background:var(--hep-surface);font-weight:500}
.harness-gateway-text-button{border:0;padding:0;background:transparent;color:var(--hep-link);font:inherit;line-height:inherit;text-align:left;text-decoration:none;cursor:pointer}
.harness-gateway-text-button:hover{text-decoration:underline}
.harness-gateway-page .harness-guide{margin:0 0 20px;color:var(--hep-muted);font-size:13px}
.harness-gateway-page .harness-guide summary{width:fit-content;cursor:pointer;color:var(--hep-link)}
.harness-gateway-page .harness-guide p{margin:8px 0 0;max-width:85ch}
.harness-gateway-main-tabs{display:flex;gap:24px;overflow-x:auto;margin:0;border-bottom:0;border-radius:var(--hep-radius) var(--hep-radius) 0 0}
.harness-gateway-main-tabs button{flex:none;min-width:0;white-space:nowrap}
.harness-gateway-main-tabs button[aria-selected=true]{color:var(--hep-link);border-bottom:2px solid var(--hep-link);font-weight:600}
.harness-gateway-dirty-dot{color:var(--hep-link);font-size:13px}
.harness-gateway-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0}
.harness-gateway-workspace>.harness-card{border-radius:0 0 var(--hep-radius) var(--hep-radius)}
.harness-gateway-workspace .harness-composition-detail{padding:20px}
.harness-gateway-workspace .harness-section-heading{margin:0 0 20px}
.harness-gateway-workspace .harness-section-heading h2{margin:0;font-size:20px}
.harness-gateway-workspace .harness-section-heading .harness-gateway-description{margin:4px 0 0;font-size:13px}
.harness-gateway-draft-state{flex:none;border:1px solid var(--hep-border);padding:4px 8px;border-radius:6px;color:var(--hep-muted);font-size:12px}
@media(min-width:681px){.harness-gateway-main-tabs+.harness-gateway-savebar{margin:0;padding:12px 16px;border:1px solid var(--hep-border);border-bottom:0;background:var(--hep-surface)}}
.harness-gateway-workspace .harness-composition-detail>h2{margin-bottom:12px}
.harness-gateway-workspace .harness-mcp-toolbar{margin-bottom:20px}
.harness-gateway-risk-notice{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:16px 0;padding:16px;border:1px solid color-mix(in srgb,var(--hep-warning) 38%,var(--hep-border));border-radius:var(--hep-control-radius);background:color-mix(in srgb,var(--hep-warning) 12%,var(--hep-surface))}
.harness-gateway-risk-notice strong{color:var(--hep-warning);font-size:13px}.harness-gateway-risk-notice p{margin:5px 0 0;font-size:12px}.harness-gateway-risk-notice button{flex:none}
.harness-gateway-overview-table{max-height:none;margin:16px 0 24px}
.harness-gateway-overview-table table{width:100%;border-collapse:collapse}
.harness-gateway-overview-table th{padding:12px 14px;background:var(--hep-surface-muted);color:var(--hep-muted);font-size:12px;font-weight:600;text-align:left;white-space:nowrap}
.harness-gateway-overview-table td{padding:16px 14px;border-bottom:1px solid var(--hep-border);font-size:13px;vertical-align:middle}
.harness-gateway-overview-table td strong,.harness-gateway-overview-table td small{display:block}
.harness-gateway-overview-table td small{margin-top:3px;color:var(--hep-muted);font-size:11px}
.harness-gateway-overview-table td code{display:block;max-width:150px;overflow-wrap:anywhere}
.harness-gateway-overview-table td .harness-gateway-text-button{white-space:nowrap}
.harness-gateway-badge{display:inline-block;padding:4px 8px;border-radius:6px;white-space:nowrap}
.harness-gateway-badge[data-state=success]{color:var(--hep-success);background:color-mix(in srgb,var(--hep-success) 10%,var(--hep-surface))}
.harness-gateway-badge[data-state=pending]{color:var(--hep-warning);background:color-mix(in srgb,var(--hep-warning) 10%,var(--hep-surface))}
.harness-gateway-badge[data-state=blocked]{color:var(--hep-danger);background:color-mix(in srgb,var(--hep-danger) 10%,var(--hep-surface))}
.harness-gateway-identity-table{margin:4px 0 0}
.harness-gateway-identity-table td code{display:inline;max-width:none}
.harness-gateway-risk-summary .harness-gateway-risk-notice{margin:16px 0}
.harness-gateway-risk-facts{display:grid;grid-template-columns:140px minmax(0,1fr);gap:14px 24px;margin:0;line-height:1.6;font-size:13px}
.harness-gateway-risk-facts dt{color:var(--hep-muted)}
.harness-gateway-risk-facts dd{margin:0;overflow-wrap:anywhere}
.harness-gateway-risk-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:16px 0 4px}
.harness-gateway-config{display:block}
.harness-gateway-savebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid var(--hep-border)}
.harness-gateway-savebar>div{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.harness-gateway-savebar small,.harness-gateway-description{font-size:12px;color:var(--hep-muted)}
.harness-gateway-description-card{padding:16px 18px;margin:0 0 20px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-description-card>p{margin:8px 0;overflow-wrap:anywhere}
.harness-gateway-description-card details{margin-top:10px}
.harness-gateway-description-card li{margin:8px 0;overflow-wrap:anywhere}
.harness-gateway-description-card li p{margin:3px 0;color:var(--hep-muted);font-size:12px}
.harness-gateway-probe{display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap;min-width:0}
.harness-gateway-probe>button{flex:none}
.harness-gateway-probe small{flex:1;min-width:min(100%,240px);color:var(--hep-muted);font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.harness-gateway-probe [role=alert]{color:var(--hep-danger)}
.harness-gateway-config fieldset{border:0;min-width:0;margin:0;padding:0}
.harness-gateway-config legend{font-size:16px;font-weight:600;padding:0;margin-bottom:8px}
.harness-gateway-config fieldset>p:first-of-type{margin:0 0 20px;color:var(--hep-muted);font-size:13px}
.harness-gateway-visually-hidden{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden;white-space:nowrap}
.harness-gateway-agent{padding:16px;margin:12px 0;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-agent>strong{grid-column:1/-1}
.harness-gateway-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.harness-gateway-panel-heading{margin:0 0 12px}
.harness-gateway-panel-heading h3{font-size:15px;margin:0}
.harness-gateway-panel-heading small{display:block;color:var(--hep-muted);font-size:12px}
.harness-gateway-panel-heading button{flex:none}
.harness-gateway-access-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 24px;margin:0 0 24px}.harness-gateway-access-fields>.harness-gateway-service-scope{grid-column:1/-1}
.harness-gateway-access-fields>label,.harness-gateway-access-fields>.harness-gateway-choices{display:grid;align-content:start;gap:8px;min-width:0;font-weight:600}
.harness-gateway-access-fields input,.harness-gateway-access-fields select{min-height:46px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);font-weight:400}
.harness-gateway-access-fields input[readonly]{background:var(--hep-surface-muted)}
.harness-gateway-access-fields small{font-weight:400}
.harness-gateway-action-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 0;border-bottom:1px solid var(--hep-border);margin:0 0 24px}
.harness-gateway-page .harness-gateway-switch-label{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;font-size:14px;font-weight:600;cursor:pointer}
.harness-gateway-action-row>div{display:grid;gap:5px}
.harness-gateway-action-row strong{font-size:14px}
.harness-gateway-action-row small{color:var(--hep-muted);font-size:12px}
.harness-gateway-switch{position:relative;display:block;flex:none;width:38px;height:22px}
.harness-gateway-switch input{position:absolute;inset:0;margin:0;opacity:0;cursor:pointer}
.harness-gateway-switch span{display:block;width:38px;height:22px;border-radius:12px;background:var(--hep-border);pointer-events:none;transition:background var(--hep-motion-fast)}
.harness-gateway-switch span::after{content:'';display:block;position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--hep-surface);transition:transform var(--hep-motion-fast)}
.harness-gateway-switch input:checked+span{background:var(--hep-primary)}
.harness-gateway-switch input:checked+span::after{transform:translateX(16px)}
.harness-gateway-switch input:focus-visible+span{outline:2px solid var(--hep-focus);outline-offset:3px}
.harness-gateway-choices{display:grid;align-content:start;gap:8px;min-width:0}
.harness-gateway-choices>span{font-size:13px;font-weight:500}
.harness-gateway-choice-list{display:flex;flex-wrap:wrap;gap:8px}
.harness-gateway-option{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;padding:5px 9px;border:1px solid var(--hep-border);border-radius:6px;background:var(--hep-surface);font-size:12px;overflow-wrap:anywhere}
.harness-gateway-option[data-selected=true]{border-color:var(--hep-primary);background:var(--hep-primary-soft)}
.harness-gateway-choices small,.harness-gateway-subjects small{color:var(--hep-muted);font-size:12px}
.harness-gateway-action-row input,.harness-gateway-agent-tools input{width:auto;min-height:0;margin:0}
.harness-gateway-action-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 20px}
.harness-gateway-action-options{grid-column:1/-1;display:grid;gap:10px}.harness-gateway-action-options>span{font-size:13px;color:var(--hep-muted)}
.harness-gateway-agent-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 24px}
.harness-gateway-agent-tools>button{border:0;padding:0;background:transparent;color:var(--hep-link);font-size:12px}
.harness-gateway-operation-list{min-width:0}
.harness-gateway-operation-list-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.harness-gateway-operation-list-heading h3{margin:0;font-size:14px}
.harness-gateway-operation-list-heading button{border:0;padding:0;background:transparent;color:var(--hep-link);font-size:12px}
.harness-gateway-operation-card{min-width:0;margin:0 0 8px;border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-operation-card .harness-gateway-operation-fields{padding:0 16px 16px}.harness-gateway-operation-card h4{padding:14px 16px;margin:0;font-size:14px}.harness-gateway-operation-select{display:grid;gap:8px;margin:14px 0}
.harness-gateway-operation-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
.harness-gateway-operation-fields .harness-gateway-field-wide{grid-column:1/-1}
.harness-gateway-operation-fields label{font-size:13px}
.harness-gateway-operation-fields input[type=checkbox]{width:auto}
.harness-gateway-operation-fields button{justify-self:start}
.harness-gateway-access-empty{margin:0;padding:24px;border:1px dashed var(--hep-border);border-radius:var(--hep-control-radius);color:var(--hep-muted);font-size:13px}
.harness-gateway-access-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:28px 0 0}
.harness-gateway-access-footer .harness-gateway-window-trigger{max-width:70%}
.harness-gateway-identity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.harness-gateway-identity>section{min-width:0;overflow-wrap:anywhere}
.harness-gateway-identity>section>p{color:var(--hep-muted);font-size:13px}
.harness-gateway-identity .harness-gateway-agent{grid-template-columns:minmax(0,1fr)}
.harness-gateway-empty{padding:20px;border:1px dashed var(--hep-border);border-radius:var(--hep-control-radius);margin:0 0 20px}
.harness-gateway-empty p{margin:6px 0 12px;color:var(--hep-muted)}
.harness-gateway-facts{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;margin:16px 0}
.harness-gateway-facts article{padding:16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-facts h4{margin:0 0 8px}
.harness-gateway-facts p{margin:6px 0;font-size:12px;color:var(--hep-muted)}
.harness-gateway-list{list-style:none;padding:0;margin:12px 0}
.harness-gateway-list>li{padding:12px 0;border-bottom:1px solid var(--hep-border);overflow-wrap:anywhere}
.harness-gateway-list>li:last-child{border-bottom:0}
.harness-gateway-list p{margin:6px 0;font-size:13px}
.harness-gateway-auxiliary{margin-top:24px;border-top:1px solid var(--hep-border);padding-top:16px}
.harness-gateway-runtime-section{min-width:0;padding:20px 0;border-top:1px solid var(--hep-border)}
.harness-gateway-runtime-section:first-of-type{border-top:0}
.harness-gateway-runtime-section h3{margin:0 0 8px;font-size:15px}
.harness-gateway-runtime-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
.harness-gateway-runtime-layout>aside{min-width:0;border-top:1px solid var(--hep-border);padding-top:20px}
.harness-gateway-subject-picker{min-width:0;margin:0;padding:12px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius)}
.harness-gateway-subject-picker legend{padding:0 4px;font-size:13px;font-weight:600}
.harness-gateway-subject-picker .harness-gateway-option{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:6px 10px;border:1px solid var(--hep-border);border-radius:6px;overflow-wrap:anywhere;cursor:pointer}
.harness-gateway-subject-picker .harness-gateway-option input{width:auto;flex:none;margin:0}
.harness-gateway-subject-picker small{display:block;margin-top:8px;color:var(--hep-muted);font-size:12px}
.harness-gateway-subject-picker p{margin:0 0 8px;color:var(--hep-muted);font-size:12px}
.harness-gateway-release{display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin:8px 0}
.harness-gateway-release label{min-width:min(100%,260px)}
.harness-gateway-workspace .harness-table-scroll:not(.harness-gateway-overview-table){margin:16px 0;max-height:400px}
.harness-gateway-page .harness-gateway-inline{display:flex;align-items:center;gap:8px}
.harness-gateway-page .harness-gateway-inline input{width:auto}
@media(max-width:680px){
.harness-gateway-page{display:flex;flex-direction:column;padding-bottom:100px}
.harness-gateway-risk-badge{flex:none;padding:5px 8px;border-radius:6px;color:var(--hep-warning);background:color-mix(in srgb,var(--hep-warning) 10%,var(--hep-surface));font-size:12px}
.harness-gateway-main-tabs{overflow-x:auto}
.harness-gateway-workspace{order:3}
.harness-gateway-workspace .harness-composition-detail{padding:20px 16px}
.harness-gateway-workspace .harness-section-heading{align-items:flex-start}
.harness-gateway-workspace .harness-section-heading h2{font-size:18px}
.harness-gateway-workspace .harness-section-heading .harness-gateway-description{font-size:12px}
.harness-gateway-savebar{order:4;align-items:flex-start;gap:8px;margin:12px 0;padding:12px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface)}
.harness-gateway-savebar>div:first-child{gap:4px}
.harness-gateway-savebar>div:first-child small{display:none}
.harness-gateway-savebar>.harness-mcp-actions{width:100%}
.harness-gateway-savebar>.harness-mcp-actions button{flex:1}
.harness-gateway-page .harness-guide{order:6}
.harness-gateway-identity-table th:nth-child(n+3),.harness-gateway-identity-table td:nth-child(n+3){display:none}
.harness-gateway-identity-table td{vertical-align:top;overflow-wrap:anywhere}
.harness-gateway-risk-facts{grid-template-columns:minmax(0,1fr);gap:4px}
.harness-gateway-risk-facts dd{margin-bottom:10px}
.harness-gateway-risk-notice{align-items:flex-start;flex-wrap:wrap}
.harness-gateway-identity,.harness-gateway-access-fields,.harness-gateway-operation-fields{grid-template-columns:minmax(0,1fr)}
.harness-gateway-page .harness-page-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'title action' 'description description';align-items:start;column-gap:12px;row-gap:4px;margin:24px 0 20px}
.harness-gateway-page .harness-page-heading>div{display:contents}
.harness-gateway-page .harness-page-heading h1{grid-area:title;font-size:27px}
.harness-gateway-page .harness-page-heading p{grid-area:description;font-size:13px}
.harness-gateway-page .harness-page-heading>button{grid-area:action;flex-shrink:0}
.harness-gateway-panel-heading{align-items:flex-start}
.harness-gateway-operation-fields .harness-gateway-field-wide{grid-column:auto}
.harness-gateway-access-footer{align-items:stretch;flex-direction:column}
.harness-gateway-access-footer .harness-gateway-window-trigger{max-width:none}
.harness-gateway-access-footer>button{width:100%}
}
.harness-gateway-detail-links{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;margin:16px 0 0;padding-top:12px;border-top:1px solid var(--hep-border)}
.harness-gateway-mobile-identity-result{display:none}
.harness-gateway-overview-table .harness-gateway-window-trigger{display:flex;font-size:12px}
.harness-gateway-main-tabs button{min-height:48px}
.harness-gateway-drawer-table{max-width:100%;overflow:auto}
.harness-gateway-drawer-table table{width:100%;border-collapse:collapse;font-size:13px}
.harness-gateway-drawer-table th,.harness-gateway-drawer-table td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--hep-border,#dce3ed);overflow-wrap:anywhere}
.harness-gateway-drawer-table th{color:var(--hep-muted,#607187);font-weight:600;white-space:nowrap}
@media(max-width:680px){.harness-gateway-mobile-identity-result{display:block;font-size:12px;color:var(--hep-muted)}.harness-gateway-detail-links{gap:4px 16px}.harness-gateway-navigation{padding-inline:16px}}
.harness-gateway-preview-actions{display:flex;justify-content:flex-end;gap:10px}

.harness-gateway-navigation{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 20px;border:1px solid var(--hep-border);border-radius:10px 10px 0 0;background:var(--hep-surface)}.harness-gateway-navigation .harness-gateway-main-tabs{padding:0;border:0;margin:0;gap:24px}.harness-gateway-read-controls{display:flex;align-items:center;justify-content:flex-end;gap:12px;font-size:12px;color:var(--hep-muted);flex-shrink:0}.harness-gateway-read-controls button{display:flex;gap:6px;align-items:center;min-height:36px;font-size:12px}.harness-gateway-read-controls svg{width:15px;height:15px}.harness-gateway-workspace>.harness-card{border-top:0}.harness-gateway-workspace .harness-composition-detail{padding:20px}.harness-gateway-charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:auto auto 1fr auto;gap:8px 16px;margin-bottom:20px}.harness-gateway-chart{display:grid;grid-row:span 4;grid-template-rows:subgrid;padding:16px;border:1px solid var(--hep-border);border-radius:10px;background:var(--hep-surface);min-width:0}.harness-gateway-chart h3{margin:0;font-size:14px}.harness-gateway-chart>p{margin:0;color:var(--hep-muted);font-size:12px}.harness-gateway-chart>small{display:block;min-height:20.4px;color:var(--hep-muted);font-size:12px;line-height:1.7}.harness-gateway-chart-body{display:flex;gap:12px;align-items:center;min-height:104px;min-width:0}.harness-gateway-chart-body svg{width:104px;height:104px;flex:none}.harness-gateway-chart-body circle{fill:none;stroke-width:12;stroke:var(--hep-border)}.harness-gateway-chart-body [data-tone=success]{stroke:var(--hep-success)}.harness-gateway-chart-body [data-tone=blocked]{stroke:var(--hep-danger)}.harness-gateway-chart-body [data-tone=pending]{stroke:var(--hep-warning)}.harness-gateway-chart-body [data-tone=neutral]{stroke:var(--hep-muted)}.harness-gateway-chart-body text{text-anchor:middle;font-size:15px;fill:var(--hep-muted)}.harness-gateway-chart-body text.harness-gateway-chart-total{font-size:23px;font-weight:600;fill:var(--hep-text)}.harness-gateway-chart-body>div{display:grid;align-self:start;gap:4px;flex:1;min-width:0}.harness-gateway-page .harness-gateway-chart-body button{display:flex;align-items:center;gap:7px;min-height:26px;padding:3px 4px;border:0;background:transparent;text-align:left;font-size:12px}.harness-gateway-chart-body button i{width:7px;height:7px;border-radius:50%;background:var(--hep-muted);flex:none}.harness-gateway-chart-body button[data-tone=success] i{background:var(--hep-success)}.harness-gateway-chart-body button[data-tone=blocked] i{background:var(--hep-danger)}.harness-gateway-chart-body button[data-tone=pending] i{background:var(--hep-warning)}.harness-gateway-chart-body button strong{margin-left:auto;font-size:12px}.harness-gateway-chart-body button[aria-pressed=true]{background:var(--hep-primary-soft)}.harness-gateway-attention{padding:14px 18px;margin-bottom:20px;border-left:3px solid var(--hep-warning);background:var(--hep-surface-muted);border-radius:7px}.harness-gateway-attention h3{margin:0 0 8px;font-size:14px}.harness-gateway-attention>div{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;margin-top:8px}.harness-gateway-attention button{min-height:30px;padding:4px 8px;font-size:12px}.harness-gateway-object{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:24px;padding-bottom:18px;border-bottom:1px solid var(--hep-border)}.harness-gateway-object>.hep-search-select{width:240px}.harness-gateway-object>div:not(.hep-search-select){flex:1;min-width:0}.harness-gateway-object p{margin:5px 0;color:var(--hep-muted);font-size:13px}.harness-gateway-object small{font-size:11px;color:var(--hep-muted)}.harness-gateway-risk-records{padding-top:18px;border-top:1px solid var(--hep-border);margin:20px 0}.harness-gateway-risk-records>article{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid var(--hep-border);border-radius:10px;padding:16px;margin:10px 0}.harness-gateway-risk-records article>div{min-width:0;overflow-wrap:anywhere}.harness-gateway-risk-records strong{font-size:13px}.harness-gateway-risk-records p,.harness-gateway-risk-records small{margin:5px 0;font-size:12px;color:var(--hep-muted)}.harness-gateway-risk-records button{flex:none}.harness-gateway-runtime-layout{display:block}.harness-gateway-manual{margin:18px 0;padding:14px;border:1px solid var(--hep-border);border-radius:8px}.harness-gateway-restriction-heading{font-size:13px;color:var(--hep-text)}.harness-gateway-manual h3{margin:0 0 14px}.harness-gateway-restriction-detail .harness-gateway-release{padding-top:12px}.harness-gateway-page .harness-gateway-runtime-section:first-child{margin-top:0;padding-top:0;border-top:0}
@media(max-width:1200px){.harness-gateway-chart{padding:14px 12px}.harness-gateway-chart-body{gap:6px}.harness-gateway-chart-body svg{width:90px;height:90px}.harness-gateway-navigation{flex-wrap:wrap;gap:0}.harness-gateway-read-controls{margin-left:auto;padding:8px 0}}@media(max-width:900px){.harness-gateway-charts{grid-template-columns:minmax(0,1fr);grid-template-rows:none;row-gap:12px}.harness-gateway-chart{grid-row:auto;grid-template-rows:auto auto auto auto}.harness-gateway-chart-body svg{width:96px;height:96px}.harness-gateway-chart-body{gap:20px}.harness-gateway-chart-body>div{grid-template-columns:repeat(2,minmax(0,1fr))}.harness-gateway-read-controls{flex-wrap:wrap;font-size:11px}.harness-gateway-navigation{padding-inline:12px}.harness-gateway-navigation .harness-gateway-main-tabs{width:100%;border-bottom:1px solid var(--hep-border)}.harness-gateway-object>.hep-search-select{width:100%}}@media(max-width:600px){.harness-gateway-workspace .harness-composition-detail{padding:16px}.harness-gateway-charts{gap:12px}.harness-gateway-chart-body>div{grid-template-columns:minmax(0,1fr)}.harness-gateway-chart{padding:14px 16px}.harness-gateway-risk-records>article{flex-direction:column;align-items:stretch}.harness-gateway-risk-records button{align-self:flex-end}.harness-gateway-main-tabs{gap:20px!important}.harness-gateway-attention>div{flex-wrap:wrap}}

.harness-gateway-window-trigger{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--hep-link);padding:6px 0;font:inherit;font-size:13px;text-align:left;cursor:pointer}.harness-gateway-window-trigger:hover{background:transparent;text-decoration:underline}
.harness-gateway-window{position:fixed;inset:auto;left:var(--gateway-window-x,50%);top:var(--gateway-window-y,50%);transform:none;translate:-50% -50%;width:var(--gateway-window-width,min(860px,calc(100vw - 48px)));height:auto;max-width:calc(100vw - 24px);max-height:var(--gateway-window-height,calc(100dvh - 48px));margin:0;padding:0;border:1px solid var(--hep-border);border-radius:10px;background:var(--hep-surface);color:var(--hep-text);box-shadow:0 16px 56px #10283e2b;overflow:hidden;z-index:40;font:inherit}.harness-gateway-window:not([open]){display:none}.harness-gateway-window[open]{display:flex;flex-direction:column}.harness-gateway-window-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 24px;border-bottom:1px solid var(--hep-border);flex:none}.harness-gateway-window-heading h2{margin:0;font-size:18px}.harness-gateway-window-heading button{display:grid;place-items:center;min-width:36px;min-height:36px;padding:0;border:0;background:transparent;color:inherit;font-size:24px;line-height:1}.harness-gateway-window-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:20px 24px}.harness-gateway-window-body :is(p,code,dd){overflow-wrap:anywhere}.harness-gateway-window-body .harness-fields{display:grid;gap:14px;margin:0}.harness-gateway-window-body .harness-fields>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px}.harness-gateway-window-body dt{color:var(--hep-muted)}.harness-gateway-window-body dd{margin:0;min-width:0}.harness-gateway-window-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:14px 24px;border-top:1px solid var(--hep-border);flex:none}.harness-gateway-window-footer>div{display:flex;justify-content:flex-end;gap:8px;margin-left:auto}.harness-gateway-window-body form{margin:0}.harness-gateway-window-body .harness-gateway-identity{grid-template-columns:minmax(0,1fr)}.harness-gateway-config>.harness-gateway-window-trigger{margin-top:20px}.harness-gateway-preview-facts{display:grid;grid-template-columns:125px minmax(0,1fr);gap:12px;margin:0;padding:16px;border:1px solid var(--hep-border);border-radius:7px;background:var(--hep-surface-muted);font-size:13px}.harness-gateway-preview-facts dd p{margin:0 0 8px}.harness-gateway-preview-warning{margin:16px 0;padding:12px;border-radius:7px;color:var(--hep-warning);background:color-mix(in srgb,var(--hep-warning) 9%,var(--hep-surface))}
@media(max-width:680px){.harness-gateway-window-heading,.harness-gateway-window-body,.harness-gateway-window-footer{padding:16px}.harness-gateway-window-body .harness-fields>div{grid-template-columns:minmax(0,1fr);gap:4px}.harness-gateway-window-footer>div{flex-wrap:wrap}.harness-gateway-window-footer button{min-height:44px}.harness-gateway-preview-facts{grid-template-columns:minmax(0,1fr);gap:4px}}

.harness-gateway-provider-summary{display:flex;align-items:start;justify-content:space-between;gap:24px;padding-bottom:20px;border-bottom:1px solid var(--hep-border)}.harness-gateway-provider-summary>div{min-width:0}.harness-gateway-provider-summary h2{margin:0 0 10px;font-size:18px}.harness-gateway-provider-summary strong{display:block;font-size:14px}.harness-gateway-provider-summary p{margin:8px 0;color:var(--hep-muted);font-size:13px;overflow-wrap:anywhere}.harness-gateway-provider-summary small{color:var(--hep-warning)}.harness-gateway-risk-table small{display:block;margin-top:4px;color:var(--hep-muted);font-size:12px}.harness-gateway-risk-table td{vertical-align:top}.harness-gateway-runtime-section>.harness-section-heading p{color:var(--hep-muted);font-size:13px;margin:0}.harness-gateway-risk-records{border-top:0;padding-top:0}.harness-gateway-runtime-layout .harness-gateway-manual{margin-bottom:0}@media(max-width:900px){.harness-gateway-provider-summary{flex-direction:column;gap:12px}.harness-gateway-risk-table{overflow:auto}.harness-gateway-risk-table table{min-width:640px}}

.harness-gateway-policy-heading h2{font-size:18px;margin:0 0 8px}.harness-gateway-policy-heading p{margin:0 0 20px;color:var(--hep-muted);font-size:13px}.harness-gateway-policy-context{display:flex;align-items:start;justify-content:space-between;gap:20px;padding:16px;margin:0 0 20px;background:var(--hep-surface-muted);border-radius:7px}.harness-gateway-policy-context>div{min-width:0}.harness-gateway-policy-context p{margin:8px 0;font-size:13px;color:var(--hep-muted)}.harness-gateway-policy-context small{font-size:12px;color:var(--hep-muted)}.harness-gateway-policy-context>button{flex:none}@media(max-width:680px){.harness-gateway-policy-context{flex-direction:column;gap:10px}}

.harness-gateway-window-workspace{min-width:0}.harness-platform .harness-gateway-window-workspace .harness-gateway-page{padding-right:calc(var(--hep-page-padding,24px) + var(--gateway-assistant-inset,0px))}

.harness-gateway-risk-provider-form{margin:20px 0 28px;padding-bottom:24px;border-bottom:1px solid var(--hep-border)}.harness-gateway-risk-provider-form fieldset{display:grid;gap:20px;min-width:0;margin:0;padding:0;border:0}.harness-gateway-risk-provider-form fieldset>p{margin:0;color:var(--hep-muted);font-size:13px}.harness-gateway-agent-risk-summary>h3{margin:0 0 14px;font-size:16px}.harness-gateway-agent-risk-summary .harness-gateway-facts{grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px}.harness-gateway-agent-risk-summary article{padding:14px 16px}.harness-gateway-agent-risk-summary article h4{font-size:14px}.harness-gateway-policy-object{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--hep-border)}.harness-gateway-policy-object>label{display:grid;gap:8px;min-width:240px}.harness-gateway-policy-object p{color:var(--hep-muted);font-size:13px;flex:1;min-width:200px}.harness-gateway-policy-panels{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}.harness-gateway-policy-panels>form{min-width:0}.harness-gateway-policy-section-heading{display:flex;align-items:start;justify-content:space-between;gap:12px;margin-bottom:16px}.harness-gateway-policy-section-heading h3{margin:0;font-size:16px}.harness-gateway-policy-section-heading p{margin:4px 0 0;color:var(--hep-muted);font-size:12px}.harness-gateway-policy-actions>span{flex:none;padding:4px 8px;border:1px solid var(--hep-border);border-radius:6px;color:var(--hep-muted);font-size:12px}.harness-gateway-policy-panels .harness-gateway-access-state{margin-top:0}.harness-gateway-static-policy .harness-gateway-policy-context{padding:12px}.harness-gateway-static-policy .harness-gateway-policy-context p{font-size:12px}@media(min-width:1200px){.harness-gateway-policy-panels{grid-template-columns:minmax(0,1.35fr) minmax(300px,1fr);gap:20px}.harness-gateway-policy-panels .harness-gateway-access-state{padding:0 0 0 20px;border-top:0;border-left:1px solid var(--hep-border)}}@media(max-width:680px){.harness-gateway-policy-object>label{width:100%;min-width:0}.harness-gateway-policy-section-heading{flex-wrap:wrap}}

.harness-gateway-service-scope{display:grid;gap:12px;min-width:0}.harness-gateway-service-scope>label,.harness-gateway-settings-field{display:grid;gap:8px}.harness-gateway-service-scope>p{margin:0;color:var(--hep-muted);font-size:13px}.harness-gateway-service-scope>.hep-search-select{width:100%}.harness-gateway-selected-services{display:grid;gap:8px}.harness-gateway-selected-services>div{display:flex;align-items:start;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--hep-border);border-radius:7px;background:var(--hep-surface-muted);min-width:0}.harness-gateway-selected-services>div>div{min-width:0}.harness-gateway-selected-services strong{font-size:14px}.harness-gateway-selected-services p{margin:5px 0;font-size:12px;color:var(--hep-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.harness-gateway-selected-services small{display:block;color:var(--hep-muted);font-size:12px;overflow-wrap:anywhere}.harness-gateway-selected-services button{flex:none;font-size:12px}.harness-gateway-settings-links{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--hep-border)}.harness-gateway-settings-section{margin-top:20px;padding-top:20px;border-top:1px solid var(--hep-border)}.harness-gateway-settings-section h3{margin:0 0 12px;font-size:15px}.harness-gateway-settings-section label:not(.harness-gateway-option),.harness-gateway-settings-field{display:grid;gap:8px;margin:12px 0}.harness-gateway-settings-field small{font-size:12px;color:var(--hep-muted)}.harness-gateway-settings-section textarea{width:100%}.harness-gateway-settings-section .harness-gateway-action-options{margin:16px 0}.harness-gateway-settings-section .harness-gateway-agent-tools{margin-bottom:0}

.harness-gateway-policy-step{margin:20px 0}.harness-gateway-policy-step h4{margin:0 0 12px;font-size:15px}.harness-gateway-policy-step>.hep-search-select{width:100%}.harness-gateway-base-scope{display:flex;align-items:start;gap:12px;flex-wrap:wrap;padding:12px 14px;margin:0 0 16px;border-radius:7px;background:var(--hep-surface-muted);font-size:12px}.harness-gateway-base-scope>div{flex:1;min-width:180px}.harness-gateway-base-scope strong{display:block;font-size:13px}.harness-gateway-base-scope span,.harness-gateway-base-scope small{display:block;margin-top:5px;color:var(--hep-muted)}.harness-gateway-base-scope button{min-height:32px;padding:4px 8px;font-size:12px}.harness-gateway-tool-policy{min-width:0}.harness-gateway-tool-policy>label{margin:0 0 16px}.harness-gateway-policy-rule-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:20px 0 12px}.harness-gateway-policy-rule-heading h4{margin:0}.harness-gateway-policy-rule{padding:16px;border:1px solid var(--hep-border);border-radius:8px;margin-bottom:12px;background:var(--hep-surface-muted)}.harness-gateway-policy-rule>header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.harness-gateway-policy-rule>header button{font-size:12px}.harness-gateway-rule-fields{display:grid;gap:16px}.harness-gateway-rule-fields>label,.harness-gateway-rule-condition>label{display:grid;gap:8px}.harness-gateway-rule-fields input:not([type=checkbox]),.harness-gateway-rule-fields select{width:100%}.harness-gateway-rule-fields small{font-size:12px;color:var(--hep-muted)}.harness-gateway-rule-condition{min-width:0;margin:0;padding:0;border:0}.harness-gateway-config .harness-gateway-rule-condition legend{font-size:13px;font-weight:600;margin-bottom:8px}.harness-gateway-rule-condition .harness-gateway-choice-list>label{display:inline-flex;align-items:center;flex:none;gap:6px;max-width:100%;font-size:13px;overflow-wrap:anywhere}.harness-gateway-rule-condition input[type=checkbox]{width:auto;flex:none;min-height:0;margin:0}.harness-gateway-policy-warning{padding:10px 12px;margin:12px 0;border-radius:7px;background:color-mix(in srgb,var(--hep-warning) 10%,var(--hep-surface));color:var(--hep-warning);font-size:13px}.harness-gateway-policy-warning p{margin:0 0 6px}.harness-gateway-policy-warning p:last-child{margin-bottom:0}@media(max-width:680px){.harness-gateway-policy-rule{padding:12px}.harness-gateway-base-scope>div{min-width:0;width:100%;flex:auto}}

.harness-gateway-rule-list{list-style:none;padding:0;margin:0 0 16px;display:grid;gap:8px}.harness-gateway-rule-list>li{display:flex;align-items:stretch;gap:8px;min-width:0}.harness-gateway-rule-list>li>button:first-child{flex:1;min-width:0;text-align:left;white-space:normal;line-height:1.7;font-size:13px;padding:10px 12px}.harness-gateway-rule-list>li>button[aria-pressed=true]{background:var(--hep-primary-soft);border-color:var(--hep-primary);color:var(--hep-link)}.harness-gateway-rule-list>li>button:last-child{flex:none;font-size:12px}.harness-gateway-rule-decision{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.harness-gateway-rule-decision>label{display:grid;gap:8px}@media(max-width:680px){.harness-gateway-rule-decision{grid-template-columns:minmax(0,1fr)}.harness-gateway-rule-list>li{gap:4px}}
.harness-gateway-policy-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.harness-gateway-policy-actions>button{font-size:12px}.harness-gateway-business-entry{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--hep-border)}.harness-gateway-business-entry>div{flex:1;min-width:min(100%,240px)}.harness-gateway-business-entry h3{margin:0;font-size:16px}.harness-gateway-business-entry p{margin:6px 0;color:var(--hep-muted);font-size:12px}.harness-gateway-business-entry small{color:var(--hep-muted);font-size:12px}.harness-gateway-page .harness-gateway-business-entry>.harness-gateway-switch-label{width:auto;gap:12px}
.harness-gateway-source-record{display:grid;gap:8px}.harness-gateway-source-record code{overflow-wrap:anywhere}.harness-gateway-source-record small{color:var(--hep-muted);font-size:12px}


.harness-gateway-provider-card{display:grid;align-content:start;gap:20px;min-width:0}
.harness-gateway-provider-heading{align-items:start;flex-wrap:wrap;gap:16px;margin:0}
.harness-gateway-provider-heading>div:first-child{flex:1;min-width:min(100%,220px)}
.harness-gateway-provider-fields{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0}
.harness-gateway-provider-fields+.harness-gateway-provider-fields{margin-top:24px;padding-top:24px;border-top:1px solid var(--hep-border)}
.harness-gateway-provider-fields>.harness-gateway-provider-enabled{display:flex;align-items:center;gap:10px;min-width:0;min-height:24px;margin:0;font-weight:500;cursor:pointer}
.harness-gateway-provider-enabled>input[type=checkbox]{width:16px;height:16px;min-height:0;flex:none;margin:0;padding:0}
.harness-gateway-provider-inputs{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,180px);align-items:start;gap:16px 20px;min-width:0}
.harness-gateway-page .harness-gateway-field{display:grid;align-content:start;gap:8px;min-width:0;font-size:13px}
.harness-gateway-field>span{line-height:1.5}
.harness-gateway-field>input,.harness-gateway-field>select{width:100%;min-width:0;min-height:42px;margin:0;box-sizing:border-box}
.harness-gateway-field>small{color:var(--hep-muted);font-size:12px;line-height:1.7}
.harness-gateway-provider-note{font-size:12px;color:var(--hep-muted);line-height:1.7;margin:0;overflow-wrap:anywhere}
.harness-gateway-provider-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:16px;border-top:1px solid var(--hep-border)}
.harness-gateway-protocol-actions{display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap;margin:0;flex:none;max-width:100%}
.harness-gateway-provider-summary>div:first-child{flex:1}
.harness-gateway-provider-summary p{max-width:90ch;margin-bottom:0}
.harness-gateway-restriction-form{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;min-width:0;margin-top:20px}
.harness-gateway-restriction-target{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,180px);align-items:start;gap:16px 20px;min-width:0}
.harness-gateway-restriction-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
@media(max-width:680px){.harness-gateway-provider-inputs,.harness-gateway-restriction-target{grid-template-columns:minmax(0,1fr)}.harness-gateway-provider-heading{gap:12px}.harness-gateway-provider-footer{gap:12px}.harness-gateway-restriction-actions{align-items:stretch}.harness-gateway-restriction-actions>button{flex:1;min-width:min(100%,220px)}}
.harness-gateway-protocol-actions>p{flex-basis:100%;margin:0}.harness-gateway-protocol-meta{font-size:12px;color:var(--hep-muted)}.harness-gateway-protocol-document{min-width:0;overflow-wrap:anywhere}.harness-gateway-protocol-document :is(h1,h2,h3){line-height:1.5}.harness-gateway-protocol-document table{display:block;overflow-x:auto}.harness-gateway-protocol-document pre{max-height:none;overflow:auto}.harness-gateway-protocol-document code{overflow-wrap:anywhere}.harness-gateway-window .harness-gateway-static-policy{border:0;padding:0;min-width:0;margin:0}
@media(pointer:coarse){.harness-gateway-page .harness-gateway-chart-body button{min-height:44px}}
`
