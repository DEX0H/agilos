// Tiny event channel so game code can say "a shot was fired", "a foot hit the ground"
// without knowing about sound. audio.js listens.
const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
  return () => {
    const list = listeners.get(type);
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}

// Muted while the network client replays movement it already played once
let muted = 0;
export function mute(on) { muted += on ? 1 : -1; }

export function emit(type, ...args) {
  if (muted > 0) return;
  const list = listeners.get(type);
  if (list) for (const fn of list) fn(...args);
}
