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

import { useEffect, useRef, useState } from 'react'
import { StatusPill } from './ui.jsx'
import TimeChart from './TimeChart.jsx'

const COUNTDOWN_S = 3
const JOG_REPEAT_MS = 150
const READY_MARGIN = 0.95   // fraction of target tension counted as "reached"
// Preset force-level buttons (kg) replacing the old 0-100 slider. Sent to the
// board as-is (raw kg), matching set_force/twist's existing unit convention -
// tension_n already reads on this same scale, not true SI Newtons.
const KG_OPTIONS = [2, 4, 6, 8, 10, 12]

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

export default function ActuationPanel({ m }) {
  const online = !!m?.actuationOk
  const tension = m?.actuationTension ?? 0
  const boardState = m?.actuationState ?? null

  const [level, setLevel] = useState(KG_OPTIONS[0])
  const [phase, setPhase] = useState('idle') // idle | countdown | twisting | ready | exercising | summary
  const [countdown, setCountdown] = useState(COUNTDOWN_S)
  const [summary, setSummary] = useState(null)
  const session = useRef({ startedAt: null, samples: [], target: 0 })
  const jogTimer = useRef(null)

  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      session.current = { startedAt: null, samples: [], target: level }
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
    if (online && tension >= session.current.target * READY_MARGIN && session.current.target > 0) {
      setPhase('ready')
    }
  }, [phase, online, tension])

  useEffect(() => {
    if (phase !== 'exercising') return
    session.current.samples.push(tension)
  }, [phase, tension])

  useEffect(() => () => clearInterval(jogTimer.current), [])

  const startSession = () => {
    setSummary(null)
    setCountdown(COUNTDOWN_S)
    setPhase('countdown')
  }

  const markReady = () => setPhase('ready')

  const beginExercise = () => {
    session.current.startedAt = Date.now()
    session.current.samples = []
    setPhase('exercising')
  }

  const stopSession = () => {
    const s = session.current
    const durationS = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0
    const peak = s.samples.reduce((mx, v) => Math.max(mx, v), 0)
    const avg = s.samples.length ? s.samples.reduce((a, v) => a + v, 0) / s.samples.length : 0
    setSummary({ target: s.target, durationS, peak, avg, samples: s.samples.length })
    sendCmd('untwist', 1)
    setPhase('summary')
  }

  const forceStop = () => {
    clearInterval(jogTimer.current)
    sendCmd('stop', 0)
    setPhase('idle')
  }

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
  const hasTarget = ['twisting', 'ready', 'exercising'].includes(phase) && session.current.target > 0
  const target = session.current.target
  const deltaPct = hasTarget && target > 0 ? ((tension - target) / target) * 100 : null

  const chartData = (m?.hist || []).map((h) => ({
    ...h,
    actuationTarget: hasTarget ? target : null,
  }))

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
        <TimeChart data={chartData}
          series={[{ key: 'actuationTension', color: '#c77bf0' }, { key: 'actuationTarget', color: '#4ea1ff' }]}
          unit=" kg" windowS={25} />
      </div>

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

      <button className="btn ghost act-force-stop" onClick={forceStop}>Force stop</button>
    </div>
  )
}
