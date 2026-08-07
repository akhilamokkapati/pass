// Isolated inner-loop test, XIAO ESP32-C3. Just the angle PID -> motor
// lets Kp/Ki/Kd be tuned directly

// UNVALIDATED: Kp/Ki/Kd, MAX_DUTY, and the sign convention (does a
// positive angle setpoint actually turn the motor the way you'd expect) -
// same caveats as actuation_mini.cpp, test at low duty first. Same applies
// to which of MANUAL_TWIST/MANUAL_UNTWIST below is physically correct -
// both are a guess (+PWM = twist) until checked by hand.

#include <Arduino.h>
#include <PID_v1.h>

const int AIN1 = D2;
const int AIN2 = D3;
const int ENCODER_C1 = D4;
const int ENCODER_C2 = D5;

double angleSetpoint = 0; // theta_d, encoder counts 
double measuredAngle = 0; // theta_o, encoder counts (double copy of `position` - PID needs a double)
double motorOutput = 0;   // signed PWM

double Kp = 2, Ki = 5, Kd = 1; // tune here directly
PID anglePID(&measuredAngle, &motorOutput, &angleSetpoint, Kp, Ki, Kd, DIRECT);

const int MAX_DUTY = 180; // unvalidated starting point for this board's motor/driver

volatile long position = 0;

void IRAM_ATTR onEncoderRise() {
  if (digitalRead(ENCODER_C2) == HIGH) position++;
  else position--;
}

void setMotor(int signedSpeed) {
  if (signedSpeed >= 0) {
    analogWrite(AIN1, signedSpeed);
    analogWrite(AIN2, 0);
  } else {
    analogWrite(AIN1, 0);
    analogWrite(AIN2, -signedSpeed);
  }
}

// ---- Manual control mode ----
// 'l' stops loop control and drops into manual (also a real instant stop -
// zeroes the motor immediately, unlike 'x' in loop mode which only
// retargets angleSetpoint to 0 and lets the PID coast down). 'q'/'w' jog
// the motor directly while in manual mode - no PID. 'x' stops the motor
// while staying in manual mode (a pause, not a mode switch). 's' returns
// to closed-loop PID control.
enum ControlMode { LOOP_CONTROL, MANUAL_CONTROL };
ControlMode mode = LOOP_CONTROL;

enum ManualDirection { MANUAL_STOPPED, MANUAL_TWIST, MANUAL_UNTWIST };
ManualDirection manualDirection = MANUAL_STOPPED;

void handleSerialInput() {
  if (!Serial.available()) return;
  char c = Serial.peek();
  if (c == 'l' || c == 'L') {
    Serial.read();
    mode = MANUAL_CONTROL;
    manualDirection = MANUAL_STOPPED;
    setMotor(0); // real instant stop
    Serial.println(F("# stopped - manual control mode"));
  } else if (c == 'x' || c == 'X') {
    Serial.read();
    if (mode == MANUAL_CONTROL) {
      manualDirection = MANUAL_STOPPED;
      setMotor(0);
      Serial.println(F("# manual: stopped"));
    } else {
      angleSetpoint = 0;
      setMotor(0); // real instant stop
      Serial.println(F("# stop - setpoint zeroed"));
    }
  } else if (c == 's' || c == 'S') {
    Serial.read();
    mode = LOOP_CONTROL;
    manualDirection = MANUAL_STOPPED;
    angleSetpoint = 0; // don't resume a stale setpoint silently - retype it deliberately
    Serial.println(F("# back to loop control - setpoint reset to 0"));
  } else if (c == 'q' || c == 'Q') {
    Serial.read();
    if (mode == MANUAL_CONTROL) {
      manualDirection = MANUAL_TWIST;
      Serial.println(F("# manual: twist"));
    } else {
      Serial.println(F("# ignored - send 'l' first to enter manual control"));
    }
  } else if (c == 'w' || c == 'W') {
    Serial.read();
    if (mode == MANUAL_CONTROL) {
      manualDirection = MANUAL_UNTWIST;
      Serial.println(F("# manual: untwist"));
    } else {
      Serial.println(F("# ignored - send 'l' first to enter manual control"));
    }
  } else if (c == 'z' || c == 'Z') {
    Serial.read();
    position = 0; // fresh reference point for repeatable step tests
    Serial.println(F("# position zeroed"));
  } else if (c == '-' || c == '.' || (c >= '0' && c <= '9')) {
    angleSetpoint = Serial.parseFloat();
    Serial.print(F("# new angle setpoint (counts): "));
    Serial.println(angleSetpoint);
  } else {
    Serial.read(); // discard unknown/whitespace characters
  }
}

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 100;

void printStatusIfDue() {
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;

  Serial.print(F(">mode:"));
  Serial.print(mode == LOOP_CONTROL ? 0 : 1);
  Serial.print(F("\t>angleSetpoint:"));
  Serial.print(angleSetpoint);
  Serial.print(F("\t>measuredAngle:"));
  Serial.print(measuredAngle);
  Serial.print(F("\t>output:"));
  Serial.println(motorOutput);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);
  analogWrite(AIN1, 0);
  analogWrite(AIN2, 0);

  pinMode(ENCODER_C1, INPUT);
  pinMode(ENCODER_C2, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENCODER_C1), onEncoderRise, RISING);

  anglePID.SetOutputLimits(-MAX_DUTY, MAX_DUTY);
  anglePID.SetMode(AUTOMATIC);
  anglePID.SetSampleTime(1); // 1 ms sample time, 1 kHz update rate

  Serial.println(F("# angle_pid_test ready"));
  Serial.println(F("# loop control: type a target angle (encoder counts) + Enter, 'x' to stop, 'z' to zero the encoder position"));
  Serial.println(F("# 'l' = stop + manual control, 's' = back to loop control"));
  Serial.println(F("# manual control: 'q' = twist, 'w' = untwist, 'x' = stop motor"));
}

void loop() {
  handleSerialInput();

  if (mode == MANUAL_CONTROL) {
    int manualPwm = (manualDirection == MANUAL_TWIST) ? MAX_DUTY
                   : (manualDirection == MANUAL_UNTWIST) ? -MAX_DUTY
                   : 0;
    setMotor(manualPwm);
    motorOutput = manualPwm; // so the status line reflects what's actually driving the motor
    measuredAngle = position;
    printStatusIfDue();
    return; // skip the PID entirely while in manual mode
  }

  measuredAngle = position;
  anglePID.Compute();
  setMotor((int)motorOutput);

  printStatusIfDue();
}
