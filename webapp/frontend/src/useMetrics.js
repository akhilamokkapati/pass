import { useEffect, useRef, useState } from 'react'
import { tiltDeg, qrelative, qaverage, qcanon, angleAboutAxisDeg, axisAngle } from './quat.js'

const STALE = 1.5
export const fresh = (age) => age != null && age < STALE
const CAL_BUF_MAX = 12       // ~0.5-0.6s of samples at 20Hz to average per capture
const MIN_BEND_DEG = 15      // reject a calibration bend this small or smaller

// Derives display metrics from the raw socket snapshot: foot loads (baseline
// removed), left/right balance, hip tilt-from-neutral, knee rep counting, and a
// rolling history buffer for the clinician time charts. Keeps per-channel foot
// baselines and the hip zero in a ref so they persist across renders.
export function useMetrics(snap, { kneeTarget = 60 } = {}) {
  const S = useRef({
    hist: [], baseL: {}, baseR: {}, hipRef: null,
    repsL: 0, phaseL: 'down', repsR: 0, phaseR: 'down',
    // knee flexion calibration: rolling raw-quaternion buffers feed capture
    // clicks; calL/calR (once set) hold {qNeutral, axis} and switch the angle
    // computation from the firmware's rough cross-check to real swing-twist.
    bufL: [], bufR: [], calL: null, calR: null,
    calPhaseL: 'idle', calPhaseR: 'idle', calCaptureL: null, calCaptureR: null,
    calMsgL: '', calMsgR: '',
  })
  const [m, setM] = useState(null)

  useEffect(() => {
    if (!snap) return
    const s = S.current
    const { knee, hip, feet } = snap
    const kneeLOk = fresh(knee?.left?.age)
    const kneeROk = fresh(knee?.right?.age)
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

    // Rolling raw-quaternion buffer per side, for calibration capture clicks.
    if (kneeLOk) {
      s.bufL.push({ qt: knee.left.q_thigh, qs: knee.left.q_shank })
      if (s.bufL.length > CAL_BUF_MAX) s.bufL.shift()
    }
    if (kneeROk) {
      s.bufR.push({ qt: knee.right.q_thigh, qs: knee.right.q_shank })
      if (s.bufR.length > CAL_BUF_MAX) s.bufR.shift()
    }

    const calibratedAngle = (cal, qt, qs) => {
      const qRel = qrelative(qt, qs)
      const qOffset = qrelative(cal.qNeutral, qRel)
      return angleAboutAxisDeg(qcanon(qOffset), cal.axis)
    }

    const kneeLAngle = kneeLOk
      ? (s.calL ? calibratedAngle(s.calL, knee.left.q_thigh, knee.left.q_shank) : knee.left.angle)
      : null
    const kneeRAngle = kneeROk
      ? (s.calR ? calibratedAngle(s.calR, knee.right.q_thigh, knee.right.q_shank) : knee.right.angle)
      : null

    // knee rep counter (each side independent): extended (<15) -> past 80% of
    // target -> back to extended
    if (kneeLOk) {
      if (s.phaseL === 'down' && kneeLAngle > kneeTarget * 0.8) s.phaseL = 'up'
      else if (s.phaseL === 'up' && kneeLAngle < 15) { s.phaseL = 'down'; s.repsL += 1 }
    }
    if (kneeROk) {
      if (s.phaseR === 'down' && kneeRAngle > kneeTarget * 0.8) s.phaseR = 'up'
      else if (s.phaseR === 'up' && kneeRAngle < 15) { s.phaseR = 'down'; s.repsR += 1 }
    }

    s.hist.push({ t: snap.t, kneeL: kneeLAngle, kneeR: kneeRAngle, hip: hipTilt, loadL, loadR })
    if (s.hist.length > 900) s.hist.shift()

    setM({
      kneeLAngle, kneeLOk, kneeRAngle, kneeROk, hipTilt, hipOk,
      loadL, loadR, lOk, rOk,
      repsL: s.repsL, repsR: s.repsR, hist: s.hist,
      anyLive: kneeLOk || kneeROk || hipOk || lOk || rOk,
      calibratedL: !!s.calL, calibratedR: !!s.calR,
      calPhaseL: s.calPhaseL, calPhaseR: s.calPhaseR,
      calMsgL: s.calMsgL, calMsgR: s.calMsgR,
    })
  }, [snap?.t, kneeTarget])

  const zeroHip = () => { S.current.hipRef = null }
  const resetReps = () => { S.current.repsL = 0; S.current.repsR = 0 }

  // Two-click calibration per knee, mirroring axis_calibration.py: first
  // click captures a short averaged window of the current (assumed straight)
  // pose as neutral; second click captures a bent pose and derives the real
  // flexion axis from the rotation between them. Reading buffers straight
  // from the rolling window means each click is instant, no recording delay.
  const calibrateKnee = (side) => {
    const s = S.current
    const buf = side === 'left' ? s.bufL : s.bufR
    const phaseKey = side === 'left' ? 'calPhaseL' : 'calPhaseR'
    const captureKey = side === 'left' ? 'calCaptureL' : 'calCaptureR'
    const calKey = side === 'left' ? 'calL' : 'calR'
    const msgKey = side === 'left' ? 'calMsgL' : 'calMsgR'

    if (buf.length < 3) {
      s[msgKey] = 'Waiting for sensor data - try again in a moment'
      return
    }
    const capture = { qt: qaverage(buf.map((b) => b.qt)), qs: qaverage(buf.map((b) => b.qs)) }

    if (s[phaseKey] === 'idle') {
      s[captureKey] = capture
      s[phaseKey] = 'awaiting-bent'
      s[msgKey] = 'Now bend the knee ~30-60° and hold still, then click again'
      return
    }

    const straight = s[captureKey]
    const qNeutral = qrelative(straight.qt, straight.qs)
    const qBentRel = qrelative(capture.qt, capture.qs)
    const qOffset = qrelative(qNeutral, qBentRel)
    const { axis, angleDeg } = axisAngle(qcanon(qOffset))

    s[phaseKey] = 'idle'
    s[captureKey] = null
    if (angleDeg < MIN_BEND_DEG) {
      s[msgKey] = 'Bend too small - hold each pose still and try again'
      return
    }
    s[calKey] = { qNeutral, axis }
    s[msgKey] = 'Calibrated'
  }

  return { m, zeroHip, resetReps, calibrateKnee }
}
