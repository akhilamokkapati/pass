#include <Arduino.h>

<<<<<<< Updated upstream
const int AIN1 = D2;
const int AIN2 = D3;
const int ENCODER_C1 = D4;
const int ENCODER_C2 = D5;

float angleSetpoint = 0;
float measuredAngle = 0;

volatile long position;

float Kp = 0.1, Ki = 0, Kd = 0; // tune here directly

float previousTime = 0; //for calculating delta t
float previousError = 0; //for calculating the derivative (edot)
float errorIntegral = 0; //integral error
unsigned long currentTime = 0; //time in the moment of calculation
unsigned long deltaTime = 0; //time difference
float errorValue = 0; //error
float edot = 0; //derivative (de/dt)
float controlSignal = 0;
float PWMValue = 0;

void IRAM_ATTR onEncoderRise() {
  if (digitalRead(ENCODER_C2) == HIGH) position++;
  else position--;
=======
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

float Kp = 1, Ki = 0, Kd = 0;

// Motor States

struct Motor {
  const char name;

  const int ch1, ch2;
  const int encPin2;

  volatile long position;

  float setpoint;
  float prevError;
  float errorIntegral;
  float controlSignal;
};

Motor motorA = {'A', 1, 2, ENC_C2, 0, 0, 0, 0, 0};
Motor motorB = {'B', 3, 4, ENC_C4, 0, 0, 0, 0, 0};


void IRAM_ATTR onEncoderRiseA() {
  if (digitalRead(ENC_C2) == HIGH) motorA.position++;
    else motorA.position--;
}

void IRAM_ATTR onEncoderRiseB() {
  if (digitalRead(ENC_C4) == HIGH) motorB.position++;
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

void resetPID(Motor& m) {
  m.prevError = m.setpoint - m.position;
  m.errorIntegral = 0;
  m.controlSignal = 0;
}

void calculatePID(Motor& m, float dt)
{
  float measured = (float)m.position;

  float error = measured - m.setpoint;

  float edot = (error - m.prevError) / dt;
  
  m.errorIntegral += (error * dt); //integral term - Newton-Leibniz, notice, this is a running sum!

  m.controlSignal = (Kp * error) + (Kd * edot) + (Ki * m.errorIntegral); //final sum, proportional term also calculated here

  m.prevError = error; //save the error for the next iteration to get the difference (for edot)

  setMotor(m, m.controlSignal);
}

// serial state machine
enum State { SELECT_MOTOR, AWAIT_SETPOINT, RUNNING };
// set default starting state
State state = SELECT_MOTOR;
Motor* active = nullptr;

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

void promptSetpoint() {
  Serial.print(F("# motor "));
  Serial.print(active->name);
  Serial.print(F(" selected (position "));
  Serial.print(active->position);
  Serial.println(F(" counts)"));
  Serial.println(F("#   enter target angle in counts, or:"));
  Serial.println(F("#   z = zero encoder here, m = back to motor select"));
}

void handleSerialInput() {
  String line;
  if (!readLine(line)) return;
  if (line.length() == 0) return;

  Serial.print("H");

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
      state = AWAIT_SETPOINT;
      promptSetpoint();
      break;

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
      } else if (c == '-' || c == '.' || isdigit(c)) {
        active->setpoint = line.toFloat();
        resetPID(*active);
        state = RUNNING;
        Serial.print(F("# running motor "));
        Serial.print(active->name);
        Serial.print(F(" -> setpoint "));
        Serial.print(active->setpoint);
        Serial.println(F(" counts   ('s' stops, 'm' re-selects)"));
      } else {
        Serial.println(F("# ? enter a number, 'z', or 'm'"));
      }
      break;

  case RUNNING:
    if (c == 'm') {
        setMotor(*active, 0);
        active = nullptr;
        state = SELECT_MOTOR;
        promptSelectMotor();
      } else if (c == '-' || c == '.' || isdigit(c)) {
        active->setpoint = line.toFloat();   // retarget on the fly
        Serial.print(F("# new setpoint: "));
        Serial.println(active->setpoint);
      }
      break;
  }
}

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 100;

void printStatusIfDue() {
  if (state != RUNNING || active == nullptr) return;
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;
 
  // One line, one println - Teleplot/Serial Plotter need it that way.
  Serial.print(F(">setpoint:"));   Serial.print(active->setpoint);
  Serial.print(F(",measured:"));   Serial.print(active->position);
  Serial.print(F(",error:"));      Serial.print(active->setpoint - active->position);
  Serial.print(F(",control:"));    Serial.print(active->controlSignal);
  Serial.println();

>>>>>>> Stashed changes
}

void setup()
{
  Serial.begin(115200);
<<<<<<< Updated upstream

  //Motor encoder-related
  pinMode(ENCODER_C1, INPUT);
  pinMode(ENCODER_C2, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENCODER_C1), onEncoderRise, RISING);

}

void loop()
{
  measuredAngle = position;

  calculatePID();

  setMotor();
}

void setMotor() {
  if (controlSignal >= 0) {
    PWMValue = constrain(controlSignal, 100, 255);
    analogWrite(AIN1, PWMValue);
    analogWrite(AIN2, 0);
  } else {
    PWMValue = constrain(controlSignal, -255, -100);
    analogWrite(AIN1, 0);
    analogWrite(AIN2, -PWMValue);
  }
}

void calculatePID()
{
  //Determining the elapsed time
  currentTime = micros(); //current time
  deltaTime = (currentTime - previousTime) / 1000000.0; //time difference in seconds
  previousTime = currentTime; //save the current time for the next iteration to get the time difference
  //---
  errorValue = measuredAngle - angleSetpoint; //Current position - target position (or setpoint)

  edot = (errorValue - previousError) / deltaTime; //edot = de/dt - derivative term

  errorIntegral = errorIntegral + (errorValue * deltaTime); //integral term - Newton-Leibniz, notice, this is a running sum!

  controlSignal = (Kp * errorValue) + (Kd * edot) + (Ki * errorIntegral); //final sum, proportional term also calculated here

  previousError = errorValue; //save the error for the next iteration to get the difference (for edot)

}

=======
  delay(2000);

  ledcSetup(1, FREQ, RES);
  ledcAttachPin(AIN1, 1);
  ledcSetup(2, FREQ, RES);
  ledcAttachPin(AIN2, 2);

  ledcSetup(3, FREQ, RES);
  ledcAttachPin(BIN1, 3);
  ledcSetup(4, FREQ, RES);
  ledcAttachPin(BIN2, 4);

  pinMode(ENC_C1, INPUT_PULLUP);
  pinMode(ENC_C2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ENC_C1), onEncoderRiseA, RISING);

  pinMode(ENC_C3, INPUT);
  pinMode(ENC_C4, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENC_C3), onEncoderRiseB, RISING);

  brakeAll();


  promptSelectMotor();
}


void loop()
{
  handleSerialInput();

  if (state == RUNNING && active != nullptr) {
    unsigned long now = micros();
    unsigned long elapsed = now - lastControlMicros;   // unsigned -> rollover-safe
    calculatePID(*active, elapsed / 1000000.0f);
  }
 
  printStatusIfDue();
}
>>>>>>> Stashed changes
