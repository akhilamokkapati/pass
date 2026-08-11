/*
 * angle_pid_wifi_test.cpp
 * angle_pid_test_manual.cpp's motor/PID/serial/strain-gauge logic,
 * unmodified, with the WiFi networking layer from wifi_bringup.cpp added on
 * top. Goal: validate the webapp <-> board round trip, not yet drive the
 * motors from webapp commands.
 *
 * Resynced 2026-08-10 against angle_pid_test_manual.cpp's HX711 update -
 * strain gauges, per-motor force reading, fixed-interval PID, and the
 * encoder-B ISR pin fix all carried over verbatim from there.
 *
 * Telemetry out (UDP :5007): sends active->force (real strain gauge
 * reading) in tension_n's slot, switched over from the earlier
 * active->position placeholder now that a real strain gauge exists.
 * Commands in (UDP :5008): received and logged only, same as
 * wifi_bringup.cpp - NOT mapped onto the motor/setpoint state machine yet.
 * Serial control (motor select, setpoint, z/s/m/read-force) is completely
 * untouched.
 */

#include <Arduino.h>
#include <HX711.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_task_wdt.h>

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

const int HX711_DT_A = D0;
const int HX711_DT_B = D9;
const int HX711_SCK = D1;

HX711 scaleA;
HX711 scaleB;

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

  HX711* scale;

  float force;

  int sign;
};

Motor motorA = {'A', 1, 2, ENC_C2, 0, 0, 0, 0, 0, &scaleA, 0, 1};
Motor motorB = {'B', 3, 4, ENC_C4, 0, 0, 0, 0, 0, &scaleB, 0, -1};


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

      if (active) {
        if (active->scale->is_ready()) {
          Serial.println("Strain Gauge Ready");
        }
        else {
          Serial.println("Strain Gauge not ready");
        }
      }

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
  Serial.print(F(",Force/N:"));    Serial.print(active->force);
  Serial.println();

}

void updateForce (Motor& m) {
  if(!m.scale->is_ready()) return;
  m.force = m.scale->get_units(1);
}

// ---- WiFi bring-up (added - see wifi_bringup.cpp for the source of this
// section and the reasoning behind the watchdog/zombie-WiFi guards) --------

#define UNIT_ID "actuation"
#define WIFI_SSID "TP-Link_1285"
#define WIFI_PASS "15289346"
#define DEST_IP "192.168.0.255"
#define TELEMETRY_PORT 5007
#define COMMAND_PORT   5008
#define EMIT_MS 200

#define WDT_TIMEOUT_S 8
#define ZOMBIE_CHECK_MS 3000
#define ZOMBIE_LIMIT    3

#define LED_PIN 21
#define LED_ON  LOW

WiFiUDP txUdp;
WiFiUDP rxUdp;
IPAddress dest;

uint32_t seq = 0;
uint32_t lastEmit = 0;
uint32_t lastHealth = 0;
uint32_t rxCount = 0;
uint32_t udpBeginOk = 0, udpBeginFail = 0, udpEndOk = 0, udpEndFail = 0;

void wdtBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdtConfig = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
}

void wifiBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  dest.fromString(DEST_IP);
}

const char* stateName() {
  switch (state) {
    case SELECT_MOTOR:   return "select_motor";
    case AWAIT_SETPOINT: return "await_setpoint";
    case RUNNING:         return "running";
  }
  return "idle";
}

void checkZombieWifi() {
  static uint32_t lastZombieCheck = 0;
  static uint8_t  zombieStreak = 0;
  uint32_t now = millis();
  if (now - lastZombieCheck < ZOMBIE_CHECK_MS) return;
  lastZombieCheck = now;
  if (WiFi.status() == WL_CONNECTED && WiFi.RSSI() == 0) {
    if (++zombieStreak >= ZOMBIE_LIMIT) {
      if (Serial) Serial.println("# WARN zombie WiFi (RSSI stuck at 0) - forcing reconnect");
      WiFi.disconnect();
      zombieStreak = 0;
    }
  } else {
    zombieStreak = 0;
  }
}

