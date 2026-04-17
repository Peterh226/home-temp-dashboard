# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Server

```bash
node server.js          # Normal mode — waits for real sensor data
node server.js --demo   # Demo mode — generates fake room data automatically
```

Open **http://localhost:3000** after starting. No `npm install` needed — zero dependencies, pure Node.js built-ins only.

## Server Process Management (pm2)

pm2 keeps the server running and auto-starts it on system boot.

**One-time setup on the server:**
```bash
npm install -g pm2
cd /path/to/HomeTempDashboard
pm2 start server.js --name homedash
pm2 startup          # follow the printed command to enable auto-start on boot
pm2 save             # save process list so it survives reboots
```

**After pulling a code update:**
```bash
git pull && pm2 restart homedash
```

**Other useful commands:**
```bash
pm2 logs homedash    # live console output
pm2 status           # check if running
pm2 stop homedash    # stop the server
```

## Architecture

This is a two-component IoT dashboard:

**Backend (`server.js`)** — Plain Node.js HTTP server (no framework) on port 3000:
- Stores all data in-memory (`roomData` object: `{ roomName: [{temp, timestamp}] }`, max 100 readings/room)
- `POST /data` — receives readings from ESP sensors (`{ mac, temp }`)
- `GET /rooms` — returns all room data as JSON
- `GET /vents` — returns vent open/closed state per room
- `POST /vent` — sets vent state for a room (`{ room, state: 'open'|'closed' }`)
- `GET /ecobee` — returns thermostat setpoint/program data
- `GET /` — serves `index.html`
- Polls **Ambient Weather API** every 5 minutes (adds "Outside" and "Weather Station Indoor" rooms)
- Polls **Beestat/Ecobee API** every 5 minutes (adds "Ecobee: <sensor name>" rooms + `ecobeeData`)
- Saves `roomData` + `ventState` + `hvacLog` to `data.json` every 10 minutes; reloads last 24 hours on startup
- Appends every reading to `data-log.ndjson` (permanent log, never trimmed); backed up nightly to Dropbox via rclone (`PBH_DropBox:HomeTempDashboard/`)
- `GET /hvac` — returns HVAC status log (`[{status: 'heat'|'cool'|'fan'|'off', timestamp}]`)

**Frontend (`index.html`)** — Single-file vanilla JS dashboard, no build step:
- Polls `/rooms` every 10 seconds
- Room cards with color-coded temperature status (COOL <65°F / GOOD 65–74 / WARM 74–80 / HOT ≥80)
- Vent open/closed toggle button on each room card
- Two Chart.js charts: single-room history (click a card) + all-rooms comparison
- "DEMO DATA" button injects client-side fake data without hitting the server
- Consistent room colors assigned via `colorMap` (persists across re-renders)

**Arduino (`TempSensor/`)** — ESP8266 sketch for DHT22 sensors:
- Credentials go in `TempSensor/config.h` (gitignored); copy from `config.h.example`
- Posts `{"mac": "AA:BB:CC:DD:EE:FF", "temp": 72.5}` to `http://<server-ip>:3000/data` every 5 minutes
- Uses deep sleep between readings — **requires GPIO16 (D0) bridged to RST** with a jumper wire
- Server resolves room name from MAC address via `server-config.json` sensors map
- WiFi timeout after 30s sleeps and retries; disconnected >2min triggers restart

## Configuration

API keys and integration settings live in `server-config.json` (gitignored). Copy from `server-config.json.example`:

```json
{
  "ambientWeather": { "apiKey": "...", "applicationKey": "..." },
  "beestat": { "apiKey": "..." },
  "sensors": {
    "AA:BB:CC:DD:EE:FF": "Room Name"
  }
}
```

All integrations are optional — omitting `server-config.json` disables them silently. The `sensors` map is required to assign human-readable names to NodeMCU units; unrecognized MACs are stored under their MAC address.
