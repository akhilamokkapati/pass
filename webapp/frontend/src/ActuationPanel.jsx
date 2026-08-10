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
// picker, Start, in-session Stop, AND the manual Twist/Untwist jog controls
// are all patient-only, since it's the patient's body wearing/operating the
// actuator. Instead, the backend (webapp/backend/sessions.py) looks at the
// patient's logged session history and recommends the next weight to try;
// the clinician's job on this tab is reviewing that history and approving/
// rejecting the recommendation, nothing hands-on. Force Stop is the one
// control available to BOTH roles - it's a safety escape hatch, not a way to
// run the exercise, so it shouldn't require the patient to be the one
// holding it. The recommendation itself is a nudge, not a lock - once
// approved it just surfaces a "use this weight" button on the patient's
// side, it doesn't auto-start anything or block other levels.

import { useEffect, useRef, useState } from 'react'
import { StatusPill } from './ui.jsx'
import TimeChart from './TimeChart.jsx'
import ActuationLogCard from './ActuationLogCard.jsx'

async function postJson(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return null   // offline - caller already has its own local state to fall back on
  }
}

// Shared by stopSession (normal Stop) and forceStop (mid-exercise Force Stop)
// so both log to the same shape via /api/actuation/session.
function summarizeSession(s) {
  const durationS = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0
  const peak = s.samples.reduce((mx, v) => Math.max(mx, v), 0)
  const avg = s.samples.length ? s.samples.reduce((a, v) => a + v, 0) / s.samples.length : 0
  return { durationS, peak, avg }
}

const COUNTDOWN_S = 3
const JOG_REPEAT_MS = 150
// Samples are pushed once per WebSocket tick while phase === 'exercising'
// (see the useEffect below), and the backend broadcasts at a fixed 20 Hz
// (main.py's _broadcaster) - so index * this constant approximates each
// sample's elapsed time within its session. Good enough for a comparison
// chart; not a precision timing claim.
const SAMPLE_DT_S = 0.05
const READY_MARGIN = 0.95   // fraction of target tension counted as "reached"
// Preset force-level buttons (kg) replacing the old 0-100 slider. Sent to the
// board as-is (raw kg), matching set_force/twist's existing unit convention -
// tension_n already reads on this same scale, not true SI Newtons.
const KG_OPTIONS = [1, 2, 3, 4, 5]

async function sendCmd(cmd, value = 0) {
  try {
    await fetch('/api/actuation/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, value }),
    })
  } catch { /* offline - button still gives feedback, command just won't land */ }
}

