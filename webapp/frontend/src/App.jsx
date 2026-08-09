import { useEffect, useState } from 'react'
import { useSocket } from './useSocket.js'
import { useMetrics } from './useMetrics.js'
import { getSession, logOut, profileSummary } from './auth.js'
import LoginView from './LoginView.jsx'
import PatientView from './PatientView.jsx'
import ClinicianView from './ClinicianView.jsx'
import GaitView from './GaitView.jsx'
import DevicesPanel from './DevicesPanel.jsx'
import ActuationPanel from './ActuationPanel.jsx'

const KNEE_TARGET = 60
const THEME_KEY = 'pass_theme'

function useTheme() {
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored) return stored
    // Clinical light theme is the intended default look now - dark mode is
    // still available via the toggle, just no longer what new sessions see.
    return 'light'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])
  return [theme, setTheme]
}

export default function App() {
  const { snap, connected } = useSocket()
  const { m, zeroHip, zeroFeet, resetReps, calibrateKneeL, calibrateKneeR, calibrateHips, calibrateHipTilt, calibrateBalance } = useMetrics(snap, { kneeTarget: KNEE_TARGET })
  const [session, setSession] = useState(() => getSession())
  const [theme, setTheme] = useTheme()
  // Own-role view vs the shared Gait tab - not a free-for-all switcher anymore;
  // which dashboard someone sees is decided by how they logged in.
  const [tab, setTab] = useState('home')
  const anyLive = !!m?.anyLive
  // Bumped on every "Zero feet" click so FeetMap's own per-channel baseline
  // (a separate tracker from useMetrics.js's) resets in lockstep instead of
  // silently drifting apart from the balance bar's zero point.
  const [feetZeroEpoch, setFeetZeroEpoch] = useState(0)

  if (!session) return <LoginView onAuth={setSession} />

  const handleLogout = () => { logOut(); setSession(null); setTab('home') }
  const handleZeroFeet = () => { zeroFeet(); setFeetZeroEpoch((e) => e + 1) }
  // Bundled once so every calibration/reset action lives next to the card it
  // affects instead of a disconnected button bar at the bottom of the page -
  // both views render their own subset of these inline.
  const actions = { zeroHip, zeroFeet: handleZeroFeet, calibrateBalance, resetReps, calibrateKneeL, calibrateKneeR, calibrateHips, calibrateHipTilt }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">PASS</span>
          <span className="tagline">Patient Assessment Sensing System</span>
        </div>
        <div className="top-right">
          <div className="modeswitch">
            <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}>
              {session.role === 'clinician' ? 'Clinician' : 'Patient'}
            </button>
            <button className={tab === 'gait' ? 'on' : ''} onClick={() => setTab('gait')}>Gait</button>
            <button className={tab === 'session' ? 'on' : ''} onClick={() => setTab('session')}>Session</button>
          </div>
          <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="Toggle light/dark mode" aria-label="Toggle light/dark mode">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <div className={`conn ${connected ? 'on' : 'off'}`}
            title="Link between this page and the PASS server (not the sensors)">
            {connected ? 'server online' : 'server offline'}
          </div>
          <div className="user-chip">
            <span className="user-name" title={profileSummary(session) || undefined}>{session.name}</span>
            <span className="user-role">{session.role}</span>
            <button className="btn ghost user-logout" onClick={handleLogout}>Log out</button>
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

      {tab === 'home' && session.role === 'clinician' && <ClinicianView m={m} snap={snap} feetZeroEpoch={feetZeroEpoch} actions={actions} />}
      {tab === 'home' && session.role !== 'clinician' && <PatientView m={m} kneeTarget={KNEE_TARGET} session={session} actions={actions} />}
      {tab === 'gait' && <GaitView m={m} />}
      {tab === 'session' && <ActuationPanel m={m} session={session} />}

      <footer className="foot-note">Live over WiFi · {connected ? 'streaming ~20×/sec' : 'reconnecting…'}</footer>
    </div>
  )
}
