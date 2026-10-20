export const businessControlStyle = `
.harness-gateway-page .harness-page-heading>div{min-width:0}
.harness-gateway-status{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0 0 16px;color:var(--hep-muted);font-size:13px;line-height:1.6;font-variant-numeric:tabular-nums}
.harness-gateway-status>span{display:inline-flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.harness-gateway-status strong{font-size:inherit;font-weight:600;color:var(--hep-text)}
.harness-gateway-page .harness-guide{margin:0 0 20px}
.harness-gateway-workspace{display:grid;gap:20px;min-width:0}
.harness-gateway-workspace .harness-composition-detail>h2{margin-bottom:12px}
.harness-gateway-workspace .harness-mcp-toolbar{margin-bottom:20px}
.harness-gateway-config{display:block}
.harness-gateway-savebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid var(--hep-border)}
.harness-gateway-savebar>div{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.harness-gateway-savebar small,.harness-gateway-description{font-size:12px;color:var(--hep-muted)}
.harness-gateway-config fieldset{border:0;min-width:0;margin:0;padding:0}
.harness-gateway-config legend{font-size:16px;font-weight:600;padding:0;margin-bottom:8px}
.harness-gateway-config fieldset>p:first-of-type{margin:0 0 20px;color:var(--hep-muted);font-size:13px}
.harness-gateway-agent{padding:16px;margin:12px 0;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-gateway-agent>strong{grid-column:1/-1}
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
.harness-gateway-runtime-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
.harness-gateway-runtime-layout>aside{min-width:0;border-top:1px solid var(--hep-border);padding-top:20px}
.harness-gateway-workspace .harness-table-scroll{margin:16px 0;max-height:400px}
.harness-gateway-operation-table{min-width:700px}
.harness-gateway-page .harness-gateway-inline{display:flex;align-items:center;gap:8px}
.harness-gateway-page .harness-gateway-inline input{width:auto}
@media(min-width:1200px){.harness-gateway-workspace{grid-template-columns:minmax(0,1.45fr) minmax(360px,.95fr);align-items:start}}
@media(max-width:680px){.harness-gateway-identity{grid-template-columns:minmax(0,1fr)}.harness-gateway-savebar{align-items:flex-start}.harness-gateway-savebar>.harness-mcp-actions{width:100%}.harness-gateway-savebar>.harness-mcp-actions button{flex:1}.harness-gateway-page .harness-page-heading{align-items:flex-start}.harness-gateway-page .harness-page-heading>button{flex-shrink:0}}
`
