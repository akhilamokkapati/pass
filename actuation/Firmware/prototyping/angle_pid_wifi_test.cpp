/*
 * angle_pid_wifi_test.cpp
 * angle_pid_test_manual.cpp's motor/PID/serial/strain-gauge/calibration
 * logic, unmodified, with the WiFi networking layer from wifi_bringup.cpp
 * added on top, PLUS a remote command-dispatch layer that drives the same
 * state machine handleSerialInput() drives - webapp buttons now actually
 * move the motors, not just get logged.
 *
 * Resynced 2026-08-11 against angle_pid_test_manual.cpp's calibration/
 * force-control rewrite - operating-point calibration, force-hold mode,
 * and force+brake mode all carried over verbatim from there.
 *
 * Two remote-triggered flows, both built entirely from functions the main
 * code already exposes (startOppointCalibration, resetPID, setMotor,
 * brakeAll) - nothing in the "main" block below this comment is touched:
 *
 *   EXERCISE mode (webapp: Start session) - one motor, continuous force
 *   hold, patient moves against it:
 *     select_motor(A/B) -> pretension fixed at EXERCISE_PRETENSION_N (5N,
 *     per instruction - no longer typed) -> auto-calibrate -> calibration
 *     hands off to AWAIT_FORCE and HALTS there (the motor genuinely sits
 *     still - this is the webapp's "Ready" phase) -> webapp's "Begin
 *     exercise" button sends begin_exercise, which applies the queued
 *     training-weight value (already kg->N converted) -> FORCE_CONTROL.
 *     Deliberately two steps, not auto-chained, so the patient confirms
 *     before the real load engages.
 *
 *   ASSESSMENT mode (webapp: Start Assessment, gated by a clinician
 *     toggle) - both motors in sequence, force+brake, fixed 1kg (9.81N)
 *     load: motor A calibrates and brakes, holds ASSESSMENT_HOLD_MS so the
 *     strain gauge reading (already streamed live over telemetry) gives
 *     the physio something to read, then motor B does the same, then done.
 *
 * Telemetry out (UDP :5007): active->force (real strain gauge reading) in
 * tension_n's slot; state string now also reports which of the two remote
 * flows above is running (see stateName()), not just the raw serial state
 * machine enum.
 * Commands in (UDP :5008): select_motor, start_exercise, begin_exercise,
 * end_session, start_assessment, twist/untwist (manual jog), jog_stop, stop
 * - see handleWifiCommands() below. end_session (webapp: "End Session")
 * differs from stop (webapp: "Force stop"): it drives the active motor's
 * tension back down to ~0N under the force PID first, then stops - stop is
 * an immediate brake-in-place, no release.
 */

#include <Arduino.h>
#include <HX711.h>
#include <cmath>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_task_wdt.h>

const int FREQ = 10000;
const int RES = 8;

const int AIN1 = D0;
const int AIN2 = D1;
const int ENC_C1 = D5;
const int ENC_C2 = D6;

const int BIN1 = D3;
const int BIN2 = D4;
const int ENC_C3 = D2;
const int ENC_C4 = D7;

const int HX711_DT_A = D8;
const int HX711_DT_B = D9;
const int HX711_SCK = D10;

HX711 scaleA;
HX711 scaleB;

float Kp = 1, Ki = 0, Kd = 0;
const int ks = 200; // spring constant: 0.2 N/mm

// ---- operating point calibration parameters ----
const int OPPOINT_CAL_CYCLES = 3;       // number of wind-up samples to average
float KpForce = 50;                     // P gain for force seek (PWM per N) - tune this
const float CAL_FORCE_TOL = 0.5f;      // N, force must be within this of pretension
const int CAL_STABLE_SAMPLES = 5;       // consecutive fresh HX711 readings in tolerance (~0.5 s at 10 Hz)
const long CAL_UNWIND_COUNTS = 100;     // how far to back off between samples
const long CAL_POS_TOL = 20;             // counts, "unwind target reached" tolerance

// geometry / unit conversion for force control
const float COUNTS_PER_REV = 700.0f;    // TODO: set to encoder CPR x gear ratio

// Motor States

struct Motor {
  const char name;

  const int ch1, ch2;
  const int encPin2;

  volatile long position;

  float setpoint;
  float forceSetpoint;
  float pretension;      // target pretension load [N] for calibration
  float operatingPoint;  // calibrated position [counts] at pretension load

  float prevError;
  float errorIntegral;
  float controlSignal;

  HX711* scale;

  float force;

  int sign;
};

Motor motorA = {'A', 1, 2, ENC_C2, 0, 0, 0, 0, 0, 0, 0, 0, &scaleA, 0, 1};
Motor motorB = {'B', 3, 4, ENC_C4, 0, 0, 0, 0, 0, 0, 0, 0, &scaleB, 0, -1};


void IRAM_ATTR onEncoderRiseA() {
  if (digitalRead(ENC_C2) == HIGH) motorA.position++;
    else motorA.position--;
}

void IRAM_ATTR onEncoderRiseB() {
  if (digitalRead(ENC_C3) == HIGH) motorB.position++;
    else motorB.position--;
}

// Motor Control

