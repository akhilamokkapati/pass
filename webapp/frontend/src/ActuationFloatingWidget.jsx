// Compact "picture-in-picture" view of the actuation session, shown on
// every tab EXCEPT Session while a session is actually running, OR while
// idle with a therapist-approved recommendation waiting (so it's not
// missed just because the patient happens to be on another tab) - so
// navigating away to check the Gait or Logs tab doesn't mean losing track
// of either. Reads the same live state as ActuationPanel.jsx (see
// useActuationSession.js, called once in App.jsx), it's just a second,
// smaller view over it - not a separate session.

const PHASE_LABEL = {
  countdown: (level, countdown) => `Starting in ${countdown}…`,
  twisting: (level) => `Twisting to ${level} kg…`,
  ready: () => 'Ready - twisted to target',
  exercising: () => 'Exercise in progress',
  summary: () => 'Session complete',
}

export default function ActuationFloatingWidget({ act, session, onGoToSession }) {
  const isClinician = session?.role === 'clinician'
  const { phase, tension, level, countdown, stopSession, forceStop, rec } = act

  // A therapist-approved recommendation is worth surfacing here too, not
  // just on the Session tab itself - otherwise a patient browsing Gait/Logs
  // has no way to notice one is waiting until they happen to check Session.
  const hasApprovedRec = !isClinician && rec?.status === 'approved'

  if (phase === 'idle' && !hasApprovedRec) return null   // nothing running, nothing waiting either

  if (phase === 'idle') {
    return (
      <div className="act-float">
        <div className="act-float-head">
          <span className="act-float-title">Actuation session</span>
          <button type="button" className="act-float-goto" onClick={onGoToSession}>
            Session tab →
          </button>
        </div>
        <div className="cue good">Your therapist recommends {rec.kg} kg next.</div>
      </div>
    )
  }

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
