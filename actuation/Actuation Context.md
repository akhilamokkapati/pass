# PASS - Patient Assessment Sensing System (Actuation Module)

Project context for Claude Code. **Read this first.**

**Scope of this file:** TSA (twisted string actuator) resistive actuation
track only, up to the point of PID tuning. Not covering sensing/dashboard
subsystems outside this. For the actuation dashboard panel's UI/UX backlog,
see `../webapp/ACTUATION_PANEL_TODO.md`.

## What this is

PASS is a modular lower-limb wearable knee rehab/strength-training
exoskeleton. North star: give physios continuous, objective insight into
patient recovery, and guide patients to exercise correctly at home.

Course: SUTD 30.007 Engineering Design Innovation. Team: 01 Super Strokers.
This repo is the **actuation module** - assistive actuation + load-cell
force/strength measurement, covering the force/load side of the platform
that the knee IMU module cannot provide on its own. See `../knee/` for the
kinematics side.

---

## 1. Hardware - current TSA build

| Component | Part | Notes |
|---|---|---|
| Motor | Under evaluation - testing a range of 6-12V motors | No single motor locked in yet; candidates being screened against TSA torque/speed operating point |
| Motor drivers under test | DRV8833, DRV8874 | DRV8874 has IPROPI current sense (usable as secondary/faster tension proxy vs strain gauge) |
| Position feedback | AS5047P magnetic encoder (final part, not yet bench-tested) | Motor angle -> string contraction -> joint angle. Commutation-feedback role dropped now that motors are brushed DC (no FOC); retained for position/contraction tracking. Bench encoder testing so far (see below) used a generic 2-channel hall quadrature module bundled with the geared test motors, not the AS5047P itself |
| MCU | XIAO ESP32-S3 | WiFi bring-up demonstrated (`wifi_led_test.cpp`, joins `TP-Link_1285`) but not yet integrated into `actuation_master.cpp` - still needs the ADC2->ADC1 migration consideration (GPIO1-10) if analog reads are ever added alongside WiFi |
| Force sensing | Strain gauge load cell (full bridge, 4 active gauges) + HX711 | Reverted back to HX711 (dedicated 24-bit ADC over a DT/SCK digital interface) after an analog Wheatstone-bridge-amp-module approach didn't pan out; no trimpot - gain is set in software (HX711 library default: channel A, gain 128). Full bridge (not a DIY quarter-bridge with fixed resistors) - close to ideally linear and self-compensates for temperature drift. **One gauge + one HX711 per motor** (not shared via A/B channels - costs resolution/update rate, and antagonistic pair needs independent tension readings per string). See §9. |

**Earlier bench rig (795 brushed DC + BTS7960B + Arduino Uno):** used for
early firmware iteration (hold-based control, soft-start ramp, IS-pin
overcurrent monitoring, ADC noise mitigation via 8-sample averaging). See
`Firmware/prototyping/bts7960b_test.cpp` (renamed from `twist_untwist.cpp`).
Surfaced the **motor back-drivability problem**: 795 motor unwinds under
passive load - a gearbox/mechanical passivity issue, not a torque rating
issue. Two candidate fixes (powered/braked hold vs. mechanical self-locking
element) - **unresolved, not yet decided.**

**Current integrated bench build:** all bring-up has now merged onto one
physical circuit - XIAO ESP32-S3 + 1x DRV8833 (both motor channels) + 2x
HX711 (one strain gauge per motor) + reserved pins for 2 quadrature
encoders (ordered, not yet arrived). Powered by LiPo + switch - no physical
buttons anymore, all control is via Serial. See
`Firmware/prototyping/actuation_master.cpp`, the integration file that
supersedes the single-component test files below for anything spanning more
than one subsystem at once.

