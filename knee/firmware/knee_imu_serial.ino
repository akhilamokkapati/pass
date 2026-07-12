/*
 * knee_imu_serial.ino
 * PASS knee module - XIAO ESP32-C3 + 2x BNO085 -> serial packet stream.
 *
 * Emits one CSV line per sample in EXACTLY the contract that Python's
 * sources/serial_source.py parses (they are two halves of one tested contract):
 *
 *     seq,t_ms,knee_angle_deg,qtw,qtx,qty,qtz,qsw,qsx,qsy,qsz\n
 *
 *   seq            sample counter (uint)
 *   t_ms           millis() at emit (uint)
 *   knee_angle_deg ROUGH on-device angle  <-- CROSS-CHECK ONLY, not the truth
 *   qt{w,x,y,z}    thigh quaternion  (BNO085 game rotation vector, scalar-first)
 *   qs{w,x,y,z}    shank quaternion
 *
 * TRUTH LIVES IN PYTHON. The two raw quaternions are the source of truth: the
 * Python engine recomputes the knee angle from them via swing-twist (the
 * validated path). knee_angle_deg here is a deliberately rough total-rotation
 * estimate carried only so the host can cross-check firmware vs engine. Do NOT
 * grow this into the "real" angle on-device.
 *
 * ---------------------------------------------------------------------------
 * BRING-UP CHECKLIST (sensor day = flash + validate)
 * ---------------------------------------------------------------------------
 * 1. LIBRARY: install "SparkFun BNO080 Cortex Based IMU" via Arduino Library
 *    Manager (works with BNO080/085/086). Header included below.
 * 2. BOARD: Seeed XIAO ESP32-C3 (or S3 - same I2C pins). Select it in the IDE.
 * 3. POWER: BNO085 is 3.3V ONLY. Feed both breakouts from the XIAO 3V3 pin.
 *    Never 5V. Common ground.
 * 4. I2C WIRING (XIAO: SDA=D4/GPIO6, SCL=D5/GPIO7). Bus shared by both sensors:
 *      XIAO 3V3  -> both VIN/3V3
 *      XIAO GND  -> both GND
 *      XIAO D4   -> both SDA
 *      XIAO D5   -> both SCL
 * 5. MODE STRAPS on EACH breakout (force I2C):  PS0 -> GND,  PS1 -> GND.
 * 6. ADDRESS via ADO on EACH breakout (this is how two sensors share one bus):
 *      THIGH sensor: ADO -> GND  => I2C address 0x4A
 *      SHANK sensor: ADO -> 3V3  => I2C address 0x4B
 * 7. FLASH this sketch, open Serial Monitor at 115200.
 *    - Startup prints (all '#'-prefixed so the host parser ignores them):
 *          # PASS knee IMU bring-up
 *          # thigh BNO085 found at 0x4A        (or: NOT FOUND -> check ADO=GND, wiring)
 *          # shank BNO085 found at 0x4B        (or: NOT FOUND -> check ADO=3V3, wiring)
 *          # streaming: seq,t_ms,knee_angle_deg,qtw,qtx,qty,qtz,qsw,qsx,qsy,qsz
 *    - A HEALTHY data line looks like (quaternions unit-norm, ~4 sig figs):
 *          0,12,3.42,0.999877,0.006134,-0.010742,0.004150,0.965881,0.258789,0.012451,-0.001220
 *      Standing still: knee_angle_deg small and steady; both quats near-constant.
 *      Bend the knee: knee_angle_deg rises smoothly; quats change smoothly.
 *    - If a sensor is NOT FOUND: check its ADO strap, PS0/PS1=GND, 3V3, and SDA/SCL.
 * 8. HOST: python -c "from sources.serial_source import SerialSource;
 *    print(SerialSource(port='COM?').get_data(2).quat_thigh.shape)"  (flash+validate)
 *
 * ---------------------------------------------------------------------------
 * HARDWARE GOTCHAS baked into setup() / loop() below
 * ---------------------------------------------------------------------------
 *  - BNO085 CLOCK-STRETCHES on I2C. Run the bus at 100 kHz (Wire.setClock),
 *    higher rates are unreliable with this part.
 *  - BNO085 needs ~100 ms after its power-on / soft-reset boot before it will
 *    accept feature commands. enableGameRotationVector() issued too early is
 *    silently dropped: dataAvailable() never fires and the sensor streams a
 *    FROZEN identity quaternion (1,0,0,0) forever. This was the day-one shank
 *    bug. setup() therefore delays before the first begin(), retries begin(),
 *    and delays again before/after enabling the report; a loop() liveness
 *    watchdog re-enables any sensor that later goes silent, and a periodic
 *    health line makes a dead sensor visible instead of masquerading as identity.
 *  - Native USB CDC serial on the C3/S3 ignores the nominal baud; throughput is
 *    USB-speed, so 100 Hz of ~100-char lines streams fine. We still begin at
 *    115200 to match the host SerialSource default.
 */

