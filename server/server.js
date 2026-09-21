'use strict';

/**
 * Wireless Mic - HTTPS static server + WebSocket signaling.
 * Works fully offline: nothing here talks to the internet.
 *
 *   npm start
 *   PORT=8443 CERT_DIR=/path/to/certs npm start
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Relay } = require('./relay');

const PORT = Number(process.env.PORT) || 8443;
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ---------------------------------------------------------------- certificates
// mkcert names files after the hostnames you pass it (e.g. "192.168.1.10+3.pem"
// and "192.168.1.10+3-key.pem"), so we detect the pair instead of hard-coding it.
function loadCertificates() {
  let files = [];
  try {
    files = fs.readdirSync(CERT_DIR);
  } catch {
    /* handled below */
  }
  const keyFile = files.find((f) => f.endsWith('-key.pem') && !f.startsWith('rootCA'));
  const certFile = keyFile && files.find((f) => f === keyFile.replace('-key.pem', '.pem'));

  if (!keyFile || !certFile) {
    console.error(`
No HTTPS certificate found in: ${CERT_DIR}

Create one with mkcert (use your laptop's real LAN IP):

    mkcert -install
    cd certs
    mkcert 192.168.1.10 localhost 127.0.0.1 ::1

Then run "npm start" again. See README.md for details.
`);
    process.exit(1);
  }

  console.log(`Using certificate: ${certFile}`);
  return {
    key: fs.readFileSync(path.join(CERT_DIR, keyFile)),
    cert: fs.readFileSync(path.join(CERT_DIR, certFile)),
  };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map((i) => i.address);
}

// --------------------------------------------------------------------- express
const app = express();
app.disable('x-powered-by');
app.use(express.static(FRONTEND_DIR, { etag: false, maxAge: 0 }));

// API to provide host network info for local QR code join generation
app.get('/api/info', (req, res) => {
  res.json({
    port: PORT,
    ips: lanAddresses(),
  });
});

// Join route alias for easy mobile QR scanning
app.get('/join', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Optional: lets a phone download the mkcert root CA to install it once and
// stop seeing "Your connection is not private". Copy rootCA.pem into certs/.
app.get('/rootCA.pem', (req, res) => {
  const file = path.join(CERT_DIR, 'rootCA.pem');
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.type('application/x-x509-ca-cert').sendFile(file);
});

const server = https.createServer(loadCertificates(), app);

// ------------------------------------------------------------------- signaling
const relay = new Relay((line) => console.log(`[signaling] ${line}`));
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data) => relay.handle(ws, data));
  ws.on('close', () => relay.leave(ws));
  ws.on('error', (err) => console.error('[signaling] socket error:', err.message));
});

// Drop half-open sockets (phone walked out of Wi-Fi range, screen locked, ...).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

// ----------------------------------------------------------------------- start
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT=<number>.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('\nWireless Mic is running (offline, LAN only)\n');
  console.log(`  Receiver (open on this laptop):  https://localhost:${PORT}/receiver.html`);
  (ips.length ? ips : ['<laptop-ip>']).forEach((ip) => {
    console.log(`  Transmitter (open on the phone): https://${ip}:${PORT}/`);
  });
  console.log(`  Signaling:                       wss://<laptop-ip>:${PORT}/ws\n`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.clients.forEach((c) => c.terminate());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
