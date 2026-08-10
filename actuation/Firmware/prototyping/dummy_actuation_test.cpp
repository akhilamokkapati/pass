/*
 * dummy_actuation_test.cpp
 * TEMPORARY test firmware: simulates the actuation board's tension_n and
 * state in software instead of reading a real strain gauge/motor, so the
 * dashboard's Session tab (countdown -> twisting -> ready -> exercising ->
 * stop, force stop, next-weight recommendation) can be exercised end-to-end
 * on real hardware before the actual actuator is wired in. Not part of the
 * real actuation firmware - see wifi_bringup.cpp for that (this file copies
 * its WiFi/UDP bring-up wholesale and adds the tension simulation on top).
 *
 * Same wire format as wifi_bringup.cpp / webapp/backend/ingest.py:
 *   OUT (telemetry, this board -> laptop, UDP :5007):
 *     actuation,seq,t_ms,tension_n,state
 *   IN  (commands, laptop -> this board, UDP :5008), format confirmed
 *   against webapp/backend/ingest.py's send_command:
 *     actuation,cmd,value
 *       set_force <kg>  - sets the simulated target, no movement yet
 *       twist     <kg>  - sets target AND starts ramping tension up toward it
 *       untwist   *     - ramps tension back down to 0
 *       stop      *     - same as untwist (used by both in-session Stop and
 *                         the dashboard's Force Stop)
 *
 * Not a physics simulation - tension ramps linearly toward whatever target
 * was last commanded, at a speed tuned so "twisting" reaches the dashboard's
 * READY_MARGIN (95% of target) in a couple of seconds like a real twist
 * would, giving the phase state machine in useActuationSession.js something
 * real to key off instead of a dashboard-side fake.
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_task_wdt.h>

#define UNIT_ID "actuation"
#define WIFI_SSID "TP-Link_1285"
#define WIFI_PASS "15289346"
#define DEST_IP "192.168.0.255"
#define TELEMETRY_PORT 5007
#define COMMAND_PORT   5008
#define EMIT_MS 50          // 20 Hz, matches the dashboard's own broadcast rate

#define WDT_TIMEOUT_S 8
#define ZOMBIE_CHECK_MS 3000
#define ZOMBIE_LIMIT    3

#define LED_PIN 21
#define LED_ON  LOW

WiFiUDP txUdp;
WiFiUDP rxUdp;
IPAddress dest;

uint32_t seq = 0;
uint32_t lastEmit = 0;
uint32_t lastTick = 0;
uint32_t lastHealth = 0;

float targetKg = 0.0f;
float tensionKg = 0.0f;
bool  ramping = false;
const char* stateStr = "idle";

const float RAMP_RATE_KG_S = 1.5f;   // simulated twist/untwist speed

void wdtBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdtConfig = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
}

void wifiBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  dest.fromString(DEST_IP);
}

void handleCommand(char *buf) {
  char *tok = strtok(buf, ",");
  if (!tok || strcmp(tok, UNIT_ID) != 0) return;
  char *cmd = strtok(NULL, ",");
  char *valStr = strtok(NULL, ",");
  float val = valStr ? atof(valStr) : 0.0f;
  if (!cmd) return;

  if (strcmp(cmd, "set_force") == 0) {
    targetKg = val;
  } else if (strcmp(cmd, "twist") == 0) {
    targetKg = val;
    ramping = true;
    stateStr = "twisting";
  } else if (strcmp(cmd, "untwist") == 0 || strcmp(cmd, "stop") == 0) {
    targetKg = 0.0f;
    ramping = true;
    stateStr = "untwisting";
  }
}

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 3000) {}

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);
  if (Serial) Serial.println("# PASS actuation DUMMY (simulated tension) bring-up");

  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  if (Serial) {
    Serial.print("# actuation wifi ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
    Serial.println(WiFi.localIP());
  }
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);

  txUdp.begin(TELEMETRY_PORT);
  rxUdp.begin(COMMAND_PORT);
  lastTick = millis();
  wdtBegin();
}

void loop() {
  uint32_t now = millis();
  esp_task_wdt_reset();

  static uint32_t lastZombieCheck = 0;
  static uint8_t zombieStreak = 0;
  if (now - lastZombieCheck >= ZOMBIE_CHECK_MS) {
    lastZombieCheck = now;
    if (WiFi.status() == WL_CONNECTED && WiFi.RSSI() == 0) {
      if (++zombieStreak >= ZOMBIE_LIMIT) {
        WiFi.disconnect();
        zombieStreak = 0;
      }
    } else {
      zombieStreak = 0;
    }
  }

  delay(1);
  if (WiFi.status() == WL_CONNECTED) digitalWrite(LED_PIN, LED_ON);
  else digitalWrite(LED_PIN, ((now / 300) % 2) ? LED_ON : !LED_ON);

  int packetSize = rxUdp.parsePacket();
  if (packetSize) {
    char buf[128];
    int len = rxUdp.read(buf, sizeof(buf) - 1);
    if (len > 0) { buf[len] = 0; handleCommand(buf); }
  }

  // Simulate tension ramping toward whatever was last commanded.
  float dt = (now - lastTick) / 1000.0f;
  lastTick = now;
  if (ramping && dt > 0 && dt < 1.0f) {
    float step = RAMP_RATE_KG_S * dt;
    if (tensionKg < targetKg) tensionKg = min(targetKg, tensionKg + step);
    else if (tensionKg > targetKg) tensionKg = max(targetKg, tensionKg - step);
    if (fabs(tensionKg - targetKg) < 0.01f) {
      ramping = false;
      stateStr = (targetKg > 0.05f) ? "holding" : "idle";
    }
  }

  if (now - lastEmit >= EMIT_MS) {
    lastEmit = now;
    char line[80];
    snprintf(line, sizeof(line), UNIT_ID ",%lu,%lu,%.2f,%s",
             (unsigned long)seq, (unsigned long)now, tensionKg, stateStr);
    if (Serial) Serial.println(line);
    txUdp.beginPacket(dest, TELEMETRY_PORT);
    txUdp.write((const uint8_t *)line, strlen(line));
    txUdp.write((uint8_t)'\n');
    txUdp.endPacket();
    seq++;
  }

  if (now - lastHealth >= 5000) {
    lastHealth = now;
    if (Serial) {
      Serial.print("# health wifi "); Serial.print(WiFi.status() == WL_CONNECTED ? "UP" : "DOWN");
      Serial.print(" ip "); Serial.print(WiFi.localIP());
      Serial.print(" rssi "); Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
      Serial.print(" gw "); Serial.println(WiFi.gatewayIP());
    }
  }
}
