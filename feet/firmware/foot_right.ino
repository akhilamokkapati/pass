/*
 * foot_right.ino  -  PASS RIGHT foot insole node, wireless (WiFi UDP, v1).
 * Identical to foot_left.ino except UNIT_ID. Values are already inverted
 * (pressure-up), so the laptop receiver does NOT invert again. Reports LiPo
 * battery percent as a trailing field (read on ADC1 pin GPIO5 - never an ADC2
 * pin like GPIO14, which conflicts with WiFi).
 */
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_task_wdt.h>

// ===== per-foot id =====
#define UNIT_ID   "foot_right"
// ===== network (same on both feet) =====
#define WIFI_SSID "TP-Link_1285"    // travel router, now bridged to SUTD_Guest (has internet)
#define WIFI_PASS "15289346"
// Directed subnet broadcast: the router delivers it to every 192.168.0.x client,
// including the laptop even when it is on the 5 GHz band of the same router.
#define DEST_IP   "192.168.0.255"
#define UDP_PORT  5006

// ===== explicit GPIO pin map (XIAO ESP32-S3) =====
#define PIN_SIG 1   // D0  GPIO1  ADC in, 220k pull-up to 3V3
#define PIN_S0  2   // D1  GPIO2  mux select
#define PIN_S1  3   // D2  GPIO3
#define PIN_S2  4   // D3  GPIO4
#define PIN_S3  7   // D8  GPIO7
// mux EN -> GND, COMMON -> GND

// ===== status LED =====
// Onboard orange user LED on GPIO21 (active LOW: LOW = lit). Solid = joined WiFi,
// blink = searching, off = not powered. No external wiring needed.
#define LED_PIN 21
#define LED_ON  LOW

// ===== battery sense =====
// External divider: BAT+ -> 100k -> PIN_VBAT -> 100k -> GND (halves the voltage).
// PIN_VBAT MUST be an ADC1 pin (GPIO1-10) so it works while WiFi is on.
#define PIN_VBAT     5      // D4 / GPIO5 (ADC1); free on the feet
#define VBAT_DIVIDER 2.0f   // 100k/100k -> x2. Change if you use other resistors.
#define VBAT_CAL     1.000f // multimeter V / reported V, if it drifts
#define BATT_MS      5000   // recompute battery every 5 s

#define ADC_MAX   4095
#define SAMPLE_MS 10        // scan all 16 zones at 100 Hz
#define SEND_MS   100       // send a frame at 10 Hz

// ===== fault recovery =====
// Hardware watchdog: force-reboots the board if loop() ever truly hangs,
// instead of it silently dying with the status LED frozen solid, needing a
// physical power-cycle to notice or fix.
#define WDT_TIMEOUT_S 8
// Zombie-WiFi guard: WiFi.status() is a cached flag that can keep reporting
// WL_CONNECTED after the AP has actually dropped the association. A
// genuinely joined station always has a real (negative) RSSI, so RSSI==0
// while "connected" is the tell - force a disconnect after enough bad reads
// so the retry logic below actually rejoins.
#define ZOMBIE_CHECK_MS 3000
#define ZOMBIE_LIMIT    3

static const uint8_t SEL[4] = {PIN_S0, PIN_S1, PIN_S2, PIN_S3};
WiFiUDP udp;
IPAddress dest;
uint32_t frame = 0, lastSample = 0, lastSend = 0, lastBatt = 0, lastWifiTry = 0;
int inv[16];
int battPct = 0;

void selCh(uint8_t c) {
  for (uint8_t i = 0; i < 4; i++) digitalWrite(SEL[i], (c >> i) & 1);
}

int readCh(uint8_t c) {
  selCh(c);
  delayMicroseconds(120);          // mux settle
  analogRead(PIN_SIG);             // dummy read
  delayMicroseconds(80);
  int a = 0;
  for (int i = 0; i < 4; i++) { a += analogRead(PIN_SIG); delayMicroseconds(40); }
  return a / 4;
}

