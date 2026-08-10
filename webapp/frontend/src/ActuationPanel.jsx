// Session tab: force-level control + twist/untwist for the actuation module.
// Commands go through POST /api/actuation/command, which works whether the
// backend is local (direct LAN broadcast) or the Render deploy (queued for
// relay.py to drain and re-broadcast) - see backend/ingest.py send_command
// vs queue_command.
//
// "Ready" (twisted to target) is judged from the board's own live tension_n,
// same honesty rule as the rest of the dashboard - no synthetic data. Until
// the strain gauge/motor loop is wired into the firmware (still placeholder
// 0.0/"idle" - see actuation/Firmware/prototyping/wifi_bringup.ino) that will
// never fire on its own, so a manual "Mark ready" is offered alongside it;
// it's a real control a user might need anyway (feel-based confirmation),
// not a fake sensor reading.
//
// Role split: the clinician does not run the patient's session - the level
// picker, Start, in-session Stop, the manual Twist/Untwist jog controls, AND
// Force Stop are all patient-only, since it's the patient's body wearing/
// operating the actuator. Instead, the backend (webapp/backend/sessions.py)
// looks at the patient's logged session history and recommends the next
// weight to try; the clinician's job on this tab is reviewing that history
// and approving/rejecting the recommendation, nothing hands-on. The
// recommendation itself is a nudge, not a lock - once approved it just
// surfaces a "use this weight" button on the patient's side, it doesn't
// auto-start anything or block other levels.
//
// All the session state/logic (phase, countdown, samples...) lives in
// useActuationSession.js, called once in App.jsx so it survives switching
// tabs - this component is just a view over that state (see also
// ActuationFloatingWidget.jsx, the compact view shown on OTHER tabs while a
// session is running).

import { StatusPill } from './ui.jsx'
import TimeChart from './TimeChart.jsx'
import ActuationLogCard from './ActuationLogCard.jsx'
import { KG_OPTIONS, EXERCISES } from './useActuationSession.js'

