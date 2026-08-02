import Ring from './Ring.jsx'

function BalanceBar({ m }) {
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const active = total > 60 && (m?.lOk || m?.rOk)
  const leftPct = active ? (m.loadL / total) * 100 : 50
  let cue = 'Step onto the insoles'
  if (active) {
    const diff = leftPct - 50
    if (Math.abs(diff) < 8) cue = 'Nicely balanced ✓'
    else if (diff > 0) cue = 'Shift weight to your right'
    else cue = 'Shift weight to your left'
  }
  const good = active && Math.abs(leftPct - 50) < 8
  return (
    <div className="balance">
      <div className="balance-track">
        <div className="balance-fill left" style={{ width: `${leftPct}%` }} />
        <div className="balance-fill right" style={{ width: `${100 - leftPct}%` }} />
        <div className="balance-center" />
      </div>
      <div className="balance-ends"><span>L {active ? Math.round(leftPct) : '--'}%</span>
        <span>{active ? Math.round(100 - leftPct) : '--'}% R</span></div>
      <div className={`cue ${good ? 'good' : ''}`}>{cue}</div>
    </div>
  )
}

export default function PatientView({ m, kneeTarget }) {
  const kneeReached = m?.kneeOk && m.kneeAngle >= kneeTarget
  const hipLevel = m?.hipOk && m.hipTilt < 10
  return (
    <div className="grid patient">
      <div className="card center">
        <h3>Knee bend</h3>
        <Ring value={m?.kneeOk ? m.kneeAngle : null} max={kneeTarget}
          sub={`target ${kneeTarget}°`} reached={kneeReached} color="#4ea1ff" />
        <div className="reps">{m?.reps ?? 0}<span>reps</span></div>
        <div className={`cue ${kneeReached ? 'good' : ''}`}>
          {!m?.kneeOk ? 'knee sensor offline'
            : kneeReached ? 'Target reached 🎉' : 'Keep bending…'}
        </div>
      </div>

      <div className="card center">
        <h3>Weight balance</h3>
        <BalanceBar m={m} />
      </div>

      <div className="card center">
        <h3>Keep hips level</h3>
        <Ring value={m?.hipOk ? m.hipTilt : null} max={20} unit="°"
          sub="stay under 10°" reached={hipLevel}
          color={hipLevel ? '#3ddc84' : '#f6c24b'} />
        <div className={`cue ${hipLevel ? 'good' : ''}`}>
          {!m?.hipOk ? 'hip sensor offline' : hipLevel ? 'Level ✓' : 'Straighten up'}
        </div>
      </div>
    </div>
  )
}
