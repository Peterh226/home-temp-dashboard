# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Server

```bash
node server.js          # Normal mode — waits for real sensor data
node server.js --demo   # Demo mode — generates fake room data automatically
```

Open **http://localhost:3000** after starting. No `npm install` needed — zero dependencies, pure Node.js built-ins only.

## Architecture

This is a two-component IoT dashboard:

**Backend (`server.js`)** — Plain Node.js HTTP server (no framework) on port 3000:
- Stores all data in-memory (`roomData` object: `{ roomName: [{temp, timestamp}] }`, max 100 readings/room)
- `POST /data` — receives readings from ESP sensors
- `GET /rooms` — returns all room data as JSON
- `GET /ecobee` — returns thermostat setpoint/program data
- `GET /` — serves `index.html`
- Polls **Ambient Weather API** every 60s (adds "Outside" and "Weather Station Indoor" rooms)
- Polls **Beestat/Ecobee API** every 3 minutes (adds "Ecobee: <sensor name>" rooms + `ecobeeData`)
- Data is lost on server restart (no persistence)

**Frontend (`index.html`)** — Single-file vanilla JS dashboard, no build step:
- Polls `/rooms` every 10 seconds
- Room cards with color-coded temperature status (COOL <65°F / GOOD 65–74 / WARM 74–80 / HOT ≥80)
- Two Chart.js charts: single-room history (click a card) + all-rooms comparison
- "DEMO DATA" button injects client-side fake data without hitting the server
- Consistent room colors assigned via `colorMap` (persists across re-renders)

**Arduino (`TempSensor/`)** — ESP8266 sketch for DHT22 sensors:
- Credentials go in `TempSensor/config.h` (gitignored); copy from `config.h.example`
- Posts `{"room": "...", "temp": 72.5}` to `http://<server-ip>:3000/data` every ~30s

## Configuration

API keys and integration settings live in `server-config.json` (gitignored). Copy from `server-config.json.example`:

```json
{
  "ambientWeather": { "apiKey": "...", "applicationKey": "..." },
  "beestat": { "apiKey": "..." }
}
```

Both integrations are optional — omitting `server-config.json` disables them silently.
