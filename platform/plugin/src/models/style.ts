// 限定在原生「设置 → 模型」的扩展区，避免影响 DSH 设置控件。
export const modelSettingsTheme = `
.hep-model-sharing{max-width:720px;margin-top:28px;padding-top:24px;border-top:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font:14px/1.55 system-ui,"Microsoft YaHei",sans-serif}
.hep-model-sharing *{box-sizing:border-box}
.hep-model-sharing h3,.hep-model-sharing h4,.hep-model-sharing p{margin:0}
.hep-model-sharing h3{font-size:17px;line-height:1.4;font-weight:600}
.hep-model-sharing h4{font-size:15px;line-height:1.5;font-weight:600}
.hep-model-sharing button,.hep-model-sharing select{font:inherit}
.hep-model-sharing button{min-height:36px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:7px 14px;background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);cursor:pointer}
.hep-model-sharing button:hover:enabled{border-color:var(--dsw-alias-button-primary-fill)}
.hep-model-sharing button:disabled{cursor:default;opacity:.55}
.hep-model-sharing button:focus-visible,.hep-model-sharing select:focus-visible,.hep-model-sharing summary:focus-visible,.hep-model-sharing input:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:2px}
.hep-model-sharing select{display:block;width:100%;min-height:40px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary)}
.hep-model-sharing input[type=checkbox]{accent-color:var(--dsw-alias-button-primary-fill);flex:none;margin:3px 0 0}
.hep-model-sharing-heading{display:flex;justify-content:space-between;align-items:start;gap:12px}
.hep-model-sharing-heading-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;min-width:90px}
.hep-model-sharing-heading p,.hep-model-sharing-intro,.hep-model-sharing-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.hep-model-sharing-intro{margin-top:6px!important}
.hep-model-sharing-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.hep-model-sharing-card{margin-top:18px;padding:20px;border:1px solid var(--hep-border,var(--dsw-alias-settings-card-stroke));border-radius:12px;background:var(--hep-surface,var(--dsw-alias-settings-card-fill))}
.hep-model-sharing-card-header{display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:12px}
.hep-model-sharing-card-header span{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.hep-model-sharing-field{display:grid;gap:6px;font-size:13px;font-weight:500}
.hep-model-sharing-field>span{color:var(--dsw-alias-label-secondary)}
.hep-model-sharing-card>.hep-model-sharing-field+.hep-model-sharing-field,.hep-model-sharing-card>.hep-model-sharing-connection-state+.hep-model-sharing-field{margin-top:14px}
.hep-model-sharing-primary{background:var(--dsw-alias-button-primary-fill)!important;border-color:var(--dsw-alias-button-primary-fill)!important;color:var(--dsw-alias-label-primary-foreground)!important}
.hep-model-sharing-status{margin-top:10px!important;font-size:12px;line-height:1.5}
.hep-model-sharing-status[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.hep-model-sharing-status[data-tone=warning]{color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.hep-model-sharing-agents{display:grid;gap:8px;margin-top:12px}
.hep-model-sharing-agent{border:1px solid var(--hep-border,var(--dsw-alias-settings-card-stroke));border-radius:8px;background:var(--hep-surface,var(--dsw-alias-settings-card-fill));overflow:hidden}
.hep-model-sharing-agent>summary{background:var(--hep-surface-muted,var(--dsw-alias-settings-card-fill));cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 16px;list-style:none}
.hep-model-sharing-agent>summary::-webkit-details-marker{display:none}
.hep-model-sharing-agent>summary::before{content:'›';font-size:20px;line-height:1;color:var(--dsw-alias-label-secondary);transition:transform .15s}
.hep-model-sharing-agent[open]>summary::before{transform:rotate(90deg)}
.hep-model-sharing-agent-title{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}
.hep-model-sharing-agent-summary{display:grid;justify-items:end;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right}
.hep-model-sharing-readiness-badge{display:inline-flex;align-items:center;max-width:100%;padding:2px 7px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:1.5}
.hep-model-sharing-readiness-badge[data-state=blocked],.hep-model-sharing-readiness-badge[data-state=runtime_check]{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-readiness-badge[data-state=ready]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.hep-model-sharing-instance-badge{display:inline-flex;align-items:center;max-width:100%;padding:2px 7px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-settings-card-fill);font-size:11px;font-weight:500;line-height:1.5}
.hep-model-sharing-instance-badge[data-state=restart_required]{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-instance-badge[data-state=current]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.hep-model-sharing-agent-body{display:grid;gap:14px;padding:16px}
.hep-model-sharing-connection-state{padding:10px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-settings-card-fill);font-size:12px;line-height:1.6}
.hep-model-sharing-connection-state strong{font-size:12px;font-weight:600}
.hep-model-sharing-connection-state p{margin-top:3px;color:var(--dsw-alias-label-secondary)}
.hep-model-sharing-connection-state[data-state=blocked],.hep-model-sharing-connection-state[data-state=runtime_check]{border-color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-connection-state[data-state=blocked] strong,.hep-model-sharing-connection-state[data-state=runtime_check] strong{color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-connection-state[data-state=ready] strong{color:var(--dsw-alias-state-success-primary)}
.hep-model-sharing-instance-state{padding:10px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-settings-card-fill);font-size:12px;line-height:1.6}
.hep-model-sharing-instance-state strong{font-size:12px;font-weight:600}
.hep-model-sharing-instance-state p{margin-top:3px;color:var(--dsw-alias-label-secondary)}
.hep-model-sharing-instance-state[data-state=restart_required]{border-color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-instance-state[data-state=restart_required] strong{color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-instance-state[data-state=current] strong{color:var(--dsw-alias-state-success-primary)}
.hep-model-sharing-instance-state ul{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;padding:0;list-style:none}
.hep-model-sharing-instance-state li{max-width:100%;padding:2px 7px;border:1px solid var(--dsw-alias-border-l3);border-radius:5px;overflow-wrap:anywhere}
.hep-model-sharing-provider{margin:0;padding:0;border:0}
.hep-model-sharing-provider legend{padding:0 0 6px;font-size:13px;font-weight:600}
.hep-model-sharing-provider-status{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.hep-model-sharing-provider-status[data-state=ready]{color:var(--dsw-alias-state-success-primary)}
.hep-model-sharing-provider-status[data-state=missing_api_key],.hep-model-sharing-provider-status[data-state=platform_only],.hep-model-sharing-provider-status[data-state=runtime_check]{color:var(--dsw-alias-state-warn-label)}
.hep-model-sharing-provider>.hep-model-sharing-note{margin-bottom:5px;font-size:11px}
.hep-model-sharing-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:7px 14px}
.hep-model-sharing-option{display:flex;align-items:flex-start;gap:8px;min-width:0;padding:6px 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;cursor:pointer}
.hep-model-sharing-option span{min-width:0;overflow-wrap:anywhere}
.hep-model-sharing-option small{display:block;color:var(--dsw-alias-label-secondary);font-size:11px}
.hep-model-sharing-failures{margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-state-warn-label);font-size:12px}
.hep-model-sharing-failures ul{margin:5px 0 0;padding-left:18px}
@media(max-width:600px){.hep-model-sharing-card{padding:14px}.hep-model-sharing-agent>summary{align-items:flex-start}.hep-model-sharing-agent-summary{max-width:48%}.hep-model-sharing-options{grid-template-columns:1fr}.hep-model-sharing-heading{align-items:flex-start}}
`
