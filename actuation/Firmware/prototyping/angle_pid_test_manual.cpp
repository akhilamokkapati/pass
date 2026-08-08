#include <Arduino.h>

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
}

void setup()
{
  Serial.begin(115200);

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

