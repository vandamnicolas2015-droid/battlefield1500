const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const SESSION_COOKIE = 'battlefield1500_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 5 })
  : null;
const authAttempts = new Map();
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/javascript.js': ['javascript.js', 'text/javascript; charset=utf-8'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8']
};

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      if (tooLarge) return;
      if (body.length + chunk.length > 4096) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(Object.assign(new Error('Send a valid JSON request.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || '';
  for (const cookie of cookies.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
  }
  return '';
}

function sessionCookie(token, request) {
  const secure = request.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_MS / 1000}${secure ? '; Secure' : ''}`;
}

function validateRequestOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch (error) {
    return false;
  }
}

function checkAuthRateLimit(request) {
  const now = Date.now();
  const forwardedFor = request.headers['x-forwarded-for'];
  const key = (typeof forwardedFor === 'string' && forwardedFor.split(',')[0].trim()) ||
    request.socket.remoteAddress || 'unknown';
  const current = authAttempts.get(key);
  if (!current || now - current.startedAt >= 15 * 60 * 1000) {
    authAttempts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count++;
  if (authAttempts.size > 10000) {
    for (const [address, attempt] of authAttempts) {
      if (now - attempt.startedAt >= 15 * 60 * 1000) authAttempts.delete(address);
    }
  }
  return current.count <= 10;
}

async function findSessionUser(token) {
  if (!pool || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const result = await pool.query(
    `SELECT users.id, users.username, users.wins
     FROM game_sessions AS sessions
     JOIN game_users AS users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  await pool.query(
    'INSERT INTO game_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\')',
    [tokenHash, userId]
  );
  return token;
}

async function handleAuthRequest(request, response, pathname) {
  if (!pool) {
    sendJson(response, 503, { error: 'Accounts are not available yet. The game database has not been configured.' });
    return;
  }
  if (pathname === '/api/me' && request.method === 'GET') {
    const user = await findSessionUser(getCookie(request, SESSION_COOKIE));
    sendJson(response, 200, user
      ? { authenticated: true, user: { username: user.username, wins: user.wins } }
      : { authenticated: false });
    return;
  }
  if (pathname === '/api/leaderboard' && request.method === 'GET') {
    const result = await pool.query(
      'SELECT username, wins FROM game_users ORDER BY wins DESC, username_norm ASC LIMIT 10'
    );
    sendJson(response, 200, { players: result.rows });
    return;
  }
  if (pathname === '/api/logout' && request.method === 'POST') {
    if (!validateRequestOrigin(request)) {
      sendJson(response, 403, { error: 'Request origin was not accepted.' });
      return;
    }
    const token = getCookie(request, SESSION_COOKIE);
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest();
      await pool.query('DELETE FROM game_sessions WHERE token_hash = $1', [tokenHash]);
    }
    sendJson(response, 200, { authenticated: false }, {
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
    });
    return;
  }
  if ((pathname !== '/api/register' && pathname !== '/api/login') || request.method !== 'POST') {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  if (!validateRequestOrigin(request)) {
    sendJson(response, 403, { error: 'Request origin was not accepted.' });
    return;
  }
  if (!checkAuthRateLimit(request)) {
    sendJson(response, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    return;
  }

  const body = await readJsonBody(request);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const usernameNorm = username.toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[A-Za-z0-9_]{3,18}$/.test(username)) {
    sendJson(response, 400, { error: 'Choose a username of 3–18 letters, numbers, or underscores.' });
    return;
  }
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 128) {
    sendJson(response, 400, { error: 'Password must be at least 8 characters and no more than 128 bytes.' });
    return;
  }

  let user;
  if (pathname === '/api/register') {
    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      const result = await pool.query(
        `INSERT INTO game_users (username, username_norm, password_salt, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, wins`,
        [username, usernameNorm, salt, passwordHash]
      );
      user = result.rows[0];
    } catch (error) {
      if (error.code === '23505') {
        sendJson(response, 409, { error: 'That username is already taken.' });
        return;
      }
      throw error;
    }
  } else {
    const result = await pool.query(
      'SELECT id, username, wins, password_salt, password_hash FROM game_users WHERE username_norm = $1',
      [usernameNorm]
    );
    user = result.rows[0];
    if (!user) {
      sendJson(response, 401, { error: 'Username or password is incorrect.' });
      return;
    }
    const passwordHash = await scrypt(password, user.password_salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (!crypto.timingSafeEqual(passwordHash, user.password_hash)) {
      sendJson(response, 401, { error: 'Username or password is incorrect.' });
      return;
    }
  }

  const token = await createSession(user.id);
  sendJson(response, 200, {
    authenticated: true,
    user: { username: user.username, wins: user.wins }
  }, { 'Set-Cookie': sessionCookie(token, request) });
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      username_norm TEXT NOT NULL UNIQUE,
      password_salt BYTEA NOT NULL,
      password_hash BYTEA NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_sessions (
      token_hash BYTEA PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS game_sessions_expiry_idx ON game_sessions (expires_at)');
  await pool.query('DELETE FROM game_sessions WHERE expires_at <= NOW()');
}

const mapDefinitions = {
  frontier: {
    name: 'Frontier Field',
    spawns: [{ x: 120, y: 270 }, { x: 840, y: 130 }, { x: 840, y: 410 }, { x: 720, y: 270 }],
    walls: [
      { x: 250, y: 130, w: 150, h: 28 },
      { x: 560, y: 382, w: 150, h: 28 },
      { x: 405, y: 240, w: 150, h: 28 },
      { x: 465, y: 240, w: 28, h: 150 }
    ]
  },
  village: {
    name: 'Greenwood Village',
    spawns: [{ x: 100, y: 270 }, { x: 860, y: 270 }, { x: 450, y: 285 }, { x: 510, y: 285 }],
    walls: [
      { x: 68, y: 72, w: 132, h: 112 },
      { x: 396, y: 64, w: 145, h: 122 },
      { x: 750, y: 74, w: 140, h: 112 },
      { x: 178, y: 356, w: 138, h: 112 },
      { x: 632, y: 352, w: 148, h: 118 }
    ]
  },
  ruins: {
    name: 'Old Keep Ruins',
    spawns: [{ x: 150, y: 270 }, { x: 810, y: 270 }, { x: 450, y: 70 }, { x: 450, y: 490 }],
    walls: [
      { x: 100, y: 100, w: 170, h: 26 },
      { x: 345, y: 115, w: 26, h: 135 },
      { x: 465, y: 140, w: 180, h: 26 },
      { x: 730, y: 95, w: 26, h: 165 },
      { x: 120, y: 335, w: 26, h: 140 },
      { x: 290, y: 370, w: 175, h: 26 },
      { x: 550, y: 315, w: 26, h: 150 },
      { x: 700, y: 370, w: 170, h: 26 },
      { x: 450, y: 255, w: 60, h: 28 }
    ]
  },
  lobby: {
    name: 'Meeting Green',
    spawns: [{ x: 480, y: 270 }],
    walls: [
      { x: 160, y: 100, w: 140, h: 22 },
      { x: 660, y: 100, w: 140, h: 22 },
      { x: 160, y: 418, w: 140, h: 22 },
      { x: 660, y: 418, w: 140, h: 22 }
    ]
  }
};
const rooms = new Map();
let nextPlayerId = 1;
const publicLobby = {
  code: 'PUBLIC',
  public: true,
  mapId: 'lobby',
  status: 'lobby',
  clients: [],
  chat: [],
  bullets: [],
  blueScore: 0,
  redScore: 0,
  timeLeft: 0
};
rooms.set(publicLobby.code, publicLobby);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    handleAuthRequest(request, response, pathname).catch(error => {
      console.error('Account API request failed:', error.message);
      if (!response.headersSent) sendJson(response, error.status || 500, {
        error: error.status ? error.message : 'The account request could not be completed. Try again later.'
      });
      else response.destroy(error);
    });
    return;
  }
  const file = FILES[pathname];
  if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  fs.readFile(path.join(ROOT, file[0]), (error, contents) => {
    if (error) {
      response.writeHead(500);
      response.end('Unable to load game files');
      return;
    }
    response.writeHead(200, {
      'Content-Type': file[1],
      'Cache-Control': 'no-cache'
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  });
});

