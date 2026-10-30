import { renderToStaticMarkup } from 'react-dom/server'
import { PlatformLogo } from './logo.tsx'
import logo from '../assets/harness-logo.svg'
import { PLATFORM_SLOGAN } from './home-entry.ts'
import { visualTokens, workbenchTokens } from './styles/tokens.ts'

export function loginPage(action: string, error = ''): string {
  return '<!doctype html>' + renderToStaticMarkup(<html lang="zh-CN">
    <head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>登录 · Harness工程平台</title><link rel="icon" type="image/svg+xml" href={logo} /><style>{`
      ${visualTokens}
      ${workbenchTokens}
      *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;color-scheme:light;
        padding:32px;background:radial-gradient(ellipse at 20% 25%,#dfefff 0%,transparent 50%),var(--hep-bg);color:var(--hep-text);font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif}
      .login-shell{width:min(100%,960px);display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}.login-story{padding:24px 0}.login-wordmark{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:600}.login-story h2{margin:40px 0 16px;font-size:40px;line-height:1.4;letter-spacing:-.04em;font-weight:600}.login-story>p{max-width:350px;color:var(--hep-muted);font-size:15px;line-height:1.9}.login-phases{display:flex;gap:20px;flex-wrap:wrap;margin-top:36px;color:var(--hep-link);font-size:12px;letter-spacing:.04em}.login-phases span{display:flex;align-items:center;gap:8px}.login-phases i{width:5px;height:5px;border-radius:50%;background:currentColor}
      main{width:100%;padding:40px;background:var(--hep-surface);border:1px solid var(--hep-border);border-radius:16px;
        box-shadow:0 16px 56px #18365a0a,0 2px 8px #18365a04}header{text-align:left;margin-bottom:28px}
      h1{font-size:24px;font-weight:600;margin:0;letter-spacing:-.025em}header p{font-size:13px;color:var(--hep-muted);margin:6px 0}
      label{display:block;margin:20px 0 8px;font-weight:500}input,button{width:100%;min-height:44px;padding:10px 12px;border-radius:var(--hep-control-radius);font:inherit;transition:border-color var(--hep-motion-fast),box-shadow var(--hep-motion-fast),background-color var(--hep-motion-fast)}
      input{border:1px solid var(--hep-border);background:#f8faff;color:var(--hep-text)}button{margin-top:24px;background:var(--hep-primary);color:white;border:0;cursor:pointer;font-weight:500}
      button:hover{background:var(--hep-primary-hover);box-shadow:0 4px 12px color-mix(in srgb,var(--hep-primary) 12%,transparent)}
      input:focus-visible,button:focus-visible{outline:2px solid var(--hep-primary);outline-offset:3px}
      [role=alert]{color:#a62020;margin:16px 0 0}
      @media(prefers-reduced-motion:no-preference){main{animation:hep-enter var(--hep-motion) var(--hep-ease)}}
      @media(max-width:900px){body{padding:24px}.login-shell{max-width:440px;grid-template-columns:1fr;gap:24px}.login-story{padding:0}.login-story h2,.login-story>p,.login-phases{display:none}main{padding:28px}h1{font-size:22px}}
      `}</style></head>
    <body className="harness-login"><div className="login-shell"><section className="login-story" aria-label="Harness 工程平台"><div className="login-wordmark"><PlatformLogo size={40} /><span>Harness 工程平台</span></div><h2>让智能体真正可用，<br />持续变好。</h2><p>从一个业务目标出发，构建智能体、验证效果，并持续改进。</p><div className="login-phases" aria-label="工程流程">{["构建", "评测", "演进", "交付"].map(label => <span key={label}><i aria-hidden="true" />{label}</span>)}</div></section><main><header><h1>登录工作台</h1>
      <p>{PLATFORM_SLOGAN}</p></header>
      <form method="post" action={action}>
        <label htmlFor="username">用户名</label><input id="username" name="username" autoComplete="username" required autoFocus maxLength={256} />
        <label htmlFor="password">密码</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
        {error && <p role="alert">{error}</p>}<button type="submit">登录</button>
      </form></main></div></body></html>)
}
