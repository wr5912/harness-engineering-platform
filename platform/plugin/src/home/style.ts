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
.harness-entry textarea{width:100%;min-height:58px;max-height:240px;resize:none;overflow-y:auto;border:0;line-height:1.65;background:transparent;padding:8px 4px;scrollbar-width:thin}
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
.harness-continue>.harness-section-heading{margin-bottom:0}
.harness-continue-list{display:grid;gap:0;max-height:395px;overflow:auto;scrollbar-width:thin}
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
.harness-platform .harness-stat{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:0 12px;width:100%;text-align:left;padding:10px 0;background:transparent;border:0;border-bottom:1px solid var(--hep-border);border-radius:0}
.harness-platform .harness-stat:last-child{border-bottom:0}
.harness-stat span{color:var(--hep-text);font-size:13px;font-weight:500}
.harness-stat strong{grid-column:2;grid-row:1/3;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3;color:var(--hep-text)}
.harness-stat small{grid-column:1;font-size:11px;line-height:1.5;color:var(--hep-muted)}
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
@media(prefers-reduced-motion:no-preference){.harness-example{animation:hep-enter var(--hep-motion) var(--hep-ease)}}
@media(hover:hover) and (prefers-reduced-motion:no-preference){.harness-platform .harness-stat:hover:enabled{background:var(--hep-surface-muted)}}
@media(min-width:1101px){.harness-home{--hep-page-padding:36px}}
@media(max-width:1100px){.harness-home-workspace{grid-template-columns:1fr}.harness-home-secondary{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.harness-home .harness-run-row{flex-wrap:nowrap}}
@media(max-width:680px){.harness-home{padding-top:12px}.harness-hero{padding:6px 0 8px;text-align:left}.harness-hero-kicker{margin-bottom:10px;font-size:11px}.harness-hero h1{max-width:300px;margin:0;font-size:25px;line-height:1.4}.harness-hero>p{margin:9px 0 14px;font-size:12px;line-height:1.85}.harness-task-composer{padding:10px 12px 12px}.harness-entry textarea{min-height:72px}.harness-home-shortcuts{display:grid;grid-template-columns:1fr;margin-top:10px}.harness-entry-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.harness-platform .harness-entry-modes button{font-size:11px;padding:9px 4px}.harness-platform .harness-free-mode{justify-self:start}.harness-home-workspace{margin-top:18px}.harness-home-primary,.harness-home-secondary{gap:16px}.harness-home-secondary{display:none}.harness-continue-list{max-height:none;overflow:visible}.harness-continue-item{grid-template-columns:32px minmax(0,1fr);align-items:start;gap:8px 10px}.harness-continue-icon{width:32px;height:32px;border-radius:8px;margin-top:2px}.harness-continue-icon svg{width:17px;height:17px}.harness-continue-title{font-size:12px}.harness-continue-title .harness-run-state{font-size:9px;padding:3px 6px}.harness-continue-item button{grid-column:2;justify-self:start;margin-top:-4px}.harness-stats{grid-template-columns:1fr}.harness-platform .harness-stat{padding:10px 0}.harness-stat strong{font-size:22px}.harness-home .harness-run-row{display:grid;grid-template-columns:32px minmax(0,1fr);gap:8px 12px}.harness-home .harness-run-labels{grid-column:2}.harness-home .harness-run-action{grid-column:2;justify-self:start}.harness-example{padding:12px}.harness-home .harness-section-heading{gap:8px}.harness-home .harness-section-heading button{flex-shrink:0}}
`
