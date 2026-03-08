const socket = io();
let myId = null;
let roomState = null;

const auth = document.getElementById('auth');
const lobby = document.getElementById('lobby');
const room = document.getElementById('room');

function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2300);
}

function cardLabel(c) {
  if (c.type === 'number') return `${c.color} ${c.value}`;
  return `${c.color} ${c.type}`;
}

function colorClass(c) {
  return ['red', 'green', 'blue', 'yellow'].includes(c) ? c : 'wild';
}

function renderLobby(data) {
  document.getElementById('onlineCount').textContent = `在线人数：${data.onlineCount}`;
  const list = document.getElementById('roomList');
  list.innerHTML = '';
  data.rooms.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.innerHTML = `<div>${r.name} (${r.players}/${r.maxPlayers}) ${r.locked ? '🔒' : ''} ${r.gameStarted ? '进行中' : ''}</div>`;
    const btn = document.createElement('button');
    btn.textContent = '加入';
    btn.disabled = r.locked || r.gameStarted || r.players >= r.maxPlayers;
    btn.onclick = () => socket.emit('room:join', { roomId: r.id });
    div.appendChild(btn);
    list.appendChild(div);
  });
}

function renderRoom(s) {
  roomState = s;
  room.classList.remove('hidden');
  lobby.classList.add('hidden');

  const isHost = s.hostId === myId;
  const top = s.topCard;

  room.innerHTML = `
    <h2>房间：${s.name}</h2>
    <div class="meta">规则：叠加${s.settings.allowStackDraw ? '开' : '关'} / 同色全出${s.settings.allowSameColorAll ? '开' : '关'} / 抢出${s.settings.allowSnatch ? '开' : '关'} / 最大${s.settings.maxPlayers}人</div>
    <div class="meta">${s.gameStarted ? `当前回合：${s.players.find(p=>p.id===s.currentPlayerId)?.name || '-'} | 方向：${s.direction === 1 ? '顺时针' : '逆时针'} | 待抽：${s.pendingDraw}` : '等待房主开始游戏'}</div>
    <div>${top ? `<span class="top-card ${colorClass(top.color)}">场上：${cardLabel(top)} / 当前色：${s.chosenColor}</span>` : ''}</div>

    <h3>玩家</h3>
    <div>${s.players.map((p) => `
      <div class="player-item">
        <div>${p.name} ${p.connected ? '' : '<span class="warn">(掉线)</span>'} ${p.id===s.hostId ? '👑' : ''} | 手牌:${p.handCount} ${p.unoDeclared ? 'UNO!' : ''}</div>
        <div>
          ${isHost && p.id !== s.hostId ? `<button data-kick="${p.id}">移除</button>` : ''}
          ${isHost && !p.connected ? `<button data-offline="${p.id}">移除掉线</button>` : ''}
          ${s.canReportUnoTargets.includes(p.id) ? `<button data-report="${p.id}">举报UNO</button>` : ''}
        </div>
      </div>
    `).join('')}</div>

    <div class="row">
      ${isHost && !s.gameStarted ? `<button id="startGame">开始游戏</button>` : ''}
      ${isHost ? `<button id="toggleLock">${s.locked ? '解锁房间' : '锁定房间'}</button>` : ''}
      ${s.me?.hand?.length === 1 ? `<button id="unoBtn">喊 UNO</button>` : ''}
      ${s.gameOver ? `<button id="rematchBtn">再来一局</button>` : ''}
      <button id="backLobby">返回大厅</button>
    </div>

    ${s.gameOver ? `<h3>排行榜</h3>
      <ol>${s.ranking.map((r) => `<li>${r.name}（剩余 ${r.cardsLeft}）</li>`).join('')}</ol>` : ''}

    <h3>你的手牌</h3>
    <div class="hand">
      ${(s.me?.hand || []).map((c) => `<button class="card-btn ${colorClass(c.color)}" data-play="${c.id}">${cardLabel(c)}</button>`).join('')}
    </div>

    ${s.me?.isMyTurn && !s.gameOver ? '<button id="drawBtn">抽牌/结算罚抽</button>' : ''}
    ${s.settings.allowSnatch && !s.me?.isMyTurn && !s.gameOver ? '<div class="meta">可尝试点击与场上完全相同的牌进行抢出</div>' : ''}
  `;

  room.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => socket.emit('room:kick', { playerId: b.dataset.kick });
  });
  room.querySelectorAll('[data-offline]').forEach((b) => {
    b.onclick = () => socket.emit('room:removeOffline', { playerId: b.dataset.offline });
  });
  room.querySelectorAll('[data-report]').forEach((b) => {
    b.onclick = () => socket.emit('game:reportUno', { targetId: b.dataset.report });
  });

  room.querySelectorAll('[data-play]').forEach((b) => {
    b.onclick = () => {
      const card = s.me.hand.find((x) => x.id === b.dataset.play);
      let chosenColor = null;
      if (card.type === 'wild' || card.type === 'wild4') {
        chosenColor = prompt('选择颜色: red/green/blue/yellow', 'red');
      }
      if (s.me.isMyTurn) {
        socket.emit('game:play', { cardId: card.id, chosenColor });
      } else if (s.settings.allowSnatch) {
        socket.emit('game:snatch', { cardId: card.id, chosenColor });
      }
    };
  });

  document.getElementById('drawBtn')?.addEventListener('click', () => socket.emit('game:draw'));
  document.getElementById('startGame')?.addEventListener('click', () => socket.emit('game:start'));
  document.getElementById('unoBtn')?.addEventListener('click', () => socket.emit('game:uno'));
  document.getElementById('rematchBtn')?.addEventListener('click', () => socket.emit('game:rematchVote'));
  document.getElementById('toggleLock')?.addEventListener('click', () => socket.emit('room:lock', { locked: !s.locked }));
  document.getElementById('backLobby')?.addEventListener('click', () => location.reload());
}

document.getElementById('enterBtn').onclick = () => {
  const name = document.getElementById('nameInput').value.trim() || '玩家';
  socket.emit('lobby:hello', { name });
};

document.getElementById('createRoomBtn').onclick = () => {
  socket.emit('room:create', {
    roomName: document.getElementById('roomName').value.trim() || 'UNO房间',
    settings: {
      allowStackDraw: document.getElementById('allowStackDraw').checked,
      allowSameColorAll: document.getElementById('allowSameColorAll').checked,
      allowSnatch: document.getElementById('allowSnatch').checked,
      maxPlayers: Number(document.getElementById('maxPlayers').value || 4)
    }
  });
};

socket.on('player:ready', ({ playerId }) => {
  myId = playerId;
  auth.classList.add('hidden');
  lobby.classList.remove('hidden');
});

socket.on('lobby:update', renderLobby);
socket.on('room:update', renderRoom);
socket.on('room:left', () => {
  toast('你已离开房间');
  setTimeout(() => location.reload(), 1000);
});
socket.on('toast', (t) => toast(t.message));
