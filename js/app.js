import { joinRoom, selfId } from 'https://esm.sh/trystero@0.21.0/mqtt';
import { DARK_COLORS, activeProps, canPlay, cardSymbol, cardName, GameRoom } from './uno-engine.js';

const APP_ID = 'bsntas-uno-v1';
const ROOM_CONFIG = {
  appId: APP_ID,
  brokerUrl: 'wss://broker.hivemq.com:8884/mqtt',
};

class UnoApp {
  constructor() {
    this.myName = '';
    this.isHost = false;
    this.room = null;
    this.trRoom = null;
    this.sendMsg = null;
    this.hostPeerId = null;
    this.roomCode = null;
    this.publicState = null;
    this.myHand = [];
    this.drawnCardIndex = null;
    this.pendingWild = null;
    this._toastTimer = null;
    this._hiddenAt = 0;
    this.showAllCards = false;
    this._disconnectTimers = new Map();
    this._reconnecting = false;
    this._heartbeatInterval = null;
    // Animation state tracking
    this._prevTopCardId = null;
    this._prevDirection = null;
    this._prevHandCount = -1;
    this.bindUI();
    this.setupVisibility();
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

  // ─── Host flow ───────────────────────────────────────────────

  createGame() {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { this.showToast('Enter your name', 'error'); return; }

    this.myName = name;
    this.isHost = true;

    const code = this.genCode();
    this.roomCode = code;
    this.room = new GameRoom();
    this.room.addPlayer(selfId, this.myName);

    this.trRoom = joinRoom(ROOM_CONFIG, code);
    const [sendMsg, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = sendMsg;

    // Keep MQTT alive and re-sync guests when host is backgrounded
    this._heartbeatInterval = setInterval(() => {
      if (this.trRoom && this.room) this.broadcastState();
    }, 25000);

    this.trRoom.onPeerJoin(peerId => {
      sendMsg({ type: 'host-hello', name: this.myName }, peerId);
    });

    this.trRoom.onPeerLeave(peerId => {
      const player = this.room.players.find(p => p.id === peerId);
      if (!player) return;
      const playerName = player.name;
      if (this.room.phase === 'lobby') {
        this.room.removePlayer(peerId);
        this.renderLobbyPlayers();
        this.broadcastState();
      } else {
        // Give the player 45 s to reconnect before removing them
        this.showToast(`${playerName} stepped away — waiting…`, 'warn');
        const timer = setTimeout(() => {
          this._disconnectTimers.delete(peerId);
          if (!this.room.players.find(p => p.id === peerId)) return;
          this.showToast(`${playerName} left the game`, 'error');
          this.room.removePlayer(peerId);
          if (this.room.players.length < 2) {
            this.room.phase = 'game_over';
            this.room.winner = { id: selfId, name: this.myName };
            this.room.lastAction = playerName + ' left the game';
          }
          this.broadcastState();
        }, 45000);
        this._disconnectTimers.set(peerId, timer);
      }
    });

    onMsg((data, peerId) => {
      if (!this.isHost) return;
      if (data.type === 'guest-join') {
        // Check if a disconnected player is rejoining under the same name
        const oldPeerId = [...this._disconnectTimers.keys()]
          .find(id => this.room.players.find(p => p.id === id)?.name === data.name);
        if (oldPeerId !== undefined) {
          clearTimeout(this._disconnectTimers.get(oldPeerId));
          this._disconnectTimers.delete(oldPeerId);
          const player = this.room.players.find(p => p.id === oldPeerId);
          if (player) {
            player.id = peerId;
            if (this.room.drawnCardInfo?.playerId === oldPeerId) {
              this.room.drawnCardInfo.playerId = peerId;
            }
            if (this.room.unoCallers.has(oldPeerId)) {
              this.room.unoCallers.delete(oldPeerId);
              this.room.unoCallers.add(peerId);
            }
            this.showToast(`${data.name} reconnected!`, 'success');
            this.broadcastState();
            return;
          }
        }
        const result = this.room.addPlayer(peerId, data.name);
        if (result.error) {
          sendMsg({ type: 'error', message: result.error, fatal: true }, peerId);
          return;
        }
        this.broadcastState();
        return;
      }
      if (data.type === 'action') {
        this.processAction(peerId, data);
        return;
      }
      if (data.type === 'ping') {
        this.broadcastState();
      }
    });

    this.showScreen('lobby');
    document.getElementById('room-code-display').textContent = code;
    document.getElementById('btn-start').style.display = '';
    document.getElementById('waiting-text').style.display = 'none';
    document.getElementById('flip-toggle-wrap').style.display = '';
    this.saveSession();
    this.renderLobbyPlayers();
  }

  // ─── Guest flow ──────────────────────────────────────────────

  joinGame() {
    const name = document.getElementById('player-name').value.trim();
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!name) { this.showToast('Enter your name', 'error'); return; }
    if (!code) { this.showToast('Enter a room code', 'error'); return; }

    this.myName = name;
    this.isHost = false;
    this.hostPeerId = null;

    const btnJoin = document.getElementById('btn-join');
    btnJoin.disabled = true;
    btnJoin.textContent = 'Searching…';

    this.trRoom = joinRoom(ROOM_CONFIG, code);
    const [sendMsg, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = sendMsg;

    const joinTimeout = setTimeout(() => {
      if (!this.hostPeerId) {
        this.showToast('Room "' + code + '" not found — check the code and retry', 'error');
        btnJoin.disabled = false;
        btnJoin.textContent = 'Join →';
        this.trRoom?.leave?.();
        this.trRoom = null;
      }
    }, 30000);

    this.trRoom.onPeerLeave(peerId => {
      if (peerId === this.hostPeerId && this.publicState?.phase !== 'game_over') {
        this.showToast('Connection lost — reconnecting…', 'warn');
        this._attemptReconnect();
      }
    });

    onMsg((data, peerId) => {
      if (this.isHost) return;

      if (data.type === 'host-hello' && !this.hostPeerId) {
        clearTimeout(joinTimeout);
        this.hostPeerId = peerId;
        this.roomCode = code;
        sendMsg({ type: 'guest-join', name: this.myName }, peerId);
        this.showScreen('lobby');
        document.getElementById('room-code-display').textContent = code;
        document.getElementById('btn-start').style.display = 'none';
        document.getElementById('waiting-text').style.display = '';
        document.getElementById('flip-toggle-wrap').style.display = 'none';
        btnJoin.disabled = false;
        btnJoin.textContent = 'Join →';
        this.saveSession();
        return;
      }

      if (peerId !== this.hostPeerId) return;

      if (data.type === 'state') {
        this.publicState = data.public;
        this.myHand = data.hand || [];
        this.drawnCardIndex = data.drawnCardIndex ?? null;
        this.render();
        return;
      }

      if (data.type === 'error') {
        this.showToast(data.message, 'error');
        if (data.fatal) {
          btnJoin.disabled = false;
          btnJoin.textContent = 'Join →';
          this.trRoom?.leave?.();
          this.trRoom = null;
        }
      }
    });
  }

  _attemptReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const code = this.roomCode;
    const name = this.myName;

    try { this.trRoom?.leave?.(); } catch (_) {}
    this.trRoom = null;
    this.sendMsg = null;
    this.hostPeerId = null;

    setTimeout(() => {
      this._reconnecting = false;
      document.getElementById('player-name').value = name;
      document.getElementById('room-code-input').value = code;
      this.joinGame();
    }, 2000);
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
      if (playerId === selfId) {
        this.showToast(result.error, 'error');
      } else {
        this.sendMsg({ type: 'error', message: result.error }, playerId);
      }
      return;
    }
    this.broadcastState();
  }

