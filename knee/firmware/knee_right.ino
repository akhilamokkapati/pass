/*
 * knee_right.ino
 * PASS RIGHT knee module - XIAO ESP32-S3 + 2x BNO085 -> WiFi UDP stream.
 * Identical to knee_left.ino except UNIT_ID - flash this onto the board
 * mounted on the RIGHT leg.
 *
 * Same as knee_imu_serial.ino (hardened dual-BNO085 init + liveness watchdog +
 * health line), but instead of raising its own SoftAP it JOINS the travel router
 * and broadcasts each sample to the laptop over UDP. Serial output is kept as
 * a wired fallback, so one firmware works both plugged in and on battery.
 *
 * Emits (unit_id-prefixed, both knees share one port - the prefix is how the
 * receiver tells them apart, same pattern as feet on their shared port):
 *
 *     unit_id,seq,t_ms,knee_angle_deg,qtw,qtx,qty,qtz,qsw,qsx,qsy,qsz\n
 *
 * TRUTH LIVES IN PYTHON: the two raw quaternions are the source of truth; the
 * engine recomputes the knee angle via swing-twist. knee_angle_deg here is a
 * rough on-device cross-check only.
 *
 * WIRING / STRAPS (unchanged, see knee_imu_serial.ino for the full checklist):
 *   I2C SDA=D4, SCL=D5, 100 kHz. THIGH ADO->GND (0x4A), SHANK ADO->3V3 (0x4B).
 *   PS0/PS1->GND on both. BNO085 is 3.3V only.
 */

#include <Wire.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_task_wdt.h>
#include "SparkFun_BNO080_Arduino_Library.h"

// ---- identity ---------------------------------------------------------
#define UNIT_ID "knee_right"

// ---- network (travel router, same as the feet) -----------------------------
#define WIFI_SSID "TP-Link_1285"
#define WIFI_PASS "15289346"
// Broadcast, not unicast: this router's repeater/bridge mode silently drops
// direct client-to-client unicast (AP/client isolation) even with excellent
// RSSI and a confirmed join. Feet and hip already use broadcast and work.
#define LAPTOP_IP "192.168.0.255"
#define UDP_PORT  5005              // knee port (feet use 5006) -> NetworkSource default

// ---- status LED --------------------------------------------------------
// Onboard orange user LED on GPIO21 (active LOW: LOW = lit). Solid = joined WiFi,
// blink = searching, off = not powered. No external wiring needed.
#define LED_PIN 21
#define LED_ON  LOW

// ---- configuration ---------------------------------------------------------
static const uint8_t  THIGH_ADDR = 0x4A;   // ADO -> GND
static const uint8_t  SHANK_ADDR = 0x4B;   // ADO -> 3V3
static const uint32_t I2C_HZ     = 100000; // BNO085 clock-stretching: keep at 100 kHz
static const uint16_t REPORT_MS  = 10;     // game rotation vector interval (~100 Hz)
static const uint32_t EMIT_MS    = 50;     // emit cadence (~20 Hz). Was 100 Hz; dropped to 20 Hz
                                            // plus the loop() yield below fixed real packet loss
                                            // (RSSI/status always looked fine, but almost nothing
                                            // actually arrived - two I2C sensors + WiFi were
                                            // starving each other). 20 Hz is plenty for knee angle.

// Init timing to work around the BNO085 post-reset boot window.
static const uint32_t BOOT_DELAY_MS   = 200;
static const uint8_t  BEGIN_ATTEMPTS  = 3;
static const uint32_t BEGIN_RETRY_MS  = 100;
static const uint32_t PRE_ENABLE_MS   = 150;
static const uint32_t POST_ENABLE_MS  = 50;

// Runtime robustness.
static const uint32_t SILENT_TIMEOUT_MS = 1000; // re-enable a sensor silent this long
static const uint32_t HEALTH_MS         = 5000; // '#' health line cadence

// ---- fault recovery ---------------------------------------------------
// Hardware watchdog: if loop() ever truly hangs (e.g. an I2C bus lockup from
// the BNO085's clock-stretching - a known way for that bus to wedge if a
// transfer gets cut mid-transaction), this force-reboots the board instead
// of it silently dying with the status LED frozen solid, needing a physical
// power-cycle to notice or fix.
static const uint32_t WDT_TIMEOUT_S = 8;
// Zombie-WiFi guard: WiFi.status() is a cached flag that can keep reporting
// WL_CONNECTED after the AP has actually dropped the association (seen on
// flaky routers). A genuinely joined station always has a real (negative)
// RSSI from beacon reception, so RSSI==0 while "connected" is the tell.
// After this many consecutive bad reads, force a disconnect so the normal
// reconnect path (auto-reconnect) kicks back in instead of streaming into
// the void forever while the LED still shows solid.
static const uint32_t ZOMBIE_CHECK_MS = 3000;
static const uint8_t  ZOMBIE_LIMIT    = 3;