void setMotor(Motor& m, float signal) {
  signal = constrain(signal, -255, 255);
  // slow decay
  if (signal >= 0) {
    ledcWrite(m.ch1, 255);
    ledcWrite(m.ch2, 255 - signal);
  } else {
    ledcWrite(m.ch1, 255 + signal);
    ledcWrite(m.ch2, 255);
  }
}

void brakeAll() {
  setMotor(motorA, 0);
  setMotor(motorB, 0);
}

// PID stuff

unsigned long lastControlMicros = 0;
const unsigned long CONTROL_INTERVAL_US = 5000;

void resetPID(Motor& m) {
  m.prevError = m.setpoint - m.position;
  m.errorIntegral = 0;
  m.controlSignal = 0;
  lastControlMicros = micros();
}

void calculatePID(Motor& m, float dt)
{
  float measured = (float)m.position;
  float error = (m.setpoint - measured);
  float edot = (error - m.prevError) / dt;
  m.errorIntegral += (error * dt); //integral term - Newton-Leibniz, notice, this is a running sum!
  m.controlSignal = (Kp * error) + (Kd * edot) + (Ki * m.errorIntegral); //final sum, proportional term also calculated here
  m.prevError = error; //save the error for the next iteration to get the difference (for edot)
  setMotor(m, m.controlSignal);
}

// serial state machine (declared here so the calibration routine can advance it)
enum State { SELECT_MOTOR, SELECT_MODE, AWAIT_SETPOINT, ANGLE_CONTROL, AWAIT_OPPOINT, AWAIT_FORCE, OPPOINT_CALIBRATION, FORCE_CONTROL, FORCE_BRAKE_MOVE, FORCE_BRAKE_HOLD };
State state = SELECT_MOTOR;
Motor* active = nullptr;
void promptSetForce();

// ---- force-and-brake mode ----
bool brakeModeSelected = false;         // set in SELECT_MODE: false = continuous force PID, true = move-then-brake
const long BRAKE_POS_TOL = 3;           // counts, considered "arrived" at force target position
const int BRAKE_SETTLE_COUNT = 40;      // consecutive in-tolerance control loops (~200 ms) before braking
int brakeSettleCounter = 0;

// convert a force delta [N] into an encoder-count delta about the operating point,
// using the linearized Jacobian x = sqrt(L^2 - (R*theta)^2)
float forceDeltaToCounts(Motor& m, float forceDelta) {
  float R = 0.0008;
  float L = 0.50;
  float thetaOp = m.operatingPoint * (2.0f * PI / COUNTS_PER_REV);
  float J = (R * R * thetaOp) / (sqrtf(L*L - powf((R * thetaOp), 2)));
  float angleDeltaRad = forceDelta / (5 * ks * J);
  return angleDeltaRad * (COUNTS_PER_REV / (2.0f * PI));
}

void calculateForcePID(Motor& m) {
  float forceError = (m.forceSetpoint - m.force);
  m.setpoint = m.operatingPoint + forceDeltaToCounts(m, forceError);
}

// brake mode: after calibration, drive to the averaged calibrated position and brake there
void startBrakeMove(Motor& m) {
  m.setpoint = m.operatingPoint;
  resetPID(m);
  brakeSettleCounter = 0;
  state = FORCE_BRAKE_MOVE;
  Serial.print(F("# moving to calibrated position "));
  Serial.print(m.setpoint);
  Serial.print(F(" counts ("));
  Serial.print(m.pretension);
  Serial.println(F(" N), then braking   ('s' stops, 'm' re-selects)"));
}

// ---- operating point calibration state machine ----
// SEEK:   P-control on force until measured load sits at pretension, then sample position
// UNWIND: back off CAL_UNWIND_COUNTS, then seek again; repeat OPPOINT_CAL_CYCLES times
enum CalPhase { CAL_SEEK, CAL_UNWIND };
CalPhase calPhase = CAL_SEEK;
int calSamplesTaken = 0;
long calPositionSum = 0;
int calStableCounter = 0;

void startOppointCalibration(Motor& m) {
  calPhase = CAL_SEEK;
  calSamplesTaken = 0;
  calPositionSum = 0;
  calStableCounter = 0;
  resetPID(m);
  Serial.print(F("# calibrating operating point at "));
  Serial.print(m.pretension);
  Serial.println(F(" N ..."));
}

