import { useState } from 'react'
import { useSocket } from './useSocket.js'
import { useMetrics } from './useMetrics.js'
import PatientView from './PatientView.jsx'
import ClinicianView from './ClinicianView.jsx'
import GaitView from './GaitView.jsx'
import DevicesPanel from './DevicesPanel.jsx'

const KNEE_TARGET = 60

export default function App() {
  const { snap, connected } = useSocket()
  const { m, zeroHip, resetReps, calibrateKnees } = useMetrics(snap, { kneeTarget: KNEE_TARGET })
  const [mode, setMode] = useState(() => localStorage.getItem('pass_mode') || 'patient')
  const pick = (x) => { setMode(x); localStorage.setItem('pass_mode', x) }
  const anyLive = !!m?.anyLive

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">PASS</span>
          <span className="tagline">Patient Assessment Sensing System</span>
        </div>
        <div className="top-right">
          <div className="modeswitch">
            <button className={mode === 'patient' ? 'on' : ''} onClick={() => pick('patient')}>Patient</button>
            <button className={mode === 'clinician' ? 'on' : ''} onClick={() => pick('clinician')}>Clinician</button>
            <button className={mode === 'gait' ? 'on' : ''} onClick={() => pick('gait')}>Gait</button>
          </div>
          <div className={`conn ${connected ? 'on' : 'off'}`}
            title="Link between this page and the PASS server (not the sensors)">
            {connected ? 'server online' : 'server offline'}
          </div>
        </div>
      </header>

      <DevicesPanel snap={snap} />

      {!anyLive && (
        <div className="empty">
          <span className="empty-dot" />
          <div><b>No sensors connected.</b> Power on a node (feet, knee, or hip) on the
            30.007 network and live data appears here automatically.</div>
        </div>
      )}

      {mode === 'patient' && <PatientView m={m} kneeTarget={KNEE_TARGET} />}
      {mode === 'clinician' && <ClinicianView m={m} snap={snap} />}
      {mode === 'gait' && <GaitView m={m} />}

      <div className="actions">
        <button className="btn ghost" onClick={zeroHip}>Zero hip (stand tall)</button>
        <button className="btn ghost" onClick={resetReps}>Reset reps</button>
        <button className={`btn ghost ${m?.calPhase === 'awaiting-bent' ? 'on' : ''}`} onClick={calibrateKnees}>
          {m?.calPhase === 'awaiting-bent' ? 'Capture bent' : 'Calibrate knees'}
        </button>
      </div>
      {m?.calMsg && <div className="cal-msg center-msg">{m.calMsg}</div>}

      <footer className="foot-note">Live over WiFi · {connected ? 'streaming ~20×/sec' : 'reconnecting…'}</footer>
    </div>
  )
}
