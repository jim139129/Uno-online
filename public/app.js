const hasSocketIo = typeof window.io === 'function';
const socket = hasSocketIo
  ? io()
  : {
      emit: () => {},
      on: () => {}
    };

let myId = null;

const auth = document.getElementById('auth');
const lobby = document.getElementById('lobby');
const room = document.getElementById('room');

const COLORS = ['red', 'green', 'blue', 'yellow'];

function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function cardFace(card) {
  if (card.type === 'number') return String(card.value);
  if (card.type === 'draw2') return '+2';
  if (card.type === 'wild4') return '+4';
  if (card.type === 'wild') return 'W';
  if (card.type === 'reverse') return '⟲';
  if (card.type === 'skip') return '⦸';
  return '?';
}

function colorClass(color) {
  return COLORS.includes(color) ? color : 'wild';
}

function createCardButton(card, disabled = false) {
  return `<button class="card-btn ${disabled ? 'disabled' : ''}" data-play="${card.id}">
      <div class="uno-card ${colorClass(card.color)}">
        <div class="tl">${cardFace(card)}</div>
        <div class="center">${cardFace(card)}</div>
        <div class="br">${cardFace(card)}</div>
      </div>
    </button>`;
}

function showColorPicker(onPick) {
  const mask = document.createElement('div');
  mask.className = 'color-picker-mask';
  mask.innerHTML = `
    <div class="color-picker-dialog">
      <h3>选择颜色</h3>
      <div class="color-picker-grid">
        ${COLORS.map((c) => `<button class="pick-color-btn ${c}" data-color="${c}">${c}</button>`).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  mask.querySelectorAll('[data-color]').forEach((btn) => {
    btn.onclick = () => {
      const picked = btn.dataset.color;
      mask.remove();
      onPick(picked);
    };
  });
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

function renderOrderList(s) {
  const arrow = s.direction === 1 ? '↓' : '↑';
  return s.players
    .map((p, i) => {
      const cls = [
        'player-node',
        p.id === s.currentPlayerId ? 'current' : '',
        p.id === myId ? 'me' : '',
        p.connected ? '' : 'offline'
      ]
        .filter(Boolean)
        .join(' ');

      const controls = [
        s.hostId === myId && p.id !== s.hostId ? `<button data-kick="${p.id}">移除</button>` : '',
        s.hostId === myId && !p.connected ? `<button data-offline="${p.id}">移除掉线</button>` : '',
        s.canReportUnoTargets.includes(p.id) ? `<button data-report="${p.id}">举报UNO</button>` : ''
      ]
        .filter(Boolean)
        .join('');

      return `${
        i > 0 ? `<div class="dir-arrow">${arrow}</div>` : ''
      }<div class="${cls}">
        <div>
          <div class="player-name">${p.name} ${p.id === s.hostId ? '👑' : ''} ${p.id === myId ? '(你)' : ''}</div>
          <div class="player-meta">手牌 ${p.handCount} 张 ${p.unoDeclared ? '· UNO!' : ''} ${!p.connected ? '· 掉线' : ''}</div>
        </div>
        <div>${controls}</div>
      </div>`;
    })
    .join('');
}

function renderRoom(s) {
  room.classList.remove('hidden');
  lobby.classList.add('hidden');

  const isHost = s.hostId === myId;
  const me = s.me || { hand: [], isMyTurn: false };
  const currentName = s.players.find((p) => p.id === s.currentPlayerId)?.name || '-';

  const handHtml = me.hand
    .map((c) => {
      const disableWild4 = !me.isMyTurn && c.type === 'wild4';
      return createCardButton(c, disableWild4);
    })
    .join('');

  room.innerHTML = `
    <h2>房间：${s.name}</h2>
    <div class="meta-chip">规则：叠加${s.settings.allowStackDraw ? '开' : '关'} · 同色全出${s.settings.allowSameColorAll ? '开' : '关'} · 抢出${s.settings.allowSnatch ? '开' : '关'} · 最大${s.settings.maxPlayers}人</div>

    <div class="game-layout">
      <aside class="turn-order">
        <h3>出牌顺序</h3>
        <div class="meta-chip">方向：${s.direction === 1 ? '顺时针（↓）' : '逆时针（↑）'}</div>
        <div class="order-list">${renderOrderList(s)}</div>
      </aside>

      <section class="center-board">
        <div class="turn-banner ${me.isMyTurn ? 'me' : 'other'}">
          ${s.gameOver ? '本局已结束' : me.isMyTurn ? '🎯 到你出牌！请尽快行动' : `当前轮到：${currentName}`}
        </div>

        <div class="top-zone">
          <div>
            ${s.topCard ? `<div class="uno-card ${colorClass(s.topCard.color)}"><div class="tl">${cardFace(
              s.topCard
            )}</div><div class="center">${cardFace(s.topCard)}</div><div class="br">${cardFace(s.topCard)}</div></div>` : ''}
          </div>
          <div>
            <div class="meta-chip">当前颜色：${s.chosenColor || '-'}</div>
            <div class="meta-chip">待抽叠加：${s.pendingDraw}</div>
            <div class="meta-chip">当前玩家：${currentName}</div>
          </div>
        </div>

        <div class="row">
          ${isHost && !s.gameStarted ? '<button id="startGame">开始游戏</button>' : ''}
          ${isHost ? `<button id="toggleLock">${s.locked ? '解锁房间' : '锁定房间'}</button>` : ''}
          ${me.hand.length === 1 ? '<button id="unoBtn">喊 UNO</button>' : ''}
          ${s.gameOver ? '<button id="rematchBtn">再来一局</button>' : ''}
          ${s.canChallengeWild4 ? '<button id="challengeWild4Btn">质疑 +4</button>' : ''}
          ${me.isMyTurn && !s.gameOver ? '<button id="drawBtn">抽牌 / 结算罚抽</button>' : ''}
          <button id="backLobby">返回大厅</button>
        </div>

        ${s.gameOver ? `<h3>排行榜</h3><ol>${s.ranking
          .map((r) => `<li>${r.name}（剩余 ${r.cardsLeft}）</li>`)
          .join('')}</ol>` : ''}

        <h3>你的手牌</h3>
        <div class="hand">${handHtml}</div>
        ${s.settings.allowSnatch && !me.isMyTurn && !s.gameOver ? '<div class="player-meta">提示：非你回合时，可点击“与场上完全相同”的牌抢出。</div>' : ''}
      </section>
    </div>
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
      const card = me.hand.find((x) => x.id === b.dataset.play);
      if (!card) return;

      if (!me.isMyTurn && card.type === 'wild4') {
        toast('+4 只能在自己的回合打出。');
        return;
      }

      const emitPlay = (chosenColor = null) => {
        if (me.isMyTurn) {
          socket.emit('game:play', { cardId: card.id, chosenColor });
        } else if (s.settings.allowSnatch) {
          socket.emit('game:snatch', { cardId: card.id, chosenColor });
        }
      };

      if (card.type === 'wild' || card.type === 'wild4') {
        showColorPicker((pickedColor) => emitPlay(pickedColor));
        return;
      }

      emitPlay();
    };
  });

  document.getElementById('drawBtn')?.addEventListener('click', () => socket.emit('game:draw'));
  document.getElementById('challengeWild4Btn')?.addEventListener('click', () => socket.emit('game:challengeWild4'));
  document.getElementById('startGame')?.addEventListener('click', () => socket.emit('game:start'));
  document.getElementById('unoBtn')?.addEventListener('click', () => socket.emit('game:uno'));
  document.getElementById('rematchBtn')?.addEventListener('click', () => socket.emit('game:rematchVote'));
  document.getElementById('toggleLock')?.addEventListener('click', () => socket.emit('room:lock', { locked: !s.locked }));
  document.getElementById('backLobby')?.addEventListener('click', () => location.reload());
}

