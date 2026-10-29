import { visualTokens } from './tokens.ts'

export const baseTheme = `${visualTokens}
.harness-platform{position:absolute;inset:0;height:100%;min-height:0;display:flex;flex-direction:column;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:var(--hep-text);background:var(--hep-bg)}
.harness-platform *{box-sizing:border-box}
.harness-platform [hidden]{display:none!important}
/* :where 降低公共控件权重；原生对话控件继续由 DSH 管理。 */
.harness-platform :where(button,input,select,textarea):not(:where(.harness-assistant-chat *)){font:inherit}
.harness-platform :where(button):not(:where(.harness-assistant-chat *)){border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);color:var(--hep-text);padding:7px 12px;min-height:max(38px,var(--hep-hit-target));cursor:pointer;transition:background-color var(--hep-motion-fast),border-color var(--hep-motion-fast),box-shadow var(--hep-motion-fast),transform var(--hep-motion-fast)}
.harness-platform :where(button):not(:where(.harness-assistant-chat *)):hover:enabled{border-color:var(--hep-primary);background:var(--hep-primary-soft);color:var(--hep-link)}
.harness-platform :where(button):not(:where(.harness-assistant-chat *)):active:enabled{transform:translateY(1px)}
.harness-platform :where(button):not(:where(.harness-assistant-chat *)):disabled{opacity:.45;cursor:default}
.harness-platform :where(button,a,input,select,textarea,summary):not(:where(.harness-assistant-chat *)):focus-visible{outline:2px solid var(--hep-focus);outline-offset:3px}
.harness-platform :where(input:not([type=checkbox]):not([type=radio]),select,textarea):not(:where(.harness-assistant-chat *)){border:1px solid var(--hep-border);border-radius:var(--hep-control-radius);background:var(--hep-surface);color:var(--hep-text);padding:8px 10px;min-width:0;max-width:100%;transition:border-color var(--hep-motion-fast),box-shadow var(--hep-motion-fast)}
.harness-platform :where(input,textarea):not(:where(.harness-assistant-chat *))::placeholder{color:var(--hep-muted);opacity:.8}
.harness-platform :where(input[type=checkbox],input[type=radio]){accent-color:var(--hep-primary)}
.harness-platform h1{font-size:24px;margin:0 0 8px}
.harness-platform h2{font-size:18px;line-height:1.4}
.harness-platform p{line-height:1.7}
.harness-platform pre{max-height:440px;overflow:auto;font-size:12px;line-height:1.7;color:var(--hep-text);background:var(--hep-surface-muted);padding:16px;border-radius:8px;overflow-wrap:anywhere}
.harness-platform table{width:100%;border-collapse:collapse;text-align:left;font-size:14px;font-variant-numeric:tabular-nums}
.harness-platform th{color:var(--hep-muted);font-weight:500;background:var(--hep-surface-muted)}
.harness-platform td,.harness-platform th{padding:12px 16px;border-bottom:1px solid var(--hep-border);overflow-wrap:anywhere;vertical-align:top}
.harness-platform td button{white-space:nowrap}
.harness-table-scroll{max-height:480px;overflow:auto;scrollbar-width:thin}
.harness-platform [role=alert]{color:var(--dsw-alias-state-error-primary,#b93838)}
.harness-topbar{min-height:76px;flex-shrink:0;display:flex;align-items:center;gap:24px;padding:0 var(--hep-page-padding);background:var(--hep-surface);border-bottom:1px solid var(--hep-border)}
.harness-brand{display:flex;gap:10px;align-items:center;flex-shrink:0}
.harness-platform .harness-brand{color:var(--hep-text);text-decoration:none}
.harness-platform .harness-brand:hover{color:var(--hep-text);text-decoration:none}
.harness-brand strong{display:block;font-size:17px;font-weight:700;line-height:1.3;white-space:nowrap}
.harness-brand small{display:block;font-size:9px;line-height:1.6;color:var(--hep-muted);letter-spacing:.09em}
.harness-nav{display:flex;align-items:stretch;gap:4px;min-width:0;align-self:stretch;overflow-x:auto;scrollbar-width:thin}
.harness-topbar>.harness-nav{flex:1}
.harness-platform .harness-nav button{position:relative;flex-shrink:0;white-space:nowrap;border:0;border-radius:0;background:transparent;padding:0 12px;color:var(--hep-muted);font-size:13px}
.harness-platform .harness-nav button:hover:enabled{border:0;background:var(--hep-surface-muted);color:var(--hep-link)}
.harness-platform .harness-nav button[aria-current=page]{color:var(--hep-link);background:transparent;font-weight:700}
.harness-nav button[aria-current=page]::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:var(--hep-brand)}
.harness-current-module,.harness-menu-navigation,.harness-menu-icon{display:none}
.harness-platform .harness-theme-toggle{display:grid;place-items:center;flex-shrink:0;width:38px;height:38px;min-height:38px;padding:0;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--hep-text)}
.harness-platform .harness-theme-toggle:hover:enabled{border-color:var(--hep-border);background:var(--hep-surface-muted);color:var(--hep-link)}
.harness-account{margin-left:auto;color:var(--hep-muted);flex-shrink:0}
.harness-account-toggle{display:none}
.harness-account-actions{display:flex;align-items:center;gap:10px}
.harness-account-menu-label{font-size:12px}
.harness-account-name{display:block;max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.harness-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--hep-primary-soft);color:var(--hep-link)}
.harness-body{display:flex;flex:1;min-width:0;min-height:0}
.harness-content{position:relative;flex:1;min-width:0;min-height:0;overflow:auto;scrollbar-width:thin}
.harness-platform[data-page=conversations] .harness-breadcrumb{padding:18px var(--hep-page-padding) 0;color:var(--hep-muted);font-size:12px}
@media(max-width:680px){.harness-platform[data-page=conversations] .harness-breadcrumb{display:none}}
@media(min-width:1101px){.harness-platform :is(.harness-agents,.harness-evaluation,.harness-instances-page,.harness-mcp-page){--hep-page-padding:36px;max-width:1360px;margin-inline:auto}}

.harness-page-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.harness-page-heading p{margin:0;color:var(--hep-muted)}
.harness-card{border:1px solid var(--hep-border);background:var(--hep-surface);border-radius:var(--hep-radius);padding:24px;min-width:0}
.harness-platform .harness-primary{background:var(--hep-primary);color:#fff;border-color:var(--hep-primary);font-weight:500}
.harness-platform .harness-primary:hover:enabled{background:var(--hep-primary-hover);border-color:var(--hep-primary-hover);color:#fff;box-shadow:0 3px 10px color-mix(in srgb,var(--hep-primary) 22%,transparent)}
.harness-section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}
.harness-section-heading h2{margin:0}
.harness-section-heading button{border:0;font-size:12px;color:var(--hep-link);background:transparent}
.harness-run-row{display:flex;align-items:center;gap:12px;padding:16px 0;border-bottom:1px solid var(--hep-border)}
.harness-run-row>div{min-width:0;flex:1}
.harness-run-row strong{display:block;font-size:14px;overflow-wrap:anywhere}
.harness-run-row small{display:block;color:var(--hep-muted);font-size:12px;margin-top:4px}
.harness-run-state{font-size:12px;background:var(--hep-status-bg);color:var(--hep-text);border-radius:6px;padding:4px 8px;flex-shrink:0}
.harness-run-state[data-status=passed]{color:var(--hep-success)}
.harness-run-state[data-status=failed],.harness-run-state[data-status=error]{color:var(--hep-danger)}
.harness-run-state[data-status=waiting],.harness-run-state[data-status=unknown],.harness-run-state[data-status=inconclusive],.harness-run-state[data-status=paused]{color:var(--hep-warning)}
.harness-run-state[data-status=running],.harness-run-state[data-status=queued],.harness-run-state[data-status=recovering]{color:var(--hep-link)}
.harness-guide{color:var(--hep-muted);background:var(--hep-surface-muted);padding:16px;border-radius:8px;margin-top:16px;line-height:1.8;font-size:12px}
.harness-source{font-size:12px;color:var(--hep-muted);margin-top:18px;overflow-wrap:anywhere}
.harness-fields{margin:8px 0;overflow-wrap:anywhere}.harness-fields>div{margin:10px 0}.harness-fields dt{font-size:12px;color:var(--hep-muted)}.harness-fields dd{margin:4px 0 0}
.harness-password-field{display:flex;align-items:center;position:relative;min-width:0}.harness-platform .harness-password-field input{width:100%;padding-right:calc(max(36px,var(--hep-hit-target)) + 8px)}.harness-platform .harness-password-field button{position:absolute;right:4px;display:grid;place-items:center;width:max(36px,var(--hep-hit-target));min-height:max(36px,var(--hep-hit-target));padding:4px;border:0;background:transparent;color:var(--hep-muted)}
.harness-platform[data-page=conversations]{background:transparent;pointer-events:none}.harness-platform[data-page=conversations] .harness-topbar{pointer-events:auto}.harness-platform[data-page=conversations] .harness-content{display:flex;flex-direction:column;overflow:hidden}
.harness-platform dialog::backdrop{background:#10283e52}
@media(prefers-reduced-motion:no-preference){.harness-platform dialog[open]{animation:hep-enter var(--hep-motion) var(--hep-ease)}}
@media(max-width:1100px){.harness-topbar{min-height:66px;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:10px;padding:0 20px}.harness-topbar>.harness-nav{display:none}.harness-current-module{display:flex;align-items:center;grid-column:2;grid-row:1;max-width:10ch;padding-left:10px;border-left:1px solid var(--hep-border);color:var(--hep-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.harness-brand{min-width:0}.harness-platform .harness-theme-toggle{grid-column:3;grid-row:1;width:44px;height:44px;min-height:44px}.harness-platform:not([data-page=home]) .harness-theme-toggle{display:none}.harness-account{grid-column:4;grid-row:1;position:relative;margin-left:0}.harness-account-toggle{display:grid;place-items:center;width:44px;height:44px;min-height:44px;padding:0;border:1px solid transparent;border-radius:9px;color:var(--hep-link);background:transparent;cursor:pointer}.harness-account-toggle:hover{background:var(--hep-surface-muted);border-color:var(--hep-border)}.harness-account-toggle:focus-visible{outline:2px solid var(--hep-focus);outline-offset:3px}.harness-account-toggle>.harness-avatar,.harness-account-menu-label{display:none}.harness-menu-icon{display:block;font-size:23px;line-height:1}.harness-account-actions{display:none;position:absolute;top:calc(100% + 8px);right:0;z-index:30;min-width:min(320px,calc(100vw - 32px));padding:12px;flex-wrap:wrap;gap:8px;background:var(--hep-surface);border:1px solid var(--hep-border);border-radius:var(--hep-radius);box-shadow:0 12px 32px #10283e24}.harness-account-actions[data-open=true]{display:flex}.harness-menu-navigation{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%;padding-bottom:10px;border-bottom:1px solid var(--hep-border)}.harness-platform .harness-menu-navigation button{min-width:0;text-align:center;padding:7px 4px;font-size:12px}.harness-platform .harness-menu-navigation button[aria-current=page]{color:var(--hep-link);background:var(--hep-primary-soft);border-color:var(--hep-primary-soft);font-weight:600}.harness-account-actions>.harness-avatar{display:grid}.harness-account-name{flex:1;max-width:none;white-space:normal;overflow-wrap:anywhere;align-self:center}.harness-account-actions form{margin-left:auto}}
@media(max-width:680px){.harness-topbar{min-height:62px;padding:0 14px;gap:8px}.harness-brand{gap:6px}.harness-brand img{width:29px;height:32px}.harness-brand strong{font-size:13px;white-space:nowrap;line-height:1.25}.harness-brand small{font-size:7px;letter-spacing:.05em}.harness-current-module{max-width:8ch;padding-left:9px;font-size:11px}.harness-account{font-size:12px;min-width:0}.harness-account-toggle{width:40px;height:40px;min-height:40px}.harness-account-actions button{padding:6px 8px}.harness-card{padding:16px}.harness-run-row{flex-wrap:wrap}}
@media(pointer:coarse){.harness-platform :where(button,input:not([type=checkbox]):not([type=radio]),select):not(:where(.harness-assistant-chat *)){min-height:44px}}
@media(prefers-reduced-motion:reduce){.harness-platform :where(button):not(:where(.harness-assistant-chat *)):active:enabled{transform:none}}
`
