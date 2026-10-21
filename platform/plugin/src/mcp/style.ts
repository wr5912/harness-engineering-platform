export const mcpPageTheme = `
.harness-mcp-page{width:100%;min-width:0;padding:24px var(--hep-page-padding);font-size:14px;line-height:1.6}
.harness-mcp-page .harness-page-heading>button{flex-shrink:0;white-space:nowrap}
.harness-mcp-toolbar{display:flex;align-items:center;gap:16px;margin:0 0 16px;padding:0 16px;border:1px solid var(--hep-border);border-radius:var(--hep-radius);background:var(--hep-surface)}
.harness-mcp-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.harness-mcp-toolbar>.harness-mcp-actions{margin-left:auto;flex-shrink:0}
.harness-mcp-tabs{display:flex;gap:24px;min-width:0;overflow-x:auto;scrollbar-width:thin}
.harness-platform .harness-mcp-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:12px 0;background:transparent;color:var(--hep-muted)}
.harness-platform .harness-mcp-tabs [aria-current=page]{color:var(--hep-link);border-bottom-color:var(--hep-primary);font-weight:600}
.harness-mcp-page .mcp-manager{max-width:none;width:100%;margin:0;overflow-wrap:anywhere}
.harness-mcp-page .mcp-manager .mcp-tabs{display:none}
.harness-mcp-page .mcp-manager .mcp-content{padding:0;min-height:0}
.harness-mcp-page :is(.harness-mcp-return,.harness-composition-return){margin:0 0 12px}
.harness-mcp-page :is(.harness-composition-detail,.mcp-layout>.mcp-card):focus{outline:2px solid var(--hep-primary);outline-offset:3px}
.harness-mcp-page :is(.harness-composition-detail,.mcp-layout>.mcp-card){scroll-margin-top:120px}
.harness-mcp-conflict,.harness-composition-conflict{margin:16px 0;padding:16px;border:1px solid var(--hep-border);border-left:4px solid var(--hep-link);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);overflow-wrap:anywhere}
.harness-composition-conflict h3{margin:0 0 8px}
.harness-composition-conflict p{margin:8px 0}
.harness-composition-workspace{display:grid;grid-template-columns:250px minmax(0,1fr);gap:24px;align-items:start}
.harness-composition-sidebar{min-width:0}
.harness-composition-sidebar h3{font-size:13px;color:var(--hep-muted);margin:20px 8px 12px;font-weight:500}
.harness-composition-sidebar ul{list-style:none;padding:0;margin:0}
.harness-composition-sidebar li{margin:4px 0}
.harness-composition-sidebar li button{display:block;width:100%;text-align:left;overflow-wrap:anywhere;padding:12px;border-color:transparent;background:transparent}
.harness-composition-sidebar li button[aria-current=true]{background:var(--hep-surface);border-color:var(--hep-border);color:var(--hep-link);box-shadow:0 2px 8px #16395908}
.harness-composition-sidebar small{display:block;margin-top:6px;font-size:12px;color:var(--hep-muted);line-height:1.5}
.harness-composition-status{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12px;line-height:1.5;color:var(--hep-muted)}
.harness-composition-status>span{display:inline-flex;align-items:center;gap:6px}
.harness-composition-status>span::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--hep-muted);flex:none}
.harness-composition-status>[data-state=published]::before{background:var(--hep-primary)}
.harness-composition-status>[data-state=draft]::before{background:transparent;border:1px solid currentColor}
.harness-composition-detail{min-width:0;padding:24px}
.harness-composition-detail h2{font-size:18px;margin:0 0 16px;overflow-wrap:anywhere}
.harness-composition-detail h3{font-size:16px;overflow-wrap:anywhere}
.harness-composition-detail h4{font-size:14px}
.harness-composition-detail p,.harness-composition-detail code{overflow-wrap:anywhere}
.harness-composition-detail>.harness-mcp-actions{margin:12px 0}
.harness-composition-detail [aria-label="编排版本"]{padding:4px;background:var(--hep-surface-muted);width:fit-content;border-radius:var(--hep-control-radius)}
.harness-composition-detail [aria-label="编排版本"] button{border-color:transparent;background:transparent;min-height:max(36px,var(--hep-hit-target));padding:6px 12px}
.harness-composition-detail [aria-label="编排版本"] button[aria-pressed=true]{background:var(--hep-surface);border-color:var(--hep-border);color:var(--hep-link)}
.harness-composition-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px}
.harness-composition-editor>p,.harness-composition-editor>.harness-mcp-actions,.harness-composition-editor>.harness-threat-editor,.harness-composition-editor>.harness-mcp-wide{grid-column:1/-1}
.harness-composition-editor label,.harness-composition-test>label{display:grid;gap:8px;min-width:0}
.harness-composition-editor input,.harness-composition-editor textarea,.harness-composition-editor select,.harness-composition-test input{width:100%;min-width:0;box-sizing:border-box}
.harness-composition-editor textarea{min-height:100px;resize:vertical}
.harness-composition-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:24px;align-items:start;margin:24px 0;padding-top:24px;border-top:1px solid var(--hep-border)}
.harness-composition-layout>div{min-width:0}
.harness-composition-layout>aside{min-width:0;padding:0 0 0 24px;border:0;border-left:1px solid var(--hep-border);border-radius:0;background:transparent;box-shadow:none}
.harness-composition-layout>aside>h3:first-child{margin-top:0}
.harness-composition-layout ul{padding-left:20px;font-size:13px;color:var(--hep-muted)}
.harness-mcp-flow{display:grid;gap:24px}
.harness-mcp-flow article{position:relative;min-width:0;padding:16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-mcp-flow article:not(:last-child)::after{content:'↓';position:absolute;left:24px;bottom:-23px;color:var(--hep-link);line-height:22px}
.harness-mcp-flow small{color:var(--hep-muted);font-size:12px}
.harness-mcp-flow h3{margin:8px 0}
.harness-mcp-flow h3 button{width:100%;text-align:left;background:var(--hep-surface);font-size:14px}
.harness-mcp-flow button[aria-pressed=true]{background:var(--hep-primary-soft);border-color:var(--hep-primary);color:var(--hep-link)}
.harness-mcp-flow code{font-size:12px;overflow-wrap:anywhere}
.harness-composition-test{padding-top:24px;margin-top:24px;border-top:1px solid var(--hep-border)}
.harness-composition-test>label{max-width:640px;margin:16px 0}
.harness-composition-test>.harness-mcp-actions{margin:16px 0}
.harness-composition-test details,.harness-composition-publish{padding-top:16px;margin-top:16px;border-top:1px solid var(--hep-border)}
.harness-composition-test summary{cursor:pointer;font-weight:500}
.harness-composition-detail pre{max-width:100%;overflow:auto;max-height:420px;padding:16px;border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.harness-composition-publish p{color:var(--hep-muted);font-size:13px}
.harness-composition-trace{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.harness-composition-trace th,.harness-composition-trace td{padding:12px;text-align:left;overflow-wrap:anywhere}
.harness-composition-trace th{font-weight:500;color:var(--hep-muted);font-size:12px;background:var(--hep-surface-muted)}
@media(max-width:1200px){.harness-composition-workspace{grid-template-columns:220px minmax(0,1fr)}.harness-composition-layout{grid-template-columns:minmax(0,1fr)}.harness-composition-layout>aside{border-left:0;border-top:1px solid var(--hep-border);padding:20px 0 0}}
@media(max-width:900px){.harness-composition-workspace{grid-template-columns:minmax(0,1fr)}.harness-composition-sidebar ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px}.harness-composition-sidebar .harness-mcp-actions{margin-bottom:16px}}
@media(max-width:760px){.harness-mcp-return{display:none}}
@media(max-width:680px){.harness-mcp-page{padding-top:16px;padding-bottom:16px}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'title action' 'description description';align-items:start;column-gap:12px;row-gap:4px;margin-bottom:16px}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading>div{display:contents}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading h1{grid-area:title;min-width:0}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading p{grid-area:description}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading>button{grid-area:action;align-self:start}.harness-mcp-toolbar{gap:0;flex-wrap:wrap}.harness-mcp-tabs{gap:20px;flex-wrap:nowrap;white-space:nowrap;width:100%}.harness-mcp-toolbar>.harness-mcp-actions:not(:empty){width:100%;justify-content:flex-end;padding:0 0 12px}.harness-mcp-page .mcp-manager .mcp-service-layout{gap:8px}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker{align-items:center}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker label{gap:0;font-size:0;line-height:0}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker select{font-size:14px;line-height:1.4}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker>button{display:none}.harness-composition-detail{padding:16px}.harness-composition-editor{grid-template-columns:minmax(0,1fr)}.harness-composition-trace thead{display:none}.harness-composition-trace tbody{display:block}.harness-composition-trace tr{display:block;padding:12px 0;border-bottom:1px solid var(--hep-border)}.harness-composition-trace td{display:grid;grid-template-columns:52px minmax(0,1fr);gap:12px;padding:4px 0;border:0}.harness-composition-trace td::before{content:attr(data-label);color:var(--hep-muted);font-size:12px}}
`
