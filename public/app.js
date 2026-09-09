/* PIXEL POINTS client. Consumes the Task 5 wire contract exactly:
   C→S acks: room:create, room:join, session:resume, round:start, vote:cast,
             round:consensus, round:revote, round:new, round:abandon, room:leave
   S→C: room:state (individual, includes you), room:update (broadcast, no you). */

const socket = io();

const DECK = [
  { value: '0', label: '0' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '8', label: '8' },
  { value: '13', label: '13' },
  { value: '21', label: '21' },
  { value: 'coffee', label: 'COFFEE', emoji: '\u2615' },
  { value: 'question', label: '?', emoji: '\u2753' },
];
const NUMERIC_OPTIONS = ['0', '1', '2', '3', '5', '8', '13', '21'];
const THEMES = [
  { id: 'crt-dark', label: 'CRT Neon (dark)' },
  { id: 'crt-light', label: 'CRT Neon (light)' },
  { id: 'pixel-dark', label: 'Pixel Pop (dark)' },
  { id: 'pixel-light', label: 'Pixel Pop (light)' },
  { id: 'mono-dark', label: 'Mono (dark)' },
  { id: 'mono-light', label: 'Mono (light)' },
];

let state = null;
let you = null;
let selectedVote = null;
let roomCode = null;
let countdownEndsAt = null;
let countdownTimer = null;
let homeError = null;
let lobbyDescDraft = '';      // preserve SM's typed description across re-renders
let lobbyDescCaret = null;   // desc input caret to restore after a re-render (M2)
let consensusChoice = null;   // preserve SM's picked points across re-renders
let historyOpen = false;      // preserve history panel open state across re-renders

const $app = document.getElementById('app');
const $overlay = document.getElementById('overlay');

const emitAck = (ev, data) =>
  new Promise((resolve) => socket.emit(ev, data, resolve));

/* ------------------------------ helpers ------------------------------ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val === null || val === undefined) continue;
    if (key === 'class') node.className = val;
    else if (key === 'text') node.textContent = val;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
    else node.setAttribute(key, val);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const compact = (nodes) => nodes.filter((n) => n !== null && n !== undefined);

function applyTheme() {
  const stored = localStorage.getItem('pp-theme');
  const theme = THEMES.some((t) => t.id === stored)
    ? stored
    : (matchMedia('(prefers-color-scheme: light)').matches ? 'crt-light' : 'crt-dark');
  document.documentElement.dataset.theme = theme;
}

function setTheme(theme) {
  localStorage.setItem('pp-theme', theme);
  applyTheme();
}

function cardFace(value) {
  if (value === 'coffee') return { emoji: '\u2615', sub: 'COFFEE' };
  if (value === 'question') return { emoji: '\u2753', sub: '?' };
  return { emoji: String(value), sub: null };
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function isDesktop() {
  return matchMedia('(min-width: 900px)').matches;
}

/* ------------------------------ overlays ------------------------------ */

function showOverlay(kind, payload = null) {
  $overlay.dataset.kind = kind;
  $overlay.replaceChildren();
  if (kind === 'reconnect') {
    $overlay.append(
      el('p', { class: 'spinner', text: 'RECONNECTING\u2026' }),
      el('p', { class: 'muted', text: 'Connection lost \u2014 retrying automatically. Keep this screen open.' })
    );
  } else if (kind === 'countdown') {
    // Non-blocking: a vote change during the countdown resets the server timer.
    $overlay.append(
      el('p', { class: 'big-countdown', id: 'countdown-number', text: String(payload) }),
      el('p', { class: 'countdown-sub', text: 'ALL VOTES IN \u2014 REVEALING' })
    );
  } else if (kind === 'notice') {
    $overlay.append(
      el('p', { class: 'overlay-title', text: payload }),
      el('button', { text: 'OK', onclick: () => hideOverlay() })
    );
  }
  $overlay.hidden = false;
}

