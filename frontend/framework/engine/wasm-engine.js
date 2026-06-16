/* wasm-engine — the lazy loader for the dual-surface data engine. Cold
   visitors pay zero bytes; the first engine call streams + compiles the
   content-hashed wasm (which the service worker then holds cache-first —
   the hash IS the version, nothing can go stale).

   RUNTIME EXPORT INTROSPECTION: the method surface is enumerated from the
   wasm-bindgen module itself — there is NO hand-maintained method array (the
   predecessor's 13-exports-vs-6-wired drift is designed out). Whatever the
   Rust crate exports under #[wasm_bindgen] is callable the day it ships.

   "One engine, two surfaces": these are the SAME functions the server runs —
   a client-side score is byte-identical to the server's for the same bytes. */

let enginePromise = null;

export function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod = await import("/wasm/data.js");
      await mod.default(); // streams + compiles the hashed wasm
      const engine = {};
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === "function" && name !== "default" && !name.startsWith("__")) {
          engine[name] = value;
        }
      }
      return engine;
    })().catch((e) => {
      enginePromise = null; // allow retry after a transient failure
      throw e;
    });
  }
  return enginePromise;
}

/** Client-side instant quality report for raw CSV bytes — the same
    parse → summarize → score path the server's upload runs. The bytes never
    leave the device. Returns the parsed JSON report or null when the engine
    is unavailable (callers degrade gracefully — the server report still
    arrives via the upload response). */
export async function clientParseScore(bytes) {
  try {
    const engine = await getEngine();
    if (typeof engine.parse_score !== "function") return null;
    return JSON.parse(engine.parse_score(new Uint8Array(bytes), undefined));
  } catch {
    return null;
  }
}

/** Load raw CSV bytes into a resident client-side Workbook — the in-browser
    data engine. The returned instance holds the parsed frame in wasm memory;
    call .page(offset, limit), .filter_page(filterJson, offset, limit),
    .score(), .rows(), .cols() on it (each page/filter_page/score returns a
    JSON STRING — parse it). `tld` is the optional encoding hint (e.g. "fr").
    Returns null when the engine is unavailable, so callers degrade to the
    server /page endpoints exactly like clientParseScore. */
export async function loadWorkbook(bytes, tld) {
  try {
    const engine = await getEngine();
    if (typeof engine.Workbook?.from_csv !== "function") return null;
    return engine.Workbook.from_csv(new Uint8Array(bytes), tld);
  } catch {
    return null;
  }
}