#include <Wire.h>
#include "SparkFun_BNO080_Arduino_Library.h"

// ---- configuration ---------------------------------------------------------
static const uint8_t  THIGH_ADDR = 0x4A;   // ADO -> GND
static const uint8_t  SHANK_ADDR = 0x4B;   // ADO -> 3V3
static const uint32_t I2C_HZ     = 100000; // BNO085 clock-stretching: keep at 100 kHz
static const uint16_t REPORT_MS  = 10;     // BNO085 game rotation vector interval (~100 Hz)
static const uint32_t EMIT_MS    = 10;     // serial emit cadence (~100 Hz)

// Init timing to work around the BNO085 post-reset boot window (see gotchas).
static const uint32_t BOOT_DELAY_MS   = 200; // after Wire setup, before first begin()
static const uint8_t  BEGIN_ATTEMPTS  = 3;   // begin() retries per sensor
static const uint32_t BEGIN_RETRY_MS  = 100; // wait between begin() attempts
static const uint32_t PRE_ENABLE_MS   = 150; // settle after begin() before enabling report
static const uint32_t POST_ENABLE_MS  = 50;  // settle after enabling report

// Runtime robustness.
static const uint32_t SILENT_TIMEOUT_MS = 1000; // re-enable a sensor silent this long
static const uint32_t HEALTH_MS         = 5000; // '#' health line cadence

BNO080 thigh;
BNO080 shank;

// latest quaternion per segment (scalar-first); init to identity so the first
// lines are valid even before the first report arrives.
float tw = 1, tx = 0, ty = 0, tz = 0;
float sw = 1, sx = 0, sy = 0, sz = 0;

uint32_t seq = 0;
uint32_t lastEmit = 0;

// Per-sensor liveness / health tracking.
bool     thighOk = false, shankOk = false;          // begin() succeeded
uint32_t thighLastReport = 0, shankLastReport = 0;   // millis of last report
uint32_t thighCount = 0, shankCount = 0;             // reports since boot
uint32_t lastHealth = 0;

// Rough on-device knee angle: total relative rotation between the two
// orientations = 2*acos(|dot(qt,qs)|). Mounting-dependent and not axis-isolated
// ON PURPOSE - it is only a cross-check; the Python engine does swing-twist.
float roughKneeAngleDeg() {
  float dot = tw * sw + tx * sx + ty * sy + tz * sz;
  dot = fabs(dot);
  if (dot > 1.0f) dot = 1.0f;
  return 2.0f * acos(dot) * 180.0f / PI;
}