WiFiUDP udp;
IPAddress dest;

// Non-blocking WiFi: never wait in loop() (a blocking join starves the I2C
// sensor polling and streams frozen identity quaternions). We kick a join ONCE
// and let the ESP32 auto-reconnect finish it; a forced re-begin only fires after
// a long interval, because re-calling begin() mid-connect ("cannot set config")
// interrupts the association and stops it ever completing.
static const uint32_t WIFI_RETRY_MS = 20000;
uint32_t lastWifiTry = 0;
bool     wifiWasUp   = false;

BNO080 thigh;
BNO080 shank;

// latest quaternion per segment (scalar-first); identity until first report.
float tw = 1, tx = 0, ty = 0, tz = 0;
float sw = 1, sx = 0, sy = 0, sz = 0;

uint32_t seq = 0;
uint32_t lastEmit = 0;

bool     thighOk = false, shankOk = false;
uint32_t thighLastReport = 0, shankLastReport = 0;
uint32_t thighCount = 0, shankCount = 0;
uint32_t lastHealth = 0;
uint32_t udpBeginOk = 0, udpBeginFail = 0, udpEndOk = 0, udpEndFail = 0;

// Rough on-device knee angle: total relative rotation = 2*acos(|dot(qt,qs)|).
// Cross-check only; the Python engine does swing-twist.
float roughKneeAngleDeg() {
  float dot = tw * sw + tx * sx + ty * sy + tz * sz;
  dot = fabs(dot);
  if (dot > 1.0f) dot = 1.0f;
  return 2.0f * acos(dot) * 180.0f / PI;
}

bool initSensor(BNO080 &imu, uint8_t addr, const char *name) {
  for (uint8_t attempt = 1; attempt <= BEGIN_ATTEMPTS; attempt++) {
    if (imu.begin(addr, Wire)) {
      delay(PRE_ENABLE_MS);
      imu.enableGameRotationVector(REPORT_MS);
      delay(POST_ENABLE_MS);
      // Serial.print can BLOCK on native USB-CDC if nothing has the port open
      // and reading - guard every print with `if (Serial)` so a board running
      // untethered (no laptop watching) can never stall its own WiFi loop on
      // an unread serial write. Found via the actuation board's downlink test.
      if (Serial) {
        Serial.print("# ");
        Serial.print(name);
        Serial.print(" BNO085 found at 0x");
        Serial.println(addr, HEX);
      }
      return true;
    }
    delay(BEGIN_RETRY_MS);
  }
  if (Serial) {
    Serial.print("# ");
    Serial.print(name);
    Serial.print(" BNO085 NOT FOUND at 0x");
    Serial.print(addr, HEX);
    Serial.println("  (check ADO strap, PS0/PS1->GND, 3V3, SDA/SCL)");
  }
  return false;
}

// Arms the hardware watchdog. Called at the END of setup(), after the blocking
// WiFi-join wait and sensor-init retries are done, so normal startup delays
// (which can legitimately run several seconds) never trip a false reboot.
// The esp_task_wdt_init signature changed in arduino-esp32 core 3.x (struct
// config instead of two plain args); this covers both so the build doesn't
// silently depend on which core version happens to be installed.
void wdtBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdtConfig = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);   // watch the loop() task; core 3.x's default init may
                             // already have one running - adding again is harmless.
}

// Kick off a (non-blocking) join. Never waits; loop() reports when it lands.
void wifiBegin() {
  // EXACT minimal sequence the working feet use - nothing else, so the knee
  // associates the same way they do.
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  dest.fromString(LAPTOP_IP);
}

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 3000) { /* wait up to 3 s for USB CDC */ }

  Wire.begin(D4, D5);        // XIAO: SDA=D4, SCL=D5
  Wire.setClock(I2C_HZ);     // 100 kHz - required for BNO085 clock stretching

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);   // off until we know the WiFi state

  if (Serial) Serial.println("# PASS " UNIT_ID " IMU bring-up (wireless)");

  // Block-and-wait for the join here (like the feet firmware that works), giving
  // the association uninterrupted time. Sensors init AFTER, so nothing is starved.
  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  if (Serial) {
    Serial.print("# " UNIT_ID " wifi ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
    Serial.print(WiFi.localIP());
    Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
  }
  WiFi.setSleep(false);      // keep radio awake -> smooth stream, no "stale" gaps
  WiFi.setTxPower(WIFI_POWER_19_5dBm);   // force max TX power
  udp.begin(UDP_PORT);

  delay(BOOT_DELAY_MS);      // BNO085 power-on boot before the first begin()

  thighOk = initSensor(thigh, THIGH_ADDR, "thigh");
  shankOk = initSensor(shank, SHANK_ADDR, "shank");

  uint32_t now = millis();
  thighLastReport = now;
  shankLastReport = now;
  lastHealth = now;

  wdtBegin();   // arm last, after all the blocking setup work above is done

  if (Serial) Serial.println("# streaming: " UNIT_ID ",seq,t_ms,knee_angle_deg,qtw,qtx,qty,qtz,qsw,qsx,qsy,qsz");
}

