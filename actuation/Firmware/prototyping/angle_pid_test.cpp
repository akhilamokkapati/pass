// Isolated inner-loop test, XIAO ESP32-C3. Just the angle PID -> motor,
// single fixed setpoint - lets Kp/Ki/Kd be tuned directly without the outer
// force loop or a manual jog mode in the way.
//
// UNVALIDATED: Kp/Ki/Kd, MIN_DUTY/MAX_DUTY/OUTPUT_DEADBAND - starting
// guesses, tune from here. Controller direction is DIRECT - REVERSE was
// tried and made the response diverge (appliedPwm ran away instead of
// settling), so DIRECT is back until the sign behavior is re-checked.
//
// Plot format: badlogic serial-plotter. One line per print, all variables
// comma-separated after a single leading '>', shares one plot pane by
// default: ">name:value,name2:value2\r\n"

#include <Arduino.h>
#include <PID_v1.h>

// ---- Pins ----
const int AIN1 = D2;
const int AIN2 = D3;
const int ENCODER_C1 = D4;
const int ENCODER_C2 = D5;

// ---- PID_v1 variables - the three doubles the library reads/writes on every Compute() ----
double angleSetpoint = 500; // theta_d, encoder counts - fixed target for this tuning pass
double measuredAngle = 0;   // theta_o, encoder counts (double copy of `position` - PID needs a double, not a volatile long)
double pidOutput = 0;       // signed PWM the PID *wants* - not what's actually sent to the motor, see setMotor()/appliedPwm

// ---- PID gains - tune here directly ----
double Kp = 5.0, Ki = 0.0, Kd = 0.5;

PID anglePID(&measuredAngle, &pidOutput, &angleSetpoint, Kp, Ki, Kd, DIRECT);

// ---- Motor drive shaping ----
const int MIN_DUTY = 0;       // minimum PWM to overcome motor/gearbox static friction - below this the motor doesn't turn at all
const int MAX_DUTY = 70;      // upper duty limit, unvalidated starting point for this board's motor/driver
const int OUTPUT_DEADBAND = 5; // |pidOutput| under this counts as "close enough" - motor fully stops instead of being floored up to MIN_DUTY

volatile long position = 0;
int appliedPwm = 0; // actual signed PWM last written to the driver, after deadband/floor/clamp - what we plot instead of the raw pidOutput

void IRAM_ATTR onEncoderRise() {
  if (digitalRead(ENCODER_C2) == HIGH) position++;
  else position--;
}

// Maps the PID's raw request to what's actually sent to the driver:
// inside the deadband -> motor off; outside it -> floored to MIN_DUTY (so it
// can actually move) and capped at MAX_DUTY. Without the deadband, any
// nonzero output - however tiny - got floored up to MIN_DUTY too, so the
// motor was never able to fully stop (this was the earlier bug: Kp changes
// barely mattered because MIN_DUTY dominated regardless of the computed
// output's size).
void setMotor(int signedSpeed) {
  if (signedSpeed > OUTPUT_DEADBAND) {
    appliedPwm = constrain(signedSpeed, MIN_DUTY, MAX_DUTY);
  } else if (signedSpeed < -OUTPUT_DEADBAND) {
    appliedPwm = constrain(signedSpeed, -MAX_DUTY, -MIN_DUTY);
  } else {
    appliedPwm = 0;
  }

  if (appliedPwm >= 0) {
    analogWrite(AIN1, appliedPwm);
    analogWrite(AIN2, 0);
  } else {
    analogWrite(AIN1, 0);
    analogWrite(AIN2, -appliedPwm);
  }
}

void handleSerialInput() {
  if (!Serial.available()) return;
  char c = Serial.peek();
  if (c == 'x' || c == 'X') {
    Serial.read();
    angleSetpoint = 0;
    setMotor(0); // real instant stop
    Serial.println(F("# stop - setpoint zeroed"));
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

  Serial.print(F(">angleSetpoint:"));
  Serial.print(angleSetpoint);
  Serial.print(F(",measuredAngle:"));
  Serial.print(measuredAngle);
  Serial.print(F(",appliedPwm:"));
  Serial.println(appliedPwm);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);
  analogWrite(AIN1, 0);
  analogWrite(AIN2, 0);

  pinMode(ENCODER_C1, INPUT_PULLUP);
  pinMode(ENCODER_C2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ENCODER_C1), onEncoderRise, RISING);

  // ---- PID_v1 setup, grouped in the order these calls matter ----
  anglePID.SetOutputLimits(-MAX_DUTY, MAX_DUTY); // clamps pidOutput to what setMotor can use - also bounds the library's internal integral accumulator so it can't wind up past this range
  anglePID.SetSampleTime(10);                    // recompute at most every 10ms (100Hz) - Compute() below is a no-op on any call before this elapses
  anglePID.SetMode(AUTOMATIC);                   // turns the loop on - Compute() does nothing until this is set

  Serial.println(F("# angle_pid_test ready - fixed setpoint 500, type a new target (encoder counts) + Enter, 'x' to stop, 'z' to zero the encoder position"));
}

void loop() {
  handleSerialInput();

  measuredAngle = position;
  anglePID.Compute(); // no-op unless SetSampleTime's interval has elapsed; otherwise reads measuredAngle/angleSetpoint and writes pidOutput
  setMotor((int)pidOutput);

  printStatusIfDue();
}
