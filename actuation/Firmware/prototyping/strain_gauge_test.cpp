// Wheatstone bridge strain gauge amp test, XIAO ESP32-S3.
// Raw ADC counts only, no voltage/force conversion yet.

#include <Arduino.h>

const int STRAIN_GAUGE_PIN = D0;

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 200;

void setup() {
  Serial.begin(115200);
  delay(500);
}

void loop() {
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;

  Serial.println(analogRead(STRAIN_GAUGE_PIN));
}
