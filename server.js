const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = new Map();
const socketToPlayer = new Map();
const disconnectTimers = new Map();

const COLORS = ['red', 'green', 'blue', 'yellow'];

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ id: uid('c'), color, type: 'number', value: 0 });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: uid('c'), color, type: 'number', value: n });
      deck.push({ id: uid('c'), color, type: 'number', value: n });
    }
    ['skip', 'reverse', 'draw2'].forEach((type) => {
      deck.push({ id: uid('c'), color, type });
      deck.push({ id: uid('c'), color, type });
    });
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: uid('c'), color: 'wild', type: 'wild' });
    deck.push({ id: uid('c'), color: 'wild', type: 'wild4' });
  }
  return shuffle(deck);
}

function cardEq(a, b) {
  return a.color === b.color && a.type === b.type && a.value === b.value;
}

function canPlay(card, top, chosenColor, room, player) {
  if (!top) return true;
  if (room.state.pendingDraw > 0) {
    if (!room.settings.allowStackDraw) return false;
    if (room.state.pendingType === 'draw2') return card.type === 'draw2';
    if (room.state.pendingType === 'wild4') return card.type === 'wild4';
    return false;
  }
  const activeColor = top.type.startsWith('wild') ? chosenColor : top.color;
  if (card.type === 'wild' || card.type === 'wild4') return true;
  if (card.color === activeColor) return true;
  if (card.type === top.type && card.type !== 'number') return true;
  if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
  return false;
}

function sanitizeRoom(room, playerId) {
  const me = room.players.find((p) => p.id === playerId);
  const canChallengeWild4 =
    room.state.wild4Challenge &&
    room.state.wild4Challenge.targetId === playerId &&
    room.players[room.state.currentIndex]?.id === playerId;
  return {
    id: room.id,
    name: room.name,
    locked: room.locked,
    hostId: room.hostId,
    settings: room.settings,
    gameStarted: room.gameStarted,
    gameOver: room.state.gameOver,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      handCount: p.hand.length,
      unoDeclared: p.unoDeclared,
      isHost: p.id === room.hostId,
      finished: room.state.finishedIds.includes(p.id)
    })),
    me: me
      ? {
          id: me.id,
          hand: me.hand,
          isMyTurn: room.gameStarted && room.players[room.state.currentIndex]?.id === me.id,
          unoDeclared: me.unoDeclared
        }
      : null,
    topCard: room.state.discard[room.state.discard.length - 1] || null,
    chosenColor: room.state.chosenColor,
    direction: room.state.direction,
    currentPlayerId: room.gameStarted ? room.players[room.state.currentIndex]?.id : null,
    pendingDraw: room.state.pendingDraw,
    pendingType: room.state.pendingType,
    canChallengeWild4,
    finishedOrder: room.state.finishedOrder,
    ranking: room.state.ranking,
    canReportUnoTargets: room.players
      .filter((p) => p.id !== playerId && p.hand.length === 1 && !p.unoDeclared)
      .map((p) => p.id)
  };
}

function broadcastLobby() {
  io.emit('lobby:update', {
    onlineCount: [...socketToPlayer.values()].filter((v, i, arr) => arr.findIndex((x) => x.playerId === v.playerId) === i).length,
    rooms: [...rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      players: r.players.length,
      maxPlayers: r.settings.maxPlayers,
      locked: r.locked,
      gameStarted: r.gameStarted
    }))
  });
}

function emitRoom(room) {
  room.players.forEach((p) => {
    io.to(p.socketId).emit('room:update', sanitizeRoom(room, p.id));
  });
  broadcastLobby();
}

function refillDeck(room) {
  if (room.state.deck.length > 0) return;
  const top = room.state.discard.pop();
  room.state.deck = shuffle(room.state.discard);
  room.state.discard = [top];
}

function drawCards(room, player, n) {
  const cards = [];
  for (let i = 0; i < n; i++) {
    refillDeck(room);
    const c = room.state.deck.pop();
    if (!c) break;
    player.hand.push(c);
    cards.push(c);
  }
  if (player.hand.length !== 1) player.unoDeclared = false;
  return cards;
}

function getStep(room, count = 1) {
  return ((room.state.direction * count) % room.players.length + room.players.length) % room.players.length;
}

