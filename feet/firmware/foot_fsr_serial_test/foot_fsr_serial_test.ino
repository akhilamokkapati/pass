/*
 * foot_fsr_serial_test.ino  -  WIRED FSR diagnostic, no WiFi.
 *
 * Reads the same 16-channel FSR mux as the real foot firmware (foot_left.ino)
 * and prints the RAW ADC value of every channel to Serial. Use this to check
 * the FSR / mux / wiring directly over USB, with no network involved.
 *
 * Flash to a foot board (XIAO ESP32-S3), open Serial Monitor at 115200.
 *
 * HOW TO READ IT:
 *   - RAW value ~4095  = channel sitting at the 3.3V pull-up = NO pressure,
 *     or an open/unpowered mux (this is what "reads 0" on the dashboard was:
 *     the firmware sends 4095 - raw, so raw 4095 -> transmitted 0).
 *   - RAW drops toward 0 as you PRESS that pad harder.
 *   - If a pad stays ~4095 while you stand hard on it, that channel has NO
 *     signal path -> FSR lead, mux COMMON->GND, mux EN->GND, or mux Vcc.
 *   - "min" shows the most-pressed channel this scan: if min stays ~4095
 *     while standing, NOTHING is getting through (shared mux/ground fault).
 *
 * After diagnosing, re-flash the real firmware (foot_left.ino / foot_right.ino).
 */

// ===== exact pin map from foot_left.ino =====
#define PIN_SIG 1   // D0  GPIO1  ADC in, 220k pull-up to 3V3
#define PIN_S0  2   // D1  GPIO2  mux select
#define PIN_S1  3   // D2  GPIO3
#define PIN_S2  4   // D3  GPIO4
#define PIN_S3  7   // D8  GPIO7
// mux EN -> GND, COMMON -> GND

static const uint8_t SEL[4] = {PIN_S0, PIN_S1, PIN_S2, PIN_S3};

void selCh(uint8_t c) {
  for (uint8_t i = 0; i < 4; i++) digitalWrite(SEL[i], (c >> i) & 1);
}

int readCh(uint8_t c) {
  selCh(c);
  delayMicroseconds(120);          // mux settle
  analogRead(PIN_SIG);             // dummy read
  delayMicroseconds(80);
  int a = 0;
  for (int i = 0; i < 4; i++) { a += analogRead(PIN_SIG); delayMicroseconds(40); }
  return a / 4;
}

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 4; i++) pinMode(SEL[i], OUTPUT);
  pinMode(PIN_SIG, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SIG, ADC_11db);   // full ~0-3.3V range, same as real firmware
  delay(300);
  Serial.println("# foot_fsr_serial_test: RAW ADC per channel. ~4095 = no/open, drops when pressed.");
}

void loop() {
  int v[16];
  int mn = 4095, mnCh = -1;
  for (uint8_t c = 0; c < 16; c++) {
    v[c] = readCh(c);
    if (v[c] < mn) { mn = v[c]; mnCh = c; }
  }
  Serial.print("raw:");
  for (uint8_t c = 0; c < 16; c++) { Serial.print(' '); Serial.print(v[c]); }
  Serial.print("   | min="); Serial.print(mn); Serial.print("@ch"); Serial.print(mnCh);
  Serial.println(mn > 3900 ? "   <-- NOTHING pressing through" : "   <-- signal OK, pressing works");
  delay(250);   // ~4 Hz
}
