// Logs tab: periodic knee/hip/gait sensor snapshots saved throughout the
// day (webapp/backend/sensor_log.py) - App.jsx POSTs one on a fixed interval
// whenever a sensor has a live link. The actuation session log is separate
// and lives embedded on the Session tab instead (see ActuationLogCard.jsx) -
// it's a discrete Start/Stop session, not a periodic reading, so it doesn't
// belong in the same table as these snapshots.
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

function fmt(v, digits = 0, unit = '') {
  return v == null ? '--' : `${v.toFixed(digits)}${unit}`
}

export default function SessionLogView() {
  const [snapshots, setSnapshots] = useState(null)   // null = still loading
  const [error, setError] = useState(false)

  const load = () => {
    setError(false)
    fetch('/api/sensors/snapshots?limit=200')
      .then((res) => res.json())
      .then((data) => setSnapshots(data.snapshots || []))
      .catch(() => setError(true))
  }

  useEffect(load, [])

  return (
    <div className="card accent-actuation log-card">
      <div className="card-head">
        <h3>Sensor log</h3>
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      {error && <div className="cue">Couldn't reach the server - try refreshing.</div>}
      {!error && snapshots === null && <div className="cue">Loading…</div>}
      {!error && snapshots?.length === 0 && (
        <div className="cue">
          No snapshots yet - they're captured automatically every so often while a sensor is connected.
        </div>
      )}

      {snapshots?.length > 0 && (
        <div className="log-table-wrap">
          <table className="log-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Knee L</th>
                <th>Knee R</th>
                <th>Hip tilt</th>
                <th>Rehab score</th>
                <th>Symmetry</th>
                <th>Cadence</th>
                <th>Reps L/R</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{fmtWhen(s.loggedAt)}</td>
                  <td>{fmt(s.kneeL, 0, '°')}</td>
                  <td>{fmt(s.kneeR, 0, '°')}</td>
                  <td>{fmt(s.hipTilt, 0, '°')}</td>
                  <td>{fmt(s.rehabScore, 0)}</td>
                  <td>{fmt(s.symmetryPct, 0, '%')}</td>
                  <td>{fmt(s.cadence, 0)}</td>
                  <td>{s.repsL ?? '--'} / {s.repsR ?? '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
