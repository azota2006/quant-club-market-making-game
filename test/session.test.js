'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { GameSession, SessionStore, GameError, normalizeConfig } = require('../server/session');

function newSession(overrides) {
  const session = new GameSession('TEST', Object.assign({ durationSec: 60 }, overrides));
  const a = session.addPlayer('Alice');
  const b = session.addPlayer('Bob');
  const c = session.addPlayer('Cara');
  return { session, a, b, c };
}

function tradingSession(overrides) {
  const ctx = newSession(overrides);
  ctx.session.dealRound();
  ctx.session.startTrading();
  return ctx;
}

test('duplicate names are rejected, case-insensitively', () => {
  const { session } = newSession();
  assert.throws(() => session.addPlayer('alice'), GameError);
  assert.throws(() => session.addPlayer('  Alice  '), GameError);
  assert.throws(() => session.addPlayer(''), GameError);
});

test('config is clamped to sane ranges', () => {
  const cfg = normalizeConfig({
    commodities: [{ id: 'H' }, { id: 'H' }, { id: 'X' }, { id: 'S' }],
    decks: 9,
    maxCardsPerPlayer: 999,
    startingCash: -5,
    durationSec: 1,
  });
  assert.deepEqual(cfg.commodities.map((c) => c.id), ['S', 'H'], 'deduped, unknown dropped, suit-ordered');
  assert.equal(cfg.decks, 4, 'clamped to the 4-deck maximum');
  assert.equal(cfg.maxCardsPerPlayer, 26);
  assert.equal(cfg.startingCash, 0);
  assert.equal(cfg.durationSec, 30);
});

test('1 through 4 decks are all accepted', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.equal(normalizeConfig({ decks: n }).decks, n);
  }
  assert.equal(normalizeConfig({ decks: 0 }).decks, 1, 'clamped up');
  assert.equal(normalizeConfig({ decks: 5 }).decks, 4, 'clamped down');
  assert.equal(normalizeConfig({ decks: 'abc' }).decks, 2, 'falls back to the default');
});

test('3 and 4 decks build bigger decks and deal bigger hands', () => {
  const session = new GameSession('BIG', { decks: 4 });
  for (let i = 0; i < 20; i += 1) session.addPlayer('P' + i);
  session.dealRound();

  const state = session.publicState();
  assert.equal(state.deckSize, 4 * 13 * 4, '4 suits x 4 decks = 208 cards');
  assert.equal(state.cardsPerPlayer, 8, '20 players can still take a full 8-card hand');
  assert.equal(Object.keys(session.hands).length, 20);
  assert.equal(session.discarded.length, 208 - 160);

  // A full suit is now worth 4 x 91, and dealt + discarded must reconstitute it.
  session.startTrading();
  session.endRound();
  session.reveal();
  for (const cid of ['S', 'H', 'D', 'C']) {
    const b = session.valueBreakdown[cid];
    assert.equal(b.sum + b.discardedSum, 91 * 4);
    assert.equal(b.dealtCount + b.discardedCount, 13 * 4);
  }
});

test('more decks let a 20-player table keep full hands', () => {
  const sizes = {};
  for (const decks of [1, 2, 3, 4]) {
    const s = new GameSession('T' + decks, { decks });
    for (let i = 0; i < 20; i += 1) s.addPlayer('P' + i);
    s.dealRound();
    sizes[decks] = s.cardsPerPlayer;
  }
  assert.deepEqual(sizes, { 1: 2, 2: 5, 3: 7, 4: 8 });
});

test('fewer than two valid commodities falls back to the default four', () => {
  assert.equal(normalizeConfig({ commodities: [{ id: 'H' }] }).commodities.length, 4);
});

test('dealing needs at least two players in the round', () => {
  const session = new GameSession('SOLO', {});
  session.addPlayer('Only', { isHost: true });
  assert.throws(() => session.dealRound(), GameError);
});

test('the host is dealt in only when host also plays', () => {
  const session = new GameSession('HOST', { hostPlays: false });
  const host = session.addPlayer('Host', { isHost: true });
  session.addPlayer('P1');
  session.addPlayer('P2');
  session.dealRound();
  assert.equal(session.isInRound(host.id), false);
  assert.equal(Object.keys(session.positions).length, 2);

  session.config.hostPlays = true;
  session.phase = 'lobby';
  session.dealRound();
  assert.equal(session.isInRound(host.id), true);
  assert.equal(Object.keys(session.positions).length, 3);
});

