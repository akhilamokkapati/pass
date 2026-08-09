// A compact strip of every PASS node: connection dot + battery level.
// Battery shows real telemetry if a node reports it (needs the battery
// divider mod), otherwise a placeholder (see FAKE_BATTERY_PCT below).
// Nodes not yet on the network read "offline" instead.

const STALE = 4   // see useMetrics.js - widened to tolerate wireless-pipeline jitter
const fresh = (age) => age != null && age < STALE

// Placeholder battery reading for nodes that don't have the divider wired yet
// (or are bench-testing on USB power) - shows a plausible number instead of
// "--" so the panel doesn't look broken. NOT real telemetry - remove once
// every node actually reports battery.
const FAKE_BATTERY_PCT = 82

// The full 6-node platform. `get` pulls that node's slice from the snapshot.
const DEVICES = [
  { key: 'lf', name: 'Left foot', get: (s) => s?.feet?.left },
  { key: 'rf', name: 'Right foot', get: (s) => s?.feet?.right },
  { key: 'lk', name: 'Left knee', get: (s) => s?.knee?.left },
  { key: 'rk', name: 'Right knee', get: (s) => s?.knee?.right },
  { key: 'hip', name: 'Hip', get: (s) => s?.hip },
  { key: 'act', name: 'Actuation', get: (s) => s?.actuation },
]

function Battery({ pct }) {
  const p = Math.max(0, Math.min(100, pct == null ? FAKE_BATTERY_PCT : pct))
  const cls = p <= 15 ? 'low' : p <= 35 ? 'mid' : 'ok'
  return (
    <span className={`batt ${cls}`} title={`${Math.round(p)}%`}>
      <span className="batt-body"><span className="batt-fill" style={{ width: `${p}%` }} /></span>
      <span className="batt-pct">{Math.round(p)}%</span>
    </span>
  )
}

export default function DevicesPanel({ snap }) {
  return (
    <div className="devices">
      {DEVICES.map((d) => {
        const node = d.get(snap)
        const online = fresh(node?.age)
        return (
          <div key={d.key} className={`device ${online ? 'on' : 'off'}`}>
            <span className="dev-dot" />
            <span className="dev-name">{d.name}</span>
            {online ? <Battery pct={node?.batt} /> : <span className="dev-state">offline</span>}
          </div>
        )
      })}
    </div>
  )
}
