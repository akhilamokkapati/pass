// Single motor test, DRV8833 driver, XIAO ESP32-S3. No encoder - motor +/- only.
// nSLEEP tied directly to 3.3V, not GPIO-controlled.
// button1 = clockwise, button2 = anticlockwise, hold-to-run with soft ramp.

#include <Arduino.h>

const int AIN1 = D0;
const int AIN2 = D1;

const int button1 = D2; // clockwise
const int button2 = D3; // anticlockwise

const int MAX_DUTY = 255; // unvalidated starting point
const int RAMP_STEP_MS = 15;

void fullStop() {
  analogWrite(AIN1, 0);
  analogWrite(AIN2, 0);
}

void softRamp(int pwmPin, int otherPin, int targetDuty) {
  for (int duty = 0; duty <= targetDuty; duty += 5) {
    analogWrite(pwmPin, duty);
    analogWrite(otherPin, 0);
    delay(RAMP_STEP_MS);
  }
}

void softRampDown(int pwmPin, int startDuty) {
  for (int duty = startDuty; duty >= 0; duty -= 5) {
    analogWrite(pwmPin, duty);
    delay(RAMP_STEP_MS);
  }
}

void runHeld(int pwmPin, int otherPin, int buttonPin, const __FlashStringHelper* label) {
  Serial.print(label);
  Serial.println(F(" pressed, holding..."));

  softRamp(pwmPin, otherPin, MAX_DUTY);

  while (digitalRead(buttonPin) == LOW) {
    delay(1);
  }

  softRampDown(pwmPin, MAX_DUTY);
  fullStop();

  Serial.print(label);
  Serial.println(F(" released."));
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);

  pinMode(button1, INPUT_PULLUP);
  pinMode(button2, INPUT_PULLUP);

  analogWrite(AIN1, 0);
  analogWrite(AIN2, 0);
}

void loop() {
  bool cwPressed  = (digitalRead(button1) == LOW);
  bool ccwPressed = (digitalRead(button2) == LOW);

  if (cwPressed) {
    runHeld(AIN1, AIN2, button1, F("CW"));
  } else if (ccwPressed) {
    runHeld(AIN2, AIN1, button2, F("CCW"));
  }
}
