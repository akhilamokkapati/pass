import { useEffect, useRef, useState } from 'react'
import { tiltDeg, qrelative, qaverage, qcanon, angleAboutAxisDeg, axisAngle } from './quat.js'

// Widened from 1.5s: a two-hop wireless pipeline (board -> router -> laptop
// -> relay -> Render -> browser) will drop the odd packet even when every
// node in the chain is healthy. 1.5s flagged those as "offline" and flickered
// the UI; 4s tolerates a few dropped packets/relay hiccups while still
// catching a genuinely disconnected node within a few seconds.
const STALE = 4
export const fresh = (age) => age != null && age < STALE
const CAL_BUF_MAX = 12       // ~0.5-0.6s of samples at 20Hz to average per capture
const MIN_BEND_DEG = 15      // reject a calibration bend this small or smaller
const SESSION_MAX = 108000   // ~90min at 20Hz - keep the full session for CSV export,
                              // not just the ~45s the live charts need

// Heel-strike/toe-off from the feet FSRs: no ankle IMU exists, so this reads
// contact PHASE (foot down vs foot lifted) from the heel-specific channels
// identified in feet/foot_layout.py's press-tested anatomy map, not a
// measured angle. Hysteresis (stance needs more load than swing needs to
// release) avoids chatter right at the threshold.
const HEEL_STANCE_ON = 150   // heel load above this -> stance (foot down)
const HEEL_STANCE_OFF = 50   // heel load below this -> swing (foot lifted)

