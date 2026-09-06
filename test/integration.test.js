'use strict';

/**
 * End-to-end tests over a real Socket.IO connection, covering the acceptance
 * criteria in §12 of the PRD that unit tests can't reach: what actually goes
 * over the wire, the stale-quote race, and reconnect.
 */

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert');

const quiet = console.log;
console.log = function () {};
const { server, io: ioServer } = require('../server/index.js');
console.log = quiet;

const { io: Client } = require('socket.io-client');

let baseUrl = '';
const openClients = [];

function ready() {
  return new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const c = Client(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
    c.log = [];
    c.onAny((event, payload) => c.log.push({ event, payload }));
    c.once('connect', () => { openClients.push(c); resolve(c); });
    c.once('connect_error', reject);
  });
}

function emit(client, event, payload) {
  return new Promise((resolve) => {
    client.emit(event, payload || {}, resolve);
  });
}

/**
 * Resolve on a matching event — including one that already arrived. Broadcasts
 * land before the ack callback fires, so a listener attached after an await
 * would otherwise miss the very event it is waiting for.
 */
function waitFor(client, event, predicate, timeoutMs = 3000) {
  for (let i = client.log.length - 1; i >= 0; i -= 1) {
    const entry = client.log[i];
    if (entry.event === event && (!predicate || predicate(entry.payload))) {
      return Promise.resolve(entry.payload);
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function onEvent(payload) {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      client.off(event, onEvent);
      resolve(payload);
    }
    client.on(event, onEvent);
  });
}

/** Recursively find anything shaped like a playing card. */
function findCards(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((v) => findCards(v, found));
    return found;
  }
  if ('suit' in value && 'rank' in value && 'value' in value) found.push(value);
  Object.keys(value).forEach((k) => findCards(value[k], found));
  return found;
}

async function newGame(config) {
  const host = await connect();
  const created = await emit(host, 'create_session', {
    hostName: 'Hostie',
    config: Object.assign({ durationSec: 600, startingCash: 0 }, config),
  });
  assert.ok(created.ok, created.error);
  return { host, code: created.sessionCode, hostId: created.playerId, hostToken: created.token };
}

async function joinAs(code, name) {
  const c = await connect();
  const res = await emit(c, 'join_session', { sessionCode: code, playerName: name });
  assert.ok(res.ok, res.error);
  c.identity = res;
  return c;
}

test.before(async () => {
  await ready();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  openClients.forEach((c) => c.close());
  await new Promise((resolve) => ioServer.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------

test('a host creates a game and players join with a 4-character code', async () => {
  const { host, code } = await newGame();
  assert.match(code, /^[A-Z2-9]{4}$/);

  const alice = await joinAs(code, 'Alice');
  assert.ok(alice.identity.playerId);
  assert.equal(alice.identity.isHost, false);
  assert.equal(alice.identity.seenRules, false);

  const state = await waitFor(host, 'session:state', (s) => s.players.length === 2);
  assert.deepEqual(state.players.map((p) => p.name), ['Hostie', 'Alice']);
});

test('a duplicate name is refused with a readable message', async () => {
  const { code } = await newGame();
  await joinAs(code, 'Alice');
  const dupe = await connect();
  const res = await emit(dupe, 'join_session', { sessionCode: code, playerName: 'alice' });
  assert.equal(res.ok, false);
  assert.match(res.error, /already taken/);
});

test('joining a code that does not exist fails cleanly', async () => {
  const c = await connect();
  const res = await emit(c, 'join_session', { sessionCode: 'ZZZZ', playerName: 'Nobody' });
  assert.equal(res.ok, false);
  assert.match(res.error, /No game found/);
});

test('after the deal a player receives only their own cards, and no true values', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');

  await emit(host, 'host:deal');
  const dealt = (p) => p.cards.length > 0;
  const aHand = await waitFor(alice, 'hand:yours', dealt);
  const bHand = await waitFor(bob, 'hand:yours', dealt);

  assert.ok(aHand.cards.length > 0);
  assert.equal(aHand.cards.length, bHand.cards.length);

  // Every card Bob's socket ever saw must be a card from Bob's own hand.
  const bobsOwn = new Set(bHand.cards.map((c) => c.suit + c.rank));
  const leaked = bob.log
    .filter((entry) => entry.event !== 'hand:yours')
    .flatMap((entry) => findCards(entry.payload));
  assert.equal(leaked.length, 0, `cards appeared in ${leaked.length} non-hand payloads`);

  // Sanity check that the detector would actually catch a leak.
  assert.equal(findCards({ deck: bHand.cards }).length, bHand.cards.length);
  assert.ok(bobsOwn.size > 0);

  // No pre-reveal true values anywhere in Bob's traffic.
  for (const entry of bob.log) {
    if (entry.payload && Object.prototype.hasOwnProperty.call(entry.payload, 'trueValues')) {
      assert.equal(entry.payload.trueValues, null, 'true values leaked before reveal');
    }
  }
});

test('quote updates reach other clients in well under a second', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  const started = Date.now();
  const seen = waitFor(bob, 'book:updated', (p) => p.commodityId === 'H');
  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 160, ask: 168 });
  const payload = await seen;

  assert.ok(Date.now() - started < 1000, 'propagation should be sub-second');
  assert.equal(payload.quotes[alice.identity.playerId].bid, 160);
  assert.equal(payload.quotes[alice.identity.playerId].ask, 168);
});