test('public state never carries hands, the deck, or pre-reveal true values', () => {
  const { session } = newSession();
  session.dealRound();
  const pub = session.publicState();
  const json = JSON.stringify(pub);

  assert.equal(pub.trueValues, null);
  assert.equal(pub.valueBreakdown, null);
  assert.equal(pub.hands, undefined);
  assert.equal(pub.deck, undefined);
  assert.equal(pub.discarded, undefined);
  assert.equal(pub.positions, undefined);
  assert.ok(!json.includes('"hands"'));
  assert.ok(!json.includes('"deck"'));

  // The public numbers a player needs for their own estimate are present.
  assert.equal(pub.cardsPerPlayer > 0, true);
  assert.equal(pub.playersInRound, 3);
  assert.equal(pub.deckSize, 104);
});

test('true values only appear in public state after reveal', () => {
  const { session } = newSession();
  session.dealRound();
  session.startTrading();
  assert.equal(session.publicState().trueValues, null);
  session.endRound();
  assert.equal(session.publicState().trueValues, null, 'still hidden while merely locked');
  session.reveal();
  assert.notEqual(session.publicState().trueValues, null);
});

test('quotes are rejected outside the trading phase', () => {
  const { session, a } = newSession();
  session.dealRound();
  assert.throws(() => session.updateQuote(a.id, 'H', 10, 20), /Trading is closed/);
  session.startTrading();
  session.updateQuote(a.id, 'H', 10, 20);
  session.endRound();
  assert.throws(() => session.updateQuote(a.id, 'H', 11, 21), /Trading is closed/);
});

test('inverted and negative quotes are rejected', () => {
  const { session, a } = tradingSession();
  assert.throws(() => session.updateQuote(a.id, 'H', 20, 20), /bid must be below/);
  assert.throws(() => session.updateQuote(a.id, 'H', 25, 20), /bid must be below/);
  assert.throws(() => session.updateQuote(a.id, 'H', -1, 20), /cannot be negative/);
  assert.throws(() => session.updateQuote(a.id, 'H', 'abc', 20), /must be numbers/);
});

test('one-sided quotes and clearing both sides work', () => {
  const { session, a } = tradingSession();
  session.updateQuote(a.id, 'H', 10, null);
  assert.deepEqual(session.quotes.H[a.id], { bid: 10, ask: null });
  session.updateQuote(a.id, 'H', null, 30);
  assert.deepEqual(session.quotes.H[a.id], { bid: null, ask: 30 });
  session.updateQuote(a.id, 'H', null, null);
  assert.equal(session.quotes.H[a.id], undefined);
});

test('a lift moves cash and position in opposite directions', () => {
  const { session, a, b } = tradingSession({ startingCash: 1000 });
  session.updateQuote(b.id, 'H', 160, 168);
  session.executeTrade(a.id, 'H', b.id, 'lift', 168);

  assert.equal(session.positions[a.id].cash, 1000 - 168);
  assert.equal(session.positions[a.id].holdings.H, 1);
  assert.equal(session.positions[b.id].cash, 1000 + 168);
  assert.equal(session.positions[b.id].holdings.H, -1);

  const trade = session.trades[0];
  assert.equal(trade.buyerId, a.id);
  assert.equal(trade.sellerId, b.id);
  assert.equal(trade.price, 168);
});

test('a hit is the mirror image of a lift', () => {
  const { session, a, b } = tradingSession({ startingCash: 0 });
  session.updateQuote(b.id, 'H', 160, 168);
  session.executeTrade(a.id, 'H', b.id, 'hit', 160);

  assert.equal(session.positions[a.id].cash, 160);
  assert.equal(session.positions[a.id].holdings.H, -1);
  assert.equal(session.positions[b.id].cash, -160);
  assert.equal(session.positions[b.id].holdings.H, 1);
  assert.equal(session.trades[0].buyerId, b.id);
});

test('you cannot trade against your own quote', () => {
  const { session, a } = tradingSession();
  session.updateQuote(a.id, 'H', 160, 168);
  assert.throws(() => session.executeTrade(a.id, 'H', a.id, 'lift', 168), /your own quote/);
});

test('a stale price is rejected rather than filled at the new one', () => {
  const { session, a, b } = tradingSession();
  session.updateQuote(b.id, 'H', 160, 168);
  session.updateQuote(b.id, 'H', 170, 180); // Bob moved his market

  assert.throws(
    () => session.executeTrade(a.id, 'H', b.id, 'lift', 168),
    /quote moved/,
    'the client still showing 168 must not get filled at 180',
  );
  assert.equal(session.trades.length, 0);
  session.executeTrade(a.id, 'H', b.id, 'lift', 180);
  assert.equal(session.trades.length, 1);
});

test('trading against a pulled quote is rejected', () => {
  const { session, a, b } = tradingSession();
  session.updateQuote(b.id, 'H', 160, 168);
  session.updateQuote(b.id, 'H', 160, null);
  assert.throws(() => session.executeTrade(a.id, 'H', b.id, 'lift', 168), /no longer available/);
});

