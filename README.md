# 🌡️ Home Temperature Dashboard

A lightweight, self-hosted dashboard for monitoring temperatures across multiple rooms in your home using ESP32 or ESP8266 sensors.

No cloud. No subscription. Runs entirely on your local network.

![Dashboard](https://img.shields.io/badge/status-working-brightgreen) ![Node](https://img.shields.io/badge/node-no_dependencies-blue) ![Hardware](https://img.shields.io/badge/hardware-ESP32%20%2F%20ESP8266-orange)

---

## Features

- Live temperature readings per room, auto-refreshing every 10 seconds
- Temperature history charts — click any room card to view its trend
- Color-coded status: COOL / GOOD / WARM / HOT
- Supports unlimited rooms (one ESP per room)
- No npm installs, no database — pure Node.js, runs out of the box
- Built-in Arduino code snippet shown right in the dashboard

---

## How It Works

```
[ESP32/ESP8266] ──HTTP POST──► [Node.js Server :3000] ──► [Browser Dashboard]
   (each room)                    (stores in memory)          (polls every 10s)
```

Each microcontroller reads its temperature sensor and POSTs a small JSON payload to your PC. The server stores readings in memory and serves the dashboard. The browser polls for updates automatically.

---

## Getting Started

### 1. Run the Server

No dependencies to install — just Node.js.

```bash
git clone https://github.com/YOUR_USERNAME/home-temp-dashboard.git
cd home-temp-dashboard
node server.js
```

Then open **http://localhost:3000** in your browser.

You'll see your local IP printed in the terminal — you'll need that for the ESP code.

---

### 2. Wire Up Your Sensor

Common sensor options:

| Sensor | Interface | Accuracy | Notes |
|--------|-----------|----------|-------|
| DHT22  | Digital   | ±0.5°C   | Best for most rooms |
| DS18B20 | 1-Wire   | ±0.5°C   | Waterproof version available |
| DHT11  | Digital   | ±2°C     | Budget option |
| SHT31  | I2C       | ±0.3°C   | High accuracy |

---

### 3. Flash Your ESP32 / ESP8266

Install these libraries in Arduino IDE first:
- `DHT sensor library` by Adafruit (if using DHT22/DHT11)
- `WiFi.h` — built into ESP32 core
- `HTTPClient.h` — built into ESP32 core

```cpp
#include <WiFi.h>          // Use <ESP8266WiFi.h> for ESP8266
#include <HTTPClient.h>
#include <DHT.h>

// ── Config ────────────────────────────────────────────
const char* ssid      = "YOUR_WIFI_SSID";
const char* password  = "YOUR_WIFI_PASSWORD";
const char* serverURL = "http://YOUR_PC_IP:3000/data";  // e.g. http://192.168.1.42:3000/data
const char* roomName  = "Living Room";                   // Change this per device

#define DHTPIN  4       // GPIO pin connected to DHT22 data line
#define DHTTYPE DHT22
// ──────────────────────────────────────────────────────

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConnected! IP: " + WiFi.localIP().toString());
}

void loop() {
  delay(2000); // DHT22 needs 2s between reads

  float tempC = dht.readTemperature();
  float tempF = dht.readTemperature(true); // pass true for Fahrenheit

  if (isnan(tempF)) {
    Serial.println("Failed to read from DHT sensor!");
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverURL);
    http.addHeader("Content-Type", "application/json");

    String payload = "{\"room\":\"" + String(roomName) + "\",\"temp\":" + String(tempF, 1) + "}";
    int httpCode = http.POST(payload);

    Serial.printf("[%s] %.1f°F → HTTP %d\n", roomName, tempF, httpCode);
    http.end();
  }

  delay(28000); // Wait ~30s total between sends
}
```

**For ESP8266**, replace:
```cpp
#include <WiFi.h>     →  #include <ESP8266WiFi.h>
#include <HTTPClient.h>  →  #include <ESP8266HTTPClient.h>
```

---

## API Reference

The server exposes two endpoints:

### `POST /data`
Send a temperature reading from your ESP.

**Body:**
```json
{
  "room": "Living Room",
  "temp": 72.5
}
```

**Response:**
```json
{ "ok": true }
```

---

### `GET /rooms`
Returns all stored room data.

**Response:**
```json
{
  "Living Room": [
    { "temp": 72.5, "timestamp": 1710000000000 },
    { "temp": 72.8, "timestamp": 1710000030000 }
  ],
  "Bedroom": [...]
}
```

---

## Project Structure

```
home-temp-dashboard/
├── server.js      # Node.js backend — receives sensor data, serves dashboard
├── index.html     # Dashboard UI — charts, room cards, live updates
└── README.md
```

---

## Tips

- **Multiple rooms**: Flash a separate ESP for each room, changing only the `roomName` constant
- **Keep PC awake**: The server needs to stay running; consider running it on a Raspberry Pi or an old laptop for 24/7 uptime
- **Finding your PC's IP**: On Windows run `ipconfig`, on Mac/Linux run `ifconfig` or `ip addr`
- **Firewall**: Make sure port 3000 is allowed through your local firewall so ESPs can reach the server
- **History limit**: The server keeps the last 100 readings per room in memory. Restarting the server clears history (no persistence yet)

---

## Roadmap / Ideas

- [ ] Persist history to a JSON file or SQLite
- [ ] Add humidity support (DHT22 already provides it)
- [ ] Email / push alerts when temperature goes out of range
- [ ] Raspberry Pi setup guide
- [ ] Dark/light mode toggle

---

## License

MIT — do whatever you want with it.