Pin mapping (all 11 of the XIAO's D0-D10 pins are used - no spares left):

| Signal | Pin |
|---|---|
| Motor 1 (DRV8833 A): AIN1 / AIN2 | D1 / D0 |
| Motor 2 (DRV8833 B): BIN1 / BIN2 | D3 / D4 |
| Motor 1 encoder: C1 / C2 | D5 / D6 |
| Motor 2 encoder: C3 / C4 | D2 / D7 |
| Strain gauge 1 (HX711 #1) DT | D9 |
| Strain gauge 2 (HX711 #2) DT | D8 |
| HX711 SCK (shared by both chips) | D10 |

Both HX711s share one SCK pin with separate DT pins (saves a GPIO). Reading
them as two independent `HX711::read()` calls doesn't work - A's clock
pulses also hit B's shift register if B is ready at the same time, forcing
B into a fresh conversion before its value is ever collected (this is why
`strainB` looked flat/dead on the plotter while `strainA` updated fine).
Fixed via a manual `readBothScales()` in `actuation_master.cpp` that
bit-bangs the shared SCK line once and samples both DT pins on every pulse.

XIAO ESP32-S3 also has a separate onboard red charge-status LED - purely
hardware-driven by the board's charge-management chip, not GPIO-exposed or
firmware-readable, and single-color (no green). Behavior: solid red
briefly when USB-C is plugged with no battery (off after ~30s), blinking
red while actually charging, off when the battery is fully charged. There
is also a separate user-programmable amber LED on GPIO21 (`LED_BUILTIN`,
active-low) if a firmware-driven indicator is ever wanted - unused
currently, and not wired to any real battery/charge signal.

Control model: no hold-to-run buttons anymore. `actuation_master.cpp` uses
toggle-on-keypress Serial control instead - `w`/`s` start the two motors in
opposite (antagonistic) directions and keep running until told otherwise,
`x` stops both. Reversing directly between `w`/`s` was spiking the buck
converter (instant full-forward-to-full-reverse duty fights the outgoing
direction's back-EMF) - fixed with a coast-then-jump: reversal now coasts
both pins to 0 for `DIRECTION_CHANGE_STOP_MS` (currently 400ms) before
applying the new direction, at `MAX_DUTY` (currently 130, down from the
default 255 - both tuned empirically against the buck converter, not
derived). Stand-in for the eventual app-driven control; exercises the same
setpoint-sign-flip relationship documented in §9 for the future PID
torque/co-contraction mapping.

**A second physical board (XIAO ESP32-C3) is now also in use**, separate
from the S3 rig above - COM10 is the S3, COM14 is the C3. The C3 has its
own single strain gauge wired (HX711 DT=D0, SCK=D1) and, as of
`actuation_mini.cpp`, its own single motor (AIN1=D2, AIN2=D3) and encoder
(C1=D4, C2=D5) - a deliberately smaller single-motor/single-encoder/
single-gauge rig for PID/cascade experimentation, kept separate from the
2-motor S3 rig so the two don't have to be reflashed back and forth.

**Current bench test files (`Firmware/prototyping/`):**
- `bts7960b_test.cpp` - BTS7960B + 795 motor, hold-to-run buttons, IS-pin
  current sensing (the earlier bench rig above).
- `drv8833_encoder_test.cpp` - DRV8833, single motor + quadrature hall
  encoder (position tracking), hold-to-run buttons.
- `drv8833_test.cpp` - DRV8833, single motor only, no encoder.
- `strain_gauge_plot.cpp` / `strain_gauge_plot_c3.cpp` - HX711 raw-reading
  bring-up, plotter-formatted output (`>strain:value`, works with Teleplot
  and the badlogic serial-plotter VS Code extension), S3 and C3 boards
  respectively. Raw counts only, no calibration applied. An LM358
  analog-bridge-amp alternative was tried and reverted - staying on HX711.
- `strain_gauge_calibration.cpp` / `strain_gauge_calibration_c3.cpp` -
  calibration tool, S3 and C3. Rewritten from the original single-weight
  nudge-to-match approach to a **multi-point least-squares fit**: tare
  once, capture several known weights (type the weight in kg + Enter),
  `f` fits a line across all points and prints the scale factor plus a
  `weight,measured,fitted,residual` CSV table (also every capture prints
  a plain CSV row) for graphing against theoretical behaviour. See the
  calibration findings below - the fit is not currently trustworthy across
  the full range.
- `actuation_master.cpp` - the integrated 2-motor/2-strain-gauge test on
  the S3, described above; current focus for the 2-motor rig.
- `wifi_led_test.cpp` - S3, joins `TP-Link_1285` and drives the onboard
  GPIO21 user LED as a status indicator (blink while searching, solid once
  joined) - bring-up only, not yet folded into `actuation_master.cpp`.
- `actuation_mini.cpp` - the C3's single-motor/encoder/gauge cascade rig,
  see §5. Current focus for closed-loop control work.
- `angle_pid_test.cpp` - C3, same motor/encoder pins as `actuation_mini.cpp`
  (AIN1/AIN2=D2/D3, encoder C1/C2=D4/D5) but **isolates just the inner
  angle PID -> motor loop** - no outer force loop, no strain gauge at all.
  Type a target angle directly (encoder counts) + Enter, `z` zeroes the
  encoder position for a repeatable reference point, `x` stops. Exists
  because tuning `Kp`/`Ki`/`Kd` inside `actuation_mini.cpp` meant fighting
  a target that the outer loop kept moving - this gives a real, held-still
  target to tune against. **`pid_learning_test.cpp` was deleted** (it was
  an open-loop PWM->angle step-response characterization test on the S3's
  Motor A/Encoder 1) - that step-response approach no longer exists
  anywhere in the project; `angle_pid_test.cpp` is a different tool
  (closed-loop tuning against a held target, not open-loop plant
  characterization) and doesn't replace it like-for-like.

---

## 2. TSA design parameters (mostly tentative - only 3 values confirmed)

**Confirmed/locked:**

| Parameter | Value |
|---|---|
| Target force range | 50-150 N (functional), 5-20 kg patient-facing setting |
| String (prototype + final) | BCY Halo, radius 0.021 mm |
| Normalized string stiffness | 9000 N |

**Everything else below is tentative / still being worked out - treat as
reference, not spec:**

| Parameter | Value |
|---|---|
| String length | 0.4 m |
| Contraction range | 0.08 m |
| Contraction time | 0.7 s |
| Payload mass | 4.5 kg |
| Peak motor torque (derived) | 16.37 mN·m |
| Peak motor speed (derived) | 6,066 RPM |

Sized using Bombara et al. (2023) inverse-modelling GUI
(TSA-Design-Algorithm-GUI, MATLAB). Operating point check:
`τ_req/τ_stall + τ_req/τ_no-load < 1`. Note: tentative values above were
derived alongside the now-dropped Nanotec/BLDC setup and likely need rework
for the new motor candidates.

---

## 3. Confirmed operational flow (this is the control spec)

1. User selects target force level (5-20 kg) -> system converts to required
   string tension.
2. Motor twists string until target tension is reached, then holds - patient
   not yet moving.
3. Patient begins exercise (knee flexion/extension against the tensioned
   string).
4. Strain gauge continuously monitors tension.
5. Motor twists/untwists as needed to hold tension constant as patient moves.
6. End of exercise.

**This is force/tension regulation, not position control.** Setpoint =
tension. Feedback = strain gauge reading. Output = bidirectional motor
command (twist to add tension, untwist to release).

Two distinct control phases identified:
- **Phase 1 (steps 2-3, ramp to setpoint):** step-response behavior.
  Priority: fast rise, minimal overshoot (overshoot here = over-tensioning
  before patient is ready - safety issue, not just performance).
- **Phase 2 (steps 4-5, hold during exercise):** disturbance rejection.
  Patient's motion actively perturbs tension; loop must reject this without
  inducing oscillation.
- **Open question:** whether gain scheduling or integrator reset is needed at
  the Phase 1->2 transition to avoid windup-driven overshoot right as
  exercise starts.

---

## 4. Control structure - work in progress, reference only (not final)

Standard closed-loop PID, discrete (runs as a loop on MCU, not continuous
math):

```
output = Kp*error + Ki*∫error dt + Kd*(d(error)/dt)
error = target_tension - measured_tension
```

Block diagram (closed loop) - **still being worked out, included here as a
conceptual reference, not a finalized architecture:**
`Setpoint -> Σ -> C(s) [PID] -> G(s) [motor + driver + TSA mechanics] ->
Y(s) [tension output] -> H(s) [strain gauge + amp] -> feeds back negatively
into Σ`

- **C(s)** - the controller, `Kp + Ki/s + Kd·s`. This is a design choice
  (gains), fully in our control.
- **G(s)** - the plant (motor + driver + string mechanics). **Not yet
  characterized.** Need to derive/estimate this (datasheet-based or
  empirical step response) before gain tuning is anything more than
  trial-and-error. Note: G(s) never gets encoded into the firmware itself -
  PID is model-free (`Compute()` only ever sees `error`). G(s) is used
  offline (by hand, MATLAB, or empirical step-response + a tuning rule like
  Ziegler-Nichols) to derive three numbers - `Kp`, `Ki`, `Kd` - which is all
  that actually lands in code.
- **H(s)** - sensor dynamics (strain gauge + amp). Likely near-flat gain if
  sensor bandwidth >> control loop bandwidth, but not yet confirmed.

**Key unresolved items before/during PID implementation:**
- Plant transfer function G(s) unknown - motor + driver + TSA not yet
  characterized as a unit.
- Direction/sign handling: error can be + or - (twist vs. untwist), output
  must map to bidirectional H-bridge control on DRV8833/DRV8874, not just
  PWM magnitude.
- Anti-windup handling at Phase 1->2 transition (safety-relevant).
- Strain gauge needs tare + a calibration factor (HX711 `tare()` /
  `set_scale()`/`get_units()`) mapping raw counts to the actual 50-150N
  range before PID tuning starts - not yet done, currently reading raw
  uncalibrated counts.
- Motor/driver candidates still being tested - final gains will be
  motor-specific, loop architecture will not.

---

## 5. Cascade control architecture (outer force / inner angle)

A newer, alternative architecture to §4's single-loop design, explored on
the C3 rig (`actuation_mini.cpp`). Block diagram (outer force loop feeding
an inner angle loop, not a single PID from force error straight to motor):

`F_d -> Σ -> Inverse SSTSA Model [1/(k_s·J(θ_0))] -> Δθ -> Σ (+θ_0) -> θ_d
-> Σ -> Angular Position PID -> Motor Plant -> θ_o -> SSTSA Model -> F_o`,
encoder feedback closes the inner (angle) loop, load-cell feedback closes
the outer (force) loop.

**Rationale:** PWM->force directly (§4's `G(s)`) is a hard combined
identification problem - motor electrical dynamics *and* the string's
nonlinear force-vs-twist relationship, lumped into one unknown. Splitting
it lets each half be characterized separately: PWM->angle is a
well-documented DC-motor position-servo problem, and angle->force is
governed by the *already-known* string stiffness (`k_s = 9000N`), just
needing the SSTSA's forward force-vs-angle formula to derive `J(θ_0)` (its
local sensitivity at the chosen operating point) - still not derived (see
end of this section for the analytical approach and why it's unverified).

**Implemented in `actuation_mini.cpp` - structure only, not real physics
yet:**
- Outer loop: `forceSetpoint - measuredForce -> INVERSE_SSTSA_GAIN
  (a single lumped placeholder, NOT derived from k_s/J(θ_0)) ->
  angleSetpoint`. Runs on its own slower timer (`OUTER_UPDATE_INTERVAL_MS`,
  200ms) - see the oscillation note below for why.
- Inner loop: `angleSetpoint - encoder position -> PID -> motor PWM`, every
  fast `loop()` pass. Angle stays in raw encoder counts throughout (no
  counts-per-revolution figure exists), so `INVERSE_SSTSA_GAIN` is in
  counts/N, not physically meaningful units.
- No pretension term in this pass (`F_d` = the typed setpoint directly, no
  `F_t + F_0` split) and no pretwist reference (`θ_0` = wherever the
  encoder starts counting at boot).
- Setpoint is **typed in kg**, converted to N internally
  (`forceSetpoint = kg * GRAVITY`) - everything downstream stays in N.
- **Manual control mode added**, since the first stall/oscillation
  debugging needed a way to jog the motor directly: `x` stops loop control
  and drops into manual (also a real instant stop - zeroes the motor
  immediately, unlike the original `x` which only retargeted to 0 and let
  the PID coast down), `q`/`w` jog twist/untwist at `MAX_DUTY` with no PID
  involved, `s` returns to loop control (resets `forceSetpoint` to 0 rather
  than silently resuming a stale target). `t` tares on demand.
- **Sign conventions still unverified** - whether a positive angle setpoint
  (or `q`/`w` in manual mode) actually commands the tension-adding twist
  direction depends on the encoder's wiring matching the motor's forward
  direction; neither has been checked against the other.

**Debugging so far (all on the C3 rig):**
1. At `MAX_DUTY=100`, the motor hummed but didn't turn - `output` was
   pinned at max with zero encoder response, ambiguous between a real
   stall and a disconnected encoder (never conclusively resolved before
   moving on).
2. Raised `MAX_DUTY` to 180 and dropped `Kp` to 0.5 - motor started moving,
   but with a **sustained oscillation that never converged** even at a
   fixed setpoint (measured force swinging roughly ±30N around a 9.81N
   target, indefinitely). Root cause: `INVERSE_SSTSA_GAIN` was 130 -
   amplifying routine force noise into huge `angleSetpoint` swings - and
   the outer loop recalculated that target on *every* fast `loop()` pass
   with no smoothing, so the inner PID was chasing a target that never
   held still (a cascade needs the outer loop to run slower than the
   inner loop; it wasn't).
3. Fix applied: `INVERSE_SSTSA_GAIN` cut 130->10, outer loop moved to its
   own 200ms timer (separate from the inner loop's fast cycle), force
   reading smoothed (`get_units(1)` -> `get_units(5)`, `FORCE_READ_SAMPLES`).
   **Not yet verified working** - this was the last change made before
   pausing; confirming it actually converges (and checking the sign
   convention while at it) is the immediate next step.

**Deriving `J(θ_0)` for real** (still outstanding): standard TSA kinematic
model, `L(θ) = √(L0² − r²θ²)` (`L0` = untwisted string length, `r` = the
twisted bundle's radius - **not** the 0.021mm string material radius from
§2, a different number entirely). Treating the load end as fixed,
`F(θ) ≈ k_s(1 − L(θ)/L0)`, giving `J(θ_0) = dF/dθ|θ0 = k_s·r²·θ_0 /
(L0·L(θ_0))`. Two unresolved inputs before this is trustworthy: the actual
`r` (bundle geometry, not yet measured) and confirming `k_s`'s exact
normalization against the Bombara et al. GUI/paper (§2's source) rather
than assuming this derivation's convention matches theirs. An empirical
alternative (measure F vs. small commanded θ steps directly, take the
local slope) was discussed as possibly more trustworthy than chasing the
exact analytical formula - not yet attempted either.

---

## 6. Calibration findings - toe region + a high-load anomaly

Multiple calibration sweeps on the C3's gauge
(`Firmware/data/calibration_run1.csv` through `run3.csv`,
`calibration_all_runs.csv`) surfaced two real, repeatable nonlinearities -
**a single linear scale factor across the full 0-13kg range does not
hold:**

- **Low-weight "toe region" (~0-3kg):** residuals are large and change
  sign across this range (a real, systematic curve, not noise) -
  consistent with the fabric-strap mounting (straps tie the plate to the
  frame and to the weights, whole rig hangs from a bar). Woven webbing
  isn't dimensionally stable at low tension - early load goes partly into
  straightening the weave/removing slack rather than fully reaching the
  plate, and the effective loading angle can still be settling too.
  Confirmed repeatable (not measurement noise) via a same-weight repeat
  check.
  - **Design implication:** since this same strap mounting carries over to
    the real rig, the toe region isn't just a calibration-test artifact -
    pretension (`F_0`, when reintroduced to §5's cascade) needs to sit
    above this threshold, or the outer loop's force error/inverse-model
    gain will be operating somewhere the relationship isn't linear.
    Threshold not yet located precisely - needs a dedicated fine sweep
    (~0.5kg steps from near-zero) to find where the local slope
    (Δreading/Δweight between close-spaced points) stops rising and
    plateaus.
  - Shorter strap length was reasoned to reduce this (less sag to pull
    straight before the strap is fully taut) - worth carrying into the
    eventual mechanical design.
- **High-load anomaly (~10-13kg):** the fitted line matches well from
  ~3-10kg, but readings plateau between 10.2-12.1kg then drop sharply at
  13.1kg. Leading hypothesis (not yet confirmed): uneven/off-axis loading
  on the plate causing local bending strain, not gauge saturation - the
  gauge's own strain rating (20,000µm/m = 2%) is far higher than a cleanly
  axial-loaded plate should ever reach at this force, but bending
  concentrates much higher local strain than axial loading for the same
  force, so an imbalanced load could explain anomalous behaviour at a
  total weight that isn't extreme on paper. Needs a retest with the load
  kept carefully centered to confirm.
- **Gauge is a full bridge** (see §1 hardware table - corrected from an
  earlier quarter-bridge assumption), spec'd at: 350Ω resistance, gauge
  factor 2.11±1%, 20,000µm/m strain limit, -20°C to +80°C rated.
- **Practical takeaway for the next calibration pass:** don't fit one line
  across the whole range. Calibrate using known weights concentrated
  within the real 5-20kg operating band (past the toe, hopefully below the
  high-load anomaly), with the load kept centered/balanced.
  `actuation_mini.cpp`'s current `SCALE_FACTOR` is a practice placeholder
  from the messy full-range sweep, explicitly not trustworthy.

---

## 7. Immediate goal

Both rigs are past the "wire nothing, mock everything" stage - the goal
now is characterizing and closing the loop for real, not simulating it:

- **S3 rig (`actuation_master.cpp`):** 2-motor/2-strain-gauge integration
  bring-up is working (shared-SCK strain read fixed, reversal-safety
  tuned). No PID work is happening on this rig currently - that moved to
  the C3.
- **C3 rig - two firmware files now, different jobs:**
  - `actuation_mini.cpp`: the full cascade (§5). Just went through an
    oscillation debugging pass (gain cut, outer loop slowed relative to
    inner loop, force reading smoothed) - **not yet confirmed working**,
    that's the first thing to check next session. Sign convention
    (`q`/`w` manual jog, or a small setpoint) still needs verifying too.
  - `angle_pid_test.cpp`: isolates just the inner angle-PID/motor loop
    (no outer loop, no strain gauge) for tuning `Kp`/`Ki`/`Kd` against a
    directly-typed, held-still target - **built but not yet flashed or
    tested.**
  - The calibration `SCALE_FACTOR` in `actuation_mini.cpp` is still the
    practice placeholder from the messy full-range sweep (§6) - redo
    calibration within the real 5-20kg operating band before trusting any
    force numbers.
- Motor: whatever's on hand from the 6-12V candidates being screened; not
  motor-specific yet. Library: classic `br3ttb/PID`.

---

## 8. How to respond (tone and structure)

- **Semi-technical, beginner-accessible.** Assume I know engineering
  fundamentals but not this specific stack. Explain unfamiliar concepts as
  they come up, don't assume prior exposure.
- **Show the thought process, not just the answer.** For each implementation
  choice, briefly explain *why* - what alternatives existed, why this one was
  picked. The goal is for me to learn the reasoning, not just receive working
  code.
- **Teach for next time.** Structure explanations so I could redo this
  myself end-to-end without help next time - flag the general principle
  behind a decision, not just the specific fix.
- Concise overview first, then detail. Bullets/tables over long paragraphs.

---

## 9. Future: antagonistic dual-motor architecture (not current scope)

Not part of the confirmed spec (section 3) yet - single-actuator tension
regulation is the current target. Captured here for when a second motor
(antagonistic string pair, e.g. flex/extend muscle-pair layout) comes up:

- **Sensing architecture (confirmed):** both motors will be housed on the
  same mounting piece per leg, but each still gets its own strain gauge +
  own HX711 - **2 gauges + 2 HX711s per leg.** Sharing a mounting piece is a
  mechanical detail; it doesn't change the sensing requirement. Independent
  per-motor tension readings are required because the two PID loops below
  need separate `measuredTensionA`/`measuredTensionB` - a combined/shared
  reading would make it impossible to tell which motor is over/under-
  tensioned. Open mechanical question (not yet resolved): exact gauge
  bonding location on each string's force path, so each gauge picks up only
  its own string's force and not cross-talk from the other motor through
  the shared structure.
- **Separate `PID` instance per motor** (own `Input`/`Output`/`Setpoint`,
  gains can differ per side if the two are mechanically asymmetric) - not
  one shared PID trying to do both.
- **But the two setpoints must come from a shared mapping, not be chosen
  independently**, or the two loops can fight (both raising tension
  "successfully" from their own point of view, wasting energy/over-stiffening
  the joint). Standard approach: a higher-level `desiredJointTorque` +
  `desiredCoContraction` (stiffness) command, converted to per-motor tension
  setpoints each loop, e.g. `SetpointA = coContraction + torque/2`,
  `SetpointB = coContraction - torque/2`, clipped at 0 (a string can only
  pull, not push).
- The PID mechanics themselves (SetOutputLimits, Compute() timing, etc.)
  don't change - only the setpoint-generation layer above the two PID
  instances is new.
