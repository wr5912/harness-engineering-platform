// DSH 0.2.1-rc.2 的设置弹窗与菜单通过 portal 挂载到 body。
// 优先使用 role、data-shortcut-modal 和 data-slot；仅设置壳层及原生字段布局
// 使用已核对的 CSS Module 语义后缀，不绑定构建 hash，不替换原生交互。
export const nativeOverlayTheme = `
body:has(.harness-platform) [role="dialog"][data-shortcut-modal="settings"]{
  box-sizing:border-box;width:880px;max-width:calc(100vw - 48px);
  height:min(800px,calc(100dvh - 48px));min-height:0;
  color:var(--hep-text);background:var(--hep-surface);
  border:1px solid var(--hep-border);border-radius:var(--hep-radius);box-shadow:var(--hep-shadow);
  --dsw-alias-state-business-primary:var(--hep-link);
  --dsw-alias-button-primary-fill:var(--hep-primary);
  --dsw-alias-button-primary-hover:var(--hep-primary-hover);
  --dsw-focus-ring-color:var(--hep-link);
}
body:has(.harness-platform) [data-shortcut-modal="settings"] > nav{
  width:188px;min-height:0;padding:20px 12px;gap:16px;
  background:var(--hep-surface-muted);border-right:1px solid var(--hep-border);
}
body:has(.harness-platform) [data-shortcut-modal="settings"] > nav button{
  flex-shrink:0;min-height:44px;border-radius:var(--hep-control-radius);
  transition:background-color var(--hep-motion-fast) var(--hep-ease),color var(--hep-motion-fast) var(--hep-ease);
}
body:has(.harness-platform) [data-shortcut-modal="settings"] > nav button[aria-current="true"]{
  color:var(--hep-link);background:var(--hep-primary-soft);font-weight:600;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] > [class$="_content"]{min-width:0;min-height:0}
body:has(.harness-platform) [data-shortcut-modal="settings"] > [class$="_content"] > [class$="_header"]{
  height:auto;min-height:64px;align-items:center;padding:10px 16px;gap:8px;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] > [class$="_content"] > [class$="_options"]{
  min-width:0;min-height:0;padding:0 24px 24px;overscroll-behavior:contain;scrollbar-gutter:stable;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] :is(button:not([role="switch"]),select){
  box-sizing:border-box;min-width:44px;min-height:44px;border-radius:var(--hep-control-radius);
}
/* 原生 Button 未输出 variant 属性；仅在 primary 按钮内配对蓝底与白字，保留开关等其他控件的前景变量。 */
body:has(.harness-platform) [data-shortcut-modal="settings"] button:is([class*="_primary_"],[class$="_primaryButton"]){
  --dsw-alias-label-primary-foreground:#fff;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] [class$="_close"]{width:44px;flex:none}
body:has(.harness-platform) [data-shortcut-modal="settings"] button[role="switch"]{
  width:60px;height:44px;border:12px solid transparent;background-clip:padding-box;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] [data-slot="settings.general.item"] [class$="_stepper"]{
  min-height:44px;padding:0 4px 0 12px;gap:8px;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] [data-slot="settings.general.item"] [class$="_arrows"]{
  position:static;flex-direction:row;opacity:1;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] :is(button,select,input):focus-visible{
  outline:2px solid var(--hep-link);outline-offset:2px;
}
body:has(.harness-platform) [data-shortcut-modal="settings"] [data-slot="settings.section"] > *{min-width:0;max-width:100%}
body:has(.harness-platform) [data-shortcut-modal="settings"] :is([class$="_rowCard"],[class$="_editor"],[class$="_card"]){border-radius:var(--hep-control-radius)}
body:has(.harness-platform) [data-shortcut-modal="settings"] :is([class$="_rowHead"],[class$="_rowActions"],[class$="_editorActions"]){flex-wrap:wrap}
body:has(.harness-platform) [data-shortcut-modal="settings"] :is([class$="_rowName"],[class$="_rowIdentity"]){min-width:0;overflow-wrap:anywhere}

/* 菜单的定位、子菜单层级与关闭行为由 DSH 保持；仅调整原生语义表面。 */
body:has(.harness-platform) [data-menu-material]:is([role="menu"],[role="group"]:has([role="menu"])){
  box-sizing:border-box;max-width:calc(100vw - 24px);padding:6px;
  color:var(--hep-text);background:var(--hep-surface);
  border:1px solid var(--hep-border);border-radius:var(--hep-radius);box-shadow:var(--hep-shadow);
  --dsw-menu-surface-fill:var(--hep-surface);--dsw-menu-backdrop-filter:none;
  --dsw-alias-interactive-bg-hover:var(--hep-primary-soft);
}
body:has(.harness-platform) [data-menu-material]:is([role="menu"],[role="group"]:has([role="menu"])) :is([role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]){
  box-sizing:border-box;min-height:44px;border-radius:var(--hep-control-radius);
  line-height:1.5;transition:background-color var(--hep-motion-fast) var(--hep-ease);
}
body:has(.harness-platform) [data-menu-material]:is([role="menu"],[role="group"]:has([role="menu"])) :is([role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]):focus-visible{
  outline:2px solid var(--hep-link);outline-offset:-2px;
}

@media(max-width:680px){
  body:has(.harness-platform) [role="dialog"][data-shortcut-modal="settings"]{
    flex-direction:column;width:calc(100vw - 24px);max-width:none;
    height:calc(100dvh - 24px);max-height:800px;
  }
  body:has(.harness-platform) [data-shortcut-modal="settings"] > nav{
    width:100%;min-width:0;max-height:none;flex:none;padding:8px 12px 10px;gap:8px;
    border-right:0;border-bottom:1px solid var(--hep-border);
  }
  body:has(.harness-platform) [data-shortcut-modal="settings"] > nav > [class$="_navTitle"]{
    min-height:44px;padding:0 4px;display:flex;align-items:center;
  }
  body:has(.harness-platform) [data-shortcut-modal="settings"] > nav > [class$="_navList"]{
    flex-direction:row;gap:6px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;padding:2px;
  }
  body:has(.harness-platform) [data-shortcut-modal="settings"] > nav button{width:max-content;padding:9px 12px;white-space:nowrap}
  body:has(.harness-platform) [data-shortcut-modal="settings"] > [class$="_content"]{width:100%}
  body:has(.harness-platform) [data-shortcut-modal="settings"] > [class$="_content"] > [class$="_header"]{
    position:absolute;top:8px;right:8px;min-height:44px;height:44px;padding:0;gap:4px;
  }
  body:has(.harness-platform) [data-shortcut-modal="settings"] > [class$="_content"] > [class$="_options"]{padding:16px;scrollbar-gutter:auto}
  body:has(.harness-platform) [data-shortcut-modal="settings"] [data-slot="settings.general.item"] :is([class$="_row"],[class$="_setting"]){flex-wrap:wrap;gap:12px}
  body:has(.harness-platform) [data-shortcut-modal="settings"] [data-slot="settings.general.item"] :is([class$="_rowText"],[class$="_settingText"]){flex:1 1 100%;padding-right:0}
  body:has(.harness-platform) [data-shortcut-modal="settings"] [data-slot="settings.general.item"] [class$="_cubeRow"]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
  body:has(.harness-platform) [data-shortcut-modal="settings"] [data-slot="settings.general.item"] [class$="_cubeRow"] > button{min-width:0;padding:16px 6px}
  body:has(.harness-platform) [data-shortcut-modal="settings"] :is([class$="_rowActions"],[class$="_editorActions"]){gap:8px}
  body:has(.harness-platform) [data-shortcut-modal="settings"] :is(input,select,textarea){min-width:0;max-width:100%}
}
`
