import Ring from './Ring.jsx'
import { StatusPill } from './ui.jsx'
import { profileSummary } from './auth.js'
import ProgressTrend from './ProgressTrend.jsx'

function Head({ title, ok }) {
  return <div className="card-head"><h3>{title}</h3><StatusPill ok={ok} /></div>
}

function BalanceBar({ m }) {
  const settling = !!m?.feetSettling
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const active = !settling && total > 400 && (m?.lOk || m?.rOk)
  const leftPct = active ? (m.loadL / total) * 100 : 50
  let cue = settling ? 'Calibrating…' : 'Step onto the insoles'
  if (active) {
    const diff = leftPct - 50
    if (Math.abs(diff) < 8) cue = 'Nicely balanced'
    else cue = diff > 0 ? 'Shift weight to your right' : 'Shift weight to your left'
  }
  const good = active && Math.abs(leftPct - 50) < 8
  return (
    <div className="balance">
      <div className="balance-track">
        <div className="balance-fill left" style={{ width: `${leftPct}%` }} />
        <div className="balance-fill right" style={{ width: `${100 - leftPct}%` }} />
        <div className="balance-center" />
      </div>
      <div className="balance-ends">
        <span>L {active ? Math.round(leftPct) : '--'}%</span>
        <span>{active ? Math.round(100 - leftPct) : '--'}% R</span>
      </div>
      <div className={`cue ${good ? 'good' : ''}`}>{cue}</div>
    </div>
  )
}

// Green/yellow/red thresholds match the reference clinical spec's Symmetry
// Score bands: >90% well balanced, 75-89% borderline, <75% needs work.
function symmetryColor(pct) {
  if (pct == null) return '#8b96a5'
  if (pct >= 90) return '#3ddc84'
  if (pct >= 75) return '#f6c24b'
  return '#ff5a4d'
}

function ScoreCard({ score }) {
  return (
    <div className={`card center accent-balance ${score == null ? 'off' : ''}`}>
      <Head title="Rehab score" ok={score != null} />
      <div className="score-big">{score ?? '--'}<span>/ 100</span></div>
      <div className="cue">
        {score == null ? 'Not enough data yet' : score >= 90 ? 'Excellent' : score >= 75 ? 'Good progress' : 'Keep going'}
      </div>
    </div>
  )
}

// Symmetry Index (SI) turned into a "goodness" percent for the ring - see
// useMetrics.js for how SI itself is derived (stance-time + knee-flexion
// comparison, standard SI = |L-R| / (0.5*(L+R)) * 100 formula).
function SymmetryCard({ si }) {
  const pct = si != null ? Math.max(0, 100 - si) : null
  const good = pct != null && pct >= 90
  return (
    <div className={`card center accent-balance ${pct == null ? 'off' : ''}`}>
      <Head title="Leg symmetry" ok={pct != null} />
      <Ring value={pct} max={100} unit="%" sub="target >90%" reached={good} color={symmetryColor(pct)} />
      <div className={`cue ${good ? 'good' : ''}`}>
        {pct == null ? 'Waiting for data' : good ? 'Well balanced' : 'Work on evening out left/right'}
      </div>
    </div>
  )
}

function CadenceCard({ cadence }) {
  return (
    <div className={`card center accent-hip ${cadence == null ? 'off' : ''}`}>
      <Head title="Cadence" ok={cadence != null} />
      <Ring value={cadence} max={140} unit="" sub="steps / min" color="#c77bf0" />
      <div className="cue">{cadence == null ? 'Keep walking to measure' : 'Steps per minute'}</div>
    </div>
  )
}

