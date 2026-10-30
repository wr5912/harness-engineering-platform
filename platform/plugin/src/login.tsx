import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlatformLogo } from './logo.tsx'
import logo from '../assets/harness-logo.svg'
import { initializeLoginCarousel } from './login-carousel.ts'
import { LoginShowcase, loginShowcaseStyle } from './login-showcase.tsx'
import { visualTokens, workbenchTokens } from './styles/tokens.ts'

export const loginCarouselScript = `(${initializeLoginCarousel.toString()})();`
export const loginCarouselScriptHash = createHash('sha256').update(loginCarouselScript).digest('base64')

const features = [
  { label: '构建迁移', title: '描述业务需求，构建专属智能体', description: '通过自然语言与管理助手协作，组织角色、技能、工具和模型。支持从已有工程迁入智能体，完成行为映射、资产生成与关键任务验证。', tags: ['对话式构建', '外部智能体迁移', '多角色协作'] },
  { label: '知识资产', title: '沉淀业务知识，复用已有能力', description: '将文档整理为可追溯的知识资产，统一管理角色指令、技能和插件配置。通过版本继承、能力融合与差异比较，让已有成果服务于下一次构建。', tags: ['知识溯源', '版本继承', '能力融合'] },
  { label: '业务连接', title: '连接业务系统，组合工具能力', description: '通过 MCP 与 OpenAPI 接入业务工具和资源，按场景分组、编排与调试。结合网关的身份与访问配置，将智能体能力接入实际业务流程。', tags: ['MCP / OpenAPI', '工具组合编排', '身份与访问控制'] },
  { label: '评测改进', title: '用真实任务验证，让每次改进有据可依', description: '围绕业务用例执行评测，保留版本来源、运行轨迹和业务产物。通过逐例分析与版本对比，发现问题、验证修改，为后续迭代提供依据。', tags: ['业务用例评测', '运行证据追溯', '版本效果对比'] },
  { label: '算力优化', title: '派生算力变体，验证更合适的执行方式', description: '从固定版本派生中算力、低算力变体，探索模型协同与代码执行。由管理助手串联决策样本、训练部署和对比评测，验证不同方案的业务适用性。', tags: ['中算力模型协同', '低算力代码执行', '训练部署与验证'] },
  { label: '运行交付', title: '支持交互与集成，把智能体交付到业务环境', description: '通过 Web 与智能体交互，或使用官方 TypeScript SDK 集成应用。支持平台实例运行，并可将符合打包要求的选定版本导出为独立智能体包。', tags: ['Web / SDK 双模式', '会话持久化', '独立打包交付'] },
]

