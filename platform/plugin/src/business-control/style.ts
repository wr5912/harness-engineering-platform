export const businessControlStyle = `
.harness-platform[data-page=gateway] .harness-breadcrumb{display:none}
.harness-gateway-page .harness-page-heading{margin:0 0 28px}
.harness-gateway-page .harness-page-heading>div{min-width:0}
.harness-gateway-page .harness-page-heading h1{margin:0 0 4px;font-size:30px}
.harness-gateway-page .harness-page-heading p{font-size:14px}
.harness-gateway-page .harness-gateway-refresh{display:inline-flex;align-items:center;gap:8px;border-color:var(--hep-border);background:var(--hep-surface);font-weight:500}
.harness-gateway-status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:0 0 24px;font-variant-numeric:tabular-nums}
.harness-gateway-status>span{display:flex;flex-direction:column;justify-content:space-between;gap:8px;min-width:0;min-height:132px;padding:18px 20px;border:1px solid var(--hep-border);border-radius:var(--hep-radius);background:var(--hep-surface);color:var(--hep-muted);font-size:13px}
.harness-gateway-stat-label{display:flex;align-items:center;justify-content:space-between;gap:8px}
.harness-gateway-stat-label svg{flex:none;color:var(--hep-muted)}
.harness-gateway-status strong{font-size:24px;font-weight:600;color:var(--hep-text);line-height:1.25;overflow-wrap:anywhere}
.harness-gateway-status strong>small{font-size:14px;color:var(--hep-muted)}
.harness-gateway-status strong.harness-gateway-warning-text{color:var(--hep-warning)}
.harness-gateway-status>span>small{font-size:12px;line-height:1.5}
.harness-gateway-text-button{border:0;padding:0;background:transparent;color:var(--hep-link);font:inherit;line-height:inherit;text-align:left;text-decoration:none;cursor:pointer}
.harness-gateway-text-button:hover{text-decoration:underline}
.harness-gateway-mobile-status{display:none}
.harness-gateway-scope{margin:0 0 8px;font-size:13px;color:var(--hep-text)}
.harness-gateway-page .harness-guide{margin:0 0 20px;color:var(--hep-muted);font-size:13px}
.harness-gateway-page .harness-guide summary{width:fit-content;cursor:pointer;color:var(--hep-link)}
.harness-gateway-page .harness-guide p{margin:8px 0 0;max-width:85ch}
.harness-gateway-main-tabs{display:flex;gap:24px;overflow-x:auto;margin:0;border-bottom:0;border-radius:var(--hep-radius) var(--hep-radius) 0 0}
.harness-gateway-main-tabs button{flex:none;min-width:0;white-space:nowrap}
.harness-gateway-main-tabs button[aria-selected=true]{color:var(--hep-link);border-bottom:2px solid var(--hep-link);font-weight:600}
.harness-gateway-dirty-dot{color:var(--hep-link);font-size:13px}
.harness-gateway-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;min-width:0}
.harness-gateway-workspace>.harness-card{border-radius:0 0 var(--hep-radius) var(--hep-radius)}
.harness-gateway-workspace .harness-composition-detail{padding:28px 32px}
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
.harness-gateway-overview-table td details{font-size:11px;color:var(--hep-muted)}
.harness-gateway-overview-table td details summary{cursor:pointer}
.harness-gateway-overview-table td code{display:block;max-width:150px;overflow-wrap:anywhere}
.harness-gateway-overview-table td .harness-gateway-text-button{white-space:nowrap}
.harness-gateway-badge{display:inline-block;padding:4px 8px;border-radius:6px;white-space:nowrap}
.harness-gateway-badge[data-state=success]{color:var(--hep-success);background:color-mix(in srgb,var(--hep-success) 10%,var(--hep-surface))}
.harness-gateway-badge[data-state=pending]{color:var(--hep-warning);background:color-mix(in srgb,var(--hep-warning) 10%,var(--hep-surface))}
.harness-gateway-badge[data-state=blocked]{color:var(--hep-danger);background:color-mix(in srgb,var(--hep-danger) 10%,var(--hep-surface))}
.harness-gateway-identity-table{margin:4px 0 0}
.harness-gateway-identity-table td code{display:inline;max-width:none}
.harness-gateway-identity-table td details code{display:block;max-width:200px}
.harness-gateway-mobile-identity-details{display:none}
.harness-gateway-risk-summary .harness-gateway-risk-notice{margin:8px 0 24px}
.harness-gateway-risk-facts{display:grid;grid-template-columns:140px minmax(0,1fr);gap:14px 24px;margin:0;line-height:1.6;font-size:13px}
.harness-gateway-risk-facts dt{color:var(--hep-muted)}
.harness-gateway-risk-facts dd{margin:0;overflow-wrap:anywhere}
.harness-gateway-risk-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:24px 0 4px}
.harness-gateway-risk-actions>details{position:relative;min-width:0}
.harness-gateway-risk-actions>details>summary{display:inline-flex;align-items:center;min-height:36px;padding:7px 12px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);cursor:pointer;list-style:none;font-size:13px}
.harness-gateway-risk-actions>details>summary::-webkit-details-marker{display:none}
.harness-gateway-risk-actions>details[open]{width:100%}
.harness-gateway-risk-actions .harness-gateway-list{max-height:320px;overflow:auto}
.harness-gateway-config-details{margin-top:28px;padding-top:18px;border-top:1px solid var(--hep-border)}
.harness-gateway-config-details>summary{width:fit-content;color:var(--hep-link);font-size:13px;cursor:pointer}
.harness-gateway-config-details[open]>summary{margin-bottom:20px}
.harness-gateway-config-details:has(>summary:focus-visible){outline:2px solid var(--hep-focus);outline-offset:3px}
.harness-gateway-overview-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0}
.harness-gateway-overview-cards article{min-width:0;padding:18px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-overview-cards h3{margin:0 0 12px;font-size:15px}.harness-gateway-overview-cards strong{font-size:13px}.harness-gateway-overview-cards p{margin:10px 0 0;color:var(--hep-muted);font-size:12px}
.harness-gateway-overview-cards strong.harness-gateway-applied{display:block;padding:12px;border-radius:6px;color:var(--hep-success);background:color-mix(in srgb,var(--hep-success) 9%,var(--hep-surface))}
.harness-gateway-overview-cards summary{margin-top:12px;color:var(--hep-link);cursor:pointer;font-size:12px}
.harness-gateway-config{display:block}
.harness-gateway-savebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid var(--hep-border)}
.harness-gateway-savebar>div{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.harness-gateway-savebar small,.harness-gateway-description{font-size:12px;color:var(--hep-muted)}
.harness-gateway-description-card{padding:16px 18px;margin:0 0 20px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-description-card>p{margin:8px 0;overflow-wrap:anywhere}
.harness-gateway-description-card details{margin-top:10px}
.harness-gateway-description-card li{margin:8px 0;overflow-wrap:anywhere}
.harness-gateway-description-card li p{margin:3px 0;color:var(--hep-muted);font-size:12px}
.harness-gateway-probe{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.harness-gateway-probe small{color:var(--hep-muted)}
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
.harness-gateway-access-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 24px;margin:0 0 24px}
.harness-gateway-access-fields>label,.harness-gateway-access-fields>.harness-gateway-choices{display:grid;align-content:start;gap:8px;min-width:0;font-weight:600}
.harness-gateway-access-fields input,.harness-gateway-access-fields select{min-height:46px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);font-weight:400}
.harness-gateway-access-fields input[readonly]{background:var(--hep-surface-muted)}
.harness-gateway-access-fields small{font-weight:400}
.harness-gateway-switch-row,.harness-gateway-action-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 0;border-bottom:1px solid var(--hep-border);margin:0 0 24px}
.harness-gateway-switch-row{display:grid;grid-template-columns:minmax(0,1fr);gap:5px}
.harness-gateway-page .harness-gateway-switch-label{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;font-size:14px;font-weight:600;cursor:pointer}
.harness-gateway-action-row>div{display:grid;gap:5px}
.harness-gateway-action-row strong{font-size:14px}
.harness-gateway-switch-row small,.harness-gateway-action-row small{color:var(--hep-muted);font-size:12px}
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
.harness-gateway-service-picker{position:relative;min-width:0;font-weight:400}
.harness-gateway-service-picker summary{display:flex;align-items:center;min-height:46px;padding:9px 12px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);cursor:pointer;list-style:none;overflow-wrap:anywhere}
.harness-gateway-service-picker summary::-webkit-details-marker{display:none}
.harness-gateway-service-picker summary::after{content:'⌄';margin-left:auto;padding-left:8px;font-size:18px}
.harness-gateway-service-picker[open] summary{border-color:var(--hep-primary)}
.harness-gateway-service-options{position:absolute;z-index:2;top:calc(100% + 4px);left:0;right:0;display:grid;gap:10px;padding:12px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);box-shadow:var(--hep-shadow)}
.harness-gateway-service-options .harness-gateway-choice-list{max-height:180px;overflow:auto}
.harness-gateway-service-options input,.harness-gateway-action-row input,.harness-gateway-agent-tools input{width:auto;min-height:0;margin:0}
.harness-gateway-action-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 20px}
.harness-gateway-action-row>details{grid-column:1/-1}
.harness-gateway-action-details summary{width:fit-content;cursor:pointer;color:var(--hep-muted);font-size:12px}
.harness-gateway-action-details .harness-gateway-choice-list{padding:12px 0}
.harness-gateway-agent-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 24px}
.harness-gateway-agent-tools>button{border:0;padding:0;background:transparent;color:var(--hep-link);font-size:12px}
.harness-gateway-operation-list{min-width:0}
.harness-gateway-operation-list-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.harness-gateway-operation-list-heading h3{margin:0;font-size:14px}
.harness-gateway-operation-list-heading button{border:0;padding:0;background:transparent;color:var(--hep-link);font-size:12px}
.harness-gateway-operation-card{min-width:0;margin:0 0 8px;border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-operation-card summary{padding:12px 16px;color:var(--hep-muted);font-size:13px;cursor:pointer;overflow-wrap:anywhere}
.harness-gateway-operation-card .harness-gateway-operation-fields{padding:0 16px 16px}
.harness-gateway-operation-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
.harness-gateway-operation-fields .harness-gateway-field-wide{grid-column:1/-1}
.harness-gateway-operation-fields label{font-size:13px}
.harness-gateway-operation-fields input[type=checkbox]{width:auto}
.harness-gateway-operation-fields button{justify-self:start}
.harness-gateway-access-empty{margin:0;padding:24px;border:1px dashed var(--hep-border);border-radius:var(--hep-control-radius);color:var(--hep-muted);font-size:13px}
.harness-gateway-access-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:28px 0 0}
.harness-gateway-access-footer details{max-width:70%;color:var(--hep-muted);font-size:12px}
.harness-gateway-access-footer summary{cursor:pointer}
.harness-gateway-access-footer p{margin:8px 0 0}
.harness-gateway-access-advanced{border-top:1px solid var(--hep-border);padding-top:14px}
.harness-gateway-access-advanced summary{cursor:pointer;color:var(--hep-muted);font-size:13px}
.harness-gateway-identity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.harness-gateway-identity>section{min-width:0;overflow-wrap:anywhere}
.harness-gateway-identity>section>p{color:var(--hep-muted);font-size:13px}
.harness-gateway-identity .harness-gateway-agent{grid-template-columns:minmax(0,1fr)}
.harness-gateway-empty{padding:20px;border:1px dashed var(--hep-border);border-radius:var(--hep-control-radius);margin:0 0 20px}
.harness-gateway-empty p{margin:6px 0 12px;color:var(--hep-muted)}
.harness-gateway-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px;margin:16px 0}
.harness-gateway-facts article{padding:16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-facts h4{margin:0 0 8px}
.harness-gateway-facts p{margin:6px 0;font-size:12px;color:var(--hep-muted)}
.harness-gateway-list{list-style:none;padding:0;margin:12px 0}
.harness-gateway-list>li{padding:12px 0;border-bottom:1px solid var(--hep-border);overflow-wrap:anywhere}
.harness-gateway-list>li:last-child{border-bottom:0}
.harness-gateway-list p{margin:6px 0;font-size:13px}
.harness-gateway-auxiliary{margin-top:24px;border-top:1px solid var(--hep-border);padding-top:16px}
.harness-gateway-auxiliary summary{cursor:pointer;font-size:13px;color:var(--hep-muted)}
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
@media(min-width:681px) and (max-width:799px){.harness-gateway-status{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:680px){
.harness-gateway-page{display:flex;flex-direction:column;padding-bottom:100px}
.harness-gateway-status-desktop{display:none}
.harness-gateway-mobile-status{display:block;order:1;margin:0 0 16px;padding:16px;border:1px solid var(--hep-border);border-radius:var(--hep-radius);background:var(--hep-surface)}
.harness-gateway-mobile-status>div{display:flex;align-items:center;justify-content:space-between;gap:8px}
.harness-gateway-mobile-status strong{font-size:14px;line-height:1.45}
.harness-gateway-mobile-status p{margin:12px 0 0;color:var(--hep-muted);font-size:12px}
.harness-gateway-risk-badge{flex:none;padding:5px 8px;border-radius:6px;color:var(--hep-warning);background:color-mix(in srgb,var(--hep-warning) 10%,var(--hep-surface));font-size:12px}
.harness-gateway-main-tabs{order:2;overflow-x:auto}
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
.harness-gateway-scope{order:5;margin:4px 0 8px}
.harness-gateway-page .harness-guide{order:6}
.harness-gateway-overview-cards{grid-template-columns:minmax(0,1fr)}
.harness-gateway-identity-table th:nth-child(n+3),.harness-gateway-identity-table td:nth-child(n+3){display:none}
.harness-gateway-identity-table td{vertical-align:top;overflow-wrap:anywhere}
.harness-gateway-mobile-identity-details{display:block;margin-top:8px}
.harness-gateway-mobile-identity-details p{margin:6px 0}
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
.harness-gateway-access-footer details{max-width:none}
.harness-gateway-access-footer>button{width:100%}
}
.harness-gateway-preview-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:#10283e72}
.harness-gateway-preview-dialog{width:min(620px,100%);max-height:calc(100dvh - 40px);overflow:auto;padding:24px;border:1px solid var(--hep-border);border-radius:var(--hep-radius);background:var(--hep-surface);box-shadow:0 16px 48px #10283e38;color:var(--hep-text)}
.harness-gateway-preview-dialog:focus{outline:none}
.harness-gateway-preview-dialog h2{margin:0 0 6px;font-size:20px}
.harness-gateway-preview-dialog>p{margin:0 0 16px;color:var(--hep-muted);font-size:13px}
.harness-gateway-preview-dialog dl{display:grid;grid-template-columns:125px minmax(0,1fr);gap:12px;margin:0;padding:16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);font-size:13px}
.harness-gateway-preview-dialog dt{color:var(--hep-muted)}
.harness-gateway-preview-dialog dd{min-width:0;margin:0;overflow-wrap:anywhere}
.harness-gateway-preview-dialog dd p{margin:0 0 8px}
.harness-gateway-preview-dialog dd p:last-child{margin-bottom:0}
.harness-gateway-preview-dialog .harness-gateway-preview-warning{margin:16px 0;padding:12px;border-radius:var(--hep-control-radius);color:var(--hep-warning);background:color-mix(in srgb,var(--hep-warning) 9%,var(--hep-surface))}
.harness-gateway-preview-actions{display:flex;justify-content:flex-end;gap:10px}
@media(max-width:680px){.harness-gateway-preview-dialog{padding:18px}.harness-gateway-preview-dialog dl{grid-template-columns:minmax(0,1fr);gap:4px}.harness-gateway-preview-dialog dd{margin-bottom:10px}.harness-gateway-preview-actions button{flex:1}}
`
