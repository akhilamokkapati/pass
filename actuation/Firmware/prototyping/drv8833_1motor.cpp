// Single geared motor test, DRV8833 driver, XIAO ESP32-S3.
// nSLEEP tied directly to 3.3V, not GPIO-controlled.
// Same hold-to-run button pattern as twist_untwist.cpp: button1 = clockwise,
// button2 = anticlockwise. Quadrature encoder (C1 interrupt, C2 for direction).

#include <Arduino.h>

const int AIN1 = D0;
const int AIN2 = D1;

const int button1 = D2; // clockwise
const int button2 = D3; // anticlockwise

const int ENCODER_C1 = D8;
const int ENCODER_C2 = D9;

const int MAX_DUTY = 80; // unvalidated starting point
const int RAMP_STEP_MS = 15;

volatile long position = 0;

void IRAM_ATTR onEncoderRise() {
  if (digitalRead(ENCODER_C2) == HIGH) position++;
  else position--;
}

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 200;

void printPositionIfDue() {
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;
  Serial.println(position);
}

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
    printPositionIfDue();
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

  pinMode(ENCODER_C1, INPUT);
  pinMode(ENCODER_C2, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENCODER_C1), onEncoderRise, RISING);

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

  printPositionIfDue();
}
