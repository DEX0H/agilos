// Tiny event channel so game code can say "a shot was fired", "a foot hit the ground"
// without knowing about sound. audio.js listens.
const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

export function emit(type, ...args) {
  const list = listeners.get(type);
  if (list) for (const fn of list) fn(...args);
}
