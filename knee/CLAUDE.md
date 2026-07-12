# PASS - Patient Assessment Sensing System (Knee Module)

Project context for Claude Code. **Read this first**, then read
`biomechanics/quaternion_math.py` and `test_quaternion_math.py` before writing code.

## What this is

PASS is a modular lower-limb wearable that makes physiotherapy quantitative -
capturing objective knee kinematics for stroke rehabilitation, giving patients
real-time feedback, and generating clinically useful data for physiotherapists.
This repo is the **knee module**, which I own as the sole software person.

Course: SUTD 30.007 Engineering Design Innovation. Team: 01 Super Strokers.
The other 7 members handle actuation, feet (FSRs), hip, and housing hardware.

## Timeline & standard

- **SDR (System Design Review): ~9 days out.** Needs a working knee subsystem
  demoed live + preliminary feasibility data + deeper modelling. Graded on
  Prototype (20%), Feasibility (20%), Modelling (20%) among others.
- **Final product demo: August.** This is NOT a throwaway prototype. Build
  **product-quality**: accurate, reliable, tested, documented. I want to be
  able to defend every number if a reviewer or physiotherapist questions it.

## How I want to work

- **One file at a time.** Explain the approach before writing, wait for me to
  confirm, then write. Do not dump multiple files at once.
- **I want to understand each file**, not just receive code. Teach as you go.
- **Test-first.** Every engine module gets known-answer tests (rotations whose
  answers we can hand-check) before we move on. Tests are the evidence the
  math is correct.
- Keep modules small, pure, and independently testable.

## Hardware

- Compute node: **Seeed XIAO ESP32-C3** (I have it now). The S3 is fine too;
  both use the same I2C pins (SDA=D4, SCL=D5). C3 is sufficient - but im still waiting for S3 as i ordered it.
- Sensors: **2x BNO085 IMU** (GY-BNO08X purple breakout), one on thigh, one on
  shank. Arriving in 1-3 days. Until then, develop against synthetic data.
- Power: **800mAh 3.7V LiPo** + JST connector + charging module. The XIAO C3 has
  onboard battery management (BAT pads, charges over USB-C), so the external
  charger may be redundant. ~10-20 h runtime - plenty.
- BNO085 notes: outputs **fused quaternions on-chip** (game rotation vector,
  w/x/y/z). So we do NOT run Madgwick on live data - the sensor already fused.
  I2C at 100 kHz (clock-stretching). Two addresses 0x4A / 0x4B via the ADO pin.
  Power 3.3V only. PS0/PS1 to GND to force I2C mode.
- Target accuracy: **knee flexion angle within +/-2.5 deg** (clinical requirement).

## What the KNEE MODULE actually measures (scope honestly)

Two IMUs on thigh + shank give a knee flexion angle signal. From ONLY that
signal, these are defensible and will be validated this term:

- **ROM** (range of motion) - core metric, quaternion-native, target +/-2.5 deg
- **Angular velocity** - derivative of the angle
- **Repetitions** - peak detection on the angle signal
- **Max flexion / max extension** - from the angle
- **Rep consistency** - variation across rep peaks

Do NOT claim these from the knee module alone (they need other modules):
- **Weight-bearing / loading** -> feet FSRs, not us
- **Muscle activity** -> EMG, not us (and optional anyway most probably not doing it)
- **Gait quality / gait phases** -> needs foot-contact events (heel strike / toe
  off) from the FEET module; a single knee IMU cannot give clean gait phases
- **Strength (as force/load)** -> needs the load cell / actuation side

The "full PASS platform" measures all of the above when knee + feet + hip +
actuation are integrated. This repo delivers the **validated knee subset**.
Keep that distinction - accurate scoping beats over-claiming, especially at review.

## Architecture - the core idea

A **data-source abstraction**: synthetic, serial (live sensor), and HuGaDB
(offline dataset) all expose the SAME interface and feed the SAME biomechanics
engine. Only the source changes; the engine never does.

Every source exposes:
- `stream()` -> yields packets one at a time (real-time path / live plot)
- `get_data(duration_s)` -> returns arrays (capture + offline analysis)

Packet schema (matches firmware + synthetic):
`seq, t_ms, knee_angle_deg, quat_thigh[4] (w,x,y,z), quat_shank[4] (w,x,y,z)`

Data flow:
`BNO085 -> XIAO -> serial/ESP-NOW -> receiver -> biomechanics engine -> metrics -> plot/dashboard`

## Engine design decisions (do NOT undo these)

- **Quaternion-native, not Euler.** Knee angle comes from quaternions via
  **swing-twist decomposition** to isolate PURE flexion about the knee's
  mediolateral axis. Do NOT fall back to pitch-subtraction (shank_pitch -
  thigh_pitch) - that's mounting-dependent and gimbal-prone. Accuracy is the
  whole reason we went quaternion-native.
