import { useEffect, useRef, useState } from 'react'
import { tiltDeg } from './quat.js'

const STALE = 1.5
export const fresh = (age) => age != null && age < STALE

// Derives display metrics from the raw socket snapshot: foot loads (baseline
// removed), left/right balance, hip tilt-from-neutral, knee rep counting, and a
// rolling history buffer for the clinician time charts. Keeps per-channel foot
// baselines and the hip zero in a ref so they persist across renders.
export function useMetrics(snap, { kneeTarget = 60 } = {}) {
  const S = useRef({
    hist: [], baseL: {}, baseR: {}, hipRef: null, reps: 0, phase: 'down',
  })
  const [m, setM] = useState(null)

  useEffect(() => {
    if (!snap) return
    const s = S.current
    const { knee, hip, feet } = snap
    const kneeOk = fresh(knee?.age)
    const hipOk = fresh(hip?.age)
    const lOk = fresh(feet?.left?.age)
    const rOk = fresh(feet?.right?.age)

    const load = (arr, base) => {
      if (!arr) return 0
      let sum = 0
      arr.forEach((v, i) => {
        base[i] = base[i] == null ? v : Math.min(base[i], v)
        sum += Math.max(0, v - base[i])
      })
      return sum
    }
    const loadL = lOk ? load(feet.left.c, s.baseL) : 0
    const loadR = rOk ? load(feet.right.c, s.baseR) : 0

    if (s.hipRef == null && hipOk) s.hipRef = hip.q
    const hipTilt = hipOk && s.hipRef ? tiltDeg(s.hipRef, hip.q) : null

    const kneeAngle = kneeOk ? knee.angle : null

    // knee rep counter: extended (<15) -> past 80% of target -> back to extended
    if (kneeOk) {
      if (s.phase === 'down' && kneeAngle > kneeTarget * 0.8) s.phase = 'up'
      else if (s.phase === 'up' && kneeAngle < 15) { s.phase = 'down'; s.reps += 1 }
    }

    s.hist.push({ t: snap.t, knee: kneeAngle, hip: hipTilt, loadL, loadR })
    if (s.hist.length > 900) s.hist.shift()

    setM({
      kneeAngle, kneeOk, hipTilt, hipOk,
      loadL, loadR, lOk, rOk,
      reps: s.reps, hist: s.hist,
      anyLive: kneeOk || hipOk || lOk || rOk,
    })
  }, [snap?.t, kneeTarget])

  const zeroHip = () => { S.current.hipRef = null }
  const resetReps = () => { S.current.reps = 0 }
  return { m, zeroHip, resetReps }
}
