/*
 * hip_wifi.ino - PASS hip module, XIAO ESP32-S3 + 1x BNO085 -> WiFi UDP.
 *
 * Joins the travel router (30.007) like the feet and unicasts the pelvis
 * quaternion to the laptop over UDP, plus a serial fallback. Uses the SAME
 * minimal WiFi sequence the working feet use, and the hardened BNO085 init from
 * the knee (retry begin + delays around enabling the report) so it can never get
 * stuck streaming a frozen identity quaternion.
 *
 * LINE (unit_id-prefixed, hip has its own port so it never collides):
 *     hip,seq,t_ms,qw,qx,qy,qz\n
 *
 * WIRING (single BNO085 on I2C): 3V3->VIN, GND->GND, SDA->D4, SCL->D5,
 *   PS0/PS1->GND (force I2C). Address auto-detected (0x4A or 0x4B via ADO).
 */

#include <Wire.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include "SparkFun_BNO080_Arduino_Library.h"

// ===== identity + network (same router as feet/knee) =====
#define UNIT_ID   "hip"
#define WIFI_SSID "30.007"
#define WIFI_PASS "awesomesauce144"
// Broadcast to the whole 30.007 subnet, so the laptop receives no matter what IP
// it or the node ends up with (removes the "laptop must be .100 / connect first"
// trap). The receiver just binds the port.
#define DEST_IP   "192.168.0.255"
#define UDP_PORT  5004              // hip port (feet 5006, knee 5005)

static const uint32_t I2C_HZ    = 100000; // BNO085 clock-stretching: keep at 100 kHz
static const uint16_t REPORT_MS = 10;     // game rotation vector interval (~100 Hz)
static const uint32_t EMIT_MS   = 20;     // send cadence (~50 Hz)

// BNO085 hardened-init timing (post-reset boot window).
static const uint32_t BOOT_DELAY_MS  = 200;
static const uint8_t  BEGIN_ATTEMPTS = 3;
static const uint32_t BEGIN_RETRY_MS = 100;
static const uint32_t PRE_ENABLE_MS  = 150;
static const uint32_t POST_ENABLE_MS = 50;
static const uint32_t SILENT_TIMEOUT_MS = 1000;
static const uint32_t HEALTH_MS         = 5000;

WiFiUDP udp;
IPAddress dest;
BNO080 imu;

float qw = 1, qx = 0, qy = 0, qz = 0;     // identity until first report
uint32_t seq = 0, lastEmit = 0, lastReport = 0, lastHealth = 0, reportCount = 0;
bool imuOk = false;

// Bring up the single BNO085, trying both I2C addresses (ADO->GND=0x4A, ADO->3V3=0x4B).
bool initSensor() {
  const uint8_t addrs[2] = {0x4A, 0x4B};
  for (uint8_t a = 0; a < 2; a++) {
    for (uint8_t attempt = 0; attempt < BEGIN_ATTEMPTS; attempt++) {
      if (imu.begin(addrs[a], Wire)) {
        delay(PRE_ENABLE_MS);
        imu.enableGameRotationVector(REPORT_MS);
        delay(POST_ENABLE_MS);
        Serial.print("# hip BNO085 found at 0x"); Serial.println(addrs[a], HEX);
        return true;
      }
      delay(BEGIN_RETRY_MS);
    }
  }
  Serial.println("# hip BNO085 NOT FOUND (check SDA=D4/SCL=D5, 3V3, PS0/PS1->GND, ADO)");
  return false;
}

// Minimal join sequence, matching the working feet, plus setSleep(false) so the
// radio never naps between sends (that nap is what makes the stream feel laggy /
// go "stale"). setSleep is applied after the join is established, in setup.
void wifiBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  dest.fromString(DEST_IP);
}

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 3000) { }

  Wire.begin(D4, D5);        // XIAO I2C: SDA=D4, SCL=D5
  Wire.setClock(I2C_HZ);
  Serial.println("# PASS hip IMU bring-up (wireless)");

  // Block-and-wait for the join here (proven feet pattern); sensor inits after.
  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  Serial.print("# hip wifi ");
  Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
  Serial.print(WiFi.localIP());
  Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
  WiFi.setSleep(false);      // keep radio awake -> smooth 50 Hz, no "stale" gaps
  udp.begin(UDP_PORT);

  delay(BOOT_DELAY_MS);
  imuOk = initSensor();

  uint32_t now = millis();
  lastReport = now; lastHealth = now;
  Serial.println("# streaming: hip,seq,t_ms,qw,qx,qy,qz");
}

void loop() {
  uint32_t now = millis();

  if (imu.dataAvailable()) {
    qw = imu.getQuatReal(); qx = imu.getQuatI();
    qy = imu.getQuatJ();    qz = imu.getQuatK();
    lastReport = now; reportCount++;
  }

  // watchdog: re-enable the report if a found sensor goes silent (frozen-identity guard)
  if (imuOk && (now - lastReport) > SILENT_TIMEOUT_MS) {
    imu.enableGameRotationVector(REPORT_MS);
    lastReport = now;
    Serial.println("# WARN hip silent >1s, re-enabling game rotation vector");
  }

  if (now - lastHealth >= HEALTH_MS) {
    lastHealth = now;
    Serial.print("# health hip_reports="); Serial.println(reportCount);
  }

  if (now - lastEmit >= EMIT_MS) {
    lastEmit = now;
    char line[96];
    snprintf(line, sizeof(line), "%s,%lu,%lu,%.6f,%.6f,%.6f,%.6f",
             UNIT_ID, (unsigned long)seq, (unsigned long)now, qw, qx, qy, qz);
    Serial.println(line);                        // wired fallback
    udp.beginPacket(dest, UDP_PORT);             // wireless
    udp.write((const uint8_t*)line, strlen(line));
    udp.write((uint8_t)'\n');
    udp.endPacket();
    seq++;
  }
}
