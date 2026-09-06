'use strict';

/**
 * Drives public/app.js inside jsdom against a fake socket, so the render paths
 * (host dashboard, trading view, reveal) are exercised the way a browser would.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

const CFG = {
  commodities: [{ id: 'S', displayName: '' }, { id: 'H', displayName: 'Rubies' }],
  decks: 1,
  maxCardsPerPlayer: 8,
  startingCash: 0,
  durationSec: 480,
  oneFillPerQuote: false,
  hostPlays: false,
};

const HOST_ID = 'host-1';
const ME_ID = 'me-1';
const OTHER_ID = 'other-1';

function baseState(over) {
  return Object.assign({
    code: 'ABCD',
    round: 0,
    phase: 'lobby',
    config: CFG,
    players: [
      { id: HOST_ID, name: 'Hostie', isHost: true, connected: true, inRound: false },
      { id: ME_ID, name: 'Me', isHost: false, connected: true, inRound: false },
      { id: OTHER_ID, name: 'Rival', isHost: false, connected: true, inRound: false },
    ],
    quotes: { S: {}, H: {} },
    trades: [],
    marks: {},
    roundStartTime: null,
    roundEndTime: null,
    cardsPerPlayer: 0,
    playersInRound: 0,
    deckSize: 26,
    serverTime: Date.now(),
    trueValues: null,
    valueBreakdown: null,
    roundResults: null,
    cumulativeLeaderboard: [],
  }, over);
}

// Every booted window is closed at the end, even if a test throws before its
// own close() — an open jsdom window keeps timers alive and hangs the runner.
const booted = [];

/**
 * Boot app.js in a fresh DOM with a scriptable fake socket.
 * `opts.identity` seeds localStorage before the script runs, the way a real
 * browser would on a refresh.
 */
function boot(opts) {
  opts = opts || {};
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;
  booted.push(win);

  // Run render flushes inline so assertions can read the DOM immediately.
  win.requestAnimationFrame = (fn) => { fn(Date.now()); return 0; };
  win.cancelAnimationFrame = () => {};

  const sent = [];
  const listeners = {};
  const socket = {
    emit(event, payload, ack) {
      sent.push({ event, payload });
      if (typeof ack === 'function') {
        const canned = socket.acks[event];
        ack(canned ? canned(payload) : { ok: true });
      }
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
    off(event, fn) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
    // Realistic defaults so handlers get a full payload unless a test overrides.
    acks: {
      create_session: () => ({
        ok: true, sessionCode: 'ABCD', playerId: HOST_ID, token: 'tok',
        name: 'Hostie', isHost: true, seenRules: true, state: baseState(),
      }),
      join_session: () => ({
        ok: true, sessionCode: 'ABCD', playerId: ME_ID, token: 'tok',
        name: 'Me', isHost: false, seenRules: true, state: baseState(),
      }),
    },
  };

  win.io = () => socket;
  win.fetch = () => Promise.resolve({ json: () => Promise.resolve({ url: 'http://192.168.1.5:3000', addresses: [], port: 3000, qr: null }) });
  win.confirm = () => true;
  if (opts.identity) win.localStorage.setItem('mmg:identity', JSON.stringify(opts.identity));

  win.eval(APP);

  function fire(event, payload) {
    (listeners[event] || []).slice().forEach((fn) => fn(payload));
  }

  return {
    dom,
    win,
    doc: win.document,
    sent,
    socket,
    fire,
    connect() { fire('connect'); },
    $(sel) { return win.document.querySelector(sel); },
    $$(sel) { return Array.from(win.document.querySelectorAll(sel)); },
    activeScreen() {
      const el = win.document.querySelector('.screen.active');
      return el ? el.id.replace('screen-', '') : null;
    },
    text(sel) {
      const el = win.document.querySelector(sel);
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
    },
    close() { win.close(); },
  };
}

test.after(() => {
  booted.forEach((win) => {
    try { win.close(); } catch (e) { /* already closed */ }
  });
});

/** Join as a normal player and land in the given state. */
function joinAs(app, state, opts) {
  opts = opts || {};
  app.socket.acks.join_session = () => ({
    ok: true,
    sessionCode: state.code,
    playerId: opts.playerId || ME_ID,
    token: 'tok',
    name: opts.name || 'Me',
    isHost: !!opts.isHost,
    seenRules: opts.seenRules !== false,
    state,
  });
  app.connect();
  app.$('#join-code').value = state.code;
  app.$('#join-name').value = opts.name || 'Me';
  app.$('#join-form').dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));
}

