// Logs tab: full actuation session history from the backend's SQLite log
// (webapp/backend/sessions.py) - the persisted source of truth the
// next-weight recommendation on the Session tab is computed from. Shown to
// both roles: the patient wants to see their own progress, the clinician
// wants the same history to judge the recommendation, so there's no reason
// to split this by role like the Session tab's controls are.
//
// Fetched over plain REST rather than the WebSocket snapshot - this is a
// bounded history list, not a live reading, and only needs to load when the
// tab is opened (App.jsx mounts this component fresh each time via
// {tab === 'logs' && <SessionLogView />}, which re-triggers the fetch).

import { useEffect, useState } from 'react'

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export default function SessionLogView() {
  const [sessions, setSessions] = useState(null)   // null = still loading
  const [error, setError] = useState(false)

  const load = () => {
    setError(false)
    fetch('/api/actuation/sessions?limit=100')
      .then((res) => res.json())
      .then((data) => setSessions(data.sessions || []))
      .catch(() => setError(true))
  }

  useEffect(load, [])

  return (
    <div className="card accent-actuation log-card">
      <div className="card-head">
        <h3>Session log</h3>
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      {error && <div className="cue">Couldn't reach the server - try refreshing.</div>}
      {!error && sessions === null && <div className="cue">Loading…</div>}
      {!error && sessions?.length === 0 && <div className="cue">No sessions logged yet - run one from the Session tab.</div>}

      {sessions?.length > 0 && (
        <div className="log-table-wrap">
          <table className="log-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Target</th>
                <th>Duration</th>
                <th>Peak</th>
                <th>Avg</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{fmtWhen(s.endedAt)}</td>
                  <td>{s.target} kg</td>
                  <td>{s.durationS.toFixed(1)} s</td>
                  <td>{s.peak.toFixed(1)} kg</td>
                  <td>{s.avg.toFixed(1)} kg</td>
                  <td className={s.completed ? 'log-ok' : 'log-warn'}>
                    {s.completed ? 'Completed' : 'Force stopped'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
