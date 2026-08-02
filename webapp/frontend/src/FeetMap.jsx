import { useEffect, useRef, useState } from 'react'

const STALE = 1.5
const FULL_SCALE = 1600 // inverted-ADC value that reads as "full" pressure

// dark -> amber -> red ramp for pressure intensity (t in 0..1)
function pressureColor(t) {
  t = Math.max(0, Math.min(1, t))
  const lerp = (a, b, u) => Math.round(a + (b - a) * u)
  let r, g, b
  if (t < 0.5) {
    const u = t / 0.5
    r = lerp(0x25, 0xf5, u); g = lerp(0x2a, 0xc2, u); b = lerp(0x33, 0x00, u)
  } else {
    const u = (t - 0.5) / 0.5
    r = lerp(0xf5, 0xff, u); g = lerp(0xc2, 0x3b, u); b = lerp(0x00, 0x30, u)
  }
  return `rgb(${r},${g},${b})`
}

function Foot({ side, zones, data }) {
  const ok = data && data.age != null && data.age < STALE
  const c = data?.c || []
  // per-channel running baseline so a resting foot reads ~0 and presses pop
  const baseRef = useRef({})
  const W = 150, H = 210
  return (
    <div className="foot">
      <div className="foot-label">{side}{ok ? '' : ' · offline'}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="foot-svg">
        <ellipse cx={W / 2} cy={H / 2} rx={W * 0.44} ry={H * 0.47} className="foot-outline" />
        {Object.entries(zones).map(([ch, z]) => {
          const raw = c[Number(ch)] ?? 0
          const base = baseRef.current
          base[ch] = base[ch] == null ? raw : Math.min(base[ch], raw)
          const val = ok ? Math.max(0, raw - base[ch]) : 0
          const norm = val / FULL_SCALE
          const cx = z.x * W
          const cy = (1 - z.y) * H
          const isAnat = !!z.anatomy
          return (
            <circle key={ch} cx={cx} cy={cy} r={isAnat ? 15 : 13}
              fill={pressureColor(norm)} className="zone"
              stroke={isAnat ? '#ffffff55' : '#00000055'} />
          )
        })}
      </svg>
    </div>
  )
}

export default function FeetMap({ feet }) {
  const [layout, setLayout] = useState(null)
  useEffect(() => {
    fetch('/api/layout').then((r) => r.json()).then(setLayout).catch(() => {})
  }, [])

  return (
    <div className="card feet-card">
      <div className="card-head"><h3>Feet · plantar pressure</h3></div>
      {layout ? (
        <div className="feet-row">
          <Foot side="left" zones={layout.left} data={feet?.left} />
          <Foot side="right" zones={layout.right} data={feet?.right} />
        </div>
      ) : (
        <div className="sub">loading layout…</div>
      )}
      <div className="legend">
        <span className="legend-label">low</span>
        <span className="legend-bar" />
        <span className="legend-label">high pressure</span>
      </div>
    </div>
  )
}