function downloadSummary(summary) {
  const lines = [
    'RUNMO actuation session report',
    new Date().toString(),
    `Target level: ${summary.target} kg`,
    `Duration: ${summary.durationS.toFixed(1)} s`,
    `Peak tension: ${summary.peak.toFixed(1)} kg`,
    `Avg tension: ${summary.avg.toFixed(1)} kg`,
    `Samples: ${summary.samples}`,
  ]
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `RUNMO-actuation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function ActuationPanel({ session, act }) {
  const isClinician = session?.role === 'clinician'
  const {
    online, tension, rec,
    level, setLevel, exercise, setExercise, phase, setPhase, countdown, summary, logRefreshKey,
    startSession, markReady, beginExercise, stopSession, forceStop,
    respondRecommendation, jogStart, jogStop,
    hasTarget, target, deltaPct, comparisonData, comparisonWindowS,
  } = act
  const selectedExercise = EXERCISES.find((ex) => ex.id === exercise)

  return (
    <div className="grid actuation">
      <div className={`card center accent-actuation ${online ? '' : 'off'}`}>
        <div className="card-head"><h3>Session Data</h3><StatusPill ok={online} /></div>
        <div className="act-tension">{online && hasTarget ? tension.toFixed(1) : '--'}<span> kg</span></div>
        {hasTarget ? (
          <div className={`act-consistency ${Math.abs(deltaPct) <= 5 ? 'good' : ''}`}>
            Target {target} kg · Actual {tension.toFixed(1)} kg · Δ {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(0)}%
          </div>
        ) : (
          <div className="cue">No active session</div>
        )}
        <div className="cue">Force Monitoring</div>
        <TimeChart data={comparisonData}
          series={[{ key: 'curTension', color: '#c77bf0' }, { key: 'prevTension', color: '#4ea1ff' }]}
          unit=" kg" windowS={comparisonWindowS} />
        <div className="act-chart-legend">
          <span className="legend-inline"><i className="dot" style={{ background: '#c77bf0' }} /> This session</span>
          <span className="legend-inline"><i className="dot blue" /> Previous session</span>
        </div>
      </div>

      {isClinician ? (
        <div className="card center accent-actuation act-session">
          <div className="card-head"><h3>Session</h3></div>
          <div className="cue">
            Session control belongs to the patient - use the recommendation card to review their
            progress and approve or reject the next weight.
          </div>
        </div>
      ) : (
        <div className="card center accent-actuation act-session">
          <div className="card-head"><h3>Session</h3></div>

          {phase === 'idle' && (
            <>
              <label className="act-level">
                <span>Exercise</span>
                <div className="act-kg-row">
                  {EXERCISES.map((ex) => (
                    <button key={ex.id} type="button" className={`btn ghost act-kg-btn ${exercise === ex.id ? 'on' : ''}`}
                      onClick={() => setExercise(ex.id)}>
                      {ex.label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="act-level">
                <span>Force level: {level} kg</span>
                <div className="act-kg-row">
                  {KG_OPTIONS.map((kg) => (
                    <button key={kg} type="button" className={`btn ghost act-kg-btn ${level === kg ? 'on' : ''}`}
                      onClick={() => setLevel(kg)}>
                      {kg} kg
                    </button>
                  ))}
                </div>
              </label>
              {rec?.status === 'approved' && (
                <div className="cue good">
                  Your therapist recommends {rec.kg} kg next.{' '}
                  <button type="button" className="btn ghost act-kg-btn" onClick={() => setLevel(rec.kg)}>
                    Use {rec.kg} kg
                  </button>
                </div>
              )}
              <button className="btn download" onClick={startSession} disabled={!online}>
                Start session
              </button>
              {!online && <div className="cue">Board offline - connect it to start</div>}
            </>
          )}

          {phase === 'countdown' && (
            <div className="act-countdown">{countdown}</div>
          )}

          {phase === 'twisting' && (
            <>
              <div className="cue">Twisting to {level} kg…</div>
              <div className="act-tension small">{tension.toFixed(1)} / {level} kg</div>
              <button className="btn ghost" onClick={markReady}>Mark ready</button>
            </>
          )}

          {phase === 'ready' && (
            <>
              <div className="cue good">Ready - twisted to target</div>
              <button className="btn download" onClick={beginExercise}>Begin exercise</button>
            </>
          )}

          {phase === 'exercising' && (
            <>
              <div className="cue good">Exercise in progress</div>
              <div className="act-tension small">{target} kg</div>
              <button className="stop-circle" onClick={stopSession}>Stop</button>
            </>
          )}

          {phase === 'summary' && summary && (
            <div className="act-summary">
              <div className="act-summary-title">Session complete</div>
              <div>Target: {summary.target} kg</div>
              <div>Duration: {summary.durationS.toFixed(1)} s</div>
              <div>Peak tension: {summary.peak.toFixed(1)} kg</div>
              <div>Avg tension: {summary.avg.toFixed(1)} kg</div>
              <div className="act-summary-actions">
                <button className="btn ghost" onClick={() => downloadSummary(summary)}>Download report</button>
                <button className="btn download" onClick={() => setPhase('idle')}>New session</button>
              </div>
            </div>
          )}
        </div>
      )}

      {rec && (
        <div className="card center accent-actuation act-recommendation">
          <div className="card-head"><h3>System Recommendation</h3></div>
          <div className="cue">For your next session:</div>
          <div className="act-rec-row">
            <div className="act-rec-col">
              <div className="cue">{selectedExercise?.label}</div>
              <div className="act-tension small">{rec.kg} kg</div>
            </div>
            <div className="act-rec-col">
              <div className="cue">Reps</div>
              <div className="act-tension small">{selectedExercise?.ptReps}</div>
            </div>
          </div>
          <div className="cue">{rec.reason}</div>
          {isClinician && rec.status === 'pending' && (
            <div className="act-summary-actions">
              <button className="btn download" onClick={() => respondRecommendation(true)}>Approve</button>
              <button className="btn ghost" onClick={() => respondRecommendation(false)}>Reject</button>
            </div>
          )}
          {isClinician && rec.status === 'approved' && (
            <div className="cue good">Approved - patient notified</div>
          )}
          {isClinician && rec.status === 'rejected' && (
            <div className="cue">Rejected</div>
          )}
          {!isClinician && rec.status === 'pending' && (
            <div className="cue">Waiting for your therapist to review this</div>
          )}
          {!isClinician && rec.status === 'approved' && (
            <span className="pill live"><i className="pill-dot" />Approved by your therapist</span>
          )}
        </div>
      )}

      {!isClinician && (
        <div className="card center accent-actuation">
          <div className="card-head"><h3>Manual control</h3></div>
          <div className="act-jog">
            <button className="btn ghost"
              onMouseDown={() => jogStart('twist')} onMouseUp={jogStop} onMouseLeave={jogStop}
              onTouchStart={() => jogStart('twist')} onTouchEnd={jogStop}>
              Twist
            </button>
            <button className="btn ghost"
              onMouseDown={() => jogStart('untwist')} onMouseUp={jogStop} onMouseLeave={jogStop}
              onTouchStart={() => jogStart('untwist')} onTouchEnd={jogStop}>
              Untwist
            </button>
          </div>
          <div className="cue">Press and hold</div>
          <button className="stop-circle" onClick={forceStop}>Force stop</button>
        </div>
      )}

      <ActuationLogCard refreshKey={logRefreshKey} />
    </div>
  )
}
