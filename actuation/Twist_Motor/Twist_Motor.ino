// BTS7960B + 795 motor test sequence (Arduino Uno, hold-to-run button control)

const int RPWM = 5;   // Uno pins 5/6 give ~980Hz PWM by default
const int LPWM = 6;
const int R_EN = 10;
const int L_EN = 11;
const int R_IS = A1;
const int L_IS = A0;
const int button1 = 12; // LEFT
const int button2 = 13; // RIGHT

const int MAX_DUTY = 40;        // 0-255 scale (~16% duty)
const int RAMP_STEP_MS = 15;

// Uno 10-bit ADC @5V: 774mV safety limit -> 158 ADC steps
const int CURRENT_LIMIT_ADC = 158;

bool hardwareFaultTripped = false;

void setup() {
  Serial.begin(115200);

  pinMode(RPWM, OUTPUT);
  pinMode(LPWM, OUTPUT);
  pinMode(R_EN, OUTPUT);
  pinMode(L_EN, OUTPUT);

  // 3-pin button modules (VCC/GND/OUT) have their own onboard pull-down
  // and output HIGH when pressed, LOW when idle.
  pinMode(button1, INPUT);
  pinMode(button2, INPUT);

  digitalWrite(R_EN, HIGH);
  digitalWrite(L_EN, HIGH);

  analogWrite(RPWM, 0);
  analogWrite(LPWM, 0);
}

int readCurrentADC(int pin) {
  const int numSamples = 16;
  long total = 0;
  for (int i = 0; i < numSamples; i++) {
    total += analogRead(pin);
    delayMicroseconds(10);
  }
  return total / numSamples;
}

bool currentOK(int pin) {
  int adcVal = readCurrentADC(pin);
  float milliVolts = (adcVal * 5000.0) / 1023.0;
  float actualAmps = ((milliVolts / 1000.0) / 470.0) * 8500.0;

  static unsigned long lastPrint = 0;
  if (millis() - lastPrint >= 150) {
    Serial.print("Current_ADC:");
    Serial.print(adcVal);
    Serial.print(",Current_A:");
    Serial.println(actualAmps, 2);
    lastPrint = millis();
  }

  if (adcVal > CURRENT_LIMIT_ADC) {
    delayMicroseconds(50);
    int doubleCheckAdc = readCurrentADC(pin);
    if (doubleCheckAdc <= CURRENT_LIMIT_ADC) {
      return true;
    }
    float errorMv = (doubleCheckAdc * 5000.0) / 1023.0;
    Serial.print(F("\nREAL OVERCURRENT DETECTED! Read ADC: "));
    Serial.print(doubleCheckAdc);
    Serial.print(F(" (~"));
    Serial.print(((errorMv / 1000.0) / 470.0) * 8500.0, 1);
    Serial.println(F("A). Stopping motor."));
    return false;
  }
  return true;
}

bool softRamp(int pwmPin, int isPin, int targetDuty) {
  if (hardwareFaultTripped) return false;
  for (int duty = 0; duty <= targetDuty; duty += 5) {
    if (!currentOK(isPin)) {
      emergencyStop();
      return false;
    }
    analogWrite(pwmPin, duty);
    delay(RAMP_STEP_MS);
  }
  return true;
}

bool softRampDown(int pwmPin, int isPin, int startDuty) {
  if (hardwareFaultTripped) return false;
  for (int duty = startDuty; duty >= 0; duty -= 5) {
    if (!currentOK(isPin)) {
      emergencyStop();
      return false;
    }
    analogWrite(pwmPin, duty);
    delay(RAMP_STEP_MS);
  }
  return true;
}

void fullStop() {
  analogWrite(RPWM, 0);
  analogWrite(LPWM, 0);
}

void emergencyStop() {
  fullStop();
  digitalWrite(R_EN, LOW);
  digitalWrite(L_EN, LOW);
  hardwareFaultTripped = true;
}

// Ramps up, holds duty for as long as buttonPin reads HIGH, then ramps down.
void runHeld(int pwmPin, int isPin, int buttonPin, const __FlashStringHelper* label) {
  Serial.print(label);
  Serial.println(F(" pressed, holding..."));

  if (!softRamp(pwmPin, isPin, MAX_DUTY)) return;

  while (digitalRead(buttonPin) == HIGH) {
    if (!currentOK(isPin)) {
      emergencyStop();
      return;
    }
    delay(1);
  }

  if (!softRampDown(pwmPin, isPin, MAX_DUTY)) return;
  fullStop();

  Serial.print(label);
  Serial.println(F(" released."));
}

void loop() {
  if (hardwareFaultTripped) {
    Serial.println(F("System locked. Reset Uno to clear fault condition."));
    while (true) { delay(1000); }
  }

  bool leftPressed  = (digitalRead(button1) == HIGH); // module outputs HIGH when pressed
  bool rightPressed = (digitalRead(button2) == HIGH);

  if (leftPressed) {
    runHeld(LPWM, L_IS, button1, F("LEFT"));
  } else if (rightPressed) {
    runHeld(RPWM, R_IS, button2, F("RIGHT"));
  }

  // loop keeps polling both buttons; motor stays engaged for exactly
  // as long as the button is held, no permanent lockout unless a real
  // overcurrent fault trips emergencyStop()
}