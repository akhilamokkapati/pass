# Actuation panel - UI/UX backlog

Tracking list for changes to `frontend/src/ActuationPanel.jsx` (and whatever
backend/firmware wiring each one implies). Captured 2026-08-10, before any of
this was implemented - nothing below is built yet. See
`actuation/Actuation Context.md` for the hardware/firmware side; this file is
webapp-only.

## Graph

- [x] Rename "Actuation" section/card -> "Session Data"
- [x] Investigate: force data appears to be influencing the set-force input.
      **Traced through `useActuationSession.js` - not a code bug.** `target`
      (from `sessionRef.current.target`) and `level` (the KG button
      selection) are never derived from `tension` anywhere; they're fully
      independent state. What's actually happening: with no real strain
      gauge wired up yet, `angle_pid_wifi_test.cpp` sends raw encoder counts
      in the `tension_n` slot as a placeholder (see
      `actuation/Firmware/prototyping/angle_pid_wifi_test.cpp`) - so the
      "Actual" reading swings to nonsensical values (e.g. -356 kg) next to a
      steady "Target 1 kg", which *looks* like cross-talk but is just the
      known placeholder-data caveat. Resolves itself once a real strain
      gauge (or at least a sane clamp/scale) feeds `tension_n`; no webapp
      change needed.
- [x] Rename the graph itself -> "Force Monitoring"
- [x] Remove the "board state: ..." line from the Session Data card (was
      showing the firmware's internal serial-state-machine name, not
      patient/clinician-relevant info)

## Session

- [x] Rename "Session" -> "Resistive Training"
- [x] Add exercise selector: knee extension / hamstring curl (already built
      as part of the Recommendation work above, reused here)
- [ ] Add reps selector: 3, 5, 8, 10, 12 - mainly to label the dataset for
      later logging/reporting, not a live rep counter input
- [x] Force-level buttons (currently the `KG_OPTIONS` row) -> vertical layout
      instead of horizontal (added `.act-kg-row-vertical`, force-level row
      only - exercise selector stays horizontal)
- [ ] "Start session" should wait through a 3-2-1 countdown before the motor
      starts twisting (countdown UI already exists - confirm/wire the actual
      twist command to fire only after it completes)
- [x] Show "Setting up" while the motor is twisting toward the target (was
      "Twisting to X kg…")
- [x] Show "Ready" once the strain gauge reading matches the set force input
      (was "Ready - twisted to target")
- [x] "Begin exercise" - notifies the system the patient is about to start
      moving. **Decided: purely a UX layer, not a real system/firmware
      signal.** Confirmed the current `beginExercise()` in
      `useActuationSession.js` already matches this - it only sets local
      state (`startedAt`, resets `samples`, flips `phase` to `exercising`),
      no `sendCmd()` call to the board. No code change needed.
- [ ] During "Exercise in progress": pull rep count from the IMU/knee sensing
      side, show reps done vs. reps remaining (needs a data source - knee
      module doesn't currently feed the actuation panel; this is a new
      cross-subsystem wire-up, not just a UI change)
- [x] Replace the small "Stop" button with a big, circular, red stop button
      (same visual treatment as the Manual Control stop button below) - added
      a shared `.stop-circle` style in `styles.css`, used by both this and
      Manual Control's Force Stop.
- [x] Session Data card (top card) should only show live tension while a
      session is actually running, not always - now gated on `hasTarget`
      (same condition already used for the Target/Actual line): shows "--"
      and a "No active session" cue otherwise.
- [ ] **Firmware note for later:** every time a session starts, the encoder
      reading should zero first - it never resets today. Not implementable
      yet since webapp -> firmware command mapping is still deferred (see
      `angle_pid_wifi_test.cpp` - commands are received and logged, not
      acted on). When that mapping gets built, session-start's `set_force`/
      `twist` handling needs to zero the encoder (existing `z` serial command
      already does this manually - same logic, just triggered by the
      incoming command instead of a keypress) before twisting toward the
      target.

## Recommendation

- [x] Recommendation content changes based on the selected exercise. Added a
      minimal client-side-only exercise selector (`EXERCISES` in
      `useActuationSession.js`: knee extension / hamstring curl) since no
      exercise concept existed anywhere (not in the UI, not in
      `sessions.py`/the sessions database). The recommendation card now shows
      the selected exercise's label; the actual kg/reason logic is still
      pure weight-progression from `sessions.py` (unchanged) - it doesn't
      yet know exercise type, it's just labeled per-exercise on screen.
      Revisit if recommendations should actually differ by exercise, which
      would need an `exercise` column added to `actuation_sessions` and
      `recommend_next_kg()` filtering by it.
- [x] Include PT-recommended rep count. **Placeholder data, not real PT
      input** - each exercise in `EXERCISES` has a hardcoded `ptReps` (knee
      extension: 10, hamstring curl: 8). Swap for a real source once one
      exists (clinician-entered? a fixed table someone provides?).
- [x] Clinician remarks input, logged against the session the current
      recommendation is based on (`rec.basedOnSessionId`). New
      `session_remarks` table in `sessions.py` (append-only - a clinician can
      leave more than one remark over time, nothing gets overwritten), new
      endpoints `POST /api/actuation/session/remark` and
      `GET /api/actuation/session/{id}/remarks`. Only the log-a-remark UI was
      built (textarea + button, clinician-only); nothing currently displays
      logged remarks back anywhere (e.g. in `ActuationLogCard`) - flag if
      that's wanted next.

## Manual Control

- [x] Replace the horizontal "Force stop" button with the same big circular
      stop button used in Session - Force Stop also moved to live inside the
      Manual Control card itself (was a separate full-width button below it
      before).
- [x] Twist/Untwist controls both motors simultaneously (for now). No webapp
      change needed - the UI already only exposes one universal Twist/
      Untwist pair, no per-motor selector exists to remove. The actual
      "drives both motors together" behavior is a firmware concern for
      whenever `twist`/`untwist` commands get mapped onto real motor control
      (currently logged-only, not acted on - see
      `actuation/Firmware/prototyping/angle_pid_wifi_test.cpp`).
