import {
  profile, onProfileChange, signIn, createAccount, setColour, changePassword,
  playAsGuest, showSignIn, signOut, deleteAccount, errorText, COLOURS,
} from './profile.js';
import { firebaseEnabled } from './firebase.js';
import { loadStats } from './stats.js';

// Menu UI for profiles: the sign-in card (username + password), the profile card, the
// profile chip and the stats screen. Everything is built with DOM calls and textContent
// (no HTML strings), so names can never become markup.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const stop = (e) => e.stopPropagation(); // clicks and typing here must not reach the game

function field(type, placeholder, autocomplete) {
  const i = el('input');
  i.type = type;
  i.placeholder = placeholder;
  i.autocomplete = autocomplete;
  i.spellcheck = false;
  i.addEventListener('keydown', stop);
  return i;
}

export function buildAccountUI(overlay, onNameChange) {
  const chip = el('div', 'acct-chip');
  const modal = el('div', 'acct-modal');
  for (const n of [chip, modal]) {
    n.addEventListener('click', stop);
    n.addEventListener('mousedown', stop);
  }
  overlay.append(chip, modal);

  let view = null; // 'signin' | 'profile' | 'stats' | null

  function close() {
    view = null;
    modal.textContent = '';
    modal.style.display = 'none';
  }
  function open(build) {
    modal.textContent = '';
    const card = el('div', 'acct-card');
    build(card);
    modal.append(card);
    modal.style.display = 'flex';
  }
  modal.addEventListener('click', (e) => { if (e.target === modal && view !== 'signin') close(); });

  const runner = (card, err) => async (fn) => {
    err.textContent = '';
    err.classList.remove('ok');
    card.classList.add('busy');
    try { await fn(); } catch (e) { err.textContent = errorText(e); } finally { card.classList.remove('busy'); }
  };

  // ---- Sign-in card: username + password ----
  function signInCard() {
    view = 'signin';
    open((card) => {
      card.append(el('h2', 'acct-title', 'Sign in'));
      card.append(el('p', 'acct-sub', 'Your stats and settings follow your username.'));
      const err = el('p', 'acct-err');
      const run = runner(card, err);
      const form = el('form', 'acct-form');
      const name = field('text', 'Username', 'username');
      name.maxLength = 16;
      const pass = field('password', 'Password (6+ characters)', 'current-password');
      const row = el('div', 'acct-row');
      const go = el('button', 'acct-btn primary', 'Sign in');
      go.type = 'submit';
      const create = el('button', 'acct-btn', 'Create account');
      create.type = 'button';
      row.append(go, create);
      form.append(name, pass, row);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        run(() => signIn(name.value.trim(), pass.value));
      });
      create.addEventListener('click', () => run(() => createAccount(name.value.trim(), pass.value)));
      const note = el('p', 'acct-sub small', 'No email needed. Keep your password safe: it can\'t be recovered.');
      const guest = el('button', 'acct-link guest', 'Play as guest (stats stay on this device)');
      guest.type = 'button';
      guest.addEventListener('click', () => { playAsGuest(); close(); });
      card.append(form, err, note, guest);
      setTimeout(() => name.focus(), 0);
    });
  }

  // ---- Profile card: colour, password, delete ----
  function profileCard() {
    view = 'profile';
    open((card) => {
      card.append(el('h2', 'acct-title', profile.name));
      const err = el('p', 'acct-err');
      const run = runner(card, err);

      card.append(el('h3', 'acct-h3', 'Colour'));
      const swatches = el('div', 'acct-swatches');
      for (const c of COLOURS) {
        const s = el('button', 'acct-swatch');
        s.type = 'button';
        s.style.background = c;
        s.title = 'Colour';
        if (c === profile.colour) s.classList.add('on');
        s.addEventListener('click', () => run(async () => {
          await setColour(c);
          for (const x of swatches.children) x.classList.toggle('on', x === s);
        }));
        swatches.append(s);
      }
      card.append(swatches);

      card.append(el('h3', 'acct-h3', 'Change password'));
      const cur = field('password', 'Current password', 'current-password');
      const next = field('password', 'New password (6+ characters)', 'new-password');
      const save = el('button', 'acct-btn', 'Change password');
      save.type = 'button';
      save.addEventListener('click', () => run(async () => {
        await changePassword(cur.value, next.value);
        cur.value = '';
        next.value = '';
        err.textContent = 'Password changed.';
        err.classList.add('ok');
      }));
      card.append(cur, next, save, err);

      const del = el('button', 'acct-link danger', 'Delete account and stats');
      del.type = 'button';
      let armed = false;
      del.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          del.textContent = 'Enter your current password above, then click again to delete everything';
          return;
        }
        run(async () => { await deleteAccount(cur.value); close(); });
      });
      const back = el('button', 'acct-link', 'Close');
      back.type = 'button';
      back.addEventListener('click', close);
      card.append(back, del);
    });
  }

  // ---- Stats screen ----
  function statsCard() {
    view = 'stats';
    open((card) => {
      card.classList.add('wide');
      const head = el('div', 'acct-head');
      head.append(el('h2', 'acct-title', profile.mode === 'user' ? `${profile.name} · stats` : 'Guest stats (this device)'));
      const x = el('button', 'acct-link', 'Close');
      x.type = 'button';
      x.addEventListener('click', close);
      head.append(x);
      const body = el('div', 'acct-stats', 'Loading…');
      card.append(head, body);
      loadStats(20).then(({ totals: t, matches }) => {
        body.textContent = '';
        const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
        const tiles = el('div', 'acct-tiles');
        const tile = (label, value) => {
          const d = el('div', 'acct-tile');
          d.append(el('b', '', String(value)), el('span', '', label));
          tiles.append(d);
        };
        tile('Matches', t.matches);
        tile('Wins', t.wins);
        tile('Win rate', pct(t.wins, t.matches));
        tile('Avg place', t.matches ? (t.placeSum / t.matches).toFixed(1) : '–');
        tile('Kills', t.kills);
        tile('K/D', t.deaths ? (t.kills / t.deaths).toFixed(2) : String(t.kills));
        tile('Accuracy', pct(t.hits, t.shots));
        tile('Headshots', pct(t.headshots, t.kills));
        tile('Longest kill', `${t.longestKill} m`);
        tile('Damage', t.damageDealt);
        body.append(tiles);

        // Kills per weapon as bars
        body.append(el('h3', 'acct-h3', 'Kills by weapon'));
        const bars = el('div', 'acct-bars');
        const kw = t.killsByWeapon || {};
        const max = Math.max(1, ...Object.values(kw));
        for (const [w, label] of [['handgun', 'Handgun'], ['smg', 'SMG'], ['rifle', 'Assault rifle'], ['sniper', 'Sniper'], ['knife', 'Knife']]) {
          const r = el('div', 'acct-bar');
          const fill = el('i');
          fill.style.width = `${((kw[w] || 0) / max) * 100}%`;
          r.append(el('span', '', label), el('div', 'track'), el('b', '', String(kw[w] || 0)));
          r.children[1].append(fill);
          bars.append(r);
        }
        body.append(bars);

        body.append(el('h3', 'acct-h3', 'Recent matches'));
        if (!matches.length) {
          body.append(el('p', 'acct-sub', 'No matches yet. Finish one and it shows up here.'));
          return;
        }
        const table = el('table', 'acct-table');
        const hr = el('tr');
        for (const h of ['Date', 'Place', 'Kills', 'Damage', 'Accuracy', 'Time']) hr.append(el('th', '', h));
        table.append(hr);
        for (const m of matches) {
          const tr = el('tr');
          const d = new Date(m.endedAt);
          const when = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          const time = `${Math.floor(m.timeAlive / 60)}:${String(m.timeAlive % 60).padStart(2, '0')}`;
          for (const v of [when, `#${m.place} of ${m.total}`, m.kills, m.damageDealt, pct(m.hits, m.shots), time]) tr.append(el('td', '', String(v)));
          if (m.win) tr.classList.add('win');
          table.append(tr);
        }
        body.append(table);
      }).catch((e) => { body.textContent = errorText(e); });
    });
  }

  // ---- Profile chip (top left of the menu) ----
  function renderChip() {
    chip.textContent = '';
    if (profile.mode === 'loading') return;
    const button = (text, fn, cls = '') => {
      const b = el('button', `acct-chip-btn ${cls}`, text);
      b.type = 'button';
      b.addEventListener('click', fn);
      chip.append(b);
    };
    if (firebaseEnabled) {
      const dot = el('span', 'acct-dot');
      dot.style.background = profile.mode === 'user' ? profile.colour : '#777';
      chip.append(dot, el('span', 'acct-name', profile.mode === 'user' ? profile.name : 'Guest'));
    }
    button('Stats', statsCard);
    if (profile.mode === 'user') {
      button('Profile', profileCard);
      button('Sign out', () => signOut().catch(() => {}));
    } else if (firebaseEnabled) {
      button('Sign in', () => { showSignIn(); signInCard(); }, 'accent');
    }
  }

  onProfileChange((p) => {
    renderChip();
    if (onNameChange) onNameChange(p.mode === 'user' ? p.name : null);
    if (p.mode === 'signedOut' && view !== 'signin') signInCard();
    else if ((p.mode === 'user' || p.mode === 'guest') && view === 'signin') close();
  });

  return { openStats: statsCard, isOpen: () => view !== null };
}