function advanceTurn(room, step = 1, fromPlayerId = null) {
  if (room.players.length === 0) return;
  let base = room.state.currentIndex;
  if (fromPlayerId) {
    base = room.players.findIndex((p) => p.id === fromPlayerId);
    if (base < 0) base = room.state.currentIndex;
  }
  room.state.currentIndex = (base + getStep(room, step)) % room.players.length;
}

function endGame(room, winnerId) {
  room.state.gameOver = true;
  const winner = room.players.find((p) => p.id === winnerId);
  const others = room.players
    .filter((p) => p.id !== winnerId)
    .sort((a, b) => a.hand.length - b.hand.length)
    .map((p) => ({ playerId: p.id, name: p.name, cardsLeft: p.hand.length }));
  room.state.ranking = [{ playerId: winner.id, name: winner.name, cardsLeft: 0 }, ...others];
  room.state.rematchVotes = {};
}

function applyCard(room, player, card, chosenColor) {
  const topBeforePlay = room.state.discard[room.state.discard.length - 1];
  const activeColorBeforePlay = topBeforePlay?.type?.startsWith('wild')
    ? room.state.chosenColor
    : topBeforePlay?.color;
  const hadMatchingColorBeforeWild4 =
    card.type === 'wild4' &&
    player.hand.some((c) => c.color === activeColorBeforePlay && c.type !== 'wild4');

  room.state.wild4Challenge = null;
  room.state.discard.push(card);
  room.state.chosenColor = card.type.startsWith('wild') ? chosenColor : card.color;

  if (card.type === 'draw2') {
    room.state.pendingDraw += 2;
    room.state.pendingType = 'draw2';
  } else if (card.type === 'wild4') {
    room.state.pendingDraw += 4;
    room.state.pendingType = 'wild4';
    room.state.wild4Challenge = {
      sourcePlayerId: player.id,
      targetId: room.players[(room.players.findIndex((p) => p.id === player.id) + getStep(room, 1)) % room.players.length]?.id,
      wasIllegal: hadMatchingColorBeforeWild4
    };
  }

  if (card.type === 'reverse') {
    room.state.direction *= -1;
  }

  let step = 1;
  if (card.type === 'skip') step = 2;
  if (card.type === 'reverse' && room.players.length === 2) step = 2;

  const shouldAutoSameColor =
    room.settings.allowSameColorAll && card.color !== 'wild' && !room.state.gameOver;
  if (shouldAutoSameColor) {
    const sameColor = player.hand.filter((c) => c.color === card.color);
    sameColor.forEach((c) => {
      player.hand = player.hand.filter((x) => x.id !== c.id);
      room.state.discard.push(c);
      room.state.chosenColor = c.color;
    });
  }

  if (player.hand.length === 0) {
    endGame(room, player.id);
    return;
  }

  advanceTurn(room, step, player.id);
}

function startGame(room) {
  room.gameStarted = true;
  room.state = {
    deck: createDeck(),
    discard: [],
    currentIndex: 0,
    direction: 1,
    chosenColor: null,
    pendingDraw: 0,
    pendingType: null,
    wild4Challenge: null,
    gameOver: false,
    finishedOrder: [],
    finishedIds: [],
    ranking: [],
    rematchVotes: {}
  };

  room.players.forEach((p) => {
    p.hand = [];
    p.unoDeclared = false;
    for (let i = 0; i < 7; i++) {
      p.hand.push(room.state.deck.pop());
    }
  });

  let first = room.state.deck.pop();
  while (first.type === 'wild4') {
    room.state.deck.unshift(first);
    room.state.deck = shuffle(room.state.deck);
    first = room.state.deck.pop();
  }
  room.state.discard.push(first);
  room.state.chosenColor = first.color === 'wild' ? COLORS[0] : first.color;
}

