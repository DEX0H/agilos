// Player settings: key bindings, keyboard layout labels, mouse sensitivity.
//
// Bindings use physical key positions (KeyboardEvent.code), so the same physical keys
// work on every layout: on AZERTY the keys labelled Z Q S D move you, on QWERTZ W A S D.
// Only the labels differ. Labels come from the browser's real layout map when it has one
// (Chrome, Edge), otherwise from a guess based on language and time zone.
// Everything is saved in localStorage; if storage is blocked, defaults are used.

const STORE = 'agilos.settings.v1';
const DEG = Math.PI / 180;
const CS_YAW = 0.022 * DEG;      // CS-style: degrees per mouse count at sensitivity 1
export const DEFAULT_SENS = 2.0; // half the old default speed, roughly

export const ACTIONS = [
  ['forward', 'Move forward', 'KeyW'],
  ['back', 'Move back', 'KeyS'],
  ['left', 'Move left', 'KeyA'],
  ['right', 'Move right', 'KeyD'],
  ['jump', 'Jump / double / wall jump', 'Space'],
  ['sprint', 'Sprint', 'ShiftLeft'],
  ['crouch', 'Crouch / slide', 'KeyC'],
  ['reload', 'Reload', 'KeyR'],
  ['weapon1', 'Handgun', 'Digit1'],
  ['weapon2', 'Knife', 'Digit2'],
  ['flip', 'Flip knife', 'KeyF'],
  ['quality', 'Quality toggle', 'KeyP'],
  ['sensDown', 'Sensitivity down', 'BracketLeft'],
  ['sensUp', 'Sensitivity up', 'BracketRight'],
];
const RESERVED = new Set(['Escape', 'Enter']); // Esc releases the mouse, Enter restarts

const defaults = () => Object.fromEntries(ACTIONS.map(([a, , code]) => [a, code]));

export const settings = { binds: defaults(), sens: DEFAULT_SENS, layout: 'auto' };

try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved) {
    if (saved.binds) Object.assign(settings.binds, saved.binds);
    if (typeof saved.sens === 'number' && saved.sens > 0) settings.sens = saved.sens;
    if (saved.layout) settings.layout = saved.layout;
  }
} catch {
  // storage unavailable: keep defaults
}

export function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {
    // storage unavailable: settings last for this session only
  }
}

export function radPerCount() {
  return CS_YAW * settings.sens;
}

export function setSens(v) {
  settings.sens = Math.round(Math.min(10, Math.max(0.1, v)) * 100) / 100;
  save();
}

// ---------- Keyboard layout ----------

// Guess from language first, then time zone (for English-language browsers in Europe)
function guessLayout() {
  const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])
    .map((l) => l.toLowerCase());
  for (const l of langs) {
    if (l === 'fr-ca') return 'qwerty';
    if (l === 'fr-ch') return 'qwertz';
    if (/^fr(-|$)/.test(l) || l === 'nl-be') return 'azerty';
    if (/^(de|cs|sk|hu|hr|sl|sr|bs|sq|lb|rm)(-|$)/.test(l)) return 'qwertz';
    if (!/^en(-|$)/.test(l)) return 'qwerty';
  }
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { tz = ''; }
  if (/^Europe\/(Paris|Brussels|Monaco)$/.test(tz)) return 'azerty';
  if (/^Europe\/(Berlin|Vienna|Zurich|Prague|Bratislava|Budapest|Zagreb|Ljubljana|Belgrade|Sarajevo|Tirane|Luxembourg|Vaduz|Busingen)$/.test(tz)) {
    return 'qwertz';
  }
  return 'qwerty';
}

let layoutMap = null;      // real labels from the browser, when available
let detected = guessLayout();

if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
  navigator.keyboard.getLayoutMap().then((map) => {
    layoutMap = map;
    const q = map.get('KeyQ');
    const y = map.get('KeyY');
    if (q === 'a') detected = 'azerty';
    else if (y === 'z') detected = 'qwertz';
    else detected = 'qwerty';
    for (const fn of changeListeners) fn();
  }).catch(() => {});
}

export function activeLayout() {
  return settings.layout === 'auto' ? detected : settings.layout;
}

export function detectedLayout() {
  return detected;
}

const NAMED = {
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt', AltRight: 'R-Alt', Tab: 'Tab', CapsLock: 'Caps', Backspace: 'Backspace',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', MetaLeft: 'L-Meta', MetaRight: 'R-Meta',
  Escape: 'Esc', Enter: 'Enter',
};
const QWERTY = {
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', IntlBackslash: '<',
};
const QWERTZ = {
  ...QWERTY, KeyY: 'Z', KeyZ: 'Y', BracketLeft: 'Ü', BracketRight: '+', Semicolon: 'Ö', Quote: 'Ä',
  Minus: 'ß', Equal: '´', Backslash: '#', Slash: '-', Backquote: '^',
};
const AZERTY = {
  ...QWERTY, KeyQ: 'A', KeyA: 'Q', KeyW: 'Z', KeyZ: 'W', KeyM: ',', Semicolon: 'M', BracketLeft: '^',
  BracketRight: '$', Quote: 'Ù', Comma: ';', Period: ':', Slash: '!', Minus: ')', Backquote: '²',
};
const TABLES = { qwerty: QWERTY, qwertz: QWERTZ, azerty: AZERTY };

// What is printed on the key with this physical code
export function keyLabel(code) {
  if (!code) return '—';
  if (NAMED[code]) return NAMED[code];
  // Number row: show the number (on AZERTY the unshifted character is &, é, " ...)
  if (code.startsWith('Digit')) return code.slice(5);
  const layout = activeLayout();
  if (layoutMap && settings.layout === 'auto') {
    const v = layoutMap.get(code);
    if (v) return v.toUpperCase();
  }
  const t = TABLES[layout] || QWERTY;
  if (t[code]) return t[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

export function bindLabel(action) {
  return keyLabel(settings.binds[action]);
}

// ---------- Change notifications and capture ----------

const changeListeners = [];
export function onSettingsChange(fn) {
  changeListeners.push(fn);
}
function changed() {
  save();
  for (const fn of changeListeners) fn();
}

export const capture = { action: null }; // set while waiting for a key to bind

export function bind(action, code) {
  if (RESERVED.has(code)) return false;
  // If another action already uses this key, give it this action's old key (swap)
  const old = settings.binds[action];
  for (const [a] of ACTIONS) {
    if (a !== action && settings.binds[a] === code) settings.binds[a] = old;
  }
  settings.binds[action] = code;
  changed();
  return true;
}

export function resetDefaults() {
  settings.binds = defaults();
  settings.sens = DEFAULT_SENS;
  settings.layout = 'auto';
  changed();
}

export function setLayout(l) {
  settings.layout = l;
  changed();
}

export function notifyChanged() {
  changed();
}