function dealtState(over) {
  return baseState(Object.assign({
    round: 1,
    phase: 'trading',
    cardsPerPlayer: 8,
    playersInRound: 3,
    roundStartTime: Date.now(),
    roundEndTime: Date.now() + 480000,
    players: baseState().players.map((p) => Object.assign({}, p, { inRound: p.id !== HOST_ID })),
  }, over));
}

const HAND = {
  cards: [
    { suit: 'H', rank: 5, value: 5 },
    { suit: 'H', rank: 4, value: 4 },
    { suit: 'S', rank: 13, value: 13 },
  ],
  subtotals: { S: 13, H: 9 },
  round: 1,
};

// ---------------------------------------------------------------------------

test('the landing screen is what a player sees first', () => {
  const app = boot();
  assert.equal(app.activeScreen(), 'landing');
  assert.equal(app.$('#topbar').hidden, true);
  app.close();
});

test('the rules modal opens from the landing screen and lists all six sections', () => {
  const app = boot();
  app.$('#btn-show-rules').click();
  assert.equal(app.$('#rules').hidden, false);
  assert.equal(app.$$('#rules .rule').length, 6);
  assert.match(app.text('#rules'), /average.{0,3} rank 7/i);
  assert.match(app.text('#rules'), /158 \/ 168/);
  app.$('#rules-close').click();
  assert.equal(app.$('#rules').hidden, true);
  app.close();
});

test('a first-time joiner gets the rules automatically; a returning one does not', () => {
  const first = boot();
  joinAs(first, baseState(), { seenRules: false });
  assert.equal(first.$('#rules').hidden, false, 'shown before the lobby');
  assert.equal(first.$('#rules-got-it').hidden, false);
  first.$('#rules-got-it').click();
  assert.equal(first.$('#rules').hidden, true);
  assert.ok(first.sent.some((m) => m.event === 'player:seen_rules'));
  assert.equal(first.activeScreen(), 'lobby', 'dismissing lands in the lobby');
  first.close();

  const returning = boot();
  joinAs(returning, baseState(), { seenRules: true });
  assert.equal(returning.$('#rules').hidden, true);
  assert.equal(returning.activeScreen(), 'lobby');
  returning.close();
});

test('the rules link stays reachable mid-round without losing the trading view', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);
  assert.equal(app.activeScreen(), 'play');

  app.$('#top-rules').click();
  assert.equal(app.$('#rules').hidden, false);
  assert.equal(app.$('#rules-got-it').hidden, true, 'no first-run button for a returning reader');
  app.$('#rules-close').click();
  assert.equal(app.activeScreen(), 'play', 'still in the round');
  app.close();
});

test('the lobby shows the code, the roster and the public game numbers', () => {
  const app = boot();
  joinAs(app, baseState());
  assert.equal(app.activeScreen(), 'lobby');
  assert.equal(app.text('#lobby-code'), 'ABCD');
  assert.equal(app.$$('#lobby-roster li').length, 3);
  assert.match(app.text('#lobby-roster'), /Hostie/);
  assert.match(app.text('#lobby-params'), /Decks/);
  app.close();
});

test('the host lands on the dashboard with controls, code and QR panel', () => {
  const app = boot();
  joinAs(app, baseState(), { isHost: true, playerId: HOST_ID, name: 'Hostie' });
  assert.equal(app.activeScreen(), 'host');
  assert.equal(app.text('#host-code'), 'ABCD');
  const labels = app.$$('#host-controls .btn').map((b) => b.textContent);
  assert.deepEqual(labels, ['Deal cards', 'Start trading', 'End round', 'Reveal values', 'End session']);
  assert.equal(app.$$('#host-controls .btn')[0].disabled, false, 'two players present, can deal');
  assert.equal(app.$$('#host-controls .btn')[1].disabled, true, 'cannot start trading yet');
  app.close();
});

test('host controls emit the right phase events', () => {
  const app = boot();
  joinAs(app, baseState(), { isHost: true, playerId: HOST_ID, name: 'Hostie' });
  app.$$('#host-controls .btn')[0].click();
  assert.ok(app.sent.some((m) => m.event === 'host:deal'));

  app.fire('session:state', dealtState({ phase: 'dealt' }));
  app.$$('#host-controls .btn')[1].click();
  assert.ok(app.sent.some((m) => m.event === 'host:start_trading'));

  app.fire('session:state', dealtState({ phase: 'trading' }));
  app.$$('#host-controls .btn')[2].click();
  assert.ok(app.sent.some((m) => m.event === 'host:end_round'));

  app.fire('session:state', dealtState({ phase: 'locked' }));
  app.$$('#host-controls .btn')[3].click();
  assert.ok(app.sent.some((m) => m.event === 'host:reveal'));
  app.close();
});

