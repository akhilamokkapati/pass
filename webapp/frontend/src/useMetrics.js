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

// Knee flexion-axis quality gate, ported from the validated offline engine
// (knee/axis_calibration.py's calibrate_flexion_axis / calibrate.py's
// residual_rms_deg) - same thresholds it uses. The live flow previously only
// checked bend SIZE; a bend that's big enough but wobbles off-axis (hip
// rotation mixed into the "knee bend"), or a pose that wasn't held steady,
// still produced a "Calibrated" axis that's silently wrong for the rest of
// the session. axis_confidence = weighted collinearity of every sample's
// rotation axis with the consensus axis (1.0 = clean single-axis motion);
// residual = RMS angular spread of a held pose about its own average.
const KNEE_CAL_MIN_CONFIDENCE = 0.9
const KNEE_CAL_MAX_RESIDUAL_DEG = 5
const SESSION_MAX = 108000   // ~90min at 20Hz - keep the full session for CSV export,
                              // not just the ~45s the live charts need
const FEET_SETTLE_S = 2      // after a foot reconnects, the baseline hasn't yet seen a
                              // genuine no-load sample to lock onto - it self-corrects the
                              // moment it does (running min), so briefly hide the balance
                              // number instead of showing a skewed one or asking the user
                              // to do anything about it (same idea as a scale settling)

// Heel-strike/toe-off from the feet FSRs: no ankle IMU exists, so this reads
// contact PHASE (foot down vs foot lifted) from the heel-specific channels
// identified in feet/foot_layout.py's press-tested anatomy map, not a
// measured angle. Hysteresis (stance needs more load than swing needs to
// release) avoids chatter right at the threshold.
const HEEL_STANCE_ON = 150   // heel load above this -> stance (foot down)
const HEEL_STANCE_OFF = 50   // heel load below this -> swing (foot lifted)
// Third state, same idea: heel loaded but TOES unloaded means the foot is
// still down but rocked back onto the heel (toes deliberately lifted), not
// mid-swing (heel unloaded/foot off the ground). Own hysteresis band so it
// doesn't chatter against 'stance' right at the threshold, same as heel's.
const TOE_LOAD_ON = 150      // toe load above this -> flat/stance
const TOE_LOAD_OFF = 50      // toe load below this -> heel-only

// Gait timing (stance/swing/double-support %, cadence, symmetry). Stance %
// is an exponential moving average, not a fixed-window average over stored
// samples - cheap, self-forgetting of old data, and settles to the true
// rolling percentage within about GAIT_PCT_WINDOW_S seconds either way.
const GAIT_PCT_WINDOW_S = 8
const STRIDE_BUF_MAX = 6     // recent heel-strikes kept per foot for cadence
// Cadence itself gets NO smoothing anywhere else in the pipeline - it's a
// straight recompute from up to 5 raw intervals every tick, so a single
// irregular step (pausing, an early/late heel-strike detection) swings the
// number hard. EMA it the same way the knee-angle signal is smoothed above,
// but with a longer time constant: cadence only genuinely updates once per
// stride (roughly every 0.5-1.5s), not every tick, so it needs heavier
// damping to actually settle - short enough to still track a real pace
// change within a few strides, not so long it goes sluggish.
const CADENCE_SMOOTH_TAU_S = 4

// Per-rep form checks, evaluated once a rep completes. Thresholds follow the
// same "error tolerance" idea used in knee-OA rehab literature (e.g. Chen et
// al. 2015's SAE/SLR/QSM alteration table) - not reading the exercise TYPE
// (the UI already knows that), just flagging the same failure modes: not
// reaching target flexion, trunk/hip compensation, and moving too fast to
// control. Priority order below matches severity, not literature order.
const FORM_TARGET_MARGIN = 0.95     // peak angle must reach this fraction of kneeTarget
const FORM_HIP_COMPENSATION_DEG = 15
const FORM_MIN_REP_S = 0.4

