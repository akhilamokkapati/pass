# Actuation module - handover

Snapshot of where things stand as of 2026-08-12, covering firmware, backend,
and webapp. See also `Actuation Context.md` (hardware/firmware background,
written earlier and not fully current - this file supersedes it on anything
about `angle_pid_wifi_test.cpp`) and `../webapp/ACTUATION_PANEL_TODO.md` (the
original webapp UI backlog - several of its items are now stale, flagged
below).

---

## 1. What's built and working

**Firmware** (`Firmware/prototyping/angle_pid_wifi_test.cpp`, PlatformIO env
`angle_pid_wifi_test`, board `seeed_xiao_esp32s3`, requires `bogde/HX711`):

- Resynced verbatim from `angle_pid_test_manual.cpp`'s calibration/force-hold
  rewrite (operating-point calibration, force PID, force+brake). That "main"
  block is never touched directly - everything below drives it through its
  own functions (`startOppointCalibration`, `resetPID`, `setMotor`,
  `brakeAll`), same as `handleSerialInput()` does.
- A remote command layer (`handleWifiCommands()` + the `remote*` functions)
  that makes webapp buttons actually move the motors - previously this was
  logged only.
- **Exercise mode**: `select_motor` -> `start_exercise` (pretension fixed at
  5N, no longer typed) -> motor calibrates and **halts** at `AWAIT_FORCE`
  ("Ready") -> `begin_exercise` (sent by the "Begin exercise" button) applies
  the real training-weight target and starts the continuous force hold. This
  two-step gating (halt-then-confirm) was the most recent change - see §3.
- **Assessment mode**: `start_assessment` runs the whole A-then-B sequence
  itself (calibrate+brake motor A at a fixed 1kg/9.81N load, hold 5s, then
  motor B, then done) - no further commands needed mid-sequence.
- **Manual jog**: `twist`/`untwist`/`jog_stop`, raw PWM via `setMotor()`,
  only active right after `select_motor` (state `SELECT_MODE`) so nothing
  else is fighting for the motor.
- **Motor mapping** (must match the webapp's `EXERCISES` array): **motor A =
  hamstring curl, motor B = knee extension**. This was flipped partway
  through the session - if anything ever looks backwards, check both
  `EXERCISES` in `useActuationSession.js` and `stateName()`'s
  `assessing_curl`/`assessing_knee_extension` labels agree.
- Telemetry (`sendTelemetryIfDue()`, UDP :5007, 200ms/5Hz) sends
  `active->force` (real strain gauge reading, not the old encoder-position
  placeholder) as `tension_n`, plus a `stateName()` string covering both the
  raw serial state machine and exercise/assessment progress.
- `printMotorActivityIfDue()` - Serial prints every 500ms, only while
  `active->controlSignal != 0`, showing which motor/signal/position/force.
  Purely observational, added for debugging (see §4).

**Backend** (`webapp/backend/`):

- `sessions.py`: session logging + next-weight recommendation (unchanged
  logic from before this session, still pure kg-progression, no exercise
  awareness), clinician remarks (`session_remarks` table, append-only), and
  the assessment-enabled toggle - **now SQLite-backed** (`app_settings`
  table) after it kept getting silently wiped by backend restarts during dev
  (was in-memory). The pending recommendation (`_pending`) is still
  in-memory only and still gets wiped on every restart - that one's
  intentional (see the comment in `sessions.py`), just know that after any
  restart you'll need to re-run a session before the Recommendation card
  reappears.
- New endpoints: `POST /api/actuation/session/remark`,
  `GET /api/actuation/session/{id}/remarks`,
  `POST /api/actuation/assessment/enable`.
- `actuationAssessmentEnabled` rides along in the existing WebSocket
  snapshot next to `actuationRecommendation`.

**Frontend** (`webapp/frontend/src/`):

- `useActuationSession.js` holds all the session/exercise/assessment state
  and command-sending; `ActuationPanel.jsx` is the view. Telemetry unit
  conversion happens **once**, at the point `tension` is read from `m`
  (`actuationTension / 9.81` -> kg), so every existing kg-based comparison
  downstream (target matching, chart, DB columns) keeps working without
  needing a conversion at each call site. Outbound, kg is converted to N the
  same way (`level * 9.81`) before being sent as `start_exercise`'s value.
- Session Data card, Resistive Training card (renamed from "Session"),
  System Recommendation card (renamed from "Next-weight recommendation"),
  independent Assessment card (clinician toggle / patient Start Assessment -
  deliberately NOT nested under the recommendation card, see §4 history),
  Manual Control with a motor selector (labelled "Motor A"/"Motor B",
  defaults to whatever exercise was last picked, still overridable), a big
  circular Stop (red)/End Session (green) button pair, and a rep counter
  (`Reps: X / Y` during "Exercise in progress") sourced from
  `useMetrics.js`'s `repsR` (right knee only - **this hardware is right-leg
  only**, confirmed by the user) via a baseline captured at
  `beginExercise()`, not the Gait tab's lifetime total.
- The floating widget (`ActuationFloatingWidget.jsx`, shown on other tabs)
  also surfaces an approved recommendation while idle, not just while a
  session is actively running.