test('round settings lock while a round is live and unlock between rounds', () => {
  const app = boot();
  joinAs(app, baseState(), { isHost: true, playerId: HOST_ID, name: 'Hostie' });
  assert.equal(app.$('#host-maxcards').disabled, false);
  assert.equal(app.$('#host-decks').value, '1', 'form reflects the session config');
  assert.equal(app.$('#host-duration').value, '8');

  app.fire('session:state', dealtState({ phase: 'trading' }));
  assert.equal(app.$('#host-maxcards').disabled, true);
  assert.equal(app.$('#host-save-config').disabled, true);

  app.fire('session:state', dealtState({ phase: 'revealed', trueValues: { S: 40, H: 50 } }));
  assert.equal(app.$('#host-maxcards').disabled, false, 'editable again between rounds');
  app.close();
});

test('both deck pickers offer 1 through 4 decks', () => {
  const app = boot();
  app.$('#btn-show-create').click();
  assert.deepEqual(
    app.$$('#cfg-decks option').map((o) => o.value), ['1', '2', '3', '4'],
  );
  assert.equal(app.$('#cfg-decks').value, '2', 'still defaults to 2');
  app.close();

  const host = boot();
  joinAs(host, baseState(), { isHost: true, playerId: HOST_ID, name: 'Hostie' });
  assert.deepEqual(
    host.$$('#host-decks option').map((o) => o.value), ['1', '2', '3', '4'],
  );
  host.close();
});

test('picking 4 decks is sent to the server', () => {
  const app = boot();
  app.$('#btn-show-create').click();
  app.$('#create-name').value = 'Hostie';
  app.$('#cfg-decks').value = '4';
  app.$('#create-form').dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));

  const create = app.sent.find((m) => m.event === 'create_session');
  assert.equal(create.payload.config.decks, 4);
  app.close();
});

test('the host preview shows what the current settings would deal', () => {
  const app = boot();
  const state = baseState();               // 2 commodities, 1 deck, 3 players
  state.config = Object.assign({}, CFG, { hostPlays: true });
  joinAs(app, state, { isHost: true, playerId: HOST_ID, name: 'Hostie' });

  // 2 suits x 1 deck = 26 cards, 3 playing, min(8, floor(26/3)=8) = 8 each.
  assert.match(app.text('#host-preview'), /26 cards · 3 playing · 8 cards each · 2 discarded/);

  // Adding decks gives the same table bigger hands and more discards.
  app.$('#host-decks').value = '4';
  app.$('#host-decks').dispatchEvent(new app.win.Event('change', { bubbles: true }));
  assert.match(app.text('#host-preview'), /104 cards · 3 playing · 8 cards each · 80 discarded/);
  app.close();
});

test('the preview warns when a setting would deal every card', () => {
  const app = boot();
  const state = baseState();
  state.config = Object.assign({}, CFG, { hostPlays: true, decks: 1 });
  joinAs(app, state, { isHost: true, playerId: HOST_ID, name: 'Hostie' });

  // 2 suits x 1 deck = 26 cards over 3 players: 8 each leaves 2 over.
  // Bumping to 26 cards each would still leave 2, but 2 suits x 1 deck with
  // max cards raised so 3 x k = 26 is impossible; use 13 cards each on 2 players.
  app.$('#host-maxcards').value = '13';
  app.$('#host-maxcards').dispatchEvent(new app.win.Event('input', { bubbles: true }));
  assert.match(app.text('#host-preview'), /26 cards · 3 playing · 8 cards each/,
    'floor(26/3)=8 still binds, so nothing is broken here');
  assert.ok(!app.text('#host-preview').includes('public knowledge'));

  // Now make it divide exactly: 2 players, 13 cards each, 26 cards, 0 discarded.
  app.fire('session:state', Object.assign(baseState(), {
    config: Object.assign({}, CFG, { hostPlays: true, decks: 1, maxCardsPerPlayer: 13 }),
    players: baseState().players.slice(0, 2),
  }));
  assert.match(app.text('#host-preview'), /0 discarded/);
  assert.match(app.text('#host-preview'), /public knowledge/);
  app.close();
});