test('an inverted quote is rejected over the wire', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  const res = await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 200, ask: 100 });
  assert.equal(res.ok, false);
  assert.match(res.error, /bid must be below/);
});

test('a lift at a stale price is refused instead of filled at the new price', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 160, ask: 168 });
  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 175, ask: 185 });

  const res = await emit(bob, 'player:lift_ask', {
    commodityId: 'H',
    counterpartyId: alice.identity.playerId,
    expectedPrice: 168,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /moved/);

  const good = await emit(bob, 'player:lift_ask', {
    commodityId: 'H',
    counterpartyId: alice.identity.playerId,
    expectedPrice: 185,
  });
  assert.equal(good.ok, true);
  assert.equal(good.trade.price, 185);
});

test('two simultaneous lifts on a one-fill quote produce exactly one trade', async () => {
  const { host, code } = await newGame({ oneFillPerQuote: true });
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');
  const cara = await joinAs(code, 'Cara');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');
  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 160, ask: 168 });

  const req = {
    commodityId: 'H',
    counterpartyId: alice.identity.playerId,
    expectedPrice: 168,
  };
  const [r1, r2] = await Promise.all([
    emit(bob, 'player:lift_ask', req),
    emit(cara, 'player:lift_ask', req),
  ]);

  const wins = [r1, r2].filter((r) => r.ok);
  const losses = [r1, r2].filter((r) => !r.ok);
  assert.equal(wins.length, 1, 'exactly one fill');
  assert.equal(losses.length, 1, 'the loser gets an error, not a duplicate fill');
  assert.match(losses[0].error, /no longer available/);
});

test('standing quotes fill repeatedly — the documented v1 default', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');
  const cara = await joinAs(code, 'Cara');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');
  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 160, ask: 168 });

  const req = { commodityId: 'H', counterpartyId: alice.identity.playerId, expectedPrice: 168 };
  const results = await Promise.all([
    emit(bob, 'player:lift_ask', req),
    emit(cara, 'player:lift_ask', req),
    emit(bob, 'player:lift_ask', req),
  ]);
  assert.ok(results.every((r) => r.ok), 'a standing quote stays tradeable');
});

test('you cannot trade against your own quote over the wire', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');
  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 160, ask: 168 });

  const res = await emit(alice, 'player:lift_ask', {
    commodityId: 'H',
    counterpartyId: alice.identity.playerId,
    expectedPrice: 168,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /your own quote/);
});

test('trading is refused before the host opens the market and after it closes', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  await joinAs(code, 'Bob');
  await emit(host, 'host:deal');

  const early = await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 1, ask: 2 });
  assert.equal(early.ok, false);
  assert.match(early.error, /Trading is closed/);

  await emit(host, 'host:start_trading');
  assert.equal((await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 1, ask: 2 })).ok, true);

  await emit(host, 'host:end_round');
  const late = await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 3, ask: 4 });
  assert.equal(late.ok, false);
});

test('only the host can drive the phase machine', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  await joinAs(code, 'Bob');

  const res = await emit(alice, 'host:deal');
  assert.equal(res.ok, false);
  assert.match(res.error, /Only the host/);
  assert.equal((await emit(alice, 'host:reveal')).ok, false);
  assert.equal((await emit(alice, 'host:end_session')).ok, false);
  assert.equal((await emit(host, 'host:deal')).ok, true);
});

test('reveal publishes true values and a P&L table that matches the formula', async () => {
  const { host, code } = await newGame({ startingCash: 500 });
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 100, ask: 110 });
  const fill = await emit(bob, 'player:lift_ask', {
    commodityId: 'H',
    counterpartyId: alice.identity.playerId,
    expectedPrice: 110,
  });
  assert.ok(fill.ok);

  await emit(host, 'host:end_round');
  const revealed = waitFor(bob, 'round:revealed');
  await emit(host, 'host:reveal');
  const payload = await revealed;

  const trueH = payload.trueValues.H;
  assert.equal(typeof trueH, 'number');

  const byId = {};
  payload.roundResults.forEach((r) => { byId[r.playerId] = r; });
  const aliceRow = byId[alice.identity.playerId];
  const bobRow = byId[bob.identity.playerId];

  // Alice sold one at 110 from flat; Bob bought it.
  assert.equal(aliceRow.cashDelta, 110);
  assert.equal(aliceRow.markToMarket, -trueH);
  assert.equal(aliceRow.pnl, 110 - trueH);
  assert.equal(bobRow.cashDelta, -110);
  assert.equal(bobRow.pnl, trueH - 110);

  const total = payload.roundResults.reduce((a, r) => a + r.pnl, 0);
  assert.equal(total, 0, 'zero sum');

  // Reconstitute the true value: dealt sum + discarded sum is the whole suit.
  const b = payload.valueBreakdown.H;
  assert.equal(b.sum, trueH);
  assert.equal(b.sum + b.discardedSum, 91 * 2, 'two decks of hearts total 182');
});

