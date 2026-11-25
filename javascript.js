const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

const $ = (id) => document.getElementById(id);
const PLAYER_NAME_STORAGE_KEY = 'battlefield1500.playerName';
const menu = $('menu');
const pauseOverlay = $('pauseOverlay');
const gameOver = $('gameOver');
$('playerName').value = loadRememberedPlayerName();

function loadRememberedPlayerName() {
  try {
    return localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || '';
  } catch (error) {
    console.warn('Could not load the remembered soldier name from browser storage.', error);
    return '';
  }
}

let currentAccount = null;
let accountStateReady = false;

function renderAccountState(account) {
  currentAccount = account;
  $('accountForm').classList.toggle('hidden', Boolean(account));
  $('logoutButton').classList.toggle('hidden', !account);
  $('accountUsername').value = account ? account.username : '';
  $('accountPassword').value = '';
  $('accountStatus').textContent = account
    ? `Signed in as ${account.username} — ${account.wins} online wins.`
    : 'Sign in to save ranked online wins.';
  if (account) {
    $('playerName').value = account.username;
    $('playerName').readOnly = true;
  } else {
    $('playerName').readOnly = false;
  }
}

async function refreshAccountState() {
  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check the account.');
    renderAccountState(result.authenticated ? result.user : null);
    accountStateReady = true;
  } catch (error) {
    accountStateReady = true;
    $('accountStatus').textContent = error.message || 'Could not check the account. Try again later.';
  }
}