const webSockets = new WebSocketServer({ server, maxPayload: 4096 });

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room, message) {
  for (const player of room.clients) send(player.socket, message);
}

function lobbyState(room) {
  return {
    type: 'lobby',
    room: room.code,
    status: room.status,
    mapId: room.mapId,
    mapName: mapDefinitions[room.mapId].name,
    players: room.clients.map(player => ({ id: player.id, name: player.name, slot: player.slot }))
  };
}

function broadcastLobby(room) {
  broadcast(room, lobbyState(room));
}

function makeRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (code.length !== 5 || rooms.has(code));
  return code;
}

function addPlayer(room, socket, name) {
  const spawn = room.public ? findLobbySpawn(room) : spawnFor(room.mapId, room.clients.length);
  const player = {
    id: String(nextPlayerId++),
    name,
    accountId: socket.account ? socket.account.id : null,
    slot: room.public ? room.clients.length % 2 : room.clients.length,
    socket,
    x: spawn.x,
    y: spawn.y,
    angle: room.clients.length === 0 ? 0 : Math.PI,
    input: { x: 0, y: 0, angle: 0, shoot: false },
    cooldown: 0,
    alive: true,
    respawnAt: 0,
    lastChatAt: 0
  };
  room.clients.push(player);
  socket.room = room;
  socket.player = player;
  return player;
}

