const COLORS      = ['red', 'blue', 'green', 'yellow'];
const DARK_COLORS = ['pink', 'teal', 'orange', 'purple'];

function uid() {
  return Math.random().toString(36).substr(2, 9);
}

// Returns the active side's { color, type, value } for a card.
// Regular (non-flip) cards have no darkType and always return their own fields.
function activeProps(card, side) {
  if (side === 'dark' && card.darkType !== undefined) {
    return { color: card.darkColor, type: card.darkType, value: card.darkValue };
  }
  return { color: card.color, type: card.type, value: card.value };
}

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ id: uid(), color, type: 'number', value: 0 });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: uid(), color, type: 'number', value: n });
      deck.push({ id: uid(), color, type: 'number', value: n });
    }
    for (const type of ['skip', 'reverse', 'draw2']) {
      deck.push({ id: uid(), color, type, value: null });
      deck.push({ id: uid(), color, type, value: null });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: uid(), color: 'wild', type: 'wild', value: null });
    deck.push({ id: uid(), color: 'wild', type: 'wild4', value: null });
  }
  return deck;
}

// Flip-mode deck: each card has light side (color/type/value) and dark side (darkColor/darkType/darkValue).
// 4 colours × (1 zero + 9×2 numbers + 2 skip + 2 reverse + 2 draw + 2 flip) + 4 wild + 4 wild/wildcolor = ~116 cards
function createFlipDeck() {
  const deck = [];
  for (let ci = 0; ci < 4; ci++) {
    const lc = COLORS[ci], dc = DARK_COLORS[ci];

    deck.push({ id: uid(), color: lc, type: 'number', value: 0,
      darkColor: dc, darkType: 'number', darkValue: 0 });

    for (let n = 1; n <= 9; n++) {
      for (let j = 0; j < 2; j++) {
        deck.push({ id: uid(), color: lc, type: 'number', value: n,
          darkColor: dc, darkType: 'number', darkValue: n });
      }
    }
    for (let j = 0; j < 2; j++) {
      deck.push({ id: uid(), color: lc, type: 'skip',    value: null, darkColor: dc, darkType: 'skipall', darkValue: null });
      deck.push({ id: uid(), color: lc, type: 'reverse', value: null, darkColor: dc, darkType: 'reverse', darkValue: null });
      deck.push({ id: uid(), color: lc, type: 'draw2',   value: null, darkColor: dc, darkType: 'draw5',   darkValue: null });
      deck.push({ id: uid(), color: lc, type: 'flip',    value: null, darkColor: dc, darkType: 'flip',    darkValue: null });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: uid(), color: 'wild', type: 'wild',  value: null, darkColor: 'dark-wild', darkType: 'wild',      darkValue: null });
    deck.push({ id: uid(), color: 'wild', type: 'wild4', value: null, darkColor: 'dark-wild', darkType: 'wildcolor', darkValue: null });
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlay(card, topCard, currentColor, pendingDraw, side = 'light') {
  const cp = activeProps(card, side);
  const tp = topCard ? activeProps(topCard, side) : null;

  // Flip card can always be played (it switches sides)
  if (cp.type === 'flip') return true;

  if (pendingDraw > 0) {
    // Only draw-stacking cards can be played against a pending draw
    return cp.type === 'draw2' || cp.type === 'wild4' || cp.type === 'draw5';
  }

  // Wild-type cards are always playable
  if (cp.type === 'wild' || cp.type === 'wild4' || cp.type === 'wildcolor') return true;

  // Colour match
  if (cp.color === currentColor) return true;
  if (!tp) return false;
  // Same number
  if (cp.type === 'number' && tp.type === 'number' && cp.value === tp.value) return true;
  // Same action type
  if (cp.type !== 'number' && cp.type === tp.type) return true;
  return false;
}

function cardSymbol(card, side = 'light') {
  const { type, value } = activeProps(card, side);
  if (type === 'number')    return String(value);
  if (type === 'skip')      return '⊘';
  if (type === 'reverse')   return '↺';
  if (type === 'draw2')     return '+2';
  if (type === 'wild')      return '✦';
  if (type === 'wild4')     return '+4';
  if (type === 'flip')      return '⇌';
  if (type === 'skipall')   return '⊗';
  if (type === 'draw5')     return '+5';
  if (type === 'wildcolor') return '⬤?';
  return '?';
}

function cardName(card, side = 'light') {
  const { color, type, value } = activeProps(card, side);
  const cn = { red:'Red', blue:'Blue', green:'Green', yellow:'Yellow',
               pink:'Pink', teal:'Teal', orange:'Orange', purple:'Purple', wild:'', 'dark-wild': '' };
  const tn = { number: value, skip: 'Skip', reverse: 'Reverse', draw2: 'Draw 2',
               wild: 'Wild', wild4: 'Wild +4', flip: 'Flip',
               skipall: 'Skip Everyone', draw5: 'Draw 5', wildcolor: 'Wild Draw Color' };
  const isWild = type === 'wild' || type === 'wild4' || type === 'wildcolor';
  const prefix = isWild ? '' : (cn[color] || color) + ' ';
  return prefix + tn[type];
}

class GameRoom {
  constructor() {
    this.players = [];
    this.deck = [];
    this.discardPile = [];
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.currentColor = null;
    this.phase = 'lobby';
    this.pendingDraw = 0;
    this.winner = null;
    this.lastAction = '';
    this.unoCallers = new Set();
    this.waitingForPass = false;
    this.drawnCardInfo = null;
    this.flipMode = false;
    this.currentSide = 'light';
  }

  get topCard() { return this.discardPile[this.discardPile.length - 1] || null; }
  get currentPlayer() { return this.players[this.currentPlayerIndex] || null; }

  addPlayer(id, name) {
    if (this.players.length >= 6) return { error: 'Room is full (max 6)' };
    if (this.phase !== 'lobby') return { error: 'Game already started' };
    const taken = this.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return { error: 'Name already taken' };
    this.players.push({ id, name, hand: [] });
    return { ok: true };
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return;
    this.players.splice(idx, 1);
    if (!this.players.length) return;
    if (idx < this.currentPlayerIndex) this.currentPlayerIndex--;
    else if (idx === this.currentPlayerIndex) {
      this.currentPlayerIndex = this.currentPlayerIndex % this.players.length;
    }
  }

  startGame() {
    if (this.players.length < 2) return { error: 'Need at least 2 players' };
    this.deck = shuffle(this.flipMode ? createFlipDeck() : createDeck());
    this.discardPile = [];
    this.currentSide = 'light';
    for (const p of this.players) p.hand = this.deck.splice(0, 7);

    let startCard;
    for (let i = 0; i < this.deck.length; i++) {
      if (activeProps(this.deck[i], 'light').type === 'number') {
        [startCard] = this.deck.splice(i, 1);
        break;
      }
    }
    if (!startCard) startCard = this.deck.shift();

    this.discardPile = [startCard];
    this.currentColor = activeProps(startCard, 'light').color;
    this.phase = 'playing';
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.pendingDraw = 0;
    this.winner = null;
    this.lastAction = 'Game started!';
    this.unoCallers = new Set();
    this.waitingForPass = false;
    this.drawnCardInfo = null;
    return { ok: true };
  }

  resetToLobby() {
    this.phase = 'lobby';
    this.deck = [];
    this.discardPile = [];
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.currentColor = null;
    this.pendingDraw = 0;
    this.winner = null;
    this.lastAction = '';
    this.unoCallers = new Set();
    this.waitingForPass = false;
    this.drawnCardInfo = null;
    this.currentSide = 'light';
    for (const p of this.players) p.hand = [];
  }

  nextIndex(offset = 1) {
    const n = this.players.length;
    return ((this.currentPlayerIndex + this.direction * offset) % n + n) % n;
  }

  advance(extra = 0) {
    this.currentPlayerIndex = this.nextIndex(1 + extra);
    this.waitingForPass = false;
    this.drawnCardInfo = null;
  }

  replenish() {
    if (this.deck.length < 4 && this.discardPile.length > 1) {
      const top = this.discardPile.pop();
      this.deck = [...this.deck, ...shuffle(this.discardPile)];
      this.discardPile = [top];
    }
  }

  give(player, count) {
    for (let i = 0; i < count; i++) {
      this.replenish();
      if (this.deck.length) player.hand.push(this.deck.shift());
    }
  }

  playCard(playerId, cardIndex, chosenColor) {
    if (this.phase !== 'playing') return { error: 'Not in playing phase' };
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { error: 'Player not found' };
    if (this.currentPlayer?.id !== playerId) return { error: "Not your turn" };
    if (this.waitingForPass && this.drawnCardInfo?.cardIndex !== cardIndex)
      return { error: 'You can only play the card you just drew' };

    const card = player.hand[cardIndex];
    if (!card) return { error: 'Invalid card' };

    const cp = activeProps(card, this.currentSide);

    if (!canPlay(card, this.topCard, this.currentColor, this.pendingDraw, this.currentSide))
      return { error: 'Cannot play this card' };

    const isWild = cp.type === 'wild' || cp.type === 'wild4' || cp.type === 'wildcolor';
    const allValidColors = [...COLORS, ...DARK_COLORS];
    if (isWild && !allValidColors.includes(chosenColor))
      return { error: 'Choose a valid color' };

    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.unoCallers.delete(playerId);
    this.waitingForPass = false;
    this.drawnCardInfo = null;

    if (isWild) {
      this.currentColor = chosenColor;
    } else if (cp.type !== 'flip') {
      this.currentColor = cp.color;
    }

    if (player.hand.length === 0) {
      this.phase = 'game_over';
      this.winner = { id: player.id, name: player.name };
      this.lastAction = `🏆 ${player.name} wins!`;
      return { ok: true };
    }

    this.lastAction = `${player.name} played ${cardName(card, this.currentSide)}`;
    let skipExtra = 0;

    switch (cp.type) {
      case 'skip':
        skipExtra = 1;
        break;
      case 'skipall':
        skipExtra = this.players.length - 1;
        this.lastAction += ' — everyone is skipped!';
        break;
      case 'reverse':
        if (this.players.length === 2) {
          skipExtra = 1;
        } else {
          this.direction *= -1;
          this.lastAction += ` — direction reversed!`;
        }
        break;
      case 'draw2':
        this.pendingDraw += 2;
        break;
      case 'draw5':
        this.pendingDraw += 5;
        break;
      case 'wild4':
        this.pendingDraw += 4;
        break;
      case 'wildcolor': {
        // Next player draws cards until they draw one matching chosenColor (max 30)
        const nextIdx = this.nextIndex(1);
        const nextP = this.players[nextIdx];
        let drawn = 0;
        while (drawn < 30) {
          this.replenish();
          if (!this.deck.length) break;
          const dc = this.deck.shift();
          nextP.hand.push(dc);
          drawn++;
          if (activeProps(dc, this.currentSide).color === chosenColor) break;
        }
        this.lastAction += ` — ${nextP.name} drew ${drawn} card${drawn !== 1 ? 's' : ''}`;
        skipExtra = 1;
        break;
      }
      case 'flip': {
        const prevSide = this.currentSide;
        this.currentSide = prevSide === 'light' ? 'dark' : 'light';
        // Set current color to the newly-active side's color of the just-played flip card
        this.currentColor = activeProps(card, this.currentSide).color;
        this.lastAction += ` — flipped to ${this.currentSide} side!`;
        break;
      }
    }

    this.advance(skipExtra);
    return { ok: true };
  }

  drawCards(playerId) {
    if (this.phase !== 'playing') return { error: 'Not in playing phase' };
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { error: 'Player not found' };
    if (this.currentPlayer?.id !== playerId) return { error: "Not your turn" };
    if (this.waitingForPass) return { error: 'Already drew — play or pass' };

    if (this.pendingDraw > 0) {
      const count = this.pendingDraw;
      this.pendingDraw = 0;
      this.give(player, count);
      this.lastAction = `${player.name} drew ${count} cards`;
      this.advance(0);
      return { ok: true };
    }

    this.replenish();
    if (!this.deck.length) return { error: 'No cards to draw' };

    const card = this.deck.shift();
    player.hand.push(card);
    const cardIdx = player.hand.length - 1;
    const playable = canPlay(card, this.topCard, this.currentColor, 0, this.currentSide);

    if (playable) {
      this.waitingForPass = true;
      this.drawnCardInfo = { playerId, cardIndex: cardIdx };
      this.lastAction = `${player.name} drew a card`;
      return { ok: true, canPlay: true, cardIndex: cardIdx };
    }

    this.lastAction = `${player.name} drew a card`;
    this.advance(0);
    return { ok: true, canPlay: false };
  }

  passTurn(playerId) {
    if (!this.waitingForPass) return { error: 'Nothing to pass' };
    if (this.currentPlayer?.id !== playerId) return { error: "Not your turn" };
    this.lastAction = `${this.currentPlayer.name} passed`;
    this.advance(0);
    return { ok: true };
  }

  callUno(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { error: 'Player not found' };
    if (player.hand.length !== 1) return { error: 'Can only call UNO with 1 card' };
    this.unoCallers.add(playerId);
    this.lastAction = `${player.name} called UNO! 🃏`;
    return { ok: true };
  }

  setFlipMode(enabled) {
    if (this.phase !== 'lobby') return { error: 'Cannot change settings mid-game' };
    this.flipMode = !!enabled;
    return { ok: true };
  }

  getPublicState() {
    return {
      phase: this.phase,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        calledUno: this.unoCallers.has(p.id),
      })),
      currentPlayerIndex: this.currentPlayerIndex,
      direction: this.direction,
      topCard: this.topCard,
      currentColor: this.currentColor,
      deckCount: this.deck.length,
      pendingDraw: this.pendingDraw,
      winner: this.winner,
      lastAction: this.lastAction,
      waitingForPass: this.waitingForPass,
      flipMode: this.flipMode,
      currentSide: this.currentSide,
    };
  }

  getPrivateData(playerId) {
    const player = this.players.find(p => p.id === playerId);
    const drawnCardIndex =
      this.drawnCardInfo?.playerId === playerId ? this.drawnCardInfo.cardIndex : null;
    return { hand: player ? player.hand : [], drawnCardIndex };
  }
}

export { COLORS, DARK_COLORS, activeProps, canPlay, cardSymbol, cardName, GameRoom };