  broadcastState() {
    const pub = this.room.getPublicState();
    const myPriv = this.room.getPrivateData(selfId);
    this.publicState = pub;
    this.myHand = myPriv.hand;
    this.drawnCardIndex = myPriv.drawnCardIndex;

    for (const player of this.room.players) {
      if (player.id === selfId) continue;
      const priv = this.room.getPrivateData(player.id);
      this.sendMsg({
        type: 'state',
        public: pub,
        hand: priv.hand,
        drawnCardIndex: priv.drawnCardIndex,
      }, player.id);
    }
    this.render();
  }

  sendAction(action) {
    if (this.isHost) {
      this.processAction(selfId, action);
    } else if (this.hostPeerId && this.sendMsg) {
      this.sendMsg({ type: 'action', ...action }, this.hostPeerId);
    }
  }

  // ─── Game actions ────────────────────────────────────────────

  startGame() {
    if (!this.isHost) return;
    // Apply flip mode setting before starting
    const flipToggle = document.getElementById('flip-mode-toggle');
    this.room.setFlipMode(flipToggle?.checked || false);
    const result = this.room.startGame();
    if (result.error) { this.showToast(result.error, 'error'); return; }
    this.broadcastState();
  }

  onCardClick(cardIndex) {
    const card = this.myHand[cardIndex];
    if (!card) return;
    const side = this.publicState?.currentSide || 'light';
    const { type } = activeProps(card, side);

    if (type === 'wild' || type === 'wild4' || type === 'wildcolor') {
      this._openColorPicker(cardIndex);
      return;
    }
    // Flip card plays immediately with no color choice
    this.sendAction({ action: 'play_card', cardIndex, chosenColor: null });
  }

