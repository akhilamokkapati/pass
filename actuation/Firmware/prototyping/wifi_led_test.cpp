// WiFi + status LED bring-up, XIAO ESP32-S3 (COM10, actuation board).
// Onboard orange user LED on GPIO21, active LOW (LOW = lit): solid = joined
// WiFi, blinking = searching. Same network/pattern as feet/firmware/foot_left.ino.

#include <WiFi.h>

#define WIFI_SSID "TP-Link_1285"
#define WIFI_PASS "15289346"

#define LED_PIN 21
#define LED_ON  LOW

uint32_t lastWifiTry = 0;

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);         // keep the radio awake so status stays live
  WiFi.setAutoReconnect(true);  // stack reconnects in the background, no blocking
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(250);
  Serial.print("# wifi ");
  Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON); // off until we know the WiFi state

  connectWifi();
}

void loop() {
  uint32_t now = millis();

  // Non-blocking reconnect: retry every 10s if the link is down, without
  // waiting (a blocking wait here would freeze the LED update too).
  if (WiFi.status() != WL_CONNECTED && now - lastWifiTry > 10000) {
    lastWifiTry = now;
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  // status LED: solid = joined, blinking = searching
  if (WiFi.status() == WL_CONNECTED) digitalWrite(LED_PIN, LED_ON);
  else digitalWrite(LED_PIN, ((now / 300) % 2) ? LED_ON : !LED_ON);
}
