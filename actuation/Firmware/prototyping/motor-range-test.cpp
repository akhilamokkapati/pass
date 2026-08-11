#include <Arduino.h>

int PWM = 255;

const int AIN1 = D0;
const int AIN2 = D1;

void handleSerialInput() {
  if (!Serial.available()) return;
  char c = Serial.peek();
  if (c == '-' || c == '.' || (c >= '0' && c <= '9')) {
    PWM = Serial.parseInt();
    Serial.print(F("# new PWM: "));
    Serial.println(PWM);
  } else {
    Serial.read(); // discard unknown/whitespace characters
  }
}

void setup() {
    Serial.begin(115200);

    ledcSetup(1, 10000, 8);
    ledcSetup(2, 10000, 8);
    ledcAttachPin(AIN1, 1);
    ledcAttachPin(AIN2, 2);
}

void loop() {
    handleSerialInput();
    ledcWrite(1, PWM);
    ledcWrite(2, 0);
}