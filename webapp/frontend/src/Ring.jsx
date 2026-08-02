// Reusable circular progress ring (SVG). Fills clockwise to value/max.
export default function Ring({
  value, max, unit = '°', sub, color = '#4ea1ff', size = 200, reached = false,
}) {
  const has = value != null
  const v = has ? Math.max(0, Math.min(max, value)) : 0
  const frac = max ? v / max : 0
  const r = size / 2 - 16
  const c = 2 * Math.PI * r
  const dash = c * frac
  const mid = size / 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ring">
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="#ffffff14" strokeWidth="14" />
      <circle
        cx={mid} cy={mid} r={r} fill="none"
        stroke={reached ? '#3ddc84' : color} strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
        transform={`rotate(-90 ${mid} ${mid})`}
        style={{ transition: 'stroke-dasharray .12s linear, stroke .2s' }}
      />
      <text x={mid} y={mid} textAnchor="middle" dominantBaseline="central" className="ring-val">
        {has ? Math.round(value) : '--'}
        <tspan className="ring-unit">{unit}</tspan>
      </text>
      {sub && (
        <text x={mid} y={mid + 34} textAnchor="middle" className="ring-sub">{sub}</text>
      )}
    </svg>
  )
}
