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
#include <esp_task_wdt.h>
#include "SparkFun_BNO080_Arduino_Library.h"

// ===== identity + network (same router as feet/knee) =====
#define UNIT_ID   "hip"
#define WIFI_SSID "TP-Link_1285"
#define WIFI_PASS "15289346"
// Broadcast to the whole 30.007 subnet, so the laptop receives no matter what IP
// it or the node ends up with (removes the "laptop must be .100 / connect first"
// trap). The receiver just binds the port.
#define DEST_IP   "192.168.0.255"
#define UDP_PORT  5004              // hip port (feet 5006, knee 5005)

// ===== status LED =====
// Onboard orange user LED on GPIO21 (active LOW: LOW = lit). Solid = joined WiFi,
// blink = searching, off = not powered. No external wiring needed.
#define LED_PIN 21
#define LED_ON  LOW

// ===== battery telemetry (optional) =====
// The XIAO ESP32-S3 does NOT expose the LiPo voltage internally, so to report
// battery you add a divider: BAT+ -> 220k -> PIN_VBAT -> 220k -> GND (halves the
// voltage into a spare ADC pin). Set ENABLE_BATTERY 1 after wiring it, then the
// node appends a trailing battery-percent field the dashboard reads.
#define ENABLE_BATTERY 0
#define PIN_VBAT       1            // D0 / GPIO1 (ADC1); free while I2C uses D4/D5

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

// ---- fault recovery ---------------------------------------------------
// Hardware watchdog: if loop() ever truly hangs (e.g. an I2C bus lockup from
// the BNO085's clock-stretching), this force-reboots the board instead of it
// silently dying with the status LED frozen solid, needing a power-cycle.
static const uint32_t WDT_TIMEOUT_S = 8;
// Zombie-WiFi guard: WiFi.status() is a cached flag that can keep reporting
// WL_CONNECTED after the AP has actually dropped the association. A
// genuinely joined station always has a real (negative) RSSI, so RSSI==0
// while "connected" is the tell - force a disconnect after enough bad reads
// so auto-reconnect actually rejoins.
static const uint32_t ZOMBIE_CHECK_MS = 3000;
static const uint8_t  ZOMBIE_LIMIT    = 3;

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
        // Serial.print can BLOCK on native USB-CDC if nothing has the port open
        // and reading - guard every print with `if (Serial)` so a board running
        // untethered (no laptop watching) can never stall its own WiFi loop on
        // an unread serial write. Found via the actuation board's downlink test.
        if (Serial) { Serial.print("# hip BNO085 found at 0x"); Serial.println(addrs[a], HEX); }
        return true;
      }
      delay(BEGIN_RETRY_MS);
    }
  }
  if (Serial) Serial.println("# hip BNO085 NOT FOUND (check SDA=D4/SCL=D5, 3V3, PS0/PS1->GND, ADO)");
  return false;
}

// Arms the hardware watchdog. Called at the END of setup(), after the blocking
// WiFi-join wait and sensor-init retries are done, so normal startup delays
// never trip a false reboot. Covers both the old and new (core 3.x) esp_task_wdt
// init signatures so the build doesn't depend on which core version is installed.
void wdtBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdtConfig = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
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
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);   // off until we know the WiFi state
#if ENABLE_BATTERY
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_VBAT, ADC_11db);
#endif
  if (Serial) Serial.println("# PASS hip IMU bring-up (wireless)");

  // Block-and-wait for the join here (proven feet pattern); sensor inits after.
  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  if (Serial) {
    Serial.print("# hip wifi ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
    Serial.print(WiFi.localIP());
    Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
  }
  WiFi.setSleep(false);      // keep radio awake -> smooth 50 Hz, no "stale" gaps
  udp.begin(UDP_PORT);

  delay(BOOT_DELAY_MS);
  imuOk = initSensor();

  uint32_t now = millis();
  lastReport = now; lastHealth = now;

  wdtBegin();   // arm last, after all the blocking setup work above is done

  if (Serial) Serial.println("# streaming: hip,seq,t_ms,qw,qx,qy,qz");
}

void loop() {
  uint32_t now = millis();
  esp_task_wdt_reset();   // feed the watchdog every pass - see wdtBegin()

  // Zombie-WiFi check (see ZOMBIE_* above).
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

  if (imu.dataAvailable()) {
    qw = imu.getQuatReal(); qx = imu.getQuatI();
    qy = imu.getQuatJ();    qz = imu.getQuatK();
    lastReport = now; reportCount++;
  }

  // watchdog: re-enable the report if a found sensor goes silent (frozen-identity guard)
  if (imuOk && (now - lastReport) > SILENT_TIMEOUT_MS) {
    imu.enableGameRotationVector(REPORT_MS);
    lastReport = now;
    if (Serial) Serial.println("# WARN hip silent >1s, re-enabling game rotation vector");
  }

  if (now - lastHealth >= HEALTH_MS) {
    lastHealth = now;
    if (Serial) { Serial.print("# health hip_reports="); Serial.println(reportCount); }
  }

  if (now - lastEmit >= EMIT_MS) {
    lastEmit = now;
    char line[110];
    int n = snprintf(line, sizeof(line), "%s,%lu,%lu,%.6f,%.6f,%.6f,%.6f",
                     UNIT_ID, (unsigned long)seq, (unsigned long)now, qw, qx, qy, qz);
#if ENABLE_BATTERY
    long acc = 0;
    for (int i = 0; i < 8; i++) acc += analogRead(PIN_VBAT);
    float vbat = (acc / 8.0f) / 4095.0f * 3.3f * 2.0f;   // undo the /2 divider
    int pct = (int)((vbat - 3.30f) / (4.20f - 3.30f) * 100.0f);
    pct = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
    snprintf(line + n, sizeof(line) - n, ",%d", pct);    // trailing battery percent
#endif
    if (Serial) Serial.println(line);             // wired fallback (guarded: see initSensor note)
    udp.beginPacket(dest, UDP_PORT);             // wireless
    udp.write((const uint8_t*)line, strlen(line));
    udp.write((uint8_t)'\n');
    udp.endPacket();
    seq++;
  }
}
