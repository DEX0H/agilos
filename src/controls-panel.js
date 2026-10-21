import {
  ACTIONS, settings, bindLabel, bind, capture, resetDefaults, setLayout, setSens,
  detectedLayout, onSettingsChange, keyLabel,
} from './settings.js';

// Controls panel shown on the pause / start screen: rebind keys, choose the keyboard
// layout used for labels, and set mouse sensitivity. Clicks inside the panel don't
// start the game.

const LAYOUT_NAMES = { qwerty: 'QWERTY', qwertz: 'QWERTZ', azerty: 'AZERTY' };

export function buildControlsPanel(container, helpText) {
  container.innerHTML = '';
  container.addEventListener('click', (e) => e.stopPropagation());
  container.addEventListener('mousedown', (e) => e.stopPropagation());

  const title = document.createElement('h2');
  title.textContent = 'Controls';
  container.append(title);

  // Keyboard layout
  const layoutRow = row('Keyboard');
  const sel = document.createElement('select');
  layoutRow.append(sel);
  sel.addEventListener('change', () => setLayout(sel.value));

  // Sensitivity
  const sensRow = row('Mouse sensitivity');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.2';
  slider.max = '6';
  slider.step = '0.05';
  const sensVal = document.createElement('input');
  sensVal.type = 'number';
  sensVal.min = '0.1';
  sensVal.max = '10';
  sensVal.step = '0.05';
  sensVal.className = 'sens-num';
  sensRow.append(slider, sensVal);
  slider.addEventListener('input', () => { setSens(parseFloat(slider.value)); refresh(); });
  sensVal.addEventListener('change', () => { setSens(parseFloat(sensVal.value) || 1); refresh(); });

  // Bindings
  const grid = document.createElement('div');
  grid.className = 'binds';
  container.append(grid);
  const buttons = {};
  for (const [action, label] of ACTIONS) {
    const name = document.createElement('span');
    name.textContent = label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      capture.action = capture.action === action ? null : action;
      refresh();
    });
    buttons[action] = btn;
    grid.append(name, btn);
  }

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'reset';
  reset.textContent = 'Reset to defaults';
  reset.addEventListener('click', () => { capture.action = null; resetDefaults(); });
  container.append(reset);

  // While waiting for a key, the next key press becomes the binding (Esc cancels)
  document.addEventListener('keydown', (e) => {
    if (!capture.action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code !== 'Escape') bind(capture.action, e.code);
    capture.action = null;
    refresh();
  }, true);

  function row(text) {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('label');
    l.textContent = text;
    r.append(l);
    container.append(r);
    return r;
  }

  function refresh() {
    const det = LAYOUT_NAMES[detectedLayout()];
    sel.innerHTML = '';
    for (const [v, t] of [['auto', `Auto (${det})`], ['qwerty', 'QWERTY'], ['qwertz', 'QWERTZ'], ['azerty', 'AZERTY']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      sel.append(o);
    }
    sel.value = settings.layout;
    slider.value = String(settings.sens);
    sensVal.value = settings.sens.toFixed(2);
    for (const [action] of ACTIONS) {
      buttons[action].textContent = capture.action === action ? 'press a key…' : bindLabel(action);
      buttons[action].classList.toggle('waiting', capture.action === action);
    }
    if (helpText) {
      const b = (a) => bindLabel(a);
      helpText.textContent =
        `${b('forward')} ${b('left')} ${b('back')} ${b('right')} move · ${b('jump')} jump (again in air, or at a wall) · ` +
        `${b('sprint')} sprint · ${b('crouch')} slide/crouch · click shoot · ${b('reload')} reload · ` +
        `${b('weapon1')}/${b('weapon2')} weapons · ${b('flip')} flip knife · ${keyLabel('Escape')} menu`;
    }
  }

  onSettingsChange(refresh);
  refresh();
}