test('next round resets the round but keeps the cumulative leaderboard', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');
  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 100, ask: 110 });
  await emit(bob, 'player:lift_ask', {
    commodityId: 'H', counterpartyId: alice.identity.playerId, expectedPrice: 110,
  });
  await emit(host, 'host:end_round');
  await emit(host, 'host:reveal');

  const afterReveal = await waitFor(host, 'session:state', (s) => s.phase === 'revealed');
  const carried = afterReveal.cumulativeLeaderboard.slice();
  assert.equal(carried.length, 2);

  const next = waitFor(host, 'session:state', (s) => s.phase === 'dealt' && s.round === 2);
  await emit(host, 'host:next_round');
  const state = await next;

  assert.equal(state.round, 2);
  assert.equal(state.trades.length, 0);
  assert.deepEqual(state.quotes.H, {});
  assert.equal(state.trueValues, null, 'the new round hides its values again');
  assert.deepEqual(
    state.cumulativeLeaderboard.map((r) => [r.name, r.total]).sort(),
    carried.map((r) => [r.name, r.total]).sort(),
    'cumulative totals survive the reset',
  );
});

test('a refreshed player rejoins with the same id, hand, cash and position', async () => {
  const { host, code } = await newGame({ startingCash: 250 });
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  const originalHand = await waitFor(alice, 'hand:yours', (p) => p.cards.length > 0);

  await emit(bob, 'player:update_quote', { commodityId: 'H', bid: 90, ask: 95 });
  await emit(alice, 'player:hit_bid', {
    commodityId: 'H', counterpartyId: bob.identity.playerId, expectedPrice: 90,
  });

  // Simulate a browser refresh: drop the socket, reconnect with the stored token.
  alice.close();
  const revived = await connect();
  const res = await emit(revived, 'join_session', {
    sessionCode: code,
    playerName: 'Alice',
    token: alice.identity.token,
  });

  assert.ok(res.ok, res.error);
  assert.equal(res.playerId, alice.identity.playerId, 'same player, not a duplicate');
  assert.equal(res.state.players.length, 3, 'no phantom extra player');

  const hand = await waitFor(revived, 'hand:yours');
  const position = await waitFor(revived, 'position:yours');
  assert.deepEqual(
    hand.cards.map((c) => c.suit + c.rank).sort(),
    originalHand.cards.map((c) => c.suit + c.rank).sort(),
  );
  assert.equal(position.position.cash, 250 + 90, 'cash from the earlier sale is intact');
  assert.equal(position.position.holdings.H, -1, 'short position is intact');
});

test('the full tape and the per-round P&L history reach clients after reveal', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  const bob = await joinAs(code, 'Bob');

  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');
  await emit(alice, 'player:update_quote', { commodityId: 'H', bid: 100, ask: 110 });
  for (let i = 0; i < 3; i += 1) {
    await emit(bob, 'player:lift_ask', {
      commodityId: 'H', counterpartyId: alice.identity.playerId, expectedPrice: 110,
    });
  }
  await emit(host, 'host:end_round');
  await emit(host, 'host:reveal');

  const state = await waitFor(bob, 'session:state', (s) => s.phase === 'revealed');
  assert.equal(state.trades.length, 3, 'players get the whole round tape to review');
  assert.equal(state.roundHistory.length, 1);
  assert.equal(state.roundHistory[0].round, 1);
  assert.equal(state.roundHistory[0].tradeCount, 3);

  // Each trade's P&L, summed, must equal what the leaderboard says.
  const trueH = state.trueValues.H;
  const bobFromTape = state.trades.reduce((sum, t) => {
    if (t.buyerId === bob.identity.playerId) return sum + (trueH - t.price);
    if (t.sellerId === bob.identity.playerId) return sum + (t.price - trueH);
    return sum;
  }, 0);
  const bobRow = state.roundResults.find((r) => r.playerId === bob.identity.playerId);
  assert.equal(bobFromTape, bobRow.pnl, "the tape explains Bob's round P&L exactly");
  assert.equal(state.roundHistory[0].pnl[bob.identity.playerId], bobRow.pnl);

  // A second round appends rather than replacing.
  await emit(host, 'host:next_round');
  await emit(host, 'host:start_trading');
  await emit(host, 'host:end_round');
  await emit(host, 'host:reveal');

  const later = await waitFor(host, 'session:state', (s) => s.roundHistory.length === 2);
  assert.deepEqual(later.roundHistory.map((r) => r.round), [1, 2]);
  assert.equal(later.roundHistory[0].tradeCount, 3, 'round 1 record is untouched');
  assert.equal(later.roundHistory[1].tradeCount, 0);
});

