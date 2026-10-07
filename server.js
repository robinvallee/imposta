'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Rooms, GameError, MIN_PLAYERS, MAX_PLAYERS, TIMER_OPTIONS } = require('./src/game');
const { TOPICS, PAIRS } = require('./src/questions');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST_GRACE_MS = 20_000;
const HEARTBEAT_MS = 15_000;
const ROOM_IDLE_MS = 30 * 60_000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Addresses other devices on the same network can use, home networks first.
function lanAddresses() {
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    .sort((a, b) => rank(a) - rank(b));
}

function start({ port = 3000, hostGraceMs = HOST_GRACE_MS } = {}) {
  const rooms = new Rooms();
  const sockets = new Map(); // "CODE:playerId" -> socket
  const phaseTimers = new Map(); // room code -> timeout
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

  const seat = (room, playerId) => `${room.code}:${playerId}`;
  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Every player gets their own view, so nobody is ever sent another player's question.
  function broadcast(room) {
    for (const player of room.players) {
      const ws = sockets.get(seat(room, player.id));
      if (ws) send(ws, { t: 'state', state: room.viewFor(player.id) });
    }
  }

  function schedule(room) {
    clearTimeout(phaseTimers.get(room.code));
    phaseTimers.delete(room.code);
    if (!room.endsAt) return;
    const timer = setTimeout(() => {
      if (room.expire()) broadcast(room);
      schedule(room);
    }, Math.max(0, room.endsAt - Date.now()) + 25);
    phaseTimers.set(room.code, timer);
  }

  function changed(room) {
    room.touch();
    schedule(room);
    broadcast(room);
  }

  function attach(ws, room, player) {
    detach(ws);
    const key = seat(room, player.id);
    const previous = sockets.get(key);
    if (previous && previous !== ws) {
      previous.room = null;
      send(previous, { t: 'replaced' });
      previous.close();
    }
    sockets.set(key, ws);
    ws.room = room;
    ws.playerId = player.id;
    player.connected = true;
    send(ws, { t: 'joined', code: room.code, token: player.token, playerId: player.id, name: player.name });
    changed(room);
  }

  // Forget which seat a socket holds. Returns the room it was in.
  function release(ws) {
    const room = ws.room;
    if (!room) return null;
    sockets.delete(seat(room, ws.playerId));
    ws.room = null;
    return room;
  }

  function detach(ws) {
    const { playerId } = ws;
    const room = release(ws);
    if (!room) return;
    room.disconnect(playerId);
    if (playerId === room.hostId) {
      // Give the host time to refresh before handing the room to someone else.
      setTimeout(() => {
        const before = room.hostId;
        room.ensureHost();
        if (room.hostId !== before) broadcast(room);
      }, hostGraceMs).unref();
    }
    broadcast(room);
  }

  function handle(ws, msg) {
    if (msg.t === 'create') {
      const room = rooms.create();
      try {
        attach(ws, room, room.join(msg.name));
      } catch (err) {
        rooms.rooms.delete(room.code);
        throw err;
      }
      return;
    }
    if (msg.t === 'join') {
      const room = rooms.get(msg.code);
      if (!room) throw new GameError('No room with that code. Check it and try again');
      attach(ws, room, room.join(msg.name, msg.token));
      return;
    }

    const room = ws.room;
    if (!room) throw new GameError('Join a room first');
    const me = ws.playerId;

    switch (msg.t) {
      case 'settings':
        room.updateSettings(me, msg);
        break;
      case 'addPair':
        room.addCustomPair(me, msg.real, msg.imposter);
        break;
      case 'removePair':
        room.removeCustomPair(me, msg.id);
        break;
      case 'kick': {
        room.kick(me, msg.id);
        const target = sockets.get(seat(room, msg.id));
        if (target) {
          release(target);
          send(target, { t: 'kicked' });
        }
        break;
      }
      case 'start':
        room.startRound(me);
        break;
      case 'answer':
        room.submitAnswer(me, msg.text);
        break;
      case 'vote':
        room.submitVote(me, msg.target);
        break;
      case 'skip':
        room.advance(me);
        break;
      case 'lobby':
        room.backToLobby(me);
        break;
      case 'leave':
        release(ws);
        room.leave(me);
        send(ws, { t: 'left' });
        break;
      default:
        return;
    }
    changed(room);
  }

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.room = null;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      try {
        handle(ws, msg);
      } catch (err) {
        if (!(err instanceof GameError)) console.error(err);
        send(ws, { t: 'error', message: err instanceof GameError ? err.message : 'Something went wrong' });
      }
    });
    ws.on('close', () => detach(ws));
    ws.on('error', () => {});

    send(ws, {
      t: 'hello',
      topics: TOPICS.map((topic) => ({
        id: topic.id,
        name: topic.name,
        emoji: topic.emoji,
        count: PAIRS.filter((p) => p.topic === topic.id).length,
      })),
      limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
      timers: TIMER_OPTIONS,
      lan: lanAddresses()[0] || null,
    });
  });

  // Phones that go to sleep rarely close their socket cleanly.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const sweeper = setInterval(() => {
    for (const code of rooms.sweep(ROOM_IDLE_MS)) {
      clearTimeout(phaseTimers.get(code));
      phaseTimers.delete(code);
    }
  }, 60_000);
  sweeper.unref();

  function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const timer of phaseTimers.values()) clearTimeout(timer);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => server.close(resolve)));
  }

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ port: server.address().port, rooms, close }));
  });
}

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 3000 }).then(({ port }) => {
    console.log(`\n  Imposta is running.\n`);
    console.log(`  On this computer:   http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  On the same Wi-Fi:  http://${ip}:${port}`);
    console.log('');
  });
}

module.exports = { start };
