#include <Arduino.h>
#include <HX711.h>


const int FREQ = 10000;
const int RES = 8;

const int AIN1 = D4;
const int AIN2 = D3;

const int HX711_DT_A = D8;
const int HX711_DT_B = D9;
const int HX711_SCK = D10;

HX711 scaleA;
HX711 scaleB;

float strainA = 0;
float strainB = 0;

float weightA = 0;

unsigned long lastPrintMs = 0;
const unsigned long PRINT_INTERVAL_MS = 200;

float strain_to_weight(float strain) {
    return (strain - 9843.25) / 21606;
}

void setup() {
    Serial.begin(115200);
    delay(500);

    scaleA.begin(HX711_DT_A, HX711_SCK);
    scaleB.begin(HX711_DT_B, HX711_SCK);

    ledcSetup(1, FREQ, RES);
    ledcAttachPin(AIN1, 1);
    ledcSetup(2, FREQ, RES);
    ledcAttachPin(AIN2, 2);

    Serial.println("Before setting up the scale:");
    Serial.print("read: \t\t");
    Serial.println(scaleA.read());			// print a raw reading from the ADC

    Serial.print("read average: \t\t");
    Serial.println(scaleA.read_average(20));  	// print the average of 20 readings from the ADC

    Serial.print("get value: \t\t");
    Serial.println(scaleA.get_value(5));		// print the average of 5 readings from the ADC minus the tare weight (not set yet)

    Serial.print("get units: \t\t");
    Serial.println(scaleA.get_units(5), 1);	// print the average of 5 readings from the ADC minus tare weight (not set) divided
                            // by the SCALE parameter (not set yet)

    scaleA.set_scale(21606.f);                      // this value is obtained by calibrating the scale with known weights; see the README for details
    scaleA.tare();				        // reset the scale to 0

    Serial.println("After setting up the scale:");

    Serial.print("read: \t\t");
    Serial.println(scaleA.read());                 // print a raw reading from the ADC

    Serial.print("read average: \t\t");
    Serial.println(scaleA.read_average(20));       // print the average of 20 readings from the ADC

    Serial.print("get value: \t\t");
    Serial.println(scaleA.get_value(5));		// print the average of 5 readings from the ADC minus the tare weight, set with tare()

    Serial.print("get units: \t\t");
    Serial.println(scaleA.get_units(5), 1);        // print the average of 5 readings from the ADC minus tare weight, divided
                            // by the SCALE parameter set with set_scale

    Serial.println("Readings:");

}

void loop() {
    unsigned long now = millis();
    if (now - lastPrintMs >= PRINT_INTERVAL_MS) {
        lastPrintMs = now;
            Serial.print("strain A (tared): ");
            Serial.print(strainA);
            Serial.print(", strain B: ");
            Serial.print(strainB);
            Serial.println();
    }

    if (scaleA.is_ready()) {
        strainA = scaleA.get_units(5);
    }

    if (scaleB.is_ready()) {
        strainB = scaleB.read();
    }

    if (strainA > -10) {
        ledcWrite(1, 255);
        ledcWrite(2, 0);
    } else {
        ledcWrite(1, 0);
        ledcWrite(2, 0);
    }
}