// Bring up one BNO085: retry begin(), then enable the game rotation vector with
// delays around it so the feature command is not dropped during the part's
// post-reset boot. Prints '#'-prefixed diagnostics. Returns true on success.
bool initSensor(BNO080 &imu, uint8_t addr, const char *name) {
  for (uint8_t attempt = 1; attempt <= BEGIN_ATTEMPTS; attempt++) {
    if (imu.begin(addr, Wire)) {
      delay(PRE_ENABLE_MS);                  // let the post-reset boot settle
      imu.enableGameRotationVector(REPORT_MS);
      delay(POST_ENABLE_MS);
      Serial.print("# ");
      Serial.print(name);
      Serial.print(" BNO085 found at 0x");
      Serial.println(addr, HEX);
      return true;
    }
    delay(BEGIN_RETRY_MS);
  }
  Serial.print("# ");
  Serial.print(name);
  Serial.print(" BNO085 NOT FOUND at 0x");
  Serial.print(addr, HEX);
  Serial.println("  (check ADO strap, PS0/PS1->GND, 3V3, SDA/SCL)");
  return false;
}

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 3000) { /* wait up to 3 s for USB CDC */ }

  Wire.begin(D4, D5);        // XIAO ESP32-C3: SDA=D4 (GPIO6), SCL=D5 (GPIO7)
  Wire.setClock(I2C_HZ);     // 100 kHz - required for BNO085 clock stretching

  Serial.println("# PASS knee IMU bring-up");

  delay(BOOT_DELAY_MS);      // BNO085 power-on boot before the first begin()

  // Per-sensor init with hardened timing so a feature command is never sent
  // into the post-reset boot window (the frozen-identity failure mode).
  thighOk = initSensor(thigh, THIGH_ADDR, "thigh");
  shankOk = initSensor(shank, SHANK_ADDR, "shank");

  uint32_t now = millis();
  thighLastReport = now;
  shankLastReport = now;
  lastHealth = now;

  Serial.println("# streaming: seq,t_ms,knee_angle_deg,qtw,qtx,qty,qtz,qsw,qsx,qsy,qsz");
}

void loop() {
  uint32_t now = millis();

  // Cache the freshest quaternion from each sensor as reports arrive, and track
  // per-sensor liveness (last-report time + count since boot).
  if (thigh.dataAvailable()) {
    tw = thigh.getQuatReal(); tx = thigh.getQuatI();
    ty = thigh.getQuatJ();    tz = thigh.getQuatK();
    thighLastReport = now;
    thighCount++;
  }
  if (shank.dataAvailable()) {
    sw = shank.getQuatReal(); sx = shank.getQuatI();
    sy = shank.getQuatJ();    sz = shank.getQuatK();
    shankLastReport = now;
    shankCount++;
  }

  // Liveness watchdog: a BNO085 whose feature command was dropped goes silent
  // and streams its cached identity forever. Re-issue the report if a found
  // sensor stops reporting, and make it visible with a '#' warning.
  if (thighOk && (now - thighLastReport) > SILENT_TIMEOUT_MS) {
    thigh.enableGameRotationVector(REPORT_MS);
    thighLastReport = now;   // fresh timeout window before the next retry
    Serial.println("# WARN thigh silent >1s, re-enabling game rotation vector");
  }
  if (shankOk && (now - shankLastReport) > SILENT_TIMEOUT_MS) {
    shank.enableGameRotationVector(REPORT_MS);
    shankLastReport = now;
    Serial.println("# WARN shank silent >1s, re-enabling game rotation vector");
  }

  // Periodic health line so a dead sensor is visible instead of masquerading as
  // a frozen identity quaternion. '#'-prefixed, so contract-safe for the parser.
  if (now - lastHealth >= HEALTH_MS) {
    lastHealth = now;
    Serial.print("# health thigh_reports=");
    Serial.print(thighCount);
    Serial.print(" shank_reports=");
    Serial.println(shankCount);
  }

  // Emit at a steady cadence using the latest cached values (decouples the
  // serial line rate from per-sensor report arrival).
  if (now - lastEmit >= EMIT_MS) {
    lastEmit = now;

    Serial.print(seq);            Serial.print(',');
    Serial.print(now);            Serial.print(',');
    Serial.print(roughKneeAngleDeg(), 2); Serial.print(',');
    Serial.print(tw, 6); Serial.print(',');
    Serial.print(tx, 6); Serial.print(',');
    Serial.print(ty, 6); Serial.print(',');
    Serial.print(tz, 6); Serial.print(',');
    Serial.print(sw, 6); Serial.print(',');
    Serial.print(sx, 6); Serial.print(',');
    Serial.print(sy, 6); Serial.print(',');
    Serial.println(sz, 6);

    seq++;
  }
}
