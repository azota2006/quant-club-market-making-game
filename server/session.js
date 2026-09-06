'use strict';

const crypto = require('crypto');
const engine = require('./engine');

/** Errors carrying a message that is safe to show a player verbatim. */
class GameError extends Error {}

// Ambiguous characters (0/O, 1/I) left out — codes get read aloud across a room.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PHASES = ['lobby', 'dealt', 'trading', 'locked', 'revealed', 'ended'];

const DEFAULT_CONFIG = {
  commodities: [
    { id: 'S', displayName: '' },
    { id: 'H', displayName: '' },
    { id: 'D', displayName: '' },
    { id: 'C', displayName: '' },
  ],
  decks: 2,
  maxCardsPerPlayer: 8,
  startingCash: 0,
  durationSec: 480,
  oneFillPerQuote: false,
  hostPlays: false,
};

function makeCode(len = 4) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeName(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').slice(0, 20);
}

/**
 * Coerce a client-supplied config into something safe. Anything missing or
 * out of range falls back to the current value, then the default.
 */
function normalizeConfig(raw, base = DEFAULT_CONFIG) {
  const input = raw && typeof raw === 'object' ? raw : {};

  const rawCommodities = Array.isArray(input.commodities) ? input.commodities : base.commodities;
  const seen = new Set();
  let commodities = [];
  for (const entry of rawCommodities) {
    const c = typeof entry === 'string' ? { id: entry, displayName: '' } : entry;
    if (!c || !engine.SUITS[c.id] || seen.has(c.id)) continue;
    seen.add(c.id);
    commodities.push({ id: c.id, displayName: String(c.displayName || '').trim().slice(0, 24) });
  }
  commodities.sort((a, b) => engine.SUIT_ORDER.indexOf(a.id) - engine.SUIT_ORDER.indexOf(b.id));
  if (commodities.length < 2) {
    commodities = DEFAULT_CONFIG.commodities.map((c) => ({ id: c.id, displayName: c.displayName }));
  }

  return {
    commodities,
    decks: clampInt(input.decks, 1, 4, base.decks),
    maxCardsPerPlayer: clampInt(input.maxCardsPerPlayer, 1, 26, base.maxCardsPerPlayer),
    startingCash: clampInt(input.startingCash, 0, 1000000, base.startingCash),
    durationSec: clampInt(input.durationSec, 30, 3600, base.durationSec),
    oneFillPerQuote:
      input.oneFillPerQuote === undefined ? base.oneFillPerQuote : Boolean(input.oneFillPerQuote),
    hostPlays: input.hostPlays === undefined ? base.hostPlays : Boolean(input.hostPlays),
  };
}

/** Prices are money, not floats to play with — 2dp, non-negative, finite. */
function normalizePrice(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new GameError('Prices must be numbers.');
  if (n < 0) throw new GameError('Prices cannot be negative.');
  if (n > 1000000) throw new GameError('That price is unreasonably large.');
  return Math.round(n * 100) / 100;
}

class GameSession {
  constructor(code, config) {
    this.code = code;
    this.players = [];
    this.round = 0;
    this.phase = 'lobby';
    this.config = normalizeConfig(config);

    // Server-only for the current round.
    this.deck = [];
    this.discarded = [];
    this.hands = {};
    this.trueValues = {};

    this.quotes = {};
    this.trades = [];
    this.positions = {};
    this.cumulative = {};
    this.roundHistory = [];

    this.roundStartTime = null;
    this.roundEndTime = null;
    this.cardsPerPlayer = 0;
    this.lastResults = null;
    this.valueBreakdown = null;

    this.createdAt = Date.now();
    this.hostDisconnectedAt = null;
    this.roundTimer = null;
  }

  // ---------------------------------------------------------------- players

