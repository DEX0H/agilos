import {
  profile, onProfileChange, signInWithGoogle, signInWithEmail, createAccount, resetPassword,
  chooseName, playAsGuest, showSignIn, signOut, deleteAccount, errorText, NAME_RE, COLOURS,
} from './profile.js';
import { firebaseEnabled } from './firebase.js';
import { loadStats } from './stats.js';

// Menu UI for profiles: the sign-in card, the name picker, the profile chip and the
// stats screen. Everything is built with DOM calls and textContent (no HTML strings),
// so names and emails can never become markup.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const stop = (e) => e.stopPropagation(); // clicks here must not start the game

export function buildAccountUI(overlay, onNameChange) {
  const chip = el('div', 'acct-chip');
  const modal = el('div', 'acct-modal');
  for (const n of [chip, modal]) {
    n.addEventListener('click', stop);
    n.addEventListener('mousedown', stop);
  }
  overlay.append(chip, modal);

  let view = null; // 'signin' | 'name' | 'stats' | null
  let editing = false; // the name card was opened from the chip (not the first sign-in)

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
  modal.addEventListener('click', (e) => { if (e.target === modal && view === 'stats') close(); });

  // ---- Sign-in card ----
  function signInCard() {
    view = 'signin';
    open((card) => {
      card.append(el('h2', 'acct-title', 'Sign in'));
      card.append(el('p', 'acct-sub', 'Keep your stats and settings on every device.'));
      const err = el('p', 'acct-err');
      const busy = (b) => card.classList.toggle('busy', b);
      const run = async (fn) => {
        err.textContent = '';
        busy(true);
        try { await fn(); } catch (e) { err.textContent = errorText(e); } finally { busy(false); }
      };

      const google = el('button', 'acct-btn google', 'Continue with Google');
      google.type = 'button';
      google.addEventListener('click', () => run(signInWithGoogle));
      card.append(google, el('div', 'acct-or', 'or with email'));

      const form = el('form', 'acct-form');
      const email = el('input');
      email.type = 'email';
      email.placeholder = 'Email';
      email.autocomplete = 'email';
      const pass = el('input');
      pass.type = 'password';
      pass.placeholder = 'Password (6+ characters)';
      pass.autocomplete = 'current-password';
      const row = el('div', 'acct-row');
      const signIn = el('button', 'acct-btn primary', 'Sign in');
      signIn.type = 'submit';
      const create = el('button', 'acct-btn', 'Create account');
      create.type = 'button';
      row.append(signIn, create);
      form.append(email, pass, row);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        run(() => signInWithEmail(email.value, pass.value));
      });
      create.addEventListener('click', () => run(() => createAccount(email.value, pass.value)));
      const forgot = el('button', 'acct-link', 'Forgot password?');
      forgot.type = 'button';
      forgot.addEventListener('click', () => run(async () => {
        await resetPassword(email.value);
        err.textContent = 'Password reset email sent.';
      }));
      for (const i of [email, pass]) i.addEventListener('keydown', stop); // typing isn't game input

      const guest = el('button', 'acct-link guest', 'Play as guest (stats stay on this device)');
      guest.type = 'button';
      guest.addEventListener('click', () => { playAsGuest(); close(); });
      card.append(form, err, forgot, guest);
    });
  }

  // ---- Choose a name (first sign-in, or rename) ----
  function nameCard(cancellable) {
    view = 'name';
    editing = cancellable;
    open((card) => {
      card.append(el('h2', 'acct-title', cancellable ? 'Edit profile' : 'Choose your player name'));
      card.append(el('p', 'acct-sub', '3 to 16 letters, digits, _ or -. Shown in the kill feed.'));
      const input = el('input');
      input.maxLength = 16;
      input.placeholder = 'Player name';
      input.value = profile.name || '';
      input.addEventListener('keydown', stop);
      let colour = profile.colour || COLOURS[0];
      const swatches = el('div', 'acct-swatches');
      for (const c of COLOURS) {
        const s = el('button', 'acct-swatch');
        s.type = 'button';
        s.style.background = c;
        s.title = 'Colour';
        if (c === colour) s.classList.add('on');
        s.addEventListener('click', () => {
          colour = c;
          for (const x of swatches.children) x.classList.toggle('on', x === s);
        });
        swatches.append(s);
      }
      const err = el('p', 'acct-err');
      const save = el('button', 'acct-btn primary', 'Save');
      save.type = 'button';
      save.addEventListener('click', async () => {
        err.textContent = '';
        if (!NAME_RE.test(input.value)) { err.textContent = errorText({ code: 'name-invalid' }); return; }
        card.classList.add('busy');
        try {
          await chooseName(input.value, colour);
          close();
        } catch (e) {
          err.textContent = errorText(e);
        } finally {
          card.classList.remove('busy');
        }
      });
      card.append(input, swatches, err, save);
      if (cancellable) {
        const del = el('button', 'acct-link danger', 'Delete account and stats');
        del.type = 'button';
        let armed = false;
        del.addEventListener('click', async () => {
          if (!armed) { armed = true; del.textContent = 'Click again to delete everything permanently'; return; }
          card.classList.add('busy');
          try { await deleteAccount(); close(); } catch (e) {
            err.textContent = e && e.code === 'auth/requires-recent-login'
              ? 'For safety, sign out and in again, then delete.' : errorText(e);
          } finally { card.classList.remove('busy'); }
        });
        const back = el('button', 'acct-link', 'Cancel');
        back.type = 'button';
        back.addEventListener('click', close);
        card.append(back, del);
      }
      setTimeout(() => input.focus(), 0);
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
    if (!firebaseEnabled && profile.mode === 'guest') {
      const b = el('button', 'acct-chip-btn', 'Stats');
      b.type = 'button';
      b.addEventListener('click', statsCard);
      chip.append(b);
      return;
    }
    if (profile.mode === 'loading') return;
    const dot = el('span', 'acct-dot');
    dot.style.background = profile.mode === 'user' ? profile.colour : '#777';
    const name = el('span', 'acct-name', profile.mode === 'user' ? profile.name : 'Guest');
    chip.append(dot, name);
    const stats = el('button', 'acct-chip-btn', 'Stats');
    stats.type = 'button';
    stats.addEventListener('click', statsCard);
    chip.append(stats);
    if (profile.mode === 'user') {
      const edit = el('button', 'acct-chip-btn', 'Profile');
      edit.type = 'button';
      edit.addEventListener('click', () => nameCard(true));
      const out = el('button', 'acct-chip-btn', 'Sign out');
      out.type = 'button';
      out.addEventListener('click', () => signOut().catch(() => {}));
      chip.append(edit, out);
    } else {
      const sign = el('button', 'acct-chip-btn accent', 'Sign in');
      sign.type = 'button';
      sign.addEventListener('click', () => { showSignIn(); signInCard(); });
      chip.append(sign);
    }
  }

  onProfileChange((p) => {
    renderChip();
    if (onNameChange) onNameChange(p.mode === 'user' ? p.name : null);
    if (p.mode === 'signedOut' && view !== 'signin') signInCard();
    else if (p.mode === 'needsName' && view !== 'name') nameCard(false);
    else if ((p.mode === 'user' || p.mode === 'guest') && (view === 'signin' || (view === 'name' && !editing))) close();
  });

  return { openStats: statsCard, isOpen: () => view !== null };
}