void runOppointCalibration(Motor& m, float dt, bool newForceSample) {
  switch (calPhase) {

    case CAL_SEEK: {
      // proportional force seek; m.sign sets the winding direction (flip if it runs away)
      float forceError = m.pretension - m.force;
      m.controlSignal = m.sign * KpForce * forceError;
      setMotor(m, m.controlSignal);

      // only judge stability on fresh HX711 readings (~10 Hz), not every 5 ms loop
      if (newForceSample) {
        if (fabsf(forceError) < CAL_FORCE_TOL) calStableCounter++;
        else calStableCounter = 0;
      }

      if (calStableCounter >= CAL_STABLE_SAMPLES) {
        calStableCounter = 0;
        noInterrupts();
        long pos = m.position;
        interrupts();
        calPositionSum += pos;
        calSamplesTaken++;

        Serial.print(F("# cal sample "));
        Serial.print(calSamplesTaken);
        Serial.print(F("/"));
        Serial.print(OPPOINT_CAL_CYCLES);
        Serial.print(F(": position "));
        Serial.println(pos);

        if (calSamplesTaken >= OPPOINT_CAL_CYCLES) {
          // done: average and store
          m.operatingPoint = (float)calPositionSum / (float)OPPOINT_CAL_CYCLES;
          setMotor(m, 0);
          Serial.print(F("# operating point saved: "));
          Serial.print(m.operatingPoint);
          Serial.println(F(" counts"));
          if (brakeModeSelected) {
            startBrakeMove(m);   // drive to the averaged position and brake there
          } else {
            state = AWAIT_FORCE;
            promptSetForce();
          }
        } else {
          // unwind before the next approach
          m.setpoint = pos - m.sign * CAL_UNWIND_COUNTS;
          resetPID(m);
          calPhase = CAL_UNWIND;
        }
      }
      break;
    }

    case CAL_UNWIND: {
      calculatePID(m, dt);   // position PID toward the unwind target
      noInterrupts();
      long pos = m.position;
      interrupts();
      if (labs((long)m.setpoint - pos) <= CAL_POS_TOL) {
        resetPID(m);         // clear integral before force seek
        calStableCounter = 0;
        calPhase = CAL_SEEK;
      }
      break;
    }
  }
}

// serial input buffer
String inputBuffer = "";

bool readLine(String& out) {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inputBuffer.length() == 0) return false;
      out = inputBuffer;
      inputBuffer = "";
      out.trim();
      return true;
    }
    if (inputBuffer.length() < 32) inputBuffer += c;
  }
  return false;
}

// Serial Prompt

void promptSelectMotor() {
  Serial.println();
  Serial.println("Select Motor (A/B): ");
}

void promptSelectMode() {
  Serial.println();
  Serial.println("Select Mode: a - angle control, f - force control, b - force + brake.");
}

void promptSetpoint() {
  Serial.print(F("# motor "));
  Serial.print(active->name);
  Serial.print(F(" selected (position "));
  Serial.print(active->position);
  Serial.println(F(" counts)"));
  Serial.println(F("#   enter target angle in counts, or:"));
  Serial.println(F("#   z = zero encoder here, m = back to motor select"));
}

void promptSetOpPoint() {
  Serial.print(F("# motor "));
  Serial.print(active->name);
  Serial.print(F(" selected (operating point "));
  Serial.print(active->operatingPoint);
  Serial.println(F(")"));
  if (brakeModeSelected)
    Serial.println(F("#   enter target tension in newtons (calibrates + brakes there), or:"));
  else
    Serial.println(F("#   enter operating point pretension in newtons, or:"));
  Serial.println(F("#   z = zero encoder here, m = back to motor select"));
}

void promptSetForce() {
  Serial.print(F("# motor "));
  Serial.print(active->name);
  Serial.print(F(" selected (forceSetpoint "));
  Serial.print(active->forceSetpoint);
  Serial.println(F("#   enter target force in newtons, or:"));
  Serial.println(F("#   z = zero encoder here, m = back to motor select"));
}

