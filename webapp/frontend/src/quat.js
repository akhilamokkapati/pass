// Minimal quaternion helpers (scalar-first) for pelvis tilt from neutral.

export function qmul(a, b) {
  const [aw, ax, ay, az] = a
  const [bw, bx, by, bz] = b
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ]
}

export function qconj(q) {
  return [q[0], -q[1], -q[2], -q[3]]
}

// Total rotation of q away from a reference pose, in degrees (0 when equal).
export function tiltDeg(ref, q) {
  let [w, x, y, z] = qmul(qconj(ref), q)
  if (w < 0) { w = -w; x = -x; y = -y; z = -z }
  const nv = Math.hypot(x, y, z)
  return (2 * Math.atan2(nv, w) * 180) / Math.PI
}

// ---- knee flexion calibration helpers ----------------------------------
// Mirrors knee/biomechanics/quaternion_math.py + relative_orientation.py so
// the live dashboard can do the same swing-twist flexion extraction the
// validated Python engine does, instead of the firmware's rough total-angle
// cross-check (2*acos(|dot|), unsigned, no axis isolation).

export function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

// q and -q are the same rotation; force w >= 0 so a sensor sign-flip can't
// make a continuous angle jump.
export function qcanon(q) {
  return q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q
}

// Orientation of b relative to a: conj(a) (x) b.
export function qrelative(a, b) {
  return qmul(qconj(a), b)
}

// Sign-aware average of a cluster of unit quaternions (aligns hemisphere to
// the first sample before summing, so mixed q/-q readings don't cancel).
// Good enough for a tight, briefly-held calibration pose.
export function qaverage(quats) {
  if (!quats.length) return [1, 0, 0, 0]
  const ref = quats[0]
  const sum = [0, 0, 0, 0]
  for (const q of quats) {
    const flip = (q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3]) < 0 ? -1 : 1
    sum[0] += flip * q[0]; sum[1] += flip * q[1]; sum[2] += flip * q[2]; sum[3] += flip * q[3]
  }
  return qnorm(sum)
}

// Signed angle (deg) of q's rotation about a unit axis (swing-twist
// decomposition): isolates rotation about `axis` and discards the rest, so
// off-axis wobble (ab/adduction, internal rotation) doesn't leak into flexion.
export function angleAboutAxisDeg(q, axis) {
  const [w, x, y, z] = qnorm(q)
  const [ax, ay, az] = axis
  const proj = x * ax + y * ay + z * az
  const twist = qnorm([w, proj * ax, proj * ay, proj * az])
  const [tw, tx, ty, tz] = twist
  const sinHalf = Math.hypot(tx, ty, tz)
  let sign = tx * ax + ty * ay + tz * az
  sign = sign === 0 ? 1 : Math.sign(sign)
  return (2 * Math.atan2(sinHalf * sign, tw) * 180) / Math.PI
}

// Axis-angle read of a rotation quaternion: the unit axis it rotates about
// and the rotation magnitude in degrees. Used to MEASURE the flexion axis
// from a straight-to-bent calibration move, rather than assuming a fixed one.
export function axisAngle(q) {
  const [w0, x0, y0, z0] = qcanon(qnorm(q))
  const w = Math.max(-1, Math.min(1, w0))
  const angleDeg = (2 * Math.acos(w) * 180) / Math.PI
  const s = Math.sqrt(Math.max(0, 1 - w * w))
  const axis = s < 1e-6 ? [1, 0, 0] : [x0 / s, y0 / s, z0 / s]
  return { axis, angleDeg }
}
