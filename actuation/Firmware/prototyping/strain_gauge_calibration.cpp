// HX711 interactive calibration, XIAO ESP32-S3.
// 1. Remove all load, send 't' to tare.
// 2. Place a known weight, use '+'/'-' to adjust the factor until the
//    printed reading matches that weight. Note the final factor down.

#include <Arduino.h>
#include <HX711.h>

const int HX711_DT = D0;
const int HX711_SCK = D1;

HX711 scale;

float calibrationFactor = 1.0;
const float ADJUST_STEP = 10.0;

void setup() {
  Serial.begin(115200);
  delay(500);

  scale.begin(HX711_DT, HX711_SCK);
  scale.set_scale(calibrationFactor);

  Serial.println(F("HX711 calibration"));
  Serial.println(F("Remove all load, then send 't' to tare."));
  Serial.println(F("Place a known weight, use '+'/'-' to adjust the factor"));
  Serial.println(F("until the reading matches that weight. Note it down."));
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == '+') {
      calibrationFactor += ADJUST_STEP;
      scale.set_scale(calibrationFactor);
    } else if (c == '-') {
      calibrationFactor -= ADJUST_STEP;
      scale.set_scale(calibrationFactor);
    } else if (c == 't') {
      scale.tare();
      Serial.println(F("Tared."));
    }
  }

  if (scale.is_ready()) {
    Serial.print(F("reading: "));
    Serial.print(scale.get_units(30), 2);
    Serial.print(F("  factor: "));
    Serial.println(calibrationFactor);
  } else {
    Serial.println(F("HX711 not ready"));
  }

  delay(200);
}
