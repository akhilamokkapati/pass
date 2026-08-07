// Cascade force/angle actuation rig, XIAO ESP32-C3. No pretension term in
// this pass (F_d = Setpoint directly, no F_t+F_0 split) and no pretwist
// reference (theta_0 treated as wherever the encoder starts counting from
// at boot, not a calibrated physical zero).
//
// Outer loop (force): Setpoint - measured force -> Inverse SSTSA Model ->
//   desired angle change -> angle setpoint. Runs on its own slower timer
//   (OUTER_UPDATE_INTERVAL_MS) - first version recalculated this every fast
//   loop() pass with no smoothing, which fed raw sensor noise straight
//   into a large gain and produced a sustained oscillation that never
//   converged (the inner loop was chasing a target that never held still).
//   Standard cascade design has the outer loop run slower than the inner
//   loop for exactly this reason.
// Inner loop (angle): angle setpoint - encoder position -> PID -> motor PWM.
//   Still runs every fast loop() pass, converging toward whatever the
//   (now slower-moving) outer loop last set.
//
// UNVALIDATED PLACEHOLDERS - verify/tune all of these before trusting this
// to run unattended:
// - SCALE_FACTOR: tonight's practice calibration (messy full-range sweep,
//   toe region + suspected bending artifact both included). Not trustworthy.
// - INVERSE_SSTSA_GAIN: stands in for 1/(k_s*J(theta_0)). k_s (string
//   stiffness, 9000N) is known, but J(theta_0) - the SSTSA's local
//   force-vs-angle sensitivity - has NOT been derived, so this is one
//   empirically-tunable number, not real physics. It's in encoder counts
//   per Newton (not radians per Newton), matching the angle loop staying
//   in raw counts. Cut from 130 to 10 after the first version's gain
//   turned out to amplify every bit of force noise into a huge angle
//   swing - still just a starting guess.
// - Kp/Ki/Kd, MAX_DUTY: same unvalidated-starting-point status as
//   elsewhere in this project.
// - SIGN CONVENTIONS: whether a positive angle setpoint actually commands
//   the twist direction that ADDS tension depends on the encoder's wiring
//   direction matching the motor's forward direction - neither has been
//   verified against each other. Same applies to which of MANUAL_TWIST/
//   MANUAL_UNTWIST below is physically correct - both are a guess (+PWM =
//   twist) until checked by hand.

#include <Arduino.h>
#include <HX711.h>
#include <PID_v1.h>

const int HX711_DT = D0;
const int HX711_SCK = D1;
const int AIN1 = D2;
const int AIN2 = D3;
const int ENCODER_C1 = D4;
const int ENCODER_C2 = D5;

const float SCALE_FACTOR = -21303.49; // PRACTICE ONLY - see header note
const float GRAVITY = 9.80665;        // kg -> N

HX711 scale;

// ---- Outer loop: force -> desired angle (Inverse SSTSA Model stand-in) ----
double forceSetpoint = 0; // F_d, N
double measuredForce = 0; // load cell feedback, N
const float INVERSE_SSTSA_GAIN = 10.0; // PLACEHOLDER, encoder counts per N - see header note

const byte FORCE_READ_SAMPLES = 5; // light averaging - reduces raw single-sample noise feeding the outer gain
const unsigned long OUTER_UPDATE_INTERVAL_MS = 200; // outer loop runs slower than inner loop, on purpose
unsigned long lastOuterUpdateMs = 0;

// ---- Inner loop: angle -> motor PWM ----
double angleSetpoint = 0; // theta_d, encoder counts
double measuredAngle = 0; // theta_o, encoder counts (double copy of `position` - PID needs a double)
double motorOutput = 0;   // signed PWM

double Kp = 0.5, Ki = 0.5, Kd = 0.1; // unvalidated starting gains
PID anglePID(&measuredAngle, &motorOutput, &angleSetpoint, Kp, Ki, Kd, DIRECT);

const int MAX_DUTY = 180; // unvalidated starting point for this board's motor/driver, also the manual jog duty

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
// zeroes the motor immediately, unlike the old 'x' which only retargeted
// forceSetpoint to 0 and let the PID coast down). 'q'/'w' jog the motor
// directly while in manual mode - no PID, no cascade - same idea as the
// direct-drive stall/sign-check test discussed earlier, just built into
// this file instead of a separate one. 'x' stops the motor while staying
// in manual mode (a pause, not a mode switch). 's' returns to closed-loop
// cascade control.
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
    forceSetpoint = 0;
    setMotor(0); // real instant stop
    Serial.println(F("# stopped - manual control mode"));
  } else if (c == 'x' || c == 'X') {
    Serial.read();
    if (mode == MANUAL_CONTROL) {
      manualDirection = MANUAL_STOPPED;
      setMotor(0);
      Serial.println(F("# manual: stopped"));
    } else {
      Serial.println(F("# ignored - send 'l' first to enter manual control"));
    }
  } else if (c == 's' || c == 'S') {
    Serial.read();
    mode = LOOP_CONTROL;
    manualDirection = MANUAL_STOPPED;
    forceSetpoint = 0; // don't resume a stale setpoint silently - retype it deliberately
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
  } else if (c == 't' || c == 'T') {
    Serial.read();
    scale.tare();
    Serial.println(F("# tared"));
  } else if (c == '-' || c == '.' || (c >= '0' && c <= '9')) {
    float kg = Serial.parseFloat();
    forceSetpoint = kg * GRAVITY; // typed input is kg, forceSetpoint itself stays in N throughout
    Serial.print(F("# new force setpoint: "));
    Serial.print(kg);
    Serial.print(F(" kg ("));
    Serial.print(forceSetpoint);
    Serial.println(F(" N)"));
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
  Serial.print(mode == LOOP_CONTROL ? F("0") : F("1"));
  Serial.print(F(",   forceSetpoint:"));
  Serial.print(forceSetpoint);
  Serial.print(F(",   measuredForce:"));
  Serial.print(measuredForce);
  Serial.print(F(",   angleSetpoint:"));
  Serial.print(angleSetpoint);
  Serial.print(F(",   measuredAngle:"));
  Serial.print(measuredAngle);
  Serial.print(F(",   output:"));
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

  scale.begin(HX711_DT, HX711_SCK);
  scale.tare();               // fresh offset every session - never hard-coded
  scale.set_scale(SCALE_FACTOR);

  anglePID.SetOutputLimits(-MAX_DUTY, MAX_DUTY);
  anglePID.SetMode(AUTOMATIC);

  Serial.println(F("# actuation_mini ready"));
  Serial.println(F("# loop control: type a target force (kg) + Enter, 't' to tare"));
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
    return; // skip the cascade entirely while in manual mode
  }

  // Outer loop: force error -> desired angle change (Inverse SSTSA Model).
  // Deliberately slower than the inner loop - see header note.
  unsigned long now = millis();
  if (now - lastOuterUpdateMs >= OUTER_UPDATE_INTERVAL_MS) {
    lastOuterUpdateMs = now;
    measuredForce = scale.get_units(FORCE_READ_SAMPLES) * GRAVITY;
    double forceError = forceSetpoint - measuredForce;
    angleSetpoint = forceError * INVERSE_SSTSA_GAIN;
  }

  // Inner loop: angle error -> motor PWM, every fast loop() pass.
  measuredAngle = position;
  anglePID.Compute();
  setMotor((int)motorOutput);

  printStatusIfDue();
}
