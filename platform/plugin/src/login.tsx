import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlatformLogo } from './logo.tsx'
import logo from '../assets/harness-logo.svg'
import { PLATFORM_SLOGAN } from './home-entry.ts'
import { initializeLoginCarousel } from './login-carousel.ts'
import { LoginShowcase, loginShowcaseStyle } from './login-showcase.tsx'
import { visualTokens, workbenchTokens } from './styles/tokens.ts'

export const loginCarouselScript = `(${initializeLoginCarousel.toString()})();`
export const loginCarouselScriptHash = createHash('sha256').update(loginCarouselScript).digest('base64')

const features = [
  { label: '构建', title: '从目标到智能体', description: '用自然语言描述目标，让平台助手协助构建智能体；也可迁移已有项目，统一管理资产、版本与演进来源。', tags: ['自然语言构建', '资产与版本', '项目迁移'] },
  { label: '评测', title: '让改进有据可循', description: '围绕真实任务运行评测、查看轨迹与逐例结果，比较不同版本和算力变体，为后续改进提供依据。', tags: ['用例与轨迹', '版本比较', '算力变体'] },
  { label: '运行', title: '灵活运行与交付', description: '创建并管理独立运行实例，支持网页访问与应用内调用；启停、重启和批量操作都有逐项回执。', tags: ['实例管理', '网页访问', '应用内调用'] },
  { label: '连接', title: '统一连接工具与服务', description: '接入 MCP 与 OpenAPI 服务，组织工具和资源；通过统一网关管理智能体身份、风险与访问规则。', tags: ['MCP / OpenAPI', '组合编排', '统一网关'] },
]

function FeatureCarousel() {
  return <section className="login-features" data-login-carousel role="region" aria-roledescription="轮播" aria-label="平台特性">
    <div className="login-feature-heading"><span>平台能力</span><span data-carousel-position aria-label="当前特性序号">01 / {String(features.length).padStart(2, '0')}</span></div>
    <div className="login-feature-slides" data-carousel-content aria-live="off" aria-atomic="true">
      {features.map((feature, index) => <article key={feature.title} className="login-feature-slide" id={`login-feature-${index}`} data-carousel-slide data-active={index === 0} aria-hidden={index !== 0} role="group" aria-roledescription="幻灯片" aria-label={`${index + 1} / ${features.length}`}>
        <LoginShowcase index={index} /><div className="login-feature-title"><h3>{feature.title}</h3></div>
        <p>{feature.description}</p>
        <ul className="login-feature-tags">{feature.tags.map(tag => <li key={tag}>{tag}</li>)}</ul>
      </article>)}
    </div>
    <div className="login-carousel-controls" data-carousel-controls hidden>
      <div className="login-carousel-dots" role="group" aria-label="选择平台特性">{features.map((feature, index) => <button key={feature.title} type="button" data-carousel-to={index} aria-controls={`login-feature-${index}`} aria-label={`查看第 ${index + 1} 项：${feature.title}`} aria-current={index === 0 ? 'true' : undefined}><span className="login-carousel-number">{String(index + 1).padStart(2, '0')}</span><span>{feature.label}</span></button>)}</div>
      <div className="login-carousel-actions">
        <button type="button" data-carousel-previous aria-label="上一项特性"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
        <button type="button" data-carousel-next aria-label="下一项特性"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg></button>
        <button type="button" className="login-carousel-playback" data-carousel-playback aria-label="暂停自动轮播" aria-pressed="false">暂停</button>
      </div>
    </div>
    <noscript><p className="login-feature-fallback">构建与迁移 · 评测与改进 · 实例交付 · 工具与网关</p></noscript>
  </section>
}

