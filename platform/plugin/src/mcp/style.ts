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
.harness-composition-sidebar li button[aria-current=true]{background:var(--hep-primary-soft);border-color:transparent;color:var(--hep-link);box-shadow:none}
.harness-composition-sidebar small{display:block;margin-top:4px;font-size:12px;color:var(--hep-muted);line-height:1.5}
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
.harness-composition-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:16px 24px}
.harness-composition-editor>p,.harness-composition-editor>.harness-mcp-actions,.harness-composition-editor>.harness-threat-editor,.harness-composition-editor>.harness-mcp-wide{grid-column:1/-1}
.harness-composition-editor label,.harness-composition-test>label{display:grid;align-content:start;gap:8px;min-width:0}
.harness-composition-editor input:not([type=checkbox]):not([type=radio]),.harness-composition-editor textarea,.harness-composition-editor select,.harness-composition-test input{width:100%;min-width:0;box-sizing:border-box}
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
.harness-composition-test details{padding-top:16px;margin-top:16px;border-top:1px solid var(--hep-border)}
.harness-composition-test summary{cursor:pointer;font-weight:500}
.harness-composition-detail pre{max-width:100%;overflow:auto;max-height:420px;padding:16px;border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.harness-composition-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.harness-composition-heading h2{margin-bottom:0}.harness-platform button.harness-composition-help{display:grid;place-items:center;flex:none;border:0;background:transparent;color:var(--hep-muted);padding:4px;min-height:28px;width:28px}.harness-platform button.harness-composition-help:hover{color:var(--hep-link);background:var(--hep-primary-soft)}
.harness-composition-trace{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.harness-composition-trace th,.harness-composition-trace td{padding:12px;text-align:left;overflow-wrap:anywhere}
.harness-composition-trace th{font-weight:500;color:var(--hep-muted);font-size:12px;background:var(--hep-surface-muted)}
@media(max-width:1200px){.harness-composition-workspace{grid-template-columns:220px minmax(0,1fr)}.harness-composition-layout{grid-template-columns:minmax(0,1fr)}.harness-composition-layout>aside{border-left:0;border-top:1px solid var(--hep-border);padding:20px 0 0}}
@media(max-width:900px){.harness-composition-workspace{grid-template-columns:minmax(0,1fr)}.harness-composition-sidebar ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px}.harness-composition-sidebar .harness-mcp-actions{margin-bottom:16px}}
@media(max-width:760px){.harness-mcp-return{display:none}}
@media(max-width:680px){.harness-mcp-page{padding-top:16px;padding-bottom:16px}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'title action' 'description description';align-items:start;column-gap:12px;row-gap:4px;margin-bottom:16px}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading>div{display:contents}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading h1{grid-area:title;min-width:0}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading p{grid-area:description}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading>button{grid-area:action;align-self:start}.harness-mcp-toolbar{gap:0;flex-wrap:wrap}.harness-mcp-tabs{gap:20px;flex-wrap:nowrap;white-space:nowrap;width:100%}.harness-mcp-toolbar>.harness-mcp-actions:not(:empty){width:100%;justify-content:flex-end;padding:0 0 12px}.harness-mcp-page .mcp-manager .mcp-service-layout{gap:8px}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker{align-items:center}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker label{gap:0;font-size:0;line-height:0}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker select{font-size:14px;line-height:1.4}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker>button{display:none}.harness-composition-detail{padding:16px}.harness-composition-editor{grid-template-columns:minmax(0,1fr)}.harness-composition-trace thead{display:none}.harness-composition-trace tbody{display:block}.harness-composition-trace tr{display:block;padding:12px 0;border-bottom:1px solid var(--hep-border)}.harness-composition-trace td{display:grid;grid-template-columns:52px minmax(0,1fr);gap:12px;padding:4px 0;border:0}.harness-composition-trace td::before{content:attr(data-label);color:var(--hep-muted);font-size:12px}}
.harness-mcp-module-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:20px}.harness-mcp-module-toolbar>.harness-mcp-toolbar{flex:1;margin:0;padding-inline:16px}.harness-mcp-module-toolbar>button{flex:none}.harness-mcp-save-actions:not(:empty){justify-content:flex-end;margin:-6px 0 14px}.harness-composition-workspace{grid-template-columns:224px minmax(0,1fr);gap:16px}.harness-composition-sidebar{padding:16px}.harness-composition-sidebar>h2{font-size:14px;margin-bottom:14px}.harness-composition-layout{grid-template-columns:minmax(0,1.4fr) minmax(220px,.8fr);gap:16px;margin-top:18px}.harness-flow-canvas{border:1px solid var(--hep-border);border-radius:var(--hep-radius);overflow:hidden;background:var(--hep-surface)}.harness-flow-canvas>header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--hep-border);gap:8px;font-size:13px;flex-wrap:wrap}.harness-flow-canvas>header>div{display:flex;align-items:center;gap:6px}.harness-flow-canvas>header button{padding:4px 8px;min-height:30px;font-size:12px}.harness-flow-canvas small{color:var(--hep-muted);font-size:11px;margin-left:8px}.harness-flow-viewport{height:400px;overflow:hidden;touch-action:none;cursor:grab;background-color:var(--hep-surface-muted);background-image:radial-gradient(color-mix(in srgb,var(--hep-primary) 18%,var(--hep-border)) 1px,transparent 1px);background-size:16px 16px}.harness-flow-viewport svg{display:block;width:100%;height:100%}.harness-flow-edge path{fill:none;stroke:color-mix(in srgb,var(--hep-primary) 28%,var(--hep-border));stroke-width:2}.harness-flow-edge text{fill:var(--hep-muted);font-size:11px}.harness-flow-node{cursor:pointer}.harness-flow-node rect{fill:var(--hep-surface);stroke:var(--hep-border);stroke-width:1.5}.harness-flow-node[aria-pressed=true] rect,.harness-flow-node:hover rect,.harness-flow-node:focus-visible rect{fill:var(--hep-primary-soft);stroke:var(--hep-primary);stroke-width:2}.harness-flow-node:focus{outline:none}.harness-flow-node text{fill:var(--hep-text);font-size:14px;font-weight:600}.harness-flow-node text.harness-flow-node-subtitle{font-size:11px;font-weight:400;fill:var(--hep-muted)}.harness-flow-canvas>footer,.harness-flow-empty{padding:10px 12px;color:var(--hep-muted);font-size:12px}.harness-flow-canvas>footer{border-top:1px solid var(--hep-border)}
.harness-composition-modal-backdrop{position:fixed;inset:0;z-index:90;background:#10283e52;display:grid;place-items:center;padding:16px}.harness-composition-modal{width:min(820px,100%);max-height:calc(100dvh - 32px);background:var(--hep-surface);color:var(--hep-text);border:1px solid var(--hep-border);border-radius:var(--hep-radius);box-shadow:0 20px 64px #173b6424;display:flex;flex-direction:column;outline:none}.harness-composition-modal>header,.harness-composition-modal>footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid var(--hep-border)}.harness-composition-modal>header h2{margin:0;font-size:17px}.harness-composition-modal>div{padding:16px 20px;overflow:auto;min-height:0}.harness-composition-modal>footer{border:0;border-top:1px solid var(--hep-border);justify-content:flex-end}.harness-composition-modal pre{max-height:none;white-space:pre;overflow:auto}
@media(max-width:1100px){.harness-composition-layout{grid-template-columns:minmax(0,1fr)}}@media(max-width:760px){.harness-mcp-module-toolbar{flex-wrap:wrap}.harness-mcp-module-toolbar>.harness-mcp-toolbar{flex-basis:100%}.harness-mcp-module-toolbar>button{margin-left:auto}.harness-composition-workspace{grid-template-columns:minmax(0,1fr)}.harness-flow-viewport{height:320px}}

/* 平台工具工作区：保留原生管理器行为，统一页面层级和阅读密度。 */
.harness-mcp-page .harness-mcp-page-heading{align-items:center;margin-bottom:24px;gap:20px}
.harness-mcp-page-heading>div{min-width:0}
.harness-mcp-page-heading h1{font-size:26px;line-height:1.3;margin:5px 0 8px;letter-spacing:-.025em}
.harness-mcp-kicker{display:block;color:var(--hep-link);font-size:11px;font-weight:600;letter-spacing:.08em;line-height:1.5}
.harness-mcp-page-heading p{max-width:75ch;font-size:13px}
.harness-mcp-page:not(.harness-gateway-page) .harness-mcp-module-toolbar>.harness-mcp-tabs{padding:5px;gap:4px;border-radius:var(--hep-radius);min-height:50px;box-shadow:none}
.harness-mcp-page .harness-mcp-module-toolbar .harness-mcp-tabs button{padding:8px 16px;min-height:38px;border:0;border-radius:var(--hep-control-radius);white-space:nowrap;font-size:13px}
.harness-mcp-page .harness-mcp-module-toolbar .harness-mcp-tabs button[aria-current=page]{background:var(--hep-primary-soft);color:var(--hep-link);font-weight:600}
.harness-mcp-page .harness-mcp-module-toolbar .harness-mcp-tabs button:not([aria-current=page]):hover:enabled{background:var(--hep-surface-muted)}
.harness-mcp-page .harness-mcp-save-actions:not(:empty){padding:10px 16px;margin:-6px 0 16px;border:1px solid var(--hep-border);border-radius:12px;background:var(--hep-surface)}
.harness-mcp-page .mcp-manager .mcp-card{border-radius:var(--hep-radius);box-shadow:0 1px 3px #173b6405}
.harness-mcp-page .mcp-manager .mcp-sidebar{background:var(--hep-surface);border-color:var(--hep-border)}
.harness-mcp-page .mcp-manager .mcp-list-item{width:100%;margin:4px 0 0;padding:12px;border:1px solid transparent;border-radius:var(--hep-control-radius);transition:background-color var(--hep-motion-fast),border-color var(--hep-motion-fast)}
.harness-mcp-page .mcp-manager .mcp-list-item[aria-current=true]{border-color:transparent;background:var(--hep-primary-soft)}
.harness-mcp-page .mcp-manager .mcp-service-title{font-size:13px;line-height:1.6}
.harness-mcp-page .mcp-manager .mcp-service-desc{font-size:12px;line-height:1.6}
.harness-mcp-page .mcp-manager .mcp-service-badge{border-radius:6px;padding:3px 8px;font-weight:500}
.harness-mcp-page .mcp-manager .mcp-service-count{padding:16px 2px 6px;font-size:11px}
.harness-mcp-page .mcp-manager .mcp-card-head{padding-bottom:16px;gap:16px}
.harness-mcp-page .mcp-manager .mcp-card-head h3{font-size:18px;letter-spacing:-.02em}
.harness-mcp-page .mcp-manager .mcp-service-summary{gap:16px 28px;padding:18px 0;margin:0 0 4px;background:transparent}
.harness-mcp-page .mcp-manager .mcp-service-summary strong{font-size:24px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.harness-mcp-page .mcp-manager .mcp-service-summary article{gap:8px}
.harness-mcp-page .mcp-manager .mcp-discovered-list li{padding:16px 0}
.harness-mcp-page .mcp-manager .mcp-discovered-list li>div>strong{font-weight:600}
.harness-mcp-page .mcp-manager .mcp-discovered-list li p{max-width:80ch;line-height:1.7}
.harness-mcp-page .mcp-manager .mcp-empty{padding:64px 24px;border-style:dashed;background:var(--hep-surface-muted)}
.harness-mcp-page .mcp-manager .mcp-empty strong{font-size:17px;font-weight:600}
.harness-mcp-page .mcp-manager .mcp-empty p{max-width:45ch;margin:10px auto 0}
.harness-mcp-page .harness-composition-sidebar{border-radius:var(--hep-radius);border:1px solid var(--hep-border);background:var(--hep-surface)}
.harness-mcp-page .harness-composition-sidebar li button{border-radius:var(--hep-control-radius);padding:12px}
.harness-mcp-page .harness-composition-sidebar li button[aria-current=true]{background:var(--hep-primary-soft);border-color:transparent;box-shadow:none}
.harness-mcp-page .harness-composition-sidebar h3{font-size:11px;letter-spacing:.04em}
.harness-mcp-page .harness-composition-detail.harness-card{border-radius:var(--hep-radius)}
.harness-composition-empty{display:flex;min-height:280px;padding:40px 24px;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--hep-muted)}
.harness-composition-empty>svg{box-sizing:content-box;padding:16px;margin-bottom:20px;border-radius:14px;background:var(--hep-primary-soft);color:var(--hep-link)}
.harness-composition-empty h3{margin:0 0 8px;color:var(--hep-text);font-size:18px}
.harness-composition-empty p{margin:0;max-width:420px;font-size:13px;overflow-wrap:anywhere}
.harness-mcp-page .harness-flow-canvas>header{padding:12px 16px;background:var(--hep-surface)}
.harness-mcp-page .harness-flow-viewport{background-size:20px 20px}
.harness-mcp-page .harness-flow-node rect{rx:12px}
.harness-mcp-page .harness-composition-test{margin-top:28px;padding-top:24px}
.harness-composition-modal>header{padding:20px 24px;background:var(--hep-surface)}
.harness-composition-modal>div{padding:24px}
.harness-composition-modal>footer{padding:16px 24px;background:var(--hep-surface-muted)}
@media(max-width:760px){.harness-mcp-page .harness-mcp-module-toolbar>.harness-mcp-tabs{flex-basis:auto}.harness-mcp-page .mcp-manager .mcp-card{padding:16px}.harness-mcp-page .mcp-manager .mcp-debug-result{min-height:280px}}
@media(max-width:680px){.harness-mcp-page:not(.harness-gateway-page)>.harness-mcp-page-heading{display:flex;align-items:flex-start;margin-bottom:20px;gap:12px}.harness-mcp-page:not(.harness-gateway-page)>.harness-mcp-page-heading>div{display:block}.harness-mcp-page-heading h1{font-size:24px}.harness-mcp-page-heading>button{padding:8px 12px;min-height:40px}.harness-mcp-page-heading p{font-size:12px}.harness-mcp-page .harness-mcp-module-toolbar .harness-mcp-tabs button{padding:9px 12px}.harness-mcp-page .mcp-manager .mcp-service-summary{gap:12px 20px;padding:16px 0}.harness-mcp-page .mcp-manager .mcp-service-summary strong{font-size:18px}.harness-composition-modal>header,.harness-composition-modal>div,.harness-composition-modal>footer{padding:16px}}
`