void handleSerialInput() {
  String line;
  if (!readLine(line)) return;
  if (line.length() == 0) return;

  char c = tolower(line.charAt(0));

  // Shortcut to stop motors at any point - s key
  if (c == 's') {
    brakeAll();
    state = SELECT_MOTOR;
    active = nullptr;
    Serial.println("Stopped");
    promptSelectMotor();
    return;
  }

  switch (state) {
    case SELECT_MOTOR:
      if (c == 'a') active = &motorA;
      else if (c == 'b') active = &motorB;
      else { Serial.println(F("Invalid Motor Selection, select 'a' or 'b'")); return; }
      state = SELECT_MODE;
      promptSelectMode();

      if (active) {
        if (active->scale->is_ready()) {
          Serial.println("Strain Gauge Ready");
        }
        else {
          Serial.println("Strain Gauge not ready");
        }
      }

      break;

    case SELECT_MODE:
      if (c == 'a') {
        state = AWAIT_SETPOINT;
        promptSetpoint();
      }
      else if (c == 'f') {
        brakeModeSelected = false;
        state = AWAIT_OPPOINT;
        promptSetOpPoint();
      }
      else if (c == 'b') {
        brakeModeSelected = true;
        state = AWAIT_OPPOINT;
        promptSetOpPoint();
      }
      else { Serial.println(F("Invalid Mode Selection, select 'a', 'f', or 'b'")); return; }
      break;   // was falling through into AWAIT_SETPOINT

    case AWAIT_SETPOINT:
      if (c == 'm') {
        active = nullptr;
        state = SELECT_MOTOR;
        promptSelectMotor();
      } else if (c == 'z') {
        noInterrupts();
        active->position = 0;
        interrupts();
        Serial.println("Encoder zeroed");
        promptSetpoint();
      } else if (line == "tare") {
        active->scale->tare();
        Serial.println("Strain Gauge Tared");
        promptSetpoint();
      } else if (c == '-' || c == '.' || isdigit(c)) {
        active->setpoint = line.toFloat();
        resetPID(*active);
        state = ANGLE_CONTROL;
        Serial.print(F("# running motor "));
        Serial.print(active->name);
        Serial.print(F(" -> setpoint "));
        Serial.print(active->setpoint);
        Serial.println(F(" counts   ('s' stops, 'm' re-selects)"));
      } else {
        Serial.println(F("# ? enter a number, 'z', or 'm'"));
      }
      break;

    case AWAIT_OPPOINT:
      if (c == 'm') {
        active = nullptr;
        state = SELECT_MOTOR;
        promptSelectMotor();
      } else if (c == 'z') {
        noInterrupts();
        active->position = 0;
        interrupts();
        Serial.println("Encoder zeroed");
        promptSetpoint();
      } else if (line == "tare") {
        active->scale->tare();
        Serial.println("Strain Gauge Tared");
        promptSetpoint();
      } else if (c == '-' || c == '.' || isdigit(c)) {
        active->pretension = line.toFloat();
        Serial.print(F(" -> pretension target "));
        Serial.print(active->pretension);
        Serial.println(F(" N   ('s' stops, 'm' re-selects)"));
        startOppointCalibration(*active);
        state = OPPOINT_CALIBRATION;
      } else {
        Serial.println(F("# ? enter a number, 'z', or 'm'"));
      }
      break;

    case AWAIT_FORCE:
      if (c == 'm') {
        active = nullptr;
        state = SELECT_MOTOR;
        promptSelectMotor();
      } else if (c == 'z') {
        noInterrupts();
        active->position = 0;
        interrupts();
        Serial.println("Encoder zeroed");
        promptSetpoint();
      } else if (line == "tare") {
        active->scale->tare();
        Serial.println("Strain Gauge Tared");
        promptSetpoint();
      } else if (c == '-' || c == '.' || isdigit(c)) {
        active->forceSetpoint = line.toFloat();
        if (brakeModeSelected) {
          startBrakeMove(*active);
        } else {
          resetPID(*active);
          state = FORCE_CONTROL;
          Serial.print(F("# running motor "));
          Serial.print(active->name);
          Serial.print(F(" -> force setpoint "));
          Serial.print(active->forceSetpoint);
          Serial.println(F(" N   ('s' stops, 'm' re-selects)"));
        }
      } else {
        Serial.println(F("# ? enter a number, 'z', or 'm'"));
      }
      break;

    case OPPOINT_CALIBRATION:
      if (c == 'm') {
            setMotor(*active, 0);
            active = nullptr;
            state = SELECT_MOTOR;
            promptSelectMotor();
      }
      break;

    case ANGLE_CONTROL:
      if (c == 'm') {
          setMotor(*active, 0);
          active = nullptr;
          state = SELECT_MOTOR;
          promptSelectMotor();
      } else if (c == '-' || c == '.' || isdigit(c)) {
        active->setpoint = line.toFloat();   // retarget on the fly
        Serial.print(F("# new setpoint: "));
        Serial.println(active->setpoint);
      } else if (line == "read-force") {
        setMotor(*active, 0);
        float averaged_force = active->scale->get_units(30);
        Serial.print("Averaged 30 force values: ");
        Serial.print(averaged_force);
        Serial.println();
        state = AWAIT_SETPOINT;
        promptSetpoint();
      }
      break;

    case FORCE_CONTROL:
        if (c == 'm') {
            setMotor(*active, 0);
            active = nullptr;
            state = SELECT_MOTOR;
            promptSelectMotor();
        } else if (c == '-' || c == '.' || isdigit(c)) {
          active->forceSetpoint = line.toFloat();   // retarget on the fly
          Serial.print(F("# new force setpoint: "));
          Serial.println(active->forceSetpoint);
        } else if (line == "read-force") {
          setMotor(*active, 0);
          float averaged_force = active->scale->get_units(30);
          Serial.print("Averaged 30 force values: ");
          Serial.print(averaged_force);
          Serial.println();
          state = AWAIT_FORCE;
          promptSetpoint();
        }
      break;

    case FORCE_BRAKE_MOVE:
    case FORCE_BRAKE_HOLD:
        if (c == 'm') {
            setMotor(*active, 0);
            active = nullptr;
            state = SELECT_MOTOR;
            promptSelectMotor();
        } else if (c == '-' || c == '.' || isdigit(c)) {
          // retarget: recalibrate at the new tension, then brake there again
          active->pretension = line.toFloat();
          Serial.print(F(" -> new tension target "));
          Serial.print(active->pretension);
          Serial.println(F(" N"));
          startOppointCalibration(*active);
          state = OPPOINT_CALIBRATION;
        } else if (line == "read-force") {
          float averaged_force = active->scale->get_units(30);
          Serial.print("Averaged 30 force values: ");
          Serial.print(averaged_force);
          Serial.println();
        }
      break;
    }
}

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 100;

void printStatusIfDue() {
  // FORCE_CONTROL included so exercise mode (the webapp's continuous
  // force-hold state) actually streams data - it runs the same
  // updateForce->calculateForcePID->calculatePID cascade as the other
  // printable states but was previously left out of this gate entirely.
  bool printable = (state == ANGLE_CONTROL || state == FORCE_CONTROL || state == FORCE_BRAKE_MOVE || state == FORCE_BRAKE_HOLD);
  if (!printable || active == nullptr) return;
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;

  // One line, one println - Teleplot/Serial Plotter need it that way.
  // setpoint/measured/error are the INNER angle loop (counts) - in
  // FORCE_CONTROL, setpoint is calculateForcePID()'s derived target, not
  // the tension target itself, so forceSetpoint/Force-N are printed
  // alongside it to see the outer loop's target vs. actual.
  Serial.print(F(">setpoint:"));      Serial.print(active->setpoint);
  Serial.print(F(",measured:"));      Serial.print(active->position);
  Serial.print(F(",error:"));         Serial.print(active->setpoint - active->position);
  Serial.print(F(",control:"));       Serial.print(active->controlSignal);
  Serial.print(F(",forceSetpoint:")); Serial.print(active->forceSetpoint);
  Serial.print(F(",Force/N:"));       Serial.print(active->force);
  Serial.println();

}