async function submitAccountAction(action) {
  const username = $('accountUsername').value.trim();
  const password = $('accountPassword').value;
  $('accountStatus').textContent = action === 'register' ? 'Creating account...' : 'Signing in...';
  $('registerButton').disabled = true;
  $('loginButton').disabled = true;
  try {
    const response = await fetch(`/api/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The account request failed.');
    renderAccountState(result.user);
    $('accountStatus').textContent = `Signed in as ${result.user.username} — ${result.user.wins} online wins.`;
  } catch (error) {
    $('accountStatus').textContent = error.message || 'Could not reach the account service. Try again later.';
  } finally {
    $('registerButton').disabled = false;
    $('loginButton').disabled = false;
  }
}

async function signOutAccount() {
  $('logoutButton').disabled = true;
  try {
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not sign out.');
    renderAccountState(null);
    $('playerName').value = loadRememberedPlayerName();
  } catch (error) {
    $('accountStatus').textContent = error.message || 'Could not sign out. Try again later.';
  } finally {
    $('logoutButton').disabled = false;
  }
}

async function loadLeaderboard() {
  const list = $('leaderboardList');
  list.replaceChildren();
  $('leaderboardStatus').textContent = 'Loading leaderboard...';
  try {
    const response = await fetch('/api/leaderboard', { credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load the leaderboard.');
    if (result.players.length === 0) {
      $('leaderboardStatus').textContent = 'No ranked wins yet. Be the first to win a private online battle!';
      return;
    }
    for (const [index, player] of result.players.entries()) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      const wins = document.createElement('strong');
      name.textContent = `${index + 1}. ${player.username}`;
      wins.textContent = `${player.wins} ${player.wins === 1 ? 'win' : 'wins'}`;
      item.append(name, wins);
      list.append(item);
    }
    $('leaderboardStatus').textContent = '';
  } catch (error) {
    $('leaderboardStatus').textContent = error.message || 'Could not load the leaderboard. Try again later.';
  }
}

let mode = 'bots';
let running = false;
let paused = false;
let lastTime = 0;
let timeLeft = 60;
let blueScore = 0;
let redScore = 0;
let players = [];
let bullets = [];
let particles = [];
let keys = {};
let mouse = { down: false, aiming: false, x: 0, y: 0 };
let socket = null;
let pendingRoomAction = null;
let onlinePlayerId = null;
let onlineRoomCode = null;
let lastInputSentAt = 0;
const chatHistory = [];
const battleMaps = {
  frontier: {
    name: 'Frontier Field',
    ground: '#526b42',
    blades: ['#587245', '#647d4e', '#718451', '#4e6942'],
    spawns: [{ x: 120, y: 270 }, { x: 840, y: 130 }, { x: 840, y: 410 }, { x: 720, y: 270 }],
    obstacles: [
      { x: 250, y: 130, w: 150, h: 28, r: 6 },
      { x: 560, y: 382, w: 150, h: 28, r: 6 },
      { x: 405, y: 240, w: 150, h: 28, r: 6 },
      { x: 465, y: 240, w: 28, h: 150, r: 6 }
    ]
  },
  village: {
    name: 'Greenwood Village',
    ground: '#64734a',
    blades: ['#596c40', '#718052', '#7b8958', '#53663d'],
    spawns: [{ x: 100, y: 270 }, { x: 860, y: 270 }, { x: 450, y: 285 }, { x: 510, y: 285 }],
    obstacles: [
      { x: 68, y: 72, w: 132, h: 112, type: 'house', roof: '#b5944e' },
      { x: 396, y: 64, w: 145, h: 122, type: 'house', roof: '#c0a15b' },
      { x: 750, y: 74, w: 140, h: 112, type: 'house', roof: '#ae8c47' },
      { x: 178, y: 356, w: 138, h: 112, type: 'house', roof: '#c0a15b' },
      { x: 632, y: 352, w: 148, h: 118, type: 'house', roof: '#b5944e' }
    ]
  },
  ruins: {
    name: 'Old Keep Ruins',
    ground: '#596344',
    blades: ['#4e593b', '#68704a', '#747953', '#555e40'],
    spawns: [{ x: 150, y: 270 }, { x: 810, y: 270 }, { x: 450, y: 70 }, { x: 450, y: 490 }],
    obstacles: [
      { x: 100, y: 100, w: 170, h: 26, r: 6 },
      { x: 345, y: 115, w: 26, h: 135, r: 6 },
      { x: 465, y: 140, w: 180, h: 26, r: 6 },
      { x: 730, y: 95, w: 26, h: 165, r: 6 },
      { x: 120, y: 335, w: 26, h: 140, r: 6 },
      { x: 290, y: 370, w: 175, h: 26, r: 6 },
      { x: 550, y: 315, w: 26, h: 150, r: 6 },
      { x: 700, y: 370, w: 170, h: 26, r: 6 },
      { x: 450, y: 255, w: 60, h: 28, r: 6 }
    ]
  },
  lobby: {
    name: 'Meeting Green',
    ground: '#63734b',
    blades: ['#5b7044', '#718251', '#7a8858', '#536c42'],
    spawns: [{ x: 480, y: 270 }],
    obstacles: [
      { x: 160, y: 100, w: 140, h: 22, r: 6 },
      { x: 660, y: 100, w: 140, h: 22, r: 6 },
      { x: 160, y: 418, w: 140, h: 22, r: 6 },
      { x: 660, y: 418, w: 140, h: 22, r: 6 }
    ]
  }
};
let selectedBattleMap = 'frontier';
let currentMapId = 'frontier';
let obstacles = battleMaps[currentMapId].obstacles;

const groundDetails = Array.from({ length: 460 }, (_, i) => {
  const x = (i * 197 + 41) % W;
  const y = (i * 113 + 29) % H;
  return {
    x,
    y,
    length: 2 + (i % 5),
    color: battleMaps.frontier.blades[i % 4],
    flower: i % 31 === 0
  };
});

function setCurrentMap(mapId) {
  currentMapId = battleMaps[mapId] ? mapId : 'frontier';
  obstacles = battleMaps[currentMapId].obstacles;
}

function chooseBattleMap(mapId) {
  if (!battleMaps[mapId] || mapId === 'lobby') return;
  selectedBattleMap = mapId;
  for (const button of document.querySelectorAll('[data-map]')) {
    button.classList.toggle('selected', button.dataset.map === mapId);
  }
}

function makePlayer(x, y, color, type = 'human') {
  return { x, y, vx: 0, vy: 0, r: 17, color, type, angle: 0, cooldown: 0, alive: true, respawn: 0, aiTimer: 0, aiMoveTimer: 0, aiMoveX: 0, aiMoveY: 0 };
}

function resetMatch() {
  blueScore = 0;
  redScore = 0;
  timeLeft = 60;
  bullets = [];
  particles = [];
  const spawns = battleMaps[currentMapId].spawns;
  if (mode === 'bots') {
    players = [
      makePlayer(spawns[0].x, spawns[0].y, '#345c71'),
      makePlayer(spawns[1].x, spawns[1].y, '#873f35', 'bot'),
      makePlayer(spawns[2].x, spawns[2].y, '#873f35', 'bot'),
      makePlayer(spawns[3].x, spawns[3].y, '#873f35', 'bot')
    ];
  } else {
    players = [
      makePlayer(spawns[0].x, spawns[0].y, '#345c71'),
      makePlayer(spawns[1].x, spawns[1].y, '#873f35')
    ];
  }
  updateScore();
}

function updateScore() {
  $('blueScore').textContent = blueScore;
  $('redScore').textContent = redScore;
  $('timer').textContent = Math.ceil(timeLeft);
}

function circleRectCollides(c, rect) {
  const cx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
  const cy = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
  const dx = c.x - cx;
  const dy = c.y - cy;
  return dx * dx + dy * dy < c.r * c.r;
}

function movePlayer(p, dx, dy, dt) {
  const speed = 210;
  const len = Math.hypot(dx, dy) || 1;
  p.vx = dx / len * speed;
  p.vy = dy / len * speed;
  const nx = p.x + p.vx * dt;
  const ny = p.y + p.vy * dt;
  const testX = { ...p, x: nx };
  const testY = { ...p, y: ny };
  if (nx > p.r && nx < W - p.r && !obstacles.some(o => circleRectCollides(testX, o))) p.x = nx;
  if (ny > p.r && ny < H - p.r && !obstacles.some(o => circleRectCollides(testY, o))) p.y = ny;
}

function shoot(p, angle) {
  if (p.cooldown > 0 || !p.alive) return;
  p.angle = angle;
  p.cooldown = 0.62;
  bullets.push({ x: p.x + Math.cos(angle) * 22, y: p.y + Math.sin(angle) * 22, vx: Math.cos(angle) * 430, vy: Math.sin(angle) * 430, life: 1.5, owner: p, r: 4 });
}

function nearestEnemy(p) {
  let best = null;
  let bestDistance = Infinity;
  for (const other of players) {
    if (!other.alive || other === p) continue;
    if (mode === 'bots' && other === players[0]) {
      const d = Math.hypot(other.x - p.x, other.y - p.y);
      if (d < bestDistance) { best = other; bestDistance = d; }
    } else if (mode === 'bots' && p === players[0]) {
      continue;
    } else if (mode === 'local' && other !== p) {
      const d = Math.hypot(other.x - p.x, other.y - p.y);
      if (d < bestDistance) { best = other; bestDistance = d; }
    }
  }
  return best;
}

function updateAI(p, dt) {
  p.aiTimer -= dt;
  p.aiMoveTimer -= dt;
  p.cooldown -= dt;
  const target = nearestEnemy(p);
  if (!target) return;
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const distance = Math.hypot(dx, dy);
  if (p.aiMoveTimer <= 0) {
    let mx = 0;
    let my = 0;
    if (distance > 320) { mx = dx; my = dy; }
    else if (distance < 115) { mx = -dx; my = -dy; }
    else if (Math.random() < 0.45) { mx = -dy; my = dx; }
    else if (Math.random() < 0.8) { mx = dy; my = -dx; }
    p.aiMoveX = mx;
    p.aiMoveY = my;
    p.aiMoveTimer = 0.7 + Math.random() * 0.8;
  }
  movePlayer(p, p.aiMoveX, p.aiMoveY, dt);
  if (p.aiTimer <= 0) {
    const aimError = (Math.random() - 0.5) * 0.8;
    shoot(p, Math.atan2(dy, dx) + aimError);
    p.aiTimer = 0.9 + Math.random() * 0.8;
  }
}

function respawn(p) {
  p.alive = false;
  p.respawn = 1.2;
  for (let i = 0; i < 18; i++) {
    particles.push({ x: p.x, y: p.y, vx: (Math.random() - .5) * 220, vy: (Math.random() - .5) * 220, life: .5, color: p.color });
  }
}

function update(dt) {
  if (mode === 'online' || mode === 'public') {
    sendOnlineInput();
    return;
  }

  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    endMatch();
  }

  if (mode === 'local') {
    const dx = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
    const dy = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
    if (players[1].alive && (dx !== 0 || dy !== 0)) {
      movePlayer(players[1], dx, dy, dt);
      players[1].angle = Math.atan2(dy, dx);
    }
  }

  const blue = players[0];
  if (blue.alive) {
    blue.cooldown -= dt;
    const dx = (keys.d || keys.D ? 1 : 0) - (keys.a || keys.A ? 1 : 0);
    const dy = (keys.s || keys.S ? 1 : 0) - (keys.w || keys.W ? 1 : 0);
    if (dx !== 0 || dy !== 0) {
      movePlayer(blue, dx, dy, dt);
      if (!mouse.aiming) blue.angle = Math.atan2(dy, dx);
    }
    if (mouse.aiming) {
      blue.angle = Math.atan2(mouse.y - blue.y, mouse.x - blue.x);
    }
    if (mouse.down) shoot(blue, blue.angle);
  }

  if (mode === 'local') {
    const red = players[1];
    red.cooldown -= dt;
    if (keys[';'] || keys['/'] || keys['.']) shoot(red, red.angle);
  }

  for (let i = 1; i < players.length; i++) {
    if (mode === 'bots' && players[i].type === 'bot') updateAI(players[i], dt);
  }

  for (const p of players) {
    if (!p.alive) {
      p.respawn -= dt;
      if (p.respawn <= 0) {
        p.alive = true;
        const spawn = battleMaps[currentMapId].spawns[players.indexOf(p)];
        p.x = spawn.x;
        p.y = spawn.y;
      }
    }
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H || obstacles.some(o => circleRectCollides(b, o))) {
      bullets.splice(i, 1);
      continue;
    }
    for (const p of players) {
      if (p !== b.owner && p.alive && Math.hypot(p.x - b.x, p.y - b.y) < p.r + b.r) {
        if (b.owner === blue) blueScore++;
        else redScore++;
        respawn(p);
        bullets.splice(i, 1);
        updateScore();
        break;
      }
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
  updateScore();
}

function drawGrid() {
  const map = battleMaps[currentMapId];
  ctx.fillStyle = map.ground;
  ctx.fillRect(0, 0, W, H);
  for (const detail of groundDetails) {
    ctx.strokeStyle = map.blades[(Math.floor(detail.x + detail.y) + detail.length) % map.blades.length];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(detail.x, detail.y + detail.length);
    ctx.lineTo(detail.x + 2, detail.y);
    ctx.stroke();
    if (detail.flower) {
      ctx.fillStyle = '#c9b968';
      ctx.fillRect(detail.x + 3, detail.y - 2, 2, 2);
    }
  }
  if (currentMapId === 'village') {
    ctx.strokeStyle = 'rgba(177, 143, 88, .3)';
    ctx.lineWidth = 34;
    ctx.beginPath();
    ctx.moveTo(0, 270);
    ctx.lineTo(W, 270);
    ctx.stroke();
  } else if (currentMapId === 'ruins') {
    ctx.fillStyle = 'rgba(112, 102, 79, .28)';
    for (let i = 0; i < 18; i++) {
      const x = (i * 181 + 85) % W;
      const y = (i * 127 + 55) % H;
      ctx.fillRect(x, y, 8 + (i % 7), 5 + (i % 4));
    }
  } else if (currentMapId === 'lobby') {
    ctx.strokeStyle = 'rgba(188, 162, 103, .32)';
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 8]);
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2, 115, 82, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8a623a';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#dfaa54';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2 - 3, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawObstacle(o) {
  if (o.type === 'house') {
    drawHouse(o);
    return;
  }
  ctx.fillStyle = 'rgba(30, 35, 25, .35)';
  ctx.fillRect(o.x + 3, o.y + 5, o.w, o.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(o.x, o.y, o.w, o.h);
  ctx.clip();
  ctx.fillStyle = '#756b55';
  ctx.fillRect(o.x, o.y, o.w, o.h);

  const stoneWidth = 31;
  const stoneHeight = 16;
  for (let row = 0; row * stoneHeight < o.h + stoneHeight; row++) {
    const offset = row % 2 ? stoneWidth / 2 : 0;
    for (let col = -1; col * stoneWidth < o.w + stoneWidth; col++) {
      const x = o.x + col * stoneWidth + offset;
      const y = o.y + row * stoneHeight;
      const shade = (row * 7 + col * 11) % 4;
      ctx.fillStyle = ['#867b63', '#958870', '#7c725d', '#a0947a'][shade];
      ctx.fillRect(x + 1, y + 1, stoneWidth - 2, stoneHeight - 2);
      ctx.strokeStyle = 'rgba(48, 43, 34, .65)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1.5, y + 1.5, stoneWidth - 3, stoneHeight - 3);
      ctx.strokeStyle = 'rgba(220, 207, 176, .28)';
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 3);
      ctx.lineTo(x + stoneWidth - 5, y + 3);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.strokeStyle = '#514b3e';
  ctx.lineWidth = 2;
  ctx.strokeRect(o.x, o.y, o.w, o.h);
}

function drawHouse(house) {
  const { x, y, w, h, roof } = house;
  ctx.fillStyle = 'rgba(30, 35, 25, .42)';
  ctx.fillRect(x + 7, y + 9, w, h);

  ctx.fillStyle = '#514737';
  ctx.fillRect(x + 5, y + 23, w - 10, h - 28);
  ctx.fillStyle = '#827965';
  ctx.fillRect(x + 10, y + 27, w - 20, h - 37);
  const stoneWidth = 18;
  const stoneHeight = 12;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 10, y + 27, w - 20, h - 37);
  ctx.clip();
  for (let row = 0; row * stoneHeight < h - 37; row++) {
    const offset = row % 2 ? stoneWidth / 2 : 0;
    for (let col = -1; col * stoneWidth < w - 20 + stoneWidth; col++) {
      const stoneX = x + 10 + col * stoneWidth + offset;
      const stoneY = y + 27 + row * stoneHeight;
      const shade = Math.abs((row * 5 + col * 3) % 5);
      ctx.fillStyle = ['#958a73', '#817864', '#a0947d', '#88806d', '#766f60'][shade];
      ctx.beginPath();
      ctx.roundRect(stoneX + 1, stoneY + 1, stoneWidth - 2, stoneHeight - 2, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(55, 49, 39, .55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(224, 214, 188, .22)';
      ctx.beginPath();
      ctx.moveTo(stoneX + 4, stoneY + 3);
      ctx.lineTo(stoneX + stoneWidth - 5, stoneY + 3);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.strokeStyle = '#574630';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 10, y + 27, w - 20, h - 37);

  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(x - 5, y + 28);
  ctx.lineTo(x + w * .5, y - 5);
  ctx.lineTo(x + w + 5, y + 28);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#49382c';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - 2, y + 27);
  ctx.lineTo(x + w * .5, y - 2);
  ctx.lineTo(x + w + 2, y + 27);
  ctx.closePath();
  ctx.clip();
  for (let row = 0; row < 6; row++) {
    const rowY = y + 2 + row * 5;
    ctx.strokeStyle = row % 2 ? 'rgba(103, 75, 35, .58)' : 'rgba(239, 211, 135, .55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 5, rowY);
    ctx.lineTo(x + w - 5, rowY);
    ctx.stroke();
    for (let strand = 0; strand < 12; strand++) {
      const strandX = x + 7 + strand * (w - 14) / 11 + (row % 2) * 3;
      ctx.strokeStyle = strand % 2 ? 'rgba(105, 78, 38, .52)' : 'rgba(244, 220, 155, .58)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(strandX, rowY - 2);
      ctx.lineTo(strandX - 2, rowY + 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  ctx.fillStyle = '#76543b';
  ctx.fillRect(x + w * .42, y + h - 38, w * .18, 28);
  ctx.strokeStyle = '#4d3827';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + w * .42, y + h - 38, w * .18, 28);
  ctx.fillStyle = '#d1b56e';
  ctx.beginPath();
  ctx.arc(x + w * .56, y + h - 24, 1.8, 0, Math.PI * 2);
  ctx.fill();

  for (const windowX of [x + w * .2, x + w * .72]) {
    ctx.fillStyle = '#627079';
    ctx.fillRect(windowX, y + h * .53, 14, 15);
    ctx.strokeStyle = '#59452f';
    ctx.lineWidth = 2;
    ctx.strokeRect(windowX, y + h * .53, 14, 15);
    ctx.beginPath();
    ctx.moveTo(windowX + 7, y + h * .53);
    ctx.lineTo(windowX + 7, y + h * .53 + 15);
    ctx.moveTo(windowX, y + h * .53 + 7.5);
    ctx.lineTo(windowX + 14, y + h * .53 + 7.5);
    ctx.stroke();
  }

  ctx.fillStyle = '#514737';
  ctx.fillRect(x + 18, y + h - 13, w - 36, 5);
}

function drawPlayer(p) {
  if (!p.alive) return;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(30, 28, 20, .4)';
  ctx.beginPath();
  ctx.ellipse(-1, 4, 15, 11, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = p === players[0] ? '#345c71' : '#873f35';
  ctx.beginPath();
  ctx.ellipse(-3, 0, 11, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#d1b56e';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = '#c6a778';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-7, -5);
  ctx.lineTo(1, -8);
  ctx.moveTo(-7, 5);
  ctx.lineTo(1, 8);
  ctx.stroke();
  ctx.fillStyle = '#594a35';
  ctx.fillRect(-14, -7, 5, 4);
  ctx.fillRect(-14, 3, 5, 4);

  ctx.fillStyle = '#c6a778';
  ctx.beginPath();
  ctx.arc(6, 0, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8b764f';
  ctx.beginPath();
  ctx.ellipse(6, -1, 6, 5, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#4b3824';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(13, -10);
  ctx.quadraticCurveTo(25, 0, 13, 10);
  ctx.stroke();
  ctx.strokeStyle = '#d4c398';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(14, -9);
  ctx.lineTo(14, 9);
  ctx.stroke();
  ctx.strokeStyle = '#59452c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(26, 0);
  ctx.stroke();
  ctx.restore();
  if (mode === 'public' && p.name) {
    ctx.save();
    ctx.font = '12px Cinzel, Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(25, 27, 20, .8)';
    ctx.strokeText(p.name, p.x, p.y - 20);
    ctx.fillStyle = '#f1e4c4';
    ctx.fillText(p.name, p.x, p.y - 20);
    ctx.restore();
  }
}

function draw() {
  drawGrid();
  obstacles.forEach(drawObstacle);
  for (const b of bullets) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(Math.atan2(b.vy, b.vx));
    ctx.fillStyle = '#5b452c';
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, -1.5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-5, 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#d2bd84';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-6, 0);
    ctx.stroke();
    ctx.restore();
  }
  players.forEach(drawPlayer);
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life * 2);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 3, 3);
  }
  ctx.globalAlpha = 1;
}

function loop(now) {
  if (!running) return;
  const dt = Math.min((now - lastTime) / 1000, .033);
  lastTime = now;
  if (!paused) update(dt);
  draw();
  requestAnimationFrame(loop);
}

function endMatch() {
  running = false;
  let title;
  if (blueScore === redScore) title = 'DRAW';
  else if (blueScore > redScore) title = 'BLUE WINS';
  else title = 'RED WINS';
  $('winnerText').textContent = title;
  $('finalScore').textContent = `BLUE ${blueScore} — ${redScore} RED`;
  gameOver.classList.remove('hidden');
}

function selectMode(nextMode) {
  mode = nextMode;
  const selectedId = { bots: 'botMode', local: 'localMode', online: 'onlineMode', public: 'publicLobbyMode' }[nextMode];
  for (const id of ['botMode', 'localMode', 'onlineMode', 'publicLobbyMode']) {
    $(id).classList.toggle('selected', id === selectedId);
  }
  $('playerTwoControls').style.visibility = nextMode === 'local' ? 'visible' : 'hidden';
  $('mapPicker').classList.toggle('hidden', nextMode === 'public');
  $('startButton').firstChild.textContent = nextMode === 'online'
    ? 'OPEN PRIVATE LOBBY '
    : nextMode === 'public' ? 'JOIN PUBLIC LOBBY ' : 'ENTER ARENA ';
}

function showLobby() {
  $('connectionError').textContent = '';
  $('lobbyDescription').textContent = mode === 'public'
    ? 'Choose a name and enter the shared walkable lobby.'
    : 'Create a room or enter a friend’s room code.';
  $('roomConnectForm').classList.remove('hidden');
  $('roomSession').classList.add('hidden');
  $('privateRoomControls').classList.toggle('hidden', mode === 'public');
  $('publicJoinButton').classList.toggle('hidden', mode !== 'public');
  $('lobbyChatMessages').replaceChildren();
  $('menu').classList.add('hidden');
  $('lobbyOverlay').classList.remove('hidden');
  const inviteRoom = new URLSearchParams(location.search).get('room');
  if (inviteRoom) $('roomCodeInput').value = inviteRoom.toUpperCase().slice(0, 5);
  $('playerName').focus();
}

function startMatch() {
  if (mode === 'bots' || mode === 'local') {
    setCurrentMap(selectedBattleMap);
    resetMatch();
  }
  else {
    bullets = [];
    particles = [];
  }
  menu.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  gameOver.classList.add('hidden');
  $('lobbyOverlay').classList.add('hidden');
  $('touchControls').classList.remove('hidden');
  $('gameChat').classList.toggle('hidden', mode !== 'online' && mode !== 'public');
  $('publicLobbyBadge').classList.toggle('hidden', mode !== 'public');
  $('battleMapBadge').classList.toggle('hidden', mode === 'public');
  $('battleMapBadge').textContent = battleMaps[currentMapId].name;
  document.querySelector('.game-shell').classList.toggle('public-lobby', mode === 'public');
  if (mode === 'online' || mode === 'public') canvas.focus();
  running = true;
  paused = false;
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

function appendChat(message) {
  chatHistory.push(message);
  if (chatHistory.length > 50) chatHistory.shift();
  for (const id of ['lobbyChatMessages', 'gameChatMessages']) {
    const list = $(id);
    const item = document.createElement('div');
    item.className = message.type === 'notice' ? 'chat-message chat-system' : 'chat-message';
    if (message.type === 'chat') {
      const name = document.createElement('strong');
      name.textContent = `${message.name}: `;
      item.append(name, document.createTextNode(message.text));
    } else {
      item.textContent = message.text;
    }
    list.append(item);
    list.scrollTop = list.scrollHeight;
  }
}

function renderLobby(message) {
  $('roomCodeLabel').textContent = message.room;
  $('lobbyStatus').textContent = message.status === 'playing'
    ? 'Battle in progress!'
    : message.players.length < 2
      ? 'Waiting for another soldier to join...'
      : 'Both soldiers are ready.';
  const list = $('lobbyPlayers');
  list.replaceChildren();
  for (const player of message.players) {
    const badge = document.createElement('span');
    badge.className = 'lobby-player';
    badge.textContent = `${player.slot === 0 ? 'BLUE' : 'RED'} — ${player.name}`;
    list.append(badge);
  }
  if (message.status === 'waiting' && mode === 'online' && onlinePlayerId) {
    running = false;
    $('gameChat').classList.add('hidden');
    $('touchControls').classList.add('hidden');
    $('lobbyOverlay').classList.remove('hidden');
    $('roomConnectForm').classList.add('hidden');
    $('roomSession').classList.remove('hidden');
  }
}

function handleOnlineMessage(message) {
  if (message.type === 'error') {
    $('connectionError').textContent = message.text;
    return;
  }
  if (message.type === 'joined') {
    onlinePlayerId = message.playerId;
    onlineRoomCode = message.room;
    if (message.mapId) setCurrentMap(message.mapId);
    $('connectionError').textContent = '';
    $('roomConnectForm').classList.add('hidden');
    $('roomSession').classList.remove('hidden');
    $('roomCodeLabel').textContent = message.room;
    $('lobbyChatMessages').replaceChildren();
    $('gameChatMessages').replaceChildren();
    chatHistory.length = 0;
    for (const chat of message.chat) appendChat(chat);
    history.replaceState(null, '', `?room=${encodeURIComponent(message.room)}`);
    return;
  }
  if (message.type === 'publicJoined') {
    onlinePlayerId = message.playerId;
    onlineRoomCode = null;
    mode = 'public';
    setCurrentMap('lobby');
    $('connectionError').textContent = '';
    $('gameChatMessages').replaceChildren();
    chatHistory.length = 0;
    for (const chat of message.chat) appendChat(chat);
    startMatch();
    return;
  }
  if (message.type === 'publicSnapshot') {
    setCurrentMap('lobby');
    $('onlineCount').textContent = `${message.count} ${message.count === 1 ? 'SOLDIER' : 'SOLDIERS'}`;
    players = message.players.map(player => ({
      ...player,
      r: 17,
      color: player.slot === 0 ? '#345c71' : '#873f35',
      type: 'public',
      cooldown: 0,
      respawn: 0,
      alive: true
    }));
    return;
  }
  if (message.type === 'lobby') {
    onlineRoomCode = message.room;
    if (message.mapId) setCurrentMap(message.mapId);
    renderLobby(message);
  } else if (message.type === 'chat' || message.type === 'notice') {
    appendChat(message);
  } else if (message.type === 'gameStart') {
    mode = 'online';
    if (message.mapId) setCurrentMap(message.mapId);
    startMatch();
  } else if (message.type === 'snapshot') {
    if (message.mapId) setCurrentMap(message.mapId);
    timeLeft = message.timeLeft;
    blueScore = message.blueScore;
    redScore = message.redScore;
    players = message.players.map(player => ({
      ...player,
      r: 17,
      color: player.slot === 0 ? '#81a9ba' : '#b96a58',
      type: 'online',
      cooldown: 0,
      respawn: 0,
      alive: player.alive
    }));
    bullets = message.bullets.map(bullet => ({
      ...bullet,
      owner: players.find(player => player.id === bullet.ownerId) || players[0],
      r: 3
    }));
    updateScore();
  } else if (message.type === 'gameOver') {
    running = false;
    $('winnerText').textContent = message.winner;
    $('finalScore').textContent = `BLUE ${blueScore} — ${redScore} RED`;
    $('gameOver').classList.remove('hidden');
  } else if (message.type === 'winRecorded') {
    if (currentAccount) {
      currentAccount.wins = message.wins;
      $('accountStatus').textContent = `Signed in as ${currentAccount.username} — ${currentAccount.wins} online wins.`;
    }
  }
}

async function sendRoomAction(action) {
  if (!accountStateReady) await refreshAccountState();
  $('connectionError').textContent = '';
  const isPrivateBattle = action.type === 'create' || action.type === 'join';
  if (isPrivateBattle && !currentAccount) {
    $('connectionError').textContent = 'Create an account or sign in to play ranked private battles.';
    $('accountUsername').focus();
    return;
  }
  const name = currentAccount ? currentAccount.username : $('playerName').value.trim();
  if (!name) {
    $('connectionError').textContent = 'Enter a soldier name first.';
    $('playerName').focus();
    return;
  }
  if (!currentAccount) {
    try {
      localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
    } catch (error) {
      console.warn('Could not save the remembered guest name.', error);
    }
  }
  pendingRoomAction = { ...action, name };
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(pendingRoomAction));
    pendingRoomAction = null;
    return;
  }
  if (socket && socket.readyState === WebSocket.CONNECTING) return;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}`);
  socket.addEventListener('open', () => {
    $('connectionError').textContent = '';
    if (pendingRoomAction) {
      socket.send(JSON.stringify(pendingRoomAction));
      pendingRoomAction = null;
    }
  });
  socket.addEventListener('message', event => {
    try {
      handleOnlineMessage(JSON.parse(event.data));
    } catch (error) {
      $('connectionError').textContent = 'Received an unreadable server response.';
    }
  });
  socket.addEventListener('error', () => {
    $('connectionError').textContent = 'Could not connect. Open this game from its online server to use multiplayer.';
  });
  socket.addEventListener('close', () => {
    if (onlinePlayerId) appendChat({ type: 'notice', text: 'Connection to the room was lost.' });
    onlinePlayerId = null;
    onlineRoomCode = null;
    socket = null;
    pendingRoomAction = null;
  });
}

function sendOnlineInput() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !onlinePlayerId || performance.now() - lastInputSentAt < 50) return;
  lastInputSentAt = performance.now();
  const dx = (keys.d || keys.D ? 1 : 0) - (keys.a || keys.A ? 1 : 0);
  const dy = (keys.s || keys.S ? 1 : 0) - (keys.w || keys.W ? 1 : 0);
  const player = players.find(item => item.id === onlinePlayerId);
  const angle = mouse.aiming && player
    ? Math.atan2(mouse.y - player.y, mouse.x - player.x)
    : player && (dx !== 0 || dy !== 0) ? Math.atan2(dy, dx) : player ? player.angle : 0;
  socket.send(JSON.stringify({
    type: 'input',
    input: { x: dx, y: dy, angle, shoot: mode === 'online' && mouse.down }
  }));
}

