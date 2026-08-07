// Integrated 2-motor / 2-strain-gauge test, DRV8833 + 2x HX711, XIAO ESP32-S3.
// No buttons - Serial toggle control: 'w'/'s' start opposite antagonistic
// states (motor 1 vs motor 2 run opposite directions), 'x' stops both.


#include <Arduino.h>

const int AIN1 = D1;
const int AIN2 = D0;
const int BIN1 = D3;
const int BIN2 = D4;

const int ENCODER1_C1 = D5;
const int ENCODER1_C2 = D6;
const int ENCODER2_C3 = D2;
const int ENCODER2_C4 = D7;

const int HX711_1_DT = D9;
const int HX711_2_DT = D8;
const int HX711_SCK = D10;

const int MAX_DUTY = 130; // unvalidated starting point

long strainA = 0;
long strainB = 0;

volatile long position1 = 0;
volatile long position2 = 0;

void IRAM_ATTR onEncoder1Rise() {
  if (digitalRead(ENCODER1_C2) == HIGH) position1++;
  else position1--;
}

void IRAM_ATTR onEncoder2Rise() {
  if (digitalRead(ENCODER2_C4) == HIGH) position2++;
  else position2--;
}

void setMotor(int pwmPin, int otherPin, int signedSpeed) {
  if (signedSpeed >= 0) {
    analogWrite(pwmPin, signedSpeed);
    analogWrite(otherPin, 0);
  } else {
    analogWrite(pwmPin, 0);
    analogWrite(otherPin, -signedSpeed);
  }
}

enum PairState { STOPPED, STATE_W, STATE_S };
PairState pairState = STOPPED;

// Reversing straight from full-forward to full-reverse duty spikes current
// (motor's own back-EMF still opposes the new direction) - coast briefly so
// it decays before driving the new direction.
const unsigned long DIRECTION_CHANGE_STOP_MS = 400;
bool reversalPending = false;
PairState pendingState = STOPPED;
unsigned long resumeAtMs = 0;

void driveMotors(PairState state) {
  int direction = (state == STATE_W) ? 1 : (state == STATE_S) ? -1 : 0;
  setMotor(AIN1, AIN2, direction * MAX_DUTY);
  setMotor(BIN1, BIN2, -direction * MAX_DUTY);
}

void requestPairState(PairState newState) {
  bool isReversal = (pairState == STATE_W && newState == STATE_S) ||
                     (pairState == STATE_S && newState == STATE_W);
  if (isReversal) {
    driveMotors(STOPPED);
    pendingState = newState;
    reversalPending = true;
    resumeAtMs = millis() + DIRECTION_CHANGE_STOP_MS;
  } else {
    reversalPending = false;
    pairState = newState;
    driveMotors(newState);
  }
}

void updatePendingReversal() {
  if (reversalPending && millis() >= resumeAtMs) {
    reversalPending = false;
    pairState = pendingState;
    driveMotors(pendingState);
  }
}

void handleSerialInput() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 'w' || c == 'W') requestPairState(STATE_W);
  else if (c == 's' || c == 'S') requestPairState(STATE_S);
  else if (c == 'x' || c == 'X') requestPairState(STOPPED);
}

bool readBothScales(long &outA, long &outB) {
  unsigned long start = millis();
  while (digitalRead(HX711_1_DT) == HIGH || digitalRead(HX711_2_DT) == HIGH) {
    if (millis() - start > 100) return false;
  }

  noInterrupts();
  unsigned long rawA = 0;
  unsigned long rawB = 0;
  for (uint8_t i = 0; i < 24; i++) {
    digitalWrite(HX711_SCK, HIGH);
    delayMicroseconds(1);
    rawA = (rawA << 1) | digitalRead(HX711_1_DT);
    rawB = (rawB << 1) | digitalRead(HX711_2_DT);
    digitalWrite(HX711_SCK, LOW);
    delayMicroseconds(1);
  }
  // One extra pulse -> gain 128 / channel A selected for both on the next conversion.
  digitalWrite(HX711_SCK, HIGH);
  delayMicroseconds(1);
  digitalWrite(HX711_SCK, LOW);
  delayMicroseconds(1);
  interrupts();

  if (rawA & 0x800000UL) rawA |= 0xFF000000UL; // sign-extend 24-bit two's complement
  if (rawB & 0x800000UL) rawB |= 0xFF000000UL;
  outA = (long)rawA;
  outB = (long)rawB;
  return true;
}

void updateStrainReadings() {
  long rawA, rawB;
  if (readBothScales(rawA, rawB)) {
    strainA = -rawA;
    strainB = -rawB;
  }
}

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 200;

void printStatusIfDue() {
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;

  Serial.print(">strainA:");
  Serial.print(strainA);
  Serial.print(",  strainB:");
  Serial.print(strainB);
  Serial.print(",  pos1:");
  Serial.print(position1);
  Serial.print(",  pos2:");
  Serial.println(position2);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);
  pinMode(BIN1, OUTPUT);
  pinMode(BIN2, OUTPUT);
  analogWrite(AIN1, 0);
  analogWrite(AIN2, 0);
  analogWrite(BIN1, 0);
  analogWrite(BIN2, 0);

  pinMode(ENCODER1_C1, INPUT);
  pinMode(ENCODER1_C2, INPUT);
  pinMode(ENCODER2_C3, INPUT);
  pinMode(ENCODER2_C4, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENCODER1_C1), onEncoder1Rise, RISING);
  attachInterrupt(digitalPinToInterrupt(ENCODER2_C3), onEncoder2Rise, RISING);

  pinMode(HX711_1_DT, INPUT);
  pinMode(HX711_2_DT, INPUT);
  pinMode(HX711_SCK, OUTPUT);
  digitalWrite(HX711_SCK, LOW);
}

void loop() {
  handleSerialInput();
  updatePendingReversal();
  updateStrainReadings();
  printStatusIfDue();
}
