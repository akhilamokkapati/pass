#include <Arduino.h>
#include <HX711.h>
#include <cmath>

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
  bool printable = (state == ANGLE_CONTROL || state == FORCE_BRAKE_MOVE || state == FORCE_BRAKE_HOLD);
  if (!printable || active == nullptr) return;
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;
 
  // One line, one println - Teleplot/Serial Plotter need it that way.
  Serial.print(F(">setpoint:"));   Serial.print(active->setpoint);
  Serial.print(F(",measured:"));   Serial.print(active->position);
  Serial.print(F(",error:"));      Serial.print(active->setpoint - active->position);
  Serial.print(F(",control:"));    Serial.print(active->controlSignal);
  Serial.print(F(",Force/N:"));    Serial.print(active->force);
  Serial.println();

}

bool updateForce (Motor& m) {
  if(!m.scale->is_ready()) return false;
  m.force = m.scale->get_units(1);
  return true;
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

  promptSelectMotor();
}


void loop()
{
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
}