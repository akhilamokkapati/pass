# Actuation panel - UI/UX backlog

Tracking list for changes to `frontend/src/ActuationPanel.jsx` (and whatever
backend/firmware wiring each one implies). Captured 2026-08-10, before any of
this was implemented - nothing below is built yet. See
`actuation/Actuation Context.md` for the hardware/firmware side; this file is
webapp-only.

## Graph

- [ ] Rename "Actuation" section/card -> "Session Data"
- [ ] Investigate: force data appears to be influencing the set-force input
      (feedback loop bug - the setpoint shouldn't move on its own from the
      live reading)
- [ ] Rename the graph itself -> "Force Monitoring"

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
- [ ] Replace the small "Stop" button with a big, circular, red stop button
      (same visual treatment as the Manual Control stop button below)

## Recommendation

- [ ] Recommendation content changes based on the selected exercise
- [ ] Include PT-recommended rep count (needs a source for "PT recommended" -
      clinician-entered? fixed per exercise? not yet specified)

## Manual Control

- [ ] Replace the horizontal "Force stop" button with the same big circular
      stop button used in Session
- [ ] Twist/Untwist controls both motors simultaneously (for now - not
      antagonistic/independent control yet, matches §9 of Actuation Context.md
      being future/not-current-scope)
