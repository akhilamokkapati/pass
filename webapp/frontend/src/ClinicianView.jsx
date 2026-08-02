import TimeChart from './TimeChart.jsx'
import FeetMap from './FeetMap.jsx'

function Stat({ label, value, unit }) {
  return (
    <div className="stat">
      <div className="stat-val">{value}<span>{unit}</span></div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

export default function ClinicianView({ m, snap }) {
  const hist = m?.hist || []
  const kneeVals = hist.map((h) => h.knee).filter((v) => v != null)
  const romMax = kneeVals.length ? Math.max(...kneeVals) : null
  const romMin = kneeVals.length ? Math.min(...kneeVals) : null
  const rom = romMax != null ? romMax - romMin : null

  let vel = 0
  if (hist.length >= 2) {
    const a = hist[hist.length - 1]
    const b = hist[Math.max(0, hist.length - 6)]
    if (a.knee != null && b.knee != null && a.t !== b.t) vel = Math.abs((a.knee - b.knee) / (a.t - b.t))
  }
  const hipMax = hist.reduce((mx, h) => (h.hip != null ? Math.max(mx, h.hip) : mx), 0)
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const sym = total > 60 ? Math.round((m.loadL / total) * 100) : null
  const fmt = (v, d = 0) => (v == null ? '--' : v.toFixed(d))

  return (
    <div className="clinician">
      <section className="card">
        <div className="card-head"><h3>Knee flexion</h3><span className="legend-inline">deg over time</span></div>
        <TimeChart data={hist} series={[{ key: 'knee', color: '#4ea1ff' }]} unit="°" windowS={25} />
        <div className="stat-row">
          <Stat label="current" value={fmt(m?.kneeAngle, 1)} unit="°" />
          <Stat label="ROM" value={fmt(rom, 0)} unit="°" />
          <Stat label="max flexion" value={fmt(romMax, 0)} unit="°" />
          <Stat label="reps" value={m?.reps ?? 0} unit="" />
          <Stat label="ang. velocity" value={fmt(vel, 0)} unit="°/s" />
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Pelvis tilt</h3><span className="legend-inline">deg from neutral</span></div>
        <TimeChart data={hist} series={[{ key: 'hip', color: '#f6c24b' }]} unit="°" windowS={25} />
        <div className="stat-row">
          <Stat label="current tilt" value={fmt(m?.hipTilt, 1)} unit="°" />
          <Stat label="max tilt" value={fmt(hipMax, 0)} unit="°" />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Foot loading &amp; symmetry</h3>
          <span className="legend-inline">
            <i className="dot blue" /> left <i className="dot orange" /> right
          </span>
        </div>
        <TimeChart data={hist}
          series={[{ key: 'loadL', color: '#4ea1ff' }, { key: 'loadR', color: '#f6774b' }]}
          windowS={25} />
        <div className="stat-row">
          <Stat label="left load" value={fmt(m?.loadL, 0)} unit="" />
          <Stat label="right load" value={fmt(m?.loadR, 0)} unit="" />
          <Stat label="L / R split" value={sym == null ? '--' : `${sym}/${100 - sym}`} unit="%" />
        </div>
        <FeetMap feet={snap?.feet} />
      </section>
    </div>
  )
}