float readBatteryVoltage() {
  uint32_t mvSum = 0;
  for (int i = 0; i < 8; i++) { mvSum += analogReadMilliVolts(PIN_VBAT); delay(1); }
  return (mvSum / 8.0f) * VBAT_DIVIDER / 1000.0f * VBAT_CAL;
}

int getLiPoPercentage(float v) {
  if (v >= 4.20f) return 100;
  if (v <= 3.30f) return 0;
  if (v > 3.95f) return 80 + (int)((v - 3.95f) / (4.20f - 3.95f) * 20.0f);
  if (v > 3.80f) return 50 + (int)((v - 3.80f) / (3.95f - 3.80f) * 30.0f);
  if (v > 3.65f) return 20 + (int)((v - 3.65f) / (3.80f - 3.65f) * 30.0f);
  if (v > 3.40f) return 5  + (int)((v - 3.40f) / (3.65f - 3.40f) * 15.0f);
  return (int)((v - 3.30f) / (3.40f - 3.30f) * 5.0f);
}

// Arms the hardware watchdog. Called at the END of setup(), after the blocking
// WiFi-join wait, so normal startup delays never trip a false reboot. Covers
// both the old and new (core 3.x) esp_task_wdt init signatures so the build
// doesn't depend on which core version is installed.
void wdtBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdtConfig = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);     // stack reconnects in the background, no blocking
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(250);
  dest.fromString(DEST_IP);
  // Serial.print can BLOCK on native USB-CDC if nothing has the port open and
  // reading - guard every print with `if (Serial)` so a board running
  // untethered (no laptop watching) can never stall its own WiFi loop on an
  // unread serial write. Found via the actuation board's downlink test.
  if (Serial) {
    Serial.print("# " UNIT_ID " wifi ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED ");
    Serial.print(WiFi.localIP());
    Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  for (uint8_t i = 0; i < 4; i++) { pinMode(SEL[i], OUTPUT); digitalWrite(SEL[i], LOW); }
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);   // off until we know the WiFi state
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SIG, ADC_11db);
  analogSetPinAttenuation(PIN_VBAT, ADC_11db);
  connectWifi();
  udp.begin(UDP_PORT);
  wdtBegin();   // arm last, after the blocking WiFi join above is done
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

  // Non-blocking reconnect: retry every 10 s if the link is down, WITHOUT waiting
  // (a blocking wait here froze the stream for ~15 s and showed as "stale").
  // Sampling and sends keep running; a send just fails harmlessly while down.
  if (WiFi.status() != WL_CONNECTED && now - lastWifiTry > 10000) {
    lastWifiTry = now;
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  // status LED: solid = joined, blinking = searching
  if (WiFi.status() == WL_CONNECTED) digitalWrite(LED_PIN, LED_ON);
  else digitalWrite(LED_PIN, ((now / 300) % 2) ? LED_ON : !LED_ON);

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    for (uint8_t c = 0; c < 16; c++) inv[c] = ADC_MAX - readCh(c);
  }

  if (now - lastBatt >= BATT_MS) {
    lastBatt = now;
    float v = readBatteryVoltage();
    battPct = getLiPoPercentage(v);
    if (Serial) {
      Serial.print("# wifi "); Serial.print(WiFi.status() == WL_CONNECTED ? "UP " : "DOWN ");
      Serial.print(WiFi.localIP());
      Serial.print("  rssi "); Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0); Serial.print(" dBm");
      Serial.print("  battery "); Serial.print(v, 3);
      Serial.print(" V  "); Serial.print(battPct); Serial.println(" %");
    }
  }

  if (now - lastSend >= SEND_MS) {
    lastSend = now;
    char p[220];
    int n = snprintf(p, sizeof(p), "%s,%lu,%lu",
                     UNIT_ID, (unsigned long)frame, (unsigned long)now);
    for (uint8_t c = 0; c < 16; c++)
      n += snprintf(p + n, sizeof(p) - n, ",%d", inv[c]);
    n += snprintf(p + n, sizeof(p) - n, ",%d", battPct);
    udp.beginPacket(dest, UDP_PORT);
    udp.write((const uint8_t *)p, strlen(p));
    udp.endPacket();
    frame++;
  }
}
