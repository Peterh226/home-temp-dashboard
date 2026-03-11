const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// In-memory store: { roomName: [{temp, timestamp}] }
const roomData = {};
const MAX_HISTORY = 100; // keep last 100 readings per room

// Ambient Weather API config (loaded from server-config.json if present)
let ambientConfig = null;
try {
  ambientConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'server-config.json'), 'utf8')).ambientWeather;
  if (ambientConfig) console.log('Ambient Weather integration enabled');
} catch (e) {
  // No config file — Ambient Weather polling disabled
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /data  — ESP sends: { "room": "Living Room", "temp": 72.5 }
  if (req.method === 'POST' && req.url === '/data') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { room, temp } = JSON.parse(body);
        if (!room || temp === undefined) throw new Error('Missing fields');
        if (!roomData[room]) roomData[room] = [];
        roomData[room].push({ temp: parseFloat(temp), timestamp: Date.now() });
        if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        console.log(`[${new Date().toLocaleTimeString()}] ${room}: ${temp}°F`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /rooms — returns all room data
  if (req.method === 'GET' && req.url === '/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roomData));
    return;
  }

  // Serve dashboard HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500); res.end('Error loading dashboard');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Demo mode: generate fake data when started with --demo
function startDemo() {
  const rooms = ['Living Room', 'Bedroom', 'Kitchen', 'Garage'];
  const baselines = [72, 70, 74, 62];

  // Seed 20 historical readings per room (spaced 30s apart)
  const now = Date.now();
  rooms.forEach((room, i) => {
    roomData[room] = [];
    for (let j = 19; j >= 0; j--) {
      roomData[room].push({
        temp: parseFloat((baselines[i] + (Math.random() - 0.5) * 4).toFixed(1)),
        timestamp: now - j * 30000
      });
    }
  });
  console.log('Demo mode: seeded data for', rooms.join(', '));

  // Continue generating a reading per room every 30s
  setInterval(() => {
    rooms.forEach((room, i) => {
      const last = roomData[room][roomData[room].length - 1].temp;
      const temp = parseFloat((last + (Math.random() - 0.5) * 2).toFixed(1));
      roomData[room].push({ temp, timestamp: Date.now() });
      if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
      console.log(`[${new Date().toLocaleTimeString()}] ${room}: ${temp}°F (demo)`);
    });
  }, 30000);
}

// Ambient Weather poller
function fetchAmbientWeather() {
  if (!ambientConfig) return;
  const url = `https://rt.ambientweather.net/v1/devices?applicationKey=${ambientConfig.applicationKey}&apiKey=${ambientConfig.apiKey}`;

  https.get(url, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const devices = JSON.parse(body);
        if (!Array.isArray(devices) || devices.length === 0) return;

        const d = devices[0].lastData;
        const now = Date.now();

        // Outdoor temperature
        if (d.tempf !== undefined) {
          const room = 'Outside';
          if (!roomData[room]) roomData[room] = [];
          roomData[room].push({ temp: parseFloat(d.tempf), timestamp: now });
          if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
          console.log(`[${new Date().toLocaleTimeString()}] ${room}: ${d.tempf}°F (ambient)`);
        }

        // Indoor temperature (from base station)
        if (d.tempinf !== undefined) {
          const room = 'Weather Station Indoor';
          if (!roomData[room]) roomData[room] = [];
          roomData[room].push({ temp: parseFloat(d.tempinf), timestamp: now });
          if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
          console.log(`[${new Date().toLocaleTimeString()}] ${room}: ${d.tempinf}°F (ambient)`);
        }
      } catch (e) {
        console.error('Ambient Weather parse error:', e.message);
      }
    });
  }).on('error', (e) => {
    console.error('Ambient Weather fetch error:', e.message);
  });
}

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n  Temperature Dashboard running at http://localhost:${PORT}`);
  console.log(`  ESP32/ESP8266 POST endpoint: http://YOUR_PC_IP:${PORT}/data`);
  console.log(`    Payload format: { "room": "Living Room", "temp": 72.5 }\n`);
  if (process.argv.includes('--demo')) startDemo();

  // Start Ambient Weather polling (every 60s — API rate limit is 1/sec)
  if (ambientConfig) {
    fetchAmbientWeather();
    setInterval(fetchAmbientWeather, 60000);
  }
});
