import { profile, onProfileChange, showSignIn } from '../profile.js';
import { normalizeCode, CODE_RE, localMode } from './signal.js';
import { MAX_PLAYERS } from './host.js';

// Menu UI for playing with friends: host a lobby or join with a code, then the lobby card
// (players, ready, kick, settings, start). Built with DOM calls and textContent only.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const stop = (e) => e.stopPropagation(); // clicks and typing here must not reach the game

function friendly(e) {
  const code = (e && e.code) || '';
  if (code === 'permission-denied') return 'Online lobbies are not available right now.';
  if (code === 'unavailable' || code === 'auth/network-request-failed') return 'No connection. Check your internet and try again.';
  if (['not-found', 'timeout', 'unreachable', 'signin', 'offline', 'busy'].includes(code)) return e.message;
  return 'Could not connect. Try again.';
}

export function buildLobbyUI(mount, overlay, net, { onStart }) {
  // ---- Menu box: host / join ----
  const box = el('div', 'mp');
  for (const ev of ['click', 'mousedown', 'keydown']) box.addEventListener(ev, stop);
  mount.after(box);

  const modal = el('div', 'acct-modal');
  for (const ev of ['click', 'mousedown', 'keydown']) modal.addEventListener(ev, stop);
  overlay.append(modal);
  let cardOpen = false;
  let busy = false;
  let error = '';

  const me = () => ({ name: profile.name || `Guest${Math.floor(Math.random() * 900 + 100)}`, colour: profile.colour });
  const canPlay = () => localMode() || profile.mode === 'user';

  async function run(fn) {
    busy = true;
    error = '';
    render();
    try { await fn(); } catch (e) { error = friendly(e); } finally { busy = false; render(); }
  }

  function renderMenu() {
    box.textContent = '';
    box.append(el('div', 'mp-title', 'PLAY WITH FRIENDS'));
    if (net.active) {
      const n = net.host ? net.host.members.length + 1 : net.client && net.client.lobby ? net.client.lobby.members.length : 1;
      const code = net.host ? net.host.code : net.client && net.client.lobby ? net.client.lobby.code : '';
      const row = el('div', 'mp-row');
      row.append(el('span', 'mp-in', `In lobby ${code} · ${n} player${n === 1 ? '' : 's'}`));
      const open = el('button', 'acct-btn primary', 'Open lobby');
      open.type = 'button';
      open.addEventListener('click', () => { cardOpen = true; render(); });
      row.append(open);
      box.append(row);
      return;
    }
    if (!canPlay()) {
      const row = el('div', 'mp-row');
      row.append(el('span', 'mp-in', 'Sign in to host or join a lobby.'));
      const b = el('button', 'acct-btn', 'Sign in');
      b.type = 'button';
      b.addEventListener('click', () => showSignIn());
      row.append(b);
      box.append(row);
      return;
    }
    const row = el('div', 'mp-row');
    const host = el('button', 'acct-btn primary', 'Host a lobby');
    host.type = 'button';
    host.disabled = busy;
    host.addEventListener('click', () => run(async () => { await net.hostLobby(me()); cardOpen = true; }));
    const input = el('input', 'mp-code');
    input.placeholder = 'CODE';
    input.maxLength = 6;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => { input.value = normalizeCode(input.value); });
    const join = el('button', 'acct-btn', 'Join');
    join.type = 'button';
    join.disabled = busy;
    const doJoin = () => {
      const code = normalizeCode(input.value);
      if (!CODE_RE.test(code)) { error = 'Codes are 6 letters.'; render(); return; }
      run(async () => { await net.joinLobby(code, me()); cardOpen = true; });
    };
    join.addEventListener('click', doJoin);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
    row.append(host, input, join);
    box.append(row);
    const note = el('p', 'mp-note', error || net.message || (busy ? 'Connecting…' : 'Friends join with your code. Bots fill the empty spots.'));
    if (error || net.message) note.classList.add('err');
    box.append(note);
  }

  function memberRow(m, isHost) {
    const row = el('div', 'mp-member');
    const dot = el('i', 'acct-dot');
    dot.style.background = m.colour;
    row.append(dot, el('b', '', m.name));
    if (m.host) row.append(el('span', 'mp-tag', 'HOST'));
    else row.append(el('span', `mp-tag ${m.ready ? 'ok' : ''}`, m.ready ? 'READY' : 'NOT READY'));
    if (m.you) row.append(el('span', 'mp-tag you', 'YOU'));
    const ping = el('span', 'mp-ping', m.host || m.you && !isHost ? '' : `${m.ping} ms`);
    if (m.ping > 250) ping.classList.add('bad');
    row.append(ping);
    if (isHost && !m.host) {
      const kick = el('button', 'acct-link danger', 'Kick');
      kick.type = 'button';
      kick.addEventListener('click', () => net.host.kick(m.key));
      row.append(kick);
    }
    return row;
  }

  function renderCard() {
    modal.textContent = '';
    if (!cardOpen || !net.active) { modal.style.display = 'none'; return; }
    const isHost = !!net.host;
    const info = isHost ? net.host.lobbyFor(null) : net.client.lobby;
    const card = el('div', 'acct-card mp-card');
    const head = el('div', 'acct-head');
    head.append(el('h2', 'acct-title', 'LOBBY'));
    const close = el('button', 'acct-link', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => { cardOpen = false; render(); });
    head.append(close);
    card.append(head);
    if (!info) {
      card.append(el('p', 'acct-sub', 'Connecting…'));
      modal.append(card);
      modal.style.display = 'flex';
      return;
    }

    const codeRow = el('div', 'mp-coderow');
    codeRow.append(el('span', 'mp-bigcode', info.code));
    const copy = el('button', 'acct-btn', 'Copy code');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(info.code).then(() => { copy.textContent = 'Copied'; }, () => {});
    });
    codeRow.append(copy);
    card.append(codeRow);
    const waiting = info.inMatch && !net.client?.inMatch ? 'A match is on. You join the next one the host starts.' : 'Waiting for the host to start the match.';
    card.append(el('p', 'acct-sub small', isHost ? 'Send this code to your friends. Anyone with it can join.' : waiting));

    const list = el('div', 'mp-list');
    for (const m of info.members) list.append(memberRow(m, isHost));
    card.append(list);
    card.append(el('p', 'acct-sub small', `${info.members.length} of ${info.max} players${info.fill ? ' · bots fill the rest' : ''}`));

    if (isHost) {
      const opts = el('div', 'mp-opts');
      const maxSel = el('select', 'mp-select');
      for (let n = 2; n <= MAX_PLAYERS; n++) {
        const o = el('option', '', `${n} players`);
        o.value = String(n);
        if (n === info.max) o.selected = true;
        maxSel.append(o);
      }
      maxSel.addEventListener('change', () => net.host.setSettings({ max: Number(maxSel.value) }));
      const fillLabel = el('label', 'mp-check');
      const fill = el('input');
      fill.type = 'checkbox';
      fill.checked = info.fill;
      fill.addEventListener('change', () => net.host.setSettings({ fill: fill.checked }));
      fillLabel.append(fill, ' Fill empty spots with bots');
      opts.append(maxSel, fillLabel);
      card.append(opts);
      const row = el('div', 'acct-row');
      const start = el('button', 'acct-btn primary', info.inMatch ? 'Restart match' : 'Start match');
      start.type = 'button';
      const notReady = info.members.filter((m) => !m.host && !m.ready).length;
      start.addEventListener('click', () => { cardOpen = false; render(); onStart(); });
      const leave = el('button', 'acct-btn', 'Close lobby');
      leave.type = 'button';
      leave.addEventListener('click', () => run(() => net.leave()));
      row.append(start, leave);
      card.append(row);
      if (notReady) card.append(el('p', 'acct-sub small', `${notReady} not ready yet (you can start anyway).`));
    } else {
      const row = el('div', 'acct-row');
      const ready = el('button', `acct-btn ${net.client.ready ? '' : 'primary'}`, net.client.ready ? 'Not ready' : 'Ready');
      ready.type = 'button';
      ready.addEventListener('click', () => { net.client.setReady(!net.client.ready); render(); });
      const leave = el('button', 'acct-btn', 'Leave');
      leave.type = 'button';
      leave.addEventListener('click', () => run(() => net.leave()));
      row.append(ready, leave);
      card.append(row);
    }
    modal.append(card);
    modal.style.display = 'flex';
  }

  function render() {
    renderMenu();
    renderCard();
  }

  net.onChange = render;
  onProfileChange(render);
  // Refresh pings every couple of seconds while the card is open
  setInterval(() => { if (cardOpen && net.active && overlay.style.display !== 'none') render(); }, 2000);
  return {
    render,
    close() { cardOpen = false; render(); },
    open() { cardOpen = true; render(); },
  };
}
