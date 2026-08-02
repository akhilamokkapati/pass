/*
 * knee_wifi.ino
 * PASS knee module - XIAO ESP32 (C3/S3) + 2x BNO085 -> WiFi UDP stream.
 *
 * Same as knee_imu_serial.ino (hardened dual-BNO085 init + liveness watchdog +
 * health line), but instead of raising its own SoftAP it JOINS the travel router
 * (30.007) like the feet and unicasts each sample to the laptop over UDP. Serial
 * output is kept as a wired fallback, so one firmware works both plugged in and
 * on battery.
 *
 * Emits EXACTLY the contract Python's sources/serial_source.py + network_source.py
 * parse (no unit_id prefix - the knee has its own port):
 *
 *     seq,t_ms,knee_angle_deg,qtw,qtx,qty,qtz,qsw,qsx,qsy,qsz\n
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
#include "SparkFun_BNO080_Arduino_Library.h"

// ---- network (travel router, same as the feet) -----------------------------
#define WIFI_SSID "30.007"
#define WIFI_PASS "awesomesauce144"
#define LAPTOP_IP "192.168.0.100"   // laptop IPv4 on the router (ipconfig)
#define UDP_PORT  5005              // knee port (feet use 5006) -> NetworkSource default

// ---- configuration ---------------------------------------------------------
static const uint8_t  THIGH_ADDR = 0x4A;   // ADO -> GND
static const uint8_t  SHANK_ADDR = 0x4B;   // ADO -> 3V3
static const uint32_t I2C_HZ     = 100000; // BNO085 clock-stretching: keep at 100 kHz
static const uint16_t REPORT_MS  = 10;     // game rotation vector interval (~100 Hz)
static const uint32_t EMIT_MS    = 10;     // emit cadence (~100 Hz)

// Init timing to work around the BNO085 post-reset boot window.
static const uint32_t BOOT_DELAY_MS   = 200;
static const uint8_t  BEGIN_ATTEMPTS  = 3;
static const uint32_t BEGIN_RETRY_MS  = 100;
static const uint32_t PRE_ENABLE_MS   = 150;
static const uint32_t POST_ENABLE_MS  = 50;

// Runtime robustness.
static const uint32_t SILENT_TIMEOUT_MS = 1000; // re-enable a sensor silent this long
static const uint32_t HEALTH_MS         = 5000; // '#' health line cadence

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

  Serial.println("# PASS knee IMU bring-up (wireless)");

  // Block-and-wait for the join here (like the feet firmware that works), giving
  // the association uninterrupted time. Sensors init AFTER, so nothing is starved.
  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  Serial.print("# knee wifi ");
  Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
  Serial.print(WiFi.localIP());
  Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
  udp.begin(UDP_PORT);

  delay(BOOT_DELAY_MS);      // BNO085 power-on boot before the first begin()

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

  // WiFi maintenance: just announce when the link comes up. We never call
  // begin() again here - setAutoReconnect(true) retries the association in the
  // background on its own, and re-calling begin() mid-connect ("cannot set
  // config") is exactly what stopped it ever joining. NEVER blocks.
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasUp) {
      wifiWasUp = true;
      Serial.print("# knee wifi JOINED ");
      Serial.print(WiFi.localIP());
      Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
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

  // Liveness watchdog: re-issue the report if a found sensor goes silent (the
  // dropped-feature-command / frozen-identity failure mode).
  if (thighOk && (now - thighLastReport) > SILENT_TIMEOUT_MS) {
    thigh.enableGameRotationVector(REPORT_MS);
    thighLastReport = now;
    Serial.println("# WARN thigh silent >1s, re-enabling game rotation vector");
  }
  if (shankOk && (now - shankLastReport) > SILENT_TIMEOUT_MS) {
    shank.enableGameRotationVector(REPORT_MS);
    shankLastReport = now;
    Serial.println("# WARN shank silent >1s, re-enabling game rotation vector");
  }

  if (now - lastHealth >= HEALTH_MS) {
    lastHealth = now;
    Serial.print("# health thigh_reports=");
    Serial.print(thighCount);
    Serial.print(" shank_reports=");
    Serial.println(shankCount);
  }

  // Emit at a steady cadence: build the line once, send it BOTH ways (serial
  // wired fallback + UDP to the laptop). Same contract for SerialSource and
  // NetworkSource.
  if (now - lastEmit >= EMIT_MS) {
    lastEmit = now;

    char line[160];
    snprintf(line, sizeof(line),
             "%lu,%lu,%.2f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f",
             (unsigned long)seq, (unsigned long)now, roughKneeAngleDeg(),
             tw, tx, ty, tz, sw, sx, sy, sz);

    Serial.println(line);                       // wired fallback

    udp.beginPacket(dest, UDP_PORT);            // wireless to the laptop
    udp.write((const uint8_t*)line, strlen(line));
    udp.write((uint8_t)'\n');
    udp.endPacket();

    seq++;
  }
}