function hideOverlay() {
  $overlay.hidden = true;
  $overlay.replaceChildren();
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function countdownSecondsLeft() {
  return Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
}

function syncCountdownOverlay() {
  const active = state && state.phase === 'voting' && state.countdownRemaining != null;
  const showing = !$overlay.hidden && $overlay.dataset.kind === 'countdown';
  if (!active) {
    if (showing) hideOverlay();
    countdownEndsAt = null;
    return;
  }
  if (!showing) showOverlay('countdown', countdownSecondsLeft());
  if (!countdownTimer) {
    countdownTimer = setInterval(() => {
      const $num = $overlay.querySelector('#countdown-number');
      if (!$num) return;
      const secs = countdownSecondsLeft();
      $num.textContent = String(secs);
      if (secs <= 0 && countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    }, 100);
  }
}

function refreshCountdownClock() {
  if (state && state.countdownRemaining != null) {
    countdownEndsAt = Date.now() + state.countdownRemaining;
  } else {
    countdownEndsAt = null;
  }
}

/* ------------------------------ session ------------------------------ */

function resetToHome(message = null) {
  localStorage.removeItem('pp-token');
  localStorage.removeItem('pp-room-code');
  state = null;
  you = null;
  selectedVote = null;
  roomCode = null;
  countdownEndsAt = null;
  lobbyDescDraft = '';
  lobbyDescCaret = null;
  consensusChoice = null;
  historyOpen = false;
  homeError = message;
  render();
}

/* ------------------------------ render: home ------------------------------ */

function renderHome() {
  const createName = el('input', {
    type: 'text', id: 'create-name', maxlength: '24',
    autocomplete: 'off', placeholder: 'Your name',
  });
  const joinCode = el('input', {
    type: 'text', id: 'join-code', maxlength: '4',
    autocomplete: 'off', autocapitalize: 'characters',
    placeholder: 'ROOM CODE',
  });
  joinCode.style.textTransform = 'uppercase';
  joinCode.style.letterSpacing = '4px';
  const joinName = el('input', {
    type: 'text', id: 'join-name', maxlength: '24',
    autocomplete: 'off', placeholder: 'Your name',
  });

  const createForm = el('form', { class: 'form' },
    el('h2', { text: 'CREATE ROOM' }),
    el('p', { class: 'hint', text: 'You become the Scrum Master and get a code to share.' }),
    el('label', { for: 'create-name', text: 'YOUR NAME' }),
    createName,
    el('button', { type: 'submit', text: 'CREATE ROOM' })
  );
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    homeError = null;
    const res = await emitAck('room:create', { name: createName.value });
    if (!res || !res.ok) {
      homeError = (res && res.error) || 'Could not create the room.';
      renderHome();
      const restored = document.getElementById('create-name');
      if (restored) {
        restored.value = createName.value;
        restored.focus();
      }
      return;
    }
    localStorage.setItem('pp-token', res.token);
    localStorage.setItem('pp-room-code', res.code);
    roomCode = res.code;
    state = res.state;
    you = res.state.you ?? null;
    selectedVote = (you && you.vote) || null;
    render();
  });

  const joinForm = el('form', { class: 'form' },
    el('h2', { text: 'JOIN ROOM' }),
    el('label', { for: 'join-code', text: 'ROOM CODE' }),
    joinCode,
    el('label', { for: 'join-name', text: 'YOUR NAME' }),
    joinName,
    el('button', { type: 'submit', text: 'JOIN ROOM' })
  );
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    homeError = null;
    const code = joinCode.value.trim().toUpperCase();
    const name = joinName.value;
    if (!code) {
      homeError = 'Enter the 4-character room code';
      renderHome();
      restoreJoinInput(code, name);
      return;
    }
    const res = await emitAck('room:join', { code, name });
    if (!res || !res.ok) {
      homeError = (res && res.error) || 'Could not join the room.';
      renderHome();
      restoreJoinInput(code, name);
      return;
    }
    localStorage.setItem('pp-token', res.token);
    localStorage.setItem('pp-room-code', res.code);
    roomCode = res.code;
    state = res.state;
    you = res.state.you ?? null;
    selectedVote = (you && you.vote) || null;
    render();
  });

  $app.replaceChildren(
    el('h1', { class: 'home-title', text: 'PIXEL POINTS' }),
    el('p', { class: 'home-sub', text: 'RETRO PLANNING POKER \u2014 CREATE OR JOIN A ROOM' }),
    el('p', { class: 'error', text: homeError || '' }),
    createForm,
    el('hr', { class: 'divider' }),
    joinForm
  );
}

