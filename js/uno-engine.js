const COLORS = ['red', 'blue', 'green', 'yellow'];

function uid() {
  return Math.random().toString(36).substr(2, 9);
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlay(card, topCard, currentColor, pendingDraw) {
  if (pendingDraw > 0) return card.type === 'draw2' || card.type === 'wild4';
  if (card.type === 'wild' || card.type === 'wild4') return true;
  if (card.color === currentColor) return true;
  if (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) return true;
  if (card.type !== 'number' && card.type === topCard.type) return true;
  return false;
}

function cardSymbol(card) {
  if (card.type === 'number') return String(card.value);
  if (card.type === 'skip') return '⊘';
  if (card.type === 'reverse') return '↺';
  if (card.type === 'draw2') return '+2';
  if (card.type === 'wild') return '✦';
  if (card.type === 'wild4') return '+4';
  return '?';
}

function cardName(card) {
  const cn = { red: 'Red', blue: 'Blue', green: 'Green', yellow: 'Yellow', wild: '' };
  const tn = { number: card.value, skip: 'Skip', reverse: 'Reverse', draw2: 'Draw 2', wild: 'Wild', wild4: 'Wild +4' };
  const prefix = (card.type === 'wild' || card.type === 'wild4') ? '' : cn[card.color] + ' ';
  return prefix + tn[card.type];
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
    this.deck = shuffle(createDeck());
    this.discardPile = [];
    for (const p of this.players) p.hand = this.deck.splice(0, 7);

    let startCard;
    for (let i = 0; i < this.deck.length; i++) {
      if (this.deck[i].type === 'number') {
        [startCard] = this.deck.splice(i, 1);
        break;
      }
    }
    if (!startCard) startCard = this.deck.shift();

    this.discardPile = [startCard];
    this.currentColor = startCard.color;
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
    if (!canPlay(card, this.topCard, this.currentColor, this.pendingDraw))
      return { error: 'Cannot play this card' };
    if ((card.type === 'wild' || card.type === 'wild4') && !COLORS.includes(chosenColor))
      return { error: 'Choose a valid color' };

    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.unoCallers.delete(playerId);
    this.waitingForPass = false;
    this.drawnCardInfo = null;

    this.currentColor = (card.type === 'wild' || card.type === 'wild4') ? chosenColor : card.color;

    if (player.hand.length === 0) {
      this.phase = 'game_over';
      this.winner = { id: player.id, name: player.name };
      this.lastAction = `🏆 ${player.name} wins!`;
      return { ok: true };
    }

    this.lastAction = `${player.name} played ${cardName(card)}`;
    let skipExtra = 0;

    if (card.type === 'skip') {
      skipExtra = 1;
    } else if (card.type === 'reverse') {
      if (this.players.length === 2) skipExtra = 1;
      else this.direction *= -1;
    } else if (card.type === 'draw2') {
      this.pendingDraw += 2;
    } else if (card.type === 'wild4') {
      this.pendingDraw += 4;
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
    const cardIndex = player.hand.length - 1;
    const playable = canPlay(card, this.topCard, this.currentColor, 0);

    if (playable) {
      this.waitingForPass = true;
      this.drawnCardInfo = { playerId, cardIndex };
      this.lastAction = `${player.name} drew a card`;
      return { ok: true, canPlay: true, cardIndex };
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
    };
  }

  getPrivateData(playerId) {
    const player = this.players.find(p => p.id === playerId);
    const drawnCardIndex =
      this.drawnCardInfo?.playerId === playerId ? this.drawnCardInfo.cardIndex : null;
    return { hand: player ? player.hand : [], drawnCardIndex };
  }
}
