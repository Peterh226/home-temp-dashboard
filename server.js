const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// In-memory store: { roomName: [{temp, timestamp}] }
const roomData = {};
const MAX_HISTORY = 288; // keep last 24 hours of readings per room (288 = 24h × 12/h)

// Vent state store: { roomName: 'open' | 'closed' }
const ventState = {};

// Persistence
const DATA_FILE = path.join(__dirname, 'data.json');
const LOG_FILE = path.join(__dirname, 'data-log.ndjson');

const HISTORY_WINDOW = 24 * 60 * 60 * 1000; // 24 hours in ms (in-memory cap)
const LOAD_WINDOW   =  7 * 24 * 60 * 60 * 1000; // 7 days — ndjson scan window on startup

// Append a reading to the permanent log file
function logReading(room, temp, timestamp) {
  const line = JSON.stringify({ type: 'temp', room, temp, timestamp }) + '\n';
  fs.appendFile(LOG_FILE, line, (e) => {
    if (e) console.error('Failed to write log:', e.message);
  });
}

function logEvent(obj) {
  const line = JSON.stringify(obj) + '\n';
  fs.appendFile(LOG_FILE, line, e => { if (e) console.error('Log write error:', e.message); });
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ roomData, ventState, hvacLog }));
  } catch (e) {
    console.error('Failed to save data:', e.message);
  }
}

async function loadData() {
  // Restore ventState from data.json (best effort — not in ndjson)
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    Object.assign(ventState, saved.ventState || {});
  } catch (e) {
    // No saved data — vent state starts fresh
  }

  // Rebuild roomData and hvacLog from ndjson — always current, survives power cuts
  if (!fs.existsSync(LOG_FILE)) {
    console.log('No ndjson log found — starting fresh');
    return;
  }

  const stat = fs.statSync(LOG_FILE);
  console.log(`Reading ndjson log (${(stat.size / 1024).toFixed(0)} KB)...`);

  const cutoff = Date.now() - LOAD_WINDOW;
  console.log(`Cutoff: ${new Date(cutoff).toISOString()} (7-day window)`);
  const tempData = {};
  const hvac = [];
  let totalLines = 0, skippedOld = 0, firstTs = null, lastTs = null;

  await new Promise((resolve) => {
    const stream = fs.createReadStream(LOG_FILE);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      totalLines++;
      try {
        const entry = JSON.parse(line);
        if (firstTs === null) firstTs = entry.timestamp;
        lastTs = entry.timestamp;
        if (entry.timestamp < cutoff) { skippedOld++; return; }
        if (entry.type === 'temp') {
          if (!tempData[entry.room]) tempData[entry.room] = [];
          tempData[entry.room].push({ temp: entry.temp, timestamp: entry.timestamp });
        } else if (entry.type === 'hvac') {
          hvac.push({ status: entry.status, timestamp: entry.timestamp });
        }
      } catch (e) { /* skip malformed lines */ }
    });
    rl.on('close', resolve);
    stream.on('error', (err) => {
      console.error('Error reading ndjson log:', err.message);
      resolve();
    });
  });

  for (const room of Object.keys(tempData)) {
    roomData[room] = tempData[room].slice(-MAX_HISTORY);
  }
  hvacLog = hvac;

  console.log(`ndjson scan: ${totalLines} lines, ${skippedOld} skipped (too old)`);
  console.log(`  first ts: ${firstTs} (${firstTs ? new Date(firstTs).toISOString() : 'none'})`);
  console.log(`  last  ts: ${lastTs} (${lastTs ? new Date(lastTs).toISOString() : 'none'})`);
  const roomCount = Object.keys(roomData).length;
  const totalReadings = Object.values(roomData).reduce((s, r) => s + r.length, 0);
  console.log(`Rebuilt from ndjson: ${roomCount} room(s), ${totalReadings} readings, ${hvacLog.length} HVAC entries (last 24h)`);
}

