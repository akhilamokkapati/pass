import { useEffect, useState } from 'react'

// Progress-over-time card. Answers "is the patient improving or declining?"
// by rolling the periodic sensor-snapshot log (see sensor_log.get_trend) into
// one point per day and showing, per metric: the current value, the change vs
// the last logged session, a baseline-to-now comparison, and a sparkline of
// the trajectory. Self-fetching like AiSummaryCard/SensorLogView, so it can be
// dropped into either the patient or clinician view with no extra wiring.

// Symmetry is stored as a raw Symmetry Index (0 = perfect, higher = worse).
// We display it as a 100 - SI score so every metric here reads the same way
// (higher = better), matching PatientView's SymmetryCard, so an up arrow
// always means improvement and there are no confusing green down-arrows.
const METRICS = [
  { key: 'rehabScore', label: 'Rehab score', unit: '', display: (v) => v },
  { key: 'maxFlexion', label: 'Peak knee flexion', unit: '°', display: (v) => v },
  { key: 'symmetry', label: 'Leg symmetry', unit: '%', display: (v) => Math.max(0, Math.min(100, 100 - v)) },
]

const round1 = (v) => Math.round(v * 10) / 10

function MiniTrend({ values }) {
  if (!values || values.length < 2) return <div className="trend-spark empty" />
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const W = 260, H = 46, m = 3
  const x = (i) => (i / (values.length - 1)) * (W - 2 * m) + m
  const y = (v) => H - m - ((v - lo) / span) * (H - 2 * m)
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(values.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`
  const last = values.length - 1
  return (
    <svg className="trend-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={area} className="trend-spark-area" />
      <path d={line} className="trend-spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={x(last)} cy={y(values[last])} r="3" className="trend-spark-dot" />
    </svg>
  )
}

// delta is already oriented so positive = improvement (higher is better for
// every displayed metric), so the arrow and colour can key straight off sign.
function DeltaPill({ delta, unit }) {
  if (delta == null) return <span className="trend-pill flat">first session</span>
  const flat = Math.abs(delta) < 0.05
  const cls = flat ? 'flat' : delta > 0 ? 'up' : 'down'
  const arrow = flat ? '•' : delta > 0 ? '▲' : '▼'
  const sign = delta > 0 ? '+' : ''
  return (
    <span className={`trend-pill ${cls}`}>
      {arrow} {sign}{round1(delta)}{unit} <em>vs last session</em>
    </span>
  )
}

function TrendRow({ metric, points }) {
  const series = points.map((p) => (p[metric.key] == null ? null : metric.display(p[metric.key])))
  const vals = series.filter((v) => v != null)
  if (vals.length === 0) return null

  const current = vals[vals.length - 1]
  const baseline = vals[0]
  const previous = vals.length >= 2 ? vals[vals.length - 2] : null
  const dPrev = previous != null ? current - previous : null
  const dBase = round1(current - baseline)

  return (
    <div className="trend-row">
      <div className="trend-row-top">
        <span className="trend-name">{metric.label}</span>
        <span className="trend-now">{round1(current)}<i>{metric.unit || (metric.key === 'rehabScore' ? '/100' : '')}</i></span>
      </div>
      <MiniTrend values={vals} />
      <div className="trend-row-bot">
        <DeltaPill delta={dPrev} unit={metric.unit} />
        {vals.length >= 2 && (
          <span className="trend-base">
            Baseline {round1(baseline)} → now {round1(current)}
            <b className={dBase > 0 ? 'up' : dBase < 0 ? 'down' : ''}>
              {' '}({dBase > 0 ? '+' : ''}{dBase}{metric.unit} since first session)
            </b>
          </span>
        )}
      </div>
    </div>
  )
}

export default function ProgressTrend() {
  const [trend, setTrend] = useState(null)   // null = loading
  const [error, setError] = useState(false)

  const load = () => {
    setError(false)
    fetch('/api/sensors/trend?days=90')
      .then((res) => res.json())
      .then((data) => setTrend(data.trend || { points: [] }))
      .catch(() => setError(true))
  }

  useEffect(load, [])

  const points = trend?.points || []
  const hasAny = points.some((p) => p.rehabScore != null || p.maxFlexion != null || p.symmetry != null)

  return (
    <section className="card accent-balance progress-trend">
      <div className="card-head">
        <h3>Progress over time</h3>
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      {error && <div className="cue">Couldn't reach the server - try refreshing.</div>}
      {!error && trend === null && <div className="cue">Loading…</div>}
      {!error && trend !== null && !hasAny && (
        <div className="cue">
          Not enough history yet - progress trends appear once a couple of sessions have been logged.
        </div>
      )}

      {hasAny && (
        <>
          <p className="trend-intro">
            How each measure has moved across logged sessions - so you can see improvement or decline at a glance,
            not just today's number.
          </p>
          <div className="trend-grid">
            {METRICS.map((metric) => (
              <TrendRow key={metric.key} metric={metric} points={points} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
