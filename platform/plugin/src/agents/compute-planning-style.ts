// 策划窗口继承全局主题，正文按任务顺序组织；标题和操作区始终可达。
export const computePlanningTheme = `
.hep-compute-dialog{width:min(880px,calc(100vw - 48px));max-width:none;max-height:min(880px,calc(100dvh - 48px));height:auto;margin:auto;padding:0;overflow:hidden;border:1px solid var(--hep-border);border-radius:16px;background:var(--hep-surface);color:var(--hep-text);box-shadow:0 28px 88px #10283e2b;font-size:14px;line-height:1.6}

.hep-compute-dialog[open]{display:flex;flex-direction:column}
.hep-compute-dialog::backdrop{background:#14273e55}

.hep-compute-dialog *{box-sizing:border-box}
.hep-compute-dialog :is(h2,h3,h4,p){margin:0}
.hep-compute-dialog :is(button,input,select,textarea){font:inherit}
.hep-compute-dialog :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--hep-focus);outline-offset:3px}
.hep-compute-dialog :is(button,summary){touch-action:manipulation}
.hep-compute-dialog button{cursor:pointer}
.hep-compute-dialog button:disabled{cursor:default;opacity:.5}
.hep-plan-icon{width:18px;height:18px;flex:none}

.hep-plan-head{flex:none;padding:26px 28px 20px;border-bottom:1px solid var(--hep-border);background:var(--hep-surface)}
.hep-plan-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.hep-plan-top>div:first-child{min-width:0}
.hep-plan-head h2{font-size:23px;line-height:1.4;font-weight:600;letter-spacing:-.02em}
.hep-plan-top p{font-size:13px;color:var(--hep-muted);margin-top:8px;line-height:1.7}
.hep-plan-top-actions{flex:none}

.harness-platform .hep-plan-close{display:grid;place-items:center;width:max(36px,var(--hep-hit-target));height:max(36px,var(--hep-hit-target));min-height:36px;padding:0;border:1px solid var(--hep-border);border-radius:10px;background:var(--hep-surface);color:var(--hep-muted)}
.harness-platform .hep-plan-close:hover:enabled{background:var(--hep-surface-muted);color:var(--hep-text)}

.hep-plan-source{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;margin-top:14px;color:var(--hep-muted);font-size:12px}
.hep-plan-source strong{color:var(--hep-text);font-weight:500;overflow-wrap:anywhere}
.hep-plan-version{padding:3px 8px;border:1px solid var(--hep-border);border-radius:6px;background:var(--hep-surface);font-variant-numeric:tabular-nums}
.hep-plan-source details{min-width:0}
.hep-plan-source summary{color:var(--hep-link);cursor:pointer;padding:3px 0}
.hep-plan-source details[open]{flex-basis:100%}
.hep-plan-source code{display:block;padding:10px 12px;margin-top:6px;border-radius:6px;background:var(--hep-surface-muted);font-size:12px;line-height:1.7;overflow-wrap:anywhere}

.hep-plan-body{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;overflow-anchor:none;padding:26px 28px;scrollbar-width:thin}
.hep-plan-config-layout,.hep-plan-config-main{min-width:0}
.hep-plan-fields{display:grid;gap:26px;min-width:0;margin:0;padding:0;border:0}

.hep-plan-mode-switch{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.harness-platform .hep-plan-mode-switch button{display:flex;align-items:center;justify-content:flex-start;gap:12px;min-width:0;padding:18px 16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);text-align:left;color:var(--hep-text)}
.hep-plan-mode-switch button>span{display:grid;gap:4px;min-width:0}.hep-plan-mode-switch button::after{content:"";width:16px;height:16px;flex:none;margin-left:auto;border:1.5px solid var(--hep-border);border-radius:50%;background:var(--hep-surface)}.hep-plan-mode-switch button[data-active=true]::after{border-color:var(--hep-primary);background:var(--hep-primary);box-shadow:inset 0 0 0 3px var(--hep-surface)}
.hep-plan-mode-switch strong{font-size:15px;font-weight:600}
.hep-plan-mode-switch small{font-size:12px;font-weight:400;color:var(--hep-muted);line-height:1.5}
.hep-plan-mode-switch .hep-plan-icon{color:var(--hep-muted)}
.harness-platform .hep-plan-mode-switch button[data-active=true]{border-color:var(--hep-primary);background:var(--hep-primary-soft);color:var(--hep-link);box-shadow:0 0 0 1px color-mix(in srgb,var(--hep-primary) 15%,transparent)}
.hep-plan-mode-switch button[data-active=true] .hep-plan-icon{color:var(--hep-link)}

.hep-plan-form-section{display:grid;gap:16px;min-width:0;padding-bottom:26px;border-bottom:1px solid var(--hep-border)}
.hep-plan-form-section>h3{display:flex;align-items:baseline;gap:10px;font-size:16px;line-height:1.5;font-weight:600}
.hep-plan-form-section>h3 small{font-size:12px;color:var(--hep-muted);font-weight:400}
.hep-plan-field{display:grid;min-width:0;gap:7px;color:var(--hep-text);font-size:13px;line-height:1.5}
.hep-plan-field span>small,.hep-plan-field>small{font-weight:400;color:var(--hep-muted);font-size:12px}
.hep-plan-field :is(input,select,textarea){width:100%;min-width:0;max-width:100%;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);color:var(--hep-text);padding:10px 12px;font-size:14px;line-height:1.5}
.hep-plan-field :is(input,select){min-height:max(40px,var(--hep-hit-target))}
.hep-plan-field textarea{resize:vertical;min-height:80px}
.hep-plan-field :is(input,textarea)::placeholder{color:var(--hep-muted)}
.hep-plan-field [aria-invalid=true]{border-color:var(--hep-danger)}
.hep-plan-field-error{color:var(--hep-danger);font-size:12px}
.hep-plan-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.hep-plan-goal-fields{grid-template-columns:minmax(0,1fr)}
.hep-plan-field-grid.hep-plan-three{grid-template-columns:minmax(0,2fr) minmax(80px,1fr) minmax(0,2fr)}
.hep-plan-wide{grid-column:1/-1}

.hep-plan-training-grid{display:grid;gap:0;min-width:0}
.hep-plan-form-card{min-width:0}
.hep-plan-optional,.hep-plan-advanced{min-width:0;border-top:1px solid var(--hep-border);font-size:13px}
.hep-plan-training-grid>.hep-plan-form-card:first-child>.hep-plan-optional:first-child{border-top:0}
.hep-plan-optional>summary,.hep-plan-advanced>summary{display:flex;align-items:center;gap:12px;min-height:48px;padding:10px 0;list-style:none;cursor:pointer;font-weight:500;color:var(--hep-text)}
.hep-plan-optional>summary::-webkit-details-marker,.hep-plan-advanced>summary::-webkit-details-marker{display:none}
.hep-plan-optional>summary::after,.hep-plan-advanced>summary::after{content:'';width:7px;height:7px;flex:none;margin-right:4px;border-right:1.5px solid var(--hep-muted);border-bottom:1.5px solid var(--hep-muted);transform:rotate(45deg)}
.hep-plan-optional[open]>summary::after,.hep-plan-advanced[open]>summary::after{transform:rotate(225deg)}
.hep-plan-optional>summary small{margin-left:auto;color:var(--hep-muted);font-size:12px;line-height:1.5;font-weight:400;overflow-wrap:anywhere}
.hep-plan-advanced>summary::after{margin-left:auto}
.hep-plan-optional[open]{padding-bottom:16px}
.hep-plan-optional>:not(summary){margin-top:14px}
.hep-plan-optional>h4{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}
.hep-plan-advanced{border:0}
.hep-plan-advanced>.hep-plan-field{margin-top:6px}

.hep-plan-segmented{display:flex;gap:4px;padding:4px;border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.harness-platform .hep-plan-segmented button{flex:1;min-height:max(36px,var(--hep-hit-target));padding:6px 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--hep-muted);font-size:13px}
.harness-platform .hep-plan-segmented button[data-active=true]{border-color:var(--hep-border);background:var(--hep-surface);color:var(--hep-link);font-weight:500}
.hep-plan-hint,.hep-plan-model-meta{font-size:12px;line-height:1.7;color:var(--hep-muted)}
.hep-plan-model-suggestions{display:grid;gap:16px}
.hep-plan-model-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:18px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted)}
.hep-plan-model-row>.agent-section-heading{grid-column:1/-1;margin:0}
.hep-plan-model-row>.hep-plan-field:last-child{grid-column:1/-1}
.hep-plan-model-row strong{font-size:13px;font-weight:500}
.harness-platform .hep-plan-model-row button,.harness-platform .hep-plan-add-model{font-size:12px}
.hep-plan-add-model{justify-self:start}

.hep-plan-trace-control{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--hep-muted)}
.hep-plan-trace-control>label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--hep-text);cursor:pointer}
.hep-plan-trace-control input,.hep-plan-trace-row input{flex:none;width:16px;height:16px;accent-color:var(--hep-primary)}
.hep-plan-trace-box{min-width:0;max-height:272px;overflow:auto;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);scrollbar-width:thin}
.hep-plan-trace-row{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:start;gap:6px 10px;padding:12px;border-bottom:1px solid var(--hep-border);cursor:pointer}
.hep-plan-trace-row:last-child{border-bottom:0}.hep-plan-trace-row:has(input:checked){background:var(--hep-primary-soft)}.hep-plan-trace-row:not(:has(input:checked)):hover{background:var(--hep-surface-muted)}
.hep-plan-trace-row input{margin-top:4px}
.hep-plan-trace-row>span{font-size:13px;overflow-wrap:anywhere}
.hep-plan-trace-row small{display:block;font-size:12px;color:var(--hep-muted);margin-top:3px;overflow-wrap:anywhere}
.hep-plan-trace-row em{font-style:normal;font-size:12px;color:var(--hep-muted);padding:2px 7px;border-radius:5px;background:var(--hep-surface-muted)}
.hep-plan-trace-row em[data-status=passed]{color:var(--hep-success)}
.hep-plan-trace-row em[data-status=failed]{color:var(--hep-danger)}
.hep-plan-trace-row em[data-status=inconclusive]{color:var(--hep-warning)}
.hep-plan-trace-row time{grid-column:2/-1;font-size:12px;color:var(--hep-muted)}
.hep-plan-trace-empty{padding:16px;color:var(--hep-muted);font-size:13px}

.hep-plan-registered-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:14px;border-radius:7px;background:var(--hep-surface-muted)}
.hep-plan-registered-details>span{display:grid;gap:4px;min-width:0;font-size:13px}
.hep-plan-registered-details b{font-size:12px;color:var(--hep-muted);font-weight:400}
.hep-plan-registered-details code{font-size:12px;overflow-wrap:anywhere}
.hep-plan-connection-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hep-plan-connection-actions>span{font-size:12px;color:var(--hep-muted)}
.hep-plan-connection-actions>p{flex-basis:100%;font-size:12px;line-height:1.7}
.hep-plan-connection-actions [data-status=ssh_reachable]{color:var(--hep-success)}
.hep-plan-connection-actions [data-status=unreachable]{color:var(--hep-danger)}

.hep-plan-notice{padding:14px 16px;border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface-muted);font-size:13px;line-height:1.7;color:var(--hep-muted)}
.hep-plan-notice strong{display:block;color:var(--hep-text);font-weight:500}
.hep-plan-notice p{margin-top:4px}
.hep-plan-notice code{overflow-wrap:anywhere}
.hep-plan-error-notice{color:var(--hep-danger)}
.hep-plan-notice.hep-plan-error-notice{border-color:color-mix(in srgb,var(--hep-danger) 30%,var(--hep-border));background:color-mix(in srgb,var(--hep-danger) 4%,var(--hep-surface))}
.hep-plan-warning-notice{color:var(--hep-warning)}
.hep-plan-notice.hep-plan-warning-notice{border-color:color-mix(in srgb,var(--hep-warning) 30%,var(--hep-border));background:color-mix(in srgb,var(--hep-warning) 5%,var(--hep-surface))}
.hep-plan-blue-notice{color:var(--hep-link)}
.harness-platform .hep-plan-link{padding:0;border:0;background:transparent;color:var(--hep-link);min-height:32px;font-size:12px}
.hep-plan-notice button{margin-top:8px}
.hep-plan-pending{padding:14px 16px;border-radius:7px;background:var(--hep-surface-muted);font-size:12px;color:var(--hep-muted)}
.hep-plan-pending strong{font-weight:500;color:var(--hep-text)}
.hep-plan-pending p{margin-top:5px;line-height:1.8}
.hep-plan-low-policy{display:grid;gap:12px}
.hep-plan-low-policy h4{font-size:14px;font-weight:500}
.hep-plan-low-policy>p{font-size:12px;color:var(--hep-muted)}

.hep-plan-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:18px 28px;border-top:1px solid var(--hep-border);background:var(--hep-surface);box-shadow:none}
.hep-plan-footer>p{font-size:12px;line-height:1.6;color:var(--hep-muted)}
.hep-plan-footer>div{display:flex;align-items:center;gap:10px;flex:none}
.harness-platform .hep-plan-footer button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:max(40px,var(--hep-hit-target));padding:8px 14px;font-size:13px;white-space:nowrap}
.harness-platform .hep-plan-primary{border-color:var(--hep-primary);background:var(--hep-primary);color:#fff}
.harness-platform .hep-plan-primary:hover:enabled{border-color:var(--hep-primary-hover);background:var(--hep-primary-hover);color:#fff}

@media(max-width:600px){.hep-compute-dialog{width:calc(100vw - 24px);max-height:calc(100dvh - 24px);margin:auto;border-radius:16px}
.hep-plan-head{padding:16px}
.hep-plan-head h2{font-size:18px}
.hep-plan-top p{font-size:12px;line-height:1.6}
.hep-plan-source{margin-top:10px}
.hep-plan-body{padding:18px 16px}
.hep-plan-fields{gap:18px}
.hep-plan-mode-switch{gap:8px}
.harness-platform .hep-plan-mode-switch button{padding:13px 10px;gap:8px;align-items:flex-start}.hep-plan-mode-switch button::after{width:13px;height:13px;margin-top:3px}.hep-plan-mode-switch strong{font-size:14px}
.hep-plan-mode-switch small{font-size:12px}
.hep-plan-mode-switch .hep-plan-icon{width:16px;height:16px;margin-top:3px}
.hep-plan-field-grid,.hep-plan-field-grid.hep-plan-three,.hep-plan-model-row{grid-template-columns:minmax(0,1fr)}
.hep-plan-wide,.hep-plan-model-row>.agent-section-heading,.hep-plan-model-row>.hep-plan-field:last-child{grid-column:auto}
.hep-plan-field :is(input,select){min-height:44px}
.hep-plan-trace-control{flex-direction:column;align-items:flex-start}
.hep-plan-optional>summary small{max-width:50%;text-align:right}
.hep-plan-footer{padding:14px 16px;gap:10px;flex-direction:column;align-items:stretch}
.hep-plan-footer>div{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:8px}
.harness-platform .hep-plan-footer button{min-height:44px;padding:8px 10px}
.hep-plan-footer>p{font-size:12px}
.hep-plan-pending{padding:12px}
.hep-plan-registered-details{gap:12px}
.hep-plan-form-section{padding-bottom:18px}
}

`