function resetMatch(room) {
  room.status = 'playing';
  room.timeLeft = 60;
  room.blueScore = 0;
  room.redScore = 0;
  room.bullets = [];
  room.clients.forEach((player, index) => {
    player.slot = index;
    const spawn = spawnFor(room.mapId, index);
    player.x = spawn.x;
    player.y = spawn.y;
    player.angle = index === 0 ? 0 : Math.PI;
    player.input = { x: 0, y: 0, angle: player.angle, shoot: false };
    player.cooldown = 0;
    player.alive = true;
    player.respawnAt = 0;
  });
  broadcast(room, { type: 'gameStart', mapId: room.mapId });
  broadcastLobby(room);
}

function addChat(room, player, text) {
  const message = {
    type: 'chat',
    name: player.name,
    text: text.slice(0, 160),
    time: Date.now()
  };
  room.chat.push(message);
  if (room.chat.length > 50) room.chat.shift();
  broadcast(room, message);
}

function publicSnapshot(room) {
  return {
    type: 'publicSnapshot',
    mapId: room.mapId,
    count: room.clients.length,
    players: room.clients.map(player => ({
      id: player.id,
      name: player.name,
      slot: player.slot,
      x: player.x,
      y: player.y,
      angle: player.angle,
      alive: true
    }))
  };
}

function leaveRoom(socket) {
  const room = socket.room;
  if (!room) return;
  const player = socket.player;
  room.clients = room.clients.filter(member => member !== player);
  socket.room = null;
  socket.player = null;
  room.bullets = [];
  if (!room.public) room.status = 'waiting';
  if (room.clients.length === 0) {
    if (!room.public) rooms.delete(room.code);
    return;
  }
  room.clients.forEach((member, index) => {
    member.slot = room.public ? index % 2 : index;
  });
  broadcast(room, { type: 'notice', text: `${player.name} left the room.` });
  broadcastLobby(room);
  if (room.public) broadcast(room, publicSnapshot(room));
}

function reject(socket, text) {
  send(socket, { type: 'error', text });
}

