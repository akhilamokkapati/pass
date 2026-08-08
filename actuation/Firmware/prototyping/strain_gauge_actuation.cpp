#include <Arduino.h>
#include <HX711.h>


const int FREQ = 10000;
const int RES = 8;

const int AIN1 = D0;
const int AIN2 = D1;

const int HX711_DT_A = D8;
const int HX711_DT_B = D9;
const int HX711_SCK = D10;

HX711 scaleA;
HX711 scaleB;

float strainA = 0;
float strainB = 0;

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 200;

void setup() {
    Serial.begin(115200);
    delay(500);

    scaleA.begin(HX711_DT_A, HX711_SCK);
    scaleB.begin(HX711_DT_B, HX711_SCK);

    scaleA.tare();
    scaleB.tare();

    ledcSetup(1, FREQ, RES);
    ledcAttachPin(AIN1, 1);
    ledcSetup(2, FREQ, RES);
    ledcAttachPin(AIN2, 2);

}

void loop() {
    unsigned long now = millis();
    if (now - lastPrintMs >= PRINT_INTERVAL_MS) {
        lastPrintMs = now;
            Serial.print("strain A: ");
            Serial.print(strainA);
            Serial.print(", strain B: ");
            Serial.print(strainB);
            Serial.println();
    }

    if (scaleA.is_ready()) {
        strainA = scaleA.read();
    }

    if (scaleB.is_ready()) {
        strainB = scaleB.read();
    }

    if (strainA < 550000) {
        ledcWrite(1, 255);
        ledcWrite(2, 0);
    }
    else {
        ledcWrite(1, 0);
        ledcWrite(2, 0);
    }
}