// Live-path smoothing for the knee-angle signal. knee/filters.py's own
// rationale applies here too: raw per-sample noise on the BNO085 fused
// quaternions becomes per-sample angle noise that can spike well past the
// clinical accuracy target even when its RMS looks fine - and that noisy
// value is what rep-phase detection, peak tracking, SI and the Rehab Score
// all read directly. Unlike the offline engine's Butterworth design (tuned
// for 100Hz), this is a simple EMA sized in TIME (not sample count) so it
// works at whatever rate packets actually arrive. The time constant is kept
// well under FORM_MIN_REP_S so it damps jitter without blurring real rep
// timing/peaks.
const KNEE_SMOOTH_TAU_S = 0.12

// Derives display metrics from the raw socket snapshot: foot loads (baseline
// removed), left/right balance, hip tilt-from-neutral, knee rep counting, and a
// rolling history buffer for the clinician time charts. Keeps per-channel foot
// baselines and the hip zero in a ref so they persist across renders.
export function useMetrics(snap, { kneeTarget = 60 } = {}) {
  const S = useRef({
    hist: [], baseL: {}, baseR: {}, lWasOk: false, rWasOk: false, hipRef: null,
    repsL: 0, phaseL: 'down', repsR: 0, phaseR: 'down',
    // knee flexion calibration: rolling raw-quaternion buffers feed capture
    // clicks; calL/calR (once set) hold {qNeutral, axis} and switch the angle
    // computation from the firmware's rough cross-check to real swing-twist.
    // Separate phase/button per side - a patient calibrating solo can't hold
    // a controlled bend on both legs at once, and one knee's capture
    // shouldn't be blocked on the other leg being mid-flow.
    // Live smoothing state for the knee-angle signal (see KNEE_SMOOTH_TAU_S).
    // wasOk trackers let a reconnect snap straight to the new reading instead
    // of easing in from a stale pre-disconnect value - same idea as the feet
    // baseline reset on reconnect below.
    smoothKneeL: null, smoothKneeR: null, kneeLWasOk: false, kneeRWasOk: false,
    bufL: [], bufR: [], calL: null, calR: null,
    calPhaseL: 'idle', calCaptureL: null, calMsgL: '',
    calPhaseR: 'idle', calCaptureR: null, calMsgR: '',
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
    footLayout: null, heelBaseL: {}, heelBaseR: {}, toeBaseL: {}, toeBaseR: {},
    footPhaseL: 'stance', footPhaseR: 'stance',
    repPeakL: 0, repPeakHipL: 0, repStartTL: null, formFlagL: '', lastRepPeakL: null,
    repPeakR: 0, repPeakHipR: 0, repStartTR: null, formFlagR: '', lastRepPeakR: null,
    // Gait timing: EMA of "in stance" per foot (see GAIT_PCT_WINDOW_S), plus
    // recent heel-strike timestamps per foot for cadence. lastTickT lets the
    // EMA use real elapsed time (dt) instead of assuming a fixed tick rate.
    lastTickT: null, stancePctL: 100, stancePctR: 100, dsPct: 100,
    heelStrikeTimesL: [], heelStrikeTimesR: [], smoothCadence: null,
    // Two physically different insole boards rarely have matched raw
    // sensitivity (FSR batch/wiring variance) - comparing raw baseline-
    // subtracted sums directly can skew the balance split even with a
    // perfect zero. balScaleR corrects the RIGHT reading to match the LEFT
    // reading's scale, captured once via calibrateBalance() while standing
    // evenly (assumed 50/50 - the only reference this software has).
    balScaleR: 1, lastLoadL: null, lastLoadR: null, calMsgBalance: '',
    feetSettleUntilT: null,
    // hip TILT direction calibration: hipTilt (via quat.js tiltDeg) is
    // deliberately unsigned - fine for the "how far off level" ring, useless
    // for the gait avatar which needs a real left/right direction to rotate
    // correctly. Same two-click axis-measurement idea as knee/hip-flexion,
    // but against a single sensor's own captured reference (no second body
    // to take a relative orientation against) - lean one fixed direction
    // (right) during calibration so the measured axis's sign convention is
    // deterministic: positive = leaning right from then on.
    bufHipTilt: [], calHipTilt: null,
    calPhaseHipTilt: 'idle', calCaptureHipTilt: null, calMsgHipTilt: '',
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

    // Auto-reset each foot's zero baseline on a fresh connect (offline ->
    // online). The baseline is a running minimum that only ever ratchets
    // down and never recovers on its own - over a long session, a single
    // noisy low sample anywhere permanently corrupts the zero point from
    // then on. Resetting on reconnect means a board coming back up (which
    // happens a lot over hours of testing/power-cycling) gets a clean floor
    // instead of inheriting hours of accumulated drift.
    if (lOk && !s.lWasOk) { s.baseL = {}; s.feetSettleUntilT = snap.t + FEET_SETTLE_S }
    if (rOk && !s.rWasOk) { s.baseR = {}; s.feetSettleUntilT = snap.t + FEET_SETTLE_S }
    s.lWasOk = lOk
    s.rWasOk = rOk
    if (kneeLOk && !s.kneeLWasOk) s.smoothKneeL = null
    if (kneeROk && !s.kneeRWasOk) s.smoothKneeR = null
    s.kneeLWasOk = kneeLOk
    s.kneeRWasOk = kneeROk

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

    // Heel/toe-specific load (subset of channels, not the whole-foot total)
    // drives stance/swing/heel-only phase for the gait avatar's feet.
    const zoneLoad = (side, arr, base, anatomy) => {
      const zones = s.footLayout?.[side]
      if (!arr || !zones) return null
      let sum = 0
      for (const [ch, z] of Object.entries(zones)) {
        if (z.anatomy !== anatomy) continue
        const v = arr[Number(ch)] ?? 0
        base[ch] = base[ch] == null ? v : Math.min(base[ch], v)
        sum += Math.max(0, v - base[ch])
      }
      return sum
    }
    const heelL = lOk ? zoneLoad('left', feet.left.c, s.heelBaseL, 'heel') : null
    const heelR = rOk ? zoneLoad('right', feet.right.c, s.heelBaseR, 'heel') : null
    const toeL = lOk ? zoneLoad('left', feet.left.c, s.toeBaseL, 'toe') : null
    const toeR = rOk ? zoneLoad('right', feet.right.c, s.toeBaseR, 'toe') : null

    // Heel unloading always wins (foot coming off the ground entirely, mid-
    // swing) regardless of toe state. Among heel-loaded states, toe load
    // decides flat stance vs. rocked back on the heel only.
    const nextFootPhase = (phase, heel, toe) => {
      if (heel == null) return phase
      if (phase !== 'swing' && heel < HEEL_STANCE_OFF) return 'swing'
      if (phase === 'swing' && heel > HEEL_STANCE_ON) {
        return (toe != null && toe < TOE_LOAD_OFF) ? 'heel-only' : 'stance'
      }
      if (phase === 'stance' && toe != null && toe < TOE_LOAD_OFF) return 'heel-only'
      if (phase === 'heel-only' && toe != null && toe > TOE_LOAD_ON) return 'stance'
      return phase
    }
    const prevPhaseL = s.footPhaseL
    const prevPhaseR = s.footPhaseR
    s.footPhaseL = nextFootPhase(s.footPhaseL, heelL, toeL)
    s.footPhaseR = nextFootPhase(s.footPhaseR, heelR, toeR)

    // Heel strike = the moment a foot leaves 'swing' (heel just made contact
    // again), regardless of whether it lands as 'stance' or 'heel-only'.
    if (prevPhaseL === 'swing' && s.footPhaseL !== 'swing') {
      s.heelStrikeTimesL.push(snap.t)
      if (s.heelStrikeTimesL.length > STRIDE_BUF_MAX) s.heelStrikeTimesL.shift()
    }
    if (prevPhaseR === 'swing' && s.footPhaseR !== 'swing') {
      s.heelStrikeTimesR.push(snap.t)
      if (s.heelStrikeTimesR.length > STRIDE_BUF_MAX) s.heelStrikeTimesR.shift()
    }

    // Rolling stance/double-support % via EMA (see GAIT_PCT_WINDOW_S above).
    // Guards against a huge dt (reconnect gap, tab backgrounded) skewing the
    // average in one jump - just skip the update for that one tick instead.
    const dt = s.lastTickT != null ? snap.t - s.lastTickT : 0
    s.lastTickT = snap.t
    if (dt > 0 && dt < 1) {
      const ease = 1 - Math.exp(-dt / GAIT_PCT_WINDOW_S)
      if (lOk) s.stancePctL += ((s.footPhaseL !== 'swing' ? 100 : 0) - s.stancePctL) * ease
      if (rOk) s.stancePctR += ((s.footPhaseR !== 'swing' ? 100 : 0) - s.stancePctR) * ease
      if (lOk && rOk) {
        const inDS = (s.footPhaseL !== 'swing' && s.footPhaseR !== 'swing') ? 100 : 0
        s.dsPct += (inDS - s.dsPct) * ease
      }
    }

    // Cadence from average stride time (heel-strike to next same-foot heel-
    // strike), combining both feet - matches the "x2 for both legs" formula.
    const avgInterval = (times) => {
      if (times.length < 2) return null
      let sum = 0
      for (let i = 1; i < times.length; i++) sum += times[i] - times[i - 1]
      return sum / (times.length - 1)
    }
    const strideL = lOk ? avgInterval(s.heelStrikeTimesL) : null
    const strideR = rOk ? avgInterval(s.heelStrikeTimesR) : null
    const strides = [strideL, strideR].filter((v) => v != null && v > 0.2 && v < 5)
    const avgStrideS = strides.length ? strides.reduce((a, b) => a + b, 0) / strides.length : null
    const rawCadence = avgStrideS ? (60 / avgStrideS) * 2 : null

    // EMA smoothing (see CADENCE_SMOOTH_TAU_S) - snaps to the raw value on
    // the first reading or after a gap (walking stopped, cadence went null)
    // rather than easing in from a stale number.
    if (rawCadence == null) {
      s.smoothCadence = null
    } else if (s.smoothCadence == null || !(dt > 0) || dt >= 1) {
      s.smoothCadence = rawCadence
    } else {
      s.smoothCadence += (rawCadence - s.smoothCadence) * (1 - Math.exp(-dt / CADENCE_SMOOTH_TAU_S))
    }
    const cadence = s.smoothCadence

    if (s.hipRef == null && hipOk) s.hipRef = hip.q
    const hipTilt = hipOk && s.hipRef ? tiltDeg(s.hipRef, hip.q) : null

    // Rolling buffer for the hip-tilt DIRECTION calibration below - just the
    // pelvis's own orientation, no knee board needed (unlike hip flexion).
    if (hipOk) {
      s.bufHipTilt.push(hip.q)
      if (s.bufHipTilt.length > CAL_BUF_MAX) s.bufHipTilt.shift()
    }
    const hipTiltSigned = (hipOk && s.calHipTilt)
      ? angleAboutAxisDeg(qcanon(qrelative(s.calHipTilt.qNeutral, hip.q)), s.calHipTilt.axis)
      : null

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

    const rawKneeLAngle = kneeLOk
      ? (s.calL ? calibratedAngle(s.calL, knee.left.q_thigh, knee.left.q_shank) : knee.left.angle)
      : null
    const rawKneeRAngle = kneeROk
      ? (s.calR ? calibratedAngle(s.calR, knee.right.q_thigh, knee.right.q_shank) : knee.right.angle)
      : null

    // EMA low-pass (see KNEE_SMOOTH_TAU_S above) - snaps straight to the raw
    // value on the first sample after connect/reconnect (smoothKneeX == null,
    // via the wasOk reset above) or if dt is degenerate, otherwise eases
    // toward it using real elapsed time so the smoothing strength doesn't
    // depend on packet rate.
    const smoothTo = (key, raw) => {
      if (raw == null) { s[key] = null; return null }
      if (s[key] == null || !(dt > 0) || dt >= 1) { s[key] = raw; return raw }
      s[key] += (raw - s[key]) * (1 - Math.exp(-dt / KNEE_SMOOTH_TAU_S))
      return s[key]
    }
    const kneeLAngle = kneeLOk ? smoothTo('smoothKneeL', rawKneeLAngle) : null
    const kneeRAngle = kneeROk ? smoothTo('smoothKneeR', rawKneeRAngle) : null

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
          s.lastRepPeakL = s.repPeakL
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
          s.lastRepPeakR = s.repPeakR
          const duration = s.repStartTR != null ? snap.t - s.repStartTR : null
          s.formFlagR = judgeForm(s.repPeakR, s.repPeakHipR, duration)
        }
      }
    }

    // Symmetry Index: SI = |X_L - X_R| / (0.5*(X_L+X_R)) * 100, per Robinson
    // et al. (1987) - standard clinical gait-symmetry formula. Computed on
    // two parameters: rolling stance-time % (from the gait timing above) and
    // peak knee flexion from each side's most recently COMPLETED rep (not
    // the in-progress one, which is mid-bend and not a fair comparison).
    // Both null until there's a real value on both sides to compare.
    const symmetryIndex = (xl, xr) => {
      if (xl == null || xr == null) return null
      const denom = 0.5 * (xl + xr)
      return denom === 0 ? null : Math.abs(xl - xr) / denom * 100
    }
    const siStance = (lOk && rOk) ? symmetryIndex(s.stancePctL, s.stancePctR) : null
    const siKneeFlex = symmetryIndex(s.lastRepPeakL, s.lastRepPeakR)
    const siValues = [siStance, siKneeFlex].filter((v) => v != null)
    const symmetryIndexOverall = siValues.length ? siValues.reduce((a, b) => a + b, 0) / siValues.length : null

    // Rehab Score: an equally-weighted composite of the factors we can
    // actually derive right now (symmetry, ROM achievement, gait-phase
    // health) - NOT a validated clinical index, just a single at-a-glance
    // number for the patient view. A factor with no data yet is left out of
    // the average rather than dragging the score down for missing data.
    const scoreParts = []
    if (symmetryIndexOverall != null) scoreParts.push(Math.max(0, 100 - symmetryIndexOverall))
    if (s.lastRepPeakL != null || s.lastRepPeakR != null) {
      const bestPeak = Math.max(s.lastRepPeakL ?? 0, s.lastRepPeakR ?? 0)
      scoreParts.push(kneeTarget > 0 ? Math.min(100, (bestPeak / kneeTarget) * 100) : 0)
    }
    // Gated on cadence (real heel-strikes detected recently), not just "a
    // foot sensor is connected" - the ~60% figure is a WALKING gait-cycle
    // target. A patient doing a seated/stationary exercise sits at ~100%
    // stance forever (feet planted, never swinging), and without this gate
    // that used to floor this component at 0 and drag the whole Rehab Score
    // down for doing nothing wrong - same failure mode as scoring weight
    // balance against 50/50 during a deliberate single-leg exercise.
    if (cadence != null && (lOk || rOk)) {
      const avgStancePct = lOk && rOk ? (s.stancePctL + s.stancePctR) / 2 : (lOk ? s.stancePctL : s.stancePctR)
      scoreParts.push(Math.max(0, 100 - Math.abs(avgStancePct - 60) * 4))  // full score at the ~60% healthy stance figure
    }
    const rehabScore = scoreParts.length ? Math.round(scoreParts.reduce((a, b) => a + b, 0) / scoreParts.length) : null

    s.hist.push({
      t: snap.t, kneeL: kneeLAngle, kneeR: kneeRAngle, hip: hipTilt, loadL, loadR,
      actuationTension: actuationOk ? actuation.tension_n : null,
    })
    if (s.hist.length > SESSION_MAX) s.hist.shift()

    setM({
      kneeLAngle, kneeLOk, kneeRAngle, kneeROk, hipTilt, hipOk,
      hipTiltSigned, hipTiltCalibrated: !!s.calHipTilt,
      calPhaseHipTilt: s.calPhaseHipTilt, calMsgHipTilt: s.calMsgHipTilt,
      loadL, loadR, lOk, rOk,
      feetSettling: s.feetSettleUntilT != null && snap.t < s.feetSettleUntilT,
      footPhaseL: lOk ? s.footPhaseL : null, footPhaseR: rOk ? s.footPhaseR : null,
      repsL: s.repsL, repsR: s.repsR, hist: s.hist,
      formFlagL: s.formFlagL, formFlagR: s.formFlagR,
      hipFlexL, hipFlexR, hipFlexCalibratedL: !!s.calHipL, hipFlexCalibratedR: !!s.calHipR,
      calPhaseHip: s.calPhaseHip, calMsgHip: s.calMsgHip,
      calMsgBalance: s.calMsgBalance,
      actuationOk, actuationTension: actuationOk ? actuation.tension_n : null,
      actuationState: actuationOk ? actuation.state : null,
      // Not gated on actuationOk - this is clinician/patient workflow state
      // (pending/approved/rejected weight suggestion), independent of
      // whether the board itself currently has a live link.
      actuationRecommendation: snap.actuationRecommendation ?? null,
      anyLive: kneeLOk || kneeROk || hipOk || lOk || rOk,
      calibratedL: !!s.calL, calibratedR: !!s.calR,
      calPhaseL: s.calPhaseL, calMsgL: s.calMsgL,
      calPhaseR: s.calPhaseR, calMsgR: s.calMsgR,
      // Performance metrics (gait timing, symmetry, composite score) - see
      // the comment block above s.hist.push for how each is derived.
      stancePctL: lOk ? s.stancePctL : null, stancePctR: rOk ? s.stancePctR : null,
      swingPctL: lOk ? 100 - s.stancePctL : null, swingPctR: rOk ? 100 - s.stancePctR : null,
      doubleSupportPct: (lOk && rOk) ? s.dsPct : null,
      cadence, siStance, siKneeFlex, symmetryIndexOverall, rehabScore,
      lastRepPeakL: s.lastRepPeakL, lastRepPeakR: s.lastRepPeakR,
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

  // Independent two-click flow per knee, mirroring axis_calibration.py: first
  // click captures a short averaged window of the current (assumed straight)
  // pose as neutral, second click captures a bent pose and derives that
  // side's real flexion axis from the rotation between them. Split per side
  // (rather than one button driving both) because a patient calibrating
  // solo can't hold a controlled, deliberate bend on both legs
  // simultaneously - each leg gets its own capture, in its own time.
  const calibrateKneeSide = (side) => {
    const s = S.current
    const buf = side === 'left' ? s.bufL : s.bufR
    const captureKey = side === 'left' ? 'calCaptureL' : 'calCaptureR'
    const calKey = side === 'left' ? 'calL' : 'calR'
    const phaseKey = side === 'left' ? 'calPhaseL' : 'calPhaseR'
    const msgKey = side === 'left' ? 'calMsgL' : 'calMsgR'

    if (buf.length < 3) {
      s[msgKey] = 'Waiting for sensor data - try again in a moment'
      return
    }

    if (s[phaseKey] === 'idle') {
      s[captureKey] = buf.slice()   // snapshot raw samples (not just their average) - the
      s[phaseKey] = 'awaiting-bent' // quality gate below needs per-sample spread, not just the mean
      s[msgKey] = 'Now bend the knee ~30-60° and hold still, then click again'
      return
    }

    const straightBuf = s[captureKey]
    s[phaseKey] = 'idle'
    s[captureKey] = null
    if (!straightBuf) {   // wasn't live for the straight capture
      s[msgKey] = 'Sensor dropped mid-capture - try again'
      return
    }
    const bentBuf = buf.slice()

    // Relative (thigh->shank) orientation per sample - averaging THIS (not qt/qs
    // separately) matches calibrate.py's calibrate_from_quaternions exactly.
    const straightRels = straightBuf.map((b) => qrelative(b.qt, b.qs))
    const bentRels = bentBuf.map((b) => qrelative(b.qt, b.qs))
    const qNeutral = qaverage(straightRels)
    const qBentRel = qaverage(bentRels)
    const qOffset = qrelative(qNeutral, qBentRel)
    const { axis, angleDeg } = axisAngle(qcanon(qOffset))
    if (angleDeg < MIN_BEND_DEG) {
      s[msgKey] = 'Bend too small - hold each pose still and try again'
      return
    }

    // RMS angular deviation (deg) of a window's samples from their own average -
    // "how still was this pose actually held". Mirrors calibrate.py's residual_rms_deg.
    const residualDeg = (rels, qRef) => {
      const devs = rels.map((r) => {
        const dot = Math.min(1, Math.abs(r[0] * qRef[0] + r[1] * qRef[1] + r[2] * qRef[2] + r[3] * qRef[3]))
        return (2 * Math.acos(dot) * 180) / Math.PI
      })
      return Math.sqrt(devs.reduce((a, d) => a + d * d, 0) / devs.length)
    }
    const neutralResidual = residualDeg(straightRels, qNeutral)
    const bentResidual = residualDeg(bentRels, qBentRel)

    // Axis confidence: for each bent-window sample, how well does its own
    // rotation-from-neutral axis agree with the consensus `axis`, weighted
    // toward bigger rotations (whose axis is better determined). Mirrors
    // axis_calibration.py's confidence calc exactly.
    let confWeight = 0
    let confSum = 0
    for (const r of bentRels) {
      const [, x, y, z] = qcanon(qrelative(qNeutral, r))
      const n = Math.hypot(x, y, z)
      if (n < 1e-6) continue
      const collin = Math.abs((x / n) * axis[0] + (y / n) * axis[1] + (z / n) * axis[2])
      confWeight += n
      confSum += n * collin
    }
    const axisConfidence = confWeight > 0 ? Math.min(1, confSum / confWeight) : 0

    if (axisConfidence < KNEE_CAL_MIN_CONFIDENCE) {
      s[msgKey] = `Bend wobbled off-axis (${Math.round(axisConfidence * 100)}% clean) - ` +
        'keep it a straight knee bend, no hip twist or rotation, and try again'
      return
    }
    if (neutralResidual > KNEE_CAL_MAX_RESIDUAL_DEG || bentResidual > KNEE_CAL_MAX_RESIDUAL_DEG) {
      s[msgKey] = 'One of the poses was not held steady enough - hold each pose fully still and try again'
      return
    }

    s[calKey] = { qNeutral, axis }
    s[msgKey] = 'Calibrated'
  }
  const calibrateKneeL = () => calibrateKneeSide('left')
  const calibrateKneeR = () => calibrateKneeSide('right')

  // Same two-click flow as calibrateKneeSide, but relating the pelvis sensor to
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
      s.calMsgHip = 'Now lift one knee up and forward, like marching in place, until your thigh ' +
        'is about 30-60° off vertical - hold still, then click again'
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

  // Two-click flow like the others, but against a SINGLE sensor's own
  // captured reference (no second body to relate it to): first click
  // captures "level" as neutral, second click (after leaning RIGHT - a fixed
  // direction so the sign convention is deterministic) derives the real
  // left/right axis from the rotation between them. Fixes hipTilt's
  // unsigned-by-design limitation (see tiltDeg in quat.js) for anything that
  // needs an actual direction, like the gait avatar's pelvis/torso rotation.
  const calibrateHipTilt = () => {
    const s = S.current
    if (s.bufHipTilt.length < 3) {
      s.calMsgHipTilt = 'Waiting for hip sensor data - try again in a moment'
      return
    }
    if (s.calPhaseHipTilt === 'idle') {
      s.calCaptureHipTilt = qaverage(s.bufHipTilt)
      s.calPhaseHipTilt = 'awaiting-lean'
      s.calMsgHipTilt = 'Now lean to your RIGHT and hold still, then click again'
      return
    }
    const level = s.calCaptureHipTilt
    s.calPhaseHipTilt = 'idle'
    s.calCaptureHipTilt = null
    if (!level) {
      s.calMsgHipTilt = 'Sensor dropped mid-capture - try again'
      return
    }
    const leaned = qaverage(s.bufHipTilt)
    const qOffset = qrelative(level, leaned)
    const { axis, angleDeg } = axisAngle(qcanon(qOffset))
    if (angleDeg < MIN_BEND_DEG) {
      s.calMsgHipTilt = 'Lean too small - hold each pose still and try again'
      return
    }
    s.calHipTilt = { qNeutral: level, axis }
    s.calMsgHipTilt = 'Calibrated'
  }

  return { m, zeroHip, zeroFeet, resetReps, calibrateKneeL, calibrateKneeR, calibrateHips, calibrateHipTilt, calibrateBalance }
}