function createRoom(name, hostPlayer, settings) {
  const room = {
    id: uid('room'),
    name: name || 'UNO房间',
    hostId: hostPlayer.id,
    locked: false,
    gameStarted: false,
    settings: {
      allowStackDraw: !!settings.allowStackDraw,
      allowSameColorAll: !!settings.allowSameColorAll,
      allowSnatch: !!settings.allowSnatch,
      maxPlayers: Math.max(2, Math.min(8, Number(settings.maxPlayers) || 4))
    },
    players: [hostPlayer],
    state: {
      deck: [],
      discard: [],
      currentIndex: 0,
      direction: 1,
      chosenColor: null,
      pendingDraw: 0,
      pendingType: null,
      wild4Challenge: null,
      gameOver: false,
      finishedOrder: [],
      finishedIds: [],
      ranking: [],
      rematchVotes: {}
    }
  };
  rooms.set(room.id, room);
  return room;
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players = room.players.filter((p) => p.connected);
  if (room.players.length === 0) {
    rooms.delete(roomId);
    broadcastLobby();
    return;
  }
  if (!room.players.find((p) => p.id === room.hostId)) {
    room.hostId = room.players[0].id;
  }
  if (room.state.currentIndex >= room.players.length) {
    room.state.currentIndex = 0;
  }
  emitRoom(room);
}

