import { nativeOverlayTheme } from './native-overlays.ts'

export const assistantTheme = `${nativeOverlayTheme}
/* 管理对话继续使用原生会话的布局与控件尺寸。 */
body .harness-platform[data-page=conversations],body .harness-platform :is(.harness-assistant-toggle,.harness-assistant-launch){--hep-hit-target:0px}
body:not([data-ds-dark-theme]) .harness-platform[data-page=conversations],body:not([data-ds-dark-theme]) .harness-platform :is(.harness-assistant-toggle,.harness-assistant-launch){--hep-link:var(--hep-primary);--hep-link-hover:var(--hep-primary-hover)}
.harness-platform button.harness-assistant-toggle{position:relative;z-index:1;display:grid;place-items:center;flex-shrink:0;width:38px;height:38px;min-height:38px;padding:0;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--hep-brand)}
.harness-assistant-toggle .harness-assistant-icon{display:block;width:28px;height:28px;pointer-events:none}
.harness-platform button.harness-assistant-toggle:hover:enabled{border-color:var(--hep-border);background:var(--hep-surface-muted);color:var(--hep-link)}
.harness-platform button.harness-assistant-launch{position:fixed;right:8px;bottom:8px;z-index:45;display:grid;place-items:center;width:48px;height:48px;padding:0;border:1px solid #c7e0f8;border-radius:16px;background:linear-gradient(145deg,#fff,#edf8ff);color:var(--hep-brand);box-shadow:0 8px 26px #174c8b24,0 2px 6px #174c8b0d;transition:transform .18s,box-shadow .18s,border-color .18s}
.harness-assistant-launch .harness-assistant-icon{display:block;width:36px;height:36px;pointer-events:none}
.harness-platform button.harness-assistant-launch:hover:enabled{transform:translateY(-2px);border-color:#8acaf2;background:linear-gradient(145deg,#fff,#e5f5ff);box-shadow:0 10px 30px #174c8b30,0 2px 6px #174c8b0d}
.harness-platform button.harness-assistant-launch[aria-expanded=true]{border-color:#8acaf2;box-shadow:0 0 0 3px #2ec5ff1f,0 8px 26px #174c8b24}
:is(.harness-assistant-toggle,.harness-assistant-launch)[data-status]::after{content:"";position:absolute;right:3px;bottom:3px;width:10px;height:10px;border:2px solid #fff;border-radius:50%;background:var(--hep-brand)}
:is(.harness-assistant-toggle,.harness-assistant-launch)[data-status=waiting]::after{background:#eaa127}
:is(.harness-assistant-toggle,.harness-assistant-launch)[data-status=unread]::after{background:#10b5ce}
@media(prefers-reduced-motion:reduce){.harness-platform button.harness-assistant-launch{transition:none}.harness-platform button.harness-assistant-launch:hover:enabled{transform:none}}
.harness-assistant{z-index:44;display:flex;flex-direction:column;min-height:0;background:#fff;border:1px solid #d5e0ee;border-radius:14px;box-shadow:0 12px 48px #12396326;overflow:hidden;--dsh-composer-card-max-width:100%;--dsh-conversation-content-max-width:100%}
.harness-assistant-floating{position:fixed;right:24px;bottom:88px;width:clamp(360px,30vw,480px);height:min(640px,calc(100dvh - 180px));max-width:calc(100vw - 32px)}
.harness-assistant-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:#f7faff;border-bottom:1px solid #e3ebf5;flex-shrink:0}
.harness-assistant-heading>div{display:flex;align-items:center;gap:6px}
.harness-assistant-heading>div:first-child{align-items:flex-start;flex-direction:column}
.harness-assistant-heading small{color:#71829b;font-size:11px}
.harness-assistant-heading button{font-size:12px;padding:6px 8px}
.harness-assistant-workspace{display:flex;flex:1;min-height:0;min-width:0}
.harness-assistant-chat{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#223550)}
.harness-assistant-chat>[data-conversation-content]{flex:1;min-height:0}
.harness-assistant-empty{margin:auto;text-align:center;padding:24px;max-width:100%}
.harness-assistant-empty p{color:#728299}
.harness-assistant-scope{margin:0;padding:8px 14px;border-bottom:1px solid #e3ebf5;color:#71829b;font-size:12px}
.harness-assistant-error{margin:0;padding:8px 14px;border-bottom:1px solid #f2dddd;background:#fff8f8;font-size:12px}
.harness-conversation-frame{box-sizing:border-box;padding-top:var(--harness-conversation-top);padding-left:var(--harness-conversation-left)}
.harness-platform[data-page=conversations] .harness-assistant-toggle{pointer-events:auto}
.harness-conversation-viewport{flex:1;min-height:0}
.harness-assistant-chat .harness-conversation-welcome{font-size:17px;flex-direction:column}
.harness-assistant-floating{background:var(--hep-surface);border-color:var(--hep-border);color:var(--hep-text)}
.harness-assistant-floating .harness-assistant-heading{background:var(--hep-surface-muted);border-color:var(--hep-border)}
.harness-assistant-floating .harness-assistant-heading small,.harness-assistant-floating .harness-assistant-scope,.harness-assistant-floating .harness-assistant-empty p{color:var(--hep-muted)}
.harness-assistant-floating .harness-conversation-welcome{color:var(--hep-text)}
.harness-assistant-floating .harness-assistant-scope{border-color:var(--hep-border)}
.harness-assistant-context{display:grid;gap:2px;padding:8px 14px;border-bottom:1px solid var(--hep-border);font-size:12px;color:var(--hep-muted);overflow-wrap:anywhere}
.harness-assistant-context button{justify-self:start}
.harness-assistant-context-row{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:2px 10px}
.harness-assistant-context-row span{flex:1 1 210px;min-width:0}
.harness-assistant-context-row strong{color:var(--hep-text);font-weight:600}
.harness-assistant-context-row a{flex:none;color:var(--hep-link);text-decoration:underline;text-underline-offset:2px}
.harness-assistant-context-ids>summary{cursor:pointer;color:var(--hep-link)}
.harness-assistant-context-ids dl{display:grid;gap:3px;margin:5px 0 0}
.harness-assistant-context-ids dl>div{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px}
.harness-assistant-context-ids dt{white-space:nowrap}
.harness-assistant-context-ids dd{min-width:0;margin:0}
.harness-assistant-context-ids code{user-select:all;overflow-wrap:anywhere}
body[data-ds-dark-theme] .harness-platform button.harness-assistant-launch{background:var(--hep-panel-bg,var(--hep-surface));border-color:var(--hep-border);box-shadow:var(--hep-shadow)}
body[data-ds-dark-theme] .harness-platform button.harness-assistant-launch:hover:enabled{background:var(--hep-surface-hover);border-color:var(--hep-brand);box-shadow:0 0 18px color-mix(in srgb,var(--hep-brand) 16%,transparent),var(--hep-shadow)}
body[data-ds-dark-theme] .harness-platform button.harness-assistant-launch[aria-expanded=true]{border-color:var(--hep-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--hep-brand) 12%,transparent),var(--hep-shadow)}
body[data-ds-dark-theme] :is(.harness-assistant-toggle,.harness-assistant-launch)[data-status]::after{border-color:var(--hep-surface)}
body[data-ds-dark-theme] :is(.harness-assistant-toggle,.harness-assistant-launch)[data-status=waiting]::after{background:var(--hep-warning)}
body[data-ds-dark-theme] :is(.harness-assistant-toggle,.harness-assistant-launch)[data-status=unread]::after{background:var(--hep-brand)}
body[data-ds-dark-theme] .harness-assistant{background:var(--hep-panel-bg,var(--hep-surface));border-color:var(--hep-border);color:var(--hep-text)}
body[data-ds-dark-theme] .harness-assistant{box-shadow:var(--hep-dialog-shadow,var(--hep-shadow))}
body[data-ds-dark-theme] .harness-assistant-heading{background:var(--hep-surface-muted);border-color:var(--hep-border)}
body[data-ds-dark-theme] :is(.harness-assistant-heading small,.harness-assistant-empty p,.harness-assistant-scope){color:var(--hep-muted)}
body[data-ds-dark-theme] .harness-assistant-scope{border-color:var(--hep-border)}
body[data-ds-dark-theme] .harness-assistant-error{background:color-mix(in srgb,var(--hep-danger) 8%,var(--hep-surface));border-color:color-mix(in srgb,var(--hep-danger) 25%,var(--hep-border));color:var(--hep-danger)}
body[data-ds-dark-theme] .harness-conversation-welcome{color:var(--hep-text)}
@media(max-width:1100px){.harness-assistant-floating{inset:0;right:0;bottom:0;max-width:none;width:100vw;height:100dvh;border:0;border-radius:0}.harness-platform button.harness-assistant-launch{display:none}.harness-platform button.harness-assistant-toggle{grid-column:3;grid-row:1;width:44px;height:44px;min-height:44px}.harness-assistant-toggle .harness-assistant-icon{width:34px;height:34px}.harness-platform button.harness-assistant-toggle[aria-expanded=true]{display:none}}
@media(max-width:580px){.harness-assistant-heading{padding:10px}.harness-assistant-heading strong{font-size:13px}.harness-assistant-context{padding:6px 10px}}
.harness-conversation-welcome{display:inline-flex;align-items:center;gap:12px;color:#223550;font-size:24px}
`
