// Compact "picture-in-picture" view of the actuation session, shown on
// every tab EXCEPT Session while a session is actually running (phase !==
// 'idle') - so navigating away to check the Gait or Logs tab mid-exercise
// doesn't mean losing track of it. Reads the same live state as
// ActuationPanel.jsx (see useActuationSession.js, called once in App.jsx),
// it's just a second, smaller view over it - not a separate session.

const PHASE_LABEL = {
  countdown: (level, countdown) => `Starting in ${countdown}…`,
  twisting: (level) => `Twisting to ${level} kg…`,
  ready: () => 'Ready - twisted to target',
  exercising: () => 'Exercise in progress',
  summary: () => 'Session complete',
}

export default function ActuationFloatingWidget({ act, session, onGoToSession }) {
  const isClinician = session?.role === 'clinician'
  const { phase, tension, level, countdown, stopSession, forceStop } = act

  if (phase === 'idle') return null   // nothing running - nothing to float

  const statusText = (PHASE_LABEL[phase] || (() => ''))(level, countdown)

  return (
    <div className="act-float">
      <div className="act-float-head">
        <span className="act-float-title">Actuation session</span>
        <button type="button" className="act-float-goto" onClick={onGoToSession}>
          Session tab →
        </button>
      </div>
      <div className="act-float-tension">{tension.toFixed(1)}<span> kg</span></div>
      <div className="cue">{statusText}</div>
      {!isClinician && (
        <div className="act-float-actions">
          {phase === 'exercising' && (
            <button className="btn ghost" onClick={stopSession}>Stop</button>
          )}
          <button className="btn ghost act-force-stop" onClick={forceStop}>Force stop</button>
        </div>
      )}
    </div>
  )
}
