import Ring from './Ring.jsx'
import { StatusPill } from './ui.jsx'

function Head({ title, ok }) {
  return <div className="card-head"><h3>{title}</h3><StatusPill ok={ok} /></div>
}

function BalanceBar({ m }) {
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const active = total > 400 && (m?.lOk || m?.rOk)
  const leftPct = active ? (m.loadL / total) * 100 : 50
  let cue = 'Step onto the insoles'
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

function KneeCard({ title, ok, angle, reps, kneeTarget, formFlag, hipFlex, hipFlexCalibrated }) {
  const reached = ok && angle >= kneeTarget
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
    </div>
  )
}

export default function PatientView({ m, kneeTarget }) {
  const hipOk = !!m?.hipOk
  const feetOk = !!(m?.lOk || m?.rOk)
  const hipLevel = hipOk && m.hipTilt < 10

  return (
    <div className="grid patient">
      <KneeCard title="Left knee bend" ok={!!m?.kneeLOk} angle={m?.kneeLAngle}
        reps={m?.repsL} kneeTarget={kneeTarget} formFlag={m?.formFlagL}
        hipFlex={m?.hipFlexL} hipFlexCalibrated={!!m?.hipFlexCalibratedL} />
      <KneeCard title="Right knee bend" ok={!!m?.kneeROk} angle={m?.kneeRAngle}
        reps={m?.repsR} kneeTarget={kneeTarget} formFlag={m?.formFlagR}
        hipFlex={m?.hipFlexR} hipFlexCalibrated={!!m?.hipFlexCalibratedR} />

      <div className={`card center accent-balance ${feetOk ? '' : 'off'}`}>
        <Head title="Weight balance" ok={feetOk} />
        <BalanceBar m={m} />
      </div>

      <div className={`card center accent-hip ${hipOk ? '' : 'off'}`}>
        <Head title="Keep hips level" ok={hipOk} />
        <Ring value={hipOk ? m.hipTilt : null} max={20} unit="°" sub="stay under 10°"
          reached={hipLevel} color={hipLevel ? '#3ddc84' : '#f6c24b'} />
        <div className={`cue ${hipOk && hipLevel ? 'good' : ''}`}>
          {hipOk ? (hipLevel ? 'Level' : 'Straighten up') : 'Waiting for sensor'}
        </div>
      </div>
    </div>
  )
}
