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

- [ ] Rename "Session" -> "Resistive Training"
- [ ] Add exercise selector: knee extension / hamstring curl
- [ ] Add reps selector: 3, 5, 8, 10, 12 - mainly to label the dataset for
      later logging/reporting, not a live rep counter input
- [ ] Force-level buttons (currently the `KG_OPTIONS` row) -> vertical layout
      instead of horizontal
- [ ] "Start session" should wait through a 3-2-1 countdown before the motor
      starts twisting (countdown UI already exists - confirm/wire the actual
      twist command to fire only after it completes)
- [ ] Show "Setting up" while the motor is twisting toward the target (maps
      to the existing `twisting` phase - just needs the right label)
- [ ] Show "Ready" once the strain gauge reading matches the set force input
      (maps to the existing `ready` phase/`READY_MARGIN` logic)
- [ ] "Begin exercise" - notifies the system the patient is about to start
      moving. **Open question from initial request: is this a real system
      signal something downstream needs, or purely UX polish (e.g. just
      starts the on-screen rep counter)? Needs a decision before/while
      implementing.**
- [ ] During "Exercise in progress": pull rep count from the IMU/knee sensing
      side, show reps done vs. reps remaining (needs a data source - knee
      module doesn't currently feed the actuation panel; this is a new
      cross-subsystem wire-up, not just a UI change)
- [x] Replace the small "Stop" button with a big, circular, red stop button
      (same visual treatment as the Manual Control stop button below) - added
      a shared `.stop-circle` style in `styles.css`, used by both this and
      Manual Control's Force Stop.

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