bool updateForce (Motor& m) {
  if(!m.scale->is_ready()) return false;
  m.force = m.scale->get_units(1);
  return true;
}

// ---- WiFi bring-up (added - see wifi_bringup.cpp for the source of this
// section and the reasoning behind the watchdog/zombie-WiFi guards) --------

#define UNIT_ID "actuation"
#define WIFI_SSID "TP-Link_1285"
#define WIFI_PASS "15289346"
#define DEST_IP "192.168.0.255"
#define TELEMETRY_PORT 5007
#define COMMAND_PORT   5008
#define EMIT_MS 200

#define WDT_TIMEOUT_S 8
#define ZOMBIE_CHECK_MS 3000
#define ZOMBIE_LIMIT    3

#define LED_PIN 21
#define LED_ON  LOW

WiFiUDP txUdp;
WiFiUDP rxUdp;
IPAddress dest;

uint32_t seq = 0;
uint32_t lastEmit = 0;
uint32_t lastHealth = 0;
uint32_t rxCount = 0;
uint32_t udpBeginOk = 0, udpBeginFail = 0, udpEndOk = 0, udpEndFail = 0;

void wdtBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdtConfig = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
}

void wifiBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  dest.fromString(DEST_IP);
}

void checkZombieWifi() {
  static uint32_t lastZombieCheck = 0;
  static uint8_t  zombieStreak = 0;
  uint32_t now = millis();
  if (now - lastZombieCheck < ZOMBIE_CHECK_MS) return;
  lastZombieCheck = now;
  if (WiFi.status() == WL_CONNECTED && WiFi.RSSI() == 0) {
    if (++zombieStreak >= ZOMBIE_LIMIT) {
      if (Serial) Serial.println("# WARN zombie WiFi (RSSI stuck at 0) - forcing reconnect");
      WiFi.disconnect();
      zombieStreak = 0;
    }
  } else {
    zombieStreak = 0;
  }
}

// ---- remote (webapp) command dispatch -------------------------------------
// Drives the exact same state machine handleSerialInput() drives (state,
// active, the Motor structs) via the same functions the serial handler
// calls (startOppointCalibration, resetPID, setMotor, brakeAll) - nothing
// above this section is touched. This is what makes webapp commands
// actually move the motors instead of only being logged.

const float EXERCISE_PRETENSION_N = 5.0f;       // fixed pretension baseline for exercise mode - no longer typed
const float ASSESSMENT_LOAD_N = 1.0f * 9.81f;   // fixed 1 kg assessment load
const uint32_t ASSESSMENT_HOLD_MS = 5000;       // dwell at each braked motor so the physio has time to read the reading

enum AssessmentStep { ASSESS_NONE, ASSESS_MOTOR_A, ASSESS_MOTOR_B, ASSESS_DONE };
AssessmentStep assessmentStep = ASSESS_NONE;
uint32_t assessmentHoldStart = 0;

bool pendingForceTargetValid = false;
float pendingForceTargetN = 0;

// "End Session" release-to-zero - see remoteEndSession() below.
bool endSessionReleasing = false;
uint32_t endSessionStableStartMs = 0;
const float RELEASE_FORCE_TOL = 0.3f;      // N, counts as "at zero"
const uint32_t RELEASE_STABLE_MS = 300;    // must hold within tolerance this long before the final stop

void remoteStopAll() {
  brakeAll();
  motorA.controlSignal = 0;
  motorB.controlSignal = 0;
  state = SELECT_MOTOR;
  active = nullptr;
  brakeModeSelected = false;
  assessmentStep = ASSESS_NONE;
  assessmentHoldStart = 0;
  pendingForceTargetValid = false;
  endSessionReleasing = false;
  if (Serial) Serial.println("# remote stop");
}

void remoteSelectMotor(int which) {
  active = (which == 0) ? &motorA : &motorB;
  state = SELECT_MODE;
  endSessionReleasing = false;
  if (Serial) { Serial.print("# remote select motor "); Serial.println(active->name); }
}

// "End Session" - unlike stop's immediate brake-in-place, this keeps the
// force PID running with forceSetpoint dropped to 0N, so the string
// actively untwists back down to ~0N under control (not just released to
// spring back on its own) before the motor is fully stopped/deselected -
// see the endSessionReleasing check in loop()'s FORCE_CONTROL block.
void remoteEndSession() {
  if (active == nullptr) { remoteStopAll(); return; }   // nothing selected, nothing to release
  active->forceSetpoint = 0;
  resetPID(*active);
  state = FORCE_CONTROL;
  endSessionReleasing = true;
  endSessionStableStartMs = 0;
  if (Serial) Serial.println("# remote end session, releasing to 0N");
}

