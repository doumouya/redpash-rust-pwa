/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/framework/type-registry.md */
import { api } from "/scripts/api.js";

// In-memory cache of TypeDefinitions, keyed by `type` id. Lazily filled on
// first getType() / getField() / all() call. invalidate() drops the cache
// so the next access re-fetches; nothing auto-refreshes today (the only
// admin write that affects /admin/types is /admin/fields PUT, and an
// explicit invalidate() after that write is cheaper than polling).
let cache = null;
let inflight = null;

async function load() {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = api.get("/admin/types").then((res) => {
    const next = new Map();
    (res.types || []).forEach((td) => next.set(td.type, td));
    cache = next;
    inflight = null;
    return cache;
  }).catch((err) => {
    inflight = null;
    throw err;
  });
  return inflight;
}

export const typeRegistry = {
  // Fetch a full TypeDefinition by `type` id. Returns null when the id
  // isn't served by /admin/types (404-leak-free: unknown types resolve
  // as null on the FE same as the backend handles missing types).
  async getType(typeId) {
    const c = await load();
    return c.get(typeId) || null;
  },
  // Fetch a single FieldDef from a TypeDefinition by field key. Returns
  // null when either the type or the field is unknown. Used by
  // cell-editor.js to dispatch editor-registry lookups and surface
  // resolved per-role perm cells per spec §3.
  async getField(typeId, fieldKey) {
    const td = await this.getType(typeId);
    if (!td) return null;
    return (td.fields || []).find((f) => f.key === fieldKey) || null;
  },
  // All TypeDefinitions currently cached (or freshly loaded). Used by
  // a future generic list-page renderer that auto-builds tabs from the
  // registry.
  async all() {
    const c = await load();
    return Array.from(c.values());
  },
  // Drop the cache. The next access re-fetches from /admin/types. Call
  // after an /admin/fields PUT (the only write that mutates the served
  // shape) or on explicit user-driven refresh.
  invalidate() {
    cache = null;
    inflight = null;
  },
};
