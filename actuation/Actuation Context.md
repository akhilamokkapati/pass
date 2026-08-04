# PASS - Patient Assessment Sensing System (Actuation Module)

Project context for Claude Code. **Read this first.**

**Scope of this file:** TSA (twisted string actuator) resistive actuation
track only, up to the point of PID tuning. Not covering sensing/dashboard
subsystems outside this.

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
| MCU | XIAO ESP32-S3 | Wireless not yet added (needs ADC2->ADC1 migration, GPIO1-10, to avoid WiFi/BLE conflict) |
| Force sensing | Strain gauge + HX711, bridge completed with 3 fixed resistors (quarter-bridge) | Reverted back to HX711 (dedicated 24-bit ADC over a DT/SCK digital interface) after an analog Wheatstone-bridge-amp-module approach didn't pan out; no trimpot - gain is set in software (HX711 library default: channel A, gain 128). **One gauge + one HX711 per motor** (not shared via A/B channels - costs resolution/update rate, and antagonistic pair needs independent tension readings per string). See §7. |

**Earlier bench rig (795 brushed DC + BTS7960B + Arduino Uno):** used for
early firmware iteration (hold-based control, soft-start ramp, IS-pin
overcurrent monitoring, ADC noise mitigation via 8-sample averaging). See
`Firmware/prototyping/bts7960b_test.cpp` (renamed from `twist_untwist.cpp`).
Surfaced the **motor back-drivability problem**: 795 motor unwinds under
passive load - a gearbox/mechanical passivity issue, not a torque rating
issue. Two candidate fixes (powered/braked hold vs. mechanical self-locking
element) - **unresolved, not yet decided.**

**Current bench test files (`Firmware/prototyping/`):**
- `bts7960b_test.cpp` - BTS7960B + 795 motor, hold-to-run buttons, IS-pin
  current sensing (the earlier bench rig above).
- `drv8833_encoder_test.cpp` - DRV8833, single motor + quadrature hall
  encoder (position tracking), hold-to-run buttons.
- `drv8833_test.cpp` - DRV8833, single motor only, no encoder - for testing
  additional motor candidates without needing an encoder wired.
- `strain_gauge_test.cpp` / `strain_gauge_teleplot.cpp` - HX711 raw-reading
  bring-up, identical except the latter formats output for the Teleplot
  VS Code extension (`>strain:value`). Raw HX711 counts only so far - no
  tare or calibration factor applied yet.
- `pid_learning_test.cpp` - the mocked/simulated PID architecture test,
  see §5. **Separate track from the physical HX711 bring-up above** - the
  PID test's simulated tension has not yet been wired to a real sensor
  reading; that integration is still to come.

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

## 5. Immediate goal

Not building the full implementation yet. Current intent: a **quick test to
learn the architecture** -

- Get a minimal PID loop running on the XIAO ESP32-S3: strain gauge read
  (HX711) -> error calc -> PID -> PWM output -> DRV8833 or DRV8874
- Purpose is to understand how the pieces fit together in code (loop timing,
  ADC read, driver control), not to hit final tuned performance
- Treat section 2 (design parameters) and section 4 (block diagram) as
  background/reference only - most of those values are still in flux and
  shouldn't constrain this test
- Motor: whatever's on hand from the 6-12V candidates being screened; not
  motor-specific yet

**Decided for the first pass (see `Firmware/prototyping/pid_learning_test.cpp`):**
no hardware is wired yet, so the strain gauge input is mocked/simulated
first, isolating PID library mechanics from hardware integration. Motor
output is behind a driver-agnostic `setMotor(signed_pwm)` seam since
DRV8833 vs DRV8874 isn't decided. Library: classic `br3ttb/PID`.

---

## 6. How to respond (tone and structure)

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

## 7. Future: antagonistic dual-motor architecture (not current scope)

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