// Per-rep form checks, evaluated once a rep completes. Thresholds follow the
// same "error tolerance" idea used in knee-OA rehab literature (e.g. Chen et
// al. 2015's SAE/SLR/QSM alteration table) - not reading the exercise TYPE
// (the UI already knows that), just flagging the same failure modes: not
// reaching target flexion, trunk/hip compensation, and moving too fast to
// control. Priority order below matches severity, not literature order.
const FORM_TARGET_MARGIN = 0.95     // peak angle must reach this fraction of kneeTarget
const FORM_HIP_COMPENSATION_DEG = 15
const FORM_MIN_REP_S = 0.4

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
    // One shared phase/button drives both sides at once (typical use: both
    // knees worn together), but each side's neutral/axis is captured and
    // judged independently, since a sleeve on one leg tells you nothing about
    // the other.
    bufL: [], bufR: [], calL: null, calR: null,
    calPhase: 'idle', calCaptureL: null, calCaptureR: null, calMsg: '',
    // hip flexion calibration: same swing-twist idea, but relates the pelvis
    // sensor to each knee board's OWN thigh sensor (already worn for the knee
    // metric - no new hardware) instead of thigh-to-shank. Separate buffers
    // and phase from the knee calibration above so the two flows don't step
    // on each other if both are mid-capture. Requires the hip board AND that
    // side's knee board live simultaneously - a single-sensor board dropping
    // out just stops that side's hip-flexion reading, same as any other
    // combined metric (e.g. balance needing both feet).
    bufHipL: [], bufHipR: [], calHipL: null, calHipR: null,
    calPhaseHip: 'idle', calCaptureHipL: null, calCaptureHipR: null, calMsgHip: '',
    footLayout: null, heelBaseL: {}, heelBaseR: {},
    footPhaseL: 'stance', footPhaseR: 'stance',
    repPeakL: 0, repPeakHipL: 0, repStartTL: null, formFlagL: '',
    repPeakR: 0, repPeakHipR: 0, repStartTR: null, formFlagR: '',
    // Two physically different insole boards rarely have matched raw
    // sensitivity (FSR batch/wiring variance) - comparing raw baseline-
    // subtracted sums directly can skew the balance split even with a
    // perfect zero. balScaleR corrects the RIGHT reading to match the LEFT
    // reading's scale, captured once via calibrateBalance() while standing
    // evenly (assumed 50/50 - the only reference this software has).
    balScaleR: 1, lastLoadL: null, lastLoadR: null, calMsgBalance: '',
  })
  const [m, setM] = useState(null)

  // Fetch the same channel-anatomy map FeetMap.jsx uses, so "which channels
  // are the heel" has one source of truth instead of a second hardcoded copy.
  useEffect(() => {
    fetch('/api/layout').then((r) => r.json()).then((layout) => { S.current.footLayout = layout }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!snap) return
    const s = S.current
    const { knee, hip, feet, actuation } = snap
    const kneeLOk = fresh(knee?.left?.age)
    const kneeROk = fresh(knee?.right?.age)
    const hipOk = fresh(hip?.age)
    const lOk = fresh(feet?.left?.age)
    const rOk = fresh(feet?.right?.age)
    const actuationOk = fresh(actuation?.age)

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
    const loadRraw = rOk ? load(feet.right.c, s.baseR) : 0
    const loadR = loadRraw * s.balScaleR
    s.lastLoadL = lOk ? loadL : null
    s.lastLoadR = rOk ? loadRraw : null

    // Heel-specific load (subset of channels, not the whole-foot total) drives
    // stance/swing phase for the gait avatar's feet.
    const heelLoad = (side, arr, base) => {
      const zones = s.footLayout?.[side]
      if (!arr || !zones) return null
      let sum = 0
      for (const [ch, z] of Object.entries(zones)) {
        if (z.anatomy !== 'heel') continue
        const v = arr[Number(ch)] ?? 0
        base[ch] = base[ch] == null ? v : Math.min(base[ch], v)
        sum += Math.max(0, v - base[ch])
      }
      return sum
    }
    const heelL = lOk ? heelLoad('left', feet.left.c, s.heelBaseL) : null
    const heelR = rOk ? heelLoad('right', feet.right.c, s.heelBaseR) : null
    if (heelL != null) {
      if (s.footPhaseL === 'swing' && heelL > HEEL_STANCE_ON) s.footPhaseL = 'stance'
      else if (s.footPhaseL === 'stance' && heelL < HEEL_STANCE_OFF) s.footPhaseL = 'swing'
    }
    if (heelR != null) {
      if (s.footPhaseR === 'swing' && heelR > HEEL_STANCE_ON) s.footPhaseR = 'stance'
      else if (s.footPhaseR === 'stance' && heelR < HEEL_STANCE_OFF) s.footPhaseR = 'swing'
    }

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
    // Same rolling-buffer idea, but pelvis-vs-thigh for hip flexion. Only
    // fills while BOTH the hip board and that side's knee board are live.
    if (hipOk && kneeLOk) {
      s.bufHipL.push({ qp: hip.q, qt: knee.left.q_thigh })
      if (s.bufHipL.length > CAL_BUF_MAX) s.bufHipL.shift()
    }
    if (hipOk && kneeROk) {
      s.bufHipR.push({ qp: hip.q, qt: knee.right.q_thigh })
      if (s.bufHipR.length > CAL_BUF_MAX) s.bufHipR.shift()
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

    // Hip flexion (pelvis vs that leg's thigh) - only available once
    // calibrateHips() has captured this side, and only while both the hip
    // board and that side's knee board are live.
    const hipFlexL = (hipOk && kneeLOk && s.calHipL)
      ? calibratedAngle(s.calHipL, hip.q, knee.left.q_thigh) : null
    const hipFlexR = (hipOk && kneeROk && s.calHipR)
      ? calibratedAngle(s.calHipR, hip.q, knee.right.q_thigh) : null

    // knee rep counter (each side independent): extended (<15) -> past 80% of
    // target -> back to extended. While "up", track this rep's peak flexion
    // and peak hip-tilt magnitude so a form flag can be judged the moment it
    // completes.
    const judgeForm = (peakAngle, peakHip, durationS) => {
      if (peakAngle < kneeTarget * FORM_TARGET_MARGIN) return "Didn't reach target - bend a little further"
      if (peakHip > FORM_HIP_COMPENSATION_DEG) return 'Leaning / hip compensation - keep hips level'
      if (durationS != null && durationS < FORM_MIN_REP_S) return 'Too fast - control the movement'
      return ''
    }
    if (kneeLOk) {
      if (s.phaseL === 'down' && kneeLAngle > kneeTarget * 0.8) {
        s.phaseL = 'up'
        s.repPeakL = kneeLAngle
        s.repPeakHipL = hipOk ? Math.abs(hipTilt) : 0
        s.repStartTL = snap.t
      } else if (s.phaseL === 'up') {
        if (kneeLAngle > s.repPeakL) s.repPeakL = kneeLAngle
        if (hipOk && Math.abs(hipTilt) > s.repPeakHipL) s.repPeakHipL = Math.abs(hipTilt)
        if (kneeLAngle < 15) {
          s.phaseL = 'down'; s.repsL += 1
          const duration = s.repStartTL != null ? snap.t - s.repStartTL : null
          s.formFlagL = judgeForm(s.repPeakL, s.repPeakHipL, duration)
        }
      }
    }
    if (kneeROk) {
      if (s.phaseR === 'down' && kneeRAngle > kneeTarget * 0.8) {
        s.phaseR = 'up'
        s.repPeakR = kneeRAngle
        s.repPeakHipR = hipOk ? Math.abs(hipTilt) : 0
        s.repStartTR = snap.t
      } else if (s.phaseR === 'up') {
        if (kneeRAngle > s.repPeakR) s.repPeakR = kneeRAngle
        if (hipOk && Math.abs(hipTilt) > s.repPeakHipR) s.repPeakHipR = Math.abs(hipTilt)
        if (kneeRAngle < 15) {
          s.phaseR = 'down'; s.repsR += 1
          const duration = s.repStartTR != null ? snap.t - s.repStartTR : null
          s.formFlagR = judgeForm(s.repPeakR, s.repPeakHipR, duration)
        }
      }
    }

    s.hist.push({ t: snap.t, kneeL: kneeLAngle, kneeR: kneeRAngle, hip: hipTilt, loadL, loadR })
    if (s.hist.length > SESSION_MAX) s.hist.shift()

    setM({
      kneeLAngle, kneeLOk, kneeRAngle, kneeROk, hipTilt, hipOk,
      loadL, loadR, lOk, rOk,
      footPhaseL: lOk ? s.footPhaseL : null, footPhaseR: rOk ? s.footPhaseR : null,
      repsL: s.repsL, repsR: s.repsR, hist: s.hist,
      formFlagL: s.formFlagL, formFlagR: s.formFlagR,
      hipFlexL, hipFlexR, hipFlexCalibratedL: !!s.calHipL, hipFlexCalibratedR: !!s.calHipR,
      calPhaseHip: s.calPhaseHip, calMsgHip: s.calMsgHip,
      calMsgBalance: s.calMsgBalance,
      actuationOk, actuationTension: actuationOk ? actuation.tension_n : null,
      actuationState: actuationOk ? actuation.state : null,
      anyLive: kneeLOk || kneeROk || hipOk || lOk || rOk,
      calibratedL: !!s.calL, calibratedR: !!s.calR,
      calPhase: s.calPhase, calMsg: s.calMsg,
    })
  }, [snap?.t, kneeTarget])

  const zeroHip = () => { S.current.hipRef = null }
  // The per-channel baseline is a running minimum that only ever tightens,
  // never resets - if a channel's very first sample wasn't a true zero-load
  // moment, every reading afterward inherits that skew for the rest of the
  // session with no way to fix it except this. Lift both feet off the
  // insoles before clicking so the next samples become the new floor.
  const zeroFeet = () => { S.current.baseL = {}; S.current.baseR = {} }

  // One-shot fix for the two insoles having different raw sensitivity:
  // capture the L/R ratio while standing evenly and use it to scale the
  // right reading to match the left from then on. This ASSUMES the stance
  // at calibration time was genuinely 50/50 - there's no independent way to
  // verify that without a reference scale, so the message says so plainly.
  const MIN_BALANCE_CAL_LOAD = 150
  const calibrateBalance = () => {
    const s = S.current
    if (s.lastLoadL == null || s.lastLoadR == null) {
      s.calMsgBalance = 'Waiting for both feet - try again in a moment'
      return
    }
    if (s.lastLoadL < MIN_BALANCE_CAL_LOAD || s.lastLoadR < MIN_BALANCE_CAL_LOAD) {
      s.calMsgBalance = 'Stand evenly on both feet with real weight, then try again'
      return
    }
    s.balScaleR = s.lastLoadL / s.lastLoadR
    s.calMsgBalance = 'Balance calibrated - assumes that stance was even 50/50'
  }
  const resetReps = () => {
    const s = S.current
    s.repsL = 0; s.repsR = 0
    s.formFlagL = ''; s.formFlagR = ''
  }

  // One button drives both knees through the same two-click flow, mirroring
  // axis_calibration.py: first click captures a short averaged window of the
  // current (assumed straight) pose as neutral for every side that's live,
  // second click captures a bent pose and derives each side's real flexion
  // axis from the rotation between them. Each side is judged independently -
  // one knee's bad capture doesn't discard the other's good one.
  const calibrateKnees = () => {
    const s = S.current
    const sides = [
      { key: 'left', buf: s.bufL, captureKey: 'calCaptureL', calKey: 'calL' },
      { key: 'right', buf: s.bufR, captureKey: 'calCaptureR', calKey: 'calR' },
    ].filter((side) => side.buf.length >= 3)

    if (!sides.length) {
      s.calMsg = 'Waiting for sensor data - try again in a moment'
      return
    }

    if (s.calPhase === 'idle') {
      for (const side of sides) {
        s[side.captureKey] = {
          qt: qaverage(side.buf.map((b) => b.qt)),
          qs: qaverage(side.buf.map((b) => b.qs)),
        }
      }
      s.calPhase = 'awaiting-bent'
      s.calMsg = 'Now bend the knee(s) ~30-60° and hold still, then click again'
      return
    }

    const results = []
    for (const side of sides) {
      const straight = s[side.captureKey]
      if (!straight) continue   // wasn't live for the straight capture
      const capture = {
        qt: qaverage(side.buf.map((b) => b.qt)),
        qs: qaverage(side.buf.map((b) => b.qs)),
      }
      const qNeutral = qrelative(straight.qt, straight.qs)
      const qBentRel = qrelative(capture.qt, capture.qs)
      const qOffset = qrelative(qNeutral, qBentRel)
      const { axis, angleDeg } = axisAngle(qcanon(qOffset))
      if (angleDeg < MIN_BEND_DEG) {
        results.push(`${side.key}: bend too small`)
        continue
      }
      s[side.calKey] = { qNeutral, axis }
      results.push(`${side.key}: calibrated`)
    }

    s.calPhase = 'idle'
    s.calCaptureL = null
    s.calCaptureR = null
    s.calMsg = results.length ? results.join(', ') : 'Bend too small - hold each pose still and try again'
  }

  // Same two-click flow as calibrateKnees, but relating the pelvis sensor to
  // each knee board's thigh sensor instead of thigh-to-shank - gives real hip
  // flexion (pelvis-to-thigh angle), not just the pelvis's own tilt-from-level.
  // Needs a genuine flexion move (raise the thigh/knee forward), not a knee
  // bend - bending the knee barely moves the thigh relative to the pelvis, so
  // it would produce a noisy, near-meaningless axis.
  const calibrateHips = () => {
    const s = S.current
    const sides = [
      { key: 'left', buf: s.bufHipL, captureKey: 'calCaptureHipL', calKey: 'calHipL' },
      { key: 'right', buf: s.bufHipR, captureKey: 'calCaptureHipR', calKey: 'calHipR' },
    ].filter((side) => side.buf.length >= 3)

    if (!sides.length) {
      s.calMsgHip = 'Waiting for hip + knee sensor data - try again in a moment'
      return
    }

    if (s.calPhaseHip === 'idle') {
      for (const side of sides) {
        s[side.captureKey] = {
          qp: qaverage(side.buf.map((b) => b.qp)),
          qt: qaverage(side.buf.map((b) => b.qt)),
        }
      }
      s.calPhaseHip = 'awaiting-flexed'
      s.calMsgHip = 'Now raise the knee(s)/flex the hip ~30-60° and hold still, then click again'
      return
    }

    const results = []
    for (const side of sides) {
      const straight = s[side.captureKey]
      if (!straight) continue
      const capture = {
        qp: qaverage(side.buf.map((b) => b.qp)),
        qt: qaverage(side.buf.map((b) => b.qt)),
      }
      const qNeutral = qrelative(straight.qp, straight.qt)
      const qFlexedRel = qrelative(capture.qp, capture.qt)
      const qOffset = qrelative(qNeutral, qFlexedRel)
      const { axis, angleDeg } = axisAngle(qcanon(qOffset))
      if (angleDeg < MIN_BEND_DEG) {
        results.push(`${side.key}: movement too small`)
        continue
      }
      s[side.calKey] = { qNeutral, axis }
      results.push(`${side.key}: calibrated`)
    }

    s.calPhaseHip = 'idle'
    s.calCaptureHipL = null
    s.calCaptureHipR = null
    s.calMsgHip = results.length ? results.join(', ') : 'Movement too small - hold each pose still and try again'
  }

  return { m, zeroHip, zeroFeet, resetReps, calibrateKnees, calibrateHips, calibrateBalance }
}