function FeatureCarousel() {
  return <section className="login-features" data-login-carousel tabIndex={0} role="region" aria-roledescription="轮播" aria-label="平台核心能力，可使用左右方向键切换">
    <div className="login-feature-slides" data-carousel-content aria-live="off" aria-atomic="true">
      {features.map((feature, index) => <article key={feature.label} className="login-feature-slide" id={`login-feature-${index}`} data-carousel-slide data-active={index === 0} aria-hidden={index !== 0} role="group" aria-roledescription="幻灯片" aria-label={`${feature.label}，${index + 1} / ${features.length}`}>
        <LoginShowcase index={index} />
        <div className="login-feature-copy"><h3>{feature.title}</h3>
          <p>{feature.description}</p>
          <ul className="login-feature-tags">{feature.tags.map(tag => <li key={tag}>{tag}</li>)}</ul>
        </div>
      </article>)}
    </div>
    <button type="button" className="login-carousel-arrow login-carousel-previous" data-carousel-previous hidden aria-label="上一项能力"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>
    <button type="button" className="login-carousel-arrow login-carousel-next" data-carousel-next hidden aria-label="下一项能力"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>
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
      .login-panel{grid-area:form;width:100%;max-width:340px;justify-self:center}.login-panel>header{text-align:left;margin-bottom:32px}.login-panel h1{font-size:24px;line-height:1.4;font-weight:600;margin:0;letter-spacing:-.025em}.login-panel>header p{font-size:14px;line-height:1.7;color:var(--hep-muted);margin:8px 0 0}
      .login-field+.login-field{margin-top:20px}.login-panel label{display:block;margin:0 0 8px;font-weight:500}.login-panel form :is(input,button){width:100%;min-height:48px;padding:12px;border-radius:var(--hep-control-radius);font:inherit;line-height:1.55;transition:border-color var(--hep-motion-fast),box-shadow var(--hep-motion-fast),background-color var(--hep-motion-fast)}
      .login-panel input{display:block;border:1px solid var(--hep-border);background:var(--hep-surface);color:var(--hep-text)}.login-panel input:hover{border-color:color-mix(in srgb,var(--hep-border) 60%,var(--hep-muted))}.login-panel form button{margin-top:28px;background:var(--hep-primary);color:#fff;border:1px solid var(--hep-primary);box-shadow:0 1px 2px #183b701a,inset 0 1px 0 #ffffff1f;cursor:pointer;font-weight:600}.login-panel form button:hover{background:var(--hep-primary-hover);border-color:var(--hep-primary-hover)}
      :is(input,button):focus-visible{outline:2px solid var(--hep-focus);outline-offset:3px}.login-panel input:focus-visible{outline-offset:2px}.login-panel [role=alert]{color:var(--hep-danger);margin:16px 0 0;overflow-wrap:anywhere}
      .login-features{position:relative;min-width:0;border-radius:12px;outline-offset:8px;touch-action:pan-y}.login-features:focus-visible{outline:2px solid var(--hep-focus)}.login-features [hidden]{display:none!important}
      .login-feature-slides{display:grid}.login-feature-slide{grid-area:1/1;min-width:0;visibility:hidden;opacity:0;pointer-events:none;transition:opacity 400ms var(--hep-ease),visibility 400ms}.login-feature-slide[data-active=true]{visibility:visible;opacity:1;pointer-events:auto}.login-feature-copy{padding-top:22px}.login-feature-copy h3{margin:0;font-size:26px;font-weight:600;line-height:1.5;letter-spacing:-.025em;text-wrap:balance}.login-feature-copy>p{max-width:660px;font-size:14px;line-height:1.85;color:var(--hep-muted);margin:14px 0 0;text-wrap:pretty}.login-feature-tags{display:flex;flex-wrap:wrap;align-items:center;gap:8px 0;margin:22px 0 0;padding:0;list-style:none;color:var(--hep-muted);font-size:12px;line-height:1.6}.login-feature-tags li+li::before{content:"";display:inline-block;width:3px;height:3px;background:var(--hep-primary);opacity:.45;border-radius:50%;margin:0 12px;vertical-align:middle}
      .login-carousel-arrow{position:absolute;top:160px;display:grid;place-items:center;width:44px;height:44px;padding:0;border:1px solid var(--hep-border);border-radius:50%;background:var(--hep-surface);color:var(--hep-text);box-shadow:0 4px 16px #18365a0a;cursor:pointer;opacity:0;pointer-events:none;transform:translateY(-50%) scale(.94);transition:opacity 180ms ease,transform 180ms ease,background-color 180ms ease;z-index:2}.login-carousel-previous{left:0}.login-carousel-next{right:0}.login-features[data-engaged=true] .login-carousel-arrow,.login-carousel-arrow:focus-visible{opacity:1;pointer-events:auto;transform:translateY(-50%) scale(1)}.login-carousel-arrow:hover{color:var(--hep-primary);background:var(--hep-primary-soft)}
      @media(prefers-reduced-motion:reduce){.login-feature-slide,.login-carousel-arrow{transition:none}}
      @media(max-width:1100px){.login-shell{column-gap:40px}.login-story h2{font-size:32px}}
      @media(max-width:900px){body{padding:24px}.login-shell{max-width:440px;grid-template-columns:minmax(0,1fr);grid-template-areas:"brand" "form" "story";gap:36px}.login-story h2{display:none}.login-panel{max-width:none}.login-panel h1{font-size:22px}.login-story{padding-top:28px;border-top:1px solid var(--hep-border)}}
      @media(max-width:680px){body{padding:24px 16px}.login-feature-copy{padding-top:18px}.login-feature-copy h3{font-size:22px}.login-feature-copy>p{font-size:13px}.login-feature-tags{margin-top:18px;font-size:11px}.login-feature-tags li+li::before{margin:0 8px}.login-carousel-arrow{top:115px}}
      ` }} /></head>
    <body className="harness-login"><div className="login-shell">
      <div className="login-wordmark"><PlatformLogo size={40} /><span>Harness 工程平台</span></div>
      <main className="login-panel"><header><h1>登录工作台</h1><p>使用平台账号，继续你的工作。</p></header>
        <form method="post" action={action}>
          <div className="login-field"><label htmlFor="username">用户名</label><input id="username" name="username" autoComplete="username" required autoFocus maxLength={256} /></div>
          <div className="login-field"><label htmlFor="password">密码</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} /></div>
          {error && <p role="alert">{error}</p>}<button type="submit">登录</button>
        </form>
      </main>
      <section className="login-story" aria-label="了解 Harness 工程平台"><h2>让智能体真正可用，<br />持续变好。</h2><FeatureCarousel /></section>
    </div><script dangerouslySetInnerHTML={{ __html: loginCarouselScript }} /></body></html>)
}