export function loginPage(action: string, error = ''): string {
  return '<!doctype html>' + renderToStaticMarkup(<html lang="zh-CN">
    <head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>登录 · Harness工程平台</title><link rel="icon" type="image/svg+xml" href={logo} /><style dangerouslySetInnerHTML={{ __html: `
      ${visualTokens}
      ${workbenchTokens}
      ${loginShowcaseStyle}
      *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;color-scheme:light;padding:32px;background:radial-gradient(ellipse at 20% 25%,color-mix(in srgb,var(--hep-primary) 9%,transparent),transparent 50%),var(--hep-bg);color:var(--hep-text);font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif}
      .login-shell{width:min(100%,1240px);display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,380px);grid-template-areas:"brand form" "story form";column-gap:80px;row-gap:32px;align-items:center}.login-wordmark{grid-area:brand;display:flex;align-items:center;gap:12px;font-size:17px;font-weight:600}.login-story{grid-area:story;min-width:0}.login-story h2{margin:0 0 24px;font-size:40px;line-height:1.4;letter-spacing:-.04em;font-weight:600}
      .login-panel{grid-area:form;width:100%;padding:40px;background:var(--hep-surface);border:1px solid var(--hep-border);border-radius:16px;box-shadow:0 16px 56px #18365a0a,0 2px 8px #18365a04}.login-panel>header{text-align:left;margin-bottom:28px}h1{font-size:24px;font-weight:600;margin:0;letter-spacing:-.025em}.login-panel>header p{font-size:13px;color:var(--hep-muted);margin:6px 0}
      form label{display:block;margin:20px 0 8px;font-weight:500}form :is(input,button){width:100%;min-height:44px;padding:10px 12px;border-radius:var(--hep-control-radius);font:inherit;transition:border-color var(--hep-motion-fast),box-shadow var(--hep-motion-fast),background-color var(--hep-motion-fast)}
      form input{border:1px solid var(--hep-border);background:var(--hep-surface-muted);color:var(--hep-text)}form button{margin-top:24px;background:var(--hep-primary);color:#fff;border:1px solid var(--hep-primary);cursor:pointer;font-weight:600}form button:hover{background:var(--hep-primary-hover);border-color:var(--hep-primary-hover);box-shadow:0 4px 12px color-mix(in srgb,var(--hep-primary) 12%,transparent)}
      :is(input,button):focus-visible{outline:2px solid var(--hep-focus);outline-offset:3px}[role=alert]{color:var(--hep-danger);margin:16px 0 0}
      .login-features{min-width:0}.login-feature-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;font-size:12px;color:var(--hep-muted)}[data-carousel-position]{font-variant-numeric:tabular-nums;letter-spacing:.04em}.login-feature-slides{display:grid}.login-feature-slide{grid-area:1/1;min-width:0;visibility:hidden;opacity:0;pointer-events:none;transition:opacity var(--hep-motion) var(--hep-ease)}.login-feature-slide[data-active=true]{visibility:visible;opacity:1;pointer-events:auto}.login-feature-title{margin:20px 0 0}.login-feature-title h3{margin:0;font-size:24px;font-weight:600;line-height:1.4;letter-spacing:-.025em}.login-feature-slide>p{max-width:600px;font-size:14px;line-height:1.7;color:var(--hep-muted);margin:12px 0}.login-feature-tags{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}.login-feature-tags li{padding:4px 8px;border-radius:6px;background:var(--hep-surface-muted);font-size:12px;line-height:1.6;color:var(--hep-muted)}
      .login-carousel-controls{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-top:20px;padding-top:16px;border-top:1px solid var(--hep-border)}.login-features [hidden]{display:none!important}.login-carousel-dots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));flex:1;min-width:260px;gap:12px}.login-carousel-actions{display:flex;align-items:center;gap:8px;margin-left:auto}.login-carousel-controls button{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;min-width:36px;min-height:36px;padding:6px;border:1px solid transparent;border-radius:8px;color:var(--hep-muted);background:transparent;cursor:pointer;font:inherit;font-size:12px;transition:background-color var(--hep-motion-fast),color var(--hep-motion-fast)}.login-carousel-controls button:hover{background:var(--hep-primary-soft);color:var(--hep-link)}.login-carousel-dots button{justify-content:flex-start;padding:8px 4px;border-radius:0}.login-carousel-number{font-size:10px;opacity:.6;font-variant-numeric:tabular-nums}.login-carousel-dots button::after{content:"";position:absolute;left:0;right:0;bottom:-17px;height:2px;background:transparent;transition:background-color var(--hep-motion)}.login-carousel-dots button[aria-current=true]{color:var(--hep-link);font-weight:600}.login-carousel-dots button[aria-current=true]::after{background:var(--hep-primary)}.login-carousel-controls .login-carousel-playback{min-width:48px;padding-inline:8px;border-color:var(--hep-border)}.login-feature-fallback{margin:16px 0 0;color:var(--hep-muted);font-size:12px}
      @media(pointer:coarse){.login-carousel-controls button{min-width:44px;min-height:44px}}
      @media(prefers-reduced-motion:no-preference){.login-panel{animation:hep-enter var(--hep-motion) var(--hep-ease)}}
      @media(max-width:1100px){.login-shell{column-gap:40px}.login-story h2{font-size:32px}}
      @media(max-width:900px){body{padding:24px}.login-shell{max-width:440px;grid-template-columns:minmax(0,1fr);grid-template-areas:"brand" "form" "story";gap:24px}.login-story h2{display:none}.login-panel{padding:28px}h1{font-size:22px}}
      @media(max-width:680px){body{padding:16px}.login-panel{padding:24px}.login-feature-title h3{font-size:22px}.login-carousel-dots{flex-basis:100%}.login-carousel-dots button::after{bottom:0}}
      ` }} /></head>
    <body className="harness-login"><div className="login-shell">
      <div className="login-wordmark"><PlatformLogo size={40} /><span>Harness 工程平台</span></div>
      <main className="login-panel"><header><h1>登录工作台</h1><p>{PLATFORM_SLOGAN}</p></header>
        <form method="post" action={action}>
          <label htmlFor="username">用户名</label><input id="username" name="username" autoComplete="username" required autoFocus maxLength={256} />
          <label htmlFor="password">密码</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
          {error && <p role="alert">{error}</p>}<button type="submit">登录</button>
        </form>
      </main>
      <section className="login-story" aria-label="了解 Harness 工程平台"><h2>让智能体真正可用，<br />持续变好。</h2><FeatureCarousel /></section>
    </div><script dangerouslySetInnerHTML={{ __html: loginCarouselScript }} /></body></html>)
}