  _openColorPicker(cardIndex) {
    const side = this.publicState?.currentSide || 'light';
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    const darkColors  = ['pink', 'teal', 'orange', 'purple'];
    const activeColors = side === 'dark' ? darkColors : lightColors;

    const emoji = { red:'🔴', blue:'🔵', green:'🟢', yellow:'🟡',
                    pink:'🩷', teal:'🩵', orange:'🟠', purple:'🟣' };
    const label = { red:'Red', blue:'Blue', green:'Green', yellow:'Yellow',
                    pink:'Pink', teal:'Teal', orange:'Orange', purple:'Purple' };
    const dotClass = { red:'dot-red', blue:'dot-blue', green:'dot-green', yellow:'dot-yellow',
                       pink:'dot-pink', teal:'dot-teal', orange:'dot-orange', purple:'dot-purple' };

    // Count hand colours for the current side
    const counts = {};
    for (const c of activeColors) counts[c] = 0;
    for (const hc of this.myHand) {
      const hProps = activeProps(hc, side);
      if (counts[hProps.color] !== undefined) counts[hProps.color]++;
    }

    // Update colour buttons
    document.querySelectorAll('.color-choice').forEach((btn, i) => {
      const c = activeColors[i];
      btn.dataset.color = c;
      btn.textContent = `${emoji[c]} ${label[c]}`;
    });

    // Render hand summary
    const summary = document.getElementById('hand-color-summary');
    summary.innerHTML = activeColors.map(c => `
      <div class="hcs-item">
        <div class="hcs-dot ${dotClass[c]}"></div>
        <span class="hcs-count">${counts[c]}</span>
      </div>`).join('');

    this.pendingWild = { cardIndex };
    document.getElementById('modal-color').classList.add('visible');
  }

  playWild(color) {
    if (!this.pendingWild) return;
    const { cardIndex } = this.pendingWild;
    this.pendingWild = null;
    document.getElementById('modal-color').classList.remove('visible');
    this.sendAction({ action: 'play_card', cardIndex, chosenColor: color });
  }

