import { nativeOverlayTheme } from './native-overlays.ts'

export const assistantTheme = `${nativeOverlayTheme}
/* 管理对话继续使用原生会话的布局与控件尺寸。 */
body .harness-platform[data-page=conversations],body .harness-platform :is(.harness-assistant-toggle,.harness-assistant-launch){--hep-link:var(--hep-primary);--hep-link-hover:var(--hep-primary-hover);--hep-hit-target:0px}
.harness-operation-inline{font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.harness-operation-inline>.harness-operation-result{margin:4px 0}
.harness-operation-inline summary{cursor:pointer;color:#52657c}
.harness-operation-inline summary strong{font-weight:500}
.harness-operation-inline [role=alert]{color:#b42318}
.harness-confirmation-summary p{margin:6px 0;line-height:1.6}
.harness-confirmation-summary small{display:block;line-height:1.5}
.harness-confirmation-summary .harness-instance-source{overflow-wrap:anywhere}
.harness-confirmation-summary>details{margin-top:8px}
.harness-confirmation-actions{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:8px;padding:10px 0 2px;background:#f8fbff}
.harness-confirmation-actions .harness-primary{background:#006eff;color:white;border-color:#006eff}
.harness-assistant-proposals-dock .harness-assistant-proposals{max-height:clamp(180px,calc(100dvh - var(--harness-conversation-top,160px) - 190px),520px)}
.harness-assistant-floating .harness-assistant-proposals{max-height:min(420px,calc(100dvh - 270px))}
@media(max-width:680px){.harness-assistant-proposals-dock .harness-assistant-proposals{padding:8px}.harness-assistant-proposals .harness-operation-card{margin:6px 0;padding:10px}.harness-assistant-proposals .harness-operation-card header{gap:6px}.harness-confirmation-budget{padding:6px 8px;background:#edf5ff;border-radius:6px}.harness-confirmation-actions{padding-top:8px}}
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
.harness-assistant-proposals-dock{box-sizing:border-box;width:100%;min-width:0;flex:none;padding-inline:calc(var(--dsh-composer-side-clearance) + 16px)}
.harness-assistant-proposals{box-sizing:border-box;width:100%;min-width:0;max-width:var(--dsh-chat-content-width);margin:0 auto;font-size:12px;max-height:260px;overflow:auto;border:1px solid #d9e6f6;border-radius:9px;background:#f8fbff;padding:8px 10px}
.harness-assistant-proposals>summary{cursor:pointer;color:#345071}
.harness-operation-card button{padding:8px 12px;border:1px solid #dce6f2;border-radius:7px;cursor:pointer}
.harness-operation-card{padding:14px;margin:8px 0;border:1px solid #d9e6f6;border-radius:9px;background:#f8fbff;font-size:13px;overflow-wrap:anywhere}
.harness-operation-card header{display:flex;justify-content:space-between;gap:12px}
.harness-operation-card header>span{color:#728299}
.harness-fusion-confirmation h4{margin:12px 0 6px}
.harness-fusion-confirmation p{margin:5px 0}
.harness-fusion-confirmation small{display:block;color:#728299;overflow-wrap:anywhere}
.harness-operation-result{margin:10px 0}
.harness-operation-result>summary{cursor:pointer}
.harness-operation-state{font-weight:500}
.harness-operation-card dl{margin:8px 0}
.harness-operation-card dl>div{display:grid;grid-template-columns:minmax(70px,auto) minmax(0,1fr);gap:10px;margin:6px 0}
.harness-operation-card dt{color:#728299}
.harness-operation-card dd{margin:0;min-width:0}
.harness-operation-card ul{margin:4px 0;padding-left:18px}
.harness-operation-card [role=alert]{margin-bottom:0}
.harness-assistant-chat [data-slot="conversation.hero.agentPreset"],.harness-assistant-chat [class$="_heroWorkspaceRow"]{display:none}
.harness-assistant-chat [class$="_titleGroup"]{display:none}
.harness-assistant-chat [class$="_headline"]{font-size:20px}
.harness-conversation-frame{box-sizing:border-box;padding-top:var(--harness-conversation-top);padding-left:var(--harness-conversation-left)}
.harness-platform[data-page=conversations] .harness-assistant-toggle{pointer-events:auto}
.harness-conversation-viewport{flex:1;min-height:0}
.harness-conversation-frame [class$="_titleGroup"],.harness-conversation-frame [class$="_panelList"],.harness-conversation-frame [class$="_heroWorkspaceRow"]{display:none}
.harness-conversation-frame [class$="_logoRow"]{display:contents}
.harness-conversation-frame [class$="_logoRow"] [class*="_brand"]{display:none}
.harness-conversation-frame [class$="_toggle"] [class$="_railMark"]{display:none}
.harness-conversation-frame [class$="_toggle"] [class$="_panelIcon"]{display:inline}
.harness-assistant-chat .harness-conversation-welcome{font-size:17px;flex-direction:column}
.harness-assistant-chat button,.harness-assistant-chat input,.harness-assistant-chat textarea{font:inherit}
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
.harness-assistant-floating .harness-assistant-proposals{background:var(--hep-surface-muted);border-color:var(--hep-border);color:var(--hep-text)}
.harness-assistant-floating .harness-operation-card{background:var(--hep-surface);border-color:var(--hep-border);color:var(--hep-text)}
.harness-assistant-floating .harness-operation-card header>span{color:var(--hep-muted)}
.harness-assistant-floating .harness-operation-card button{background:var(--hep-surface);border-color:var(--hep-border);color:var(--hep-text)}
.harness-assistant-floating .harness-operation-inline summary{color:var(--hep-link)}
.harness-assistant-floating .harness-operation-inline [role=alert]{color:var(--hep-danger)}
.harness-assistant-floating .harness-confirmation-actions,.harness-assistant-floating .harness-confirmation-budget{background:var(--hep-surface-muted)}
.harness-assistant-floating .harness-assistant-proposals-dock{max-height:min(40dvh,320px);overflow-y:auto}
.harness-task-card-compact{margin:0 0 8px}
.harness-task-card-compact .harness-task-goal{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:8px 0}
.harness-task-card-compact .harness-task-phase{font-weight:500;color:var(--hep-text);margin:8px 0}
.harness-task-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.harness-task-card-compact details{margin-top:8px;max-height:200px;overflow-y:auto}
.harness-task-card-compact details summary{cursor:pointer;color:var(--hep-link)}
.harness-task-card-compact details small{display:block;color:var(--hep-muted)}
@media(max-width:1100px){.harness-assistant-floating{inset:0;right:0;bottom:0;max-width:none;width:100vw;height:100dvh;border:0;border-radius:0}.harness-platform button.harness-assistant-launch{display:none}.harness-platform button.harness-assistant-toggle{grid-column:3;grid-row:1;width:44px;height:44px;min-height:44px}.harness-assistant-toggle .harness-assistant-icon{width:34px;height:34px}.harness-platform button.harness-assistant-toggle[aria-expanded=true]{display:none}}
@media(max-width:580px){.harness-assistant-heading{padding:10px}.harness-assistant-heading strong{font-size:13px}.harness-assistant-context{padding:6px 10px}.harness-assistant-floating .harness-assistant-proposals-dock{max-height:35dvh}}
@media(max-width:580px){.harness-assistant-floating [class$="_composerSeat"]{flex:1 1 auto;min-height:0}.harness-assistant-floating [class*="_composerStack"]{flex:1 1 auto;min-height:0;justify-content:flex-end}.harness-assistant-floating [class*="_composerStack"]>[class$="_root"]{flex:1 1 auto}}
.harness-conversation-welcome{display:inline-flex;align-items:center;gap:12px;color:#223550;font-size:24px}
`
