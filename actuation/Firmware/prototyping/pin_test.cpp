#include <Arduino.h>

const int test_pin = D7;
const int ref_pin = D0;

void setup() {
    pinMode(test_pin, OUTPUT);
    pinMode(ref_pin, OUTPUT);
}

void loop() {
    digitalWrite(test_pin, HIGH);
    digitalWrite(ref_pin, HIGH);
}