test('standing quotes (the v1 default) can be filled repeatedly', () => {
  const { session, a, b, c } = tradingSession({ startingCash: 0 });
  session.updateQuote(b.id, 'H', 160, 168);
  session.executeTrade(a.id, 'H', b.id, 'lift', 168);
  session.executeTrade(c.id, 'H', b.id, 'lift', 168);
  session.executeTrade(a.id, 'H', b.id, 'lift', 168);

  assert.equal(session.trades.length, 3);
  assert.equal(session.positions[b.id].holdings.H, -3);
  assert.equal(session.positions[b.id].cash, 504);
});

test('with one-fill-per-quote on, the second lift finds nothing there', () => {
  const { session, a, b, c } = tradingSession({ oneFillPerQuote: true });
  session.updateQuote(b.id, 'H', 160, 168);
  session.executeTrade(a.id, 'H', b.id, 'lift', 168);

  assert.throws(() => session.executeTrade(c.id, 'H', b.id, 'lift', 168), /no longer available/);
  assert.equal(session.trades.length, 1);
  assert.equal(session.quotes.H[b.id].ask, null);
  assert.equal(session.quotes.H[b.id].bid, 160, 'the untouched side stays live');
});

test('trading is impossible once the round is locked', () => {
  const { session, a, b } = tradingSession();
  session.updateQuote(b.id, 'H', 160, 168);
  session.endRound();
  assert.throws(() => session.executeTrade(a.id, 'H', b.id, 'lift', 168), /Trading is closed/);
});

test('a mid-round joiner gets no cards and cannot trade until the next deal', () => {
  const { session, a } = tradingSession();
  const late = session.addPlayer('Late');

  assert.equal(session.isInRound(late.id), false);
  assert.equal(session.hands[late.id], undefined);
  assert.throws(() => session.updateQuote(late.id, 'H', 1, 2), /not in this round/);
  assert.throws(() => session.executeTrade(late.id, 'H', a.id, 'lift', 5), /not in this round/);

  session.reveal();
  session.nextRound();
  assert.equal(session.isInRound(late.id), true);
  assert.equal(session.hands[late.id].length > 0, true);
});

test('reveal scores the formula from the PRD by hand', () => {
  const { session, a, b } = tradingSession({ startingCash: 100 });
  session.trueValues = { S: 50, H: 172, D: 60, C: 70 };

  session.updateQuote(b.id, 'H', 160, 168);
  session.executeTrade(a.id, 'H', b.id, 'lift', 168); // Alice buys 1 H at 168

  const results = session.reveal();
  // Alice: cash 100 -> -68, so delta is -168; inventory +1 H at 172; P&L = -168 + 172 = +4
  assert.equal(results[a.id].cash, -68);
  assert.equal(results[a.id].cashDelta, -168);
  assert.equal(results[a.id].markToMarket, 172);
  assert.equal(results[a.id].pnl, 4);
  // Bob: delta +168, inventory -172, P&L -4
  assert.equal(results[b.id].pnl, -4);
  // Cara never traded.
  assert.equal(Object.values(results).reduce((x, r) => x + r.pnl, 0), 0);
});

test('cumulative leaderboard adds up across rounds and survives the reset', () => {
  const { session, a, b } = tradingSession({ startingCash: 0 });
  session.trueValues = { S: 0, H: 100, D: 0, C: 0 };
  session.updateQuote(b.id, 'H', 80, 90);
  session.executeTrade(a.id, 'H', b.id, 'lift', 90); // Alice +10, Bob -10
  session.reveal();
  assert.equal(session.cumulative[a.id], 10);

  session.nextRound();
  assert.equal(session.round, 2);
  assert.equal(session.phase, 'dealt');
  assert.equal(session.trades.length, 0, 'trades reset');
  assert.deepEqual(session.quotes.H, {}, 'quotes reset');
  assert.equal(session.positions[a.id].cash, 0, 'cash reset');
  assert.equal(session.positions[a.id].holdings.H, 0, 'position reset');
  assert.equal(session.cumulative[a.id], 10, 'cumulative preserved');

  session.startTrading();
  session.trueValues = { S: 0, H: 100, D: 0, C: 0 };
  session.updateQuote(b.id, 'H', 80, 90);
  session.executeTrade(a.id, 'H', b.id, 'lift', 90);
  session.reveal();
  assert.equal(session.cumulative[a.id], 20);

  const board = session.leaderboard();
  assert.equal(board[0].name, 'Alice');
  assert.equal(board[0].total, 20);
  assert.equal(board[board.length - 1].name, 'Bob');
});

