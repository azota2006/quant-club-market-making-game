# Market Making Game

A live, multiplayer market-making game for an in-person quant club game night.
Players quote two-sided markets on "commodities" whose true value is hidden until
the end of the round. Runs on a host laptop over local WiFi; everyone else joins
from a phone browser with a 4-character code. No accounts, no database.

Built to a written product spec.

---

## At a glance

**What players do.** Every commodity is a card suit. You are dealt a private hand
and never see anyone else's. For each commodity you post a bid and an ask, and
anybody can trade against your quote at any moment. You are trading a *number*,
not the cards themselves — like a futures contract that settles at whatever that
suit turns out to be worth.

**Where the number comes from.** A commodity's true value is the sum of the card
ranks (A=1 … K=13) of that suit that were actually dealt into someone's hand.
Cards left over after the deal are discarded and count for nothing — which is
what makes the value genuinely unknown rather than a fixed constant. Your own
hand is a guaranteed floor; the rest you have to estimate.

**How you win.** At Reveal:
`P&L = (cash made trading) + (position held × true value)`.
Quoting a tight two-sided market and ending flat earns the spread no matter what
the reveal says; carrying a position is a bet on it. Every round is exactly zero
sum. Scores accumulate across rounds, and the highest total wins the night.

**A round, start to finish.** Host deals → players study their hands → trading
opens on a clock → trading closes → Reveal scores everyone and shows what each
trade was actually worth.

### What's in the repository

| Path | What it holds |
|---|---|
| `server/engine.js` | Pure game maths — deck, shuffle, deal, true values, scoring |
| `server/session.js` | Session state, phase machine, quote and trade rules, redaction |
| `server/index.js` | Express + Socket.IO wiring, round timer, join URL and QR code |
| `public/` | The entire client: one HTML shell, one JS file, one stylesheet |
| `test/` | 110 tests — engine maths, session rules, live sockets, and the UI in jsdom |

About 3,600 lines of application code and 2,100 of tests. No build step, and no
runtime dependencies beyond Express, Socket.IO and a QR-code generator.

---

## Quick start

Double-click **`start.cmd`**, or run it from a terminal:

```
.\start.cmd
```

It installs dependencies on first run and starts the server. Stop it with Ctrl+C.

If you'd rather use npm directly, use `npm.cmd` rather than `npm` in PowerShell —
see "PowerShell blocks npm" below for why.

The server prints the addresses to share:

```
  Host dashboard:  http://localhost:3000
  Players join at: http://192.168.1.42:3000   (Wi-Fi)
```

Open the dashboard on the host laptop, click **Create a game**, and read the
4-character code out to the room. The dashboard also shows a QR code pointing at
the join URL, which is the fastest way to get 15 phones onto the right page.

Change the port with `set PORT=4000` before `start.cmd` (or `$env:PORT=4000` in
PowerShell).

### Requirements

Node 18 or newer (developed on 24.20.0 LTS). Nothing else — no database and
no external services. If you cannot install Node system-wide, the official
Windows .zip build unpacks anywhere and needs no admin rights; put that folder
on your PATH and open a new terminal.

### PowerShell blocks npm

```
npm : File ...\npm.ps1 cannot be loaded because running scripts is disabled on this system.
```

npm ships a PowerShell wrapper, npm.ps1, which PowerShell refuses to run when
the execution policy is `Restricted` — the Windows default when neither the
`CurrentUser` nor `LocalMachine` scope has been set. Check yours with
`Get-ExecutionPolicy -List`. Nothing is wrong with the Node install; this
affects every npm package on the machine, not just this project.

Three ways round it, cheapest first:

1. **`.\start.cmd`** — a batch file, so the policy never applies. Nothing to change.
2. **`npm.cmd start`** — calls npm's batch wrapper instead of the PowerShell one.
   Works anywhere `npm` would, including `npm.cmd test`.
3. **Relax the policy for your account** (a real security-setting change, so it's
   your call, not something to do casually):
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
   This lets locally-authored scripts run and requires downloaded ones to be
   signed. It needs no admin rights and affects only your user account.

### Windows firewall

The first time Node binds a port, Windows may ask whether to allow it on private
networks. **Say yes**, or phones on the same WiFi will not be able to connect
even though `localhost` works fine on the host laptop. If you dismissed the
prompt, allow it under Windows Security → Firewall → Allow an app.

---

## Running a game night

The host drives every phase from the dashboard:

| Phase      | What's happening                                                       |
|------------|------------------------------------------------------------------------|
| `lobby`    | Players join, host configures the round. No cards dealt.               |
| `dealt`    | Hands are out and visible to their owners. Quoting is not open yet.    |
| `trading`  | Quotes and trades are live, timer running.                             |
| `locked`   | Timer hit zero or the host ended the round. Trading frozen.            |
| `revealed` | True values shown, round scored, cumulative leaderboard updated.       |
| `ended`    | Session closed, final standings.                                       |

**Deal cards → Start trading → End round → Reveal → Next round.** The clock ends
the round automatically, so "End round" is only needed to stop early.

After each Reveal:

- **Players** get the full round tape with every trade priced against the true
  value, defaulting to just their own trades. The per-trade figures sum to
  exactly that player's round P&L, so the tape explains the score line by line.
- **The host** gets a "P&L by round" matrix — one column per round, one row per
  player, ordered by cumulative standing, with the true values and trade count
  behind each round listed underneath.

### Round settings

| Setting                | Default | Notes |
|------------------------|---------|-------|
| Commodities            | all 4 suits | 2–4. Optional flavour names ("Iron Ore"); suit name is used if blank. |
| Decks                  | 2 | 1–4. More decks = more cards = full hands for a bigger table. See below. |
| Max cards / player     | 8 | Actual deal is `min(this, floor(deck ÷ players))`. |
| Starting cash          | 0 | Nets out of P&L either way; 0 makes "cash" read as trading P&L. |
| Round length           | 8 min | |
| Host also plays        | off | Adds a "My desk" tab so the host can quote from the dashboard. |
| Quote expires after one fill | off | See "standing quotes" below. |

Settings are editable in the lobby **and between rounds**, and apply at the next
deal. (The PRD says lobby-only; being able to shorten the clock or drop a deck
after a first round that ran long is worth the small deviation.)

**Tuning the uncertainty:** fewer cards per player means more cards discarded,
which means more irreducible unknown in every commodity. More cards per player
makes the market more information-efficient and rewards inference over guessing.

### Choosing a deck count

The settings card shows a live preview — *"208 cards · 20 playing · 8 cards each
· 48 discarded"* — that updates as you change anything, so you can see the effect
before committing. It warns you if a combination would deal badly.

With 4 commodities and max cards at 8 (cells are **cards each / discarded**):

| Players | 1 deck | 2 decks | 3 decks | 4 decks |
|---|---|---|---|---|
| 12 | 4 / 4 | 8 / 8 | 8 / 60 | 8 / 112 |
| **13** | **4 / 0** ⚠ | **8 / 0** ⚠ | 8 / 52 | 8 / 104 |
| 16 | 3 / 4 | 6 / 8 | 8 / 28 | 8 / 80 |
| 20 | 2 / 12 | 5 / 4 | 7 / 16 | 8 / 48 |
| 25 | 2 / 2 | 4 / 4 | 6 / 6 | 8 / 8 |
| **26** | **2 / 0** ⚠ | **4 / 0** ⚠ | **6 / 0** ⚠ | **8 / 0** ⚠ |

**4 decks gives every table from 10 to 25 players a full 8-card hand.** With 1
deck a 20-player table is down to 2 cards each, which is barely a hand.

⚠ **Zero discards breaks the round.** If every card gets dealt, each commodity is
worth exactly 91 × decks, computable by anyone before a card is turned — there is
no hidden information left. This happens whenever the player count divides the
deck evenly. **13 players is the trap to know about**, since 13 divides every
possible deck size; 3 or 4 decks fixes it, or drop max cards to 6. At 26 players
no deck count saves you — lower max cards to 7 instead. The host preview flags
all of these before you deal.

---

## How the hidden value works

Each commodity is a suit. Its true value is the sum of the ranks
(A=1 … K=13) of **only the cards of that suit that were actually dealt into
someone's hand**. Cards left over after the last full round of dealing are
discarded and count toward nothing.

That last part is the whole point: a complete suit always sums to 91 per deck, so
if every card counted the "hidden" value would be public knowledge before the
round began. Because the leftovers are random, nobody — including the host — can
know the number, or even how much is missing, until Reveal.

Players see their own hand plus the public game numbers (decks, commodities,
cards per player, players in the round) and are left to do the estimation
themselves. The UI deliberately shows **no computed fair value** anywhere; that
inference is the skill the game exists to test.

Scoring, per player per round:

```
round P&L = (cash_end − starting_cash) + Σ (position in commodity × true value)
```

Every trade moves +1 to one player and −1 to the other, so the table is exactly
zero sum. There is a test asserting that.

---

## Standing quotes, and the one real ambiguity in the PRD

