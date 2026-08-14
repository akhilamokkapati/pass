# RUNMO: Helping you run-more

**RUNMO** is a modular lower-limb wearable that makes physiotherapy quantitative:
it captures objective lower-limb kinematics and loading, gives patients real-time
feedback, and produces clinically useful data for physiotherapists. RUNMO is **not
tied to any single condition** - the same measurements support rehabilitation across
many contexts (post-surgical recovery, sports/injury rehab, general musculoskeletal
physiotherapy, and neurological rehabilitation such as post-stroke).

> Course project for SUTD 30.007 Engineering Design Innovation, Team 01 *Super Strokers*.

This repository is a **monorepo**: each subsystem lives in its own top-level folder,
self-contained with its own code, tests, firmware and README. Teammates work inside
their subsystem's folder.

## Subsystems

| Folder | Module | What it covers | Status |
|--------|--------|----------------|--------|
| [`knee/`](knee/) | Knee kinematics | IMU-based knee-flexion angle + ROM/velocity/rep metrics (quaternion-native) | Built + tested (100 tests) |
| [`hip/`](hip/) | Hip | Hip-joint orientation / kinematics | Planned |
| [`feet/`](feet/) | Feet (FSR) | Plantar force sensing: weight-bearing/loading, foot-contact events (heel strike / toe off), gait phases | Planned |
| [`actuation/`](actuation/) | Actuation | Assistive actuation + load-cell force/strength measurement | Planned |
| [`housing/`](housing/) | Housing | Mechanical housing, mounting, power/enclosure | Planned |

The **full RUNMO platform** integrates all subsystems; each folder delivers its own
validated piece. See each subsystem's README for scope and status.

## Repository layout

```
runmo/
  knee/        <- knee subsystem (code, tests, firmware, dashboard, README, CLAUDE.md)
  hip/         <- hip subsystem
  feet/        <- feet / FSR subsystem
  actuation/   <- actuation subsystem
  housing/     <- housing / mechanical subsystem
  README.md    <- this file
```

## Contributing (for teammates)

1. Put your work inside **your subsystem's folder** (e.g. `feet/`). Keep code, tests,
   firmware and docs together there.
2. Add a short `README.md` in your folder: what the module does, how to run it, status.
3. Keep each subsystem independently runnable (its own `requirements.txt` / setup).
4. Don't reach across into another subsystem's folder; if you need shared code, raise
   it so we can add a `shared/` module deliberately.

New here? Start with the [`knee/`](knee/) subsystem as a reference for how a subsystem
is structured (source modules + test-first tests + firmware + README).
