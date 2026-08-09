// Guides a patient wearing every sensor at once through calibrating all of
// them in one pass, instead of hunting down each card's own Calibrate
// button. It doesn't do anything the individual buttons (PatientView.jsx,
// ClinicianView.jsx) don't already do - it's the exact same two-click
// capture flow per joint (calibrateKneeL/R, calibrateHips, calibrateHipTilt
// in useMetrics.js), just walked through in sequence with its own
// instruction text instead of the patient having to know which button to
// press next and in what pose. Balance calibration is one click, everything
// else is "stand straight, click, hold the target pose, click" - kept as two
// separate prompts per joint (not one shared "stand straight" for
// everything) so retrying a single joint that failed a quality check never
// has to unwind or replay any other joint's already-captured calibration.
//
// The step list is frozen at the moment the wizard starts (from whichever
// sensors are live right then) rather than re-evaluated live - if a board
// drops mid-wizard, that step's own calibrate call will just show its normal
// "waiting for sensor" message rather than the wizard silently skipping or
// reordering steps under the patient's feet.

import { useState } from 'react'

function buildSteps(m) {
  const kneeLOk = !!m?.kneeLOk
  const kneeROk = !!m?.kneeROk
  const hipOk = !!m?.hipOk
  const feetOk = !!m?.lOk && !!m?.rOk

  const steps = []
  if (feetOk) {
    steps.push({
      key: 'balance', label: 'Weight balance',
      prompts: ['Stand evenly on both feet with real weight on the insoles, then click Next.'],
      run: (actions) => actions.calibrateBalance(),
      result: (m) => m?.calMsgBalance,
    })
  }
  if (kneeLOk) {
    steps.push({
      key: 'kneeL', label: 'Left knee',
      prompts: [
        'Stand with your LEFT knee straight and hold still, then click Next.',
        'Now bend your LEFT knee about 30-60° and hold still, then click Next.',
      ],
      run: (actions) => actions.calibrateKneeL(),
      result: (m) => m?.calMsgL,
    })
  }
  if (kneeROk) {
    steps.push({
      key: 'kneeR', label: 'Right knee',
      prompts: [
        'Stand with your RIGHT knee straight and hold still, then click Next.',
        'Now bend your RIGHT knee about 30-60° and hold still, then click Next.',
      ],
      run: (actions) => actions.calibrateKneeR(),
      result: (m) => m?.calMsgR,
    })
  }
  if (hipOk && (kneeLOk || kneeROk)) {
    steps.push({
      key: 'hipFlex', label: 'Hip flexion',
      prompts: [
        'Stand straight and hold still, then click Next.',
        'Now raise your knee(s) (flex your hip) about 30-60° and hold still, then click Next.',
      ],
      run: (actions) => actions.calibrateHips(),
      result: (m) => m?.calMsgHip,
    })
  }
  if (hipOk) {
    steps.push({
      key: 'hipTilt', label: 'Hip tilt direction',
      prompts: [
        'Stand straight and level, hold still, then click Next.',
        'Now lean to your RIGHT and hold still, then click Next.',
      ],
      run: (actions) => actions.calibrateHipTilt(),
      result: (m) => m?.calMsgHipTilt,
    })
  }
  return steps
}

export default function CalibrateAllBar({ m, actions }) {
  const [steps, setSteps] = useState(null)     // null = wizard not running
  const [stepIdx, setStepIdx] = useState(0)
  const [clickCount, setClickCount] = useState(0)
  const [emptyMsg, setEmptyMsg] = useState('')

  const start = () => {
    const built = buildSteps(m)
    if (!built.length) {
      setEmptyMsg("Nothing to calibrate with the sensors currently connected.")
      return
    }
    setEmptyMsg('')
    setSteps(built)
    setStepIdx(0)
    setClickCount(0)
  }
  const close = () => setSteps(null)

  if (!steps) {
    return (
      <div className="cal-all-bar">
        <button className="btn download" onClick={start}>Calibrate all</button>
        {emptyMsg && <span className="cue">{emptyMsg}</span>}
      </div>
    )
  }

  // Once running, this takes over as a full-screen modal instead of the
  // small inline bar - the instructions/pose prompts need to be readable
  // from a few feet away (that's the whole point of walking through this
  // hands-free), not squeezed into the same row as the connection banner.
  const done = stepIdx >= steps.length
  const step = done ? null : steps[stepIdx]
  const capturing = step ? clickCount < step.prompts.length : false
  const next = () => {
    if (capturing) {
      step.run(actions)
      setClickCount((c) => c + 1)
    } else {
      setStepIdx((i) => i + 1)
      setClickCount(0)
    }
  }
  const retry = () => setClickCount(0)

  return (
    <div className="cal-all-overlay">
      <div className="cal-all-modal">
        {done ? (
          <>
            <div className="cal-all-title">All done</div>
            <div className="cal-all-prompt">Ran calibration for: {steps.map((s) => s.label).join(', ')}.</div>
            <div className="cal-all-actions">
              <button className="btn download" onClick={close}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="cal-all-progress">Step {stepIdx + 1} of {steps.length}</div>
            <div className="cal-all-title">{step.label}</div>
            <div className="cal-all-prompt">{capturing ? step.prompts[clickCount] : (step.result(m) || 'Captured.')}</div>
            <div className="cal-all-actions">
              {!capturing && <button className="btn ghost" onClick={retry}>Retry</button>}
              <button className="btn download" onClick={next}>{capturing ? 'Next' : 'Continue'}</button>
              <button className="btn ghost" onClick={close}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