function KneeCard({ title, ok, angle, reps, kneeTarget, formFlag, hipFlex, hipFlexCalibrated,
  calPhase, calMsg, onCalibrate, onResetReps }) {
  const reached = ok && angle >= kneeTarget
  const awaitingBent = calPhase === 'awaiting-bent'
  return (
    <div className={`card center accent-knee ${ok ? '' : 'off'}`}>
      <Head title={title} ok={ok} />
      <Ring value={ok ? angle : null} max={kneeTarget} sub={`target ${kneeTarget}°`}
        reached={reached} color="#4ea1ff" />
      {ok ? (
        <>
          <div className="reps">{reps ?? 0}<span>reps</span></div>
          <div className={`cue ${reached ? 'good' : ''}`}>
            {reached ? 'Target reached' : 'Keep bending'}
          </div>
          {formFlag && <div className="form-flag">{formFlag}</div>}
          {hipFlexCalibrated && (
            <div className="hip-flex-stat">
              Hip flexion: {hipFlex != null ? `${hipFlex.toFixed(0)}°` : '--'}
            </div>
          )}
        </>
      ) : <div className="cue">Waiting for sensor</div>}
      <div className="card-actions">
        <button className={`btn ghost ${awaitingBent ? 'on' : ''}`} onClick={onCalibrate}>
          {awaitingBent ? 'Capture bent' : 'Calibrate'}
        </button>
        <button className="btn ghost" onClick={onResetReps}>Reset reps</button>
      </div>
      {calMsg && <div className="cal-msg">{calMsg}</div>}
    </div>
  )
}

export default function PatientView({ m, kneeTarget, session, actions }) {
  const hipOk = !!m?.hipOk
  const feetOk = !!(m?.lOk || m?.rOk)
  const hipLevel = hipOk && m.hipTilt < 10
  const profile = profileSummary(session)
  const hipTiltAwaitingLean = m?.calPhaseHipTilt === 'awaiting-lean'
  const hipFlexAwaitingFlexed = m?.calPhaseHip === 'awaiting-flexed'

  return (
    <div className="patient-wrap">
      {profile && <div className="patient-profile">Personalizing for {profile}</div>}
      <div className="grid patient">
      <KneeCard title="Left knee bend" ok={!!m?.kneeLOk} angle={m?.kneeLAngle}
        reps={m?.repsL} kneeTarget={kneeTarget} formFlag={m?.formFlagL}
        hipFlex={m?.hipFlexL} hipFlexCalibrated={!!m?.hipFlexCalibratedL}
        calPhase={m?.calPhaseL} calMsg={m?.calMsgL}
        onCalibrate={actions.calibrateKneeL} onResetReps={actions.resetReps} />
      <KneeCard title="Right knee bend" ok={!!m?.kneeROk} angle={m?.kneeRAngle}
        reps={m?.repsR} kneeTarget={kneeTarget} formFlag={m?.formFlagR}
        hipFlex={m?.hipFlexR} hipFlexCalibrated={!!m?.hipFlexCalibratedR}
        calPhase={m?.calPhaseR} calMsg={m?.calMsgR}
        onCalibrate={actions.calibrateKneeR} onResetReps={actions.resetReps} />

      <div className={`card center accent-balance ${feetOk ? '' : 'off'}`}>
        <Head title="Weight balance" ok={feetOk} />
        <BalanceBar m={m} />
        <div className="card-actions">
          <button className="btn ghost" onClick={actions.zeroFeet}>Zero feet</button>
          <button className="btn ghost" onClick={actions.calibrateBalance}>Calibrate balance</button>
        </div>
        {m?.calMsgBalance && <div className="cal-msg">{m.calMsgBalance}</div>}
      </div>

      <div className={`card center accent-hip ${hipOk ? '' : 'off'}`}>
        <Head title="Keep hips level" ok={hipOk} />
        <Ring value={hipOk ? m.hipTilt : null} max={20} unit="°" sub="stay under 10°"
          reached={hipLevel} color={hipLevel ? '#3ddc84' : '#f6c24b'} />
        <div className={`cue ${hipOk && hipLevel ? 'good' : ''}`}>
          {hipOk ? (hipLevel ? 'Level' : 'Straighten up') : 'Waiting for sensor'}
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
      </div>

      </div>

      <div className="grid performance">
        <ScoreCard score={m?.rehabScore} />
        <SymmetryCard si={m?.symmetryIndexOverall} />
        <CadenceCard cadence={m?.cadence} />
      </div>

      <ProgressTrend />
    </div>
  )
}
