/* Market Making Game — client.
   Plain DOM, no framework. The trading view is built once per round and then
   patched in place, so quote inputs never lose focus when the book updates. */
(function () {
  'use strict';

  // ------------------------------------------------------------- constants

  var SUITS = {
    S: { symbol: '♠', name: 'Spades', color: 'black' },
    H: { symbol: '♥', name: 'Hearts', color: 'red' },
    D: { symbol: '♦', name: 'Diamonds', color: 'red' },
    C: { symbol: '♣', name: 'Clubs', color: 'black' },
  };
  var SUIT_ORDER = ['S', 'H', 'D', 'C'];
  var RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  var STORE_KEY = 'mmg:identity';

  var PHASE_LABEL = {
    lobby: 'Lobby',
    dealt: 'Cards dealt',
    trading: 'Trading',
    locked: 'Closed',
    revealed: 'Revealed',
    ended: 'Finished',
  };

  // --------------------------------------------------------------- helpers

  function $(sel) { return document.querySelector(sel); }

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else node.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i += 1) {
      var kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) {
        kid.forEach(function (k2) {
          if (k2 === null || k2 === undefined || k2 === false) return;
          node.appendChild(typeof k2 === 'object' ? k2 : document.createTextNode(String(k2)));
        });
      } else node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function num(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(2);
  }

  function signed(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var s = num(Math.abs(n));
    return (n > 0 ? '+' : n < 0 ? '−' : '') + s;
  }

  function signClass(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'dim'; }

  function rankLabel(rank) { return RANK_LABEL[rank] || String(rank); }

  function commodityName(c) {
    return (c.displayName && c.displayName.trim()) || SUITS[c.id].name;
  }

  function clockText(ms) {
    if (ms === null || ms === undefined) return '';
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function timeOfDay(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* no haptics */ }
  }

  // ----------------------------------------------------------------- state

  var S = {
    screen: 'landing',
    identity: null,
    session: null,
    hand: null,
    subtotals: null,
    position: null,
    drafts: {},
    clockOffset: 0,
    connected: false,
    hostTab: 'dashboard',
    shellKey: null,
    hostShellBuilt: false,
    freshTrades: {},
    lastTradeCount: 0,
    revealTape: 'mine',
  };

  function loadIdentity() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveIdentity(id) {
    S.identity = id;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(id)); } catch (e) { /* private mode */ }
  }

  function dropIdentity() {
    S.identity = null;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* private mode */ }
  }

  function me() {
    if (!S.session || !S.identity) return null;
    for (var i = 0; i < S.session.players.length; i += 1) {
      if (S.session.players[i].id === S.identity.playerId) return S.session.players[i];
    }
    return null;
  }

  function playerName(id) {
    if (!S.session) return '?';
    for (var i = 0; i < S.session.players.length; i += 1) {
      if (S.session.players[i].id === id) return S.session.players[i].name;
    }
    return '(left)';
  }

  function commodities() { return (S.session && S.session.config.commodities) || []; }

  function amInRound() {
    var m = me();
    return !!(m && m.inRound);
  }

  // ---------------------------------------------------------------- toasts

  function toast(message, kind) {
    var host = $('#toasts');
    var node = h('div', { class: 'toast ' + (kind || ''), text: message });
    host.appendChild(node);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, kind === 'err' ? 4200 : 2600);
  }

  // ---------------------------------------------------------------- socket

  var socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', function () {
    S.connected = true;
    if (S.identity && S.identity.sessionCode && S.identity.token) {
      socket.emit(
        'join_session',
        {
          sessionCode: S.identity.sessionCode,
          playerName: S.identity.name,
          token: S.identity.token,
        },
        function (res) {
          if (!res || !res.ok) {
            dropIdentity();
            S.session = null;
            go('landing');
            if (res && res.error) toast(res.error, 'err');
            return;
          }
          adoptJoin(res);
        },
      );
    }
    render();
  });

  socket.on('disconnect', function () {
    S.connected = false;
    render();
  });

  socket.on('error', function (payload) {
    toast((payload && payload.message) || 'Something went wrong.', 'err');
  });

  socket.on('session:removed', function (payload) {
    dropIdentity();
    S.session = null;
    S.hand = null;
    S.position = null;
    S.hostShellBuilt = false;
    S.shellKey = null;
    go('landing');
    updateTopbar();
    toast((payload && payload.message) || 'You were removed from the game.', 'err');
  });

  socket.on('session:state', function (state) {
    S.clockOffset = state.serverTime - Date.now();
    var prevPhase = S.session && S.session.phase;
    var prevRound = S.session && S.session.round;
    S.session = state;
    if (state.round !== prevRound) {
      S.drafts = {};
      S.freshTrades = {};
    }
    if (prevPhase && prevPhase !== state.phase) onPhaseEnter(state.phase);
    render();
  });

  socket.on('phase:changed', function (payload) {
    if (payload && payload.reason === 'timer') toast("Time's up — trading is closed.", 'err');
  });

  socket.on('hand:yours', function (payload) {
    S.hand = payload.cards || [];
    S.subtotals = payload.subtotals || {};
    if (S.screen === 'play') updateHand();
    render();
  });

  socket.on('position:yours', function (payload) {
    S.position = payload.position;
    if (S.screen === 'play') updateMe();
    updateTopbar();
  });

  socket.on('book:updated', function (payload) {
    if (!S.session) return;
    S.session.quotes[payload.commodityId] = payload.quotes;
    scheduleBookUpdate(payload.commodityId);
  });

  socket.on('trade:executed', function (payload) {
    if (!S.session) return;
    S.session.trades.push(payload.trade);
    if (S.session.trades.length > 80) S.session.trades.shift();
    S.session.marks = payload.marks;
    S.freshTrades[payload.trade.id] = true;
    setTimeout(function () { delete S.freshTrades[payload.trade.id]; }, 1000);

    var mine = S.identity && (payload.trade.buyerId === S.identity.playerId ||
      payload.trade.sellerId === S.identity.playerId);
    if (mine) buzz(18);
    scheduleTapeUpdate();
    scheduleBookUpdate(payload.trade.commodityId);
  });

  socket.on('round:revealed', function () {
    buzz([12, 60, 12]);
  });

  function onPhaseEnter(phase) {
    if (phase === 'trading') { toast('Market open — quote away.', 'ok'); buzz(25); }
    if (phase === 'dealt') { toast('Cards dealt. Look at your hand.', 'ok'); buzz(15); }
    if (phase === 'revealed') toast('Values revealed.', 'ok');
  }

  function adoptJoin(res) {
    if (!res || !res.state) {
      toast('The server sent back an incomplete reply. Try joining again.', 'err');
      return;
    }
    saveIdentity({
      sessionCode: res.sessionCode,
      playerId: res.playerId,
      token: res.token,
      name: res.name,
      isHost: res.isHost,
      seenRules: res.seenRules,
    });
    S.clockOffset = res.state.serverTime - Date.now();
    S.session = res.state;
    if (!res.isHost && !res.seenRules) openRules(true);
    render();
  }

  // -------------------------------------------------------- update batching

  var pendingBooks = {};
  var pendingTape = false;
  var flushPending = false;

  function flushUpdates() {
    flushPending = false;
    if (S.screen === 'play') {
      Object.keys(pendingBooks).forEach(function (cid) { updateBook(cid); });
      if (pendingTape) updateTape();
    } else if (S.screen === 'host') {
      updateHostLive();
    }
    pendingBooks = {};
    pendingTape = false;
  }

  // Guard with a flag rather than the handle: the handle is only assigned after
  // requestAnimationFrame returns, which is too late if the callback already ran.
  function scheduleFlush() {
    if (flushPending) return;
    flushPending = true;
    requestAnimationFrame(flushUpdates);
  }

  function scheduleBookUpdate(cid) { pendingBooks[cid] = true; scheduleFlush(); }
  function scheduleTapeUpdate() { pendingTape = true; scheduleFlush(); }

  // -------------------------------------------------------------- routing

  function go(screen) {
    S.screen = screen;
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i += 1) {
      screens[i].classList.toggle('active', screens[i].id === 'screen-' + screen);
    }
    window.scrollTo(0, 0);
  }

  function decideScreen() {
    if (!S.session || !S.identity) return S.screen === 'create' ? 'create' : 'landing';
    var m = me();
    var isHost = !!(m && m.isHost);

    if (isHost && S.hostTab === 'dashboard') return 'host';
    if (isHost && S.hostTab === 'desk' && !S.session.config.hostPlays) {
      S.hostTab = 'dashboard';
      return 'host';
    }

    switch (S.session.phase) {
      case 'lobby': return isHost ? 'host' : 'lobby';
      case 'dealt':
      case 'trading':
      case 'locked': return 'play';
      case 'revealed':
      case 'ended': return 'reveal';
      default: return 'lobby';
    }
  }

  function render() {
    var target = decideScreen();
    if (target !== S.screen) go(target);
    updateTopbar();

    if (target === 'lobby') renderLobby();
    else if (target === 'host') renderHost();
    else if (target === 'play') renderPlay();
    else if (target === 'reveal') renderReveal();
  }

  // -------------------------------------------------------------- topbar

  function remainingMs() {
    if (!S.session || !S.session.roundEndTime) return null;
    if (S.session.phase !== 'trading') return null;
    return S.session.roundEndTime - (Date.now() + S.clockOffset);
  }

  function updateTopbar() {
    var bar = $('#topbar');
    if (!S.session || !S.identity) { bar.hidden = true; return; }
    bar.hidden = false;

    $('#top-round').textContent = S.session.round > 0 ? 'Round ' + S.session.round : 'Lobby';
    var phaseEl = $('#top-phase');
    phaseEl.textContent = PHASE_LABEL[S.session.phase] || S.session.phase;
    phaseEl.dataset.phase = S.session.phase;

    var who = S.identity.name + (S.position ? ' · ' + num(S.position.cash) : '');
    $('#top-who').textContent = S.connected ? who : 'offline…';

    updateClock();
  }

  function updateClock() {
    var el = $('#top-clock');
    var ms = remainingMs();
    if (ms === null) { el.textContent = ''; el.classList.remove('urgent'); return; }
    el.textContent = clockText(ms);
    el.classList.toggle('urgent', ms < 30000);
  }

  setInterval(function () {
    if (S.session && S.session.phase === 'trading') updateClock();
  }, 250);

  // --------------------------------------------------------------- landing

  $('#join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('#join-code').value.trim().toUpperCase();
    var name = $('#join-name').value.trim();
    if (!code || !name) return;
    socket.emit('join_session', { sessionCode: code, playerName: name }, function (res) {
      if (!res || !res.ok) { toast((res && res.error) || 'Could not join.', 'err'); return; }
      adoptJoin(res);
    });
  });

  $('#join-code').addEventListener('input', function (e) {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('#btn-show-rules').addEventListener('click', function () { openRules(false); });
  $('#btn-show-create').addEventListener('click', function () { go('create'); });
  $('#create-back').addEventListener('click', function () { go('landing'); });

  // ---------------------------------------------------------- create form

  function buildCommodityPicker(host, prefix) {
    clear(host);
    SUIT_ORDER.forEach(function (id) {
      var wrap = h('label', { class: 'commodity-opt', dataset: { suit: id } });
      var box = h('input', { type: 'checkbox', id: prefix + '-on-' + id, checked: true });
      var nameInput = h('input', {
        type: 'text',
        id: prefix + '-nm-' + id,
        maxlength: '24',
        placeholder: 'Flavour name (optional)',
      });
      box.addEventListener('change', function () {
        wrap.classList.toggle('off', !box.checked);
        nameInput.disabled = !box.checked;
      });
      wrap.appendChild(box);
      wrap.appendChild(
        h(
          'span',
          { class: 'co-body' },
          h('span', { class: 'co-name' },
            h('span', { class: 'suit ' + SUITS[id].color, text: SUITS[id].symbol }),
            ' ' + SUITS[id].name),
          nameInput,
        ),
      );
      host.appendChild(wrap);
    });
  }

  function readCommodityPicker(prefix) {
    var out = [];
    SUIT_ORDER.forEach(function (id) {
      var box = document.getElementById(prefix + '-on-' + id);
      if (box && box.checked) {
        var nm = document.getElementById(prefix + '-nm-' + id);
        out.push({ id: id, displayName: nm ? nm.value.trim() : '' });
      }
    });
    return out;
  }

  function writeCommodityPicker(prefix, list) {
    var byId = {};
    list.forEach(function (c) { byId[c.id] = c; });
    SUIT_ORDER.forEach(function (id) {
      var box = document.getElementById(prefix + '-on-' + id);
      var nm = document.getElementById(prefix + '-nm-' + id);
      if (!box || !nm) return;
      box.checked = !!byId[id];
      nm.value = byId[id] ? byId[id].displayName || '' : '';
      nm.disabled = !box.checked;
      box.parentNode.classList.toggle('off', !box.checked);
    });
  }

  buildCommodityPicker($('#commodity-picker'), 'cfg');

  function readCreateConfig(prefix) {
    return {
      commodities: readCommodityPicker(prefix),
      decks: Number(document.getElementById(prefix + '-decks').value),
      maxCardsPerPlayer: Number(document.getElementById(prefix + '-maxcards').value),
      startingCash: Number(document.getElementById(prefix + '-cash').value),
      durationSec: Math.round(Number(document.getElementById(prefix + '-duration').value) * 60),
      hostPlays: document.getElementById(prefix + '-hostplays').checked,
      oneFillPerQuote: document.getElementById(prefix + '-onefill').checked,
    };
  }

  $('#create-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var cfg = readCreateConfig('cfg');
    if (cfg.commodities.length < 2) { toast('Pick at least 2 commodities.', 'err'); return; }
    var name = $('#create-name').value.trim() || 'Host';
    socket.emit('create_session', { hostName: name, config: cfg }, function (res) {
      if (!res || !res.ok) { toast((res && res.error) || 'Could not create the game.', 'err'); return; }
      adoptJoin(res);
    });
  });

  // ----------------------------------------------------------------- rules

  var rulesFirstTime = false;

  function openRules(firstTime) {
    rulesFirstTime = !!firstTime;
    $('#rules-got-it').hidden = !firstTime;
    $('#rules-close').hidden = false;
    $('#rules').hidden = false;
    $('#rules .modal-body').scrollTop = 0;
  }

  function closeRules() {
    $('#rules').hidden = true;
    if (rulesFirstTime && S.identity) {
      socket.emit('player:seen_rules', {});
      S.identity.seenRules = true;
      saveIdentity(S.identity);
      rulesFirstTime = false;
    }
  }

  $('#rules-close').addEventListener('click', closeRules);
  $('#rules-got-it').addEventListener('click', closeRules);
  $('#top-rules').addEventListener('click', function () { openRules(false); });
  $('#rules').addEventListener('click', function (e) {
    if (e.target === $('#rules')) closeRules();
  });

  // ----------------------------------------------------------- game params

  function paramsCard() {
    var s = S.session;
    var dealt = s.cardsPerPlayer * s.playersInRound;
    return h(
      'div',
      null,
      h('p', { class: 'label', text: 'Public game numbers' }),
      h(
        'div',
        { class: 'params' },
        param('Decks', s.config.decks),
        param('Commodities', s.config.commodities.length),
        param('Cards each', s.cardsPerPlayer || '—'),
        param('Players', s.playersInRound || s.players.length),
        param('Cards dealt', dealt || '—'),
        param('Discarded', s.cardsPerPlayer ? s.deckSize - dealt : '—'),
      ),
      h('p', {
        class: 'hint',
        text: 'Every card in a suit averages rank 7. The rest is your job.',
      }),
    );
  }

  function param(k, v) {
    return h('div', { class: 'param' },
      h('span', { class: 'k', text: k }),
      h('span', { class: 'v', text: String(v) }));
  }

  // ----------------------------------------------------------------- lobby

  function renderLobby() {
    var s = S.session;
    $('#lobby-code').textContent = s.code;
    $('#lobby-status').textContent = amInRound()
      ? 'Waiting for the host…'
      : s.round > 0
        ? "Round in progress — you'll be dealt in next round."
        : 'Waiting for the host to deal…';

    $('#lobby-count').textContent = '(' + s.players.length + ')';
    var roster = $('#lobby-roster');
    clear(roster);
    s.players.forEach(function (p) { roster.appendChild(rosterItem(p)); });

    var params = $('#lobby-params');
    clear(params);
    params.appendChild(paramsCard());
  }

  function rosterItem(p) {
    var mine = S.identity && p.id === S.identity.playerId;
    return h(
      'li',
      { class: (p.connected ? '' : 'off ') + (mine ? 'me' : '') },
      h('span', { class: 'dot ' + (p.connected ? '' : 'off') }),
      h('span', { text: p.name }),
      p.isHost ? h('span', { class: 'tag', text: 'host' }) : null,
    );
  }

  // ------------------------------------------------------------------ host

  function renderHost() {
    if (!S.hostShellBuilt) buildHostShell();
    updateHostCode();
    updateHostRoster();
    updateHostControls();
    updateHostLive();
    updateHostHistory();
    updateHostTabs();
  }

  /** Every round's P&L per player, side by side, with the running total. */
  function updateHostHistory() {
    var box = $('#host-history');
    if (!box) return;
    clear(box);

    var history = S.session.roundHistory || [];
    if (!history.length) {
      box.appendChild(h('p', { class: 'muted',
        text: 'Each round\'s P&L appears here once you reveal it.' }));
      return;
    }

    // Order players by cumulative total so the table reads like the standings.
    var order = S.session.cumulativeLeaderboard.map(function (r) { return r; });

    var head = h('tr', null, h('th', { text: 'Player' }));
    history.forEach(function (r) {
      head.appendChild(h('th', { class: 'num', text: 'R' + r.round }));
    });
    head.appendChild(h('th', { class: 'num', text: 'Total' }));

    var tbody = h('tbody');
    order.forEach(function (row, i) {
      var tr = h('tr', null,
        h('td', null, h('span', { class: 'rank', text: String(i + 1) + ' ' }), row.name));
      history.forEach(function (r) {
        var v = r.pnl[row.playerId];
        tr.appendChild(v === undefined
          ? h('td', { class: 'num dim', text: '·', title: 'not in this round' })
          : h('td', { class: 'num ' + signClass(v), text: signed(v) }));
      });
      tr.appendChild(h('td', { class: 'num strong ' + signClass(row.total), text: signed(row.total) }));
      tbody.appendChild(tr);
    });

    var table = h('table', { class: 'tbl' }, h('thead', null, head), tbody);
    box.appendChild(h('div', { class: 'scroll-x' }, table));

    var values = h('div', { class: 'roundvals' });
    history.forEach(function (r) {
      var parts = commodities().map(function (c) {
        return SUITS[c.id].symbol + ' ' + num(r.trueValues[c.id]);
      }).join('   ');
      values.appendChild(h('div', { class: 'roundval' },
        h('b', { text: 'R' + r.round }), ' ' + parts,
        h('span', { class: 'dim', text: '  ' + r.tradeCount + ' trades' })));
    });
    box.appendChild(h('p', { class: 'label', text: 'True values each round' }));
    box.appendChild(values);
  }

  function buildHostShell() {
    var body = $('#host-body');
    clear(body);

    body.appendChild(h('div', { class: 'tabs', id: 'host-tabs' }));

    body.appendChild(
      h('div', { class: 'card center', id: 'host-code-card' },
        h('p', { class: 'label', text: 'Game code' }),
        h('p', { class: 'code-big', id: 'host-code', text: '----' }),
        h('div', { class: 'joinbox', id: 'host-joinbox' })),
    );

    body.appendChild(
      h('div', { class: 'card' },
        h('h2', null, 'Players ', h('span', { class: 'count', id: 'host-count' })),
        h('ul', { class: 'roster', id: 'host-roster' })),
    );

    body.appendChild(
      h('div', { class: 'card' },
        h('h2', { text: 'Round controls' }),
        h('div', { id: 'host-banner' }),
        h('div', { class: 'controls', id: 'host-controls' })),
    );

    body.appendChild(buildHostConfigCard());

    body.appendChild(
      h('div', { class: 'card', id: 'host-live-card' },
        h('h2', { text: 'Live markets' }),
        h('div', { id: 'host-live' })),
    );

    body.appendChild(
      h('div', { class: 'card', id: 'host-history-card' },
        h('h2', { text: 'P&L by round' }),
        h('div', { id: 'host-history' })),
    );

    body.appendChild(
      h('div', { class: 'card', id: 'host-leader-card' },
        h('h2', { text: 'Cumulative leaderboard' }),
        h('div', { id: 'host-leader' })),
    );

    S.hostShellBuilt = true;
    fetchNetworkInfo();
  }

  function buildHostConfigCard() {
    var card = h('div', { class: 'card', id: 'host-config-card' });
    card.appendChild(h('h2', { text: 'Round settings' }));
    card.appendChild(h('p', { class: 'hint', id: 'host-config-note', text: '' }));

    var picker = h('div', { class: 'commodity-picker', id: 'host-picker' });
    card.appendChild(h('fieldset', { class: 'field' },
      h('legend', { text: 'Commodities' }), picker));
    buildCommodityPicker(picker, 'host');

    var grid = h('div', { class: 'grid2' });
    grid.appendChild(h('label', { class: 'field' },
      h('span', { text: 'Decks' }),
      h('select', { id: 'host-decks' },
        h('option', { value: '1', text: '1 deck' }),
        h('option', { value: '2', text: '2 decks' }),
        h('option', { value: '3', text: '3 decks' }),
        h('option', { value: '4', text: '4 decks' }))));
    grid.appendChild(numberField('host-maxcards', 'Max cards / player', 1, 26, 1));
    grid.appendChild(numberField('host-cash', 'Starting cash', 0, 1000000, 1));
    grid.appendChild(numberField('host-duration', 'Round length (min)', 1, 60, 0.5));
    card.appendChild(grid);

    card.appendChild(h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'host-hostplays' }),
      h('span', null, 'Host also plays ', h('em', { text: '(deal me a hand too)' }))));
    card.appendChild(h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'host-onefill' }),
      h('span', null, 'Quote expires after one fill ',
        h('em', { text: '(off = standing quotes)' }))));

    card.appendChild(h('div', { class: 'preview', id: 'host-preview' }));
    card.addEventListener('input', updateDealPreview);
    card.addEventListener('change', updateDealPreview);

    card.appendChild(h('button', {
      class: 'btn primary',
      id: 'host-save-config',
      type: 'button',
      onclick: function () {
        var cfg = readCreateConfig('host');
        if (cfg.commodities.length < 2) { toast('Pick at least 2 commodities.', 'err'); return; }
        socket.emit('host:configure_round', { config: cfg });
        toast('Settings saved.', 'ok');
      },
    }, 'Save settings'));

    return card;
  }

  function numberField(id, label, min, max, step) {
    return h('label', { class: 'field' },
      h('span', { text: label }),
      h('input', {
        type: 'number', id: id, min: String(min), max: String(max), step: String(step),
        inputmode: 'decimal',
      }));
  }

  /**
   * What the settings currently in the form would actually deal, given who is
   * in the room. Recomputed as the host types, so the effect of adding a deck
   * or changing hand size is visible before committing to it.
   */
  function updateDealPreview() {
    var box = $('#host-preview');
    if (!box || !S.session) return;
    clear(box);

    var cfg = readCreateConfig('host');
    var suits = cfg.commodities.length;
    var roster = S.session.players.filter(function (p) {
      return !p.isHost || cfg.hostPlays;
    }).length;
    var deckSize = suits * 13 * cfg.decks;
    var each = roster > 0 ? Math.min(cfg.maxCardsPerPlayer, Math.floor(deckSize / roster)) : 0;
    var discarded = deckSize - each * roster;

    box.appendChild(h('div', { class: 'preview-line' },
      h('b', { text: String(deckSize) }), ' cards',
      ' · ', h('b', { text: String(roster) }), ' playing',
      ' · ', h('b', { text: String(each) }), ' cards each',
      ' · ', h('b', { text: String(discarded) }), ' discarded'));

    var warn = null;
    if (suits < 2) warn = 'Pick at least 2 commodities.';
    else if (roster < 2) warn = 'Waiting for at least 2 players to be dealt in.';
    else if (each < 1) warn = 'Not enough cards to go round — add a deck or a commodity.';
    else if (discarded === 0) {
      warn = 'Every card would be dealt, so every value would be public knowledge before the round starts. Lower max cards per player.';
    } else if (discarded < suits) {
      warn = 'Almost nothing would be discarded, so the values are nearly public. Lower max cards per player.';
    }
    if (warn) box.appendChild(h('div', { class: 'preview-warn', text: warn }));
  }

  var hostConfigSynced = null;

  function syncHostConfigForm() {
    var s = S.session;
    var key = JSON.stringify(s.config);
    if (hostConfigSynced === key) return;
    hostConfigSynced = key;
    writeCommodityPicker('host', s.config.commodities);
    $('#host-decks').value = String(s.config.decks);
    $('#host-maxcards').value = String(s.config.maxCardsPerPlayer);
    $('#host-cash').value = String(s.config.startingCash);
    $('#host-duration').value = String(Math.round((s.config.durationSec / 60) * 10) / 10);
    $('#host-hostplays').checked = !!s.config.hostPlays;
    $('#host-onefill').checked = !!s.config.oneFillPerQuote;
  }

  function fetchNetworkInfo() {
    fetch('/api/network')
      .then(function (r) { return r.json(); })
      .then(function (info) {
        var box = $('#host-joinbox');
        if (!box) return;
        clear(box);
        if (info.qr) box.appendChild(h('img', { src: info.qr, alt: 'QR code to join' }));
        var links = h('div', null,
          h('p', { class: 'label', text: 'Players join at' }),
          h('p', { class: 'joinurl mono', text: info.url }));
        if (info.addresses.length > 1) {
          links.appendChild(h('p', { class: 'hint', text: 'Other addresses: ' +
            info.addresses.slice(1).map(function (a) {
              return 'http://' + a.address + ':' + info.port;
            }).join('  ') }));
        }
        box.appendChild(links);
      })
      .catch(function () { /* the code alone is enough to join */ });
  }

  function updateHostCode() { $('#host-code').textContent = S.session.code; }

  function updateHostRoster() {
    var s = S.session;
    $('#host-count').textContent = '(' + s.players.length + ')';
    var list = $('#host-roster');
    clear(list);
    s.players.forEach(function (p) {
      var item = rosterItem(p);
      if (!p.isHost && (s.phase === 'lobby' || s.phase === 'revealed')) {
        item.appendChild(h('button', {
          class: 'btn ghost small',
          type: 'button',
          title: 'Remove ' + p.name,
          onclick: function () {
            if (window.confirm('Remove ' + p.name + ' from the roster? They can rejoin with the code.')) {
              socket.emit('host:kick_player', { playerId: p.id });
            }
          },
        }, '×'));
      }
      list.appendChild(item);
    });
  }

  function hostButton(label, event, opts) {
    opts = opts || {};
    return h('button', {
      class: 'btn ' + (opts.primary ? 'primary' : opts.danger ? 'danger' : ''),
      type: 'button',
      disabled: opts.disabled,
      onclick: function () {
        if (opts.confirm && !window.confirm(opts.confirm)) return;
        socket.emit(event, {});
      },
    }, label);
  }

  function updateHostControls() {
    var s = S.session;
    var box = $('#host-controls');
    clear(box);

    var rosterSize = s.players.filter(function (p) { return !p.isHost || s.config.hostPlays; }).length;
    var canDeal = (s.phase === 'lobby' || s.phase === 'revealed') && rosterSize >= 2;

    box.appendChild(hostButton(
      s.round === 0 ? 'Deal cards' : 'Next round (deal)',
      s.phase === 'revealed' ? 'host:next_round' : 'host:deal',
      { primary: canDeal, disabled: !canDeal },
    ));
    box.appendChild(hostButton('Start trading', 'host:start_trading',
      { primary: s.phase === 'dealt', disabled: s.phase !== 'dealt' }));
    box.appendChild(hostButton('End round', 'host:end_round',
      { primary: s.phase === 'trading', disabled: s.phase !== 'trading' }));
    box.appendChild(hostButton('Reveal values', 'host:reveal',
      { primary: s.phase === 'locked', disabled: s.phase !== 'locked' && s.phase !== 'trading' }));
    box.appendChild(hostButton('End session', 'host:end_session', {
      danger: true,
      disabled: s.phase === 'ended',
      confirm: 'End the whole session and show final standings?',
    }));

    var banner = $('#host-banner');
    clear(banner);
    var msg = null;
    if (s.phase === 'lobby' && rosterSize < 2) {
      msg = ['warn', 'Waiting for at least 2 players' +
        (s.config.hostPlays ? '' : ' (you are not playing — turn on "host also plays" to count yourself)') + '.'];
    } else if (s.phase === 'lobby') msg = ['info', 'Ready to deal ' + rosterSize + ' players in.'];
    else if (s.phase === 'dealt') msg = ['info', 'Hands are out. Start trading when the room is ready.'];
    else if (s.phase === 'trading') msg = ['info', 'Market is live — ' + clockText(remainingMs()) + ' left.'];
    else if (s.phase === 'locked') msg = ['warn', 'Trading closed. Reveal when everyone is watching.'];
    else if (s.phase === 'revealed') msg = ['info', 'Round ' + s.round + ' scored. Deal again or end the session.'];
    else if (s.phase === 'ended') msg = ['warn', 'Session finished.'];
    if (msg) banner.appendChild(h('div', { class: 'banner ' + msg[0], text: msg[1] }));

    var editable = s.phase === 'lobby' || s.phase === 'revealed';
    $('#host-config-note').textContent = editable
      ? 'Applies to the next deal.'
      : 'Locked while a round is in progress.';
    var card = $('#host-config-card');
    var inputs = card.querySelectorAll('input, select, button');
    for (var i = 0; i < inputs.length; i += 1) inputs[i].disabled = !editable;
    syncHostConfigForm();
    updateDealPreview();
  }

  function updateHostTabs() {
    var tabs = $('#host-tabs');
    if (!tabs) return;
    clear(tabs);
    if (!S.session.config.hostPlays) { tabs.hidden = true; return; }
    tabs.hidden = false;
    tabs.appendChild(h('button', {
      class: 'btn ' + (S.hostTab === 'dashboard' ? 'on' : ''),
      type: 'button',
      onclick: function () { S.hostTab = 'dashboard'; render(); },
    }, 'Dashboard'));
    tabs.appendChild(h('button', {
      class: 'btn ' + (S.hostTab === 'desk' ? 'on' : ''),
      type: 'button',
      onclick: function () { S.hostTab = 'desk'; render(); },
    }, 'My desk'));
  }

  function updateHostLive() {
    var s = S.session;
    var host = $('#host-live');
    if (!host) return;
    clear(host);

    if (s.phase === 'lobby') {
      host.appendChild(h('p', { class: 'muted', text: 'Markets appear once trading starts.' }));
      return;
    }

    commodities().forEach(function (c) {
      var book = (s.quotes && s.quotes[c.id]) || {};
      var rows = Object.keys(book).map(function (pid) {
        return { pid: pid, bid: book[pid].bid, ask: book[pid].ask };
      }).sort(function (a, b) {
        return (b.bid === null ? -Infinity : b.bid) - (a.bid === null ? -Infinity : a.bid);
      });

      var table = h('table', { class: 'tbl hostbook' },
        h('thead', null, h('tr', null,
          h('th', { text: commodityName(c) + ' ' + SUITS[c.id].symbol }),
          h('th', { class: 'num', text: 'Bid' }),
          h('th', { class: 'num', text: 'Ask' }))));
      var tbody = h('tbody');
      if (!rows.length) {
        tbody.appendChild(h('tr', null, h('td', { colspan: '3', class: 'dim', text: 'No quotes yet.' })));
      }
      rows.forEach(function (r) {
        tbody.appendChild(h('tr', null,
          h('td', { text: playerName(r.pid) }),
          h('td', { class: 'num b', text: r.bid === null ? '—' : num(r.bid) }),
          h('td', { class: 'num a', text: r.ask === null ? '—' : num(r.ask) })));
      });
      table.appendChild(tbody);
      host.appendChild(h('div', { class: 'scroll-x' }, table));
    });

    host.appendChild(h('h3', { text: 'Trade tape' }));
    host.appendChild(tapeList());

    var leader = $('#host-leader');
    clear(leader);
    leader.appendChild(leaderboardTable(s.cumulativeLeaderboard));
  }

  // ------------------------------------------------------------------ play

  function renderPlay() {
    var key = [S.session.round, commodities().map(function (c) { return c.id; }).join(''), amInRound()].join('|');
    if (S.shellKey !== key) buildPlayShell(key);
    updateParams();
    updateHand();
    updateAllBooks();
    updateMe();
    updateTape();
    updatePhaseNotice();
  }

  function buildPlayShell(key) {
    var body = $('#play-body');
    clear(body);
    S.shellKey = key;

    var m = me();
    if (m && m.isHost && S.session.config.hostPlays) {
      var tabs = h('div', { class: 'tabs' });
      tabs.appendChild(h('button', {
        class: 'btn', type: 'button',
        onclick: function () { S.hostTab = 'dashboard'; render(); },
      }, '← Dashboard'));
      tabs.appendChild(h('button', { class: 'btn on', type: 'button' }, 'My desk'));
      body.appendChild(tabs);
    }

    body.appendChild(h('div', { id: 'play-notice' }));

    if (!amInRound()) {
      body.appendChild(h('div', { class: 'card' },
        h('h2', { text: 'Sitting this round out' }),
        h('p', { class: 'muted', text: 'You joined after the cards were dealt. You will be dealt in at the start of the next round — watch the tape in the meantime.' })));
      body.appendChild(h('div', { class: 'card', id: 'play-params' }));
      body.appendChild(h('div', { class: 'card' },
        h('h2', { text: 'Trade tape' }),
        h('div', { id: 'play-tape', class: 'tape' })));
      return;
    }

    body.appendChild(h('div', { class: 'card', id: 'play-params' }));

    body.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Your hand' }),
      h('div', { id: 'play-hand' })));

    var cmds = h('div', { id: 'play-cmds' });
    commodities().forEach(function (c) { cmds.appendChild(buildCommodityPanel(c)); });

    // On a laptop the tape sits beside the quote panels and stays in view; on a
    // phone it stacks directly under them, with per-commodity prints inline.
    body.appendChild(h('div', { class: 'trading-grid' },
      cmds,
      h('aside', { class: 'tape-col' },
        h('div', { class: 'card tape-card' },
          h('h2', { text: 'Trade tape' }),
          h('div', { id: 'play-tape', class: 'tape' })))));

    body.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Your book' }),
      h('div', { id: 'play-me' })));
  }

  function draft(cid) {
    if (!S.drafts[cid]) S.drafts[cid] = { bid: '', ask: '' };
    return S.drafts[cid];
  }

  function buildCommodityPanel(c) {
    var cid = c.id;
    var panel = h('section', { class: 'cmd', dataset: { cid: cid } });

    panel.appendChild(h('header', { class: 'cmd-head' },
      h('span', { class: 'suit ' + SUITS[cid].color, text: SUITS[cid].symbol }),
      h('span', null,
        h('span', { class: 'name', text: commodityName(c) }),
        c.displayName ? h('span', { class: 'sub', text: ' · ' + SUITS[cid].name }) : null),
      h('span', { class: 'stats', id: 'stats-' + cid })));

    panel.appendChild(h('div', { class: 'bbo', id: 'bbo-' + cid }));

    // Recent prints for this commodity, right where you type your price.
    panel.appendChild(h('div', { class: 'prints', id: 'prints-' + cid }));

    var d = draft(cid);
    var bidInput = h('input', {
      type: 'text', inputmode: 'decimal', id: 'bid-' + cid, placeholder: 'bid', value: d.bid,
    });
    var askInput = h('input', {
      type: 'text', inputmode: 'decimal', id: 'ask-' + cid, placeholder: 'ask', value: d.ask,
    });
    bidInput.addEventListener('input', function () { draft(cid).bid = bidInput.value; });
    askInput.addEventListener('input', function () { draft(cid).ask = askInput.value; });
    function onEnter(e) { if (e.key === 'Enter') { e.preventDefault(); submitQuote(cid); } }
    bidInput.addEventListener('keydown', onEnter);
    askInput.addEventListener('keydown', onEnter);

    panel.appendChild(h('div', { class: 'quoter' },
      h('label', { class: 'field' }, h('span', { text: 'My bid' }), bidInput),
      h('label', { class: 'field' }, h('span', { text: 'My ask' }), askInput),
      h('div', { class: 'qbtns' },
        h('button', {
          class: 'btn primary', type: 'button', id: 'send-' + cid,
          onclick: function () { submitQuote(cid); },
        }, 'Quote'),
        h('button', {
          class: 'btn ghost', type: 'button', id: 'clear-' + cid,
          onclick: function () {
            draft(cid).bid = '';
            draft(cid).ask = '';
            bidInput.value = '';
            askInput.value = '';
            socket.emit('player:clear_quote', { commodityId: cid });
          },
        }, 'Clear'))));

    panel.appendChild(h('div', { class: 'myquote', id: 'myq-' + cid }));

    panel.appendChild(h('div', { class: 'book' },
      h('div', { class: 'book-head' }, h('span', { text: 'Bids' }), h('span', { text: 'Asks' })),
      h('div', { class: 'ladder', id: 'book-' + cid })));

    return panel;
  }

  function submitQuote(cid) {
    var d = draft(cid);
    var bidRaw = d.bid.trim();
    var askRaw = d.ask.trim();
    var bid = bidRaw === '' ? null : Number(bidRaw);
    var ask = askRaw === '' ? null : Number(askRaw);
    if (bidRaw !== '' && !isFinite(bid)) { toast('Bid must be a number.', 'err'); return; }
    if (askRaw !== '' && !isFinite(ask)) { toast('Ask must be a number.', 'err'); return; }
    if (bid !== null && ask !== null && bid >= ask) {
      toast('Your bid must be below your ask.', 'err');
      return;
    }
    socket.emit('player:update_quote', { commodityId: cid, bid: bid, ask: ask });
  }

  function updateParams() {
    var box = $('#play-params');
    if (!box) return;
    clear(box);
    box.appendChild(paramsCard());
  }

  function updatePhaseNotice() {
    var box = $('#play-notice');
    if (!box) return;
    clear(box);
    var phase = S.session.phase;
    if (!S.connected) {
      box.appendChild(h('div', { class: 'banner warn', text: 'Reconnecting… your quotes are still live.' }));
      return;
    }
    if (phase === 'dealt') {
      box.appendChild(h('div', { class: 'banner info',
        text: 'Study your hand. Quoting opens when the host starts the clock.' }));
    } else if (phase === 'locked') {
      box.appendChild(h('div', { class: 'banner warn',
        text: 'Trading is closed. Waiting for the host to reveal.' }));
    }
    var tradable = phase === 'trading';
    commodities().forEach(function (c) {
      ['bid-', 'ask-', 'send-', 'clear-'].forEach(function (p) {
        var el = document.getElementById(p + c.id);
        if (el) el.disabled = !tradable;
      });
    });
  }

  function updateHand() {
    var box = $('#play-hand');
    if (!box) return;
    clear(box);
    if (!S.hand || !S.hand.length) {
      box.appendChild(h('p', { class: 'empty-hand', text: 'No cards yet.' }));
      return;
    }
    commodities().forEach(function (c) {
      var cards = S.hand.filter(function (card) { return card.suit === c.id; });
      var sub = (S.subtotals && S.subtotals[c.id]) || 0;
      var group = h('div', { class: 'hand-suit' },
        h('div', { class: 'hand-head' },
          h('span', { class: 'suit ' + SUITS[c.id].color, text: SUITS[c.id].symbol }),
          h('span', { text: commodityName(c) }),
          h('span', { class: 'sub' }, 'your cards sum to ', h('b', { text: String(sub) }))));
      var row = h('div', { class: 'cards' });
      if (!cards.length) row.appendChild(h('span', { class: 'empty-hand', text: 'none' }));
      cards
        .slice()
        .sort(function (a, b) { return a.rank - b.rank; })
        .forEach(function (card) {
          row.appendChild(h('span', { class: 'pcard ' + SUITS[card.suit].color },
            rankLabel(card.rank),
            h('span', { class: 's', text: SUITS[card.suit].symbol })));
        });
      group.appendChild(row);
      box.appendChild(group);
    });
  }

  function bookRows(cid) {
    var book = (S.session.quotes && S.session.quotes[cid]) || {};
    var bids = [];
    var asks = [];
    Object.keys(book).forEach(function (pid) {
      var q = book[pid];
      if (q.bid !== null && q.bid !== undefined) bids.push({ pid: pid, price: q.bid });
      if (q.ask !== null && q.ask !== undefined) asks.push({ pid: pid, price: q.ask });
    });
    bids.sort(function (a, b) { return b.price - a.price; });
    asks.sort(function (a, b) { return a.price - b.price; });
    return { bids: bids, asks: asks };
  }

  function updateAllBooks() {
    commodities().forEach(function (c) { updateBook(c.id); });
  }

  function updateBook(cid) {
    var ladder = document.getElementById('book-' + cid);
    if (!ladder) return;
    var myId = S.identity.playerId;
    var rows = bookRows(cid);
    var tradable = S.session.phase === 'trading' && amInRound();

    // --- header stats: market BBO, my position, last trade
    var stats = document.getElementById('stats-' + cid);
    if (stats) {
      clear(stats);
      var holding = (S.position && S.position.holdings && S.position.holdings[cid]) || 0;
      var mark = S.session.marks && S.session.marks[cid];
      stats.appendChild(h('span', null, 'Last',
        h('b', { text: mark === undefined || mark === null ? '—' : num(mark) })));
      stats.appendChild(h('span', null, 'Position',
        h('b', { class: signClass(holding), text: signed(holding) })));
    }

    // --- one-tap best tradeable quotes (yours are excluded — you can't hit yourself)
    var bbo = document.getElementById('bbo-' + cid);
    if (bbo) {
      clear(bbo);
      var bestBid = rows.bids.filter(function (r) { return r.pid !== myId; })[0];
      var bestAsk = rows.asks.filter(function (r) { return r.pid !== myId; })[0];
      bbo.appendChild(actionButton(cid, 'hit', bestBid, tradable));
      bbo.appendChild(actionButton(cid, 'lift', bestAsk, tradable));
    }

    // --- my own resting quote, echoed back from the server
    var myq = document.getElementById('myq-' + cid);
    if (myq) {
      clear(myq);
      var mine = ((S.session.quotes && S.session.quotes[cid]) || {})[myId];
      if (mine && (mine.bid !== null || mine.ask !== null)) {
        myq.appendChild(h('span', null, 'Your market: ',
          h('b', { text: mine.bid === null ? '—' : num(mine.bid) }),
          ' / ',
          h('b', { text: mine.ask === null ? '—' : num(mine.ask) })));
      } else {
        myq.appendChild(h('span', { class: 'dim', text: 'You have no quote in this market.' }));
      }
    }

    clear(ladder);
    ladder.appendChild(sideColumn(cid, 'bids', rows.bids, tradable));
    ladder.appendChild(sideColumn(cid, 'asks', rows.asks, tradable));

    updatePrints(cid);
  }

  /** The last few prices this commodity actually traded at, newest first. */
  function updatePrints(cid) {
    var box = document.getElementById('prints-' + cid);
    if (!box) return;
    clear(box);

    var recent = (S.session.trades || [])
      .filter(function (t) { return t.commodityId === cid; })
      .slice(-8)
      .reverse();

    if (!recent.length) {
      box.appendChild(h('span', { class: 'prints-empty', text: 'no trades yet in this market' }));
      return;
    }

    box.appendChild(h('span', { class: 'prints-label', text: 'Traded' }));
    var myId = S.identity.playerId;
    recent.forEach(function (t) {
      var mine = t.buyerId === myId || t.sellerId === myId;
      box.appendChild(h('span', {
        class: 'print ' + (t.side === 'lift' ? 'buy' : 'sell') + (mine ? ' mine' : ''),
        title: playerName(t.buyerId) + ' bought from ' + playerName(t.sellerId) +
          ' at ' + num(t.price) + ' (' + timeOfDay(t.ts) + ')',
        text: num(t.price),
      }));
    });
  }

  function actionButton(cid, side, quote, tradable) {
    if (!quote) {
      return h('button', { class: 'btn flat', type: 'button', disabled: true },
        h('span', { class: 'p', text: '—' }),
        h('span', { class: 'n', text: side === 'hit' ? 'no bid' : 'no ask' }));
    }
    return h('button', {
      class: 'btn ' + (side === 'hit' ? 'bid' : 'ask'),
      type: 'button',
      disabled: !tradable,
      onclick: function () { sendTrade(cid, side, quote.pid, quote.price); },
    },
      h('span', { class: 'p', text: num(quote.price) }),
      h('span', { class: 'n', text: (side === 'hit' ? 'Hit · sell to ' : 'Lift · buy from ') + playerName(quote.pid) }));
  }

  function sideColumn(cid, which, rows, tradable) {
    var myId = S.identity.playerId;
    var col = h('div', { class: 'side ' + which });
    if (!rows.length) {
      col.appendChild(h('div', { class: 'side-empty', text: which === 'bids' ? 'no bids' : 'no asks' }));
      return col;
    }
    rows.slice(0, 12).forEach(function (r) {
      var isMine = r.pid === myId;
      var row = h('div', { class: 'qrow ' + (isMine ? 'mine' : '') },
        h('span', { class: 'px', text: num(r.price) }),
        h('span', { class: 'nm', text: isMine ? 'you' : playerName(r.pid) }));
      if (!isMine) {
        row.appendChild(h('button', {
          class: 'btn ' + (which === 'bids' ? 'bid' : 'ask'),
          type: 'button',
          disabled: !tradable,
          onclick: function () {
            sendTrade(cid, which === 'bids' ? 'hit' : 'lift', r.pid, r.price);
          },
        }, which === 'bids' ? 'Hit' : 'Lift'));
      }
      col.appendChild(row);
    });
    return col;
  }

  function sendTrade(cid, side, counterpartyId, expectedPrice) {
    socket.emit(
      side === 'lift' ? 'player:lift_ask' : 'player:hit_bid',
      { commodityId: cid, counterpartyId: counterpartyId, expectedPrice: expectedPrice },
      function (res) {
        if (!res || !res.ok) toast((res && res.error) || 'Trade rejected.', 'err');
      },
    );
  }

  function updateMe() {
    var box = $('#play-me');
    if (!box) return;
    clear(box);
    if (!S.position) {
      box.appendChild(h('p', { class: 'muted', text: 'Not trading this round.' }));
      return;
    }
    var table = h('table', { class: 'tbl' },
      h('thead', null, h('tr', null,
        h('th', { text: 'Commodity' }),
        h('th', { class: 'num', text: 'Position' }),
        h('th', { class: 'num', text: 'Last' }),
        h('th', { class: 'num', text: 'Your cards' }))));
    var tbody = h('tbody');
    commodities().forEach(function (c) {
      var pos = S.position.holdings[c.id] || 0;
      var mark = S.session.marks && S.session.marks[c.id];
      tbody.appendChild(h('tr', null,
        h('td', null, h('span', { class: 'suit ' + SUITS[c.id].color, text: SUITS[c.id].symbol }),
          ' ' + commodityName(c)),
        h('td', { class: 'num ' + signClass(pos), text: signed(pos) }),
        h('td', { class: 'num dim', text: mark === undefined || mark === null ? '—' : num(mark) }),
        h('td', { class: 'num dim', text: String((S.subtotals && S.subtotals[c.id]) || 0) })));
    });
    table.appendChild(tbody);

    box.appendChild(h('div', { class: 'params' },
      param('Cash', num(S.position.cash)),
      param('Trades', S.session.trades.filter(function (t) {
        return t.buyerId === S.identity.playerId || t.sellerId === S.identity.playerId;
      }).length)));
    box.appendChild(h('div', { class: 'scroll-x' }, table));
    box.appendChild(h('p', { class: 'hint',
      text: 'Marks are last traded price, not true value. True value stays hidden until Reveal.' }));
  }

  function tapeList() {
    var wrap = h('div', { class: 'tape' });
    var trades = (S.session.trades || []).slice(-40).reverse();
    if (!trades.length) {
      wrap.appendChild(h('p', { class: 'muted', text: 'No trades yet.' }));
      return wrap;
    }
    var myId = S.identity && S.identity.playerId;
    trades.forEach(function (t) {
      var mine = t.buyerId === myId || t.sellerId === myId;
      wrap.appendChild(h('div', {
        class: 'tape-row ' + (mine ? 'mine ' : '') + (S.freshTrades[t.id] ? 'fresh' : ''),
      },
        h('span', { class: 't', text: timeOfDay(t.ts) }),
        h('span', { class: 'suit ' + SUITS[t.commodityId].color, text: SUITS[t.commodityId].symbol }),
        h('span', { class: 'px', text: num(t.price) }),
        h('span', { class: 'desc', text: playerName(t.buyerId) + ' bought from ' + playerName(t.sellerId) })));
    });
    return wrap;
  }

  function updateTape() {
    var box = $('#play-tape');
    if (!box) return;
    var list = tapeList();
    clear(box);
    while (list.firstChild) box.appendChild(list.firstChild);
  }

  // ---------------------------------------------------------------- reveal

  function renderReveal() {
    var s = S.session;
    var body = $('#reveal-body');
    clear(body);

    var m = me();
    if (m && m.isHost && s.config.hostPlays) {
      var tabs = h('div', { class: 'tabs' });
      tabs.appendChild(h('button', {
        class: 'btn', type: 'button',
        onclick: function () { S.hostTab = 'dashboard'; render(); },
      }, '← Dashboard'));
      tabs.appendChild(h('button', { class: 'btn on', type: 'button' }, 'Results'));
      body.appendChild(tabs);
    }

    if (s.phase === 'ended') {
      body.appendChild(h('div', { class: 'card center' },
        h('h2', { text: 'Session complete' }),
        h('p', { class: 'muted', text: 'Final standings after ' + s.round + ' round' + (s.round === 1 ? '' : 's') + '.' })));
    }

    if (s.trueValues) {
      var tvCard = h('div', { class: 'card' },
        h('h2', { text: 'True values — round ' + s.round }));
      var grid = h('div', { class: 'tv-grid' });
      commodities().forEach(function (c) {
        var b = s.valueBreakdown && s.valueBreakdown[c.id];
        grid.appendChild(h('div', { class: 'tv' },
          h('div', { class: 'n' },
            h('span', { class: 'suit ' + SUITS[c.id].color, text: SUITS[c.id].symbol }),
            ' ' + commodityName(c)),
          h('div', { class: 'v', text: num(s.trueValues[c.id]) }),
          b ? h('div', { class: 'b',
            text: b.dealtCount + ' dealt · ' + b.discardedCount + ' discarded (' + b.discardedSum + ')' }) : null));
      });
      tvCard.appendChild(grid);
      tvCard.appendChild(h('p', { class: 'hint',
        text: 'Value = sum of ranks of the cards of that suit that were dealt. Discarded cards counted for nothing.' }));
      body.appendChild(tvCard);
    }

    if (s.roundResults && s.roundResults.length) {
      var rCard = h('div', { class: 'card' }, h('h2', { text: 'Round ' + s.round + ' P&L' }));
      var table = h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
          h('th', { text: '#' }),
          h('th', { text: 'Player' }),
          h('th', { class: 'num', text: 'Cash Δ' }),
          h('th', { class: 'num', text: 'Inventory' }),
          h('th', { class: 'num', text: 'P&L' }))));
      var tbody = h('tbody');
      s.roundResults.forEach(function (r, i) {
        var mine = S.identity && r.playerId === S.identity.playerId;
        var posText = commodities().map(function (c) {
          var v = r.holdings[c.id] || 0;
          return v === 0 ? null : SUITS[c.id].symbol + signed(v);
        }).filter(Boolean).join(' ') || 'flat';
        tbody.appendChild(h('tr', { class: mine ? 'me' : '' },
          h('td', { class: 'rank', text: String(i + 1) }),
          h('td', null, r.name, h('span', { class: 'dim', text: '  ' + posText })),
          h('td', { class: 'num ' + signClass(r.cashDelta), text: signed(r.cashDelta) }),
          h('td', { class: 'num ' + signClass(r.markToMarket), text: signed(r.markToMarket) }),
          h('td', { class: 'num ' + signClass(r.pnl), text: signed(r.pnl) })));
      });
      table.appendChild(tbody);
      rCard.appendChild(h('div', { class: 'scroll-x' }, table));
      body.appendChild(rCard);
    }

    if (s.trueValues) body.appendChild(revealTapeCard());

    body.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Cumulative leaderboard' }),
      leaderboardTable(s.cumulativeLeaderboard)));

    if (!(m && m.isHost)) {
      body.appendChild(h('div', { class: 'card center' },
        h('p', { class: 'muted', text: s.phase === 'ended'
          ? 'Thanks for playing.'
          : 'Waiting for the host to start the next round…' })));
    }
  }

  /**
   * P&L a single trade earned the given player, now that the value is known.
   * Buying below the true value makes money; selling above it does.
   * Summed over a player's trades, these come to exactly their round P&L.
   */
  function tradePnl(trade, playerId, trueValues) {
    var v = trueValues[trade.commodityId];
    if (v === undefined || v === null) return 0;
    if (trade.buyerId === playerId) return v - trade.price;
    if (trade.sellerId === playerId) return trade.price - v;
    return 0;
  }

  function revealTapeCard() {
    var s = S.session;
    var myId = S.identity.playerId;
    var trades = s.trades || [];
    var card = h('div', { class: 'card' }, h('h2', { text: 'Every trade this round' }));

    if (!trades.length) {
      card.appendChild(h('p', { class: 'muted', text: 'No trades were made this round.' }));
      return card;
    }

    var mine = trades.filter(function (t) {
      return t.buyerId === myId || t.sellerId === myId;
    });

    if (mine.length) {
      var totals = mine.map(function (t) { return tradePnl(t, myId, s.trueValues); });
      var sum = totals.reduce(function (a, b) { return a + b; }, 0);
      var wins = totals.filter(function (x) { return x > 0; }).length;
      card.appendChild(h('div', { class: 'params' },
        param('Your trades', mine.length),
        param('Good ones', wins + '/' + mine.length),
        param('Best', signed(Math.max.apply(null, totals))),
        param('Worst', signed(Math.min.apply(null, totals)))));
      card.appendChild(h('p', { class: 'hint',
        text: 'These add up to ' + signed(sum) + ', which is exactly your round P&L — every '
          + 'point you made or lost came from one of these trades.' }));
    } else {
      card.appendChild(h('p', { class: 'muted',
        text: "You didn't trade this round, so your P&L is zero. Here's what everyone else did." }));
    }

    var tabs = h('div', { class: 'tabs' });
    function tabButton(label, mode) {
      return h('button', {
        class: 'btn small ' + (S.revealTape === mode ? 'on' : ''),
        type: 'button',
        onclick: function () { S.revealTape = mode; renderReveal(); },
      }, label);
    }
    if (mine.length) {
      tabs.appendChild(tabButton('My trades (' + mine.length + ')', 'mine'));
      tabs.appendChild(tabButton('All trades (' + trades.length + ')', 'all'));
      card.appendChild(tabs);
    }

    var showing = (S.revealTape === 'all' || !mine.length) ? trades : mine;
    var capped = showing.slice(-200).reverse();

    var table = h('table', { class: 'tbl tape-tbl' },
      h('thead', null, h('tr', null,
        h('th', { text: 'Time' }),
        h('th', { text: 'Market' }),
        h('th', { class: 'num', text: 'Price' }),
        h('th', { class: 'num', text: 'True' }),
        h('th', { text: 'Buyer' }),
        h('th', { text: 'Seller' }),
        h('th', { class: 'num', text: mine.length && S.revealTape !== 'all' ? 'Your P&L' : 'Buyer P&L' }))));

    var tbody = h('tbody');
    capped.forEach(function (t) {
      var v = s.trueValues[t.commodityId];
      var involved = t.buyerId === myId || t.sellerId === myId;
      var showMine = involved && S.revealTape !== 'all';
      var pnl = showMine ? tradePnl(t, myId, s.trueValues) : v - t.price;
      tbody.appendChild(h('tr', { class: involved ? 'me' : '' },
        h('td', { class: 'dim', text: timeOfDay(t.ts) }),
        h('td', null, h('span', { class: 'suit ' + SUITS[t.commodityId].color,
          text: SUITS[t.commodityId].symbol })),
        h('td', { class: 'num', text: num(t.price) }),
        h('td', { class: 'num dim', text: num(v) }),
        h('td', { class: t.buyerId === myId ? 'you' : '', text: playerName(t.buyerId) }),
        h('td', { class: t.sellerId === myId ? 'you' : '', text: playerName(t.sellerId) }),
        h('td', { class: 'num ' + signClass(pnl), text: signed(pnl) })));
    });
    table.appendChild(tbody);

    card.appendChild(h('div', { class: 'scroll-x' }, table));
    if (showing.length > 200) {
      card.appendChild(h('p', { class: 'hint',
        text: 'Showing the most recent 200 of ' + showing.length + ' trades.' }));
    }
    if (!mine.length || S.revealTape === 'all') {
      card.appendChild(h('p', { class: 'hint',
        text: 'Buyer P&L is what the buyer made on that unit; the seller made the opposite.' }));
    }
    return card;
  }

  function leaderboardTable(rows) {
    if (!rows || !rows.length) return h('p', { class: 'muted', text: 'Nothing scored yet.' });
    var table = h('table', { class: 'tbl' },
      h('thead', null, h('tr', null,
        h('th', { text: '#' }),
        h('th', { text: 'Player' }),
        h('th', { class: 'num', text: 'Total P&L' }))));
    var tbody = h('tbody');
    rows.forEach(function (r, i) {
      var mine = S.identity && r.playerId === S.identity.playerId;
      tbody.appendChild(h('tr', { class: mine ? 'me' : '' },
        h('td', { class: 'rank', text: String(i + 1) }),
        h('td', { text: r.name }),
        h('td', { class: 'num ' + signClass(r.total), text: signed(r.total) })));
    });
    table.appendChild(tbody);
    return h('div', { class: 'scroll-x' }, table);
  }

  // ------------------------------------------------------------------ boot

  S.identity = loadIdentity();
  if (S.identity && S.identity.name) {
    $('#join-name').value = S.identity.name;
    $('#join-code').value = S.identity.sessionCode || '';
  }
  go('landing');
})();
