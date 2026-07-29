// Strain gauge test via HX711 (bridge completed with 3 fixed resistors),
// XIAO ESP32-S3. Teleplot-formatted output (>name:value) for live plotting.

#include <Arduino.h>
#include <HX711.h>

const int HX711_DT = D0;
const int HX711_SCK = D1;

HX711 scale;

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 200;

void setup() {
  Serial.begin(115200);
  delay(500);

  scale.begin(HX711_DT, HX711_SCK);
}

void loop() {
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;

  if (scale.is_ready()) {
    Serial.print(">strain:");
    Serial.println(-scale.read());
  } else {
    Serial.println(F("HX711 not ready"));
  }
}
