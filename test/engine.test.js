'use strict';

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../server/engine');

/** Deterministic "shuffle" source so deals are reproducible in tests. */
function seededRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('buildDeck includes only the active suits', () => {
  const deck = engine.buildDeck(['S', 'H'], 1);
  assert.equal(deck.length, 26);
  assert.ok(deck.every((c) => c.suit === 'S' || c.suit === 'H'));

  const two = engine.buildDeck(['S', 'H', 'D', 'C'], 2);
  assert.equal(two.length, 104);
  assert.equal(two.filter((c) => c.suit === 'D').length, 26);
});

test('a full suit sums to 91 per deck — which is why discards matter', () => {
  for (const decks of [1, 2, 3, 4]) {
    const deck = engine.buildDeck(['H'], decks);
    assert.equal(deck.length, 13 * decks);
    assert.equal(deck.reduce((a, c) => a + c.value, 0), 91 * decks);
  }
});

test('3 and 4 decks build the right number of every card', () => {
  for (const decks of [3, 4]) {
    const deck = engine.buildDeck(['S', 'H', 'D', 'C'], decks);
    assert.equal(deck.length, 52 * decks);
    assert.equal(deck.filter((c) => c.suit === 'D').length, 13 * decks);
    assert.equal(deck.filter((c) => c.suit === 'D' && c.rank === 13).length, decks,
      'one king of diamonds per deck');
  }
});

