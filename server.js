const http = require('http');
const fs = require('fs');
const path = require('path');

// In-memory store: { roomName: [{temp, timestamp}] }
const roomData = {};
const MAX_HISTORY = 100; // keep last 100 readings per room

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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🌡️  Temperature Dashboard running at http://localhost:${PORT}`);
  console.log(`📡  ESP32/ESP8266 POST endpoint: http://YOUR_PC_IP:${PORT}/data`);
  console.log(`    Payload format: { "room": "Living Room", "temp": 72.5 }\n`);
});
