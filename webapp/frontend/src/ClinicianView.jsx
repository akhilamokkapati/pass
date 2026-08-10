import { useState } from 'react'
import TimeChart from './TimeChart.jsx'
import FeetMap from './FeetMap.jsx'
import { StatusPill } from './ui.jsx'
import { downloadReport } from './report.js'
import { downloadCSV } from './csv.js'
import AiSummaryCard from './AiSummaryCard.jsx'

function Stat({ label, value, unit }) {
  return (
    <div className="stat">
      <div className="stat-val">{value}<span>{unit}</span></div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function kneeSideStats(hist, key) {
  const vals = hist.map((h) => h[key]).filter((v) => v != null)
  const romMax = vals.length ? Math.max(...vals) : null
  const romMin = vals.length ? Math.min(...vals) : null
  const rom = romMax != null ? romMax - romMin : null
  let vel = 0
  if (hist.length >= 2) {
    const a = hist[hist.length - 1]
    const b = hist[Math.max(0, hist.length - 6)]
    if (a[key] != null && b[key] != null && a.t !== b.t) vel = Math.abs((a[key] - b[key]) / (a.t - b.t))
  }
  return { romMax, rom, vel }
}

export default function ClinicianView({ m, snap, feetZeroEpoch, actions }) {
  // Latest AI summary (once the clinician generates one) so the PDF can embed it.
  const [aiSummary, setAiSummary] = useState('')
  const hist = m?.hist || []
  const left = kneeSideStats(hist, 'kneeL')
  const right = kneeSideStats(hist, 'kneeR')
  const hipMax = hist.reduce((mx, h) => (h.hip != null ? Math.max(mx, h.hip) : mx), 0)
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const sym = (!m?.feetSettling && total > 60) ? Math.round((m.loadL / total) * 100) : null
  const fmt = (v, d = 0) => (v == null ? '--' : v.toFixed(d))

  const kneeLOk = !!m?.kneeLOk
  const kneeROk = !!m?.kneeROk
  const hipOk = !!m?.hipOk
  const feetOk = !!(m?.lOk || m?.rOk)
  const kneeLAwaitingBent = m?.calPhaseL === 'awaiting-bent'
  const kneeRAwaitingBent = m?.calPhaseR === 'awaiting-bent'
  const hipTiltAwaitingLean = m?.calPhaseHipTilt === 'awaiting-lean'
  const hipFlexAwaitingFlexed = m?.calPhaseHip === 'awaiting-flexed'

  return (
    <div className="clinician">
      <div className="clinician-head">
        <span className="clinician-title">Session detail</span>
        <div className="clinician-head-actions">
          <button className="btn download" onClick={() => downloadReport(m, aiSummary)}>
            <span className="dl-ico" /> Download report
          </button>
          <button className="btn ghost" onClick={() => downloadCSV(m)}>
            Download CSV
          </button>
        </div>
      </div>

      <AiSummaryCard onSummary={setAiSummary} />

      <section className="card accent-knee">
        <div className="card-head"><h3>Left knee flexion</h3><StatusPill ok={kneeLOk} /></div>
        <TimeChart data={hist} series={[{ key: 'kneeL', color: '#4ea1ff' }]} unit="°" windowS={25} />
        <div className="stat-row">
          <Stat label="current" value={fmt(m?.kneeLAngle, 1)} unit="°" />
          <Stat label="ROM" value={fmt(left.rom, 0)} unit="°" />
          <Stat label="max flexion" value={fmt(left.romMax, 0)} unit="°" />
          <Stat label="reps" value={m?.repsL ?? 0} unit="" />
          <Stat label="ang. velocity" value={fmt(left.vel, 0)} unit="°/s" />
        </div>
        <div className="card-actions">
          <button className={`btn ghost ${kneeLAwaitingBent ? 'on' : ''}`} onClick={actions.calibrateKneeL}>
            {kneeLAwaitingBent ? 'Capture bent' : 'Calibrate'}
          </button>
          <button className="btn ghost" onClick={actions.resetReps}>Reset reps</button>
        </div>
        {m?.calMsgL && <div className="cal-msg">{m.calMsgL}</div>}
      </section>

      <section className="card accent-knee">
        <div className="card-head"><h3>Right knee flexion</h3><StatusPill ok={kneeROk} /></div>
        <TimeChart data={hist} series={[{ key: 'kneeR', color: '#f6774b' }]} unit="°" windowS={25} />
        <div className="stat-row">
          <Stat label="current" value={fmt(m?.kneeRAngle, 1)} unit="°" />
          <Stat label="ROM" value={fmt(right.rom, 0)} unit="°" />
          <Stat label="max flexion" value={fmt(right.romMax, 0)} unit="°" />
          <Stat label="reps" value={m?.repsR ?? 0} unit="" />
          <Stat label="ang. velocity" value={fmt(right.vel, 0)} unit="°/s" />
        </div>
        <div className="card-actions">
          <button className={`btn ghost ${kneeRAwaitingBent ? 'on' : ''}`} onClick={actions.calibrateKneeR}>
            {kneeRAwaitingBent ? 'Capture bent' : 'Calibrate'}
          </button>
          <button className="btn ghost" onClick={actions.resetReps}>Reset reps</button>
        </div>
        {m?.calMsgR && <div className="cal-msg">{m.calMsgR}</div>}
      </section>

      <section className="card accent-hip">
        <div className="card-head"><h3>Pelvis tilt</h3><StatusPill ok={hipOk} /></div>
        <TimeChart data={hist} series={[{ key: 'hip', color: '#f6c24b' }]} unit="°" windowS={25} />
        <div className="stat-row">
          <Stat label="current tilt" value={fmt(m?.hipTilt, 1)} unit="°" />
          <Stat label="max tilt" value={fmt(hipMax, 0)} unit="°" />
        </div>
        <div className="card-actions">
          <button className="btn ghost" onClick={actions.zeroHip}>Zero hip</button>
          <button className={`btn ghost ${hipTiltAwaitingLean ? 'on' : ''}`} onClick={actions.calibrateHipTilt}>
            {hipTiltAwaitingLean ? 'Capture lean right' : 'Calibrate tilt direction'}
          </button>
          <button className={`btn ghost ${hipFlexAwaitingFlexed ? 'on' : ''}`} onClick={actions.calibrateHips}>
            {hipFlexAwaitingFlexed ? 'Capture flexed' : 'Calibrate hip flexion'}
          </button>
        </div>
        {m?.calMsgHipTilt && <div className="cal-msg">{m.calMsgHipTilt}</div>}
        {m?.calMsgHip && <div className="cal-msg">{m.calMsgHip}</div>}
      </section>

      <section className="card accent-balance">
        <div className="card-head">
          <h3>Gait timing &amp; symmetry</h3>
          <span className="legend-inline">SI formula: |L-R| / (0.5*(L+R)) &times; 100</span>
        </div>
        <div className="stat-row">
          <Stat label="stance L" value={fmt(m?.stancePctL, 0)} unit="%" />
          <Stat label="stance R" value={fmt(m?.stancePctR, 0)} unit="%" />
          <Stat label="double support" value={fmt(m?.doubleSupportPct, 0)} unit="%" />
          <Stat label="cadence" value={fmt(m?.cadence, 0)} unit=" spm" />
        </div>
        <div className="stat-row">
          <Stat label="SI - stance time" value={fmt(m?.siStance, 1)} unit="%" />
          <Stat label="SI - knee flexion" value={fmt(m?.siKneeFlex, 1)} unit="%" />
          <Stat label="rehab score" value={m?.rehabScore ?? '--'} unit="/100" />
        </div>
      </section>

      <section className="card accent-balance">
        <div className="card-head">
          <h3>Foot loading and symmetry</h3>
          <span className="legend-inline"><i className="dot blue" /> left <i className="dot orange" /> right</span>
        </div>
        <TimeChart data={hist}
          series={[{ key: 'loadL', color: '#4ea1ff' }, { key: 'loadR', color: '#f6774b' }]}
          windowS={25} />
        <div className="stat-row">
          <Stat label="left load" value={fmt(m?.loadL, 0)} unit="" />
          <Stat label="right load" value={fmt(m?.loadR, 0)} unit="" />
          <Stat label="L / R split" value={sym == null ? '--' : `${sym}/${100 - sym}`} unit="%" />
          <Stat label="feet" value={feetOk ? 'connected' : 'not conn.'} unit="" />
        </div>
        <FeetMap feet={snap?.feet} resetKey={feetZeroEpoch} />
        <div className="card-actions">
          <button className="btn ghost" onClick={actions.zeroFeet}>Zero feet</button>
          <button className="btn ghost" onClick={actions.calibrateBalance}>Calibrate balance</button>
        </div>
        {m?.calMsgBalance && <div className="cal-msg">{m.calMsgBalance}</div>}
      </section>
    </div>
  )
}