function downloadSummary(summary) {
  const lines = [
    'PASS actuation session report',
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
  a.download = `PASS-actuation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function ActuationPanel({ m, session }) {
  const online = !!m?.actuationOk
  const tension = m?.actuationTension ?? 0
  const boardState = m?.actuationState ?? null
  const isClinician = session?.role === 'clinician'
  const rec = m?.actuationRecommendation ?? null

  const [level, setLevel] = useState(KG_OPTIONS[0])
  const [phase, setPhase] = useState('idle') // idle | countdown | twisting | ready | exercising | summary
  const [countdown, setCountdown] = useState(COUNTDOWN_S)
  const [summary, setSummary] = useState(null)
  const [logRefreshKey, setLogRefreshKey] = useState(0)
  // The previous session's full tension curve, for the live chart to compare
  // the in-progress session against - frozen at whatever it was when THIS
  // session started (see startSession), not re-fetched after logging, or
  // "previous" would immediately become the session that just finished.
  const [previousSamples, setPreviousSamples] = useState([])
  const sessionRef = useRef({ startedAt: null, samples: [], target: 0 })
  const jogTimer = useRef(null)

  const fetchPreviousSamples = () => {
    fetch('/api/actuation/session/latest')
      .then((res) => res.json())
      .then((data) => setPreviousSamples(data?.session?.samplesSeries || []))
      .catch(() => {})
  }
  useEffect(fetchPreviousSamples, [])

  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      sessionRef.current = { startedAt: null, samples: [], target: level }
      sendCmd('set_force', level)
      sendCmd('twist', level)
      setPhase('twisting')
      return
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown, level])

  useEffect(() => {
    if (phase !== 'twisting') return
    if (online && tension >= sessionRef.current.target * READY_MARGIN && sessionRef.current.target > 0) {
      setPhase('ready')
    }
  }, [phase, online, tension])

  useEffect(() => {
    if (phase !== 'exercising') return
    sessionRef.current.samples.push(tension)
  }, [phase, tension])

  useEffect(() => () => clearInterval(jogTimer.current), [])

  const startSession = () => {
    fetchPreviousSamples()
    setSummary(null)
    setCountdown(COUNTDOWN_S)
    setPhase('countdown')
  }

  const markReady = () => setPhase('ready')

  const beginExercise = () => {
    sessionRef.current.startedAt = Date.now()
    sessionRef.current.samples = []
    setPhase('exercising')
  }

  const stopSession = () => {
    const s = sessionRef.current
    const { durationS, peak, avg } = summarizeSession(s)
    setSummary({ target: s.target, durationS, peak, avg, samples: s.samples.length })
    sendCmd('untwist', 1)
    setPhase('summary')
    postJson('/api/actuation/session', {
      target: s.target, durationS, peak, avg, samples: s.samples.length,
      completed: true, kgOptions: KG_OPTIONS, samplesSeries: s.samples,
    }).then(() => setLogRefreshKey((k) => k + 1))
  }

  // A force stop mid-exercise is still a meaningful data point ("this level
  // was too much") - log it same as a normal Stop, just with completed:false,
  // so the recommendation can react to it. A force stop from any other phase
  // (still twisting, hasn't started exercising yet) has no sample data worth
  // logging.
  const forceStop = () => {
    clearInterval(jogTimer.current)
    sendCmd('stop', 0)
    if (phase === 'exercising') {
      const s = sessionRef.current
      const { durationS, peak, avg } = summarizeSession(s)
      postJson('/api/actuation/session', {
        target: s.target, durationS, peak, avg, samples: s.samples.length,
        completed: false, kgOptions: KG_OPTIONS, samplesSeries: s.samples,
      }).then(() => setLogRefreshKey((k) => k + 1))
    }
    setPhase('idle')
  }

  const respondRecommendation = (approved) =>
    postJson('/api/actuation/recommendation/respond', { approved })

  const jogStart = (cmd) => {
    sendCmd(cmd, 1)
    clearInterval(jogTimer.current)
    jogTimer.current = setInterval(() => sendCmd(cmd, 1), JOG_REPEAT_MS)
  }
  const jogStop = () => {
    clearInterval(jogTimer.current)
    sendCmd('stop', 0)
  }

  // Target-vs-actual consistency (supposed force vs what the strain gauge
  // reports) - only meaningful once a session has actually commanded a
  // target; before that there's nothing to be consistent WITH.
  const hasTarget = ['twisting', 'ready', 'exercising'].includes(phase) && sessionRef.current.target > 0
  const target = sessionRef.current.target
  const deltaPct = hasTarget && target > 0 ? ((tension - target) / target) * 100 : null

  // Current session (in progress, or just-finished until the next Start
  // resets it) vs the one immediately before it, both indexed by elapsed
  // time WITHIN their own session rather than wall-clock time - that's what
  // makes them comparable on the same axis regardless of when each was run.
  const curSamples = sessionRef.current.samples
  const comparisonData = []
  for (let i = 0; i < previousSamples.length; i++) {
    comparisonData.push({ t: i * SAMPLE_DT_S, prevTension: previousSamples[i] })
  }
  for (let i = 0; i < curSamples.length; i++) {
    comparisonData.push({ t: i * SAMPLE_DT_S, curTension: curSamples[i] })
  }
  comparisonData.sort((a, b) => a.t - b.t)
  const comparisonWindowS = Math.max(
    previousSamples.length * SAMPLE_DT_S,
    curSamples.length * SAMPLE_DT_S,
    10,
  )

  return (
    <div className="grid actuation">
      <div className={`card center accent-actuation ${online ? '' : 'off'}`}>
        <div className="card-head"><h3>Actuation</h3><StatusPill ok={online} /></div>
        <div className="act-tension">{online ? tension.toFixed(1) : '--'}<span> kg</span></div>
        <div className="cue">{online ? `board state: ${boardState}` : 'Waiting for board'}</div>
        {hasTarget && (
          <div className={`act-consistency ${Math.abs(deltaPct) <= 5 ? 'good' : ''}`}>
            Target {target} kg · Actual {tension.toFixed(1)} kg · Δ {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(0)}%
          </div>
        )}
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
              <div className="act-tension small">{tension.toFixed(1)} kg</div>
              <button className="btn ghost" onClick={stopSession}>Stop</button>
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
          <div className="card-head"><h3>Next-weight recommendation</h3></div>
          <div className="act-tension small">{rec.kg} kg</div>
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
        </div>
      )}

      <button className="btn ghost act-force-stop" onClick={forceStop}>Force stop</button>

      <ActuationLogCard refreshKey={logRefreshKey} />
    </div>
  )
}
