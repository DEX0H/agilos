import {
  ACTIONS, settings, bindLabel, bind, capture, resetDefaults, setLayout, setSens, setBots, MIN_BOTS, MAX_BOTS,
  setDifficulty, DIFFICULTIES, setVolume, setFullscreen,
  detectedLayout, onSettingsChange,
} from './settings.js';

// Settings panel on the start / pause screen: keyboard layout for labels, mouse
// sensitivity, and key bindings. Clicks inside the panel don't start the game.
// `hints` gets a row of keycap chips describing the controls.

const LAYOUT_NAMES = { qwerty: 'QWERTY', qwertz: 'QWERTZ', azerty: 'AZERTY' };

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function buildControlsPanel(container, hints) {
  container.innerHTML = '';
  container.addEventListener('click', (e) => e.stopPropagation());
  container.addEventListener('mousedown', (e) => e.stopPropagation());

  // Header with reset
  const head = el('div', 'panel-head');
  head.append(el('h2', '', 'Settings'));
  const reset = el('button', 'ghost', 'Reset');
  reset.type = 'button';
  reset.title = 'Reset all settings to defaults';
  reset.addEventListener('click', () => { capture.action = null; resetDefaults(); });
  head.append(reset);
  container.append(head);

  // General
  const general = el('div', 'panel-section');
  const layoutRow = el('label', 'field');
  layoutRow.append(el('span', 'field-name', 'Keyboard'));
  const sel = el('select');
  sel.addEventListener('change', () => setLayout(sel.value));
  layoutRow.append(sel);

  const sensRow = el('label', 'field');
  sensRow.append(el('span', 'field-name', 'Sensitivity'));
  const sensWrap = el('div', 'sens');
  const slider = el('input');
  slider.type = 'range';
  slider.min = '0.2';
  slider.max = '6';
  slider.step = '0.05';
  const sensVal = el('input', 'sens-num');
  sensVal.type = 'number';
  sensVal.min = '0.1';
  sensVal.max = '10';
  sensVal.step = '0.05';
  sensWrap.append(slider, sensVal);
  sensRow.append(sensWrap);
  slider.addEventListener('input', () => { setSens(parseFloat(slider.value)); refresh(); });
  sensVal.addEventListener('change', () => { setSens(parseFloat(sensVal.value) || 1); refresh(); });
  // Number of bots in the match
  const botsRow = el('label', 'field');
  botsRow.append(el('span', 'field-name', 'Bots'));
  const botsWrap = el('div', 'sens');
  const botsSlider = el('input');
  botsSlider.type = 'range';
  botsSlider.min = String(MIN_BOTS);
  botsSlider.max = String(MAX_BOTS);
  botsSlider.step = '1';
  const botsVal = el('input', 'sens-num');
  botsVal.type = 'number';
  botsVal.min = String(MIN_BOTS);
  botsVal.max = String(MAX_BOTS);
  botsVal.step = '1';
  botsWrap.append(botsSlider, botsVal);
  botsRow.append(botsWrap);
  botsSlider.addEventListener('input', () => { setBots(parseInt(botsSlider.value, 10)); refresh(); });
  botsVal.addEventListener('change', () => { setBots(parseInt(botsVal.value, 10)); refresh(); });
  // Bot difficulty
  const diffRow = el('label', 'field');
  diffRow.append(el('span', 'field-name', 'Difficulty'));
  const diffSel = el('select');
  for (const d of DIFFICULTIES) {
    const o = el('option', '', d[0].toUpperCase() + d.slice(1));
    o.value = d;
    diffSel.append(o);
  }
  diffSel.addEventListener('change', () => { setDifficulty(diffSel.value); refresh(); });
  diffRow.append(diffSel);
  // Volumes
  const volRow = (label, key) => {
    const row = el('label', 'field');
    row.append(el('span', 'field-name', label));
    const wrap = el('div', 'sens');
    const sl = el('input');
    sl.type = 'range';
    sl.min = '0';
    sl.max = '100';
    sl.step = '1';
    const num = el('input', 'sens-num');
    num.type = 'number';
    num.min = '0';
    num.max = '100';
    wrap.append(sl, num);
    row.append(wrap);
    sl.addEventListener('input', () => { setVolume(key, parseInt(sl.value, 10) / 100); refresh(); });
    num.addEventListener('change', () => { setVolume(key, (parseInt(num.value, 10) || 0) / 100); refresh(); });
    return { row, sl, num, key };
  };
  const vols = [volRow('Effects', 'sfxVol'), volRow('Music', 'musicVol')];
  general.append(layoutRow, sensRow, botsRow, diffRow, ...vols.map((v) => v.row));
  // Browser only: fullscreen keeps Ctrl+W from closing the tab (the Windows app doesn't need it)
  const fsRow = el('label', 'field');
  fsRow.append(el('span', 'field-name', 'Fullscreen'));
  const fsSel = el('select');
  for (const [v, t] of [['on', 'While playing (Ctrl keys safe)'], ['off', 'Off']]) {
    const o = el('option', '', t);
    o.value = v;
    fsSel.append(o);
  }
  fsSel.addEventListener('change', () => { setFullscreen(fsSel.value === 'on'); refresh(); });
  fsRow.append(fsSel);
  if (!window.agilosDesktop) general.append(fsRow);
  container.append(general);

  // Key bindings
  const bindsHead = el('div', 'section-title', 'Key bindings');
  bindsHead.append(el('span', 'section-hint', 'click a key, then press the new one'));
  container.append(bindsHead);
  const grid = el('div', 'binds');
  container.append(grid);
  const buttons = {};
  for (const [action, label] of ACTIONS) {
    const item = el('div', 'bind');
    item.append(el('span', 'bind-name', label));
    const btn = el('button', 'keycap');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      capture.action = capture.action === action ? null : action;
      refresh();
    });
    buttons[action] = btn;
    item.append(btn);
    grid.append(item);
  }

  // While waiting for a key, the next key press becomes the binding (Esc cancels)
  document.addEventListener('keydown', (e) => {
    if (!capture.action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code !== 'Escape') bind(capture.action, e.code);
    capture.action = null;
    refresh();
  }, true);

  function chip(keys, text) {
    const h = el('span', 'hint');
    for (const k of keys) h.append(el('kbd', '', k));
    h.append(el('span', '', text));
    return h;
  }

  function refresh() {
    const det = LAYOUT_NAMES[detectedLayout()];
    sel.innerHTML = '';
    for (const [v, t] of [['auto', `Auto · ${det}`], ['qwerty', 'QWERTY'], ['qwertz', 'QWERTZ'], ['azerty', 'AZERTY']]) {
      const o = el('option', '', t);
      o.value = v;
      sel.append(o);
    }
    sel.value = settings.layout;
    botsSlider.value = String(settings.bots);
    diffSel.value = settings.difficulty;
    fsSel.value = settings.fullscreen ? 'on' : 'off';
    for (const v of vols) {
      v.sl.value = String(Math.round(settings[v.key] * 100));
      v.num.value = String(Math.round(settings[v.key] * 100));
    }
    botsVal.value = String(settings.bots);
    slider.value = String(settings.sens);
    sensVal.value = settings.sens.toFixed(2);
    for (const [action] of ACTIONS) {
      const waiting = capture.action === action;
      buttons[action].textContent = waiting ? 'press a key' : bindLabel(action);
      buttons[action].classList.toggle('waiting', waiting);
    }

    if (hints) {
      const b = bindLabel;
      hints.innerHTML = '';
      hints.append(
        chip([b('forward'), b('left'), b('back'), b('right')], 'move'),
        chip([b('jump')], 'jump · double · wall · hold at a wall: climb'),
        chip([b('sprint')], 'sprint'),
        chip(settings.binds.slide === settings.binds.crouch ? [b('crouch')] : [b('crouch'), b('slide')],
          settings.binds.slide === settings.binds.crouch ? 'crouch · while running: slide · jump+crouch on a mantle: superglide' : 'crouch · slide · jump+crouch on a mantle: superglide'),
        chip(['Mouse'], 'shoot'),
        chip(['RMB'], 'hold: aim down sights'),
        chip([b('interact')], 'mystery box'),
        chip([b('reload')], 'reload'),
        chip([b('weapon1'), b('weapon2')], 'weapons'),
        chip([b('flip')], 'flip knife'),
        chip(['Esc'], 'menu'),
      );
    }
  }

  onSettingsChange(refresh);
  refresh();
}
