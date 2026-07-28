# Right foot insole - channel map

Source-of-truth pin/channel map for the PASS right foot pressure insole.

The right insole is wired DIFFERENTLY from the left: different physical-pin to
mux-channel map, and different COMMON/NUL pins. The same physical pin number can
be a sensor zone on one foot and GND on the other, so the two feet must have
separate configs. Do not share a map between them.

Shared hardware facts (sensor FS-INS-16Z, XIAO ESP32-S3, CD74HC4067 mux, pull-up
topology, the inversion requirement, ADC read routine, firmware pin map) are
identical to the left foot; see [left_insole_channel_map.md](left_insole_channel_map.md).
This doc records only what differs: the right foot's pin/channel/COMMON/NUL map.

## Physical adapter pin to mux channel map (verified)

| Phys pin | Mux ch | Phys pin | Mux ch |
|----------|--------|----------|--------|
| 2        | C0     | 12       | C8     |
| 3        | C1     | 13       | C9     |
| 4        | C2     | 15       | C10    |
| 5        | C3     | 16       | C11    |
| 7        | C4     | 17       | C12    |
| 8        | C5     | 18       | C13    |
| 9        | C6     | 19       | C14    |
| 10       | C7     | 20       | C15    |

COMMON and NUL pins:

- Phys 6 and phys 14: COMMON (GND, tied together).
- Phys 1 and phys 11: NUL (bare, unconnected).

## Live channels

All 16 mux channels C0-C15 are live sensor zones. The COMMON and NUL pins are not
wired to any mux channel, so there are no dead channels in the scan. This holds for
the left foot too.

## Channel to anatomy

TODO, to be finalized by the press test (which mux channel sits under which part of
the foot). Leave the anatomy layer configurable; do not hardcode assumptions.

| Mux ch | Phys pin | Anatomy | Status |
|--------|----------|---------|--------|
| C0     | 2        | TODO    | TODO   |
| C1     | 3        | TODO    | TODO   |
| C2     | 4        | TODO    | TODO   |
| C3     | 5        | TODO    | TODO   |
| C4     | 7        | TODO    | TODO   |
| C5     | 8        | TODO    | TODO   |
| C6     | 9        | TODO    | TODO   |
| C7     | 10       | TODO    | TODO   |
| C8     | 12       | TODO    | TODO   |
| C9     | 13       | TODO    | TODO   |
| C10    | 15       | TODO    | TODO   |
| C11    | 16       | TODO    | TODO   |
| C12    | 17       | TODO    | TODO   |
| C13    | 18       | TODO    | TODO   |
| C14    | 19       | TODO    | TODO   |
| C15    | 20       | TODO    | TODO   |
