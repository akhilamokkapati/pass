#include <Arduino.h>

const int ENC_C1 = D5;
const int ENC_C2 = D6;

volatile long position;

void IRAM_ATTR onEncoderRiseA() {
  if (digitalRead(ENC_C2) == HIGH) position++;
    else position--;
}

void setup() {
    Serial.begin(115200);

    delay(2000);

    pinMode(ENC_C1, INPUT_PULLUP);
    pinMode(ENC_C2, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(ENC_C1), onEncoderRiseA, RISING);
}

void loop() {
    Serial.println(position);
}