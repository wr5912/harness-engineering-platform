export const homePageTheme = `
.harness-home{width:100%;max-width:1360px;padding:24px var(--hep-page-padding) 32px;margin:auto}
.harness-hero{text-align:center;padding:16px 0 18px}
.harness-hero-kicker{display:block;margin-bottom:14px;color:var(--hep-link);font-size:12px;font-weight:700;letter-spacing:.12em}
.harness-hero h1{max-width:1080px;margin:0 auto;font-size:clamp(26px,2.5vw,32px);font-weight:600;line-height:1.35;letter-spacing:-.025em;text-wrap:balance}
.harness-hero>p{max-width:720px;color:var(--hep-muted);margin:8px auto 18px;font-size:14px;text-wrap:pretty}
.harness-task-composer{max-width:860px;margin:auto;padding:12px 16px 16px;background:var(--hep-surface);border:1px solid color-mix(in srgb,var(--hep-primary) 28%,var(--hep-border));border-radius:16px;text-align:left;transition:border-color var(--hep-motion),box-shadow var(--hep-motion)}
.harness-task-composer:focus-within{border-color:var(--hep-primary);box-shadow:0 0 0 3px var(--hep-primary-soft),var(--hep-shadow)}
.harness-home-shortcuts{max-width:860px;margin:12px auto 0;display:flex;align-items:center;justify-content:center;gap:8px;text-align:left;flex-wrap:wrap}
.harness-entry-modes{display:flex;flex:none;gap:8px;min-width:0}
.harness-platform .harness-entry-modes button{display:flex;align-items:center;justify-content:center;gap:7px;flex:none;min-width:0;background:var(--hep-surface);border:1px solid var(--hep-border);font-size:12px;color:var(--hep-text);padding:8px 12px}
.harness-entry-modes svg{flex-shrink:0;color:var(--hep-link)}
.harness-platform .harness-free-mode{flex:0 0 auto;color:var(--hep-link);border-color:transparent;background:transparent;padding:5px 8px;font-size:12px}
.harness-platform .harness-entry-modes button[aria-pressed=true],.harness-platform .harness-free-mode[aria-pressed=true]{background:var(--hep-primary-soft);border-color:var(--hep-primary);color:var(--hep-link);font-weight:600}
.harness-entry{display:flex;flex-direction:column;gap:12px}
.harness-entry textarea{width:100%;min-height:39px;max-height:240px;resize:none;overflow-y:auto;border:0;line-height:1.65;background:transparent;padding:8px 4px;scrollbar-width:thin}
.harness-entry textarea:focus-visible{outline:2px solid var(--hep-primary-soft);outline-offset:1px}
.harness-entry-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:0 4px}
.harness-entry-footer span{font-size:12px;color:var(--hep-muted);line-height:1.6}
.harness-entry-footer button{flex-shrink:0;min-width:108px;margin-left:auto}
.harness-task-composer>p{font-size:14px;margin:12px 4px 0}
.harness-platform .harness-example-toggle{margin-top:12px;border-color:transparent;background:transparent;color:var(--hep-link);font-size:13px;padding:4px 0}
.harness-example{position:relative;margin:12px auto 0;padding:16px;text-align:left;background:var(--hep-surface);border:1px solid var(--hep-border);border-radius:var(--hep-radius)}
.harness-example label{display:grid;gap:8px;min-width:0;font-size:14px;color:var(--hep-text)}
.harness-example p{font-size:14px;color:var(--hep-muted);margin:8px 0 16px}
.harness-example>div{display:flex;gap:8px;flex-wrap:wrap}
.harness-example select{margin-bottom:16px;width:100%;min-width:0}
.harness-home-workspace{display:grid;grid-template-columns:minmax(0,3fr) minmax(300px,1fr);gap:24px;align-items:start;margin:22px 0 24px}
.harness-home-primary,.harness-home-secondary{display:grid;gap:24px;align-content:start;min-width:0}
.harness-home-primary>.harness-card,.harness-home-secondary>.harness-card{min-width:0}
.harness-home .harness-source{text-align:center;font-size:11px}
.harness-home-workspace .harness-section-heading p{margin:4px 0 0;color:var(--hep-muted);font-size:12px;line-height:1.5}
.harness-stats{display:grid;gap:0;margin:4px 0 0}
.harness-continue{margin:0}
.harness-continue>.harness-section-heading,.harness-recent-work>.harness-section-heading{align-items:flex-start}
.harness-home .harness-section-heading h2{display:flex;align-items:center;gap:8px}
.harness-entry-footer button{display:inline-flex;align-items:center;justify-content:center;gap:6px}
.harness-stat small:empty{min-height:18px}
.harness-continue-list{display:grid;gap:0}
.harness-platform .harness-home-view-all{display:inline-flex;align-items:center;min-height:36px;padding:6px 0;border-color:transparent;background:transparent;color:var(--hep-link);font-size:12px;white-space:nowrap}
.harness-continue-item{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--hep-border)}
.harness-continue-item:last-child{border-bottom:0}
.harness-continue-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:var(--hep-primary-soft);color:var(--hep-link)}
.harness-continue-icon[data-tone=warning]{background:color-mix(in srgb,var(--hep-warning) 12%,var(--hep-surface));color:var(--hep-warning)}
.harness-continue-icon[data-tone=danger]{background:color-mix(in srgb,var(--hep-danger) 12%,var(--hep-surface));color:var(--hep-danger)}
.harness-continue-content{min-width:0}
.harness-continue-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.harness-continue-item strong{line-height:1.5;overflow-wrap:anywhere}
.harness-continue-item small{display:block;color:var(--hep-muted);overflow-wrap:anywhere}
.harness-continue-item button{white-space:nowrap}
.harness-platform .harness-stat{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 12px;width:100%;min-height:70px;text-align:left;padding:13px 0;background:transparent;border:0;border-bottom:1px solid var(--hep-border);border-radius:0}
.harness-platform .harness-stat:last-child{border-bottom:0}
.harness-stat span{color:var(--hep-text);font-size:13px;font-weight:500}
.harness-stat strong{grid-column:2;grid-row:1;font-size:13px;font-weight:500;line-height:1.5;color:var(--hep-text);white-space:nowrap}.harness-stat[data-value-kind=number] strong{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}.harness-stat[data-value-kind=unknown] strong{font-size:18px;font-weight:400;color:var(--hep-muted)}.harness-stat[data-value-kind=status] strong{padding:3px 7px;border-radius:5px;background:var(--hep-surface-muted)}
.harness-stat small{grid-column:1/-1;font-size:12px;line-height:1.5;color:var(--hep-muted)}
.harness-start-guide{background:var(--hep-primary-soft);border-color:color-mix(in srgb,var(--hep-primary) 18%,var(--hep-border))}
.harness-guide-icon{display:grid;place-items:center;width:34px;height:34px;margin-bottom:14px;color:var(--hep-link);font-size:26px}
.harness-start-guide h2{margin:0;font-size:17px;line-height:1.45}
.harness-start-guide>p{margin:10px 0 16px;color:var(--hep-muted);font-size:13px;line-height:1.7}
.harness-platform .harness-guide-action{color:var(--hep-link);border-color:transparent;background:color-mix(in srgb,var(--hep-primary) 10%,var(--hep-surface));font-weight:600}
.harness-home .harness-run-row:last-child{border-bottom:0;padding-bottom:0}
.harness-home .harness-run-row>div>small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.harness-home .harness-run-row{padding:12px 0}
.harness-home .harness-run-row strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.harness-run-row>.harness-run-labels{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap}
.harness-platform .harness-run-action{flex-shrink:0;padding:6px 8px;min-height:36px;border-color:transparent;background:transparent;color:var(--hep-link);font-size:12px;white-space:nowrap}
.harness-platform .harness-run-action:hover:enabled{background:var(--hep-primary-soft);color:var(--hep-link)}
.harness-home-run-overview{min-width:0;margin:0 0 20px;padding:0 0 20px;border-bottom:1px solid var(--hep-border)}
.harness-home .harness-home-run-table .harness-run-row{display:table-row}.harness-home-run-table td{padding:14px 12px;vertical-align:middle}.harness-home-run-table th{font-size:12px;padding:10px 12px}.harness-home-run-table td:first-child{min-width:180px}.harness-home-run-table td small{display:block;color:var(--hep-muted);font-size:12px;margin-top:5px}.harness-home-run-table .harness-run-state{white-space:nowrap}
@media(max-width:680px){.harness-home-run-table thead{display:none}.harness-home-run-table tbody,.harness-home .harness-home-run-table .harness-run-row{display:block}.harness-home-run-table td{display:grid;grid-template-columns:80px minmax(0,1fr);align-items:start;border:0;padding:7px 0}.harness-home-run-table td::before{content:attr(data-label);color:var(--hep-muted);font-size:12px}.harness-home-run-table td small{grid-column:2}.harness-home-run-table td:first-child{min-width:0}.harness-home-run-table td strong{white-space:normal}.harness-home-run-table td .harness-run-state{justify-self:start}.harness-home-run-table td .harness-run-action{justify-self:start;grid-column:2;padding:0}}
/* 两列共享行轨道，卡片上下边界保持一致；各自的内容不靠固定高度撑开。 */
@media(min-width:1101px){.harness-home-workspace{grid-template-rows:auto auto;align-items:stretch}.harness-home-primary,.harness-home-secondary{grid-row:span 2;grid-template-rows:subgrid;align-content:normal}.harness-home-primary{grid-column:1}.harness-home-secondary{grid-column:2}.harness-continue,.harness-workspace-summary{display:flex;flex-direction:column}.harness-continue>.harness-section-heading,.harness-workspace-summary>.harness-section-heading{align-items:flex-start;min-height:48px;margin:0 0 12px}.harness-continue-list,.harness-workspace-summary .harness-stats{display:grid;flex:1;grid-template-rows:repeat(4,minmax(78px,1fr));grid-auto-rows:minmax(78px,1fr);gap:0;margin:0}.harness-continue-item,.harness-platform .harness-workspace-summary .harness-stat{box-sizing:border-box;min-height:78px;padding:12px 0}.harness-continue-item:last-child{border-bottom:1px solid var(--hep-border)}.harness-continue-item:nth-child(4){border-bottom:0}}
@media(prefers-reduced-motion:no-preference){.harness-example{animation:hep-enter var(--hep-motion) var(--hep-ease)}}
@media(hover:hover) and (prefers-reduced-motion:no-preference){.harness-platform .harness-stat:hover:enabled{background:var(--hep-surface-muted)}}
@media(min-width:1101px){.harness-home{--hep-page-padding:36px}}
@media(max-width:1100px){.harness-home-workspace{grid-template-columns:1fr}.harness-home-secondary{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.harness-home .harness-run-row{flex-wrap:nowrap}}
@media(max-width:680px){.harness-home{padding-top:12px}.harness-hero{padding:6px 0 8px;text-align:left}.harness-hero-kicker{margin-bottom:10px;font-size:11px}.harness-hero h1{max-width:300px;margin:0;font-size:25px;line-height:1.4}.harness-hero>p{margin:9px 0 14px;font-size:12px;line-height:1.85}.harness-task-composer{padding:10px 12px 12px}.harness-entry textarea{min-height:64px}.harness-home-shortcuts{display:grid;grid-template-columns:1fr;margin-top:10px}.harness-entry-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.harness-platform .harness-entry-modes button{font-size:11px;padding:9px 4px}.harness-platform .harness-free-mode{justify-self:start}.harness-home-workspace{margin-top:18px}.harness-home-primary,.harness-home-secondary{gap:16px}.harness-home-secondary{grid-template-columns:minmax(0,1fr)}.harness-home-secondary .harness-start-guide{display:none}.harness-continue-item{grid-template-columns:32px minmax(0,1fr);align-items:start;gap:8px 10px}.harness-continue-icon{width:32px;height:32px;border-radius:8px;margin-top:2px}.harness-continue-icon svg{width:17px;height:17px}.harness-continue-title{font-size:12px}.harness-continue-title .harness-run-state{font-size:12px;line-height:1.5;padding:3px 6px}.harness-continue-item button{grid-column:2;justify-self:start;margin-top:-4px}.harness-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.harness-platform .harness-stat{grid-template-columns:minmax(0,1fr);align-content:start;align-items:start;gap:6px;padding:12px 0}.harness-stat strong{grid-column:1;grid-row:auto;justify-self:start}.harness-home .harness-stat:nth-last-child(-n+2){border-bottom:0}.harness-stat[data-value-kind=number] strong{font-size:22px}.harness-home .harness-run-row{display:grid;grid-template-columns:32px minmax(0,1fr);gap:8px 12px}.harness-home .harness-run-labels{grid-column:2}.harness-home .harness-run-action{grid-column:2;justify-self:start}.harness-example{padding:12px}.harness-home .harness-section-heading{gap:8px}.harness-home .harness-section-heading button{flex-shrink:0}}
`