function handleMessage(socket, message) {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'publicJoin') {
    if (socket.room) {
      reject(socket, 'Leave your current room first.');
      return;
    }
    const guestName = typeof message.name === 'string'
      ? message.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18)
      : '';
    const name = socket.account ? socket.account.username : guestName;
    if (!name) {
      reject(socket, 'Enter a player name first.');
      return;
    }
    if (publicLobby.clients.length >= 64) {
      reject(socket, 'The public lobby is full right now. Try again later.');
      return;
    }
    const player = addPlayer(publicLobby, socket, name);
    send(socket, { type: 'publicJoined', room: publicLobby.code, playerId: player.id, chat: publicLobby.chat });
    addChat(publicLobby, player, `${player.name} joined the public lobby.`);
    broadcastLobby(publicLobby);
    broadcast(publicLobby, publicSnapshot(publicLobby));
    return;
  }

  if (message.type === 'create' || message.type === 'join') {
    if (socket.room) {
      reject(socket, 'Leave your current room first.');
      return;
    }
    if (!socket.account) {
      reject(socket, 'Sign in to an account before joining a ranked private battle.');
      return;
    }
    const name = socket.account.username;

    let room;
    if (message.type === 'create') {
      const code = makeRoomCode();
      room = {
        code,
        mapId: mapDefinitions[message.mapId] && message.mapId !== 'lobby' ? message.mapId : 'frontier',
        status: 'waiting',
        clients: [],
        chat: [],
        bullets: [],
        blueScore: 0,
        redScore: 0,
        timeLeft: 60
      };
      rooms.set(code, room);
    } else {
      const code = typeof message.room === 'string' ? message.room.trim().toUpperCase() : '';
      room = rooms.get(code);
      if (!room) {
        reject(socket, 'Room not found. Check the code and try again.');
        return;
      }
      if (room.public) {
        reject(socket, 'Use the public lobby option to enter the open field.');
        return;
      }
      if (room.clients.length >= 2 || room.status === 'playing') {
        reject(socket, 'That room is already full.');
        return;
      }
    }

    const player = addPlayer(room, socket, name);
    send(socket, { type: 'joined', room: room.code, mapId: room.mapId, playerId: player.id, chat: room.chat });
    broadcastLobby(room);
    if (room.clients.length === 2) resetMatch(room);
    return;
  }

  if (!socket.room || !socket.player) {
    reject(socket, 'Join a room first.');
    return;
  }

  if (message.type === 'chat') {
    const text = typeof message.text === 'string'
      ? message.text.replace(/[\u0000-\u001f\u007f]/g, '').trim()
      : '';
    if (text && Date.now() - socket.player.lastChatAt >= 700) {
      socket.player.lastChatAt = Date.now();
      addChat(socket.room, socket.player, text);
    }
  } else if (message.type === 'input' && (socket.room.status === 'playing' || socket.room.public)) {
    const input = message.input || {};
    const x = Number(input.x);
    const y = Number(input.y);
    const angle = Number(input.angle);
    socket.player.input = {
      x: Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0,
      y: Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0,
      angle: Number.isFinite(angle) ? angle : socket.player.angle,
      shoot: !socket.room.public && input.shoot === true
    };
  } else if (message.type === 'rematch' && socket.room.clients.length === 2) {
    resetMatch(socket.room);
  } else if (message.type === 'leave') {
    leaveRoom(socket);
  }
}

webSockets.on('connection', (socket, request) => {
  const authenticated = findSessionUser(getCookie(request, SESSION_COOKIE))
    .then(user => { socket.account = user; })
    .catch(error => {
      console.error('Could not verify the WebSocket account session:', error.message);
      socket.close(1011, 'Account session verification failed.');
    });
  socket.on('message', data => {
    authenticated.then(() => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        reject(socket, 'Could not read that message.');
        return;
      }
      handleMessage(socket, message);
    }).catch(error => console.error('Could not handle WebSocket message:', error.message));
  });
  socket.on('close', () => leaveRoom(socket));
  socket.on('error', error => console.error('WebSocket error:', error.message));
});

function collidesCircleRect(circle, rect) {
  const x = Math.max(rect.x, Math.min(circle.x, rect.x + rect.w));
  const y = Math.max(rect.y, Math.min(circle.y, rect.y + rect.h));
  const dx = circle.x - x;
  const dy = circle.y - y;
  return dx * dx + dy * dy < circle.r * circle.r;
}

function spawnFor(mapId, index) {
  const spawns = mapDefinitions[mapId].spawns;
  return spawns[index % spawns.length];
}

function movePlayer(player, dt, walls) {
  const input = player.input;
  const length = Math.hypot(input.x, input.y);
  const dx = length > 0 ? input.x / length : 0;
  const dy = length > 0 ? input.y / length : 0;
  const speed = 190;
  const nextX = player.x + dx * speed * dt;
  const nextY = player.y + dy * speed * dt;
  if (nextX > 17 && nextX < 943 && !walls.some(wall => collidesCircleRect({ x: nextX, y: player.y, r: 17 }, wall))) {
    player.x = nextX;
  }
  if (nextY > 17 && nextY < 523 && !walls.some(wall => collidesCircleRect({ x: player.x, y: nextY, r: 17 }, wall))) {
    player.y = nextY;
  }
  player.angle = input.angle;
}

function findLobbySpawn(room) {
  const lobbyWalls = mapDefinitions.lobby.walls;
  const candidates = [];
  for (let y = 55; y <= 485; y += 45) {
    for (let x = 55; x <= 905; x += 45) {
      const candidate = { x, y, r: 17 };
      if (lobbyWalls.some(wall => collidesCircleRect(candidate, wall))) continue;
      if (room.clients.some(player => Math.hypot(player.x - x, player.y - y) < 38)) continue;
      candidates.push(candidate);
    }
  }
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : { x: 55, y: 55 };
}

