// 策划弹窗只使用平台语义色；选择页与配置页共用固定头尾和内部滚动区。
export const computePlanningTheme = `
.hep-compute-dialog{
  width:min(1080px,calc(100vw - 46px));max-width:none;max-height:calc(100dvh - 46px);
  margin:auto;padding:0;overflow:hidden;border:1px solid var(--hep-border);border-radius:16px;
  background:var(--hep-surface);color:var(--hep-text);box-shadow:0 18px 70px #112d4d29;
  font-size:14px;line-height:1.65
}
.hep-compute-dialog[open]{display:flex;flex-direction:column}
.hep-compute-dialog.hep-plan-config{width:min(1160px,calc(100vw - 46px))}
.hep-compute-dialog::backdrop{background:#152c485c;backdrop-filter:blur(2px)}
.hep-compute-dialog *{box-sizing:border-box}
.hep-compute-dialog :is(h2,h3,h4,p){margin:0}
.hep-compute-dialog :is(button,input,select,textarea){font:inherit}
.hep-compute-dialog :is(button,summary,input,select,textarea){touch-action:manipulation}
.hep-compute-dialog :is(button,input,select,textarea,summary):focus-visible{outline:3px solid var(--hep-focus);outline-offset:3px}
.hep-compute-dialog button{cursor:pointer}
.hep-compute-dialog button:disabled{cursor:not-allowed;opacity:.55}
.hep-plan-icon{width:18px;height:18px;flex:none;vertical-align:middle}
.hep-plan-head{padding:24px 27px 15px;border-bottom:1px solid var(--hep-border);flex:none}
.hep-plan-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.hep-plan-top-actions{display:flex;align-items:center;gap:8px;flex:none}
.hep-plan-head h2{font-size:22px;line-height:1.4;font-weight:650}
.hep-plan-head h2:focus{outline:none}
.hep-plan-head h2:focus-visible{outline:3px solid var(--hep-focus);outline-offset:4px}
.hep-plan-top p{font-size:13px;color:var(--hep-muted);margin-top:5px}
.harness-platform .hep-plan-close,.hep-plan-close,.harness-platform .hep-plan-theme,.hep-plan-theme{display:grid;place-items:center;width:36px;height:36px;min-height:36px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--hep-text);flex:none}
.harness-platform .hep-plan-close:hover:enabled,.hep-plan-close:hover:enabled,.harness-platform .hep-plan-theme:hover:enabled,.hep-plan-theme:hover:enabled{background:var(--hep-surface-muted);border-color:var(--hep-border)}
.hep-plan-stepper{display:flex;align-items:center;gap:14px;margin-top:19px;color:var(--hep-muted);font-size:13px}
.hep-plan-stepper>span{display:flex;align-items:center;gap:7px;white-space:nowrap}
.hep-plan-stepper b{display:grid;place-items:center;width:22px;height:22px;border:1px solid var(--hep-border);border-radius:50%;background:var(--hep-surface-muted);font-size:11px;font-weight:600}
.hep-plan-stepper>span[data-active=true]{color:var(--hep-link);font-weight:650}
.hep-plan-stepper>span[data-active=true] b{color:#fff;background:var(--hep-primary);border-color:var(--hep-primary)}
.hep-plan-stepper>i{width:42px;height:1px;background:var(--hep-border)}
.hep-plan-stepper>em,.hep-plan-source>em,.hep-plan-form-section h3>em{display:inline-flex;align-items:center;border-radius:5px;background:var(--hep-primary-soft);color:var(--hep-link);font-style:normal;font-size:11px;padding:3px 8px}
.harness-platform .hep-plan-link,.hep-plan-link{border:0;background:transparent;padding:0;min-height:0;color:var(--hep-link);text-decoration:underline;text-underline-offset:3px}
.hep-plan-source{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:13px;color:var(--hep-muted)}
.hep-plan-source strong{font-weight:600;color:var(--hep-text)}
.hep-plan-source details{position:relative}
.hep-plan-source summary{cursor:pointer;color:var(--hep-link);font-size:11px}
.hep-plan-source code{display:block;max-width:min(440px,80vw);overflow-wrap:anywhere;padding:6px 9px;border:1px solid var(--hep-border);border-radius:6px;background:var(--hep-surface-muted);color:var(--hep-muted)}
.hep-plan-body{overflow:auto;overflow-anchor:none;overscroll-behavior:contain;padding:23px 27px;min-height:0;flex:1;scrollbar-width:thin}
.hep-plan-choose-lead{margin-bottom:17px}
.hep-plan-choose-lead h3{font-size:15px;margin-bottom:3px;font-weight:650}
.hep-plan-choose-lead p{font-size:13px;color:var(--hep-muted)}
.hep-plan-type-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}
.hep-plan-type-card{position:relative;display:flex;flex-direction:column;min-width:0;padding:21px;border:1.5px solid var(--hep-muted);border-radius:12px;background:var(--hep-surface);cursor:pointer}
.hep-plan-type-card:hover{border-color:var(--hep-primary);background:var(--hep-surface-muted)}
.hep-plan-type-card[data-selected=true]{padding:20.5px;border:2px solid var(--hep-primary);background:var(--hep-primary-soft);box-shadow:0 0 0 3px #0075ca0c}
.hep-plan-type-card>input[type=radio]{position:absolute;width:1px;height:1px;opacity:0}
.hep-plan-type-card:focus-within{outline:3px solid var(--hep-focus);outline-offset:3px}
.hep-plan-type-heading{display:flex;align-items:center;gap:12px;margin-bottom:15px}
.hep-plan-type-icon{display:grid;place-items:center;width:43px;height:43px;flex:none;border-radius:10px;background:var(--hep-primary-soft);color:var(--hep-link)}
.hep-plan-type-icon .hep-plan-icon{width:20px;height:20px}
.hep-plan-type-card[data-selected=true] .hep-plan-type-icon{background:var(--hep-surface)}
.hep-plan-type-heading>div{min-width:0}
.hep-plan-type-heading h3{font-size:21px;line-height:1.35;font-weight:650}
.hep-plan-type-heading p{font-size:13px;color:var(--hep-muted);margin-top:3px}
.hep-plan-radio-mark{width:20px;height:20px;border:1.5px solid var(--hep-muted);border-radius:50%;margin-left:auto;flex:none}
.hep-plan-type-card[data-selected=true] .hep-plan-radio-mark{border:6px solid var(--hep-primary);background:var(--hep-surface)}
.hep-plan-type-desc{font-size:14px;line-height:1.85;color:var(--hep-muted);min-height:78px}
.hep-plan-route-list{display:grid;gap:11px;list-style:none;margin:17px 0 13px;padding:0}
.hep-plan-route-list li{display:flex;align-items:flex-start;gap:8px;font-size:14px}
.hep-plan-route-list i{display:grid;place-items:center;width:20px;height:20px;flex:none;margin-top:1px;border:1px solid var(--hep-border);border-radius:50%;background:var(--hep-surface-muted);font-size:11px;font-style:normal}
.hep-plan-route-list strong{font-weight:600}
.hep-plan-route-list small{display:block;font-size:13px;line-height:1.75;color:var(--hep-muted);margin-top:1px}
.hep-plan-type-foot{border-top:1px solid var(--hep-border);margin-top:auto;padding-top:13px;font-size:13px}
.hep-plan-choose-notes{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:17px}
.hep-plan-choose-notes p{font-size:13px;line-height:1.8;color:var(--hep-muted)}
.hep-plan-choose-notes strong{color:var(--hep-text)}
.hep-plan-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:15px 27px;border-top:1px solid var(--hep-border);background:var(--hep-surface)}
.hep-plan-footer>p{max-width:500px;font-size:13px;color:var(--hep-muted)}
.hep-plan-footer>p strong{font-weight:600;color:var(--hep-text)}
.hep-plan-footer>div{display:flex;align-items:center;gap:9px;flex:none}
.harness-platform .hep-plan-footer button,.hep-plan-footer button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:39px;padding:8px 14px;border:1px solid var(--hep-border);border-radius:8px;background:var(--hep-surface);color:var(--hep-text);font-size:13px;font-weight:600;white-space:nowrap}
.harness-platform .hep-plan-footer button:hover:enabled,.hep-plan-footer button:hover:enabled{border-color:var(--hep-primary);background:var(--hep-primary-soft);color:var(--hep-link)}
.harness-platform .hep-plan-footer .hep-plan-primary,.hep-plan-footer .hep-plan-primary{border-color:var(--hep-primary);background:var(--hep-primary);color:#fff}
.harness-platform .hep-plan-footer .hep-plan-primary:hover:enabled,.hep-plan-footer .hep-plan-primary:hover:enabled{background:var(--hep-primary-hover);color:#fff}
.hep-plan-config-layout{display:grid;grid-template-columns:minmax(0,1fr) 238px;gap:23px;align-items:start}
.hep-plan-config-main{display:flex;flex-direction:column;gap:19px;min-width:0}
.hep-plan-fields{display:flex;flex-direction:column;gap:19px;min-width:0;border:0;margin:0;padding:0}
.hep-plan-fields[disabled]{opacity:.76}
.hep-plan-form-section>h3{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:15px;font-weight:650}
.hep-plan-form-section>h3>span{padding:2px 5px;border-radius:5px;background:var(--hep-primary-soft);color:var(--hep-link);font-size:10px;font-weight:700}
.hep-plan-form-section>h3>small{font-size:11px;font-weight:400;color:var(--hep-muted)}
.hep-plan-field-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:11px 14px}
.hep-plan-field-grid.hep-plan-three{grid-template-columns:1.5fr .7fr 1fr}
.hep-plan-wide{grid-column:1/-1}
.hep-plan-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:13px;font-weight:550}
.hep-plan-field small{display:inline;font-size:12px;font-weight:400;color:var(--hep-muted)}
.hep-plan-field :is(input,select,textarea){width:100%;min-width:0;min-height:42px;padding:8px 10px;border:1px solid var(--hep-muted);border-radius:7px;background:var(--hep-surface);color:var(--hep-text);font-size:14px;font-weight:400}
.hep-plan-field textarea{resize:vertical;line-height:1.7;min-height:62px}
.hep-plan-field :is(input,select,textarea)[aria-invalid=true]{border-color:var(--hep-danger);background:color-mix(in srgb,var(--hep-surface) 93%,var(--hep-danger))}
.hep-plan-field :is(input,textarea)::placeholder{color:var(--hep-muted);opacity:1}
.hep-plan-field-error,.hep-plan-error{display:block;font-size:12px;color:var(--hep-danger);font-weight:400}
.hep-plan-readonly{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:42px;font-weight:400}
.hep-plan-readonly strong{font-weight:600}
.hep-plan-readonly em{padding:3px 8px;border-radius:5px;background:var(--hep-primary-soft);color:var(--hep-link);font-size:11px;font-style:normal}
.hep-plan-trace-box{border:1px solid var(--hep-border);border-radius:9px;overflow:hidden}
.hep-plan-trace-box[aria-invalid=true]{border-color:var(--hep-danger)}
.hep-plan-trace-row{display:flex;align-items:center;gap:9px;min-width:0;padding:10px 11px;border-bottom:1px solid var(--hep-border);font-size:13px;cursor:pointer}
.hep-plan-trace-row:last-child{border-bottom:0}
.hep-plan-trace-row[data-disabled=true]{opacity:.55;cursor:default}
.hep-plan-trace-row>input{width:16px;height:16px;flex:none;accent-color:var(--hep-primary)}
.hep-plan-trace-row>span{min-width:0;flex:1;overflow-wrap:anywhere}
.hep-plan-trace-row code{font-size:11px;color:var(--hep-muted)}
.hep-plan-trace-row em{display:inline-flex;align-items:center;padding:3px 7px;border-radius:5px;background:var(--hep-surface-muted);color:var(--hep-muted);font-size:11px;font-style:normal;white-space:nowrap}
.hep-plan-trace-row em[data-status=failed]{color:var(--hep-danger)}
.hep-plan-trace-row em[data-status=passed]{color:var(--hep-success)}
.hep-plan-trace-row em[data-status=inconclusive]{color:var(--hep-warning)}
.hep-plan-trace-row em[data-status=running]{color:var(--hep-link)}
.hep-plan-trace-row>time{font-size:11px;color:var(--hep-muted);white-space:nowrap}
.hep-plan-trace-empty{padding:16px;color:var(--hep-muted);font-size:13px}
.hep-plan-trace-details{margin-top:8px;color:var(--hep-muted);font-size:12px}
.hep-plan-trace-details summary{width:max-content;cursor:pointer;color:var(--hep-link)}
.hep-plan-trace-details code{display:block;max-width:100%;margin-top:6px;overflow-wrap:anywhere}
.hep-plan-trace-control{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px;color:var(--hep-muted);font-size:12px}
.hep-plan-trace-control label{display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--hep-text)}
.hep-plan-trace-control input{width:16px;height:16px;accent-color:var(--hep-primary)}
.hep-plan-training-grid{display:grid;grid-template-columns:.8fr 1.2fr;gap:12px}
.hep-plan-form-card{min-width:0;padding:14px;border:1px solid var(--hep-border);border-radius:9px;background:var(--hep-surface)}
.hep-plan-form-card h4{display:flex;align-items:center;gap:7px;margin-bottom:12px;font-size:14px;font-weight:650}
.hep-plan-form-card h4 .hep-plan-icon{color:var(--hep-link)}
.hep-plan-form-card .hep-plan-field-grid{margin-top:10px}
.hep-plan-form-card>.hep-plan-field{margin-top:12px}
.hep-plan-model-meta{display:inline-flex;margin-top:10px;padding:3px 8px;border:1px solid color-mix(in srgb,var(--hep-warning) 32%,var(--hep-border));border-radius:5px;background:color-mix(in srgb,var(--hep-surface) 91%,var(--hep-warning));color:var(--hep-warning);font-size:11px}
.hep-plan-segmented{display:flex;gap:3px;padding:3px;margin-bottom:12px;border:1px solid var(--hep-border);border-radius:7px;background:var(--hep-surface-muted)}
.harness-platform .hep-plan-segmented button,.hep-plan-segmented button{flex:1;min-height:36px;padding:6px 5px;border:0;border-radius:5px;background:transparent;color:var(--hep-muted);font-size:12px;white-space:nowrap}
.harness-platform .hep-plan-segmented button[data-active=true],.hep-plan-segmented button[data-active=true]{background:var(--hep-surface);color:var(--hep-link);box-shadow:0 1px 4px #143b6412;font-weight:650}
.hep-plan-hint{margin-top:9px;font-size:12px;color:var(--hep-muted);line-height:1.7}
.hep-plan-connection-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px}
.harness-platform .hep-plan-connection-actions button,.hep-plan-connection-actions button{min-height:32px;padding:5px 10px;font-size:12px}
.hep-plan-connection-actions>span{font-size:12px;color:var(--hep-muted)}
.hep-plan-connection-actions>p{width:100%;padding:8px 10px;border:1px solid var(--hep-border);border-radius:7px;background:var(--hep-surface-muted);color:var(--hep-muted);font-size:12px}
.hep-plan-connection-actions>p.hep-plan-error-notice{border-color:var(--hep-danger);color:var(--hep-danger)}
.hep-plan-connection-actions>p.hep-plan-warning-notice{border-color:var(--hep-warning);color:var(--hep-warning)}
.hep-plan-connection-actions>p[data-status=ssh_reachable]{border-color:color-mix(in srgb,var(--hep-success) 35%,var(--hep-border));color:var(--hep-success)}
.hep-plan-connection-actions>p[data-status=unreachable]{border-color:color-mix(in srgb,var(--hep-danger) 35%,var(--hep-border));color:var(--hep-danger)}
.hep-plan-connection-actions>p[data-status=port_reachable_unverified],.hep-plan-connection-actions>p[data-status=unknown]{border-color:color-mix(in srgb,var(--hep-warning) 35%,var(--hep-border));color:var(--hep-warning)}
.hep-plan-registered-details{display:grid;grid-template-columns:1fr 1fr;gap:9px 12px;margin-top:12px;font-size:13px}
.hep-plan-registered-details span{display:flex;flex-direction:column;gap:3px;min-width:0}
.hep-plan-registered-details b{font-size:12px;color:var(--hep-muted);font-weight:500}
.hep-plan-registered-details code{overflow-wrap:anywhere;font-size:12px}
.hep-plan-registered-details .hep-plan-wide{grid-column:1/-1}
.hep-plan-notice{padding:11px 13px;border:1px solid var(--hep-border);border-radius:8px;background:var(--hep-surface-muted);color:var(--hep-muted);font-size:12px;line-height:1.75}
.hep-plan-notice strong{display:block;color:var(--hep-text)}
.hep-plan-notice p{margin-top:4px}
.hep-plan-blue-notice{border-color:color-mix(in srgb,var(--hep-primary) 30%,var(--hep-border));background:var(--hep-primary-soft);color:var(--hep-link)}
.hep-plan-warning-notice{border-color:color-mix(in srgb,var(--hep-warning) 38%,var(--hep-border));background:color-mix(in srgb,var(--hep-surface) 91%,var(--hep-warning));color:var(--hep-warning)}
.hep-plan-error-notice{border-color:color-mix(in srgb,var(--hep-danger) 38%,var(--hep-border));background:color-mix(in srgb,var(--hep-surface) 92%,var(--hep-danger));color:var(--hep-danger)}
.hep-plan-notice code{overflow-wrap:anywhere}
.harness-platform .hep-plan-notice button,.hep-plan-notice button{margin-top:8px;min-height:32px;padding:5px 10px;font-size:12px}
.hep-plan-summary{position:sticky;top:0;min-width:0;padding:16px;border:1px solid var(--hep-border);border-radius:10px;background:var(--hep-surface-muted)}
.hep-plan-summary>small{font-size:11px;color:var(--hep-link);font-weight:700}
.hep-plan-summary>h3{margin-top:5px;font-size:18px;font-weight:650}
.hep-plan-summary>p{margin-top:3px;color:var(--hep-muted);font-size:13px}
.hep-plan-summary dl{display:grid;gap:0;margin:14px 0}
.hep-plan-summary dl>div{display:grid;grid-template-columns:80px minmax(0,1fr);gap:8px;padding:8px 0;border-bottom:1px solid var(--hep-border);font-size:13px}
.hep-plan-summary dt{color:var(--hep-muted);font-size:12px}
.hep-plan-summary dd{margin:0;overflow-wrap:anywhere}
.hep-plan-summary .hep-plan-notice{font-size:12px}
.hep-plan-pending{margin-top:14px;font-size:12px;line-height:1.75}
.hep-plan-pending ul{padding-left:18px;margin:6px 0 0;color:var(--hep-muted)}
.hep-plan-low-route{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.hep-plan-low-route>div{min-width:0;padding:12px;border:1px solid var(--hep-border);border-radius:8px;background:var(--hep-surface-muted)}
.hep-plan-low-route .hep-plan-icon{color:var(--hep-link)}
.hep-plan-low-route strong{display:block;margin:8px 0 3px;font-size:13px}
.hep-plan-low-route p{font-size:13px;color:var(--hep-muted)}
.hep-plan-low-policy{margin:13px 0;padding:14px;border:1px solid var(--hep-border);border-radius:8px}
.hep-plan-low-policy h4{font-size:14px;margin-bottom:10px}
.hep-plan-low-policy p{margin-top:8px;color:var(--hep-muted);font-size:12px}
.hep-plan-advanced{font-size:12px;color:var(--hep-muted)}
.hep-plan-advanced summary{width:max-content;max-width:100%;cursor:pointer}
.hep-plan-advanced .hep-plan-field{margin-top:10px;color:var(--hep-text)}
.hep-plan-summary-advanced{white-space:pre-wrap}
@media(max-width:960px){
  .hep-plan-config-layout{grid-template-columns:1fr}
  .hep-plan-summary{display:none}
  .hep-compute-dialog{max-height:calc(100dvh - 32px);width:min(100%,calc(100vw - 32px))}
  .hep-compute-dialog.hep-plan-config{width:min(100%,calc(100vw - 32px))}
  .hep-plan-footer>p{max-width:44%}
}
@media(max-width:600px){
  .hep-compute-dialog,.hep-compute-dialog.hep-plan-config{width:100vw;max-height:calc(100dvh - 28px);margin:auto 0 0;border-radius:14px 14px 0 0;border-bottom:0}
  .hep-plan-head{padding:16px 17px 11px}
  .hep-plan-head h2{font-size:19px}
  .hep-plan-top p{font-size:12px}
  .hep-plan-config .hep-plan-top p{display:none}
  .hep-plan-stepper{gap:9px;margin-top:13px;font-size:12px}
  .hep-plan-stepper>i{width:24px}
  .hep-plan-source{font-size:12px;gap:6px}
  .hep-plan-source details{display:none}
  .hep-plan-body{padding:18px 17px}
  .hep-plan-type-grid,.hep-plan-choose-notes{grid-template-columns:1fr;gap:13px}
  .hep-plan-choose-lead p{font-size:11px;line-height:1.6}
  .hep-plan-type-card{padding:17px}
  .hep-plan-type-card[data-selected=true]{padding:16.5px}
  .hep-plan-type-desc{min-height:0;font-size:13px}
  .hep-plan-type-heading h3{font-size:19px}
  .hep-plan-type-heading p{font-size:12px}
  .hep-plan-route-list{gap:11px;margin:15px 0}
  .hep-plan-route-list li{font-size:13px}
  .hep-plan-route-list small{font-size:12px}
  .hep-plan-type-foot,.hep-plan-choose-notes p{font-size:12px}
  .hep-plan-footer{display:block;padding:10px 16px max(12px,env(safe-area-inset-bottom))}
  .hep-plan-footer>p{max-width:none;font-size:12px;margin-bottom:8px}
  .hep-plan-footer>div{display:grid;grid-template-columns:1fr 1.25fr;gap:8px}
  .harness-platform .hep-plan-footer button,.hep-plan-footer button{white-space:normal;min-height:44px;padding:7px 9px;font-size:12px}
  .hep-plan-field-grid,.hep-plan-field-grid.hep-plan-three{grid-template-columns:1fr}
  .hep-plan-wide{grid-column:auto}
  .hep-plan-field :is(input,select,textarea){font-size:16px;min-height:44px}
  .hep-plan-form-section>h3{font-size:14px;flex-wrap:wrap}
  .hep-plan-training-grid{grid-template-columns:1fr}
  .hep-plan-segmented button{min-height:42px}
  .hep-plan-trace-row{flex-wrap:wrap;gap:7px;padding:10px;font-size:13px}
  .hep-plan-trace-row>input{margin:0;width:17px;height:17px}
  .hep-plan-trace-row>span{flex-basis:calc(100% - 28px)}
  .hep-plan-trace-row>em{margin-left:23px}
  .hep-plan-trace-row>time{font-size:11px}
  .hep-plan-low-route{grid-template-columns:1fr}
  .hep-plan-low-route>div{display:grid;grid-template-columns:24px 1fr;gap:3px 8px}
  .hep-plan-low-route .hep-plan-icon{grid-row:1/3}
  .hep-plan-low-route strong{margin:0}
  .hep-plan-low-route p{grid-column:2}
}
@media(prefers-reduced-motion:reduce){.hep-compute-dialog *{scroll-behavior:auto!important}}
`