// Manual jog - raw PWM via setMotor(), bypassing the calibration/force PID
// entirely. Safe to drive directly: this only runs while state ==
// SELECT_MODE (right after select_motor, before any mode/flow claims the
// motor), and none of loop()'s control blocks touch setMotor() in that
// state, so there's nothing else fighting for the pin. dir: +1 = twist
// (tension up), -1 = untwist - m.sign keeps this consistent regardless of
// which physical direction each motor's wiring winds in.
const int JOG_PWM = 220;   // was 150 - bumped for faster manual jog (255 = full duty)

void remoteJog(int dir) {
  if (active == nullptr || state != SELECT_MODE) return;
  active->controlSignal = dir * active->sign * JOG_PWM;   // keep in sync - see printMotorActivityIfDue()
  setMotor(*active, active->controlSignal);
}

// Jog release - just halts movement, unlike remoteStopAll() it does NOT
// deselect the motor, so repeated jog presses don't need select_motor sent
// again between every press/release.
void remoteJogStop() {
  if (active == nullptr) return;
  active->controlSignal = 0;
  setMotor(*active, 0);
}

// Exercise mode: pretension fixed at EXERCISE_PRETENSION_N. Calibration
// halts the motor on its own once it reaches AWAIT_FORCE (the main code's
// own runOppointCalibration() already calls setMotor(m, 0) there - nothing
// extra needed for that part). The webapp's training-weight value is just
// queued here, NOT auto-applied - it only takes effect once
// remoteBeginExercise() is explicitly triggered by the "Begin exercise"
// button, so the motor genuinely sits still at pretension ("Ready") until
// the patient confirms, instead of sliding straight into the real target
// the instant calibration finishes.
void remoteStartExercise(float forceN) {
  if (active == nullptr) return;   // select_motor must arrive first
  brakeModeSelected = false;
  endSessionReleasing = false;
  pendingForceTargetValid = true;
  pendingForceTargetN = forceN;
  active->pretension = EXERCISE_PRETENSION_N;
  startOppointCalibration(*active);
  state = OPPOINT_CALIBRATION;
  if (Serial) Serial.println("# remote start exercise");
}

// "Begin exercise" button - applies the queued training-weight target and
// starts the continuous force hold. Only does anything if calibration has
// actually finished and is sitting at AWAIT_FORCE waiting; otherwise it's
// pressed too early (or nothing is queued) and is a no-op.
void remoteBeginExercise() {
  if (!pendingForceTargetValid || state != AWAIT_FORCE || active == nullptr) return;
  active->forceSetpoint = pendingForceTargetN;
  resetPID(*active);
  state = FORCE_CONTROL;
  pendingForceTargetValid = false;
  if (Serial) Serial.println("# remote begin exercise, force target applied");
}

// Assessment mode: motor A first, force+brake at the fixed load.
// serviceRemoteFlows() advances to motor B once A settles, then finishes.
void remoteStartAssessment() {
  assessmentStep = ASSESS_MOTOR_A;
  assessmentHoldStart = 0;
  active = &motorA;
  brakeModeSelected = true;
  active->pretension = ASSESSMENT_LOAD_N;
  startOppointCalibration(*active);
  state = OPPOINT_CALIBRATION;
  if (Serial) Serial.println("# remote start assessment");
}

// Polled every loop() pass - advances the assessment flow once the
// underlying state machine reaches the point a typed Serial command would
// have driven it further (brake settling). Exercise mode's AWAIT_FORCE step
// is NOT auto-advanced here on purpose - see remoteBeginExercise().
void serviceRemoteFlows() {
  if (assessmentStep == ASSESS_MOTOR_A && state == FORCE_BRAKE_HOLD) {
    if (assessmentHoldStart == 0) assessmentHoldStart = millis();
    if (millis() - assessmentHoldStart >= ASSESSMENT_HOLD_MS) {
      assessmentHoldStart = 0;
      assessmentStep = ASSESS_MOTOR_B;
      active = &motorB;
      active->pretension = ASSESSMENT_LOAD_N;
      startOppointCalibration(*active);
      state = OPPOINT_CALIBRATION;
      if (Serial) Serial.println("# assessment: motor A done, starting motor B");
    }
  } else if (assessmentStep == ASSESS_MOTOR_B && state == FORCE_BRAKE_HOLD) {
    if (assessmentHoldStart == 0) assessmentHoldStart = millis();
    if (millis() - assessmentHoldStart >= ASSESSMENT_HOLD_MS) {
      assessmentHoldStart = 0;
      assessmentStep = ASSESS_DONE;
      setMotor(*active, 0);
      if (Serial) Serial.println("# assessment: done");
    }
  }
}

// state string reported over telemetry - assessment/exercise progress take
// priority over the raw serial-state-machine name, since that's what the
// webapp actually needs to show the patient/clinician.
const char* stateName() {
  // motor A = curl, motor B = knee extension (see EXERCISES in
  // useActuationSession.js - must match)
  if (assessmentStep == ASSESS_MOTOR_A)  return "assessing_curl";
  if (assessmentStep == ASSESS_MOTOR_B)  return "assessing_knee_extension";
  if (assessmentStep == ASSESS_DONE)     return "assessment_done";
  switch (state) {
    case SELECT_MOTOR:        return "select_motor";
    case SELECT_MODE:         return "select_mode";
    case AWAIT_SETPOINT:      return "await_setpoint";
    case ANGLE_CONTROL:       return "angle_control";
    case AWAIT_OPPOINT:       return "await_oppoint";
    case AWAIT_FORCE:         return "await_force";
    case OPPOINT_CALIBRATION: return "calibrating";
    case FORCE_CONTROL:       return "exercising";
    case FORCE_BRAKE_MOVE:    return "moving_to_hold";
    case FORCE_BRAKE_HOLD:    return "holding";
  }
  return "idle";
}

