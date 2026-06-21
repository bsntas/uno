class UnoApp {
  constructor() {
    this.peer = null;
    this.myId = null;
    this.myName = '';
    this.isHost = false;
    this.connections = new Map();
    this.hostConn = null;
    this.room = null;
    this.publicState = null;
    this.myHand = [];
    this.drawnCardIndex = null;
    this.pendingWild = null;
    this._toastTimer = null;

    this.bindUI();
  }

  // ─── Utilities ───────────────────────────────────────────────

  genCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
  }

  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
  }

  showToast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show toast-' + type;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ─── PeerJS helpers ──────────────────────────────────────────

  makePeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id) : new Peer();
      const t = setTimeout(() => { peer.destroy(); reject(new Error('Timeout')); }, 12000);
      peer.on('open', () => { clearTimeout(t); resolve(peer); });
      peer.on('error', err => { clearTimeout(t); reject(err); });
    });
  }

  // ─── Host flow ───────────────────────────────────────────────

  async createGame() {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { this.showToast('Enter your name', 'error'); return; }

    document.getElementById('btn-create').disabled = true;
    document.getElementById('btn-create').textContent = 'Connecting…';

    const code = this.genCode();
    try {
      this.peer = await this.makePeer(code);
    } catch (e) {
      this.showToast('Could not create room: ' + e.message, 'error');
      document.getElementById('btn-create').disabled = false;
      document.getElementById('btn-create').textContent = 'Create Game';
      return;
    }

    this.myId = code;
    this.myName = name;
    this.isHost = true;
    this.room = new GameRoom();
    this.room.addPlayer(this.myId, this.myName);

    this.peer.on('connection', conn => {
      conn.on('open', () => {
        conn.on('data', data => this.onGuestData(conn, data));
        conn.on('close', () => this.onGuestDisconnect(conn));
        conn.on('error', () => this.onGuestDisconnect(conn));
      });
    });

    this.showScreen('lobby');
    document.getElementById('room-code-display').textContent = code;
    document.getElementById('btn-start').style.display = '';
    document.getElementById('waiting-text').style.display = 'none';
    this.renderLobbyPlayers();
  }

  // ─── Guest flow ──────────────────────────────────────────────

  async joinGame() {
    const name = document.getElementById('player-name').value.trim();
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!name) { this.showToast('Enter your name', 'error'); return; }
    if (!code) { this.showToast('Enter a room code', 'error'); return; }

    document.getElementById('btn-join').disabled = true;
    document.getElementById('btn-join').textContent = 'Connecting…';

    try {
      this.peer = await this.makePeer(null);
    } catch (e) {
      this.showToast('Connection failed: ' + e.message, 'error');
      document.getElementById('btn-join').disabled = false;
      document.getElementById('btn-join').textContent = 'Join Game';
      return;
    }

    this.myId = this.peer.id;
    this.myName = name;
    this.isHost = false;

    const conn = this.peer.connect(code, { reliable: true });
    this.hostConn = conn;

    const joinTimeout = setTimeout(() => {
      this.showToast('Could not find room "' + code + '"', 'error');
      document.getElementById('btn-join').disabled = false;
      document.getElementById('btn-join').textContent = 'Join Game';
    }, 8000);

    conn.on('open', () => {
      clearTimeout(joinTimeout);
      conn.send({ type: 'join', name });
    });

    conn.on('data', data => this.onHostData(data, code));

    conn.on('close', () => {
      if (this.publicState?.phase !== 'game_over') {
        this.showToast('Disconnected from host', 'error');
        setTimeout(() => location.reload(), 2000);
      }
    });

    conn.on('error', err => {
      clearTimeout(joinTimeout);
      this.showToast('Connection error: ' + (err.message || err), 'error');
      document.getElementById('btn-join').disabled = false;
      document.getElementById('btn-join').textContent = 'Join Game';
    });
  }

  // ─── Host: handle guest messages ─────────────────────────────

  onGuestData(conn, data) {
    if (data.type === 'join') {
      const result = this.room.addPlayer(conn.peer, data.name);
      if (result.error) {
        conn.send({ type: 'error', message: result.error });
        return;
      }
      this.connections.set(conn.peer, conn);
      conn.send({ type: 'joined', roomCode: this.myId });
      this.broadcastState();
      this.renderLobbyPlayers();
      return;
    }
    if (data.type === 'action') {
      this.processAction(conn.peer, data);
    }
  }

  onGuestDisconnect(conn) {
    const id = conn.peer;
    this.connections.delete(id);
    const player = this.room.players.find(p => p.id === id);
    const playerName = player?.name || 'A player';

    if (this.room.phase === 'lobby') {
      this.room.removePlayer(id);
      this.renderLobbyPlayers();
      this.broadcastState();
    } else {
      this.showToast(playerName + ' disconnected', 'error');
      this.room.removePlayer(id);
      if (this.room.players.length < 2) {
        this.room.phase = 'game_over';
        this.room.winner = { id: this.myId, name: this.myName };
        this.room.lastAction = playerName + ' left the game';
      }
      this.broadcastState();
    }
  }

  // ─── Guest: handle host messages ─────────────────────────────

  onHostData(data, roomCode) {
    if (data.type === 'joined') {
      this.showScreen('lobby');
      document.getElementById('room-code-display').textContent = data.roomCode || roomCode;
      document.getElementById('btn-start').style.display = 'none';
      document.getElementById('waiting-text').style.display = '';
    }
    if (data.type === 'state') {
      this.publicState = data.public;
      this.myHand = data.hand;
      this.drawnCardIndex = data.drawnCardIndex ?? null;
      this.render();
    }
    if (data.type === 'error') {
      this.showToast(data.message, 'error');
    }
  }

  // ─── Action processing (host only) ──────────────────────────

  processAction(playerId, data) {
    let result;
    switch (data.action) {
      case 'play_card':
        result = this.room.playCard(playerId, data.cardIndex, data.chosenColor);
        break;
      case 'draw_card':
        result = this.room.drawCards(playerId);
        break;
      case 'pass_turn':
        result = this.room.passTurn(playerId);
        break;
      case 'call_uno':
        result = this.room.callUno(playerId);
        break;
    }
    if (result?.error) {
      const conn = this.connections.get(playerId);
      if (conn) conn.send({ type: 'error', message: result.error });
      // Also show to self if it's the host
      if (playerId === this.myId) this.showToast(result.error, 'error');
      return;
    }
    this.broadcastState();
  }

  broadcastState() {
    const pub = this.room.getPublicState();
    const myPriv = this.room.getPrivateData(this.myId);
    this.publicState = pub;
    this.myHand = myPriv.hand;
    this.drawnCardIndex = myPriv.drawnCardIndex;

    for (const player of this.room.players) {
      if (player.id === this.myId) continue;
      const conn = this.connections.get(player.id);
      if (!conn) continue;
      const priv = this.room.getPrivateData(player.id);
      conn.send({ type: 'state', public: pub, hand: priv.hand, drawnCardIndex: priv.drawnCardIndex });
    }
    this.render();
  }

  sendAction(action) {
    if (this.isHost) {
      this.processAction(this.myId, action);
    } else if (this.hostConn?.open) {
      this.hostConn.send({ type: 'action', ...action });
    }
  }

  // ─── Game actions ────────────────────────────────────────────

  startGame() {
    if (!this.isHost) return;
    const result = this.room.startGame();
    if (result.error) { this.showToast(result.error, 'error'); return; }
    this.broadcastState();
  }

  onCardClick(cardIndex) {
    const card = this.myHand[cardIndex];
    if (!card) return;
    if (card.type === 'wild' || card.type === 'wild4') {
      this.pendingWild = { cardIndex };
      document.getElementById('modal-color').classList.add('visible');
      return;
    }
    this.sendAction({ action: 'play_card', cardIndex, chosenColor: null });
  }

  playWild(color) {
    if (!this.pendingWild) return;
    const { cardIndex } = this.pendingWild;
    this.pendingWild = null;
    document.getElementById('modal-color').classList.remove('visible');
    this.sendAction({ action: 'play_card', cardIndex, chosenColor: color });
  }

  playAgain() {
    document.getElementById('modal-gameover').classList.remove('visible');
    if (this.isHost) {
      this.room.resetToLobby();
      this.broadcastState();
    }
    // Guests will receive lobby state and render() will switch screen
  }

  // ─── Rendering ───────────────────────────────────────────────

  render() {
    if (!this.publicState) return;
    const { phase } = this.publicState;

    if (phase === 'lobby') {
      this.showScreen('lobby');
      this.renderLobbyPlayers();
      return;
    }

    this.showScreen('game');
    this.renderGame();

    if (phase === 'game_over') {
      this.showGameOver();
    }
  }

  renderLobbyPlayers() {
    const players = this.isHost
      ? this.room.players
      : (this.publicState?.players || []);

    document.getElementById('player-list').innerHTML = players.map((p, i) => `
      <div class="lobby-player">
        <div class="player-avatar-badge">${p.name[0].toUpperCase()}</div>
        <span class="lobby-player-name">${escHtml(p.name)}</span>
        ${i === 0 ? '<span class="host-chip">HOST</span>' : ''}
      </div>`).join('');

    document.getElementById('player-count').textContent =
      `${players.length} / 6 players`;

    if (this.isHost) {
      document.getElementById('btn-start').textContent =
        players.length >= 2 ? 'Start Game' : 'Waiting for players…';
      document.getElementById('btn-start').disabled = players.length < 2;
    }
  }

  renderGame() {
    const st = this.publicState;
    const myIdx = st.players.findIndex(p => p.id === this.myId);
    const isMyTurn = st.currentPlayerIndex === myIdx;
    const myData = st.players[myIdx];
    const curName = st.players[st.currentPlayerIndex]?.name || '';

    // Direction & color
    document.getElementById('dir-arrow').textContent = st.direction === 1 ? '⟳' : '⟲';
    document.getElementById('dir-label').textContent = st.direction === 1 ? 'Clockwise' : 'Counter-CW';
    document.getElementById('color-dot').className = 'color-dot dot-' + st.currentColor;
    document.getElementById('color-label').textContent = (st.currentColor || '').charAt(0).toUpperCase() + (st.currentColor || '').slice(1);
    document.getElementById('last-action').textContent = st.lastAction;

    // Pending draw banner
    const banner = document.getElementById('pending-banner');
    if (st.pendingDraw > 0 && isMyTurn) {
      banner.textContent = `⚠️  Stack a draw card — or draw ${st.pendingDraw} cards!`;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }

    // Turn indicator
    const turnEl = document.getElementById('turn-indicator');
    turnEl.textContent = isMyTurn ? '✨ Your Turn!' : `${curName}'s Turn`;
    turnEl.className = 'turn-indicator' + (isMyTurn ? ' my-turn' : '');

    // Discard pile
    const discardEl = document.getElementById('discard-top');
    if (st.topCard) {
      discardEl.innerHTML = this.cardHTML(st.topCard, {
        interactive: false,
        overrideColor: st.currentColor,
      });
    }

    // Draw pile count
    document.getElementById('deck-count').textContent = st.deckCount;

    // Opponents
    this.renderOpponents(st, myIdx);

    // My hand
    this.renderHand(st, isMyTurn);

    // Buttons
    const btnDraw = document.getElementById('btn-draw');
    const btnPass = document.getElementById('btn-pass');
    const btnUno = document.getElementById('btn-uno');

    btnDraw.style.display = (isMyTurn && !st.waitingForPass) ? '' : 'none';
    btnDraw.textContent = st.pendingDraw > 0 ? `Draw ${st.pendingDraw} cards` : 'Draw Card';

    btnPass.style.display = (isMyTurn && st.waitingForPass) ? '' : 'none';

    if (myData && myData.cardCount === 1) {
      btnUno.style.display = '';
      btnUno.className = 'btn-uno' + (myData.calledUno ? ' called' : '');
    } else {
      btnUno.style.display = 'none';
    }
  }

  renderOpponents(st, myIdx) {
    const ops = st.players
      .map((p, i) => ({ ...p, globalIndex: i }))
      .filter(p => p.globalIndex !== myIdx);

    document.getElementById('opponents-area').innerHTML = ops.map(p => {
      const isCurrent = p.globalIndex === st.currentPlayerIndex;
      const shown = Math.min(p.cardCount, 7);
      const cards = Array.from({ length: shown }, () =>
        `<div class="card card-back card-sm"></div>`).join('');
      const extra = p.cardCount > 7 ? `<span class="extra-badge">+${p.cardCount - 7}</span>` : '';

      return `
        <div class="opponent-slot${isCurrent ? ' active-player' : ''}">
          <div class="opp-header">
            <div class="opp-avatar">${p.name[0].toUpperCase()}</div>
            <div class="opp-info">
              <span class="opp-name">${escHtml(p.name)}</span>
              <span class="opp-count">${p.cardCount} card${p.cardCount !== 1 ? 's' : ''}</span>
            </div>
            ${p.calledUno ? '<span class="uno-chip">UNO!</span>' : ''}
            ${isCurrent ? '<span class="turn-chip">▼ Playing</span>' : ''}
          </div>
          <div class="opp-cards">${cards}${extra}</div>
        </div>`;
    }).join('');
  }

  renderHand(st, isMyTurn) {
    const el = document.getElementById('my-hand');
    el.innerHTML = this.myHand.map((card, i) => {
      const playable = isMyTurn && canPlay(card, st.topCard, st.currentColor, st.pendingDraw);
      const restricted = this.drawnCardIndex !== null && i !== this.drawnCardIndex;
      const isDrawn = this.drawnCardIndex === i;
      return this.cardHTML(card, {
        index: i,
        playable: playable && !restricted,
        dimmed: isMyTurn && !playable,
        isDrawn,
      });
    }).join('');

    el.querySelectorAll('.card[data-index]').forEach(el => {
      const i = parseInt(el.dataset.index);
      if (el.classList.contains('playable')) {
        el.addEventListener('click', () => this.onCardClick(i));
      }
    });
  }

  cardHTML(card, opts = {}) {
    const { index = -1, playable = false, dimmed = false, isDrawn = false,
            interactive = true, overrideColor = null } = opts;
    const sym = cardSymbol(card);
    const isWild = card.type === 'wild' || card.type === 'wild4';
    const colorClass = `card-${card.color}`;

    const classes = ['card', colorClass,
      playable ? 'playable' : '',
      dimmed ? 'dimmed' : '',
      isDrawn ? 'drawn-card' : '',
    ].filter(Boolean).join(' ');

    const dataIdx = index >= 0 ? `data-index="${index}"` : '';

    // Color bar for wild cards that have a chosen color
    const colorBar = isWild && overrideColor
      ? `<div class="wild-bar bar-${overrideColor}"></div>` : '';

    return `<div class="${classes}" ${dataIdx} title="${cardName(card)}">
      ${colorBar}
      <span class="c-corner c-tl">${sym}</span>
      <div class="c-center"><span class="c-sym">${sym}</span></div>
      <span class="c-corner c-br">${sym}</span>
    </div>`;
  }

  showGameOver() {
    const st = this.publicState;
    const isWinner = st.winner?.id === this.myId;
    document.getElementById('go-title').textContent = isWinner ? '🏆 You Win!' : 'Game Over!';
    document.getElementById('go-msg').textContent = isWinner
      ? 'Amazing — you played all your cards first!'
      : `${st.winner?.name || 'Someone'} played all their cards first.`;
    document.getElementById('modal-gameover').classList.add('visible');
  }

  // ─── UI bindings ─────────────────────────────────────────────

  bindUI() {
    const $ = id => document.getElementById(id);

    $('btn-create').addEventListener('click', () => this.createGame());
    $('btn-join').addEventListener('click', () => this.joinGame());

    $('player-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const code = $('room-code-input').value.trim();
        if (code) this.joinGame(); else this.createGame();
      }
    });
    $('room-code-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.joinGame();
    });

    $('btn-copy').addEventListener('click', () => {
      const code = $('room-code-display').textContent;
      navigator.clipboard.writeText(code)
        .then(() => this.showToast('Room code copied!'))
        .catch(() => this.showToast('Code: ' + code));
    });

    $('btn-start').addEventListener('click', () => this.startGame());

    $('btn-draw').addEventListener('click', () => this.sendAction({ action: 'draw_card' }));
    $('btn-pass').addEventListener('click', () => this.sendAction({ action: 'pass_turn' }));
    $('btn-uno').addEventListener('click', () => this.sendAction({ action: 'call_uno' }));

    document.querySelectorAll('.color-choice').forEach(btn => {
      btn.addEventListener('click', () => this.playWild(btn.dataset.color));
    });

    $('modal-color').addEventListener('click', e => {
      if (e.target === $('modal-color')) {
        $('modal-color').classList.remove('visible');
        this.pendingWild = null;
      }
    });

    $('btn-play-again').addEventListener('click', () => this.playAgain());
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', () => { window.app = new UnoApp(); });
