const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// In-memory store: { roomName: [{temp, timestamp}] }
const roomData = {};
const MAX_HISTORY = 100; // keep last 100 readings per room

// Load config (API keys for integrations)
let ambientConfig = null;
let beestatConfig = null;
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'server-config.json'), 'utf8'));
  ambientConfig = config.ambientWeather || null;
  beestatConfig = config.beestat || null;
  if (ambientConfig) console.log('Ambient Weather integration enabled');
  if (beestatConfig) console.log('Beestat/Ecobee integration enabled');
} catch (e) {
  // No config file — integrations disabled
}

// Ecobee data (separate from room temps — includes setpoint and program)
let ecobeeData = null;

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

  // GET /ecobee — returns thermostat setpoint, program, and sensor data
  if (req.method === 'GET' && req.url === '/ecobee') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ecobeeData || {}));
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

// Beestat/Ecobee poller
function beestatRequest(resource, method) {
  return new Promise((resolve, reject) => {
    const url = `https://api.beestat.io/?api_key=${beestatConfig.apiKey}&resource=${resource}&method=${method}&arguments=%7B%7D`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.success) resolve(json.data);
          else reject(new Error(json.data?.error_message || 'Beestat API error'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchBeestat() {
  if (!beestatConfig) return;
  try {
    // Sync first to get fresh data
    await beestatRequest('thermostat', 'sync');
    await beestatRequest('sensor', 'sync');

    // Small delay to let sync complete
    await new Promise(r => setTimeout(r, 1000));

    const thermostats = await beestatRequest('thermostat', 'read_id');
    const sensors = await beestatRequest('sensor', 'read_id');

    const now = Date.now();

    // Process thermostat data (setpoint, program)
    const tId = Object.keys(thermostats)[0];
    if (tId) {
      const t = thermostats[tId];
      ecobeeData = {
        name: t.name,
        temperature: t.temperature,
        humidity: t.humidity,
        setpoint_heat: t.setpoint_heat,
        setpoint_cool: t.setpoint_cool,
        program: t.program?.currentClimateRef || null,
        timestamp: now
      };
      console.log(`[${new Date().toLocaleTimeString()}] Ecobee: ${t.temperature}°F, setpoint heat:${t.setpoint_heat} cool:${t.setpoint_cool}, program:${ecobeeData.program}`);
    }

    // Process sensor data — add each as a room
    for (const sId of Object.keys(sensors)) {
      const s = sensors[sId];
      if (s.temperature === null) continue;
      const room = `Ecobee: ${s.name}`;
      if (!roomData[room]) roomData[room] = [];
      roomData[room].push({ temp: parseFloat(s.temperature), timestamp: now });
      if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
      console.log(`[${new Date().toLocaleTimeString()}] ${room}: ${s.temperature}°F (beestat)`);
    }
  } catch (e) {
    console.error('Beestat fetch error:', e.message);
  }
}

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n  Temperature Dashboard running at http://localhost:${PORT}`);
  console.log(`  ESP32/ESP8266 POST endpoint: http://YOUR_PC_IP:${PORT}/data`);
  console.log(`    Payload format: { "room": "Living Room", "temp": 72.5 }\n`);
  if (process.argv.includes('--demo')) startDemo();

  // Start Ambient Weather polling (every 60s)
  if (ambientConfig) {
    fetchAmbientWeather();
    setInterval(fetchAmbientWeather, 60000);
  }

  // Start Beestat/Ecobee polling (every 3 min — ecobee data updates every 3 min)
  if (beestatConfig) {
    fetchBeestat();
    setInterval(fetchBeestat, 180000);
  }
});