function restoreJoinInput(code, name) {
  const $code = document.getElementById('join-code');
  const $name = document.getElementById('join-name');
  if ($code) $code.value = code;
  if ($name) {
    $name.value = name;
    $name.focus();
  }
}

/* ------------------------------ render: room chrome ------------------------------ */

function phaseLabel(phase) {
  if (phase === 'lobby') return 'LOBBY';
  if (phase === 'voting') return 'VOTING';
  if (phase === 'reveal') return 'REVEAL';
  return '';
}

function renderHeader() {
  const themeSelect = el('select', { id: 'theme-select', 'aria-label': 'Theme' });
  const current = document.documentElement.dataset.theme;
  for (const t of THEMES) {
    const opt = el('option', { value: t.id, text: t.label });
    if (t.id === current) opt.selected = true;
    themeSelect.append(opt);
  }
  themeSelect.addEventListener('change', () => setTheme(themeSelect.value));

  const smOnline = state.players.some((p) => p.role === 'sm' && p.connected);

  const leaveBtn = el('button', {
    class: 'leave-btn',
    text: 'LEAVE',
    onclick: async () => {
      if (!confirm('Leave this room? You can rejoin with the room code while it stays open.')) return;
      await emitAck('room:leave', {});
      resetToHome();
    },
  });

  return el('header', { class: 'header' },
    el('div', { class: 'header-top' },
      el('p', { class: 'wordmark', text: 'PIXEL POINTS' }),
      el('div', { class: 'header-controls' },
        el('span', { class: 'phase-chip', text: phaseLabel(state.phase) }),
        themeSelect,
        leaveBtn
      )
    ),
    smOnline ? null : el('p', { class: 'sm-waiting', text: 'SM RECONNECTING\u2026' }),
    el('p', { class: 'room-code', text: roomCode || '' })
  );
}

function renderDescription() {
  if (!state.description) return null;
  if (state.phase !== 'voting' && state.phase !== 'reveal') return null;
  return el('p', { class: 'description', text: state.description });
}

function renderHistory() {
  const details = el('details', { class: 'history-panel' });
  if (historyOpen) details.setAttribute('open', '');
  details.addEventListener('toggle', () => { historyOpen = details.open; });
  const n = state.history.length;
  details.append(el('summary', {},
    el('span', { text: 'HISTORY' }),
    el('span', {
      class: 'history-count',
      text: n ? `${n} round${n === 1 ? '' : 's'}` : 'none yet',
    })
  ));
  if (!n) {
    details.append(el('p', { class: 'history-empty', text: 'No rounds recorded yet.' }));
  } else {
    const list = el('ul', { class: 'history-list' });
    for (const entry of state.history) {
      list.append(el('li', { class: 'history-entry' },
        el('span', {
          class: 'history-points',
          text: `${entry.points} pt${entry.points === 1 ? '' : 's'}`,
        }),
        el('div', { class: 'history-text' },
          el('span', { text: entry.description }),
          el('span', { class: 'history-time', text: formatTime(entry.time) })
        )
      ));
    }
    details.append(list);
  }
  return details;
}

function renderPlayerList() {
  const list = el('ul', { class: 'player-list' });
  for (const p of state.players) {
    let status = '';
    if (!p.connected) status = 'reconnecting';
    else if (state.phase === 'voting' && p.voted) status = 'voted';
    list.append(el('li', { class: 'player-row' },
      el('span', { text: p.name }),
      el('span', { class: `player-role ${p.role}`, text: p.role === 'sm' ? 'SM' : 'P' }),
      el('span', { class: `player-status${p.connected ? '' : ' offline'}`, text: status })
    ));
  }
  return list;
}