test('the trading view shows the hand grouped by suit with visible subtotals', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);

  assert.equal(app.activeScreen(), 'play');
  const hand = app.text('#play-hand');
  assert.match(hand, /Rubies/, 'flavour name is used');
  assert.match(hand, /your cards sum to 9/);
  assert.match(hand, /your cards sum to 13/);
  assert.equal(app.$$('#play-hand .pcard').length, 3);
  app.close();
});

test('the game parameters panel is present and carries no computed fair value', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);

  const params = app.text('#play-params');
  assert.match(params, /Decks/);
  assert.match(params, /Cards each/);
  assert.match(params, /Players/);
  assert.match(params, /Discarded/);

  // The estimate is the player's job — no suggestion anywhere in the UI.
  const body = app.text('#play-body').toLowerCase();
  assert.ok(!body.includes('fair value'), 'no fair-value suggestion');
  assert.ok(!body.includes('estimated value'));
  assert.ok(!body.includes('suggested'));
  app.close();
});

test('posting a quote validates locally and emits update_quote', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);

  app.$('#bid-H').value = '160';
  app.$('#bid-H').dispatchEvent(new app.win.Event('input'));
  app.$('#ask-H').value = '168';
  app.$('#ask-H').dispatchEvent(new app.win.Event('input'));
  app.$('#send-H').click();

  const quote = app.sent.filter((m) => m.event === 'player:update_quote').pop();
  assert.deepEqual(quote.payload, { commodityId: 'H', bid: 160, ask: 168 });
  app.close();
});

test('an inverted quote is stopped before it reaches the server', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);

  app.$('#bid-H').value = '200';
  app.$('#bid-H').dispatchEvent(new app.win.Event('input'));
  app.$('#ask-H').value = '100';
  app.$('#ask-H').dispatchEvent(new app.win.Event('input'));
  app.$('#send-H').click();

  assert.equal(app.sent.filter((m) => m.event === 'player:update_quote').length, 0);
  assert.match(app.text('#toasts'), /bid must be below/);
  app.close();
});

test('quote inputs keep what you typed while the book updates around you', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);

  app.$('#bid-H').value = '155';
  app.$('#bid-H').dispatchEvent(new app.win.Event('input'));

  // Someone else's quote arrives mid-typing.
  app.fire('book:updated', { commodityId: 'H', quotes: { [OTHER_ID]: { bid: 150, ask: 158 } } });
  app.win.document.querySelector('#book-H');

  assert.equal(app.$('#bid-H').value, '155', 'half-typed price survives a book update');
  app.close();
});

test('the order book attributes quotes by name and offers Hit and Lift', () => {
  const app = boot();
  const state = dealtState();
  state.quotes.H = {
    [OTHER_ID]: { bid: 160, ask: 168 },
    [ME_ID]: { bid: 150, ask: 175 },
  };
  joinAs(app, state);
  app.fire('hand:yours', HAND);

  const book = app.text('#book-H');
  assert.match(book, /Rival/, 'quotes are attributed, not anonymous');
  assert.match(book, /you/, 'your own quote is marked');

  const bbo = app.text('#bbo-H');
  assert.match(bbo, /Hit .{0,3} sell to Rival/);
  assert.match(bbo, /Lift .{0,3} buy from Rival/);
  assert.equal(app.text('#myq-H').includes('150'), true, 'your own market is echoed back');
  app.close();
});

test('the best-quote buttons skip your own quote — you cannot trade yourself', () => {
  const app = boot();
  const state = dealtState();
  state.quotes.H = { [ME_ID]: { bid: 999, ask: 1000 } };
  joinAs(app, state);
  app.fire('hand:yours', HAND);

  const buttons = app.$$('#bbo-H .btn');
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((b) => b.disabled), 'nothing tradeable when only your quote rests');
  assert.match(app.text('#bbo-H'), /no bid/);
  assert.match(app.text('#bbo-H'), /no ask/);
  app.close();
});

test('lifting sends the price the client had on screen, for stale detection', () => {
  const app = boot();
  const state = dealtState();
  state.quotes.H = { [OTHER_ID]: { bid: 160, ask: 168 } };
  joinAs(app, state);
  app.fire('hand:yours', HAND);

  app.$$('#bbo-H .btn')[1].click();
  const lift = app.sent.filter((m) => m.event === 'player:lift_ask').pop();
  assert.deepEqual(lift.payload, { commodityId: 'H', counterpartyId: OTHER_ID, expectedPrice: 168 });

  app.$$('#bbo-H .btn')[0].click();
  const hit = app.sent.filter((m) => m.event === 'player:hit_bid').pop();
  assert.deepEqual(hit.payload, { commodityId: 'H', counterpartyId: OTHER_ID, expectedPrice: 160 });
  app.close();
});

