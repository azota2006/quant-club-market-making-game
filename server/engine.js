'use strict';

/**
 * Pure game logic: deck construction, shuffling, dealing, true-value
 * calculation and round scoring. No networking, no session state, no I/O —
 * everything here is a pure function so it can be unit tested directly
 * (see test/engine.test.js).
 */

const SUITS = {
  S: { id: 'S', symbol: '♠', name: 'Spades', color: 'black' },
  H: { id: 'H', symbol: '♥', name: 'Hearts', color: 'red' },
  D: { id: 'D', symbol: '♦', name: 'Diamonds', color: 'red' },
  C: { id: 'C', symbol: '♣', name: 'Clubs', color: 'black' },
};

const SUIT_ORDER = ['S', 'H', 'D', 'C'];

const RANK_LABELS = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K',
};

/** A=1, 2-10 face value, J=11, Q=12, K=13. */
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

function rankLabel(rank) {
  return RANK_LABELS[rank];
}

function cardLabel(card) {
  return rankLabel(card.rank) + SUITS[card.suit].symbol;
}

/**
 * Build the deck for a round. Only cards belonging to active commodities are
 * included — if the host picks 3 of 4 suits, the 4th suit never enters the deck.
 */
function buildDeck(commodityIds, decks) {
  const cards = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of commodityIds) {
      for (const rank of RANKS) {
        cards.push({ suit, rank, value: rank });
      }
    }
  }
  return cards;
}

/** Fisher-Yates. `rng` is injectable so tests can be deterministic. */
function shuffle(cards, rng = Math.random) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * floor(deck size / players), capped at the host's max hand size.
 */
function computeCardsPerPlayer(deckSize, playerCount, maxCardsPerPlayer) {
  if (playerCount <= 0) return 0;
  return Math.min(maxCardsPerPlayer, Math.floor(deckSize / playerCount));
}

/**
 * Deal round-robin, one card at a time. Whatever is left after the last full
 * round is discarded outright — those cards count toward nothing, which is what
 * makes each suit's total a genuine unknown rather than a fixed constant.
 */
function deal(deck, playerIds, cardsPerPlayer) {
  const hands = {};
  for (const id of playerIds) hands[id] = [];

  let idx = 0;
  for (let c = 0; c < cardsPerPlayer; c += 1) {
    for (const id of playerIds) {
      hands[id].push(deck[idx]);
      idx += 1;
    }
  }

  return {
    hands,
    dealtCount: idx,
    discarded: deck.slice(idx),
  };
}

/**
 * True value of a commodity = sum of the ranks of only the cards of that suit
 * that actually landed in someone's hand.
 */
function computeTrueValues(hands, commodityIds) {
  const values = {};
  for (const id of commodityIds) values[id] = 0;
  for (const playerId of Object.keys(hands)) {
    for (const card of hands[playerId]) {
      if (values[card.suit] !== undefined) values[card.suit] += card.value;
    }
  }
  return values;
}

/**
 * Post-reveal explainer: how many cards of each suit were dealt vs. discarded.
 * Only ever computed at reveal time — never sent to a client before that.
 */
function computeValueBreakdown(hands, discarded, commodityIds) {
  const breakdown = {};
  for (const id of commodityIds) {
    breakdown[id] = { dealtCount: 0, sum: 0, discardedCount: 0, discardedSum: 0 };
  }
  for (const playerId of Object.keys(hands)) {
    for (const card of hands[playerId]) {
      const b = breakdown[card.suit];
      if (!b) continue;
      b.dealtCount += 1;
      b.sum += card.value;
    }
  }
  for (const card of discarded) {
    const b = breakdown[card.suit];
    if (!b) continue;
    b.discardedCount += 1;
    b.discardedSum += card.value;
  }
  return breakdown;
}

/** Sum of the player's own cards in each suit — the visible floor on value. */
function handSubtotals(cards, commodityIds) {
  const totals = {};
  for (const id of commodityIds) totals[id] = 0;
  for (const card of cards) {
    if (totals[card.suit] !== undefined) totals[card.suit] += card.value;
  }
  return totals;
}

/**
 * round P&L = (cash_end - starting_cash) + sum(position x true_value)
 */
function scorePlayer(position, startingCash, trueValues) {
  const cashDelta = position.cash - startingCash;
  let markToMarket = 0;
  for (const cid of Object.keys(trueValues)) {
    const holding = position.holdings[cid] || 0;
    markToMarket += holding * trueValues[cid];
  }
  return {
    cash: position.cash,
    cashDelta,
    markToMarket,
    pnl: cashDelta + markToMarket,
    holdings: Object.assign({}, position.holdings),
  };
}

/**
 * Score every player who was dealt into the round. Players who joined
 * mid-round have no position and are simply not scored.
 */
function scoreRound(positions, startingCash, trueValues) {
  const results = {};
  for (const playerId of Object.keys(positions)) {
    results[playerId] = scorePlayer(positions[playerId], startingCash, trueValues);
  }
  return results;
}

module.exports = {
  SUITS,
  SUIT_ORDER,
  RANKS,
  RANK_LABELS,
  rankLabel,
  cardLabel,
  buildDeck,
  shuffle,
  computeCardsPerPlayer,
  deal,
  computeTrueValues,
  computeValueBreakdown,
  handSubtotals,
  scorePlayer,
  scoreRound,
};