// commands in - logged only, NOT mapped onto the motor state machine yet
void handleWifiCommands() {
  int packetSize = rxUdp.parsePacket();
  if (!packetSize) return;
  char buf[128];
  int len = rxUdp.read(buf, sizeof(buf) - 1);
  if (len > 0) buf[len] = 0; else buf[0] = 0;
  rxCount++;
  if (Serial) {
    Serial.print("# CMD RX from "); Serial.print(rxUdp.remoteIP());
    Serial.print(" -> \""); Serial.print(buf); Serial.println("\"");
  }
}

// telemetry out - active->force (real strain gauge reading) now feeds
// tension_n. Only updates while state == RUNNING (see updateForce()'s call
// site in loop() - untouched, part of the resynced actuation code), so
// select a motor and enter a setpoint over Serial to see it move.
void sendTelemetryIfDue() {
  uint32_t now = millis();
  if (now - lastEmit < EMIT_MS) return;
  lastEmit = now;

  float force = active ? active->force : 0.0f;
  char line[80];
  snprintf(line, sizeof(line), UNIT_ID ",%lu,%lu,%.2f,%s",
           (unsigned long)seq, (unsigned long)now, force, stateName());
  int beginOk = txUdp.beginPacket(dest, TELEMETRY_PORT);
  if (beginOk) udpBeginOk++; else udpBeginFail++;
  txUdp.write((const uint8_t *)line, strlen(line));
  txUdp.write((uint8_t)'\n');
  int endOk = txUdp.endPacket();
  if (endOk) udpEndOk++; else udpEndFail++;
  seq++;
}

void printWifiHealthIfDue() {
  uint32_t now = millis();
  if (now - lastHealth < 5000) return;
  lastHealth = now;
  if (Serial) {
    Serial.print("# health wifi "); Serial.print(WiFi.status() == WL_CONNECTED ? "UP" : "DOWN");
    Serial.print(" ip "); Serial.print(WiFi.localIP());
    Serial.print(" rssi "); Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
    Serial.print(" cmdRxCount="); Serial.print(rxCount);
    Serial.print(" udp begin ok="); Serial.print(udpBeginOk); Serial.print(" fail="); Serial.print(udpBeginFail);
    Serial.print(" end ok="); Serial.print(udpEndOk); Serial.print(" fail="); Serial.println(udpEndFail);
  }
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

  scaleA.set_scale(15147.f);
  scaleB.set_scale(18766.f);

  scaleA.tare();
  scaleB.tare();

  // ---- WiFi bring-up added on top of the actuation setup above ----------
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);

  wifiBegin();
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 20000) delay(250);
  if (Serial) {
    Serial.print("# " UNIT_ID " wifi ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "JOINED " : "FAILED (auto-retrying) ");
    Serial.println(WiFi.localIP());
  }
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);   // force max TX power, matching knee/hip

  txUdp.begin(TELEMETRY_PORT);
  rxUdp.begin(COMMAND_PORT);
  if (Serial) {
    Serial.print("# telemetry -> "); Serial.print(dest); Serial.print(":"); Serial.println(TELEMETRY_PORT);
    Serial.print("# commands listening on :"); Serial.println(COMMAND_PORT);
  }
  wdtBegin();   // arm last, after the blocking WiFi join above is done

  promptSelectMotor();
}


void loop()
{
  esp_task_wdt_reset();   // feed the watchdog every pass - see wdtBegin()
  checkZombieWifi();
  if (WiFi.status() == WL_CONNECTED) digitalWrite(LED_PIN, LED_ON);
  else digitalWrite(LED_PIN, ((millis() / 300) % 2) ? LED_ON : !LED_ON);

  handleSerialInput();

  if (state == RUNNING && active != nullptr) {
    unsigned long now = micros();
    if (now - lastControlMicros >= CONTROL_INTERVAL_US) {
      float dt = (now - lastControlMicros) / 1000000.0f;
      lastControlMicros = now;
      calculatePID(*active, dt);
      updateForce(*active);
    }
  }

  printStatusIfDue();

  handleWifiCommands();
  sendTelemetryIfDue();
  printWifiHealthIfDue();
}
