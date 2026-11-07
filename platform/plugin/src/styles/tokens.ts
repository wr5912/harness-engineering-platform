// 平台与登录页共用语义变量；浅色保留原值，深色在同一声明中维护。
export const visualTokens = `
:root,body,.harness-platform,.harness-assistant-proposals,.harness-operation-inline{
  --hep-brand:#0075ca;--hep-primary:#0062ae;--hep-primary-hover:#004e8e;
  --hep-link:#005da8;--hep-link-hover:#004e8e;--hep-focus:#0086dd;
  --hep-surface:var(--dsw-alias-bg-layer-1,#fff);
  --hep-bg:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 97%,#0075ca);
  --hep-surface-muted:color-mix(in srgb,var(--hep-surface) 96%,#0075ca);
  --hep-primary-soft:color-mix(in srgb,var(--hep-surface) 92%,var(--hep-primary));
  --hep-text:var(--dsw-alias-label-primary,#20344c);
  --hep-muted:var(--dsw-alias-label-secondary,#607186);
  --hep-border:var(--dsw-alias-border-l3,#dfe6ee);
  --hep-success:#176c3c;--hep-warning:#805200;--hep-danger:#b42318;
  --hep-status-bg:var(--hep-surface-muted);
  --hep-flow-input-fill:#eaf3ff;--hep-flow-input-border:#8eb4df;
  --hep-flow-process-fill:#f1f4f8;--hep-flow-process-border:#a8b4c5;
  --hep-flow-condition-fill:#f2ecfb;--hep-flow-condition-border:#b5a0d8;
  --hep-flow-output-fill:#e7f4f4;--hep-flow-output-border:#87bebb;
  --hep-shadow:0 8px 28px #16395910;
  --hep-hit-target:0px;--hep-radius:12px;--hep-control-radius:8px;--hep-page-padding:32px;
  --hep-motion-fast:140ms;--hep-motion:200ms;--hep-ease:cubic-bezier(.2,.8,.2,1);
  --hep-on-primary:#fff;
}
/* 所有暗色消费者共用这一份色值；原生公开别名也引用这些变量。 */
body[data-ds-dark-theme],body[data-ds-dark-theme] :is(.harness-platform,.harness-assistant-proposals,.harness-operation-inline,.hep-detail-drawer,.hep-search-popup){
  --hep-brand:#10baff;--hep-primary:#2c53d7;--hep-primary-hover:#3d67ec;
  --hep-link:#59ccff;--hep-link-hover:#a0e8ff;--hep-focus:#40d4ff;
  --hep-bg:#020713;--hep-surface:#061629;--hep-surface-muted:#091e36;
  --hep-primary-soft:#102c4c;--hep-text:#d7e5fa;--hep-muted:#97aecf;--hep-border:#1b3c5e;
  --hep-success:#4ddbb8;--hep-warning:#f2c572;--hep-danger:#ff9a91;
  --hep-flow-input-fill:#102c48;--hep-flow-input-border:#467caa;
  --hep-flow-process-fill:#182536;--hep-flow-process-border:#536880;
  --hep-flow-condition-fill:#2c2243;--hep-flow-condition-border:#927bb8;
  --hep-flow-output-fill:#103437;--hep-flow-output-border:#4a9291;
  --hep-violet:#b2a5ff;--hep-control-bg:#041020;--hep-surface-hover:#0c2948;
  --hep-panel-bg:linear-gradient(145deg,#092039f2,#041020fa);
  --hep-popover-bg:linear-gradient(155deg,#0b2440fa,#030e20fc);
  --hep-primary-fill:linear-gradient(135deg,#214caf,#293de1);
  --hep-primary-hover-fill:linear-gradient(135deg,#2e63d6,#3d50f0);
  --hep-page-bg:radial-gradient(ellipse at 4% 0%,#123a7026,transparent 45%),radial-gradient(ellipse at 95% 4%,#492b8014,transparent 36%),var(--hep-bg);
  --hep-shadow:inset 0 1px 0 #58caff09,0 8px 28px #0004;
  --hep-dialog-shadow:0 24px 80px #000a,0 0 0 1px #328bd524,inset 0 1px 0 #81dbff12;
  --hep-backdrop:#000817b8;--hep-motion-fast:180ms;
}
@media(max-width:900px){:root,body,.harness-platform{--hep-page-padding:24px}}
@media(max-width:680px){:root,body,.harness-platform{--hep-page-padding:16px}}
@media(pointer:coarse){:root,body,.harness-platform,.harness-assistant-proposals,.harness-operation-inline{--hep-hit-target:44px}}
@keyframes hep-enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){:root,body,.harness-platform,.harness-assistant-proposals,.harness-operation-inline{--hep-motion-fast:0ms;--hep-motion:0ms}}
@media(prefers-reduced-motion:reduce){body[data-ds-dark-theme],body[data-ds-dark-theme] :is(.harness-platform,.harness-assistant-proposals,.harness-operation-inline,.hep-detail-drawer,.hep-search-popup){--hep-motion-fast:0ms;--hep-motion:0ms}}
`

// 浅色业务工作面保留现有调色；暗色值统一由上方声明提供。
export const workbenchTokens = `
.harness-platform:not([data-page=conversations]),.hep-detail-drawer,.harness-login{
  --hep-brand:#2563eb;--hep-primary:#2563eb;--hep-primary-hover:#1d4ed8;
  --hep-link:#2459cf;--hep-link-hover:#1d4ed8;--hep-focus:#3b82f6;
  --hep-bg:#f5f8fc;--hep-surface:#fff;--hep-surface-muted:#f8fafc;
  --hep-primary-soft:#edf4ff;--hep-text:#182235;--hep-muted:#66758b;--hep-border:#e3e9f2;
  --hep-radius:12px;--hep-control-radius:8px;--hep-page-padding:28px;
  --hep-shadow:0 1px 3px #182b4e05,0 4px 16px #182b4e03;
  --hep-success:#168151;--hep-warning:#8c610c;--hep-danger:#c43a40;
  font-family:HepNoto,system-ui,"Microsoft YaHei",sans-serif;line-height:1.55;
}
`