// commands in - parses "actuation,cmd,value" and dispatches to the remote
// flow functions above.
void handleWifiCommands() {
  int packetSize = rxUdp.parsePacket();
  if (!packetSize) return;
  char buf[128];
  int len = rxUdp.read(buf, sizeof(buf) - 1);
  if (len > 0) buf[len] = 0; else buf[0] = 0;
  rxCount++;
  if (Serial) {
    Serial.print("# CMD RX from "); Serial.print(rxUdp.remoteIP());
    Serial.print(" -> \""); Serial.print(buf); Serial.println("\"");
  }

  char* unit = strtok(buf, ",");
  char* cmd = strtok(nullptr, ",");
  char* valueStr = strtok(nullptr, ",");
  if (unit == nullptr || cmd == nullptr) return;
  float value = valueStr ? atof(valueStr) : 0.0f;

  if (strcmp(cmd, "select_motor") == 0) {
    remoteSelectMotor((int)value);
  } else if (strcmp(cmd, "start_exercise") == 0) {
    remoteStartExercise(value);
  } else if (strcmp(cmd, "begin_exercise") == 0) {
    remoteBeginExercise();
  } else if (strcmp(cmd, "end_session") == 0) {
    remoteEndSession();
  } else if (strcmp(cmd, "start_assessment") == 0) {
    remoteStartAssessment();
  } else if (strcmp(cmd, "twist") == 0) {
    remoteJog(+1);
  } else if (strcmp(cmd, "untwist") == 0) {
    remoteJog(-1);
  } else if (strcmp(cmd, "jog_stop") == 0) {
    remoteJogStop();
  } else if (strcmp(cmd, "stop") == 0) {
    remoteStopAll();
  }
}

// telemetry out - active->force (real strain gauge reading) feeds
// tension_n; state string reports remote-flow progress (see stateName()).
void sendTelemetryIfDue() {
  uint32_t now = millis();
  if (now - lastEmit < EMIT_MS) return;
  lastEmit = now;

  float force = active ? active->force : 0.0f;
  char line[80];
  snprintf(line, sizeof(line), UNIT_ID ",%lu,%lu,%.2f,%s",
           (unsigned long)seq, (unsigned long)now, force, stateName());
  int beginOk = txUdp.beginPacket(dest, TELEMETRY_PORT);
  if (beginOk) udpBeginOk++; else udpBeginFail++;
  txUdp.write((const uint8_t *)line, strlen(line));
  txUdp.write((uint8_t)'\n');
  int endOk = txUdp.endPacket();
  if (endOk) udpEndOk++; else udpEndFail++;
  seq++;
}

void printWifiHealthIfDue() {
  uint32_t now = millis();
  if (now - lastHealth < 5000) return;
  lastHealth = now;
  if (Serial) {
    Serial.print("# health wifi "); Serial.print(WiFi.status() == WL_CONNECTED ? "UP" : "DOWN");
    Serial.print(" ip "); Serial.print(WiFi.localIP());
    Serial.print(" rssi "); Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
    Serial.print(" cmdRxCount="); Serial.print(rxCount);
    Serial.print(" udp begin ok="); Serial.print(udpBeginOk); Serial.print(" fail="); Serial.print(udpBeginFail);
    Serial.print(" end ok="); Serial.print(udpEndOk); Serial.print(" fail="); Serial.println(udpEndFail);
  }
}

// Periodic, throttled print of what the active motor is actually being
// driven at - only fires while controlSignal is nonzero, i.e. the motor is
// genuinely signaled to move, and stays quiet otherwise. Reads
// active->controlSignal, which every drive path already writes before
// calling setMotor() (calculatePID, calibration seek, remoteJog above) - no
// changes to any of those functions needed, this only observes.
uint32_t lastMotorActivityPrint = 0;
const uint32_t MOTOR_ACTIVITY_PRINT_MS = 500;

void printMotorActivityIfDue() {
  uint32_t now = millis();
  if (now - lastMotorActivityPrint < MOTOR_ACTIVITY_PRINT_MS) return;
  lastMotorActivityPrint = now;
  if (!Serial || active == nullptr || active->controlSignal == 0) return;
  Serial.print("# motor "); Serial.print(active->name);
  Serial.print(" driving signal="); Serial.print(active->controlSignal);
  Serial.print(" position="); Serial.print(active->position);
  Serial.print(" force="); Serial.print(active->force);
  Serial.println(" N");
}

