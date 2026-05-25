// Lazy loader for the `data` crate's wasm build.
//
// The wasm bundle (~3.46 MB gzipped over-the-wire) lazy-loads only
// when `getEngine()` is first awaited — page-cold visitors pay 0
// bytes. The browser stream-compiles the .wasm, so engine ops become
// callable before the download finishes.
//
// Source of truth: backend/crates/data/src/wasm.rs (five wrappers
// — apply_filter, apply_sort, auto_clean, step_preview, parse_csv).
// Regenerate after a data-crate change: `sh tools/build-wasm.sh`.
// Architecture: docs/internal/roadmap-webassembly.md §5 Phase B + C.

/** Demo upload cap. Files larger than this go through the sign-up CTA
 *  instead of loading the wasm engine. 5 MB — generous for "try it",
 *  cheap for in-browser parse, and the bound is honest: bigger files
 *  legitimately do need an account (multi-step cleaning, persisted
 *  projects, etc.) — it's not artificial scarcity. */
export const DEMO_CAP_BYTES = 5 * 1024 * 1024;

let _enginePromise = null;

/** Lazy-load + initialize the wasm engine. Subsequent calls return the
 *  cached engine instantly. First call triggers fetch + stream-compile
 *  of `/wasm/data_bg.wasm` via the wasm-bindgen `data.js` glue. */
export async function getEngine() {
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    const mod = await import('/wasm/data.js');
    await mod.default(); // wasm-bindgen init — fetches + instantiates data_bg.wasm
    return {
      apply_filter:  mod.apply_filter,
      apply_sort:    mod.apply_sort,
      auto_clean:    mod.auto_clean,
      step_preview:  mod.step_preview,
      parse_csv:     mod.parse_csv,
    };
  })();
  return _enginePromise;
}

/** Throws RangeError if the file exceeds the demo cap; returns the file
 *  unchanged otherwise. The caller decides what to render on rejection
 *  (sign-up CTA, error toast, etc.) — this function makes no UI
 *  assumption beyond what the error message says. */
export function gateBySize(file) {
  if (file.size > DEMO_CAP_BYTES) {
    const limitMb = (DEMO_CAP_BYTES / 1024 / 1024).toFixed(0);
    const sizeMb  = (file.size      / 1024 / 1024).toFixed(2);
    throw new RangeError(
      `file is ${sizeMb} MB; demo limit is ${limitMb} MB. ` +
      `Sign up for a free account to handle any size.`
    );
  }
  return file;
}
