// Lightweight multi-series time-series line chart (SVG, no deps).
// data: [{t, <key>...}], series: [{key,color,label}]
export default function TimeChart({ data, series, height = 150, windowS = 20, unit = '' }) {
  const pts = (data || []).filter((d) => d.t >= (data[data.length - 1]?.t ?? 0) - windowS)
  if (pts.length < 2) return <div className="chart-empty">waiting for data…</div>

  const t1 = pts[pts.length - 1].t
  const t0 = t1 - windowS
  let lo = Infinity, hi = -Infinity
  for (const d of pts) for (const s of series) {
    const v = d[s.key]
    if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  }
  if (!isFinite(lo)) { lo = 0; hi = 1 }
  if (hi - lo < 1) hi = lo + 1
  const pad = hi - lo === 0 ? 1 : (hi - lo) * 0.12
  lo -= pad; hi += pad

  const W = 600, H = height, m = 4
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W
  const y = (v) => H - m - ((v - lo) / (hi - lo)) * (H - 2 * m)

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" preserveAspectRatio="none">
        {series.map((s) => {
          const path = pts.filter((d) => d[s.key] != null)
            .map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d[s.key]).toFixed(1)}`)
            .join(' ')
          return <path key={s.key} d={path} fill="none" stroke={s.color}
            strokeWidth="2" vectorEffect="non-scaling-stroke" />
        })}
      </svg>
      <div className="chart-scale">
        <span>{Math.round(hi)}{unit}</span>
        <span>{Math.round(lo)}{unit}</span>
      </div>
    </div>
  )
}
