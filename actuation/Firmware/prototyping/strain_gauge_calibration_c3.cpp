// HX711 multi-point calibration, XIAO ESP32-C3.
// Duplicate of strain_gauge_calibration.cpp (S3) for the C3 board on COM14 -
// this calibrates that board's own physical gauge, it does not transfer to
// the S3 rig's gauges.
//
// Replaces the old single-weight nudge-to-match procedure with a proper
// least-squares fit across several known weights - averaging individual
// per-weight ratios lets noisy light-weight readings skew the result as
// much as clean heavy-weight ones; fitting a line through all points at
// once weighs them correctly instead.
//
// Output convention for easy CSV export: lines starting with '#' are
// status/instructions, plain comma lines are data - copy those straight
// into a spreadsheet to graph against a theoretical prediction.
//
// 1. Remove all load, send 't' to tare. Tare ONCE - not between weights,
//    retaring with a weight already on would zero out the very thing
//    you're trying to measure.
// 2. For each known weight: place it, wait for it to settle by eye, then
//    type the known weight in kg + Enter to capture.
// 3. Repeat for several weights spanning your working range.
// 4. Send 'f' to finish - prints the fitted scale factor (hard-code this
//    into production code), the fitted intercept (should be near 0 if the
//    tare was clean), and a weight,measured,fitted,residual CSV table.

#include <Arduino.h>
#include <HX711.h>

const int HX711_DT = D0;
const int HX711_SCK = D1;

HX711 scale;

const byte READ_SAMPLES = 10;    // averaging per capture - balance of noise vs wait time
const float DEADBAND_KG = 0.3;   // for the live idle preview only
const byte MAX_POINTS = 20;

float pointWeight[MAX_POINTS];
float pointValue[MAX_POINTS];
byte pointCount = 0;

unsigned long lastPreviewMs = 0;
const unsigned long PREVIEW_INTERVAL_MS = 200;

void printPreview() {
  // get_units() already waits internally for the chip to be ready - no
  // need to pre-check is_ready() here (doing so was racing against the
  // chip starting its next conversion right after this call returns).
  float raw = scale.get_units(READ_SAMPLES);
  float filtered = (fabs(raw) < DEADBAND_KG) ? 0.0 : raw;

  Serial.print(F("# live: "));
  Serial.print(filtered, 2);
  Serial.print(F("  ("));
  Serial.print(pointCount);
  Serial.println(F(" points captured)"));
}

void captureSample(float knownWeight) {
  if (pointCount >= MAX_POINTS) {
    Serial.println(F("# max points reached - send 'f' to finish"));
    return;
  }
  float value = scale.get_units(READ_SAMPLES);
  pointWeight[pointCount] = knownWeight;
  pointValue[pointCount] = value;
  pointCount++;
  Serial.print(knownWeight, 3);
  Serial.print(',');
  Serial.println(value, 2);
}

void finishAndFit() {
  if (pointCount < 2) {
    Serial.println(F("# need at least 2 points before finishing"));
    return;
  }

  float sumW = 0, sumV = 0;
  for (byte i = 0; i < pointCount; i++) {
    sumW += pointWeight[i];
    sumV += pointValue[i];
  }
  float meanW = sumW / pointCount;
  float meanV = sumV / pointCount;

  float numerator = 0, denominator = 0;
  for (byte i = 0; i < pointCount; i++) {
    float dw = pointWeight[i] - meanW;
    numerator += dw * (pointValue[i] - meanV);
    denominator += dw * dw;
  }

  if (denominator == 0) {
    Serial.println(F("# all captured weights are identical - can't fit a slope"));
    return;
  }

  float slope = numerator / denominator;
  float intercept = meanV - slope * meanW;

  Serial.print(F("# scale factor (hard-code this): "));
  Serial.println(slope, 4);
  Serial.print(F("# intercept (should be near 0): "));
  Serial.println(intercept, 2);
  Serial.println(F("weight,measured,fitted,residual"));
  for (byte i = 0; i < pointCount; i++) {
    float fitted = slope * pointWeight[i] + intercept;
    float residual = pointValue[i] - fitted;
    Serial.print(pointWeight[i], 3);
    Serial.print(',');
    Serial.print(pointValue[i], 2);
    Serial.print(',');
    Serial.print(fitted, 2);
    Serial.print(',');
    Serial.println(residual, 2);
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  scale.begin(HX711_DT, HX711_SCK);
  scale.set_scale(1.0); // stay in raw (tare-corrected) units - this file finds the factor, doesn't apply one

  Serial.println(F("# HX711 multi-point calibration"));
  Serial.println(F("# 1. Remove all load, send 't' to tare (once)."));
  Serial.println(F("# 2. Place a known weight, type its value in kg + Enter to capture."));
  Serial.println(F("# 3. Repeat for several weights, then send 'f' to finish."));
  Serial.println(F("weight,value"));
}

bool finished = false;

void loop() {
  if (finished) return; // 'f' ends the session - nothing more happens until reset/reflash

  if (Serial.available()) {
    char c = Serial.peek();
    if (c == 't' || c == 'T') {
      Serial.read();
      scale.tare();
      pointCount = 0; // a fresh tare invalidates any points captured against the old zero
      Serial.println(F("# tared, previous points cleared"));
    } else if (c == 'f' || c == 'F') {
      Serial.read();
      finishAndFit();
      finished = true;
      Serial.println(F("# session finished - reset the board to run again"));
      return;
    } else if (c == '-' || c == '.' || (c >= '0' && c <= '9')) {
      float knownWeight = Serial.parseFloat();
      captureSample(knownWeight);
    } else {
      Serial.read(); // discard whitespace/unknown characters
    }
  }

  unsigned long now = millis();
  if (now - lastPreviewMs >= PREVIEW_INTERVAL_MS) {
    lastPreviewMs = now;
    printPreview();
  }
}
