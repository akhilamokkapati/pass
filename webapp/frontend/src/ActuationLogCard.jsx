// Compact actuation session history embedded directly on the Session tab
// (under the session controls) so there's no need to leave the tab to see
// past sessions. Pulls from the same persisted log (webapp/backend/
// sessions.py) the next-weight recommendation is computed from. The full
// sensor log (knee/hip/gait, not actuation) lives on the separate Logs tab
// - see SessionLogView.jsx.

import { useEffect, useState } from 'react'

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export default function ActuationLogCard({ refreshKey }) {
  const [sessions, setSessions] = useState(null)   // null = still loading

  useEffect(() => {
    fetch('/api/actuation/sessions?limit=10')
      .then((res) => res.json())
      .then((data) => setSessions(data.sessions || []))
      .catch(() => setSessions([]))
  }, [refreshKey])

  return (
    <div className="card accent-actuation log-card act-log-embed">
      <div className="card-head"><h3>Recent sessions</h3></div>

      {sessions === null && <div className="cue">Loading…</div>}
      {sessions?.length === 0 && <div className="cue">No sessions logged yet.</div>}

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
