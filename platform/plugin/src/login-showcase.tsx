import type { ReactNode } from 'react'

type IconKind = 'agent' | 'chat' | 'folder' | 'document' | 'layers' | 'tools' | 'code' | 'window' | 'branch'

function Icon({ kind, x, y, size = 24 }: { kind: IconKind; x: number; y: number; size?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${size / 24})`} className="login-scene-icon">
    {kind === 'agent' ? <><rect x="4" y="5" width="16" height="15" rx="5" /><path d="M12 2v3M8 11v2m8-2v2m-8 3h8M1 10v6m22-6v6" /></>
      : kind === 'chat' ? <><path d="M20 15a4 4 0 0 1-4 4H9l-6 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4Z" /><path d="M7 8h9M7 12h6" /></>
      : kind === 'folder' ? <><path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11H3Z" /><path d="M3 9h18" /></>
      : kind === 'document' ? <><path d="M14 2H5v20h14V7Z" /><path d="M14 2v6h5M8 12h8m-8 4h6" /></>
      : kind === 'layers' ? <><path d="m12 2 10 6-10 6L2 8Zm-10 10 10 6 10-6M2 16l10 6 10-6" /></>
      : kind === 'tools' ? <><rect x="2" y="2" width="7" height="7" rx="2" /><rect x="15" y="15" width="7" height="7" rx="2" /><path d="M18.5 2v7M15 5.5h7M2 18.5h7M5.5 15v7M9 5.5h3v13h3" /></>
      : kind === 'code' ? <><path d="m7 6-6 6 6 6m10-12 6 6-6 6m-3-16-4 20" /></>
      : kind === 'window' ? <><rect x="2" y="3" width="20" height="18" rx="3" /><path d="M2 8h20M6 5.5h.01M9 5.5h.01M6 12h12m-12 4h8" /></>
      : <><circle cx="6" cy="4" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12m0-6h5a7 7 0 0 0 7-5" /></>}
  </g>
}

function Surface({ x, y, width, height, children, main = false }: { x: number; y: number; width: number; height: number; children: ReactNode; main?: boolean }) {
  return <g className={main ? 'login-scene-surface login-scene-main' : 'login-scene-surface'}>
    <rect x={x} y={y} width={width} height={height} rx="16" />{children}
  </g>
}

function BuildScene() {
  return <>
    <path className="login-scene-link" d="M228 94h34q22 0 22 22v44h72M228 228h34q22 0 22-22v-46" />
    <Surface x={60} y={48} width={168} height={88}><Icon kind="chat" x={78} y={66} /><text x="78" y="116">描述业务需求</text></Surface>
    <Surface x={60} y={184} width={168} height={88}><Icon kind="folder" x={78} y={202} /><text x="78" y="252">迁入已有工程</text></Surface>
    <rect className="login-scene-paper" x="344" y="82" width="184" height="172" rx="36" transform="rotate(-7 436 168)" />
    <rect className="login-scene-agent-tile" x="360" y="64" width="184" height="172" rx="36" />
    <g className="login-scene-inverse"><Icon kind="agent" x={414} y={98} size={76} /></g>
    <text className="login-scene-inverse-label" x="452" y="209" textAnchor="middle">角色 · 技能 · 工具 · 模型</text>
    <text className="login-scene-title" x="452" y="280" textAnchor="middle">专属智能体</text>
    <text className="login-scene-caption" x="452" y="306" textAnchor="middle">构建 · 运行 · 任务验证</text>
    <circle className="login-scene-node" cx="284" cy="160" r="6" />
  </>
}

function KnowledgeScene() {
  return <>
    <path className="login-scene-link" d="M186 154h64M456 154h42q22 0 22-22v-22m-22 44q22 0 22 22v24" />
    <g transform="rotate(-7 130 160)"><rect className="login-scene-paper" x="66" y="83" width="124" height="156" rx="12" /></g>
    <Surface x={76} y={74} width={112} height={156}>
      <Icon kind="document" x={96} y={94} size={30} /><path className="login-scene-rule" d="M98 145h66m-66 18h50m-50 18h60" /><text x="132" y="211" textAnchor="middle">业务文档</text>
    </Surface>
    <g className="login-scene-stack" transform="translate(353 160) rotate(-6)">
      <rect className="login-scene-paper" x="-93" y="-101" width="186" height="214" rx="14" transform="rotate(-8)" />
      <rect className="login-scene-paper" x="-93" y="-101" width="186" height="214" rx="14" transform="rotate(5)" />
      <Surface x={-93} y={-101} width={186} height={214} main>
        <path className="login-scene-rule" d="M-66-77H16m-82 11h55" />
        <Icon kind="layers" x={-24} y={-35} size={48} />
        <text className="login-scene-title" x="0" y="46" textAnchor="middle">知识资产</text>
        <text className="login-scene-caption" x="0" y="79" textAnchor="middle">来源可追溯</text>
      </Surface>
    </g>
    <circle className="login-scene-orbit" cx="530" cy="81" r="31" /><Icon kind="branch" x={518} y={69} /><text x="530" y="132" textAnchor="middle">继承</text>
    <circle className="login-scene-orbit" cx="530" cy="221" r="31" /><Icon kind="layers" x={518} y={209} /><text x="530" y="273" textAnchor="middle">融合</text>
  </>
}

function ConnectionScene() {
  return <>
    <circle className="login-scene-ring" cx="325" cy="160" r="116" />
    <path className="login-scene-link" d="M186 92h28q27 0 43 27m-71 109h28q27 0 43-27M401 160h75" />
    <rect className="login-scene-pill" x="68" y="66" width="118" height="52" rx="26" /><text className="login-scene-blue" x="127" y="98" textAnchor="middle">MCP</text>
    <rect className="login-scene-pill" x="68" y="202" width="118" height="52" rx="26" /><text className="login-scene-blue" x="127" y="234" textAnchor="middle">OpenAPI</text>
    <circle className="login-scene-hub" cx="325" cy="160" r="76" />
    <Icon kind="agent" x={300} y={114} size={50} /><text className="login-scene-title" x="325" y="197" textAnchor="middle">智能体</text>
    <g transform="translate(325 44)"><rect className="login-scene-pill" x="-22" y="-22" width="44" height="44" rx="12" /><Icon kind="tools" x={-12} y={-12} /></g>
    <g transform="translate(325 276)"><rect className="login-scene-pill" x="-22" y="-22" width="44" height="44" rx="12" /><Icon kind="branch" x={-12} y={-12} /></g>
    <g transform="translate(487 106)">
      <rect className="login-scene-paper" width="96" height="104" rx="16" />
      {[0, 1, 2, 3].map(i => <rect key={i} className="login-scene-tile" x={14 + i % 2 * 38} y={16 + Math.floor(i / 2) * 38} width="30" height="30" rx="8" />)}
    </g>
    <text x="535" y="242" textAnchor="middle">业务系统</text>
    <circle className="login-scene-node" cx="441" cy="160" r="5" />
  </>
}

function EvaluationScene() {
  return <>
    <path className="login-scene-link" d="M212 72h226q30 0 30 30v116q0 30-30 30H212q-30 0-30-30V102q0-30 30-30Z" />
    <path className="login-scene-arrow" d="m318 66 7 6-7 6m20 164-7 6 7 6" />
    <circle className="login-scene-orbit" cx="325" cy="160" r="54" /><Icon kind="branch" x={309} y={127} size={32} /><text x="325" y="188" textAnchor="middle">持续改进</text>
    <Surface x={80} y={40} width={174} height={92}><Icon kind="document" x={99} y={58} /><text x="99" y="110">业务用例</text></Surface>
    <Surface x={398} y={40} width={174} height={92}><Icon kind="code" x={417} y={58} /><text x="417" y="110">执行与证据</text></Surface>
    <Surface x={80} y={196} width={174} height={92}><Icon kind="chat" x={99} y={214} /><text x="99" y="266">问题与修改</text></Surface>
    <Surface x={398} y={196} width={174} height={92}><Icon kind="layers" x={417} y={214} /><text x="417" y="266">版本比较</text></Surface>
  </>
}

function ComputeScene() {
  return <>
    <path className="login-scene-link" d="M178 160h36q24 0 24-24V94q0-22 22-22h24m-70 88q24 0 24 24v42q0 22 22 22h24M478 72h28q24 0 24 24v128q0 24-24 24h-28M530 160h24" />
    <circle className="login-scene-orbit" cx="123" cy="160" r="55" /><Icon kind="branch" x={108} y={125} size={30} /><text x="123" y="191" textAnchor="middle">固定父版</text>
    <Surface x={284} y={32} width={194} height={96} main><Icon kind="agent" x={304} y={51} /><text x="304" y="104">中算力 · 模型协同</text></Surface>
    <Surface x={284} y={200} width={194} height={96} main><Icon kind="code" x={304} y={219} /><text x="304" y="272">低算力 · 代码执行</text></Surface>
    <circle className="login-scene-node" cx="214" cy="160" r="5" />
    <text className="login-scene-caption" x="381" y="166" textAnchor="middle">样本 · 训练 · 部署</text>
    <text className="login-scene-blue" x="570" y="149" textAnchor="middle">比较</text><text className="login-scene-blue" x="570" y="174" textAnchor="middle">验证</text>
  </>
}

function DeliveryScene() {
  return <>
    <path className="login-scene-link" d="M246 118v24q0 16 16 16h128q16 0 16 16v24M456 118v24q0 16-16 16H262q-16 0-16 16v24" />
    <text className="login-scene-caption" x="60" y="85">使用</text><text className="login-scene-caption" x="60" y="242">交付</text>
    <Surface x={156} y={26} width={180} height={92} main><Icon kind="window" x={176} y={48} size={30} /><text className="login-scene-title" x="228" y="77">Web</text></Surface>
    <Surface x={366} y={26} width={180} height={92} main><Icon kind="code" x={386} y={48} size={30} /><text className="login-scene-title" x="438" y="77">SDK</text></Surface>
    <g transform="translate(175 193)">
      <rect className="login-scene-paper" x="0" y="22" width="140" height="50" rx="12" />
      <rect className="login-scene-paper" x="0" y="11" width="140" height="50" rx="12" />
      <rect className="login-scene-hub" width="140" height="50" rx="12" />
      <circle className="login-scene-node" cx="22" cy="25" r="5" /><path className="login-scene-rule" d="M42 25h76" />
    </g>
    <text x="245" y="296" textAnchor="middle">平台运行</text>
    <g transform="translate(455 229)">
      <path className="login-scene-package-top" d="m0-48 62 29-62 30-62-30Z" />
      <path className="login-scene-package-left" d="m-62-19 62 30v45l-62-30Z" />
      <path className="login-scene-package-right" d="m0 11 62-30v45L0 56Z" />
      <path className="login-scene-rule" d="m-31-33 62 30v18" />
    </g>
    <text x="455" y="310" textAnchor="middle">独立智能体包</text>
    <circle className="login-scene-node" cx="326" cy="158" r="6" />
  </>
}

/** 原创关系插画；不把演示构图作为账号状态或已验证业务结果。 */
export function LoginShowcase({ index }: { index: number }) {
  const Scene = [BuildScene, KnowledgeScene, ConnectionScene, EvaluationScene, ComputeScene, DeliveryScene][index] ?? BuildScene
  return <div className="login-showcase" data-scene={index} aria-hidden="true">
    <svg className="login-scene" viewBox="0 -12 650 344" fill="none" focusable="false">
      <defs><radialGradient id={`login-scene-halo-${index}`}><stop stopColor="var(--hep-primary)" stopOpacity=".08" /><stop offset="1" stopColor="var(--hep-primary)" stopOpacity="0" /></radialGradient></defs>
      <ellipse cx="330" cy="162" rx="292" ry="150" fill={`url(#login-scene-halo-${index})`} />
      <g className="login-scene-content"><Scene /></g>
    </svg>
  </div>
}

export const loginShowcaseStyle = `
.login-showcase{display:grid;grid-template-rows:minmax(0,1fr);place-items:center;width:100%;height:320px;min-width:0;pointer-events:none;overflow:hidden}
.login-scene{display:block;width:100%;max-width:680px;height:100%;overflow:visible}
.login-scene text{fill:var(--hep-text);font:500 16px/1.5 system-ui,"Microsoft YaHei",sans-serif;letter-spacing:.01em}
.login-scene .login-scene-title{font-size:22px;font-weight:600;letter-spacing:-.02em}
.login-scene .login-scene-caption{fill:var(--hep-muted);font-size:13px;font-weight:400}
.login-scene .login-scene-blue{fill:var(--hep-link);font-size:15px;font-weight:500}
.login-scene-surface>rect:first-child{fill:var(--hep-surface);stroke:var(--hep-border);stroke-width:1.2;filter:drop-shadow(0 6px 12px color-mix(in srgb,var(--hep-primary) 5%,transparent))}
.login-scene-main>rect:first-child{stroke:color-mix(in srgb,var(--hep-primary) 24%,var(--hep-border))}
.login-scene-icon{fill:none;stroke:var(--hep-link);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.login-scene-orbit,.login-scene-pill{fill:var(--hep-primary-soft);stroke:color-mix(in srgb,var(--hep-primary) 18%,var(--hep-border));stroke-width:1}
.login-scene-paper{fill:var(--hep-primary-soft);stroke:var(--hep-border)}
.login-scene-agent-tile{fill:var(--hep-primary);stroke:var(--hep-primary-hover);filter:drop-shadow(0 12px 20px color-mix(in srgb,var(--hep-primary) 16%,transparent))}
.login-scene-inverse .login-scene-icon{stroke:var(--hep-surface);stroke-width:1.2}
.login-scene .login-scene-inverse-label{fill:var(--hep-surface);font-size:12px;font-weight:400}
.login-scene-hub{fill:var(--hep-surface);stroke:color-mix(in srgb,var(--hep-primary) 26%,var(--hep-border));stroke-width:1.2;filter:drop-shadow(0 8px 16px color-mix(in srgb,var(--hep-primary) 8%,transparent))}
.login-scene-ring{fill:none;stroke:color-mix(in srgb,var(--hep-primary) 18%,var(--hep-border));stroke-width:1;stroke-dasharray:3 6}
.login-scene-tile{fill:var(--hep-surface);stroke:color-mix(in srgb,var(--hep-primary) 20%,var(--hep-border));stroke-width:1}
.login-scene-package-top{fill:var(--hep-surface);stroke:color-mix(in srgb,var(--hep-primary) 25%,var(--hep-border));stroke-linejoin:round}
.login-scene-package-left{fill:var(--hep-primary-soft);stroke:color-mix(in srgb,var(--hep-primary) 25%,var(--hep-border));stroke-linejoin:round}
.login-scene-package-right{fill:color-mix(in srgb,var(--hep-primary) 12%,var(--hep-surface));stroke:color-mix(in srgb,var(--hep-primary) 25%,var(--hep-border));stroke-linejoin:round}
.login-scene-link{fill:none;stroke:color-mix(in srgb,var(--hep-primary) 36%,var(--hep-border));stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.login-scene-rule{stroke:var(--hep-border);stroke-width:1.2;stroke-linecap:round}
.login-scene-node{fill:var(--hep-primary);stroke:var(--hep-surface);stroke-width:3}
.login-scene-arrow{stroke:var(--hep-link);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
@media(prefers-reduced-motion:no-preference){.login-feature-slide[data-active=true] .login-scene-content{animation:login-scene-enter 500ms var(--hep-ease) both}.login-scene-link{stroke-dasharray:5 5;animation:login-scene-flow 24s linear infinite}.login-feature-slide:not([data-active=true]) .login-scene-link,[data-login-carousel][data-playing=false] .login-scene-link{animation-play-state:paused}}
@keyframes login-scene-enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes login-scene-flow{to{stroke-dashoffset:-120}}
@media(max-width:680px){.login-showcase{height:230px}.login-scene text{font-size:20px}.login-scene .login-scene-title{font-size:25px}.login-scene .login-scene-caption{font-size:16px}.login-scene .login-scene-blue{font-size:18px}.login-scene .login-scene-inverse-label{display:none}.login-scene-inverse{transform:translateY(12px)}}
`
