#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <DHT.h>

// ── Config ────────────────────────────────────────────
const char* ssid      = "YOUR_WIFI_SSID";
const char* password  = "YOUR_WIFI_PASSWORD";
const char* serverURL = "http://YOUR_PC_IP:3000/data";  // e.g. http://192.168.1.42:3000/data
const char* roomName  = "Living Room";                   // Change this per device

#define DHTPIN  4       // GPIO4 = D2 on most ESP8266 boards
#define DHTTYPE DHT22
// ──────────────────────────────────────────────────────

DHT dht(DHTPIN, DHTTYPE);
WiFiClient wifiClient;

void setup() {
  Serial.begin(115200);
  Serial.println();
  dht.begin();

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("Connected! IP: " + WiFi.localIP().toString());
}

void loop() {
  delay(2000);  // DHT22 needs 2s between reads

  float tempF = dht.readTemperature(true);  // true = Fahrenheit

  if (isnan(tempF)) {
    Serial.println("Failed to read from DHT sensor!");
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(wifiClient, serverURL);
    http.addHeader("Content-Type", "application/json");

    String payload = "{\"room\":\"" + String(roomName) + "\",\"temp\":" + String(tempF, 1) + "}";
    int httpCode = http.POST(payload);

    Serial.printf("[%s] %.1f°F -> HTTP %d\n", roomName, tempF, httpCode);
    http.end();
  } else {
    Serial.println("WiFi disconnected, reconnecting...");
    WiFi.begin(ssid, password);
  }

  delay(28000);  // ~30s total between sends
}