function snapshot(room) {
  return {
    type: 'snapshot',
    mapId: room.mapId,
    timeLeft: room.timeLeft,
    blueScore: room.blueScore,
    redScore: room.redScore,
    players: room.clients.map(player => ({
      id: player.id,
      name: player.name,
      slot: player.slot,
      x: player.x,
      y: player.y,
      angle: player.angle,
      alive: player.alive
    })),
    bullets: room.bullets.map(bullet => ({
      ownerId: bullet.ownerId,
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy
    }))
  };
}

setInterval(() => {
  const dt = 0.05;
  for (const room of rooms.values()) {
    if (room.public) {
      for (const player of room.clients) movePlayer(player, dt, mapDefinitions.lobby.walls);
      broadcast(room, publicSnapshot(room));
      continue;
    }
    if (room.status !== 'playing') continue;
    room.timeLeft = Math.max(0, room.timeLeft - dt);

    for (const player of room.clients) {
      if (!player.alive) {
        if (Date.now() >= player.respawnAt) {
          player.alive = true;
          const spawn = spawnFor(room.mapId, player.slot);
          player.x = spawn.x;
          player.y = spawn.y;
        }
        continue;
      }
      movePlayer(player, dt, mapDefinitions[room.mapId].walls);
      player.cooldown = Math.max(0, player.cooldown - dt);
      if (player.input.shoot && player.cooldown === 0) {
        const angle = player.angle;
        room.bullets.push({
          ownerId: player.id,
          x: player.x + Math.cos(angle) * 22,
          y: player.y + Math.sin(angle) * 22,
          vx: Math.cos(angle) * 430,
          vy: Math.sin(angle) * 430,
          life: 1.5
        });
        player.cooldown = 0.62;
      }
    }

    for (let i = room.bullets.length - 1; i >= 0; i--) {
      const bullet = room.bullets[i];
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      bullet.life -= dt;
      if (bullet.life <= 0 || bullet.x < 0 || bullet.x > 960 || bullet.y < 0 || bullet.y > 540 ||
          mapDefinitions[room.mapId].walls.some(wall => collidesCircleRect({ x: bullet.x, y: bullet.y, r: 3 }, wall))) {
        room.bullets.splice(i, 1);
        continue;
      }
      const hit = room.clients.find(player => player.id !== bullet.ownerId && player.alive &&
        Math.hypot(player.x - bullet.x, player.y - bullet.y) < 20);
      if (hit) {
        const shooter = room.clients.find(player => player.id === bullet.ownerId);
        if (shooter && shooter.slot === 0) room.blueScore++;
        else room.redScore++;
        hit.alive = false;
        hit.respawnAt = Date.now() + 1200;
        room.bullets.splice(i, 1);
      }
    }

    if (room.timeLeft === 0) {
      room.status = 'finished';
      const winnerSlot = room.blueScore === room.redScore ? null : room.blueScore > room.redScore ? 0 : 1;
      broadcast(room, {
        type: 'gameOver',
        winner: winnerSlot === null ? 'DRAW' : winnerSlot === 0 ? 'BLUE WINS' : 'RED WINS'
      });
      if (winnerSlot !== null && pool) {
        const winner = room.clients.find(player => player.slot === winnerSlot);
        if (winner && winner.accountId) {
          pool.query('UPDATE game_users SET wins = wins + 1 WHERE id = $1 RETURNING wins', [winner.accountId])
            .then(result => {
              if (!result.rows[0]) throw new Error('Winning account no longer exists.');
              send(winner.socket, { type: 'winRecorded', wins: result.rows[0].wins });
            })
            .catch(error => {
              console.error('Could not save the online match win:', error.message);
              send(winner.socket, { type: 'notice', text: 'Your win could not be saved to the leaderboard. Please try again later.' });
            });
        }
      }
    }
    broadcast(room, snapshot(room));
  }
}, 50);

initializeDatabase().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Battlefield 1500 listening on port ${PORT}`);
  });
}).catch(error => {
  console.error('Could not initialize the game database:', error.message);
  process.exitCode = 1;
});
