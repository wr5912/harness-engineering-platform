export const instanceTheme = `
.harness-instances-page{container:hep-instances / inline-size;width:100%;min-width:0;padding:24px var(--hep-page-padding);color:var(--hep-text);font-size:14px;line-height:1.6}
.harness-instances-page .instance-page-heading{align-items:center;flex-wrap:wrap;gap:16px;margin-bottom:24px}
.instance-page-heading p{margin:0}
.instance-summary-stats{margin-top:8px;color:var(--hep-muted);font-size:13px;font-variant-numeric:tabular-nums}
.instance-filter-panel,.instance-list-panel,.instance-panel{min-width:0;border:1px solid var(--hep-border);border-radius:var(--hep-radius);background:var(--hep-surface)}
.instance-create-heading,.instance-filter-row,.instance-list-heading,.instance-detail-header,.instance-embed-heading,.instance-code-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.instance-source-picker{display:grid;gap:16px;min-width:0}
.instance-source-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.instance-source-advanced{margin-top:14px;padding:4px 0;border:0;background:transparent;color:var(--hep-link);cursor:pointer;text-align:left}
.instance-field-hint{color:var(--hep-muted);font-size:12px}
.instance-source-verdict{display:grid;gap:4px;padding:12px 14px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);font-size:13px}
.instance-source-verdict[data-state=pending]{border-color:color-mix(in srgb,var(--hep-warning) 40%,var(--hep-border));background:color-mix(in srgb,var(--hep-warning) 9%,var(--hep-surface))}
.instance-source-verdict[data-state=passed]{border-color:color-mix(in srgb,var(--hep-success) 40%,var(--hep-border));background:color-mix(in srgb,var(--hep-success) 8%,var(--hep-surface))}
.instance-source-verdict[data-state=failed]{border-color:color-mix(in srgb,var(--hep-danger) 40%,var(--hep-border));background:color-mix(in srgb,var(--hep-danger) 8%,var(--hep-surface))}
.instance-source-verdict[data-state=unavailable]{border-color:var(--dsw-alias-danger-text,#c24140)}
.instance-source-verdict span{color:var(--hep-muted)}
.instance-model-panel{margin-top:20px;padding:16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.instance-model-panel .instance-source-heading{margin-bottom:8px}
.instance-model-panel .instance-muted{margin:6px 0 12px}
.instance-model-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px;margin-top:12px}
.instance-model-warning{margin:12px 0 0;color:var(--dsw-alias-danger-text,#c24140);overflow-wrap:anywhere}
.instance-model-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:16px}
.instance-field,.instance-filter-field,.instance-search-field{display:grid;gap:8px;min-width:0}
.instance-field-input{box-sizing:border-box;width:100%;min-width:0;min-height:max(40px,var(--hep-hit-target))}
.instance-search-field,.instance-filter-field{gap:0;font-size:0;line-height:0}
.instance-search-field .instance-field-input,.instance-filter-field .instance-field-input{font-size:14px;line-height:1.4}
.instance-filter-panel{padding:20px;margin-bottom:0;border-radius:var(--hep-radius) var(--hep-radius) 0 0}
.instance-filter-row{align-items:flex-end;justify-content:flex-start;gap:12px}
.instance-filter-field{min-width:min(100%,160px)}
.instance-search-field{flex:0 1 300px;min-width:min(100%,220px)}
.instance-filter-count{margin-left:auto;align-self:center;color:var(--hep-muted);font-size:13px;white-space:nowrap}
.instance-source-filter{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px;overflow-wrap:anywhere}
.instance-batch-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--hep-border)}
.instance-selection-notice{color:var(--dsw-alias-danger-text,#c24140)}
.instance-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.harness-instances-page .instance-button{min-height:max(40px,var(--hep-hit-target));padding:8px 12px;line-height:1.4}
.instance-list-panel{overflow:hidden;border-top:0;border-radius:0 0 var(--hep-radius) var(--hep-radius)}
.instance-list-heading{padding:12px 20px;border-top:1px solid var(--hep-border);font-size:12px}
.instance-list-heading strong{font-weight:500;color:var(--hep-muted)}
.instance-table-wrap{max-width:100%;overflow-x:auto}
.instance-table{width:100%;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}
.harness-instances-page .instance-list-th{text-align:left;padding:12px 16px;border-bottom:1px solid var(--hep-border);font-size:12px;white-space:nowrap;font-weight:500;color:var(--hep-muted);background:var(--hep-surface-muted)}
.harness-instances-page .instance-list-td{padding:18px 16px;border-bottom:1px solid var(--hep-border);font-size:14px;vertical-align:middle;overflow-wrap:anywhere}
.instance-table tbody tr{transition:background var(--hep-motion-fast) var(--hep-ease)}
.instance-table tbody tr[data-current=true],.instance-table tbody tr[data-selected=true]{background:var(--hep-primary-soft)}
.instance-table tbody tr:last-child td{border-bottom:0}
.instance-name{font-weight:600}
.instance-source{color:var(--hep-muted)}
.instance-source strong{display:block;color:var(--hep-text);font-weight:500;overflow-wrap:anywhere}
.instance-source small{display:block;margin-top:3px;font-size:12px;overflow-wrap:anywhere}
.instance-access-note{margin-top:6px}
.harness-instances-page input[type=checkbox]{width:16px;height:16px;accent-color:var(--hep-primary);cursor:pointer}
.harness-instances-page .instance-empty-list{text-align:center;padding:48px 20px;color:var(--hep-muted)}
.instance-th,.instance-td{padding:12px;border-bottom:1px solid var(--hep-border);text-align:left;vertical-align:top;overflow-wrap:anywhere;font-size:13px}
.instance-th{font-weight:500;color:var(--hep-muted);background:var(--hep-surface-muted)}
.instance-error{margin-bottom:16px;padding:12px 16px;border-radius:var(--hep-control-radius);color:var(--dsw-alias-danger-text,#c24140);background:color-mix(in srgb,var(--dsw-alias-danger-text,#c24140) 7%,var(--hep-surface));overflow-wrap:anywhere}
.harness-instance-detail,.instance-detail-route-notice{scroll-margin-top:120px}
.instance-panel{margin-top:24px}
.instance-detail-header{padding:24px}
.instance-heading-content{min-width:0}
.instance-detail-title{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px}
.instance-detail-title h2{margin:0;font-size:18px;overflow-wrap:anywhere}
.instance-state-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600;white-space:nowrap;color:var(--hep-muted);background:color-mix(in srgb,currentColor 8%,transparent)}
.instance-state-badge[data-state=running]{color:var(--dsw-alias-success-text,#167a52)}
.instance-state-badge:is([data-state=failed],[data-state=unknown]),.instance-state-badge:not([data-state]){color:var(--dsw-alias-danger-text,#c24140)}
.instance-detail-notice{margin:0 24px 16px;color:var(--dsw-alias-danger-text,#c24140)}
.instance-detail-tabs{display:flex;gap:24px;padding:0 24px;border-bottom:1px solid var(--hep-border);overflow-x:auto}
.harness-instances-page .instance-detail-tab{border:0;border-bottom:2px solid transparent;border-radius:0;padding:12px 0;background:transparent;color:var(--hep-muted);white-space:nowrap}
.harness-instances-page .instance-detail-tab[aria-selected=true]{border-bottom-color:var(--hep-primary);color:var(--hep-link);font-weight:600}
.instance-detail-body{padding:24px;min-width:0}
.instance-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:20px 24px;margin:0}
.instance-fact{min-width:0;padding-bottom:16px;border-bottom:1px solid var(--hep-border)}
.instance-fact-value{margin:6px 0 0;overflow-wrap:anywhere}
.instance-copy-id{display:block;margin-top:8px}
.instance-fact-value small{display:block;margin-top:4px}
.instance-muted{color:var(--hep-muted);font-size:13px;line-height:1.65}
.instance-session-note{margin-top:24px;line-height:1.7;overflow-wrap:anywhere}
.instance-session-note p{margin:6px 0 0}
.instance-detail-fold{border-top:1px solid var(--hep-border);padding-top:16px;margin-top:20px}
.instance-fold-title{cursor:pointer;font-weight:600}
.instance-mount-scroll{overflow-x:auto;margin-top:12px}
.instance-mount-table{width:100%;border-collapse:collapse;table-layout:fixed}
.instance-run-list{list-style:none;padding:0;margin:12px 0 0}
.instance-run-item{display:grid;gap:4px;padding:12px 0;overflow-wrap:anywhere}
.instance-run-item+li{border-top:1px solid var(--hep-border)}
.harness-instances-page .instance-run-link{border:0;padding:0;min-height:max(32px,var(--hep-hit-target));text-align:left;color:var(--hep-link);background:transparent;overflow-wrap:anywhere;justify-self:start}
.instance-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.instance-embed-heading{align-items:start}
.instance-section-title{font-size:16px;margin:0}
.instance-code-box{border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);overflow:hidden;margin-top:16px}
.instance-code-heading{padding:12px 16px;border-bottom:1px solid var(--hep-border);font-size:13px;background:var(--hep-surface-muted)}
.instance-embed-code{margin:0;padding:20px;max-height:320px;overflow:auto;font-size:13px;line-height:1.7;color:var(--hep-text);background:var(--hep-surface);white-space:pre}
.instance-embed-empty{padding:40px 24px;margin-top:16px;border:1px dashed var(--hep-border);border-radius:var(--hep-control-radius);text-align:center;color:var(--hep-muted);background:var(--hep-surface-muted)}
.instance-embed-notes{padding-left:20px;line-height:1.8}
.instance-embed-notes li+li{margin-top:8px}
.instance-log-content{margin:0;max-height:420px;min-height:160px;overflow:auto;padding:20px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);font-size:13px;line-height:1.7;background:var(--hep-surface-muted);white-space:pre}
.instance-dialog{box-sizing:border-box;width:min(640px,calc(100vw - 32px));max-height:85dvh;padding:0;border:1px solid var(--hep-border);border-radius:var(--hep-radius);color:var(--hep-text);background:var(--hep-surface);box-shadow:var(--hep-shadow);overflow:hidden}
.instance-dialog[open]{display:flex;flex-direction:column;animation:hep-enter var(--hep-motion) var(--hep-ease)}
.instance-dialog::backdrop{background:#102c4a66}
.instance-dialog-heading,.instance-dialog-actions{flex:none;padding:20px 24px}
.instance-dialog-heading{border-bottom:1px solid var(--hep-border)}
.instance-dialog-heading h2{margin:0;font-size:18px}
.instance-dialog-heading p{margin:4px 0 0;color:var(--hep-muted);font-size:13px}
.instance-create-dialog{width:min(660px,calc(100vw - 32px))}
.instance-create-heading,.instance-action-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.instance-dialog-close{flex:none;min-width:36px;min-height:36px;border:0;background:transparent;color:var(--hep-text);font-size:27px;line-height:1;cursor:pointer}
.instance-dialog-content{padding:16px 24px;min-height:0;overflow:auto;overscroll-behavior:contain}
.instance-create-content{display:grid;gap:18px;padding-top:22px;padding-bottom:22px}
.instance-create-content>.instance-field{margin:0}
.instance-create-model{display:grid;gap:8px}
.instance-create-model-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.instance-create-model-heading .instance-button{padding:5px 9px;font-size:12px}
.instance-create-model .instance-field-hint{margin:0}
.instance-create-model .instance-model-fields{margin:0;gap:10px}
.instance-create-model .instance-field{margin:0}
.instance-create-advanced{border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.instance-create-advanced summary{padding:12px 14px;cursor:pointer;color:var(--hep-muted)}
.instance-create-advanced-body{display:grid;gap:12px;padding:0 14px 14px}
.instance-create-impact{margin:0;color:var(--hep-muted);font-size:13px}
.instance-dialog-actions{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--hep-border)}
.instance-danger-button{min-height:max(40px,var(--hep-hit-target));padding:8px 16px;border:1px solid #a92830;border-radius:var(--hep-control-radius);background:#a92830;color:#fff;cursor:pointer}
.instance-danger-button:hover{filter:brightness(.95)}
.instance-pre{max-width:100%;overflow:auto;padding:16px;border-radius:var(--hep-control-radius);color:inherit;background:var(--hep-surface-muted);font-size:13px;line-height:1.6}
.instance-preview-summary{margin:0 0 6px;font-weight:600}
.instance-preview-items,.instance-receipt-items{display:grid;gap:12px;margin-top:14px}
.instance-preview-item{padding:14px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);min-width:0}
.instance-preview-item[data-ok=false]{border-color:var(--dsw-alias-danger-text,#c24140)}
.instance-preview-item h3{margin:0 0 12px;font-size:15px;overflow-wrap:anywhere}
.instance-preview-item dl{display:grid;gap:8px;margin:0}
.instance-preview-item dl>div{display:grid;grid-template-columns:80px minmax(0,1fr);gap:10px}
.instance-preview-item dt{color:var(--hep-muted)}
.instance-preview-item dd{margin:0;overflow-wrap:anywhere}
.instance-preview-facts dd .instance-muted{display:block;margin-top:2px}
.instance-preview-item details{margin-top:12px}
.instance-preview-item summary{cursor:pointer;color:var(--hep-link)}
.instance-preview-item .instance-pre{max-height:260px;margin-bottom:0}
.instance-reference-preview{padding:0;border:0}
.instance-reference-card{padding:18px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.instance-reference-card h3{font-size:16px}
.instance-reference-card dl>div{grid-template-columns:110px minmax(0,1fr)}
.instance-preview-warning{display:grid;gap:2px;margin-top:16px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--hep-warning) 40%,var(--hep-border));border-radius:var(--hep-control-radius);background:color-mix(in srgb,var(--hep-warning) 12%,var(--hep-surface));color:var(--hep-warning)}
.instance-preview-impact{margin-top:18px}
.instance-preview-impact h4{margin:0 0 10px;font-size:14px}
.instance-preview-impact ul{margin:0;padding-left:22px;color:var(--hep-muted)}
.instance-preview-impact li+li{margin-top:6px}
.instance-preview-technical{margin-top:18px;padding:12px 14px;border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.instance-preview-technical summary{color:var(--hep-muted)!important}
.instance-receipt-ok,.instance-receipt-bad{padding:10px 0;overflow-wrap:anywhere}
.instance-receipt-items>div+div{border-top:1px solid var(--hep-border)}
.instance-receipt-ok{color:var(--dsw-alias-success-text,#167a52)}
.instance-receipt-bad{color:var(--dsw-alias-danger-text,#c24140)}
@container hep-instances (max-width:1000px){
  .instance-table{min-width:970px}
  .instance-table .instance-empty-list{text-align:left}
}
@media(max-width:680px){
  .harness-instances-page{padding-top:16px;padding-bottom:16px}
  .harness-instances-page .instance-page-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'title action' 'description description' 'stats stats';align-items:start;column-gap:12px;row-gap:4px}
  .instance-page-heading>div{display:contents}
  .instance-page-heading h1{grid-area:title;min-width:0}
  .instance-page-heading p{grid-area:description}
  .instance-page-heading .instance-summary-stats{grid-area:stats;margin-top:0}
  .instance-page-heading>button{grid-area:action;align-self:start}
  .instance-filter-panel,.instance-detail-header,.instance-detail-body{padding:16px}
  .instance-list-heading{padding:16px}
  .instance-detail-tabs{padding:0 16px;gap:20px}
  .instance-detail-notice{margin:0 16px 12px}
  .instance-search-field{flex:1 1 100%}
  .instance-filter-count{flex:1;text-align:right}
  .instance-detail-grid{grid-template-columns:minmax(0,1fr)}
  .instance-detail-header>.instance-actions{width:100%}
  .instance-model-actions>*{flex:1 1 150px}
  .instance-dialog-heading,.instance-dialog-actions{padding:16px}
  .instance-dialog-content{padding:12px 16px}
  .instance-dialog-actions{flex-wrap:wrap}
  .instance-dialog-actions button{flex:1 1 150px}
  .instance-preview-item dl>div{grid-template-columns:minmax(0,1fr);gap:0}
  .instance-reference-card dl>div{grid-template-columns:100px minmax(0,1fr);gap:8px}
}
@media(pointer:coarse){.harness-instances-page button,.harness-instances-page .instance-field-input{min-height:44px}.harness-instances-page input[type=checkbox]{width:20px;height:20px}}
@media(prefers-reduced-motion:reduce){.instance-dialog[open]{animation:none}}
`
