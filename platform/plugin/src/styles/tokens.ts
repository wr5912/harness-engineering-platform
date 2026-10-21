// 平台与登录页共用的视觉规则；颜色继承 DSH 主题，业务页只消费语义变量。
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
  --hep-shadow:0 8px 28px #16395910;
  --hep-hit-target:0px;--hep-radius:12px;--hep-control-radius:8px;--hep-page-padding:32px;
  --hep-motion-fast:140ms;--hep-motion:200ms;--hep-ease:cubic-bezier(.2,.8,.2,1);
}
body[data-ds-dark-theme],body[data-ds-dark-theme] :is(.harness-platform,.harness-assistant-proposals,.harness-operation-inline){
  --hep-link:var(--dsw-alias-link,#7aaaff);--hep-link-hover:var(--dsw-alias-link,#7aaaff);
  --hep-focus:#8ac8ff;
  --hep-success:#88dfab;--hep-warning:#fbd57f;--hep-danger:#ffaca4;
}
@media(max-width:900px){:root,body,.harness-platform{--hep-page-padding:24px}}
@media(max-width:680px){:root,body,.harness-platform{--hep-page-padding:16px}}
@media(pointer:coarse){:root,body,.harness-platform,.harness-assistant-proposals,.harness-operation-inline{--hep-hit-target:44px}}
@keyframes hep-enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){:root,body,.harness-platform,.harness-assistant-proposals,.harness-operation-inline{--hep-motion-fast:0ms;--hep-motion:0ms}}
`
