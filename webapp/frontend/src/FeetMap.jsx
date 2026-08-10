import { useEffect, useRef, useState } from 'react'
import { StatusPill } from './ui.jsx'

const STALE = 8   // see useMetrics.js - widened to tolerate wireless-pipeline jitter + zombie-WiFi reconnect cycles
const DEFAULT_FULL_SCALE = 3400 // inverted-ADC value that reads as "full" pressure
const SENS_KEY = 'pass_feet_full_scale'

// A foot silhouette (toes at top, heel at bottom), viewBox 0 0 150 210.
const FOOT_PATH =
  'M75 205 C63 205 55 199 53 188 C50 175 46 162 45 145 C44 124 40 108 44 89 ' +
  'C47 60 55 27 75 23 C95 27 103 60 106 89 C110 108 106 124 105 145 ' +
  'C104 162 100 175 97 188 C95 199 87 205 75 205 Z'

function pressureColor(t) {
  t = Math.max(0, Math.min(1, t))
  const lerp = (a, b, u) => Math.round(a + (b - a) * u)
  let r, g, b
  if (t < 0.5) {
    const u = t / 0.5
    // Mid-gray "no pressure" start (not near-black) - readable on both the
    // dark and light themes without needing to detect which is active,
    // unlike the old near-black start which vanished on a light background.
    r = lerp(0x9a, 0xf5, u); g = lerp(0xa3, 0xc2, u); b = lerp(0xb0, 0x00, u)
  } else {
    const u = (t - 0.5) / 0.5
    r = lerp(0xf5, 0xff, u); g = lerp(0xc2, 0x3b, u); b = lerp(0x00, 0x30, u)
  }
  return `rgb(${r},${g},${b})`
}

function Foot({ side, zones, data, fullScale, resetKey }) {
  const ok = data && data.age != null && data.age < STALE
  const c = data?.c || []
  const baseRef = useRef({})
  const wasOkRef = useRef(false)
  const lastResetRef = useRef(resetKey)
  // Same "auto-reset on reconnect" fix useMetrics.js already has for its own
  // baseline - without it, a channel's zero point gets set once from whatever
  // the first sample after mount happened to be (which may not be true zero
  // load) and never corrects itself for the rest of the session. Also clears
  // on the shared "Zero feet" click (resetKey bump from App.jsx) so this map
  // and the balance bar agree on one zero point instead of drifting apart.
  if (ok && !wasOkRef.current) baseRef.current = {}
  wasOkRef.current = ok
  if (resetKey !== lastResetRef.current) { baseRef.current = {}; lastResetRef.current = resetKey }
  const W = 150, H = 210
  const mirror = side === 'right' ? `translate(${W},0) scale(-1,1)` : undefined
  let total = 0
  // Center of Pressure: weighted spatial average of zone position by load,
  // same formula as the clinical spec (CoP_x = sum(F_i * x_i) / sum(F_i)).
  // Accumulated as a side effect during the .map below (same pattern the
  // existing `total` already uses) - read after the map has run, since JSX
  // sibling expressions evaluate in source order before render.
  let copWX = 0, copWY = 0
  const COP_MIN_LOAD = 100   // below this, division is unstable/meaningless - hide the dot
  return (
    <div className="foot">
      <div className="foot-label">{side} <StatusPill ok={ok} /></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="foot-svg">
        <path d={FOOT_PATH} className="foot-outline" transform={mirror} />
        {ok ? Object.entries(zones).map(([ch, z]) => {
          const raw = c[Number(ch)] ?? 0
          const base = baseRef.current
          base[ch] = base[ch] == null ? raw : Math.min(base[ch], raw)
          const val = Math.max(0, raw - base[ch])
          total += val
          const cx = z.x * W
          const cy = (1 - z.y) * H
          copWX += cx * val
          copWY += cy * val
          const anat = !!z.anatomy
          return (
            <circle key={ch} cx={cx} cy={cy} r={anat ? 14 : 12}
              fill={pressureColor(val / fullScale)} className="zone"
              stroke={anat ? '#8b96a599' : '#8b96a533'} />
          )
        }) : (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="foot-off">not connected</text>
        )}
        {ok && total > COP_MIN_LOAD && (
          <circle cx={copWX / total} cy={copWY / total} r={5} className="cop-dot" />
        )}
      </svg>
      <div className="foot-load">{ok ? `load ${Math.round(total)}` : '--'}</div>
    </div>
  )
}

export default function FeetMap({ feet, resetKey }) {
  const [layout, setLayout] = useState(null)
  const [fullScale, setFullScale] = useState(() => {
    const saved = Number(localStorage.getItem(SENS_KEY))
    return saved > 0 ? saved : DEFAULT_FULL_SCALE
  })
  useEffect(() => {
    fetch('/api/layout').then((r) => r.json()).then(setLayout).catch(() => {})
  }, [])
  const setScale = (v) => {
    setFullScale(v)
    localStorage.setItem(SENS_KEY, String(v))
  }

  return (
    <div className="feet-card">
      {layout ? (
        <div className="feet-row">
          <Foot side="left" zones={layout.left} data={feet?.left} fullScale={fullScale} resetKey={resetKey} />
          <Foot side="right" zones={layout.right} data={feet?.right} fullScale={fullScale} resetKey={resetKey} />
        </div>
      ) : (
        <div className="sub">loading layout...</div>
      )}
      <div className="legend">
        <span className="legend-label">low</span>
        <span className="legend-bar" />
        <span className="legend-label">high pressure</span>
      </div>
      <div className="sens-row">
        <span className="legend-label">color sensitivity</span>
        <input type="range" min="800" max="4000" step="100" value={fullScale}
          onChange={(e) => setScale(Number(e.target.value))} />
        <span className="sens-val">{fullScale}</span>
      </div>
    </div>
  )
}