test('a player joining mid-round waits for the next deal', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  const late = await joinAs(code, 'Late');
  const state = await waitFor(late, 'session:state');
  const lateRow = state.players.find((p) => p.id === late.identity.playerId);
  assert.equal(lateRow.inRound, false);

  const res = await emit(late, 'player:update_quote', { commodityId: 'H', bid: 1, ask: 2 });
  assert.equal(res.ok, false);
  assert.match(res.error, /not in this round/);

  const aliceRow = state.players.find((p) => p.id === alice.identity.playerId);
  assert.equal(aliceRow.inRound, true);
});

test('a rejection with no ack callback comes back as an "error" event', async () => {
  // The client posts quotes fire-and-forget, so this is the path a player
  // actually hits when the server refuses an inverted market.
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  await joinAs(code, 'Bob');
  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  const errored = waitFor(alice, 'error');
  alice.emit('player:update_quote', { commodityId: 'H', bid: 200, ask: 100 });
  const payload = await errored;
  assert.match(payload.message, /bid must be below/);
});

test('a removed player is reset, and the name is freed for a rejoin', async () => {
  const { host, code } = await newGame();
  const alice = await joinAs(code, 'Alice');
  await joinAs(code, 'Bob');

  const removed = waitFor(alice, 'session:removed');
  await emit(host, 'host:kick_player', { playerId: alice.identity.playerId });
  const payload = await removed;
  assert.match(payload.message, /removed you from the game/);

  const state = await waitFor(host, 'session:state', (s) => s.players.length === 2);
  assert.ok(!state.players.some((p) => p.name === 'Alice'));

  // Removal tidies the roster; it is not a ban.
  const back = await joinAs(code, 'Alice');
  assert.notEqual(back.identity.playerId, alice.identity.playerId);
});

test('the host cannot be removed', async () => {
  const { host, code, hostId } = await newGame();
  await joinAs(code, 'Alice');
  const res = await emit(host, 'host:kick_player', { playerId: hostId });
  assert.equal(res.ok, false);
  assert.match(res.error, /Cannot remove/);
});

test('the network endpoint gives the host a join URL and a QR code', async () => {
  const res = await fetch(`${baseUrl}/api/network`);
  const info = await res.json();
  assert.ok(typeof info.url === 'string' && info.url.startsWith('http://'));
  assert.ok(Array.isArray(info.addresses));
  if (info.qr) assert.match(info.qr, /^data:image\/png;base64,/);
});

test('a 20-player table deals, quotes and trades without dropping anything', async () => {
  const { host, code } = await newGame({ maxCardsPerPlayer: 5 });
  const players = [];
  for (let i = 0; i < 20; i += 1) players.push(await joinAs(code, `P${i}`));

  await emit(host, 'host:deal');
  await emit(host, 'host:start_trading');

  const hands = await Promise.all(
    players.map((p) => waitFor(p, 'hand:yours', (x) => x.cards.length > 0)),
  );
  hands.forEach((hand) => assert.equal(hand.cards.length, 5));

  const quotes = await Promise.all(
    players.map((p, i) => emit(p, 'player:update_quote', {
      commodityId: 'S', bid: 100 + i, ask: 200 + i,
    })),
  );
  assert.ok(quotes.every((q) => q.ok));

  // Everyone lifts P19's ask at the same moment; standing quotes take all of it.
  const target = players[19];
  const fills = await Promise.all(
    players.slice(0, 19).map((p) => emit(p, 'player:lift_ask', {
      commodityId: 'S',
      counterpartyId: target.identity.playerId,
      expectedPrice: 219,
    })),
  );
  assert.equal(fills.filter((f) => f.ok).length, 19);

  await emit(host, 'host:end_round');
  const revealed = waitFor(host, 'round:revealed');
  await emit(host, 'host:reveal');
  const payload = await revealed;

  assert.equal(payload.roundResults.length, 20);
  assert.equal(payload.roundResults.reduce((a, r) => a + r.pnl, 0), 0);
  const seller = payload.roundResults.find((r) => r.playerId === target.identity.playerId);
  assert.equal(seller.holdings.S, -19);
  assert.equal(seller.cashDelta, 219 * 19);
});