/* ------------------------------ render: lobby ------------------------------ */

function renderLobby() {
  const wrap = el('section', {});
  if (you && you.role === 'sm') {
    const desc = el('input', {
      type: 'text', id: 'desc-input', maxlength: '140',
      placeholder: 'One-sentence story description\u2026',
      value: lobbyDescDraft,
    });
    desc.addEventListener('input', () => { lobbyDescDraft = desc.value; });
    const connectedVoters = state.players
      .filter((p) => p.role === 'player' && p.connected).length;
    const canStart = connectedVoters >= 2;

    const form = el('form', { class: 'form' },
      el('h2', { text: 'START A ROUND' }),
      el('label', { for: 'desc-input', text: 'STORY DESCRIPTION (MAX 140)' }),
      desc,
      el('button', {
        type: 'submit',
        text: 'START ROUND',
        disabled: canStart ? null : '',
      }),
      el('p', {
        class: 'hint',
        text: canStart
          ? 'Players will see the description while voting.'
          : `Need 2 connected voters to start (${connectedVoters}/2).`,
      })
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await emitAck('round:start', { description: desc.value });
      if (!res || !res.ok) {
        showOverlay('notice', (res && res.error) || 'Could not start the round.');
      } else {
        lobbyDescDraft = '';
        consensusChoice = null;
      }
    });
    wrap.append(form);
  } else {
    wrap.append(
      el('h2', { text: 'WAITING FOR SM\u2026' }),
      el('p', { class: 'hint', text: 'The Scrum Master will start the round soon. Keep this screen open.' })
    );
  }
  wrap.append(el('h2', { text: 'PLAYERS' }), renderPlayerList());
  return wrap;
}

/* ------------------------------ render: voting ------------------------------ */

function renderVoting() {
  const wrap = el('section', {});
  if (you && you.role === 'sm') {
    wrap.append(el('h2', { text: 'VOTE BOARD' }));
    const grid = el('div', { class: 'board-grid' });
    for (const p of state.players.filter((p) => p.role === 'player')) {
      grid.append(el('div', {
        class: `tile${p.voted ? ' voted' : ''}${p.connected ? '' : ' tile-offline'}`,
      },
        el('span', { class: 'tile-name', text: p.name }),
        p.voted
          ? el('span', { class: 'tile-vote', text: '?' })
          : el('span', {
              class: 'tile-vote pending',
              text: p.connected ? 'WAITING\u2026' : 'OFFLINE',
            })
      ));
    }
    wrap.append(grid);
    const abandonBtn = el('button', {
      class: 'abandon-btn',
      text: 'ABANDON ROUND',
      onclick: async () => {
        if (!confirm('Abandon this round? All votes are discarded and you return to the lobby.')) return;
        const res = await emitAck('round:abandon', {});
        if (!res || !res.ok) showOverlay('notice', (res && res.error) || 'Could not abandon the round.');
      },
    });
    wrap.append(abandonBtn);
  } else {
    wrap.append(el('h2', { text: 'PICK YOUR CARD' }));
    const hand = el('div', { class: 'hand' });
    for (const card of DECK) {
      const face = cardFace(card.value);
      const isSelected = selectedVote === card.value;
      const cardEl = el('button', {
        type: 'button',
        class: `card${isSelected ? ' selected' : ''}`,
        'data-value': card.value,
        'aria-pressed': isSelected ? 'true' : 'false',
        'aria-label': `Vote ${card.label}`,
      },
        el('span', { class: 'card-emoji', text: face.emoji }),
        el('span', { class: 'card-label', text: face.sub || '\u00a0' })
      );
      cardEl.addEventListener('click', async () => {
        if (selectedVote === card.value) return;
        const prev = selectedVote;
        selectedVote = card.value; // optimistic highlight
        render();
        const res = await emitAck('vote:cast', { value: card.value });
        if (!res || !res.ok) {
          selectedVote = prev; // roll back on failure
          render();
          showOverlay('notice', (res && res.error) || 'Could not cast your vote.');
        }
      });
      hand.append(cardEl);
    }
    wrap.append(hand);
    wrap.append(el('p', {
      class: 'hint',
      text: selectedVote
        ? 'Vote cast \u2014 tap another card to change it.'
        : 'Tap a card to vote. You can change it any time before the reveal.',
    }));
  }
  return wrap;
}