void setup()
{
  ledcSetup(1, FREQ, RES);
  ledcAttachPin(AIN1, 1);
  ledcSetup(2, FREQ, RES);
  ledcAttachPin(AIN2, 2);

  ledcSetup(3, FREQ, RES);
  ledcAttachPin(BIN1, 3);
  ledcSetup(4, FREQ, RES);
  ledcAttachPin(BIN2, 4);

  brakeAll();

  Serial.begin(115200);

  delay(2000);

  pinMode(ENC_C1, INPUT_PULLUP);
  pinMode(ENC_C2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ENC_C1), onEncoderRiseA, RISING);

  pinMode(ENC_C3, INPUT_PULLUP);
  pinMode(ENC_C4, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ENC_C4), onEncoderRiseB, RISING);

  // strain gauge setup:
  scaleA.begin(HX711_DT_A, HX711_SCK);
  scaleB.begin(HX711_DT_B, HX711_SCK);

  // experimentally deterimined scale factor A: -15147

  scaleA.set_scale(-15147.05067f);
  scaleB.set_scale(-18766.08337f);

  scaleA.tare();
  scaleB.tare();

  // ---- WiFi bring-up added on top of the actuation setup above ----------
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);

  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  if (Serial) {
    Serial.print("# " UNIT_ID " wifi ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
    Serial.println(WiFi.localIP());
  }
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);   // force max TX power, matching knee/hip

  txUdp.begin(TELEMETRY_PORT);
  rxUdp.begin(COMMAND_PORT);
  if (Serial) {
    Serial.print("# telemetry -> "); Serial.print(dest); Serial.print(":"); Serial.println(TELEMETRY_PORT);
    Serial.print("# commands listening on :"); Serial.println(COMMAND_PORT);
  }
  wdtBegin();   // arm last, after the blocking WiFi join above is done

  promptSelectMotor();
}


void loop()
{
  esp_task_wdt_reset();   // feed the watchdog every pass - see wdtBegin()
  checkZombieWifi();
  if (WiFi.status() == WL_CONNECTED) digitalWrite(LED_PIN, LED_ON);
  else digitalWrite(LED_PIN, ((millis() / 300) % 2) ? LED_ON : !LED_ON);

  handleSerialInput();

  if (state == OPPOINT_CALIBRATION && active != nullptr) {
    unsigned long now = micros();
    if (now - lastControlMicros >= CONTROL_INTERVAL_US) {
      float dt = (now - lastControlMicros) / 1000000.0f;
      lastControlMicros = now;
      bool newForceSample = updateForce(*active);
      runOppointCalibration(*active, dt, newForceSample);
    }
  }

  if (state == ANGLE_CONTROL && active != nullptr) {
    unsigned long now = micros();
    if (now - lastControlMicros >= CONTROL_INTERVAL_US) {
      float dt = (now - lastControlMicros) / 1000000.0f;
      lastControlMicros = now;
      calculatePID(*active, dt);
      updateForce(*active);
    }
  }

  if (state == FORCE_CONTROL && active != nullptr) {
    unsigned long now = micros();
    if (now - lastControlMicros >= CONTROL_INTERVAL_US) {
      float dt = (now - lastControlMicros) / 1000000.0f;
      lastControlMicros = now;
      updateForce(*active);
      calculateForcePID(*active);
      calculatePID(*active, dt);
    }

    // End-session release: forceSetpoint was already dropped to 0 by
    // remoteEndSession() - once the force PID above has actually driven
    // measured tension down to ~0N and held it there (not just crossed
    // through 0 on the way to overshooting), finish with a real stop
    // instead of leaving the motor sitting in FORCE_CONTROL forever.
    if (endSessionReleasing) {
      if (fabsf(active->force) < RELEASE_FORCE_TOL) {
        if (endSessionStableStartMs == 0) endSessionStableStartMs = millis();
        if (millis() - endSessionStableStartMs >= RELEASE_STABLE_MS) {
          if (Serial) Serial.println("# end session release complete, stopping");
          remoteStopAll();
        }
      } else {
        endSessionStableStartMs = 0;
      }
    }
  }

  if (state == FORCE_BRAKE_MOVE && active != nullptr) {
    unsigned long now = micros();
    if (now - lastControlMicros >= CONTROL_INTERVAL_US) {
      float dt = (now - lastControlMicros) / 1000000.0f;
      lastControlMicros = now;
      updateForce(*active);
      calculatePID(*active, dt);   // position PID toward the precomputed force target

      noInterrupts();
      long pos = active->position;
      interrupts();
      if (labs((long)active->setpoint - pos) <= BRAKE_POS_TOL) brakeSettleCounter++;
      else brakeSettleCounter = 0;

      if (brakeSettleCounter >= BRAKE_SETTLE_COUNT) {
        setMotor(*active, 0);      // slow-decay drive at 0 = both terminals high = brake
        state = FORCE_BRAKE_HOLD;
        Serial.print(F("# target reached, motor braked. measured force: "));
        Serial.print(active->force);
        Serial.println(F(" N   (enter new force to retarget, 'read-force', 'm', or 's')"));
      }
    }
  }

  if (state == FORCE_BRAKE_HOLD && active != nullptr) {
    // motor is braked; just keep the force reading fresh for the status line
    unsigned long now = micros();
    if (now - lastControlMicros >= CONTROL_INTERVAL_US) {
      lastControlMicros = now;
      updateForce(*active);
    }
  }

  printStatusIfDue();

  handleWifiCommands();
  serviceRemoteFlows();
  sendTelemetryIfDue();
  printWifiHealthIfDue();
  printMotorActivityIfDue();
}