void loop() {
  uint32_t now = millis();
  esp_task_wdt_reset();   // feed the watchdog every pass - see wdtBegin()

  // Zombie-WiFi check: status() says connected but RSSI reads 0 (no real
  // signal) - force a disconnect so auto-reconnect actually rejoins instead
  // of streaming into the void with a solid LED. See ZOMBIE_* above.
  static uint32_t lastZombieCheck = 0;
  static uint8_t  zombieStreak = 0;
  if (now - lastZombieCheck >= ZOMBIE_CHECK_MS) {
    lastZombieCheck = now;
    if (WiFi.status() == WL_CONNECTED && WiFi.RSSI() == 0) {
      if (++zombieStreak >= ZOMBIE_LIMIT) {
        if (Serial) Serial.println("# WARN zombie WiFi (RSSI stuck at 0) - forcing reconnect");
        WiFi.disconnect();
        zombieStreak = 0;
      }
    } else {
      zombieStreak = 0;
    }
  }

  // status LED: solid = joined, blinking = searching
  if (WiFi.status() == WL_CONNECTED) digitalWrite(LED_PIN, LED_ON);
  else digitalWrite(LED_PIN, ((now / 300) % 2) ? LED_ON : !LED_ON);

  // WiFi maintenance: just announce when the link comes up. We never call
  // begin() again here - setAutoReconnect(true) retries the association in the
  // background on its own, and re-calling begin() mid-connect ("cannot set
  // config") is exactly what stopped it ever joining. NEVER blocks.
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasUp) {
      wifiWasUp = true;
      if (Serial) {
        Serial.print("# " UNIT_ID " wifi JOINED ");
        Serial.print(WiFi.localIP());
        Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
      }
    }
  } else {
    wifiWasUp = false;                    // auto-reconnect handles the retry
  }

  // Cache the freshest quaternion from each sensor as reports arrive.
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

  // Yield once per loop so tight back-to-back I2C polling of two sensors can't
  // monopolize CPU time right when the WiFi stack needs a window to transmit
  // (this is what was causing near-total packet loss before this fix).
  delay(1);

  // Liveness watchdog: re-issue the report if a found sensor goes silent (the
  // dropped-feature-command / frozen-identity failure mode).
  if (thighOk && (now - thighLastReport) > SILENT_TIMEOUT_MS) {
    thigh.enableGameRotationVector(REPORT_MS);
    thighLastReport = now;
    if (Serial) Serial.println("# WARN thigh silent >1s, re-enabling game rotation vector");
  }
  if (shankOk && (now - shankLastReport) > SILENT_TIMEOUT_MS) {
    shank.enableGameRotationVector(REPORT_MS);
    shankLastReport = now;
    if (Serial) Serial.println("# WARN shank silent >1s, re-enabling game rotation vector");
  }

  if (now - lastHealth >= HEALTH_MS) {
    lastHealth = now;
    if (Serial) {
      Serial.print("# health thigh_reports=");
      Serial.print(thighCount);
      Serial.print(" shank_reports=");
      Serial.print(shankCount);
      Serial.print("  wifi ");
      Serial.print(WiFi.status() == WL_CONNECTED ? "UP" : "DOWN");
      Serial.print("  rssi ");
      Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
      Serial.print(" dBm  udp begin ok=");
      Serial.print(udpBeginOk);
      Serial.print(" fail=");
      Serial.print(udpBeginFail);
      Serial.print("  end ok=");
      Serial.print(udpEndOk);
      Serial.print(" fail=");
      Serial.println(udpEndFail);
    }
  }

  // Emit at a steady cadence: build the line once, send it BOTH ways (serial
  // wired fallback + UDP to the laptop). unit_id prefix lets the receiver tell
  // this apart from the other knee sharing the same port.
  if (now - lastEmit >= EMIT_MS) {
    lastEmit = now;

    char line[180];
    snprintf(line, sizeof(line),
             UNIT_ID ",%lu,%lu,%.2f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f",
             (unsigned long)seq, (unsigned long)now, roughKneeAngleDeg(),
             tw, tx, ty, tz, sw, sx, sy, sz);

    if (Serial) Serial.println(line);            // wired fallback (guarded: see initSensor note)

    int beginOk = udp.beginPacket(dest, UDP_PORT);   // wireless to the laptop
    if (beginOk) { udpBeginOk++; } else { udpBeginFail++; }
    udp.write((const uint8_t*)line, strlen(line));
    udp.write((uint8_t)'\n');
    int endOk = udp.endPacket();
    if (endOk) { udpEndOk++; } else { udpEndFail++; }

    seq++;
  }
}