io.on('connection', (socket) => {
  socket.on('lobby:hello', ({ name }) => {
    const playerId = uid('player');
    socketToPlayer.set(socket.id, { playerId, name: (name || '玩家').slice(0, 16), roomId: null });
    io.to(socket.id).emit('player:ready', { playerId });
    broadcastLobby();
  });

  socket.on('room:create', ({ roomName, settings }) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const host = {
      id: info.playerId,
      name: info.name,
      socketId: socket.id,
      connected: true,
      hand: [],
      unoDeclared: false
    };
    const room = createRoom(roomName, host, settings || {});
    info.roomId = room.id;
    socket.join(room.id);
    emitRoom(room);
  });

  socket.on('room:join', ({ roomId }) => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(roomId);
    if (!info || !room) return;
    if (room.locked || room.players.length >= room.settings.maxPlayers || room.gameStarted) {
      io.to(socket.id).emit('toast', { type: 'error', message: '房间不可加入（已锁定/已满/已开局）' });
      return;
    }
    room.players.push({
      id: info.playerId,
      name: info.name,
      socketId: socket.id,
      connected: true,
      hand: [],
      unoDeclared: false
    });
    info.roomId = roomId;
    socket.join(roomId);
    emitRoom(room);
  });

  socket.on('room:lock', ({ locked }) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room || room.hostId !== info.playerId) return;
    room.locked = !!locked;
    emitRoom(room);
  });

  socket.on('room:kick', ({ playerId }) => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || room.hostId !== info.playerId) return;
    const target = room.players.find((p) => p.id === playerId);
    if (!target || target.id === room.hostId) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    const tInfo = [...socketToPlayer.entries()].find(([, v]) => v.playerId === playerId);
    if (tInfo) {
      tInfo[1].roomId = null;
      io.to(tInfo[0]).emit('toast', { type: 'error', message: '你已被房主移出房间。' });
      io.to(tInfo[0]).emit('room:left');
    }
    cleanupRoomIfEmpty(room.id);
  });

  socket.on('room:removeOffline', ({ playerId }) => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || room.hostId !== info.playerId) return;
    const target = room.players.find((p) => p.id === playerId);
    if (!target || target.connected) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    cleanupRoomIfEmpty(room.id);
  });

  socket.on('game:start', () => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || room.hostId !== info.playerId) return;
    if (room.players.length < 2) return;
    startGame(room);
    emitRoom(room);
  });

  socket.on('game:play', ({ cardId, chosenColor }) => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || !room.gameStarted || room.state.gameOver) return;
    const idx = room.players.findIndex((p) => p.id === info.playerId);
    if (idx !== room.state.currentIndex) return;
    const player = room.players[idx];
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return;

    const top = room.state.discard[room.state.discard.length - 1];
    if (!canPlay(card, top, room.state.chosenColor, room, player)) return;
    if ((card.type === 'wild' || card.type === 'wild4') && !COLORS.includes(chosenColor)) return;

    player.hand = player.hand.filter((c) => c.id !== card.id);
    if (player.hand.length !== 1) player.unoDeclared = false;

    applyCard(room, player, card, chosenColor);
    emitRoom(room);
  });

  socket.on('game:draw', () => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || !room.gameStarted || room.state.gameOver) return;
    const idx = room.players.findIndex((p) => p.id === info.playerId);
    if (idx !== room.state.currentIndex) return;
    const player = room.players[idx];

    if (room.state.pendingDraw > 0) {
      drawCards(room, player, room.state.pendingDraw);
      room.state.pendingDraw = 0;
      room.state.pendingType = null;
      room.state.wild4Challenge = null;
      advanceTurn(room, 1, player.id);
    } else {
      drawCards(room, player, 1);
      advanceTurn(room, 1, player.id);
    }
    emitRoom(room);
  });

  socket.on('game:snatch', ({ cardId, chosenColor }) => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || !room.settings.allowSnatch || !room.gameStarted || room.state.gameOver) return;
    const player = room.players.find((p) => p.id === info.playerId);
    if (!player) return;
    const card = player.hand.find((c) => c.id === cardId);
    const top = room.state.discard[room.state.discard.length - 1];
    if (!card || !top || !cardEq(card, top) || card.type === 'wild4') return;
    if ((card.type === 'wild' || card.type === 'wild4') && !COLORS.includes(chosenColor)) return;

    player.hand = player.hand.filter((c) => c.id !== card.id);
    if (player.hand.length !== 1) player.unoDeclared = false;
    applyCard(room, player, card, chosenColor);
    emitRoom(room);
  });

  socket.on('game:challengeWild4', () => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || !room.gameStarted || room.state.gameOver) return;

    const challenge = room.state.wild4Challenge;
    if (!challenge || challenge.targetId !== info.playerId) return;
    if (room.players[room.state.currentIndex]?.id !== info.playerId) return;

    const source = room.players.find((p) => p.id === challenge.sourcePlayerId);
    const challenger = room.players.find((p) => p.id === challenge.targetId);
    if (!source || !challenger) return;

    if (challenge.wasIllegal) {
      drawCards(room, source, 4);
      room.state.pendingDraw = 0;
      room.state.pendingType = null;
      io.to(room.id).emit('toast', { type: 'warn', message: `${challenger.name} 质疑成功，${source.name} 罚抽4张！` });
    } else {
      drawCards(room, challenger, 6);
      room.state.pendingDraw = 0;
      room.state.pendingType = null;
      advanceTurn(room, 1, challenger.id);
      io.to(room.id).emit('toast', { type: 'warn', message: `${challenger.name} 质疑失败，罚抽6张并跳过回合。` });
    }

    room.state.wild4Challenge = null;
    emitRoom(room);
  });

  socket.on('game:uno', () => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || !room.gameStarted || room.state.gameOver) return;
    const player = room.players.find((p) => p.id === info.playerId);
    if (!player) return;
    if (player.hand.length === 1) {
      player.unoDeclared = true;
      emitRoom(room);
    }
  });

  socket.on('game:reportUno', ({ targetId }) => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || !room.gameStarted || room.state.gameOver) return;
    const target = room.players.find((p) => p.id === targetId);
    if (!target || target.id === info.playerId) return;
    if (target.hand.length === 1 && !target.unoDeclared) {
      drawCards(room, target, 2);
      io.to(room.id).emit('toast', { type: 'warn', message: `${target.name} 被举报未喊UNO，罚抽2张！` });
      emitRoom(room);
    }
  });

  socket.on('game:rematchVote', () => {
    const info = socketToPlayer.get(socket.id);
    const room = rooms.get(info?.roomId);
    if (!room || !room.state.gameOver) return;
    room.state.rematchVotes[info.playerId] = true;
    const allReady = room.players.every((p) => room.state.rematchVotes[p.id]);
    if (allReady) {
      startGame(room);
    }
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    socketToPlayer.delete(socket.id);
    const room = rooms.get(info.roomId);
    if (room) {
      const player = room.players.find((p) => p.id === info.playerId);
      if (player) player.connected = false;
      emitRoom(room);
      const timer = setTimeout(() => {
        const r = rooms.get(info.roomId);
        if (!r) return;
        r.players = r.players.filter((p) => p.id !== info.playerId);
        cleanupRoomIfEmpty(info.roomId);
      }, 30000);
      disconnectTimers.set(info.playerId, timer);
    }
    broadcastLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO server running at http://localhost:${PORT}`);
});
