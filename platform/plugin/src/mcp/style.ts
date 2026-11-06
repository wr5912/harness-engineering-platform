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
.harness-composition-workspace{display:grid;grid-template-columns:240px minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:16px;align-items:stretch;height:max(560px,calc(100dvh - var(--composition-top,240px) - 24px));min-width:0}
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
.harness-composition-detail{min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px;padding:16px;overflow:auto}
.harness-composition-detail h2{font-size:18px;margin:0 0 16px;overflow-wrap:anywhere}
.harness-composition-detail h3{font-size:16px;overflow-wrap:anywhere}
.harness-composition-detail h4{font-size:14px}
.harness-composition-detail p,.harness-composition-detail code{overflow-wrap:anywhere}
.harness-composition-detail>.harness-mcp-actions{margin:12px 0}
.harness-composition-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:16px 24px}
.harness-composition-editor>p,.harness-composition-editor>.harness-mcp-actions,.harness-composition-editor>.harness-threat-editor,.harness-composition-editor>.harness-mcp-wide{grid-column:1/-1}
.harness-composition-editor label,.harness-composition-test>label{display:grid;align-content:start;gap:8px;min-width:0}
.harness-composition-editor input:not([type=checkbox]):not([type=radio]),.harness-composition-editor textarea,.harness-composition-editor select,.harness-composition-test input{width:100%;min-width:0;box-sizing:border-box}
.harness-composition-editor textarea{min-height:100px;resize:vertical}
.harness-composition-layout{display:flex;flex:1;min-height:180px;gap:16px}
.harness-composition-graph{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;gap:8px}.harness-composition-graph>p{margin:0}
.harness-composition-node-panel{flex:0 0 320px;min-width:0;overflow:auto;border-left:1px solid var(--hep-border)}
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
.harness-composition-test{padding:16px;min-width:0;overflow:auto}
.harness-composition-test>label{max-width:640px;margin:16px 0}
.harness-composition-test>.harness-mcp-actions{margin:16px 0}
.harness-composition-test details{padding-top:16px;margin-top:16px;border-top:1px solid var(--hep-border)}
.harness-composition-test summary{cursor:pointer;font-weight:500}
.harness-composition-detail pre{max-width:100%;overflow:auto;max-height:420px;padding:16px;border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.harness-composition-trace{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.harness-composition-trace th,.harness-composition-trace td{padding:12px;text-align:left;overflow-wrap:anywhere}
.harness-composition-trace th{font-weight:500;color:var(--hep-muted);font-size:12px;background:var(--hep-surface-muted)}
@media(max-width:760px){.harness-mcp-return{display:none}}
@media(max-width:680px){.harness-mcp-page{padding-top:16px;padding-bottom:16px}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'title action' 'description description';align-items:start;column-gap:12px;row-gap:4px;margin-bottom:16px}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading>div{display:contents}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading h1{grid-area:title;min-width:0}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading p{grid-area:description}.harness-mcp-page:not(.harness-gateway-page)>.harness-page-heading>button{grid-area:action;align-self:start}.harness-mcp-toolbar{gap:0;flex-wrap:wrap}.harness-mcp-tabs{gap:20px;flex-wrap:nowrap;white-space:nowrap;width:100%}.harness-mcp-toolbar>.harness-mcp-actions:not(:empty){width:100%;justify-content:flex-end;padding:0 0 12px}.harness-mcp-page .mcp-manager .mcp-service-layout{gap:8px}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker{align-items:center}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker label{gap:0;font-size:0;line-height:0}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker select{font-size:14px;line-height:1.4}.harness-mcp-page .mcp-manager .mcp-mobile-service-picker>button{display:none}.harness-composition-detail{padding:16px}.harness-composition-editor{grid-template-columns:minmax(0,1fr)}.harness-composition-trace thead{display:none}.harness-composition-trace tbody{display:block}.harness-composition-trace tr{display:block;padding:12px 0;border-bottom:1px solid var(--hep-border)}.harness-composition-trace td{display:grid;grid-template-columns:52px minmax(0,1fr);gap:12px;padding:4px 0;border:0}.harness-composition-trace td::before{content:attr(data-label);color:var(--hep-muted);font-size:12px}}
.harness-mcp-module-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:20px}.harness-mcp-module-toolbar>.harness-mcp-toolbar{flex:1;margin:0;padding-inline:16px}.harness-mcp-module-toolbar>button{flex:none}.harness-mcp-save-actions:not(:empty){justify-content:flex-end;margin:-6px 0 14px}.harness-composition-sidebar{padding:16px}.harness-composition-sidebar>h2{font-size:14px;margin-bottom:14px}.harness-flow-canvas{display:flex;flex:1;flex-direction:column;min-height:0;border:1px solid var(--hep-border);border-radius:var(--hep-radius);overflow:hidden;background:var(--hep-surface)}.harness-flow-canvas>header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--hep-border);gap:8px;font-size:13px;flex-wrap:wrap}.harness-flow-canvas>header>div{display:flex;align-items:center;gap:6px}.harness-flow-canvas>header button{padding:4px 8px;min-height:30px;font-size:12px}.harness-flow-canvas small{color:var(--hep-muted);font-size:11px;margin-left:8px}.harness-flow-viewport{flex:1;min-height:0;overflow:hidden;touch-action:none;cursor:grab;background-color:var(--hep-surface-muted);background-image:radial-gradient(color-mix(in srgb,var(--hep-primary) 18%,var(--hep-border)) 1px,transparent 1px);background-size:16px 16px}.harness-flow-viewport svg{display:block;width:100%;height:100%}.harness-flow-edge path{fill:none;stroke:color-mix(in srgb,var(--hep-primary) 28%,var(--hep-border));stroke-width:2}.harness-flow-edge text{fill:var(--hep-muted);font-size:11px}.harness-flow-node{cursor:grab;user-select:none}.harness-flow-node:active,.harness-flow-viewport:active{cursor:grabbing}.harness-flow-node rect{fill:var(--hep-surface);stroke:var(--hep-border);stroke-width:1.5}.harness-flow-node[aria-pressed=true] rect,.harness-flow-node:hover rect,.harness-flow-node:focus-visible rect{fill:var(--hep-primary-soft);stroke:var(--hep-primary);stroke-width:2}.harness-flow-node:focus{outline:none}.harness-flow-node text{fill:var(--hep-text);font-size:14px;font-weight:600}.harness-flow-node text.harness-flow-node-subtitle{font-size:11px;font-weight:400;fill:var(--hep-muted)}.harness-flow-canvas>footer,.harness-flow-empty{padding:10px 12px;color:var(--hep-muted);font-size:12px}.harness-flow-canvas>footer{border-top:1px solid var(--hep-border)}
.harness-composition-modal-backdrop{position:fixed;inset:0;z-index:90;background:#10283e52;display:grid;place-items:center;padding:16px}.harness-composition-modal{width:min(820px,100%);max-height:calc(100dvh - 32px);background:var(--hep-surface);color:var(--hep-text);border:1px solid var(--hep-border);border-radius:var(--hep-radius);box-shadow:0 20px 64px #173b6424;display:flex;flex-direction:column;outline:none}.harness-composition-modal>header,.harness-composition-modal>footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid var(--hep-border)}.harness-composition-modal>header h2{margin:0;font-size:17px}.harness-composition-modal>div{padding:16px 20px;overflow:auto;min-height:0}.harness-composition-modal>footer{border:0;border-top:1px solid var(--hep-border);justify-content:flex-end}.harness-composition-modal pre{max-height:none;white-space:pre;overflow:auto}
@media(max-width:760px){.harness-mcp-module-toolbar{flex-wrap:wrap}.harness-mcp-module-toolbar>.harness-mcp-toolbar{flex-basis:100%}.harness-mcp-module-toolbar>button{margin-left:auto}.harness-composition-workspace{grid-template-columns:minmax(0,1fr)}}

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

.harness-composition-modal>header{padding:20px 24px;background:var(--hep-surface)}
.harness-composition-modal>div{padding:24px}
.harness-composition-modal>footer{padding:16px 24px;background:var(--hep-surface-muted)}
@media(max-width:760px){.harness-mcp-page .harness-mcp-module-toolbar>.harness-mcp-tabs{flex-basis:auto}.harness-mcp-page .mcp-manager .mcp-card{padding:16px}.harness-mcp-page .mcp-manager .mcp-debug-result{min-height:280px}}
@media(max-width:680px){.harness-mcp-page:not(.harness-gateway-page)>.harness-mcp-page-heading{display:flex;align-items:flex-start;margin-bottom:20px;gap:12px}.harness-mcp-page:not(.harness-gateway-page)>.harness-mcp-page-heading>div{display:block}.harness-mcp-page-heading h1{font-size:24px}.harness-mcp-page-heading>button{padding:8px 12px;min-height:40px}.harness-mcp-page-heading p{font-size:12px}.harness-mcp-page .harness-mcp-module-toolbar .harness-mcp-tabs button{padding:9px 12px}.harness-mcp-page .mcp-manager .mcp-service-summary{gap:12px 20px;padding:16px 0}.harness-mcp-page .mcp-manager .mcp-service-summary strong{font-size:18px}.harness-composition-modal>header,.harness-composition-modal>div,.harness-composition-modal>footer{padding:16px}}
/* 编排工作面共用布局：画布占据剩余空间，辅助信息按需展开。 */
.harness-composition-workspace[data-list-open=false],
.harness-composition-workspace[data-fullscreen=true]{grid-template-columns:minmax(0,1fr)}
.harness-composition-workspace[data-list-open=false]>.harness-composition-sidebar,
.harness-composition-workspace[data-fullscreen=true]>.harness-composition-sidebar{display:none}
.harness-composition-workspace>.harness-composition-sidebar{max-height:100%;min-height:0;overflow:auto}
.harness-composition-topbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none}
.harness-composition-detail .harness-composition-topbar h2{flex:1;min-width:120px;margin:0;font-size:18px;line-height:1.6}
.harness-composition-version{width:220px;max-width:100%}
.harness-composition-summary{display:flex;align-items:center;gap:12px;justify-content:space-between;font-size:13px;color:var(--hep-muted);flex:none}
.harness-composition-summary>span{min-width:0;overflow-wrap:anywhere}
.harness-composition-summary>.hep-detail-trigger{flex:none}
.harness-composition-detail>p{margin:0;flex:none}
.harness-composition-detail>.harness-composition-editor{overflow:auto;min-height:0}
.harness-composition-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--hep-border);flex:none}
.harness-composition-panel-heading>button{flex:none;min-width:36px;font-size:20px;line-height:1}
.harness-composition-panel-body{padding:16px;min-width:0;overflow:auto}
.harness-composition-node-panel[hidden]{display:none}
.harness-composition-test-dock{flex:none;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);overflow:hidden}
.harness-platform .harness-composition-test-toggle{display:flex;align-items:center;gap:12px;width:100%;border:0;border-radius:0;text-align:left;padding:10px 16px;background:var(--hep-surface-muted);white-space:normal}
.harness-composition-test-toggle>span[role=status]{flex:1;font-size:12px;font-weight:400;color:var(--hep-muted)}
.harness-composition-panel-drawer{max-height:100dvh!important}
.harness-composition-panel-drawer .harness-composition-test{overflow:auto;min-height:0}
.harness-composition-panel-drawer .harness-composition-panel-body{flex:1;min-height:0}
.harness-composition-panel-drawer :is(input,textarea,select){width:100%;max-width:100%;font:inherit;color:inherit;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);padding:8px 12px;background:var(--hep-surface)}
.harness-composition-panel-drawer p,.harness-composition-panel-drawer code{overflow-wrap:anywhere}
.harness-composition-panel-drawer button{font:inherit;color:inherit;padding:6px 12px;min-height:var(--hep-hit-target,36px);border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface)}
.harness-composition-panel-drawer pre{max-width:100%;overflow:auto;white-space:pre-wrap;padding:12px;background:var(--hep-surface-muted);font-size:12px}
.harness-composition-workspace[data-fullscreen=true]>.harness-composition-detail{position:fixed;inset:0;z-index:80;width:100%;height:100dvh;max-height:100dvh;margin:0;border-radius:0;outline:none;background:var(--hep-surface)}
.harness-composition-workspace[data-fullscreen=true] .harness-composition-list-toggle{display:none}
.harness-composition-mobile-picker{display:none}
.harness-flow-empty{flex:1;margin:0;display:grid;place-items:center;text-align:center}
@media(max-width:1100px){
 .harness-composition-workspace{grid-template-columns:minmax(0,1fr)}
 .harness-composition-sidebar,.harness-composition-list-toggle{display:none}
 .harness-composition-mobile-picker{display:flex;align-items:center;gap:8px;flex:none}
 .harness-composition-mobile-picker>.hep-search-select{flex:1;min-width:0}
 .harness-composition-topbar{gap:8px}
 .harness-composition-detail .harness-composition-topbar h2{flex-basis:calc(100% - 100px);order:-2}
 .harness-composition-fullscreen-toggle{order:-1;margin-left:auto}
 .harness-composition-version{flex:1 1 160px;width:auto;min-width:0}
}
@media(max-width:680px){
 .harness-composition-detail{padding:12px;gap:8px}
 .harness-composition-summary{font-size:12px;gap:8px}
 .harness-composition-test-toggle{gap:8px}
 .harness-flow-canvas>header small{display:none}
 .harness-flow-canvas>footer{font-size:11px}
 .harness-composition-panel-heading,.harness-composition-panel-body,.harness-composition-test{padding:12px}
 .harness-composition-mobile-picker button{padding-inline:8px}
}
`
