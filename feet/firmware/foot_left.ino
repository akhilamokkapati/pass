/*
 * foot_left.ino  -  PASS LEFT foot insole node, wireless (WiFi UDP, v1).
 * Same 16-zone scan as the serial firmware; instead of USB it joins the travel
 * router and sends one UDP frame per 100 ms to the laptop. Values are already
 * inverted (pressure-up), so the laptop receiver does NOT invert again.
 */
#include <WiFi.h>
#include <WiFiUdp.h>

// ===== per-foot id =====
#define UNIT_ID   "foot_left"
// ===== network (same on both feet) =====
#define WIFI_SSID "30.007"
#define WIFI_PASS "awesomesauce144"
#define LAPTOP_IP "192.168.0.100"
#define UDP_PORT  5006

// ===== explicit GPIO pin map (XIAO ESP32-S3) =====
#define PIN_SIG 1   // D0  GPIO1  ADC in, 220k pull-up to 3V3
#define PIN_S0  2   // D1  GPIO2  mux select
#define PIN_S1  3   // D2  GPIO3
#define PIN_S2  4   // D3  GPIO4
#define PIN_S3  7   // D8  GPIO7
// mux EN -> GND, COMMON -> GND

#define ADC_MAX   4095
#define SAMPLE_MS 10        // scan all 16 zones at 100 Hz
#define SEND_MS   100       // send a frame at 10 Hz

static const uint8_t SEL[4] = {PIN_S0, PIN_S1, PIN_S2, PIN_S3};
WiFiUDP udp;
IPAddress dest;
uint32_t frame = 0, lastSample = 0, lastSend = 0;
int inv[16];

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

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // keep the radio awake so 10 Hz UDP is not dropped
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(250);
  dest.fromString(LAPTOP_IP);
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
  connectWifi();
  udp.begin(UDP_PORT);
}

void loop() {
  uint32_t now = millis();

  // keep the link up if the router drops us
  if (WiFi.status() != WL_CONNECTED) { connectWifi(); return; }

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    for (uint8_t c = 0; c < 16; c++) inv[c] = ADC_MAX - readCh(c);   // invert here
  }

  if (now - lastSend >= SEND_MS) {
    lastSend = now;
    char p[220];
    int n = snprintf(p, sizeof(p), "%s,%lu,%lu",
                     UNIT_ID, (unsigned long)frame, (unsigned long)now);
    for (uint8_t c = 0; c < 16; c++)
      n += snprintf(p + n, sizeof(p) - n, ",%d", inv[c]);
    udp.beginPacket(dest, UDP_PORT);
    udp.write((const uint8_t *)p, strlen(p));
    udp.endPacket();
    frame++;
  }
}
