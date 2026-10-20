export const businessControlStyle = `
.harness-gateway-page .harness-page-heading>div{min-width:0}
.harness-gateway-status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 16px;font-variant-numeric:tabular-nums}
.harness-gateway-status>span{display:flex;flex-direction:column;gap:4px;min-width:0;padding:14px 16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);color:var(--hep-muted);font-size:12px}
.harness-gateway-status strong{font-size:17px;font-weight:600;color:var(--hep-text);overflow-wrap:anywhere}
.harness-gateway-status small{font-size:11px}
.harness-gateway-page .harness-guide{margin:0 0 20px}
.harness-gateway-main-tabs{display:flex;gap:4px;overflow-x:auto;margin:0 0 16px;border-bottom:1px solid var(--hep-border)}
.harness-gateway-main-tabs button{flex:none;min-width:0;white-space:nowrap}
.harness-gateway-main-tabs button[aria-selected=true]{color:var(--hep-link);border-bottom:2px solid var(--hep-link);font-weight:600}
.harness-gateway-dirty-dot{color:var(--hep-link);font-size:13px}
.harness-gateway-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;min-width:0}
.harness-gateway-workspace .harness-composition-detail>h2{margin-bottom:12px}
.harness-gateway-workspace .harness-mcp-toolbar{margin-bottom:20px}
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
.harness-gateway-agent{padding:16px;margin:12px 0;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-agent>strong{grid-column:1/-1}
.harness-gateway-access-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start}
.harness-gateway-access-panel{min-width:0}
.harness-gateway-panel-heading,.harness-gateway-access-card-heading,.harness-gateway-operation-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.harness-gateway-panel-heading{margin:0 0 12px}
.harness-gateway-panel-heading h3{font-size:15px;margin:0}
.harness-gateway-panel-heading small,.harness-gateway-operation-heading small{display:block;color:var(--hep-muted);font-size:12px}
.harness-gateway-panel-heading button,.harness-gateway-operation-heading button{flex:none}
.harness-gateway-access-card,.harness-gateway-operation-card{min-width:0;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);padding:18px;margin-bottom:12px}
.harness-gateway-access-card-heading{padding-bottom:14px;border-bottom:1px solid var(--hep-border)}
.harness-gateway-access-card-heading strong,.harness-gateway-operation-heading strong{min-width:0;overflow-wrap:anywhere;font-size:14px}
.harness-gateway-access-card .harness-gateway-inline,.harness-gateway-operation-card .harness-gateway-inline{display:inline-flex;align-items:center;gap:8px;min-width:0}
.harness-gateway-access-card :is(input[type=checkbox],input[type=radio]),.harness-gateway-operation-card input[type=checkbox]{width:auto;flex:none;margin:0}
.harness-gateway-access-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;padding:16px 0}
.harness-gateway-choices{display:grid;align-content:start;gap:8px;min-width:0}
.harness-gateway-choices>span{font-size:13px;font-weight:500}
.harness-gateway-choice-list{display:flex;flex-wrap:wrap;gap:8px}
.harness-gateway-access-card .harness-gateway-option{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;padding:5px 9px;border:1px solid var(--hep-border);border-radius:6px;background:var(--hep-surface);font-size:12px;overflow-wrap:anywhere}
.harness-gateway-option[data-selected=true]{border-color:var(--hep-primary);background:var(--hep-primary-soft)}
.harness-gateway-choices small,.harness-gateway-subjects small{color:var(--hep-muted);font-size:12px}
.harness-gateway-subjects{align-content:start}
.harness-gateway-action-details{border-top:1px solid var(--hep-border)}
.harness-gateway-action-details summary{display:flex;align-items:center;gap:12px;min-width:0;padding:12px 0;cursor:pointer;list-style:none}
.harness-gateway-action-details summary::-webkit-details-marker{display:none}
.harness-gateway-action-details summary::before{content:'▸';color:var(--hep-muted)}
.harness-gateway-action-details[open] summary::before{content:'▾'}
.harness-gateway-action-details summary>span:first-child{white-space:nowrap;font-weight:500}
.harness-gateway-action-details summary small{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hep-muted)}
.harness-gateway-selection-count{display:none}
.harness-gateway-edit-label{color:var(--hep-link);font-size:12px}
.harness-gateway-action-details .harness-gateway-choice-list{padding:0 0 14px 16px}
.harness-gateway-access-card-footer{display:flex;justify-content:flex-end;border-top:1px solid var(--hep-border);padding-top:8px}
.harness-gateway-access-card-footer button{border:0;background:transparent;color:var(--hep-muted);font-size:12px}
.harness-gateway-operation-heading{align-items:flex-start;margin-bottom:16px}
.harness-gateway-operation-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
.harness-gateway-operation-fields .harness-gateway-field-wide{grid-column:1/-1}
.harness-gateway-operation-fields label{font-size:13px}
.harness-gateway-access-empty{margin:0;padding:24px;border:1px dashed var(--hep-border);border-radius:var(--hep-control-radius);color:var(--hep-muted);font-size:13px}
.harness-gateway-access-note{margin:16px 0;color:var(--hep-muted);font-size:12px}
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
.harness-gateway-workspace .harness-table-scroll{margin:16px 0;max-height:400px}
.harness-gateway-page .harness-gateway-inline{display:flex;align-items:center;gap:8px}
.harness-gateway-page .harness-gateway-inline input{width:auto}
@media(max-width:1250px){.harness-gateway-access-layout{grid-template-columns:minmax(0,1fr)}}
@media(max-width:900px){.harness-gateway-status{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:680px){.harness-gateway-identity,.harness-gateway-access-fields,.harness-gateway-operation-fields{grid-template-columns:minmax(0,1fr)}.harness-gateway-savebar{align-items:flex-start}.harness-gateway-savebar>.harness-mcp-actions{width:100%}.harness-gateway-savebar>.harness-mcp-actions button{flex:1}.harness-gateway-page .harness-page-heading{align-items:flex-start}.harness-gateway-page .harness-page-heading>button{flex-shrink:0}.harness-gateway-access-card,.harness-gateway-operation-card{padding:14px}.harness-gateway-access-card-heading{align-items:flex-start;flex-wrap:wrap}.harness-gateway-panel-heading{align-items:flex-start}.harness-gateway-operation-fields .harness-gateway-field-wide{grid-column:auto}.harness-gateway-action-details summary small{display:none}.harness-gateway-selection-count{display:inline;margin-left:auto;color:var(--hep-muted);font-size:12px}}
`
