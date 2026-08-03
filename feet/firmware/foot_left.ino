/*
 * foot_left.ino  -  PASS LEFT foot insole node, wireless (WiFi UDP, v1).
 * Same 16-zone scan as the serial firmware; instead of USB it joins the travel
 * router and sends one UDP frame per 100 ms to the laptop. Values are already
 * inverted (pressure-up), so the laptop receiver does NOT invert again.
 *
 * Now also reports LiPo battery percent as a trailing field, which the dashboard
 * Devices panel shows. IMPORTANT: battery is read on an ADC1 pin (GPIO5). Do NOT
 * use ADC2 pins (GPIO11-20, e.g. GPIO14) for this - ADC2 is shared with the WiFi
 * radio and returns garbage while WiFi is on.
 */
#include <WiFi.h>
#include <WiFiUdp.h>

// ===== per-foot id =====
#define UNIT_ID   "foot_left"
// ===== network (same on both feet) =====
#define WIFI_SSID "30.007"
#define WIFI_PASS "awesomesauce144"
// Broadcast to the whole subnet, so the laptop receives no matter what IP it or
// this node ends up with (removes the "laptop must be exactly .100" trap).
#define DEST_IP   "192.168.0.255"
#define UDP_PORT  5006

// ===== explicit GPIO pin map (XIAO ESP32-S3) =====
#define PIN_SIG 1   // D0  GPIO1  ADC in, 220k pull-up to 3V3
#define PIN_S0  2   // D1  GPIO2  mux select
#define PIN_S1  3   // D2  GPIO3
#define PIN_S2  4   // D3  GPIO4
#define PIN_S3  7   // D8  GPIO7
// mux EN -> GND, COMMON -> GND

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

// Averaged battery voltage using the chip's factory (eFuse) mV calibration.
float readBatteryVoltage() {
  uint32_t mvSum = 0;
  for (int i = 0; i < 8; i++) { mvSum += analogReadMilliVolts(PIN_VBAT); delay(1); }
  return (mvSum / 8.0f) * VBAT_DIVIDER / 1000.0f * VBAT_CAL;
}

// LiPo voltage -> approximate state-of-charge percent (your discharge curve).
int getLiPoPercentage(float v) {
  if (v >= 4.20f) return 100;
  if (v <= 3.30f) return 0;
  if (v > 3.95f) return 80 + (int)((v - 3.95f) / (4.20f - 3.95f) * 20.0f);
  if (v > 3.80f) return 50 + (int)((v - 3.80f) / (3.95f - 3.80f) * 30.0f);
  if (v > 3.65f) return 20 + (int)((v - 3.65f) / (3.80f - 3.65f) * 30.0f);
  if (v > 3.40f) return 5  + (int)((v - 3.40f) / (3.65f - 3.40f) * 15.0f);
  return (int)((v - 3.30f) / (3.40f - 3.30f) * 5.0f);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // keep the radio awake so 10 Hz UDP is not dropped
  WiFi.setAutoReconnect(true);     // stack reconnects in the background, no blocking
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(250);
  dest.fromString(DEST_IP);
  Serial.print("# " UNIT_ID " wifi ");
  Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED ");
  Serial.print(WiFi.localIP());
  Serial.print(" -> "); Serial.print(dest); Serial.print(":"); Serial.println(UDP_PORT);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  for (uint8_t i = 0; i < 4; i++) { pinMode(SEL[i], OUTPUT); digitalWrite(SEL[i], LOW); }
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SIG, ADC_11db);
  analogSetPinAttenuation(PIN_VBAT, ADC_11db);   // full range for the divided battery
  connectWifi();
  udp.begin(UDP_PORT);
}

void loop() {
  uint32_t now = millis();

  // Non-blocking reconnect: retry every 10 s if the link is down, WITHOUT waiting
  // (a blocking wait here froze the stream for ~15 s and showed as "stale").
  // Sampling and sends keep running; a send just fails harmlessly while down.
  if (WiFi.status() != WL_CONNECTED && now - lastWifiTry > 10000) {
    lastWifiTry = now;
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    for (uint8_t c = 0; c < 16; c++) inv[c] = ADC_MAX - readCh(c);   // invert here
  }

  if (now - lastBatt >= BATT_MS) {
    lastBatt = now;
    float v = readBatteryVoltage();
    battPct = getLiPoPercentage(v);
    Serial.print("# battery "); Serial.print(v, 3); Serial.print(" V  ");
    Serial.print(battPct); Serial.println(" %");   // watch this to set VBAT_CAL
  }

  if (now - lastSend >= SEND_MS) {
    lastSend = now;
    char p[220];
    int n = snprintf(p, sizeof(p), "%s,%lu,%lu",
                     UNIT_ID, (unsigned long)frame, (unsigned long)now);
    for (uint8_t c = 0; c < 16; c++)
      n += snprintf(p + n, sizeof(p) - n, ",%d", inv[c]);
    n += snprintf(p + n, sizeof(p) - n, ",%d", battPct);   // trailing battery percent
    udp.beginPacket(dest, UDP_PORT);
    udp.write((const uint8_t *)p, strlen(p));
    udp.endPacket();
    frame++;
  }
}
