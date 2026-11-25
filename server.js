const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/javascript.js': ['javascript.js', 'text/javascript; charset=utf-8'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8']
};
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
  const file = FILES[request.url.split('?')[0]];
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
    const name = typeof message.name === 'string'
      ? message.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18)
      : '';
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
    const name = typeof message.name === 'string'
      ? message.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18)
      : '';
    if (!name) {
      reject(socket, 'Enter a player name first.');
      return;
    }

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

webSockets.on('connection', socket => {
  socket.on('message', data => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      reject(socket, 'Could not read that message.');
      return;
    }
    handleMessage(socket, message);
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
      broadcast(room, {
        type: 'gameOver',
        winner: room.blueScore === room.redScore ? 'DRAW' : room.blueScore > room.redScore ? 'BLUE WINS' : 'RED WINS'
      });
    }
    broadcast(room, snapshot(room));
  }
}, 50);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Battlefield 1500 listening on port ${PORT}`);
});
