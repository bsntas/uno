# UNO — Multiplayer

A real-time multiplayer UNO card game that runs entirely in the browser with no server, no accounts, and no install. Share a room code and play from any device.

**Live:** [bsntas.github.io/uno](https://bsntas.github.io/uno)

---

## Features

- **2–6 players** over a peer-to-peer connection
- **UNO Flip mode** — dual-sided cards with the full dark-side rule set
- Works on **mobile and desktop** — touch-optimised, portrait and landscape
- **No backend** — pure static site, hosted on GitHub Pages
- **Reconnect** — returning after backgrounding the app rejoins your seat automatically
- Animations for card plays, draws, direction reversals, and dealing

### Standard rules

| Card | Effect |
|---|---|
| Number (0–9) | Play on matching colour or number |
| Skip | Next player loses their turn |
| Reverse | Reverses play order (acts as Skip in 2-player) |
| Draw 2 | Next player draws 2 (stackable) |
| Wild | Play any time; choose next colour |
| Wild Draw 4 | Next player draws 4 (stackable); choose next colour |

### UNO Flip rules (dark side)

| Card | Effect |
|---|---|
| Skip Everyone | Every other player is skipped |
| Draw 5 | Next player draws 5 (stackable with Draw 2) |
| Wild Draw Color | Next player draws until they pick a card matching the chosen colour |
| Flip | Switches all hands to the other side of the deck |

---

## How to play

1. Open the game in a browser.
2. Enter your name and tap **Create Game** — you'll get a 6-character room code.
3. Share the code with friends. They enter the code and their name, then tap **Join →**.
4. The host can optionally enable **UNO Flip Mode** in the lobby.
5. Once 2–6 players have joined, the host taps **Start Game**.

### During the game

- **Playable cards** are highlighted with a gold glow and lift when it is your turn.
- Tap a playable card to play it. Wild cards open a colour picker — a summary of your hand colours is shown to help you choose.
- If you have no playable card (or choose not to play), tap **Draw Card**.
- If the drawn card is playable, you may play it immediately or tap **Pass Turn**.
- Tap **UNO!** when you are down to one card.
- The **info bar** at the top shows current play direction, active colour, and the last action.

---

## Architecture

The game is a **zero-backend static site** — all logic runs in the browser.

```
index.html          Single-page app shell with all three screens (home / lobby / game)
css/style.css       All styling — responsive, mobile-first
js/app.js           UI layer — networking, rendering, user interaction
js/uno-engine.js    Pure game logic — deck, rules, GameRoom state machine
```

### Networking

Multiplayer is powered by [Trystero](https://github.com/dmotz/trystero) with the MQTT strategy. Peers discover each other via HiveMQ's public MQTT broker (`wss://broker.hivemq.com:8884/mqtt`) and then communicate directly over WebRTC data channels. No signalling server is owned or operated.

**Host-authoritative model:** the host's tab runs the `GameRoom` engine and is the single source of truth. On every state change the host broadcasts:
- A **public state** (player list, top card, scores, current colour) to everyone
- A **private hand** to each player individually

Guests send actions (`play_card`, `draw_card`, `pass_turn`, `call_uno`) to the host, which validates and applies them before rebroadcasting.

### Reconnection

If a player disconnects mid-game, the host starts a 45-second grace period. If the same player name rejoins within that window, their seat, hand, and turn position are restored seamlessly.

---

## Local development

No build step required — it is plain HTML, CSS, and ES Modules.

```bash
# Any static file server works, e.g.:
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in two browser tabs to test multiplayer locally.

> **Note:** The game uses `import` from `https://esm.sh/trystero@0.21.0/mqtt`. An internet connection is needed even for local development.

---

## Browser support

| Browser | Status |
|---|---|
| Chrome / Edge (Android & desktop) | ✅ Full support |
| Safari (iOS 15.4+) | ✅ Full support |
| Firefox | ✅ Full support |
| Samsung Internet | ✅ Full support |

WebRTC data channels are required. The game will not work in browsers that block WebRTC.

---

## Project structure

```
uno/
├── index.html          App shell + all screen markup
├── css/
│   └── style.css       Styles (reset, screens, cards, modals, responsive)
└── js/
    ├── app.js          UnoApp class — Trystero setup, rendering, UI events
    └── uno-engine.js   GameRoom class + pure functions (canPlay, cardSymbol, …)
```

### Key classes and functions

**`uno-engine.js`**

| Export | Description |
|---|---|
| `GameRoom` | Host-side state machine — players, deck, turn order, rules |
| `canPlay(card, topCard, currentColor, pendingDraw, side)` | Returns true if the card is legal to play |
| `cardSymbol(card, side)` | Short display string for a card (`'5'`, `'+4'`, `'↺'`, …) |
| `cardName(card, side)` | Full readable name (`'Blue Skip'`, `'Wild Draw 4'`, …) |
| `activeProps(card, side)` | Returns `{ color, type, value }` for the active deck side |
| `COLORS` / `DARK_COLORS` | Light-side and dark-side colour arrays |

**`app.js`**

| Method | Description |
|---|---|
| `createGame()` | Host flow — creates room, sets up Trystero, shows lobby |
| `joinGame()` | Guest flow — joins room, waits for host hello |
| `startGame()` | Host only — applies flip mode and starts the `GameRoom` |
| `broadcastState()` | Sends public + private state to all peers |
| `renderGame()` | Full re-render of the game screen from public state |
| `renderHand()` | Renders the player's cards with playable/dimmed states |
| `cardHTML()` | Returns the HTML string for a single card |
| `_attemptReconnect()` | Guest reconnection — leaves old room, rejoins after 2 s |

---

## Deployment

The `main` branch is served directly by GitHub Pages from the repository root. Pushing to `main` deploys immediately — no CI pipeline is needed.