  addPlayer(name, { isHost = false } = {}) {
    const clean = normalizeName(name);
    if (!clean) throw new GameError('Please enter a name.');
    if (this.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      throw new GameError(`"${clean}" is already taken in this game. Pick another name.`);
    }
    if (this.players.length >= 40) throw new GameError('This game is full.');

    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      name: clean,
      isHost,
      connected: true,
      seenRules: false,
      socketId: null,
      lastSeen: Date.now(),
    };
    this.players.push(player);
    if (this.cumulative[player.id] === undefined) this.cumulative[player.id] = 0;
    return player;
  }

  playerById(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  playerByToken(token) {
    if (!token) return null;
    return this.players.find((p) => p.token === token) || null;
  }

  host() {
    return this.players.find((p) => p.isHost) || null;
  }

  /** Everyone who gets dealt in: all players, minus the host if they sit out. */
  activeRoster() {
    return this.players.filter((p) => !p.isHost || this.config.hostPlays);
  }

  isInRound(playerId) {
    return Object.prototype.hasOwnProperty.call(this.positions, playerId);
  }

  // ----------------------------------------------------------------- phases

  requirePhase(phase, action) {
    if (this.phase !== phase) {
      throw new GameError(`Can't ${action} while the game is in "${this.phase}".`);
    }
  }

  dealRound() {
    if (this.phase !== 'lobby' && this.phase !== 'revealed') {
      throw new GameError(`Can't deal from the "${this.phase}" phase.`);
    }

    const roster = this.activeRoster();
    if (roster.length < 2) {
      throw new GameError(
        this.config.hostPlays
          ? 'You need at least 2 players to deal.'
          : 'You need at least 2 players to deal (turn on "host also plays" to count yourself).',
      );
    }

    const commodityIds = this.config.commodities.map((c) => c.id);
    const deck = engine.shuffle(engine.buildDeck(commodityIds, this.config.decks));
    const cardsPerPlayer = engine.computeCardsPerPlayer(
      deck.length,
      roster.length,
      this.config.maxCardsPerPlayer,
    );
    if (cardsPerPlayer < 1) {
      throw new GameError(
        `Not enough cards: ${deck.length} cards for ${roster.length} players. Add a deck or a commodity.`,
      );
    }

    const { hands, discarded } = engine.deal(deck, roster.map((p) => p.id), cardsPerPlayer);

    this.deck = deck;
    this.hands = hands;
    this.discarded = discarded;
    this.trueValues = engine.computeTrueValues(hands, commodityIds);
    this.cardsPerPlayer = cardsPerPlayer;

    this.quotes = {};
    for (const cid of commodityIds) this.quotes[cid] = {};

    this.trades = [];
    this.positions = {};
    for (const p of roster) {
      const holdings = {};
      for (const cid of commodityIds) holdings[cid] = 0;
      this.positions[p.id] = { cash: this.config.startingCash, holdings };
      if (this.cumulative[p.id] === undefined) this.cumulative[p.id] = 0;
    }

    this.round += 1;
    this.phase = 'dealt';
    this.roundStartTime = null;
    this.roundEndTime = null;
    this.lastResults = null;
    this.valueBreakdown = null;
  }

  startTrading() {
    this.requirePhase('dealt', 'start trading');
    this.phase = 'trading';
    this.roundStartTime = Date.now();
    this.roundEndTime = this.roundStartTime + this.config.durationSec * 1000;
  }

  endRound() {
    if (this.phase !== 'trading') throw new GameError('The round is not running.');
    this.phase = 'locked';
    this.roundEndTime = Date.now();
  }

  reveal() {
    if (this.phase !== 'locked' && this.phase !== 'trading') {
      throw new GameError('There is nothing to reveal yet.');
    }
    if (this.phase === 'trading') this.endRound();

    const results = engine.scoreRound(this.positions, this.config.startingCash, this.trueValues);
    for (const playerId of Object.keys(results)) {
      this.cumulative[playerId] = (this.cumulative[playerId] || 0) + results[playerId].pnl;
    }

    this.valueBreakdown = engine.computeValueBreakdown(
      this.hands,
      this.discarded,
      this.config.commodities.map((c) => c.id),
    );
    this.lastResults = results;

    // Keep a per-round record so the host can look back over the whole night.
    const pnl = {};
    for (const playerId of Object.keys(results)) pnl[playerId] = results[playerId].pnl;
    this.roundHistory.push({
      round: this.round,
      trueValues: Object.assign({}, this.trueValues),
      pnl,
      tradeCount: this.trades.length,
    });

    this.phase = 'revealed';
    return results;
  }

  nextRound() {
    this.requirePhase('revealed', 'start the next round');
    this.dealRound();
  }

  endSession() {
    this.phase = 'ended';
    this.roundEndTime = Date.now();
  }

  // ----------------------------------------------------------------- quotes

  updateQuote(playerId, commodityId, rawBid, rawAsk) {
    if (this.phase !== 'trading') throw new GameError('Trading is closed.');
    if (!this.quotes[commodityId]) throw new GameError('Unknown commodity.');
    if (!this.isInRound(playerId)) {
      throw new GameError("You're not in this round — you'll be dealt in next round.");
    }

    const bid = normalizePrice(rawBid);
    const ask = normalizePrice(rawAsk);
    if (bid !== null && ask !== null && bid >= ask) {
      throw new GameError('Your bid must be below your ask.');
    }

    if (bid === null && ask === null) {
      delete this.quotes[commodityId][playerId];
    } else {
      this.quotes[commodityId][playerId] = { bid, ask };
    }
    return this.quotes[commodityId];
  }

  clearAllQuotesFor(playerId) {
    for (const cid of Object.keys(this.quotes)) delete this.quotes[cid][playerId];
  }

  /**
   * Execute one 1-lot trade against a resting quote.
   *
   * Node runs this to completion without interleaving, so the check-then-write
   * is atomic with respect to other socket events. `expectedPrice` is what the
   * clicking client had on screen: if the quote has since moved or been pulled,
   * the trade is rejected rather than filled at a price nobody agreed to.
   */
  executeTrade(actorId, commodityId, counterpartyId, side, expectedPrice) {
    if (this.phase !== 'trading') throw new GameError('Trading is closed.');
    if (actorId === counterpartyId) throw new GameError("You can't trade against your own quote.");

    const book = this.quotes[commodityId];
    if (!book) throw new GameError('Unknown commodity.');

    const actorPos = this.positions[actorId];
    if (!actorPos) throw new GameError("You're not in this round — you'll be dealt in next round.");
    const cpPos = this.positions[counterpartyId];
    if (!cpPos) throw new GameError('That player is not in this round.');

    const quote = book[counterpartyId];
    const price = quote ? (side === 'lift' ? quote.ask : quote.bid) : null;
    if (price === null || price === undefined) {
      throw new GameError('That quote is no longer available.');
    }

    const expected = expectedPrice === null || expectedPrice === undefined ? null : Number(expectedPrice);
    if (expected !== null && Number.isFinite(expected) && expected !== price) {
      throw new GameError(`That quote moved — it's now ${price}. Try again.`);
    }

    const cid = commodityId;
    if (side === 'lift') {
      actorPos.cash -= price;
      actorPos.holdings[cid] = (actorPos.holdings[cid] || 0) + 1;
      cpPos.cash += price;
      cpPos.holdings[cid] = (cpPos.holdings[cid] || 0) - 1;
    } else {
      actorPos.cash += price;
      actorPos.holdings[cid] = (actorPos.holdings[cid] || 0) - 1;
      cpPos.cash -= price;
      cpPos.holdings[cid] = (cpPos.holdings[cid] || 0) + 1;
    }

    // v1 default: quotes are standing and stay live after a fill. With the
    // host's "one fill per quote" option on, the filled side is pulled instead.
    let bookChanged = false;
    if (this.config.oneFillPerQuote) {
      if (side === 'lift') quote.ask = null;
      else quote.bid = null;
      if (quote.bid === null && quote.ask === null) delete book[counterpartyId];
      bookChanged = true;
    }

    const trade = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      commodityId: cid,
      price,
      buyerId: side === 'lift' ? actorId : counterpartyId,
      sellerId: side === 'lift' ? counterpartyId : actorId,
      aggressorId: actorId,
      side,
    };
    this.trades.push(trade);
    if (this.trades.length > 500) this.trades.splice(0, this.trades.length - 500);

    return { trade, bookChanged, actorId, counterpartyId };
  }

  // ------------------------------------------------------------ serializing

  /** Last traded price per commodity — the only mark available pre-reveal. */
  marks() {
    const out = {};
    for (const t of this.trades) out[t.commodityId] = t.price;
    return out;
  }

  leaderboard() {
    return this.players
      .filter((p) => this.cumulative[p.id] !== undefined && (!p.isHost || this.config.hostPlays))
      .map((p) => ({ playerId: p.id, name: p.name, total: this.cumulative[p.id] || 0 }))
      .sort((a, b) => b.total - a.total);
  }

  roundResultsPublic() {
    if (!this.lastResults) return null;
    return Object.keys(this.lastResults)
      .map((playerId) => {
        const player = this.playerById(playerId);
        const r = this.lastResults[playerId];
        return {
          playerId,
          name: player ? player.name : '(left)',
          pnl: r.pnl,
          cashDelta: r.cashDelta,
          markToMarket: r.markToMarket,
          holdings: r.holdings,
        };
      })
      .sort((a, b) => b.pnl - a.pnl);
  }

  /**
   * The only object ever broadcast. Hands, the deck, discards, and true values
   * are deliberately absent until the host reveals.
   */
  publicState() {
    const revealed = this.phase === 'revealed' || this.phase === 'ended';
    return {
      code: this.code,
      round: this.round,
      phase: this.phase,
      config: this.config,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        connected: p.connected,
        inRound: this.isInRound(p.id),
      })),
      quotes: this.quotes,
      // Once the round is scored, send the whole tape so players can review
      // every trade against the revealed value.
      trades: revealed ? this.trades.slice() : this.trades.slice(-80),
      roundHistory: this.roundHistory,
      marks: this.marks(),
      roundStartTime: this.roundStartTime,
      roundEndTime: this.roundEndTime,
      cardsPerPlayer: this.cardsPerPlayer,
      playersInRound: Object.keys(this.positions).length,
      deckSize: this.config.commodities.length * 13 * this.config.decks,
      serverTime: Date.now(),
      trueValues: revealed ? this.trueValues : null,
      valueBreakdown: revealed ? this.valueBreakdown : null,
      roundResults: revealed ? this.roundResultsPublic() : null,
      cumulativeLeaderboard: this.leaderboard(),
    };
  }

  privateStateFor(playerId) {
    const cards = this.hands[playerId] || [];
    const commodityIds = this.config.commodities.map((c) => c.id);
    return {
      hand: cards,
      handSubtotals: engine.handSubtotals(cards, commodityIds),
      position: this.positions[playerId] || null,
    };
  }
}