test('a rejected trade surfaces the server message', () => {
  const app = boot();
  const state = dealtState();
  state.quotes.H = { [OTHER_ID]: { bid: 160, ask: 168 } };
  joinAs(app, state);
  app.fire('hand:yours', HAND);

  app.socket.acks['player:lift_ask'] = () => ({ ok: false, error: 'That quote is no longer available.' });
  app.$$('#bbo-H .btn')[1].click();
  assert.match(app.text('#toasts'), /no longer available/);
  app.close();
});

test('quoting is disabled before the market opens and after it closes', () => {
  const app = boot();
  joinAs(app, dealtState({ phase: 'dealt' }));
  app.fire('hand:yours', HAND);
  assert.equal(app.$('#bid-H').disabled, true);
  assert.match(app.text('#play-notice'), /Quoting opens when the host starts the clock/);

  app.fire('session:state', dealtState({ phase: 'trading' }));
  assert.equal(app.$('#bid-H').disabled, false);

  app.fire('session:state', dealtState({ phase: 'locked' }));
  assert.equal(app.$('#bid-H').disabled, true);
  assert.match(app.text('#play-notice'), /Trading is closed/);
  app.close();
});

test('each commodity shows its own recent prints next to the quote inputs', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);

  assert.match(app.text('#prints-H'), /no trades yet/);

  app.fire('trade:executed', {
    trade: { id: 't1', ts: Date.now(), commodityId: 'H', price: 165, buyerId: ME_ID, sellerId: OTHER_ID, side: 'lift' },
    marks: { H: 165 },
  });
  app.fire('trade:executed', {
    trade: { id: 't2', ts: Date.now(), commodityId: 'H', price: 171, buyerId: OTHER_ID, sellerId: HOST_ID, side: 'lift' },
    marks: { H: 171 },
  });
  app.fire('trade:executed', {
    trade: { id: 't3', ts: Date.now(), commodityId: 'S', price: 40, buyerId: OTHER_ID, sellerId: ME_ID, side: 'hit' },
    marks: { S: 40 },
  });

  const prints = app.$$('#prints-H .print').map((n) => n.textContent);
  assert.deepEqual(prints, ['171', '165'], 'newest first, this commodity only');
  assert.deepEqual(app.$$('#prints-S .print').map((n) => n.textContent), ['40']);
  assert.match(app.$$('#prints-H .print')[1].getAttribute('title'), /Me bought from Rival/);
  app.close();
});

test('the tape sits with the quote panels, not below the position table', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);

  const tape = app.$('#play-tape');
  assert.ok(tape, 'tape is rendered');
  assert.ok(tape.closest('.trading-grid'), 'tape lives in the trading grid beside the panels');
  assert.ok(app.$('.trading-grid #play-cmds'), 'so do the commodity panels');

  // It must come before the position card in document order.
  const body = app.$('#play-body');
  const nodes = Array.from(body.querySelectorAll('#play-tape, #play-me'));
  assert.deepEqual(nodes.map((n) => n.id), ['play-tape', 'play-me']);
  app.close();
});

test('the tape names both sides of each trade', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);
  app.fire('trade:executed', {
    trade: { id: 't1', ts: Date.now(), commodityId: 'H', price: 168, buyerId: ME_ID, sellerId: OTHER_ID },
    marks: { H: 168 },
  });

  const tape = app.text('#play-tape');
  assert.match(tape, /Me bought from Rival/);
  assert.match(tape, /168/);
  app.close();
});

test('position and cash update from the private position event', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);
  app.fire('position:yours', { position: { cash: -168, holdings: { H: 1, S: 0 } } });

  assert.match(app.text('#play-me'), /Cash/);
  assert.match(app.text('#play-me'), /-168|−168/);
  assert.match(app.text('#top-who'), /Me/);
  assert.match(app.text('#play-me'), /last traded price, not true value/i);
  app.close();
});

test('a mid-round joiner is told to wait instead of shown a dead trading form', () => {
  const app = boot();
  const state = dealtState();
  state.players = state.players.map((p) => Object.assign({}, p, { inRound: p.id !== ME_ID }));
  joinAs(app, state);

  assert.equal(app.activeScreen(), 'play');
  assert.match(app.text('#play-body'), /Sitting this round out/);
  assert.equal(app.$('#bid-H'), null, 'no quote form for someone not in the round');
  assert.ok(app.$('#play-tape'), 'but they can still watch the tape');
  app.close();
});