function sendChat(inputId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const input = $(inputId);
  const text = input.value.trim();
  if (!text) return;
  socket.send(JSON.stringify({ type: 'chat', text }));
  input.value = '';
}

function leaveOnlineRoom() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'leave' }));
    socket.close();
  }
  socket = null;
  onlinePlayerId = null;
  onlineRoomCode = null;
  running = false;
  paused = false;
  $('lobbyOverlay').classList.add('hidden');
  $('gameChat').classList.add('hidden');
  $('publicLobbyBadge').classList.add('hidden');
  $('battleMapBadge').classList.add('hidden');
  document.querySelector('.game-shell').classList.remove('public-lobby');
  $('touchControls').classList.add('hidden');
  $('pauseOverlay').classList.add('hidden');
  $('gameOver').classList.add('hidden');
  $('menu').classList.remove('hidden');
  history.replaceState(null, '', window.location.pathname);
}

$('botMode').addEventListener('click', () => selectMode('bots'));
$('localMode').addEventListener('click', () => selectMode('local'));
$('onlineMode').addEventListener('click', () => selectMode('online'));
$('publicLobbyMode').addEventListener('click', () => selectMode('public'));
$('accountForm').addEventListener('submit', event => {
  event.preventDefault();
  submitAccountAction('login');
});
$('registerButton').addEventListener('click', () => submitAccountAction('register'));
$('logoutButton').addEventListener('click', signOutAccount);
$('leaderboardButton').addEventListener('click', () => {
  menu.classList.add('hidden');
  $('leaderboardOverlay').classList.remove('hidden');
  loadLeaderboard();
});
$('leaderboardCloseButton').addEventListener('click', () => {
  $('leaderboardOverlay').classList.add('hidden');
  menu.classList.remove('hidden');
});
$('mapPicker').addEventListener('click', event => {
  const button = event.target.closest('[data-map]');
  if (button) chooseBattleMap(button.dataset.map);
});
$('leavePublicLobbyButton').addEventListener('click', leaveOnlineRoom);
$('startButton').addEventListener('click', () => {
  if (mode === 'online' || mode === 'public') showLobby();
  else startMatch();
});
$('createRoomButton').addEventListener('click', () => sendRoomAction({ type: 'create', mapId: selectedBattleMap }));
$('joinRoomButton').addEventListener('click', () => sendRoomAction({ type: 'join', room: $('roomCodeInput').value }));
$('publicJoinButton').addEventListener('click', () => sendRoomAction({ type: 'publicJoin' }));
$('copyRoomButton').addEventListener('click', async () => {
  if (!onlineRoomCode) return;
  const invite = `${location.origin}${location.pathname}?room=${encodeURIComponent(onlineRoomCode)}`;
  try {
    await navigator.clipboard.writeText(invite);
    $('copyRoomButton').textContent = 'COPIED';
  } catch (error) {
    $('connectionError').textContent = 'Copy failed. Share this room code: ' + onlineRoomCode;
  }
});
$('leaveRoomButton').addEventListener('click', leaveOnlineRoom);
$('lobbyBackButton').addEventListener('click', () => {
  leaveOnlineRoom();
});
$('lobbyChatForm').addEventListener('submit', event => {
  event.preventDefault();
  sendChat('lobbyChatInput');
});
$('gameChatForm').addEventListener('submit', event => {
  event.preventDefault();
  sendChat('gameChatInput');
});
$('gameChatToggle').addEventListener('click', () => {
  const panel = $('gameChatPanel');
  panel.classList.toggle('hidden');
  $('gameChatToggle').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
});
$('pauseButton').addEventListener('click', () => {
  if (!running) return;
  paused = !paused;
  if (paused && (mode === 'online' || mode === 'public') && socket && socket.readyState === WebSocket.OPEN) {
    const player = players.find(item => item.id === onlinePlayerId);
    socket.send(JSON.stringify({ type: 'input', input: { x: 0, y: 0, angle: player ? player.angle : 0, shoot: false } }));
  }
  pauseOverlay.classList.toggle('hidden', !paused);
});
$('resumeButton').addEventListener('click', () => { paused = false; pauseOverlay.classList.add('hidden'); });
$('menuButton').addEventListener('click', () => {
  if (mode === 'online') leaveOnlineRoom();
  else {
    running = false;
    paused = false;
    pauseOverlay.classList.add('hidden');
    menu.classList.remove('hidden');
  }
});
$('againButton').addEventListener('click', () => {
  if (mode === 'online' && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'rematch' }));
  else startMatch();
});
$('gameMenuButton').addEventListener('click', () => {
  if (mode === 'online' || mode === 'public') leaveOnlineRoom();
  else { $('gameOver').classList.add('hidden'); menu.classList.remove('hidden'); }
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, button')) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  keys[e.key] = true;
  keys[key] = true;

  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd', 'f', ';', '/', '.'].includes(key) || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
  }

  if (key === 'escape' && running) {
    paused = !paused;
    pauseOverlay.classList.toggle('hidden', !paused);
  }

  if (players[0]) {
    if (key === 'w') players[0].angle = -Math.PI / 2;
    if (key === 's') players[0].angle = Math.PI / 2;
    if (key === 'a') players[0].angle = Math.PI;
    if (key === 'd') players[0].angle = 0;
  }
  if (mode === 'local' && players[1]) {
    if (e.key === 'ArrowLeft') players[1].angle = Math.PI;
    if (e.key === 'ArrowRight') players[1].angle = 0;
    if (e.key === 'ArrowUp') players[1].angle = -Math.PI / 2;
    if (e.key === 'ArrowDown') players[1].angle = Math.PI / 2;
  }
  if (mode === 'local' && (key === ';' || key === '/' || key === '.')) shoot(players[1], players[1].angle);
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  keys[key] = false;
});
window.addEventListener('blur', () => {
  keys = {};
  mouse.down = false;
});