§4.3 says a quote is **standing**: it stays live and repeatedly tradeable until
the quoting player changes or clears it. §12 asks that two players lifting the
same ask at the same moment produce exactly one fill and one "no longer
available" error.

Those two rules can't both hold — under standing quotes both lifts are
legitimate, and refusing the second would be a bug, not a safeguard.

Both behaviours are implemented, and the host chooses:

- **Default (standing quotes, §4.3):** a resting quote fills as many times as
  people hit it. Leave a bad price up and you will be run over. This is the v1
  behaviour the PRD specifies.
- **"Quote expires after one fill" (the §12 scenario, flagged as v1.1 in §4.3):**
  the filled side is pulled on execution, so exactly one of two simultaneous
  lifts wins and the other gets "That quote is no longer available."

The protection §12 is really after — a client clicking a price that has since
moved — applies in **both** modes. Every lift and hit carries the price the
client had on screen, and the server refuses to fill at anything else:

> That quote moved — it's now 185. Try again.

Trades are executed synchronously on a single-threaded server, so the
check-then-write is atomic with respect to every other event.

---

## Architecture

```
server/
  engine.js    pure game math — deck, shuffle, deal, true values, scoring
  session.js   session state, phase machine, quote/trade rules, redaction
  index.js     Express + Socket.IO wiring, timers, join URL / QR endpoint
public/
  index.html   app shell + the rules screen copy
  app.js       client: socket handling, screen routing, trading UI
  styles.css   mobile-first dark theme
test/
  engine.test.js       deck, dealing, true values, P&L, zero-sum
  session.test.js      phases, quote validation, trades, multi-round reset
  integration.test.js  real sockets: hidden info, stale quotes, reconnect, 20 players
  client.test.js       the UI driven in jsdom against a fake socket
```

State is in memory, keyed by session code. Losing the server loses the game;
that is the accepted tradeoff for a single game night.

### What the server refuses to send

`publicState()` is the only object ever broadcast, and it is built by
construction rather than by deletion — hands, the deck, the discard pile and
pre-reveal true values simply are not in it. Private data goes to exactly one
socket via `hand:yours` and `position:yours`.

An integration test records **every** payload a player's socket receives, scans
it recursively for anything card-shaped, and fails if it finds a single card
outside that player's own `hand:yours`.

### Event contract

Client → server: `create_session`, `join_session`, `player:seen_rules`,
`player:update_quote`, `player:clear_quote`, `player:lift_ask`,
`player:hit_bid`, and the host-only `host:configure_round`, `host:deal`,
`host:start_trading`, `host:end_round`, `host:reveal`, `host:next_round`,
`host:end_session`, `host:kick_player`.

Server → client: `session:state`, `hand:yours`, `position:yours`,
`phase:changed`, `book:updated`, `trade:executed`, `round:revealed`, `error`.

`create_session` and `join_session` reply through an acknowledgement callback;
trade and quote actions do too, so a rejection can be shown to the one player who
caused it instead of being broadcast.

### Reconnects

Each player gets an opaque token stored in `localStorage`. A refresh, a locked
phone, or a walk out of WiFi range reconnects to the **same** `playerId` and
receives the full state plus their private hand and position. Quotes are left
live across a disconnect — a phone briefly dropping WiFi should not silently pull
someone's market. Sessions are never torn down when the host disconnects; they
are only swept after three hours with nobody connected.

---

## Tests

```
npm.cmd test
```

(`npm.cmd`, not `npm` — see "PowerShell blocks npm" above.)

110 tests, no external services. Highlights, mapped to the PRD's acceptance
criteria:

- 20 players deal, quote, and trade concurrently; the round scores zero sum.
- No player's socket ever sees another player's cards or a pre-reveal true value.
- A quote update reaches other clients in well under a second.
- A stale-price lift is refused; with one-fill mode on, two simultaneous lifts
  produce exactly one trade and one clear error.
- Reveal P&L matches `(cash_end − starting_cash) + Σ(position × true value)`,
  hand-checked.
- A refreshed player rejoins with hand, cash, and position intact, and no phantom
  duplicate player appears.
- Next round resets trades, quotes, cash, and positions while the cumulative
  leaderboard carries over.
- A first-time joiner sees the rules before the lobby; a returning one does not,
  but can reopen them mid-round without leaving the trading view.

---

## Known limits (as specified)

One resting quote per player per commodity, 1-unit trades, no position or cash
limits, no persistence between sessions, and order books attributed by name.
All of these are explicit non-goals in the PRD rather than oversights.
