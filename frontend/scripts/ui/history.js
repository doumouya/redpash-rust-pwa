// Generic client-side history (undo/redo) for plain-JSON state.
//
// Spec objects in the report + dashboard builders are pure JSON, so
// "snapshot" is a deep-cloned JSON.stringify/parse pair. Equality is
// also string-based — cheap and avoids deep-walking.
//
// Usage:
//
//   const h = createHistory(spec);
//   // After each spec mutation:
//   h.push(spec);          // no-op if state is unchanged from the top
//   // Undo / redo:
//   const prev = h.undo(); // returns the previous state, or null
//   const next = h.redo(); // returns the next state, or null
//   // Replace history when loading a fresh spec (openExisting):
//   h.reset(spec);
//
// The caller is responsible for re-applying the returned state onto
// the live spec object (typically with `Object.keys(spec).forEach(
// (k) => delete spec[k]); Object.assign(spec, returned)` so existing
// references stay valid).

const MAX_DEPTH = 50;

export function createHistory(initial) {
  let stack = [snapshot(initial)];
  let i     = 0;   // index of the *current* state in stack

  function snapshot(s) { return JSON.stringify(s); }
  function revive(s)   { return JSON.parse(s); }

  return {
    push(state) {
      const s = snapshot(state);
      if (s === stack[i]) return;             // dedupe no-op pushes
      stack.length = i + 1;                   // drop any redo branch
      stack.push(s);
      i++;
      while (stack.length > MAX_DEPTH) {       // bound memory
        stack.shift();
        i--;
      }
    },
    undo() {
      if (i <= 0) return null;
      i--;
      return revive(stack[i]);
    },
    redo() {
      if (i >= stack.length - 1) return null;
      i++;
      return revive(stack[i]);
    },
    reset(state) {
      stack = [snapshot(state)];
      i = 0;
    },
    canUndo() { return i > 0; },
    canRedo() { return i < stack.length - 1; },
  };
}