/* ------------------------------ render: reveal ------------------------------ */

function renderReveal() {
  const wrap = el('section', {});
  const reveal = state.reveal;
  if (!reveal) {
    wrap.append(el('h2', { text: 'REVEALING\u2026' }));
    return wrap;
  }

  const numericVotes = reveal.players
    .filter((p) => NUMERIC_OPTIONS.includes(p.vote))
    .map((p) => Number(p.vote));
  const unanimous = numericVotes.length >= 2
    && numericVotes.every((v) => v === numericVotes[0]);

  const showBigBoard = (you && you.role === 'sm') || isDesktop();

  wrap.append(...compact([
    el('h2', { text: showBigBoard ? 'HANDS UP \u2014 ALL CARDS REVEALED' : 'CARDS REVEALED' }),
    el('div', { class: 'reveal-stats' },
      reveal.spread
        ? el('span', { class: 'stat-chip', text: `SPREAD: ${reveal.spread.min}\u2013${reveal.spread.max}` })
        : el('span', { class: 'stat-chip', text: 'NO NUMERIC VOTES' }),
      reveal.suggestedPoints != null
        ? el('span', { class: 'stat-chip', text: `SUGGESTED: ${reveal.suggestedPoints} PTS` })
        : null
    ),
    unanimous ? el('p', { class: 'win-banner', text: '\u2605 UNANIMOUS VOTE \u2605' }) : null
  ]));

  if (showBigBoard) {
    const grid = el('div', { class: 'reveal-grid' });
    let i = 0;
    for (const p of reveal.players) {
      const face = cardFace(p.vote);
      grid.append(el('div', {
        class: `reveal-card${p.connected ? '' : ' offline'}`,
        'data-value': p.vote,
        style: `animation-delay:${(i++) * 0.08}s`,
      },
        el('span', { class: 'reveal-emoji', text: face.emoji }),
        el('span', { class: 'reveal-value', text: face.sub || String(p.vote) }),
        el('span', { class: 'reveal-name', text: p.name })
      ));
    }
    wrap.append(grid);
  } else {
    const list = el('ul', { class: 'vote-summary' });
    for (const p of reveal.players) {
      list.append(el('li', { class: 'vote-summary-row' },
        el('span', { class: 'vote-summary-name', text: p.name }),
        el('span', {
          class: `vote-summary-value${p.connected ? '' : ' offline'}`,
          'data-value': p.vote,
          text: cardFace(p.vote).emoji,
        })
      ));
    }
    wrap.append(el('h3', { text: 'HAND REVEALED' }), list);
  }

  if (you && you.role === 'sm') {
    const pointsSelect = el('select', { id: 'points-select', 'aria-label': 'Consensus points' });
    pointsSelect.addEventListener('change', () => { consensusChoice = pointsSelect.value; });
    const suggested = reveal.suggestedPoints != null ? String(reveal.suggestedPoints) : null;
    const chosen = consensusChoice && NUMERIC_OPTIONS.includes(consensusChoice)
      ? consensusChoice
      : suggested;
    for (const v of NUMERIC_OPTIONS) {
      const opt = el('option', { value: v, text: `${v} pts` });
      if (v === chosen) opt.selected = true;
      pointsSelect.append(opt);
    }
    wrap.append(el('div', { class: 'sm-actions' },
      el('h3', { text: 'SM \u2014 DECIDE THE POINTS' }),
      el('div', { class: 'row' },
        pointsSelect,
        el('button', {
          type: 'button', class: 'danger', text: 'CONFIRM CONSENSUS',
          onclick: async () => {
            const res = await emitAck('round:consensus', { points: pointsSelect.value });
            if (!res || !res.ok) {
              showOverlay('notice', (res && res.error) || 'Could not record consensus.');
            } else {
              consensusChoice = null;
            }
          },
        })
      ),
      el('div', { class: 'row' },
        el('button', {
          type: 'button', class: 'secondary', text: 'REVOTE',
          onclick: async () => {
            const res = await emitAck('round:revote');
            if (!res || !res.ok) {
              showOverlay('notice', (res && res.error) || 'Could not start a revote.');
            } else {
              consensusChoice = null;
            }
          },
        }),
        el('button', {
          type: 'button', class: 'secondary', text: 'NEW ROUND',
          onclick: async () => {
            const res = await emitAck('round:new');
            if (!res || !res.ok) {
              showOverlay('notice', (res && res.error) || 'Could not start a new round.');
            } else {
              consensusChoice = null;
            }
          },
        })
      )
    ));
  } else {
    wrap.append(el('p', { class: 'hint', text: 'Waiting for the Scrum Master to decide\u2026' }));
  }

  return wrap;
}