test('the countdown renders from the server clock', () => {
  const app = boot();
  joinAs(app, dealtState({ roundEndTime: Date.now() + 125000, serverTime: Date.now() }));
  app.fire('hand:yours', HAND);
  assert.match(app.text('#top-clock'), /^2:0\d$/);
  app.close();
});

test('reveal lays out true values, the round table and the cumulative board', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('session:state', dealtState({
    phase: 'revealed',
    trueValues: { S: 44, H: 172 },
    valueBreakdown: {
      S: { dealtCount: 12, sum: 44, discardedCount: 1, discardedSum: 47 },
      H: { dealtCount: 12, sum: 172, discardedCount: 1, discardedSum: -81 },
    },
    roundResults: [
      { playerId: ME_ID, name: 'Me', pnl: 4, cashDelta: -168, markToMarket: 172, holdings: { H: 1, S: 0 } },
      { playerId: OTHER_ID, name: 'Rival', pnl: -4, cashDelta: 168, markToMarket: -172, holdings: { H: -1, S: 0 } },
    ],
    cumulativeLeaderboard: [
      { playerId: ME_ID, name: 'Me', total: 4 },
      { playerId: OTHER_ID, name: 'Rival', total: -4 },
    ],
  }));

  assert.equal(app.activeScreen(), 'reveal');
  const body = app.text('#reveal-body');
  assert.match(body, /172/);
  assert.match(body, /Rubies/);
  assert.match(body, /12 dealt/);
  assert.match(body, /Cumulative leaderboard/);
  assert.match(body, /Waiting for the host/);
  assert.equal(app.$$('#reveal-body table').length, 2, 'round table plus leaderboard');
  assert.ok(app.$('#reveal-body tr.me'), 'your own row is highlighted');
  app.close();
});

test('reveal shows the round tape with what each trade actually earned', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('session:state', dealtState({
    phase: 'revealed',
    trueValues: { S: 44, H: 172 },
    trades: [
      // I sold at 168 into a value of 172 -> lost 4.
      { id: 't1', ts: Date.now(), commodityId: 'H', price: 168, buyerId: OTHER_ID, sellerId: ME_ID, side: 'lift' },
      // I bought at 160 into a value of 172 -> made 12.
      { id: 't2', ts: Date.now(), commodityId: 'H', price: 160, buyerId: ME_ID, sellerId: OTHER_ID, side: 'lift' },
      // Not my trade.
      { id: 't3', ts: Date.now(), commodityId: 'S', price: 40, buyerId: HOST_ID, sellerId: OTHER_ID, side: 'lift' },
    ],
    roundResults: [
      { playerId: ME_ID, name: 'Me', pnl: 8, cashDelta: 8, markToMarket: 0, holdings: { H: 0, S: 0 } },
      { playerId: OTHER_ID, name: 'Rival', pnl: -8, cashDelta: -8, markToMarket: 0, holdings: { H: 0, S: 0 } },
    ],
    cumulativeLeaderboard: [{ playerId: ME_ID, name: 'Me', total: 8 }],
  }));

  const body = app.text('#reveal-body');
  assert.match(body, /Every trade this round/);
  assert.match(body, /Your trades/);
  assert.match(body, /Good ones/);

  // -4 and +12 sum to +8, which must match the round P&L the server reported.
  assert.match(body, /add up to \+8, which is exactly your round P&L/);

  // Defaults to my own trades only: two rows, not three.
  const rows = app.$$('#reveal-body .tape-tbl tbody tr');
  assert.equal(rows.length, 2);
  const pnlCells = rows.map((r) => r.lastElementChild.textContent);
  assert.deepEqual(pnlCells, ['+12', '−4'], 'newest first, from my side of each trade');
  app.close();
});