test('card values run A=1 through K=13', () => {
  const deck = engine.buildDeck(['S'], 1);
  const ranks = deck.map((c) => c.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.ok(deck.every((c) => c.value === c.rank));
  assert.equal(engine.rankLabel(1), 'A');
  assert.equal(engine.rankLabel(11), 'J');
  assert.equal(engine.rankLabel(13), 'K');
});

test('shuffle permutes without inventing or losing cards', () => {
  const deck = engine.buildDeck(['S', 'H', 'D', 'C'], 1);
  const shuffled = engine.shuffle(deck, seededRng(42));
  assert.equal(shuffled.length, deck.length);
  const key = (c) => c.suit + c.rank;
  assert.deepEqual(shuffled.map(key).sort(), deck.map(key).sort());
  assert.notDeepEqual(shuffled.map(key), deck.map(key));
});

test('cardsPerPlayer is floor(deck / players), capped by the host max', () => {
  assert.equal(engine.computeCardsPerPlayer(104, 16, 8), 6);
  assert.equal(engine.computeCardsPerPlayer(104, 10, 8), 8, 'cap wins over floor(10.4)');
  assert.equal(engine.computeCardsPerPlayer(52, 20, 8), 2);
  assert.equal(engine.computeCardsPerPlayer(26, 20, 8), 1);
  assert.equal(engine.computeCardsPerPlayer(10, 20, 8), 0, 'not enough to go round');
});

test('deal hands out round-robin and discards the remainder', () => {
  const deck = engine.buildDeck(['S', 'H', 'D', 'C'], 2);
  const players = ['p1', 'p2', 'p3'];
  const perPlayer = engine.computeCardsPerPlayer(deck.length, players.length, 8);
  const { hands, discarded } = engine.deal(deck, players, perPlayer);

  assert.equal(perPlayer, 8);
  players.forEach((p) => assert.equal(hands[p].length, 8));
  assert.equal(discarded.length, 104 - 24);

  // Round-robin: the first three cards off the deck go to p1, p2, p3 in turn.
  assert.deepEqual(hands.p1[0], deck[0]);
  assert.deepEqual(hands.p2[0], deck[1]);
  assert.deepEqual(hands.p3[0], deck[2]);
  assert.deepEqual(hands.p1[1], deck[3]);
});

test('every card is either dealt or discarded, never both', () => {
  const deck = engine.shuffle(engine.buildDeck(['S', 'H', 'D', 'C'], 2), seededRng(7));
  const players = ['a', 'b', 'c', 'd', 'e'];
  const { hands, discarded } = engine.deal(deck, players, 8);
  const dealt = players.reduce((acc, p) => acc.concat(hands[p]), []);
  assert.equal(dealt.length + discarded.length, deck.length);
  assert.equal(dealt.length, 40);
});

test('true value counts only dealt cards, so it lands below the full-suit total', () => {
  const deck = engine.shuffle(engine.buildDeck(['S', 'H'], 1), seededRng(11));
  const players = ['a', 'b', 'c'];
  const { hands, discarded } = engine.deal(deck, players, 8);
  const values = engine.computeTrueValues(hands, ['S', 'H']);

  const dealtHearts = players
    .reduce((acc, p) => acc.concat(hands[p]), [])
    .filter((c) => c.suit === 'H')
    .reduce((a, c) => a + c.value, 0);
  assert.equal(values.H, dealtHearts);

  const discardedHearts = discarded.filter((c) => c.suit === 'H').reduce((a, c) => a + c.value, 0);
  assert.equal(values.H + discardedHearts, 91, 'dealt + discarded reconstitutes the full suit');
  assert.ok(discarded.length > 0);
  assert.ok(values.H < 91, 'some hearts were discarded, so the value is not the constant 91');
});

test('true value ignores suits that are not in play', () => {
  const hands = {
    a: [{ suit: 'S', rank: 5, value: 5 }, { suit: 'H', rank: 3, value: 3 }],
  };
  const values = engine.computeTrueValues(hands, ['S']);
  assert.deepEqual(values, { S: 5 });
});

test('value breakdown splits dealt from discarded', () => {
  const deck = engine.shuffle(engine.buildDeck(['S', 'H'], 1), seededRng(3));
  const { hands, discarded } = engine.deal(deck, ['a', 'b'], 5);
  const b = engine.computeValueBreakdown(hands, discarded, ['S', 'H']);
  assert.equal(b.S.dealtCount + b.H.dealtCount, 10);
  assert.equal(b.S.dealtCount + b.S.discardedCount, 13);
  assert.equal(b.S.sum + b.S.discardedSum, 91);
});

test('hand subtotals group a hand by suit', () => {
  const cards = [
    { suit: 'H', rank: 4, value: 4 },
    { suit: 'H', rank: 5, value: 5 },
    { suit: 'S', rank: 13, value: 13 },
  ];
  assert.deepEqual(engine.handSubtotals(cards, ['S', 'H', 'D']), { S: 13, H: 9, D: 0 });
});

test('P&L is cash delta plus inventory marked at true value', () => {
  // Sold one Hearts at 168 from flat, starting cash 0. Hearts reveals at 172.
  const position = { cash: 168, holdings: { H: -1, S: 0 } };
  const result = engine.scorePlayer(position, 0, { H: 172, S: 40 });
  assert.equal(result.cashDelta, 168);
  assert.equal(result.markToMarket, -172);
  assert.equal(result.pnl, -4, 'short into a higher value loses 4');

  const buyer = engine.scorePlayer({ cash: -168, holdings: { H: 1, S: 0 } }, 0, { H: 172, S: 40 });
  assert.equal(buyer.pnl, 4, 'the other side of the same trade makes 4');
});

test('starting cash nets out of P&L', () => {
  const flat = engine.scorePlayer({ cash: 5000, holdings: { H: 0 } }, 5000, { H: 100 });
  assert.equal(flat.pnl, 0);
});

test('the table is zero sum across every player', () => {
  const trueValues = { H: 150, S: 90 };
  const positions = {
    a: { cash: 300, holdings: { H: -2, S: 0 } },
    b: { cash: -300, holdings: { H: 2, S: -1 } },
    c: { cash: 0, holdings: { H: 0, S: 1 } },
  };
  const results = engine.scoreRound(positions, 0, trueValues);
  const total = Object.keys(results).reduce((a, k) => a + results[k].pnl, 0);
  assert.equal(total, 0);
});