- **Calibration = straight-leg zero.** Capture a quiet-standing quaternion,
  treat that relative orientation as 0 deg. Removes mounting offset correctly.
- **Library functions must not print.** Return values; let callers decide to
  print. (My old code printed inside engine functions - don't repeat that.)
- **One definition per metric.** My old repo defined ROM/cadence in multiple
  places with different formulas. Each metric lives in exactly one module here.
- **Live-path angle needs low-pass filtering before the +/-2.5 deg claim applies.**
  Raw per-sample noise on the BNO085 fused quaternions becomes per-sample
  knee-angle noise that can spike past +/-2.5 deg even when RMS is comfortably
  under it (see `run_capture --noise`: 2 deg input noise -> ~2 deg RMS but ~8 deg
  max on the raw signal). A low-pass filter on the angle signal (from
  `filters.py`, to be built) resolves this. So the `run_capture` error plot is a
  **diagnostic**, NOT a feasibility claim - the +/-2.5 deg accuracy statement is
  about the **filtered** live angle, not raw per-sample output.

## What's built and verified

All test-first with known-answer / property tests. Full suite: **100 passing**
(`.venv\Scripts\python -m pytest -q`). numpy/scipy/matplotlib/ahrs/pyserial live
in `.venv`, not the global `py`; pytest is installed in `.venv`.

Engine (`biomechanics/`, pure quaternion math):
- `quaternion_math.py` - primitives: normalize, conjugate, multiply, relative,
  angle_about_axis (swing-twist), to_euler_pitch. + `test_quaternion_math.py`.
- `relative_orientation.py` - knee_relative (thigh→shank), remove_offset
  (calibration application; identity neutral = passthrough), canonicalize
  (w≥0, kills sensor sign-flips). + `test_relative_orientation.py`.
- `joint_angles.py` - knee_flexion_angle(q_rel, axis=DEFAULT_FLEXION_AXIS): THE
  single flexion metric; sign convention (flexion positive) pinned here.
  + `test_joint_angles.py`.

Calibration - `calibrate.py`: straight-leg zero via Markley quaternion average
(sign-invariant); CalibrationResult carries a residual quality gate.
+ `test_calibrate.py`.

Axis calibration - `axis_calibration.py`: MEASURES the live flexion axis (the one
thing unknown until the sensors are mounted). Captures a straight-leg + a bent
pose, takes the axis of the between-pose rotation, with a single-axis confidence
score. Reuses calibrate + remove_offset. On HuGaDB it rediscovers ~[-0.18,-0.98,
-0.02] (i.e. -Y; note the hardcoded HUGADB_FLEXION_AXIS=(0,-1,0) is ~10 deg off
this measured value - a mild idealization, fine for swing-twist).
+ `test_axis_calibration.py`.

Filtering - `filters.py`: one Butterworth design, two modes: `lowpass_offline`
(filtfilt, zero-phase, for batch/HuGaDB/captures) and `StreamingLowpass`
(lfilter+state, causal, warm-started, for the live path). + `test_filters.py`.

Sources (`sources/`, all behind stream()/get_data + shared `schema.py`):
- `schema.py` - Packet + Capture (Capture.activity optional, source-neutral).
- `synthetic.py` - SyntheticSource; independent forward-model ground truth.
  + `test_synthetic_source.py`.
- `hugadb.py` - HuGaDBSource; real IMU, Madgwick-fused (the ONLY fusion path),
  knee_angle_deg=NaN (no reference), empirical flexion axis (0,−1,0). Validated
  on real sit-to-stand: standing ~0°, sitting ~61°, peak ~64°.
  + `test_hugadb.py`.
- `serial_source.py` - SerialSource for the live BNO085 link (built ahead of the
  hardware). Parses the firmware CSV line
  `seq,t_ms,knee_angle_deg,qt(wxyz),qs(wxyz)`; emits RAW quaternions as the
  truth and carries the firmware's on-device angle only as a cross-check.
  Hardware-decoupled: tests feed simulated lines, pyserial is imported lazily.
  + `test_serial_source.py`.

Metrics (derived from the knee-angle signal, work on ANY source's Capture):
- `metrics.py` - direct parameter-free reductions: range_of_motion, max_flexion,
  max_extension, angular_velocity, peak_angular_velocity, summarize.
  + `test_metrics.py`.
- `repetitions.py` - detection-based: detect_reps returns count + confidence
  indicators (per-peak prominence, partial_at_start/end flags, amplitude_cv,
  period_cv). Prominence is ADAPTIVE - max(floor ~6°, 0.3×session ROM) - so it
  counts low-ROM stroke-rehab reps (20-30°), not just healthy ~60° sit-to-stand.
  + `test_repetitions.py`.

Runner + infra:
- `run_capture.py` - capture-to-graph + accuracy report, multi-source; overlays
  raw+filtered angle, shades activity bands, shows a ±2.5° error panel
  (synthetic, has ground truth) or a raw−filtered residual (HuGaDB), and prints
  the full metric set on the figure (ROM, max flex/ext, peak velocity, rep count
  WITH confidence indicators - partial-edge caveat + adaptive prominence).
  + `test_run_capture.py`.
- `live_plot.py` - real-time scrolling knee-angle plot over a source's stream(),
  using the causal StreamingLowpass. Sample cadence (wall-clock pump) and redraw
  cadence (~30 fps) are decoupled; hot loop is receive→filter→buffer only.
  Validated against synthetic; real test comes with the BNO085s. + `test_live_plot.py`.
- `conftest.py` - session-scoped cached HuGaDB (Madgwick) fixture keeps the
  suite fast.
- Data: `hugadb/` - 364 HuGaDB v2 CSVs.

Firmware - `firmware/knee_imu_serial.ino`: XIAO ESP32-C3 + 2x BNO085 sketch that
emits EXACTLY the SerialSource CSV contract (verified: a firmware-formatted line
round-trips through parse_packet_line). Uses SparkFun BNO080 library, I2C @
100 kHz (clock-stretching), 0x4A/0x4B via ADO, game rotation vector; prints
per-sensor found/NOT-FOUND diagnostics ('#'-prefixed, skipped by the parser) and
carries a rough on-device angle as cross-check only. Bring-up checklist in-file.

**Hardware bring-up status (2026-07-12):** dual-IMU I2C detection (0x4A + 0x4B)
and THIGH game-rotation-vector streaming are verified live on the XIAO ESP32-C3
rig at a clean 100 Hz (seq no drops, t_ms ~10 ms, thigh quaternion unit-norm and
evolving smoothly with motion). Day-one bug: the SHANK streamed a frozen identity
quaternion (1,0,0,0) because enableGameRotationVector() was issued before the
BNO085 finished its post-reset boot and was silently dropped, so the on-device
angle was thigh-relative-to-identity (bogus 155-164 deg). This commit is the fix:
hardened init (200 ms boot delay + begin() retries + 150/50 ms delays around
enabling the report via a shared initSensor() helper), a loop() liveness watchdog
that re-enables a sensor silent >1 s, and a periodic '#' health line so a dead
sensor is visible instead of masquerading as identity. Still to confirm on
hardware after this flash: live shank rotation vector, and the Python swing-twist
angle tracking the on-device cross-check during slow bends.

## Build order (where we are)

1. [done] `quaternion_math.py` + tests
2. [done] quaternion-native `relative_orientation.py` + `joint_angles.py`
3. [done] synthetic source → engine → knee angle end to end (round-trip against
   an independent forward-model ground truth)
4. [done] straight-leg calibration in quaternion form (Markley average)
5. [done] HuGaDB as a second source (Madgwick lives ONLY on this offline path,
   since HuGaDB is raw accel/gyro with no on-chip fusion); validated on real
   sit-to-stand
6. [done] SDR deliverables (Prototype + Feasibility):
   - capture-to-graph (synthetic + HuGaDB), offline-filtered, with a citable
     accuracy (synthetic) / ROM (HuGaDB) number
   - live plot: real-time `stream()` → causal `StreamingLowpass` → scrolling knee
     angle. Validated against SYNTHETIC now; real test when the BNO085s arrive.
7. [done] SerialSource skeleton (live BNO085 link), tested with simulated
   firmware lines, PLUS the matching firmware (firmware/knee_imu_serial.ino).
   Both halves of the CSV contract verified to mesh. Hardware day = flash +
   wire + validate.
9. [done] axis_calibration.py - the tool to MEASURE the live flexion axis on the
   mounted hardware (was the one item gated by sensor day). Validated on HuGaDB.

HARDWARE DAY (sensors arrive 1-3 days out from 2026-07-05): flash the firmware,
run the bring-up checklist, then axis-calibrate (straight-leg + bent) to get the
live flexion axis, and validate the whole live path (serial -> engine -> metrics
-> live plot). All software is built and tested; nothing else blocks this.
8. [done] metrics - `metrics.py` (direct: ROM, max flexion/extension, angular
   velocity) + `repetitions.py` (detection: rep count, consistency, with adaptive
   prominence + confidence indicators). Validated on synthetic and HuGaDB.

## Scope discipline (do NOT build these yet)

The full PASS vision includes ML (exercise classification, recovery scoring),
a digital twin, LLM clinical reporting, and a dashboard. These are **phase 2** -
they need labelled clinical data we don't have yet, and building them now means
many fragile subsystems instead of one solid one. Keep the knee measurement
chain excellent first. Do NOT scaffold empty ML/LLM/digital-twin folders -
that clutter is what made my last repo overwhelming. Add a layer only when we
actually build it.

## Conventions

- Quaternions: (w, x, y, z), unit norm, Hamilton product, right-handed.
- Python interpreter on this Windows machine is `py`; venv in `.venv`.
- Packages installed: numpy, scipy, matplotlib, pyserial.
