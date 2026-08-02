import { useEffect, useRef, useState } from 'react'
import { StatusPill } from './ui.jsx'

const STALE = 1.5
const FULL_SCALE = 1600 // inverted-ADC value that reads as "full" pressure

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
  const baseRef = useRef({})
  const W = 150, H = 210
  const mirror = side === 'right' ? `translate(${W},0) scale(-1,1)` : undefined
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
          const cx = z.x * W
          const cy = (1 - z.y) * H
          const anat = !!z.anatomy
          return (
            <circle key={ch} cx={cx} cy={cy} r={anat ? 14 : 12}
              fill={pressureColor(val / FULL_SCALE)} className="zone"
              stroke={anat ? '#ffffff55' : '#00000055'} />
          )
        }) : (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="foot-off">not connected</text>
        )}
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
    <div className="feet-card">
      {layout ? (
        <div className="feet-row">
          <Foot side="left" zones={layout.left} data={feet?.left} />
          <Foot side="right" zones={layout.right} data={feet?.right} />
        </div>
      ) : (
        <div className="sub">loading layout...</div>
      )}
      <div className="legend">
        <span className="legend-label">low</span>
        <span className="legend-bar" />
        <span className="legend-label">high pressure</span>
      </div>
    </div>
  )
}