---

## 2. What's NOT yet flashed to the board

The **most recent firmware change** (§1's "halt-then-confirm" exercise-mode
gating, plus the dead-code cleanup in the header comment) is built and
compiles clean but **failed to flash** - COM16 was locked by something else
(most likely a Serial Monitor tab left open). The webapp side of that change
(sending `begin_exercise`, and switching "Ready" detection to watch
`boardState === 'await_force'` instead of a tension threshold) IS already
built and deployed on the webapp.

**This means right now there's a real mismatch**: the webapp expects the new
halt-then-confirm behavior, but the board is still running the *previous*
firmware, which auto-applies the training weight immediately after
calibration (no halt). Practically: "Ready" may not trigger correctly, or
"Begin exercise" may appear to do nothing, until this is reflashed.

**To resume:** close whatever has COM16 open, then:
```
cd actuation/Firmware
C:\Users\chain\.platformio\penv\Scripts\pio.exe run -e angle_pid_wifi_test -t upload --upload-port COM16
```
(Port may differ by session/USB port - check `[System.IO.Ports.SerialPort]::GetPortNames()` in PowerShell if COM16 isn't right.)

---

## 3. Open issue: Untwist not responding

Mid-debug, unresolved. Confirmed so far:
- The `untwist` command **does** arrive over WiFi (`# CMD RX ... "actuation,untwist,1"` prints).
- Full hardware (motor + driver + encoder + strain gauge) is wired, not just the bench sensor-only rig from earlier.
- The firmware logic itself (`remoteJog()`, `setMotor()`, the dispatch table) was reviewed and is symmetric for both directions - no obvious code bug found by inspection.

**Next diagnostic step** (asked, not yet answered): while holding Untwist,
does the periodic `# motor X driving signal=...` print (added for exactly
this, see §1) show a **negative** signal value?
- If yes -> firmware is doing its job; the problem is downstream (wiring,
  driver channel, or a mechanical limit like the string already being fully
  unwound).
- If no -> real firmware bug, needs more digging.

---

## 4. Notable decisions/history worth knowing

- **kg -> N conversion**: webapp force values are real physics now (×9.81
  both directions), not the old "kg passed straight through as if it were N"
  convention. Decided explicitly, not a silent default.
- **Assessment mode is separate from the weight recommendation** - two
  different features that happen to both live near the Recommendation card.
  Early on, the assessment toggle + patient button were accidentally nested
  inside `{rec && (...)}`, so they vanished whenever there was no pending
  recommendation (i.e. after every backend restart). Fixed by pulling them
  into their own independent card - if assessment ever "disappears" again,
  check this hasn't regressed.
- **`lastControlMicros` bug** in the original `angle_pid_test_manual.cpp`
  (pre-calibration-rewrite) was flagged once, then fixed upstream by
  whoever wrote the calibration rewrite (now uses `CONTROL_INTERVAL_US`
  properly) - not something carried into this file as a live bug.
- **`ACTUATION_PANEL_TODO.md` is stale in a couple of places** now: its
  "Manual Control - Twist/Untwist ... currently logged-only, not acted on"
  line is wrong (jog is now mapped, see §1), and its "Begin exercise ...
  no `sendCmd()` call, no code change needed" line is also wrong as of §1's
  gating change (it now sends `begin_exercise`). Left as-is rather than
  rewritten, since this file is the more current source of truth going
  forward - flag if you want that doc cleaned up too.
- Manual Control's **jog is intentionally still separate from exercise
  selection** - it has its own motor picker that just defaults/syncs to
  whatever exercise was last chosen.

---

## 5. Quick-reference: webapp -> firmware commands

| Command | Sent by | Effect |
|---|---|---|
| `select_motor` (0/1) | exercise picker (auto), Manual Control's motor picker | Sets `active` motor. 0=A(curl), 1=B(knee extension). |
| `start_exercise` (N) | "Start session", after countdown | Calibrates to fixed 5N pretension, then **halts** (as of the not-yet-flashed change). |
| `begin_exercise` | "Begin exercise" button | Applies the queued training weight, starts force-hold. No-op unless calibration actually finished. |
| `start_assessment` | patient's "Start Assessment" | Runs the whole A->B sequence automatically. |
| `twist` / `untwist` (held, repeating) | Manual Control jog buttons | Raw PWM jog - only works right after `select_motor`. |
| `jog_stop` | releasing jog buttons | Halts movement, keeps motor selected. |
| `stop` | Force Stop (both places) | Full abort - brakes, deselects, resets any in-progress flow. |

## 6. Running everything locally

```
# backend (from repo root pass/, venv already set up in .venv)
../.venv/Scripts/python -m uvicorn webapp.backend.main:app --host 0.0.0.0 --port 8000

# frontend, after any change under webapp/frontend/src
cd webapp/frontend && node node_modules/vite/bin/vite.js build
# then restart the backend above - it only picks up dist/ at process start
```
Laptop running the backend must be on `TP-Link_1285` (same LAN as the board)
for live telemetry/commands to work; `localhost:8000` works regardless of
network for viewing the UI itself.
