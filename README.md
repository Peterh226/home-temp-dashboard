# Home Temperature Dashboard

A lightweight, self-hosted dashboard for monitoring temperatures across multiple rooms using ESP8266 sensors and a Raspberry Pi server.

No cloud. No subscription. Runs entirely on your local network.

---

## Features

- Live temperature readings per room, auto-refreshing every 10 seconds
- Color-coded status: COOL / GOOD / WARM / HOT
- Click any room card to view its temperature history chart
- All-rooms comparison chart with shared timeline
- HVAC status overlay — heat/cool cycles shown as colored bands on charts
- Vent open/closed toggle per room
- Offline indicator on room cards (greys out after 15 min without a reading)
- Ecobee thermostat integration via Beestat API
- Ambient Weather outdoor sensor integration
- Last 24 hours of data restored automatically on server restart
- Permanent reading log written to `data-log.ndjson` (all readings, never trimmed)
- Automatic nightly backup of log to Dropbox via rclone
- No npm installs, no database — pure Node.js

---

## Hardware

- **Server:** Raspberry Pi (any model with WiFi or Ethernet)
- **Sensors:** NodeMCU ESP8266 with DHT22 temperature sensor
- Each NodeMCU uses deep sleep between readings — requires a jumper wire from D0 (GPIO16) to RST
- Sensors report every 5 minutes via HTTP POST
- Room names are assigned server-side by MAC address — all units run identical firmware

---

## How It Works

Each NodeMCU wakes from deep sleep, connects to WiFi, reads the DHT22, POSTs its MAC address and temperature to the server, blinks the LED, then sleeps for 5 minutes. The server looks up the room name from the MAC address in `server-config.json` and stores the reading in memory.

---

## Server Setup

Requires Node.js. No dependencies to install.

Clone the repo, copy `server-config.json.example` to `server-config.json` and fill in your API keys and sensor MAC-to-room mappings, then start the server.

Open `http://<server-ip>:3000` in any browser on your network.

---

## Process Management (pm2)

pm2 keeps the server running and restarts it on system boot.

One-time setup: `sudo npm install -g pm2`, then `pm2 start server.js --name homedash`, then `pm2 startup` (follow the printed command), then `pm2 save`.

Common commands:
- `pm2 restart homedash` — restart after a code update
- `pm2 logs homedash` — view live console output
- `pm2 status` — check if running
- `pm2 stop homedash` — stop the server

After pulling a code update: `git pull && pm2 restart homedash`

---

## Data Logging & Backup

Every temperature reading is appended to `data-log.ndjson` in the project directory. This file grows indefinitely and is never trimmed — it's the permanent record of all readings.

Format: one JSON object per line — `{"room":"Living Room","temp":72.5,"timestamp":1744800000000}`

### Dropbox Backup via rclone

A nightly cron job syncs `data-log.ndjson` to Dropbox automatically.

**One-time setup on the RPi:**
```bash
# Install rclone
curl https://rclone.org/install.sh | sudo bash

# Configure Dropbox remote (follow prompts, leave client ID/secret blank)
rclone config
# Name the remote: PBH_DropBox
# Type: dropbox
# Authorize via browser when prompted

# Test it
rclone copy /home/peterh226/home-temp-dashboard/data-log.ndjson PBH_DropBox:HomeTempDashboard/ -v

# Add cron job (runs at 2 AM daily)
crontab -e
# Add: 0 2 * * * rclone copy /home/peterh226/home-temp-dashboard/data-log.ndjson PBH_DropBox:HomeTempDashboard/ --log-file=/home/peterh226/rclone-homedash.log
```

---

## Configuration

All settings live in `server-config.json` (gitignored — copy from `server-config.json.example`):

- `ambientWeather` — API key and application key for Ambient Weather integration
- `beestat` — API key for Beestat/Ecobee integration
- `sensors` — MAC address to room name mappings for each NodeMCU

---

## Flashing Sensors

Arduino sketch is in `TempSensor/`. Credentials go in `TempSensor/config.h` (gitignored — copy from `config.h.example`).

Flash using `arduino-cli` with FQBN `esp8266:esp8266:nodemcuv2`. The MAC address is printed during upload and on WiFi connect via serial. Add new MACs to `server-config.json` on the server.

---

## API

- `POST /data` — receive a sensor reading (`{ mac, temp }`)
- `GET /rooms` — all room temperature history
- `GET /vents` — vent states
- `POST /vent` — set vent state (`{ room, state: 'open'|'closed' }`)
- `GET /ecobee` — thermostat setpoint and program
- `GET /hvac` — HVAC status log (heat/cool/fan/off with timestamps)

---

## License

MIT