function bootstrapPreviewMode() {
  const params = new URLSearchParams(location.search);
  if (!params.get('preview')) return;
  auth.classList.add('hidden');
  lobby.classList.add('hidden');
  myId = 'p2';
  renderRoom({
    id: 'demo',
    name: 'UI 预览房间',
    locked: false,
    hostId: 'p1',
    settings: { allowStackDraw: true, allowSameColorAll: true, allowSnatch: true, maxPlayers: 6 },
    gameStarted: true,
    gameOver: false,
    players: [
      { id: 'p1', name: '房主A', connected: true, handCount: 3, unoDeclared: false },
      { id: 'p2', name: '你', connected: true, handCount: 6, unoDeclared: false },
      { id: 'p3', name: '玩家C', connected: true, handCount: 1, unoDeclared: false },
      { id: 'p4', name: '玩家D', connected: false, handCount: 4, unoDeclared: false }
    ],
    me: {
      id: 'p2',
      hand: [
        { id: 'c1', color: 'red', type: 'number', value: 7 },
        { id: 'c2', color: 'yellow', type: 'skip' },
        { id: 'c3', color: 'blue', type: 'reverse' },
        { id: 'c4', color: 'wild', type: 'wild' },
        { id: 'c5', color: 'green', type: 'draw2' },
        { id: 'c6', color: 'wild', type: 'wild4' }
      ],
      isMyTurn: true,
      unoDeclared: false
    },
    topCard: { id: 't1', color: 'yellow', type: 'number', value: 7 },
    chosenColor: 'yellow',
    direction: 1,
    currentPlayerId: 'p2',
    pendingDraw: 2,
    ranking: [],
    canReportUnoTargets: ['p3']
  });
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
  setTimeout(() => location.reload(), 800);
});
socket.on('toast', (t) => toast(t.message));

bootstrapPreviewMode();
if (!hasSocketIo) {
  toast('未连接到 Socket.IO，当前可用 ?preview=1 预览界面');
}