function updateMousePosition(event) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = (event.clientX - rect.left) * (W / rect.width);
  mouse.y = (event.clientY - rect.top) * (H / rect.height);
  mouse.aiming = true;
}

canvas.addEventListener('pointermove', updateMousePosition);
canvas.addEventListener('mouseleave', () => { mouse.aiming = false; });
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  updateMousePosition(event);
  mouse.down = true;
  event.preventDefault();
});
window.addEventListener('pointerup', (event) => {
  if (event.button === 0) mouse.down = false;
});

for (const button of document.querySelectorAll('.touch-dpad [data-key]')) {
  const key = button.dataset.key;
  button.addEventListener('pointerdown', event => {
    keys[key] = true;
    button.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  const release = event => {
    keys[key] = false;
    event.preventDefault();
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

$('touchShoot').addEventListener('pointerdown', event => {
  mouse.down = true;
  $('touchShoot').setPointerCapture(event.pointerId);
  event.preventDefault();
});
const releaseTouchShoot = event => {
  mouse.down = false;
  event.preventDefault();
};
$('touchShoot').addEventListener('pointerup', releaseTouchShoot);
$('touchShoot').addEventListener('pointercancel', releaseTouchShoot);
$('touchShoot').addEventListener('lostpointercapture', releaseTouchShoot);

resetMatch();
draw();
refreshAccountState();
