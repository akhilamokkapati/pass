// Small looping stick-figure demo shown in the Calibrate All modal so the
// instruction text ("bend your LEFT knee", "lean to your RIGHT"...) has a
// picture to go with it. Pure inline SVG + CSS keyframes (see .pose-* rules
// in styles.css) - no video/image assets, so it stays a few KB and themes
// automatically via the existing CSS variables.
//
// Each pose is a plain side-view figure; only the parts relevant to that
// pose actually move; everything else holds the neutral standing pose. The
// knee-bend pose keeps the thigh vertical and swings just the shin
// backward, matching the calibration motion itself (calibrateKneeSide in
// useMetrics.js reads a thigh/shank relative rotation, not a whole-leg one)
// rather than a generic "knee bend" drawing that wouldn't match what's
// actually being captured.

const POSE_LABEL = {
  stand: 'Stand straight',
  kneeL: 'Bend LEFT knee',
  kneeR: 'Bend RIGHT knee',
  hipFlex: 'Lift knee up and forward',
  hipTilt: 'Lean RIGHT',
}

export default function PoseAnimation({ pose }) {
  const cls = `pose-fig pose-${pose || 'stand'}`
  return (
    <svg viewBox="0 0 160 190" className="pose-anim" aria-label={POSE_LABEL[pose] || ''}>
      <g className={cls}>
        {/* head */}
        <circle cx="80" cy="26" r="13" className="pose-part" />
        {/* torso + arms, rotate together as one unit for the hip-tilt lean */}
        <g className="pose-upper">
          <line x1="80" y1="39" x2="80" y2="104" className="pose-part" />
          <line x1="80" y1="52" x2="58" y2="90" className="pose-part" />
          <line x1="80" y1="52" x2="102" y2="90" className="pose-part" />
        </g>
        {/* right leg (viewer's right = figure's left leg, kept static except hip-tilt plant) */}
        <line x1="80" y1="104" x2="94" y2="150" className="pose-part pose-static" />
        <line x1="94" y1="150" x2="96" y2="182" className="pose-part pose-static" />
        {/* left leg (the one that moves for kneeL / hipFlex) */}
        <g className="pose-leg-hip">
          <line x1="80" y1="104" x2="66" y2="150" className="pose-part pose-thigh" />
          <g className="pose-leg-knee">
            <line x1="66" y1="150" x2="64" y2="182" className="pose-part pose-shin" />
          </g>
        </g>
      </g>
    </svg>
  )
}