test('the reveal tape can switch to showing everyone trades', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('session:state', dealtState({
    phase: 'revealed',
    trueValues: { S: 44, H: 172 },
    trades: [
      { id: 't1', ts: Date.now(), commodityId: 'H', price: 168, buyerId: OTHER_ID, sellerId: ME_ID, side: 'lift' },
      { id: 't3', ts: Date.now(), commodityId: 'S', price: 40, buyerId: HOST_ID, sellerId: OTHER_ID, side: 'lift' },
    ],
    roundResults: [{ playerId: ME_ID, name: 'Me', pnl: -4, cashDelta: 168, markToMarket: -172, holdings: { H: -1 } }],
    cumulativeLeaderboard: [{ playerId: ME_ID, name: 'Me', total: -4 }],
  }));

  assert.equal(app.$$('#reveal-body .tape-tbl tbody tr').length, 1, 'mine only by default');
  const tabs = app.$$('#reveal-body .tabs .btn');
  assert.equal(tabs.length, 2);
  tabs[1].click();
  assert.equal(app.$$('#reveal-body .tape-tbl tbody tr').length, 2, 'now the whole tape');
  assert.match(app.text('#reveal-body'), /Buyer P&L is what the buyer made/);
  app.close();
});

test('a player who never traded is told so and still sees the tape', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('session:state', dealtState({
    phase: 'revealed',
    trueValues: { S: 44, H: 172 },
    trades: [
      { id: 't3', ts: Date.now(), commodityId: 'S', price: 40, buyerId: HOST_ID, sellerId: OTHER_ID, side: 'lift' },
    ],
    roundResults: [{ playerId: ME_ID, name: 'Me', pnl: 0, cashDelta: 0, markToMarket: 0, holdings: {} }],
    cumulativeLeaderboard: [{ playerId: ME_ID, name: 'Me', total: 0 }],
  }));

  assert.match(app.text('#reveal-body'), /didn't trade this round/);
  assert.equal(app.$$('#reveal-body .tape-tbl tbody tr').length, 1);
  app.close();
});

test('the host sees a P&L matrix with one column per round', () => {
  const app = boot();
  joinAs(app, baseState(), { isHost: true, playerId: HOST_ID, name: 'Hostie' });
  assert.match(app.text('#host-history'), /appears here once you reveal/);

  app.fire('session:state', dealtState({
    phase: 'revealed',
    round: 3,
    trueValues: { S: 44, H: 172 },
    roundHistory: [
      { round: 1, trueValues: { S: 40, H: 160 }, pnl: { [ME_ID]: 10, [OTHER_ID]: -10 }, tradeCount: 4 },
      { round: 2, trueValues: { S: 50, H: 150 }, pnl: { [ME_ID]: -3, [OTHER_ID]: 3 }, tradeCount: 7 },
      { round: 3, trueValues: { S: 44, H: 172 }, pnl: { [ME_ID]: 5 }, tradeCount: 2 },
    ],
    cumulativeLeaderboard: [
      { playerId: ME_ID, name: 'Me', total: 12 },
      { playerId: OTHER_ID, name: 'Rival', total: -7 },
    ],
  }));

  const headers = app.$$('#host-history thead th').map((n) => n.textContent);
  assert.deepEqual(headers, ['Player', 'R1', 'R2', 'R3', 'Total']);

  const rows = app.$$('#host-history tbody tr');
  assert.equal(rows.length, 2, 'one row per player, best first');
  const first = Array.from(rows[0].children).map((n) => n.textContent.trim());
  assert.match(first[0], /Me$/);
  assert.deepEqual(first.slice(1), ['+10', '−3', '+5', '+12']);

  const second = Array.from(rows[1].children).map((n) => n.textContent.trim());
  assert.deepEqual(second.slice(1), ['+10'.replace('+10', '−10'), '+3', '·', '−7']);
  assert.equal(rows[1].children[3].getAttribute('title'), 'not in this round');

  // The true values behind each round are listed too.
  assert.match(app.text('#host-history'), /R1.*160/);
  assert.match(app.text('#host-history'), /7 trades/);
  app.close();
});

test('the final screen appears when the host ends the session', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('session:state', dealtState({
    phase: 'ended',
    round: 3,
    trueValues: { S: 44, H: 172 },
    cumulativeLeaderboard: [{ playerId: ME_ID, name: 'Me', total: 12 }],
  }));
  assert.equal(app.activeScreen(), 'reveal');
  assert.match(app.text('#reveal-body'), /Session complete/);
  assert.match(app.text('#reveal-body'), /Final standings after 3 rounds/);
  app.close();
});

test('a host who plays gets a desk tab and their own trading panels', () => {
  const app = boot();
  const cfg = Object.assign({}, CFG, { hostPlays: true });
  const state = dealtState({ config: cfg });
  state.players = state.players.map((p) => Object.assign({}, p, { inRound: true }));
  joinAs(app, state, { isHost: true, playerId: HOST_ID, name: 'Hostie' });

  assert.equal(app.activeScreen(), 'host');
  const tabs = app.$$('#host-tabs .btn');
  assert.equal(tabs.length, 2);
  tabs[1].click();
  assert.equal(app.activeScreen(), 'play');
  assert.ok(app.$('#bid-H'), 'the host can quote from their desk');

  app.$$('#screen-play .tabs .btn')[0].click();
  assert.equal(app.activeScreen(), 'host', 'and get back to the dashboard');
  app.close();
});

