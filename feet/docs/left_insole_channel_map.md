# Left foot insole - channel map and hardware reference

Source-of-truth hardware documentation for the PASS left foot pressure insole node.
Hardware bring-up complete and verified end to end.

- Node: left foot pressure insole
- Pipeline tier: v1 (XIAO over USB serial into the Streamlit dashboard). This node
  is serial only. No ESP-NOW, no master/slave, no v2 WiFi mesh.

## Sensor

- Part: LEGACT FS-INS-16Z film pressure insole.
- Zones: 16.
- Tail: 20-pin 1.0 mm pitch FPC.
- Electrical behavior: resistive. Resistance falls with load, roughly 150k unloaded
  down to about 70k at 10 kg.
- Nature: distribution sensor. It reports RELATIVE pressure only. It is not a
  calibrated force sensor. Do not report absolute Newtons from it.

## MCU

- Seeed XIAO ESP32-S3.

## Mux and pull-up topology

- Mux: CD74HC4067, 16-channel analog multiplexer.
- Topology: pull-up.
  - Insole COMMON tied to GND.
  - 220k pull-up resistor from the SIG node to 3V3.
- Consequence (important): pressing a zone lowers that zone's resistance, which
  pulls the ADC reading DOWN from a roughly 4095 baseline. Higher pressure = lower
  raw ADC.
- INVERSION REQUIREMENT: raw ADC is inverted relative to pressure. It MUST be
  inverted downstream so pressure reads up. The firmware streams RAW counts; the
  Python source applies `pressure = 4095 - raw`. Do not invert in firmware.

## Firmware pin map (explicit GPIO)

Pin mappings use explicit GPIO defines, never board-package aliases.

| Signal   | XIAO label | GPIO   | Notes                       |
|----------|------------|--------|-----------------------------|
| SIG/ADC  | D0         | GPIO1  | ADC1_CH0                    |
| S0       | D1         | GPIO2  | mux select bit 0 (LSB)      |
| S1       | D2         | GPIO3  | mux select bit 1            |
| S2       | D3         | GPIO4  | mux select bit 2            |
| S3       | D8         | GPIO7  | mux select bit 3 (MSB)      |
| EN       | -          | -      | tied to GND in hardware (mux always enabled) |

Channel select: `channel = (S3 << 3) | (S2 << 2) | (S1 << 1) | S0`, S0 = LSB.

## ADC read routine (verified)

- Resolution: 12-bit (0 to 4095).
- Attenuation: 11 dB (full ~3.3 V input range).
- Per-channel sequence:
  1. Set S0..S3 to select the channel.
  2. Settle 120 us. Bump to 500 us if crosstalk is observed between channels.
  3. One dummy `analogRead` (discarded).
  4. Wait 80 us.
  5. Average 4 reads spaced 40 us apart. That average is the channel value.

## Physical adapter pin to mux channel map (verified)

FPC/adapter physical pin numbers to CD74HC4067 channels.

| Phys pin | Mux ch | Phys pin | Mux ch |
|----------|--------|----------|--------|
| 1        | C0     | 11       | C8     |
| 2        | C1     | 12       | C9     |
| 3        | C2     | 13       | C10    |
| 4        | C3     | 14       | C11    |
| 5        | C4     | 16       | C12    |
| 6        | C5     | 17       | C13    |
| 8        | C6     | 18       | C14    |
| 9        | C7     | 19       | C15    |

COMMON and NUL pins:

- Phys 7 and phys 15: COMMON (tied to GND).
- Phys 10 and phys 20: NUL (unconnected).

## Channel to anatomy

The anatomy layer is configurable and must not hardcode assumptions beyond the
confirmed entries below. Remaining zones are TODO, to be finalized by a press test.

| Mux ch | Phys pin | Anatomy         | Status    |
|--------|----------|-----------------|-----------|
| C0     | 1        | TODO            | TODO      |
| C1     | 2        | TODO            | TODO      |
| C2     | 3        | TODO            | TODO      |
| C3     | 4        | TODO            | TODO      |
| C4     | 5        | TODO            | TODO      |
| C5     | 6        | TODO            | TODO      |
| C6     | 8        | TODO            | TODO      |
| C7     | 9        | TODO            | TODO      |
| C8     | 11       | Big toe         | confirmed |
| C9     | 12       | Big toe         | confirmed |
| C10    | 13       | TODO            | TODO      |
| C11    | 14       | TODO            | TODO      |
| C12    | 16       | Heel            | confirmed |
| C13    | 17       | Heel            | confirmed |
| C14    | 18       | TODO            | TODO      |
| C15    | 19       | TODO            | TODO      |

## Downstream processing requirements

Handled in the Python source, not in firmware:

1. Inversion: `pressure = 4095 - raw` per channel, so pressure reads up.
2. Per-zone normalization: from a standing-still calibration segment, compute each
   zone's baseline and scale so the output is fraction-of-static-load per zone. This
   corrects zone-to-zone sensitivity variation. It must be re-runnable per session,
   not baked once.
