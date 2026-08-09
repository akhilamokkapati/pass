/*
 * wifi_bringup.ino
 * PASS actuation module - first WiFi bring-up. Joins the same network as
 * feet/knee/hip and proves the dashboard can talk to this board in BOTH
 * directions: it broadcasts a telemetry heartbeat OUT (so the dashboard's
 * Actuation card can show online/offline like every other module), and
 * listens for commands IN on a separate port (so the "twist/untwist",
 * "set force level" etc. dashboard buttons have somewhere to land).
 *
 * No motor, driver, or strain gauge wired into this file - see
 * actuation_master.cpp for that hardware bring-up (Serial-only control right
 * now). This is deliberately just the network layer, kept separate so it's
 * testable with nothing but the bare ESP32 on USB, per Actuation Context.md
 * section 5 ("quick test to learn the architecture", mocked hardware first).
 * Once the two are merged, real commands received here will drive the real
 * motor/PID loop instead of just being logged.
 *
 * Wire format matches the rest of the platform (unit_id-prefixed,
 * comma-separated), and matches webapp/backend/ingest.py exactly:
 *   OUT (telemetry, this board -> laptop, UDP :5007):
 *     actuation,seq,t_ms,tension_n,state\n
 *     tension_n/state are placeholders (0.0 / "idle") until the strain gauge
 *     and motor are wired in.
 *   IN  (commands, laptop -> this board, UDP :5008):
 *     actuation,cmd,value\n
 *     e.g. "actuation,set_force,10.0" or "actuation,twist,1". Logged over
 *     serial only for now - nothing acts on it yet.
 *
 * Requires AP/client isolation OFF on the router (confirmed working via a
 * throwaway test board before this file existed) - without that, the laptop
 * cannot reach this board at all, only the reverse.
 *
 * ROOT-CAUSE NOTE (found while bringing this file up): Serial.print/println
 * can BLOCK on the XIAO ESP32-S3's native USB-CDC if nothing has the port
 * open and actively reading - this stalled the whole loop() and, with it,
 * WiFi sends, even though udp.beginPacket()/endPacket() kept reporting
 * success. A board with a monitor attached never shows it; a board running
 * untethered (the real deployment case - no laptop watching) would. Every
 * Serial call below is guarded with `if (Serial)` so it can never block.
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
#define EMIT_MS 200        // 5 Hz heartbeat - plenty for a status-only line

// ---- fault recovery -----------------------------------------------------
// Hardware watchdog: force-reboots the board if loop() ever truly hangs,
// instead of it silently dying with the status LED frozen solid, needing a
// physical power-cycle to notice or fix.
#define WDT_TIMEOUT_S 8
// Zombie-WiFi guard: WiFi.status() is a cached flag that can keep reporting
// WL_CONNECTED after the AP has actually dropped the association. A
// genuinely joined station always has a real (negative) RSSI, so RSSI==0
// while "connected" is the tell. Unlike the feet, this board has no periodic
// re-begin() retry today - the forced disconnect below is what lets
// auto-reconnect actually kick in instead of streaming into the void.
#define ZOMBIE_CHECK_MS 3000
#define ZOMBIE_LIMIT    3

#define LED_PIN 21
#define LED_ON  LOW

WiFiUDP txUdp;
WiFiUDP rxUdp;
IPAddress dest;

uint32_t seq = 0;
uint32_t lastEmit = 0;
uint32_t lastHealth = 0;
uint32_t rxCount = 0;
uint32_t udpBeginOk = 0, udpBeginFail = 0, udpEndOk = 0, udpEndFail = 0;

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

void wifiBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  dest.fromString(DEST_IP);
}

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 3000) {}

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);

  if (Serial) Serial.println("# PASS " UNIT_ID " wifi bring-up");

  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  if (Serial) {
    Serial.print("# " UNIT_ID " wifi ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
    Serial.println(WiFi.localIP());
  }
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);   // force max TX power, matching knee/hip

  txUdp.begin(TELEMETRY_PORT);
  rxUdp.begin(COMMAND_PORT);
  if (Serial) {
    Serial.print("# telemetry -> "); Serial.print(dest); Serial.print(":"); Serial.println(TELEMETRY_PORT);
    Serial.print("# commands listening on :"); Serial.println(COMMAND_PORT);
  }
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

  // Yield once per loop so a tight loop() can't monopolize CPU time right
  // when the WiFi stack needs a window to actually transmit - this exact
  // symptom (udp begin/end report success, but nothing arrives) is what a
  // missing yield caused on the knee boards earlier; see knee_left.ino.
  delay(1);

  if (WiFi.status() == WL_CONNECTED) digitalWrite(LED_PIN, LED_ON);
  else digitalWrite(LED_PIN, ((now / 300) % 2) ? LED_ON : !LED_ON);

  // commands in - stub only: log what arrives, nothing acts on it yet
  int packetSize = rxUdp.parsePacket();
  if (packetSize) {
    char buf[128];
    int len = rxUdp.read(buf, sizeof(buf) - 1);
    if (len > 0) buf[len] = 0; else buf[0] = 0;
    rxCount++;
    if (Serial) {
      Serial.print("# CMD RX from "); Serial.print(rxUdp.remoteIP());
      Serial.print(" -> \""); Serial.print(buf); Serial.println("\"");
    }
    digitalWrite(LED_PIN, !LED_ON);
    delay(30);
    digitalWrite(LED_PIN, LED_ON);
  }

  // telemetry out - placeholder values until strain gauge/motor are wired
  if (now - lastEmit >= EMIT_MS) {
    lastEmit = now;
    char line[80];
    snprintf(line, sizeof(line), UNIT_ID ",%lu,%lu,%.2f,%s",
             (unsigned long)seq, (unsigned long)now, 0.0f, "idle");
    if (Serial) Serial.println(line);
    int beginOk = txUdp.beginPacket(dest, TELEMETRY_PORT);
    if (beginOk) udpBeginOk++; else udpBeginFail++;
    txUdp.write((const uint8_t *)line, strlen(line));
    txUdp.write((uint8_t)'\n');
    int endOk = txUdp.endPacket();
    if (endOk) udpEndOk++; else udpEndFail++;
    seq++;
  }

  if (now - lastHealth >= 5000) {
    lastHealth = now;
    if (Serial) {
      Serial.print("# health wifi "); Serial.print(WiFi.status() == WL_CONNECTED ? "UP" : "DOWN");
      Serial.print(" ip "); Serial.print(WiFi.localIP());
      Serial.print(" rssi "); Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
      Serial.print(" cmdRxCount="); Serial.print(rxCount);
      Serial.print(" udp begin ok="); Serial.print(udpBeginOk); Serial.print(" fail="); Serial.print(udpBeginFail);
      Serial.print(" end ok="); Serial.print(udpEndOk); Serial.print(" fail="); Serial.println(udpEndFail);
    }
  }
}
