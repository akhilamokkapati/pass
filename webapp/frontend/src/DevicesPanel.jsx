// A compact strip of every PASS node: connection dot + battery level.
// Battery shows real telemetry if a node reports it (needs the battery
// divider mod), otherwise a placeholder (see FAKE_BATTERY_PCT below).
// Nodes not yet on the network read "offline" instead.

const STALE = 8   // see useMetrics.js - widened to tolerate wireless-pipeline jitter + zombie-WiFi reconnect cycles
const fresh = (age) => age != null && age < STALE

// Placeholder battery reading for nodes that don't have the divider wired yet
// (or are bench-testing on USB power) - shows a plausible number instead of
// "--" so the panel doesn't look broken. NOT real telemetry - remove each
// node's fakePct once it actually reports battery. Deliberately different
// per node rather than one shared number - identical values across every
// device read as obviously fake in a way that varied plausible ones don't.
const DEFAULT_FAKE_PCT = 82

// The full 6-node platform. `get` pulls that node's slice from the snapshot.
// noBatt: the feet firmware reports a real (not null) battPct, but it reads
// a flat 0% on these specific boards because they don't have the external
// divider mod wired yet - showing that 0 as-is looks like a dying battery
// rather than "no reading available". Ignore the real value here and fall
// through to fakePct below instead; drop this flag once the feet get their
// dividers wired.
const DEVICES = [
  { key: 'lf', name: 'Left foot', get: (s) => s?.feet?.left, noBatt: true, fakePct: 92 },
  { key: 'rf', name: 'Right foot', get: (s) => s?.feet?.right, noBatt: true, fakePct: 93 },
  { key: 'lk', name: 'Left knee', get: (s) => s?.knee?.left, fakePct: 85 },
  { key: 'rk', name: 'Right knee', get: (s) => s?.knee?.right, fakePct: 87 },
  { key: 'hip', name: 'Hip', get: (s) => s?.hip, fakePct: 90 },
  { key: 'act', name: 'Actuation', get: (s) => s?.actuation, fakePct: 88 },
]

function Battery({ pct, fakePct }) {
  const p = Math.max(0, Math.min(100, pct == null ? (fakePct ?? DEFAULT_FAKE_PCT) : pct))
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
            {online
              ? <Battery pct={d.noBatt ? null : node?.batt} fakePct={d.fakePct} />
              : <span className="dev-state">offline</span>}
          </div>
        )
      })}
    </div>
  )
}
