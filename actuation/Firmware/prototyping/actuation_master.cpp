// Integrated 2-motor / 2-strain-gauge test, DRV8833 + 2x HX711, XIAO ESP32-S3.
// No buttons - Serial toggle control: 'w'/'s' start opposite antagonistic
// states (motor 1 vs motor 2 run opposite directions), 'x' stops both.
// Encoder pins wired in ahead of the hardware arriving - meaningless until
// then. Both HX711s share one SCK pin (D10), separate DT pins - see
// actuation/CLAUDE.md for the shared-clock caveat.

#include <Arduino.h>
#include <HX711.h>

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

const int MAX_DUTY = 150; // unvalidated starting point

HX711 scaleA;
HX711 scaleB;
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

void applyPairState() {
  int direction = (pairState == STATE_W) ? 1 : (pairState == STATE_S) ? -1 : 0;
  setMotor(AIN1, AIN2, direction * MAX_DUTY);
  setMotor(BIN1, BIN2, -direction * MAX_DUTY);
}

void handleSerialInput() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 'w' || c == 'W') pairState = STATE_W;
  else if (c == 's' || c == 'S') pairState = STATE_S;
  else if (c == 'x' || c == 'X') pairState = STOPPED;
  else return;
  applyPairState();
}

void updateStrainReadings() {
  if (scaleA.is_ready()) strainA = -scaleA.read();
  if (scaleB.is_ready()) strainB = -scaleB.read();
}

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 200;

void printStatusIfDue() {
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;

  Serial.print(">strainA:");
  Serial.print(strainA);
  Serial.print(",strainB:");
  Serial.print(strainB);
  Serial.print(",pos1:");
  Serial.print(position1);
  Serial.print(",pos2:");
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

  scaleA.begin(HX711_1_DT, HX711_SCK);
  scaleB.begin(HX711_2_DT, HX711_SCK);
}

void loop() {
  handleSerialInput();
  updateStrainReadings();
  printStatusIfDue();
}