  playAgain() {
    this.showAllCards = false;
    this._prevTopCardId = null;
    this._prevDirection = null;
    this._prevHandCount = -1;
    document.getElementById('modal-gameover').classList.remove('visible');
    if (this.isHost) {
      this.room.resetToLobby();
      this.broadcastState();
    }
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
    if (phase === 'game_over') this.showGameOver();
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
      document.getElementById('flip-toggle-wrap').style.display = '';
    } else {
      document.getElementById('flip-toggle-wrap').style.display = 'none';
    }
  }

  renderGame() {
    const st = this.publicState;
    const side = st.currentSide || 'light';
    const myIdx = st.players.findIndex(p => p.id === selfId);
    const isMyTurn = st.currentPlayerIndex === myIdx;
    const myData = st.players[myIdx];
    const curName = st.players[st.currentPlayerIndex]?.name || '';

    document.getElementById('dir-arrow').textContent = st.direction === 1 ? '⟳' : '⟲';
    document.getElementById('dir-label').textContent = st.direction === 1 ? 'Clockwise' : 'Counter-CW';

    // Flash direction badge when direction changes
    if (this._prevDirection !== null && st.direction !== this._prevDirection) {
      const badge = document.getElementById('dir-badge');
      badge.classList.remove('dir-flash');
      void badge.offsetWidth; // reflow to restart animation
      badge.classList.add('dir-flash');
      setTimeout(() => badge.classList.remove('dir-flash'), 600);
    }
    this._prevDirection = st.direction;

    document.getElementById('color-dot').className = 'color-dot dot-' + st.currentColor;
    document.getElementById('color-label').textContent =
      (st.currentColor || '').charAt(0).toUpperCase() + (st.currentColor || '').slice(1);
    document.getElementById('last-action').textContent = st.lastAction;

    // Flip side badge
    const flipBadge = document.getElementById('flip-side-badge');
    if (st.flipMode) {
      flipBadge.style.display = '';
      flipBadge.textContent = side === 'dark' ? '🌑 Dark' : '☀️ Light';
      flipBadge.className = `flip-side-badge side-${side}`;
    } else {
      flipBadge.style.display = 'none';
    }

    const banner = document.getElementById('pending-banner');
    if (st.pendingDraw > 0 && isMyTurn) {
      banner.textContent = `⚠️  Stack a draw card — or draw ${st.pendingDraw} cards!`;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }

    // Discard pile — animate card landing when top card changes
    const discardEl = document.getElementById('discard-top');
    if (st.topCard) {
      const isNewCard = st.topCard.id !== this._prevTopCardId;
      discardEl.innerHTML = this.cardHTML(st.topCard, {
        overrideColor: st.currentColor,
        side,
        animLand: isNewCard,
      });
      this._prevTopCardId = st.topCard.id;
    }

    document.getElementById('deck-count').textContent = st.deckCount;

    const turnEl = document.getElementById('turn-indicator');
    turnEl.textContent = isMyTurn ? '✨ Your Turn!' : `${curName}'s Turn`;
    turnEl.className = 'turn-indicator' + (isMyTurn ? ' my-turn' : '');

    this.renderOpponents(st, myIdx);
    this.renderHand(st, isMyTurn, side);

    const btnDraw = document.getElementById('btn-draw');
    const btnPass = document.getElementById('btn-pass');
    const btnUno  = document.getElementById('btn-uno');

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
      const extra = p.cardCount > 7
        ? `<span class="extra-badge">+${p.cardCount - 7}</span>` : '';

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

  renderHand(st, isMyTurn, side) {
    const el = document.getElementById('my-hand');
    const toggleBtn = document.getElementById('btn-toggle-cards');

    const cardStates = this.myHand.map((card, i) => {
      const playable = isMyTurn && canPlay(card, st.topCard, st.currentColor, st.pendingDraw, side);
      const restricted = this.drawnCardIndex !== null && i !== this.drawnCardIndex;
      return {
        card, i,
        canPlay: playable && !restricted,
        dimmed: isMyTurn && !playable,
        isDrawn: this.drawnCardIndex === i,
      };
    });

    const playable = cardStates.filter(c => c.canPlay || c.isDrawn);
    const canFilter = isMyTurn && playable.length > 0 && playable.length < cardStates.length;
    const visible = (!this.showAllCards && canFilter) ? playable : cardStates;

    el.classList.toggle('wrap', this.showAllCards || !isMyTurn);

    // Detect hand growth → animate new cards sliding in
    const newCount = this.myHand.length;
    const prevCount = this._prevHandCount;
    const handGrew = prevCount >= 0 && newCount > prevCount;
    const newCardStart = handGrew ? prevCount : newCount; // index of first new card in myHand
    this._prevHandCount = newCount;

    el.innerHTML = visible.map(c => this.cardHTML(c.card, {
      index: c.i,
      playable: c.canPlay,
      dimmed: (this.showAllCards || !isMyTurn) && c.dimmed,
      isDrawn: c.isDrawn,
      side,
      animDeal: handGrew && c.i >= newCardStart,
    })).join('');

    el.querySelectorAll('.card[data-index]').forEach(cardEl => {
      const i = parseInt(cardEl.dataset.index);
      if (cardEl.classList.contains('playable')) {
        cardEl.addEventListener('click', () => this.onCardClick(i));
      }
    });

    if (canFilter) {
      toggleBtn.style.display = '';
      toggleBtn.textContent = this.showAllCards
        ? `Playable only (${cardStates.filter(c => c.canPlay).length})`
        : `All cards (${this.myHand.length})`;
    } else {
      toggleBtn.style.display = 'none';
    }
  }

  toggleCardView() {
    this.showAllCards = !this.showAllCards;
    if (this.publicState) {
      const st = this.publicState;
      const side = st.currentSide || 'light';
      const myIdx = st.players.findIndex(p => p.id === selfId);
      this.renderHand(st, st.currentPlayerIndex === myIdx, side);
    }
  }

  cardHTML(card, opts = {}) {
    const { index = -1, playable = false, dimmed = false, isDrawn = false,
            overrideColor = null, side = 'light', animLand = false, animDeal = false } = opts;

    const { color, type } = activeProps(card, side);
    const sym = cardSymbol(card, side);
    const isWild = type === 'wild' || type === 'wild4' || type === 'wildcolor' || color === 'dark-wild';

    const classes = ['card', `card-${color}`,
      playable  ? 'playable'   : '',
      dimmed    ? 'dimmed'     : '',
      isDrawn   ? 'drawn-card' : '',
      animLand  ? 'discard-land' : '',
      animDeal  ? 'card-deal-in' : '',
    ].filter(Boolean).join(' ');

    const dataIdx = index >= 0 ? `data-index="${index}"` : '';
    const colorBar = isWild && overrideColor
      ? `<div class="wild-bar bar-${overrideColor}"></div>` : '';

    return `<div class="${classes}" ${dataIdx} title="${cardName(card, side)}">
      ${colorBar}
      <span class="c-corner c-tl">${sym}</span>
      <div class="c-center"><span class="c-sym">${sym}</span></div>
      <span class="c-corner c-br">${sym}</span>
    </div>`;
  }

  showGameOver() {
    const st = this.publicState;
    const isWinner = st.winner?.id === selfId;
    document.getElementById('go-title').textContent = isWinner ? '🏆 You Win!' : 'Game Over!';
    document.getElementById('go-msg').textContent = isWinner
      ? 'Amazing — you played all your cards first!'
      : `${st.winner?.name || 'Someone'} played all their cards first.`;
    document.getElementById('modal-gameover').classList.add('visible');
  }

  // ─── Session persistence & visibility ───────────────────────

  setupVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this._hiddenAt = Date.now();
        return;
      }
      if (!this.trRoom) return;
      if (this.isHost) {
        this.broadcastState();
      } else if (this.hostPeerId && this.sendMsg) {
        this.sendMsg({ type: 'ping' }, this.hostPeerId);
      }
    });
  }

  saveSession() {
    if (!this.roomCode) return;
    try {
      sessionStorage.setItem('uno-session', JSON.stringify({
        roomCode: this.roomCode,
        playerName: this.myName,
        isHost: this.isHost,
      }));
    } catch (_) {}
  }

  clearSession() {
    sessionStorage.removeItem('uno-session');
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

    $('btn-draw').addEventListener('click', () => {
      // Bounce the deck visually
      const deck = $('deck-pile');
      deck.classList.remove('deck-bounce');
      void deck.offsetWidth;
      deck.classList.add('deck-bounce');
      setTimeout(() => deck.classList.remove('deck-bounce'), 400);
      this.sendAction({ action: 'draw_card' });
    });
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
    $('btn-toggle-cards').addEventListener('click', () => this.toggleCardView());

    // Flip mode toggle (host only, visible in lobby)
    $('flip-mode-toggle').addEventListener('change', e => {
      if (this.isHost && this.room) {
        this.room.setFlipMode(e.target.checked);
      }
    });
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new UnoApp();
  try {
    const raw = sessionStorage.getItem('uno-session');
    if (raw) {
      const { roomCode, playerName, isHost } = JSON.parse(raw);
      if (playerName) document.getElementById('player-name').value = playerName;
      if (!isHost && roomCode) {
        document.getElementById('room-code-input').value = roomCode;
        window.app.showToast(`Tap "Join →" to rejoin ${roomCode}`, 'info');
      }
    }
  } catch (_) {
    sessionStorage.removeItem('uno-session');
  }
});