/* ------------------------------ render root ------------------------------ */

function render() {
  if (!state || !you) {
    renderHome();
    return;
  }
  const view = state.phase === 'lobby' ? renderLobby()
    : state.phase === 'voting' ? renderVoting()
    : renderReveal();

  // M2: a room:update during lobby rebuilds the SM's description input.
  // If it was focused, capture caret before teardown so the rebuild can refocus.
  const descWasFocused = document.activeElement && document.activeElement.id === 'desc-input';
  if (descWasFocused) {
    const $old = document.getElementById('desc-input');
    lobbyDescCaret = $old ? $old.selectionStart : null;
  }

  $app.replaceChildren(...compact([
    renderHeader(),
    renderDescription(),
    renderHistory(),
    view
  ]));

  if (descWasFocused) {
    const $desc = document.getElementById('desc-input');
    if ($desc) {
      $desc.focus();
      const pos = lobbyDescCaret != null ? lobbyDescCaret : $desc.value.length;
      $desc.setSelectionRange(pos, pos);
    }
    lobbyDescCaret = null;
  }
  refreshCountdownClock();
  syncCountdownOverlay();
}

/* ------------------------------ socket wiring ------------------------------ */

socket.on('connect', async () => {
  hideOverlay();
  const token = localStorage.getItem('pp-token');
  if (!token) {
    // Only (re)render home if nothing is on screen — never wipe typed input.
    if ($app.childElementCount === 0) renderHome();
    return;
  }
  const res = await emitAck('session:resume', { token });
  if (!res || !res.ok) {
    // Session or room gone (expiry or server restart) — clean bounce home.
    resetToHome('Your session expired \u2014 create or join a room.');
    return;
  }
  // Server also emits room:state right after; render from the ack immediately.
  roomCode = localStorage.getItem('pp-room-code') || roomCode;
  if (res.state) {
    state = res.state;
    you = res.state.you ?? you;
    if (res.state.you && res.state.you.vote !== undefined) selectedVote = res.state.you.vote;
  }
  render();
});

socket.on('disconnect', () => {
  showOverlay('reconnect');
});

socket.on('room:state', (s) => {
  state = s;
  you = s.you ?? you;
  if (s.you && s.you.vote !== undefined) selectedVote = s.you.vote;
  render();
});

socket.on('room:update', (s) => {
  // Server resets all votes on consensus/revote/newRound; votes only persist
  // within a phase, so a phase change invalidates our optimistic selection.
  if (state && s.phase !== state.phase) {
    selectedVote = null;
    if (you) you.vote = null;
  }
  state = { ...s, you };
  render();
});

/* ------------------------------ boot ------------------------------ */

applyTheme();
renderHome();