import { joinRoom, selfId } from 'https://esm.sh/trystero@0.21.0/mqtt';
import { canPlay, cardSymbol, cardName, GameRoom } from './uno-engine.js';

const APP_ID = 'bsntas-uno-v1';
const ROOM_CONFIG = {
  appId: APP_ID,
  brokerUrl: 'wss://broker.hivemq.com:8884/mqtt',
};

class UnoApp {
  constructor() {
    this.myName = '';
    this.isHost = false;
    this.room = null;        // GameRoom (host only)
    this.trRoom = null;      // Trystero room
    this.sendMsg = null;     // Trystero send fn
    this.hostPeerId = null;  // guest only
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

  // ─── Host flow ───────────────────────────────────────────────

  createGame() {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { this.showToast('Enter your name', 'error'); return; }

    this.myName = name;
    this.isHost = true;

    const code = this.genCode();
    this.room = new GameRoom();
    this.room.addPlayer(selfId, this.myName);

    this.trRoom = joinRoom(ROOM_CONFIG, code);
    const [sendMsg, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = sendMsg;

    this.trRoom.onPeerJoin(peerId => {
      // Announce ourselves as host to the new peer
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
        this.showToast(playerName + ' disconnected', 'error');
        this.room.removePlayer(peerId);
        if (this.room.players.length < 2) {
          this.room.phase = 'game_over';
          this.room.winner = { id: selfId, name: this.myName };
          this.room.lastAction = playerName + ' left the game';
        }
        this.broadcastState();
      }
    });

    onMsg((data, peerId) => {
      if (!this.isHost) return;
      if (data.type === 'guest-join') {
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
      }
    });

    this.showScreen('lobby');
    document.getElementById('room-code-display').textContent = code;
    document.getElementById('btn-start').style.display = '';
    document.getElementById('waiting-text').style.display = 'none';
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
        this.showToast('Host disconnected', 'error');
        setTimeout(() => location.reload(), 2000);
      }
    });

    onMsg((data, peerId) => {
      if (this.isHost) return;

      if (data.type === 'host-hello' && !this.hostPeerId) {
        clearTimeout(joinTimeout);
        this.hostPeerId = peerId;
        sendMsg({ type: 'guest-join', name: this.myName }, peerId);
        this.showScreen('lobby');
        document.getElementById('room-code-display').textContent = code;
        document.getElementById('btn-start').style.display = 'none';
        document.getElementById('waiting-text').style.display = '';
        btnJoin.disabled = false;
        btnJoin.textContent = 'Join →';
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
      }, player.id); // player.id === Trystero peerId for guests
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
    }
  }

  renderGame() {
    const st = this.publicState;
    const myIdx = st.players.findIndex(p => p.id === selfId);
    const isMyTurn = st.currentPlayerIndex === myIdx;
    const myData = st.players[myIdx];
    const curName = st.players[st.currentPlayerIndex]?.name || '';

    document.getElementById('dir-arrow').textContent = st.direction === 1 ? '⟳' : '⟲';
    document.getElementById('dir-label').textContent = st.direction === 1 ? 'Clockwise' : 'Counter-CW';
    document.getElementById('color-dot').className = 'color-dot dot-' + st.currentColor;
    document.getElementById('color-label').textContent =
      (st.currentColor || '').charAt(0).toUpperCase() + (st.currentColor || '').slice(1);
    document.getElementById('last-action').textContent = st.lastAction;

    const banner = document.getElementById('pending-banner');
    if (st.pendingDraw > 0 && isMyTurn) {
      banner.textContent = `⚠️  Stack a draw card — or draw ${st.pendingDraw} cards!`;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }

    const discardEl = document.getElementById('discard-top');
    if (st.topCard) {
      discardEl.innerHTML = this.cardHTML(st.topCard, {
        overrideColor: st.currentColor,
      });
    }

    document.getElementById('deck-count').textContent = st.deckCount;

    const turnEl = document.getElementById('turn-indicator');
    turnEl.textContent = isMyTurn ? '✨ Your Turn!' : `${curName}'s Turn`;
    turnEl.className = 'turn-indicator' + (isMyTurn ? ' my-turn' : '');

    this.renderOpponents(st, myIdx);
    this.renderHand(st, isMyTurn);

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
            overrideColor = null } = opts;
    const sym = cardSymbol(card);
    const isWild = card.type === 'wild' || card.type === 'wild4';

    const classes = ['card', `card-${card.color}`,
      playable ? 'playable' : '',
      dimmed    ? 'dimmed'   : '',
      isDrawn   ? 'drawn-card' : '',
    ].filter(Boolean).join(' ');

    const dataIdx = index >= 0 ? `data-index="${index}"` : '';
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
    const isWinner = st.winner?.id === selfId;
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
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', () => { window.app = new UnoApp(); });