setInterval(saveData, 10 * 60 * 1000); // Save every 10 minutes

// Load config (API keys for integrations)
let ambientConfig = null;
let beestatConfig = null;
let sensorMap = {};  // MAC address -> room name
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'server-config.json'), 'utf8'));
  ambientConfig = config.ambientWeather || null;
  beestatConfig = config.beestat || null;
  sensorMap = config.sensors || {};
  if (ambientConfig) console.log('Ambient Weather integration enabled');
  if (beestatConfig) console.log('Beestat/Ecobee integration enabled');
  if (Object.keys(sensorMap).length) console.log(`Sensor map loaded: ${Object.keys(sensorMap).length} device(s)`);
} catch (e) {
  // No config file — integrations disabled
}

// Ecobee data (separate from room temps — includes setpoint and program)
let ecobeeData = null;

// HVAC status log: [{ status: 'heat'|'cool'|'fan'|'off', timestamp }]
let hvacLog = [];
let lastHvacStatus = null;
let lastSetpointKey = null;

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

  // POST /data  — ESP sends: { "mac": "AA:BB:CC:DD:EE:FF", "temp": 72.5 }
  if (req.method === 'POST' && req.url === '/data') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024) { res.writeHead(413); res.end(); body = null; }
    });
    req.on('end', () => {
      if (body === null) return;
      try {
        const { room, mac, temp } = JSON.parse(body);
        if (temp === undefined) throw new Error('Missing fields');
        const tempNum = parseFloat(temp);
        if (isNaN(tempNum) || tempNum < -40 || tempNum > 200) throw new Error('Invalid temp');
        // Resolve room name: MAC lookup → raw MAC fallback → legacy room field
        const resolvedRoom = (mac && sensorMap[mac.toUpperCase()]) || (mac && sensorMap[mac]) || mac || room;
        if (!resolvedRoom) throw new Error('Missing room or mac');
        if (resolvedRoom.length > 64) throw new Error('Room name too long');
        if (Object.keys(roomData).length >= 50 && !roomData[resolvedRoom]) throw new Error('Too many rooms');
        if (!roomData[resolvedRoom]) roomData[resolvedRoom] = [];
        const ts = Date.now();
        roomData[resolvedRoom].push({ temp: tempNum, timestamp: ts });
        if (roomData[resolvedRoom].length > MAX_HISTORY) roomData[resolvedRoom].shift();
        logReading(resolvedRoom, tempNum, ts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, room: resolvedRoom }));
        console.log(`[${new Date().toLocaleTimeString()}] ${resolvedRoom}: ${tempNum}°F`);
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

  // GET /vents — returns all vent states
  if (req.method === 'GET' && req.url === '/vents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ventState));
    return;
  }

  // POST /vent — set vent state: { room, state: 'open'|'closed' }
  if (req.method === 'POST' && req.url === '/vent') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 256) { res.writeHead(413); res.end(); body = null; }
    });
    req.on('end', () => {
      if (body === null) return;
      try {
        const { room, state } = JSON.parse(body);
        if (!room || !['open', 'closed'].includes(state)) throw new Error('Invalid fields');
        ventState[room] = state;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        console.log(`[${new Date().toLocaleTimeString()}] Vent ${room}: ${state}`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /hvac — returns HVAC status log
  if (req.method === 'GET' && req.url === '/hvac') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(hvacLog));
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

  if (req.method === 'GET' && req.url === '/analysis') {
    const filePath = path.join(__dirname, 'analysis.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading analysis page'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/analysis-data') {
    computeAnalysis().then(data => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
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
          const temp = parseFloat(d.tempf);
          if (!roomData[room]) roomData[room] = [];
          roomData[room].push({ temp, timestamp: now });
          if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
          logReading(room, temp, now);
          console.log(`[${new Date().toLocaleTimeString()}] ${room}: ${d.tempf}°F (ambient)`);
        }

        // Indoor temperature (from base station)
        if (d.tempinf !== undefined) {
          const room = 'Weather Station Indoor';
          const temp = parseFloat(d.tempinf);
          if (!roomData[room]) roomData[room] = [];
          roomData[room].push({ temp, timestamp: now });
          if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
          logReading(room, temp, now);
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
    // Sync first to get fresh data (non-fatal if unavailable)
    await beestatRequest('thermostat', 'sync').catch(e => console.warn('Beestat sync warning:', e.message));
    await beestatRequest('sensor', 'sync').catch(e => {});

    // Small delay to let sync complete
    await new Promise(r => setTimeout(r, 1000));

    const thermostats = await beestatRequest('thermostat', 'read_id');
    const sensors = await beestatRequest('sensor', 'read_id');

    const now = Date.now();

    // Process thermostat data (setpoint, program, equipment status)
    const tId = Object.keys(thermostats)[0];
    if (tId) {
      const t = thermostats[tId];

      // Determine HVAC status from running_equipment (string or array)
      const re = t.running_equipment;
      const equip = (Array.isArray(re) ? re.join(',') : (re || '')).toLowerCase();
      let hvacStatus = 'off';
      if (/heat|aux/.test(equip)) hvacStatus = 'heat';
      else if (/cool|comp/.test(equip)) hvacStatus = 'cool';
      else if (/fan/.test(equip)) hvacStatus = 'fan';

      ecobeeData = {
        name: t.name,
        temperature: t.temperature,
        humidity: t.humidity,
        setpoint_heat: t.setpoint_heat,
        setpoint_cool: t.setpoint_cool,
        program: t.program?.currentClimateRef || null,
        hvac_status: hvacStatus,
        timestamp: now
      };

      // Append to hvac log, trim to 24-hour window
      hvacLog.push({ status: hvacStatus, timestamp: now });
      const cutoff = Date.now() - HISTORY_WINDOW;
      hvacLog = hvacLog.filter(e => e.timestamp >= cutoff);

      // Log HVAC transitions and setpoint changes to permanent log
      if (hvacStatus !== lastHvacStatus) {
        logEvent({ type: 'hvac', status: hvacStatus, timestamp: now });
        lastHvacStatus = hvacStatus;
      }
      const spKey = `${t.setpoint_heat}:${t.setpoint_cool}:${ecobeeData.program}`;
      if (spKey !== lastSetpointKey) {
        logEvent({ type: 'setpoint', heat: t.setpoint_heat, cool: t.setpoint_cool, program: ecobeeData.program, timestamp: now });
        lastSetpointKey = spKey;
      }

      console.log(`[${new Date().toLocaleTimeString()}] Ecobee: ${t.temperature}°F, heat:${t.setpoint_heat} cool:${t.setpoint_cool}, program:${ecobeeData.program}, hvac:${hvacStatus} [${t.running_equipment || 'none'}]`);
    }

    // Process sensor data — add each as a room
    for (const sId of Object.keys(sensors)) {
      const s = sensors[sId];
      if (s.temperature === null) continue;
      const room = `Ecobee: ${s.name}`;
      const temp = parseFloat(s.temperature);
      if (!roomData[room]) roomData[room] = [];
      roomData[room].push({ temp, timestamp: now });
      if (roomData[room].length > MAX_HISTORY) roomData[room].shift();
      logReading(room, temp, now);
      console.log(`[${new Date().toLocaleTimeString()}] ${room}: ${s.temperature}°F (beestat)`);
    }
  } catch (e) {
    console.error('Beestat fetch error:', e.message);
  }
}

// Analysis computation (cached 10 min, covers last 90 days of temp readings)
let analysisCache = null;
let analysisCacheTime = 0;
const ANALYSIS_CACHE_MS = 10 * 60 * 1000;
const ANALYSIS_DAYS = 90;

function getAnalysisWindow(ts) {
  const h = new Date(ts).getHours();
  if (h >= 23 || h < 8) return 'sleep';
  if (h >= 18) return 'evening';
  return 'day';
}

async function computeAnalysis() {
  if (analysisCache && Date.now() - analysisCacheTime < ANALYSIS_CACHE_MS) return analysisCache;

  const tsCutoff = Date.now() - ANALYSIS_DAYS * 24 * 60 * 60 * 1000;
  const tempRecords = [];
  const hvacRecords = [];
  const setpointRecords = [];
  let firstTs = Infinity, lastTs = 0;

  try {
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(LOG_FILE);
      stream.on('error', reject);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', line => {
        if (!line.trim()) return;
        try {
          const obj = JSON.parse(line);
          const type = obj.type || 'temp';
          if (!obj.timestamp) return;
          if (obj.timestamp < firstTs) firstTs = obj.timestamp;
          if (obj.timestamp > lastTs) lastTs = obj.timestamp;
          if (type === 'temp' && obj.timestamp >= tsCutoff && obj.room && obj.temp !== undefined) {
            tempRecords.push(obj);
          } else if (type === 'hvac' && obj.status) {
            hvacRecords.push(obj);
          } else if (type === 'setpoint' && obj.heat !== undefined) {
            setpointRecords.push(obj);
          }
        } catch {}
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Analysis read error:', e.message);
    return (analysisCache = { noData: true, totalReadings: 0, days: 0, rooms: [], roomAnalysis: {}, avgResponseTime: {}, hvacSessionCount: 0, hasSetpointData: false, hasHvacData: false });
  }

  setpointRecords.sort((a, b) => a.timestamp - b.timestamp);
  hvacRecords.sort((a, b) => a.timestamp - b.timestamp);
  tempRecords.sort((a, b) => a.timestamp - b.timestamp);

  function getActiveSetpoint(ts) {
    let sp = null;
    for (const s of setpointRecords) {
      if (s.timestamp <= ts) sp = s;
      else break;
    }
    return sp;
  }

  // Accumulate per-room per-window stats
  const acc = {};
  for (const r of tempRecords) {
    if (!acc[r.room]) {
      acc[r.room] = {
        sleep:   { sumT: 0, sumDHeat: 0, sumDCool: 0, n: 0, nd: 0, min: Infinity, max: -Infinity },
        evening: { sumT: 0, sumDHeat: 0, sumDCool: 0, n: 0, nd: 0, min: Infinity, max: -Infinity },
        day:     { sumT: 0, sumDHeat: 0, sumDCool: 0, n: 0, nd: 0, min: Infinity, max: -Infinity },
      };
    }
    const w = acc[r.room][getAnalysisWindow(r.timestamp)];
    w.sumT += r.temp; w.n++;
    if (r.temp < w.min) w.min = r.temp;
    if (r.temp > w.max) w.max = r.temp;
    const sp = getActiveSetpoint(r.timestamp);
    if (sp) { w.sumDHeat += r.temp - sp.heat; w.sumDCool += r.temp - sp.cool; w.nd++; }
  }

  const roomAnalysis = {};
  for (const [room, windows] of Object.entries(acc)) {
    roomAnalysis[room] = {};
    for (const [wName, w] of Object.entries(windows)) {
      if (w.n === 0) continue;
      roomAnalysis[room][wName] = {
        avgTemp: parseFloat((w.sumT / w.n).toFixed(1)),
        avgDelta: w.nd > 0 ? parseFloat((w.sumDHeat / w.nd).toFixed(1)) : null,
        avgCoolDelta: w.nd > 0 ? parseFloat((w.sumDCool / w.nd).toFixed(1)) : null,
        count: w.n,
        minTemp: parseFloat(w.min.toFixed(1)),
        maxTemp: parseFloat(w.max.toFixed(1)),
      };
    }
  }

  // HVAC response: find on-transitions, compute per-room time-to-setpoint
  function findTempIdx(ts) {
    let lo = 0, hi = tempRecords.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tempRecords[m].timestamp < ts) lo = m + 1; else hi = m; }
    return lo;
  }

  const sessions = [];
  for (let i = 1; i < hvacRecords.length; i++) {
    const prev = hvacRecords[i - 1], curr = hvacRecords[i];
    if ((prev.status === 'off' || prev.status === 'fan') && (curr.status === 'heat' || curr.status === 'cool')) {
      const sp = getActiveSetpoint(curr.timestamp);
      if (!sp) continue;
      const target = curr.status === 'heat' ? sp.heat : sp.cool;
      const end = curr.timestamp + 2 * 60 * 60 * 1000;
      const roomResponse = {};
      const startIdx = findTempIdx(curr.timestamp);
      for (let j = startIdx; j < tempRecords.length && tempRecords[j].timestamp <= end; j++) {
        const r = tempRecords[j];
        if (roomResponse[r.room] !== undefined) continue;
        const reached = curr.status === 'heat' ? r.temp >= target - 0.5 : r.temp <= target + 0.5;
        if (reached) roomResponse[r.room] = Math.round((r.timestamp - curr.timestamp) / 60000);
      }
      sessions.push({ mode: curr.status, roomResponse });
    }
  }

  const rtAcc = {};
  for (const s of sessions) {
    for (const [room, mins] of Object.entries(s.roomResponse)) {
      if (!rtAcc[room]) rtAcc[room] = { sum: 0, n: 0 };
      rtAcc[room].sum += mins; rtAcc[room].n++;
    }
  }
  const avgResponseTime = {};
  for (const room of Object.keys(rtAcc)) {
    avgResponseTime[room] = Math.round(rtAcc[room].sum / rtAcc[room].n);
  }

  const days = firstTs === Infinity ? 0 : Math.max(1, Math.round((lastTs - firstTs) / (24 * 60 * 60 * 1000)));

  analysisCache = {
    days, totalReadings: tempRecords.length,
    firstTs: firstTs === Infinity ? null : firstTs,
    lastTs: lastTs === 0 ? null : lastTs,
    hasSetpointData: setpointRecords.length > 0,
    hasHvacData: hvacRecords.length > 0,
    rooms: Object.keys(roomAnalysis).sort(),
    roomAnalysis, avgResponseTime,
    hvacSessionCount: sessions.length,
  };
  analysisCacheTime = Date.now();
  console.log(`[${new Date().toLocaleTimeString()}] Analysis: ${tempRecords.length} readings, ${days}d, ${sessions.length} HVAC sessions`);
  return analysisCache;
}

const PORT = 3000;
loadData().catch(err => {
  console.error('loadData failed, starting with empty history:', err.message);
}).then(() => server.listen(PORT, () => {
  console.log(`\n  Temperature Dashboard running at http://localhost:${PORT}`);
  console.log(`  ESP32/ESP8266 POST endpoint: http://YOUR_PC_IP:${PORT}/data`);
  console.log(`    Payload format: { "room": "Living Room", "temp": 72.5 }\n`);
  if (process.argv.includes('--demo')) startDemo();

  // Start Ambient Weather polling (every 5 min)
  if (ambientConfig) {
    fetchAmbientWeather();
    setInterval(fetchAmbientWeather, 300000);
  }

  // Start Beestat/Ecobee polling (every 5 min)
  if (beestatConfig) {
    fetchBeestat();
    setInterval(fetchBeestat, 300000);
  }
}));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use.`);
    console.error(`  Another process (possibly a stale pm2 entry) is holding the port.`);
    console.error(`  Fix: run "sudo pm2 list" -- if homedash appears there, run:`);
    console.error(`       sudo pm2 delete homedash && sudo pm2 save`);
    console.error(`  Then restart the user-level process: pm2 restart homedash\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${signal} received — saving data and shutting down...`);
  saveData();
  server.close(() => {
    console.log('Server closed cleanly.');
    process.exit(0);
  });
  // Force exit if server.close stalls (e.g. open keep-alive connections)
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
