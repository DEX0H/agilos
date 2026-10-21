import {
  ACTIONS, settings, bindLabel, bind, capture, resetDefaults, setLayout, setSens,
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
  general.append(layoutRow, sensRow);
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
        chip([b('jump')], 'jump · double · wall'),
        chip([b('sprint')], 'sprint'),
        chip([b('crouch')], 'slide / crouch'),
        chip(['Mouse'], 'shoot'),
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