test('round history records each round P&L, true values and trade count', () => {
  const { session, a, b } = tradingSession({ startingCash: 0 });
  assert.deepEqual(session.roundHistory, []);

  session.trueValues = { S: 0, H: 100, D: 0, C: 0 };
  session.updateQuote(b.id, 'H', 80, 90);
  session.executeTrade(a.id, 'H', b.id, 'lift', 90);
  session.reveal();

  assert.equal(session.roundHistory.length, 1);
  const r1 = session.roundHistory[0];
  assert.equal(r1.round, 1);
  assert.equal(r1.pnl[a.id], 10);
  assert.equal(r1.pnl[b.id], -10);
  assert.equal(r1.trueValues.H, 100);
  assert.equal(r1.tradeCount, 1);

  session.nextRound();
  assert.equal(session.roundHistory.length, 1, 'history survives the round reset');
  session.startTrading();
  session.trueValues = { S: 0, H: 50, D: 0, C: 0 };
  session.updateQuote(b.id, 'H', 40, 45);
  session.executeTrade(a.id, 'H', b.id, 'lift', 45);
  session.reveal();

  assert.equal(session.roundHistory.length, 2);
  assert.equal(session.roundHistory[1].round, 2);
  assert.equal(session.roundHistory[1].pnl[a.id], 5);
  assert.equal(session.roundHistory[0].pnl[a.id], 10, 'round 1 is not overwritten');

  // The history columns must reconcile with the cumulative leaderboard.
  const total = session.roundHistory.reduce((sum, r) => sum + r.pnl[a.id], 0);
  assert.equal(total, session.cumulative[a.id]);
});

test('the whole tape is published at reveal so players can review it', () => {
  const { session, a, b } = tradingSession({ startingCash: 0 });
  session.updateQuote(b.id, 'H', 80, 90);
  for (let i = 0; i < 95; i += 1) session.executeTrade(a.id, 'H', b.id, 'lift', 90);

  assert.equal(session.publicState().trades.length, 80, 'trimmed while trading');
  session.reveal();
  assert.equal(session.publicState().trades.length, 95, 'complete once revealed');
});

test('per-trade P&L sums to the round P&L for every player', () => {
  const { session, a, b, c } = tradingSession({ startingCash: 0 });
  session.trueValues = { S: 30, H: 100, D: 40, C: 50 };
  session.updateQuote(b.id, 'H', 80, 90);
  session.updateQuote(c.id, 'S', 20, 35);
  session.executeTrade(a.id, 'H', b.id, 'lift', 90);
  session.executeTrade(a.id, 'H', b.id, 'hit', 80);
  session.executeTrade(a.id, 'S', c.id, 'lift', 35);

  const results = session.reveal();
  for (const player of [a, b, c]) {
    const fromTape = session.trades.reduce((sum, t) => {
      const v = session.trueValues[t.commodityId];
      if (t.buyerId === player.id) return sum + (v - t.price);
      if (t.sellerId === player.id) return sum + (t.price - v);
      return sum;
    }, 0);
    assert.equal(fromTape, results[player.id].pnl, `${player.name}'s trades explain their P&L`);
  }
});

test('phase transitions reject out-of-order host actions', () => {
  const { session } = newSession();
  assert.throws(() => session.startTrading(), GameError);
  assert.throws(() => session.reveal(), GameError);
  session.dealRound();
  assert.throws(() => session.nextRound(), GameError);
  assert.throws(() => session.endRound(), GameError);
  session.startTrading();
  assert.throws(() => session.dealRound(), GameError);
});

test('a player token identifies a returning player', () => {
  const { session, a } = newSession();
  assert.equal(session.playerByToken(a.token).id, a.id);
  assert.equal(session.playerByToken('nope'), null);
  assert.equal(session.playerByToken(undefined), null);
});

test('the session store hands out distinct codes and finds them case-insensitively', () => {
  const store = new SessionStore();
  const { session, host } = store.create('Host', {});
  assert.equal(host.isHost, true);
  assert.equal(session.code.length, 4);
  assert.equal(store.get(session.code.toLowerCase()).code, session.code);
  assert.equal(store.get('    '), null);
  assert.equal(store.get(null), null);
});

test('marks report the last traded price per commodity', () => {
  const { session, a, b } = tradingSession();
  session.updateQuote(b.id, 'H', 160, 168);
  session.executeTrade(a.id, 'H', b.id, 'lift', 168);
  session.updateQuote(b.id, 'H', 170, 178);
  session.executeTrade(a.id, 'H', b.id, 'lift', 178);
  assert.deepEqual(session.marks(), { H: 178 });
});
