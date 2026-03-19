#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <DHT.h>

// ── Config (edit config.h with your credentials) ─────
#include "config.h"

#define DHTPIN  4       // GPIO4 = D2 on most ESP8266 boards
#define DHTTYPE DHT22
#define LED_PIN 2       // Built-in LED on NodeMCU (active LOW)
#define SLEEP_US 300000000UL  // 5 minutes in microseconds
// ──────────────────────────────────────────────────────

DHT dht(DHTPIN, DHTTYPE);
WiFiClient wifiClient;

void setup() {
  Serial.begin(115200);
  Serial.println();
  dht.begin();

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);  // OFF (active LOW)

  // Connect to WiFi
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(LED_PIN, LOW);
    delay(250);
    digitalWrite(LED_PIN, HIGH);
    delay(250);
    Serial.print(".");
    if (millis() - start > 30000) {
      Serial.println("\nWiFi timeout — sleeping and retrying");
      ESP.deepSleep(SLEEP_US);
    }
  }
  Serial.println();
  Serial.println("Connected! IP: " + WiFi.localIP().toString());
  Serial.println("MAC: " + WiFi.macAddress());

  delay(2000);  // DHT22 needs 2s to stabilize
  float tempF = dht.readTemperature(true);  // true = Fahrenheit

  if (isnan(tempF)) {
    Serial.println("Failed to read from DHT sensor — sleeping");
    ESP.deepSleep(SLEEP_US);
  }

  HTTPClient http;
  http.begin(wifiClient, serverURL);
  http.addHeader("Content-Type", "application/json");

  String mac = WiFi.macAddress();
  String payload = "{\"mac\":\"" + mac + "\",\"temp\":" + String(tempF, 1) + "}";
  int httpCode = http.POST(payload);

  String roomName = mac;  // fallback if response can't be parsed
  if (httpCode == 200) {
    String response = http.getString();
    int idx = response.indexOf("\"room\":\"");
    if (idx >= 0) {
      int start = idx + 8;
      int end = response.indexOf("\"", start);
      if (end > start) roomName = response.substring(start, end);
    }
  }
  Serial.printf("[%s] %s — %.1f°F -> HTTP %d\n", mac.c_str(), roomName.c_str(), tempF, httpCode);
  http.end();

  // Blink LED to confirm send
  digitalWrite(LED_PIN, LOW);
  delay(100);
  digitalWrite(LED_PIN, HIGH);

  Serial.println("Sleeping for 5 minutes...");
  ESP.deepSleep(SLEEP_US);
}

void loop() {
  // Never reached — chip sleeps and restarts via RST
}