test('a stored token drives an automatic rejoin on reload', () => {
  const app = boot({
    identity: {
      sessionCode: 'ABCD', playerId: ME_ID, token: 'tok', name: 'Me', isHost: false, seenRules: true,
    },
  });
  app.socket.acks.join_session = () => ({
    ok: true, sessionCode: 'ABCD', playerId: ME_ID, token: 'tok', name: 'Me', isHost: false,
    seenRules: true, state: dealtState(),
  });
  app.connect();

  const join = app.sent.find((m) => m.event === 'join_session');
  assert.ok(join, 'reconnect happens without the player retyping anything');
  assert.equal(join.payload.token, 'tok');
  assert.equal(join.payload.sessionCode, 'ABCD');
  assert.equal(app.activeScreen(), 'play', 'straight back into the round');
  assert.equal(app.$('#rules').hidden, true, 'and the rules do not reappear');
  app.close();
});

test('a stale token is discarded and the player is sent back to the landing screen', () => {
  const app = boot({
    identity: {
      sessionCode: 'GONE', playerId: 'x', token: 'dead', name: 'Me', isHost: false, seenRules: true,
    },
  });
  app.socket.acks.join_session = () => ({ ok: false, error: 'That game is no longer running.' });
  app.connect();

  assert.equal(app.activeScreen(), 'landing');
  assert.equal(app.win.localStorage.getItem('mmg:identity'), null, 'the dead token is cleared');
  assert.match(app.text('#toasts'), /no longer running/);
  app.close();
});

test('a dropped connection is shown rather than silently pretended away', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);
  app.fire('disconnect');
  assert.match(app.text('#play-notice'), /Reconnecting/);
  assert.match(app.text('#top-who'), /offline/);
  app.close();
});

test('being removed returns the player to the landing screen with a clean slate', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('hand:yours', HAND);
  assert.equal(app.activeScreen(), 'play');

  app.fire('session:removed', { message: 'The host removed you from the game.' });

  assert.equal(app.activeScreen(), 'landing');
  assert.equal(app.$('#topbar').hidden, true);
  assert.equal(app.win.localStorage.getItem('mmg:identity'), null);
  assert.match(app.text('#toasts'), /removed you from the game/);
  app.close();
});

test('server errors reach the player as a toast', () => {
  const app = boot();
  joinAs(app, dealtState());
  app.fire('error', { message: 'Slow down a moment.' });
  assert.match(app.text('#toasts'), /Slow down a moment/);
  app.close();
});

test('the create form collects a full config and only allows 2+ commodities', () => {
  const app = boot();
  app.$('#btn-show-create').click();
  assert.equal(app.activeScreen(), 'create');

  app.$('#create-name').value = 'Hostie';
  app.$('#cfg-decks').value = '2';
  app.$('#cfg-maxcards').value = '6';
  app.$('#cfg-duration').value = '5';
  app.$('#cfg-nm-S').value = 'Iron Ore';
  app.$('#cfg-on-D').click();
  app.$('#cfg-on-C').click();
  app.$('#create-form').dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));

  const create = app.sent.find((m) => m.event === 'create_session');
  assert.equal(create.payload.hostName, 'Hostie');
  assert.deepEqual(create.payload.config.commodities, [
    { id: 'S', displayName: 'Iron Ore' },
    { id: 'H', displayName: '' },
  ]);
  assert.equal(create.payload.config.decks, 2);
  assert.equal(create.payload.config.maxCardsPerPlayer, 6);
  assert.equal(create.payload.config.durationSec, 300, 'minutes are converted to seconds');
  app.close();
});

test('creating with fewer than two commodities is refused client-side', () => {
  const app = boot();
  app.$('#btn-show-create').click();
  app.$('#create-name').value = 'Hostie';
  ['H', 'D', 'C'].forEach((id) => app.$('#cfg-on-' + id).click());
  app.$('#create-form').dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));

  assert.equal(app.sent.filter((m) => m.event === 'create_session').length, 0);
  assert.match(app.text('#toasts'), /at least 2 commodities/);
  app.close();
});