class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(hostName, config) {
    let code = makeCode();
    let guard = 0;
    while (this.sessions.has(code) && guard < 50) {
      code = makeCode();
      guard += 1;
    }
    const session = new GameSession(code, config);
    const host = session.addPlayer(hostName || 'Host', { isHost: true });
    this.sessions.set(code, session);
    return { session, host };
  }

  get(code) {
    if (!code) return null;
    return this.sessions.get(String(code).trim().toUpperCase()) || null;
  }

  delete(code) {
    const session = this.sessions.get(code);
    if (session && session.roundTimer) clearTimeout(session.roundTimer);
    this.sessions.delete(code);
  }

  /** Drop sessions nobody has been connected to for a while. */
  sweep(maxIdleMs = 3 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [code, session] of this.sessions) {
      const anyConnected = session.players.some((p) => p.connected);
      if (anyConnected) continue;
      const lastSeen = session.players.reduce((max, p) => Math.max(max, p.lastSeen || 0), session.createdAt);
      if (now - lastSeen > maxIdleMs) this.delete(code);
    }
  }
}

module.exports = {
  GameError,
  GameSession,
  SessionStore,
  DEFAULT_CONFIG,
  PHASES,
  makeCode,
  normalizeConfig,
  normalizePrice,
  normalizeName,
};
