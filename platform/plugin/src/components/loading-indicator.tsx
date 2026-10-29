/** 读取反馈不占用正文；可访问名称由具体工作对象提供。 */
export function LoadingIndicator({ label, block = false, className = '' }: { label: string; block?: boolean; className?: string }) {
  return <span className={`hep-loading${block ? ' hep-loading-block' : ''}${className ? ` ${className}` : ''}`} role="status" aria-label={label}>
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" opacity=".18"/><path d="M10 3a7 7 0 0 1 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
  </span>
}

export const loadingIndicatorTheme = `
.hep-loading{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;vertical-align:middle;color:var(--hep-muted,#607187);animation:hep-loading-reveal .15s step-end}
.hep-loading>svg{display:block;animation:hep-loading-turn .9s linear infinite}
.hep-loading-block{display:flex;width:100%;min-height:72px;height:auto;padding:24px 0}
@keyframes hep-loading-turn{to{transform:rotate(360deg)}}
@keyframes hep-loading-reveal{from{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){.hep-loading,.hep-loading>svg{animation:none}}
`
