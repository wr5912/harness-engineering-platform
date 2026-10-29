export type ChartTone = 'success' | 'danger' | 'warning' | 'neutral' | 'accent'
export type ChartSegment = { key: string; label: string; count: number; tone: ChartTone }

/** 展示已读取记录的组成；空记录与读取未知由调用方分别处理。 */
export function DistributionChart({ title, description, segments, totalLabel = '条记录', emptyText = '暂无记录', variant = 'donut', onSelect, selectedKey }: {
  title: string; description?: string; segments: ChartSegment[]; totalLabel?: string; emptyText?: string; variant?: 'donut' | 'bars'
  onSelect?(key: string): void; selectedKey?: string
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  const circumference = 2 * Math.PI * 48
  let offset = 0
  return <figure className="hep-overview-chart" data-variant={variant}>
    <figcaption><h3>{title}</h3>{description && <p>{description}</p>}</figcaption>
    <div className="hep-overview-chart-body">
      {variant === 'donut' && <svg viewBox="0 0 128 128" role="img" aria-label={`${title}，共 ${total} ${totalLabel}`}>
        <circle className="hep-overview-ring-base" cx="64" cy="64" r="48" />
        {segments.filter(segment => segment.count > 0).map(segment => {
          const length = segment.count / total * circumference, start = offset; offset += length
          return <circle key={segment.key} className="hep-overview-ring-segment" data-tone={segment.tone} cx="64" cy="64" r="48" strokeDasharray={`${length} ${Math.max(0, circumference - length)}`} strokeDashoffset={-start} transform="rotate(-90 64 64)" />
        })}
        <text x="64" y="61" className="hep-overview-chart-total">{total}</text><text x="64" y="81" className="hep-overview-chart-unit">{total ? totalLabel : '暂无记录'}</text>
      </svg>}
      <ul className="hep-overview-chart-legend" aria-label={`${title}分类`}>
        {segments.map(segment => {
          const contents = <><span className="hep-overview-chart-swatch" data-tone={segment.tone} aria-hidden="true" /><span className="hep-overview-chart-label">{segment.label}</span><strong>{segment.count}</strong>{variant === 'bars' && <span className="hep-overview-bar-track" aria-hidden="true"><i data-tone={segment.tone} style={{ width: `${total ? segment.count / total * 100 : 0}%` }} /></span>}</>
          return <li key={segment.key}>{onSelect ? <button type="button" aria-pressed={selectedKey === segment.key} onClick={() => onSelect(segment.key)}>{contents}</button> : <div>{contents}</div>}</li>
        })}
      </ul>
      {!total && <p className="hep-overview-chart-empty">{emptyText}</p>}
    </div>
  </figure>
}

export type SequencePoint = { key: string; label: string; status: string; tone: ChartTone; description?: string }
/** 记录按调用方提供的先后排列；色块表示类别，不暗示数值趋势。 */
export function SequenceChart({ title, description, items, onSelect, emptyText = '暂无记录' }: {
  title: string; description?: string; items: SequencePoint[]; onSelect?(key: string): void; emptyText?: string
}) {
  return <figure className="hep-overview-sequence"><figcaption><h3>{title}</h3>{description && <p>{description}</p>}</figcaption>
    {items.length ? <ol>{items.map(item => {
      const contents = <><span className="hep-overview-sequence-mark" data-tone={item.tone} aria-hidden="true" /><strong>{item.status}</strong><span>{item.label}</span></>
      return <li key={item.key}>{onSelect ? <button type="button" title={item.description} aria-label={`${item.label}，${item.status}${item.description ? `，${item.description}` : ''}`} onClick={() => onSelect(item.key)}>{contents}</button> : <div title={item.description}>{contents}</div>}</li>
    })}</ol> : <p className="hep-overview-chart-empty">{emptyText}</p>}
  </figure>
}

export const overviewChartsTheme = `
.hep-overview-chart,.hep-overview-sequence{margin:0;min-width:0;color:var(--hep-text)}
.hep-overview-chart{display:grid;grid-template-rows:auto 1fr;gap:12px}
.hep-overview-chart figcaption h3,.hep-overview-sequence figcaption h3{margin:0;font-size:15px;line-height:1.5;font-weight:600}
.hep-overview-chart figcaption p,.hep-overview-sequence figcaption p{margin:4px 0 0;color:var(--hep-muted);font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.hep-overview-chart-body{display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:10px 16px;min-width:0}
.hep-overview-chart-body>svg{display:block;width:112px;max-width:100%;overflow:visible}
.hep-overview-ring-base,.hep-overview-ring-segment{fill:none;stroke-width:11}
.hep-overview-ring-base{stroke:var(--hep-border)}
.hep-overview-ring-segment{stroke:var(--hep-chart-color,var(--hep-muted))}
.hep-overview-chart [data-tone=success],.hep-overview-sequence [data-tone=success]{--hep-chart-color:var(--hep-success)}
.hep-overview-chart [data-tone=danger],.hep-overview-sequence [data-tone=danger]{--hep-chart-color:var(--hep-danger)}
.hep-overview-chart [data-tone=warning],.hep-overview-sequence [data-tone=warning]{--hep-chart-color:var(--hep-warning)}
.hep-overview-chart [data-tone=neutral],.hep-overview-sequence [data-tone=neutral]{--hep-chart-color:var(--hep-muted)}
.hep-overview-chart [data-tone=accent],.hep-overview-sequence [data-tone=accent]{--hep-chart-color:var(--hep-primary)}
.hep-overview-chart-total{font-size:29px;font-weight:600;fill:var(--hep-text);text-anchor:middle;font-variant-numeric:tabular-nums}
.hep-overview-chart-unit{font-size:16px;fill:var(--hep-muted);text-anchor:middle}
.hep-overview-chart-legend{display:grid;align-content:center;gap:3px;min-width:0;margin:0;padding:0;list-style:none}
.hep-overview-chart-legend>li{min-width:0}
.hep-overview-chart-legend>li>div,.harness-platform .hep-overview-chart-legend>li>button{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:4px 8px;width:100%;min-width:0;padding:4px 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--hep-text);font:inherit;font-size:12px;line-height:1.5;text-align:left;box-sizing:border-box}
.hep-overview-chart-legend>li>div{min-height:28px}
.harness-platform .hep-overview-chart-legend>li>button:hover,.harness-platform .hep-overview-chart-legend>li>button[aria-pressed=true]{background:var(--hep-surface-muted);border-color:var(--hep-border)}
.hep-overview-chart-label{min-width:0;overflow-wrap:anywhere}
.hep-overview-chart-legend strong{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.hep-overview-chart-swatch{width:8px;height:8px;border-radius:3px;background:var(--hep-chart-color,var(--hep-muted))}
.hep-overview-chart-empty{grid-column:1/-1;margin:0;color:var(--hep-muted);font-size:12px;line-height:1.7}
.hep-overview-chart[data-variant=bars] .hep-overview-chart-body{grid-template-columns:minmax(0,1fr)}
.hep-overview-bar-track{grid-column:2/-1;height:4px;overflow:hidden;border-radius:4px;background:var(--hep-border)}
.hep-overview-bar-track>i{display:block;height:100%;border-radius:inherit;background:var(--hep-chart-color,var(--hep-muted))}
.hep-overview-sequence>ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(64px,96px));justify-content:start;gap:8px;list-style:none;margin:12px 0 0;padding:0}
.hep-overview-sequence li{display:grid;min-width:0}
.hep-overview-sequence li>div,.harness-platform .hep-overview-sequence li>button{display:grid;grid-template-rows:20px 1fr auto;align-content:start;gap:5px;width:100%;height:100%;padding:6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--hep-text);text-align:center;box-sizing:border-box}
.harness-platform .hep-overview-sequence li>button:hover{border-color:var(--hep-border);background:var(--hep-surface-muted)}
.hep-overview-sequence-mark{height:20px;border-radius:4px;background:var(--hep-chart-color,var(--hep-muted));opacity:.85}
.hep-overview-sequence li strong{font-size:11px;font-weight:500;line-height:1.5;overflow-wrap:anywhere}
.hep-overview-sequence li span:last-child{color:var(--hep-muted);font-size:11px;line-height:1.5}
.harness-platform .hep-overview-chart button:focus-visible,.harness-platform .hep-overview-sequence button:focus-visible{outline:2px solid var(--hep-primary);outline-offset:2px}
@media(max-width:680px){.hep-overview-chart-body{grid-template-columns:96px minmax(0,1fr);gap:10px}.hep-overview-chart-body>svg{width:96px}.hep-overview-sequence>ol{grid-template-columns:repeat(4,minmax(0,96px))}}
`
