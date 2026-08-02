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
