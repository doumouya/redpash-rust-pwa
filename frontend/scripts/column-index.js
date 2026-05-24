// column-index.js — per-file distinct-values cache.
//
// Backed by GET /api/files/:rid/uniques?col=X&q=Y&limit=N (live since
// commit 34445ce; response = { values, total, truncated }). Caches
// fetched results keyed on (rid, col, q, limit) so subsequent reads
// from any consumer (autocomplete, chip-picker, search) hit memory
// instead of the network.
//
// LRU at the FILE level (not per-key) — evicting a file drops every
// cached query for every column of that file in one move. Bound at
// 8 files per the audit_distincts P99 of 690KB resident; 8 × 690KB
// ≈ 5.5MB headroom for the chip-picker's selection state too.
//
// `invalidateFile(rid)` is the cache-invalidation hook every
// mutation site needs to call (clean step, join apply, file
// re-upload). The auth-audit pattern catalog will eventually flag
// any mutation callback that doesn't.
//
// This module is the first concrete consumer of the data-shape-
// index architecture; the FS pilot (per docs/internal/architecture/
// data-shape-index.md §4) will migrate this surface to the
// fs.distinct(path, q, limit) shape once the FS API designs against
// a real consumer.

import { api } from "/scripts/api.js";

const LRU_MAX = 8;

// cache: Map<rid, Map<cacheKey, DistinctResult>>
//   cacheKey = `${colName}::${q}::${limit}`
// lruOrder: rid strings, MRU first. Evicting pops the LRU end.
const cache    = new Map();
const lruOrder = [];

function cacheKey(colName, q, limit) {
  return colName + "::" + (q || "") + "::" + limit;
}

function touchLRU(rid) {
  const idx = lruOrder.indexOf(rid);
  if (idx >= 0) lruOrder.splice(idx, 1);
  lruOrder.unshift(rid);
  while (lruOrder.length > LRU_MAX) {
    const evicted = lruOrder.pop();
    cache.delete(evicted);
  }
}

/**
 * Fetch (or return from cache) the distinct-values slice for a column.
 *
 * @param {string} rid       — the file's redpash id
 * @param {string} colName   — exact column name as on the wire
 * @param {object} opts
 * @param {string} [opts.q]      case-insensitive substring filter (default "")
 * @param {number} [opts.limit]  cap on returned values (default 50, max 500)
 * @returns {Promise<{values: string[], total: number, truncated: boolean}>}
 */
export async function getDistinct(rid, colName, opts = {}) {
  if (!rid || !colName) return { values: [], total: 0, truncated: false };
  const q     = (opts.q || "").trim();
  const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
  const key   = cacheKey(colName, q.toLowerCase(), limit);

  const fileCache = cache.get(rid);
  if (fileCache && fileCache.has(key)) {
    touchLRU(rid);
    return fileCache.get(key);
  }

  const params = new URLSearchParams();
  params.set("col", colName);
  if (q) params.set("q", q);
  params.set("limit", String(limit));
  const url = "/files/" + encodeURIComponent(rid) + "/uniques?" + params.toString();

  let result;
  try {
    result = await api.get(url);
  } catch (err) {
    // Surface the error in a shape the caller can render without
    // crashing the dropdown. Don't cache failures — the next focus
    // gets a fresh chance.
    return { values: [], total: 0, truncated: false, error: err?.message || "fetch failed" };
  }

  // Normalize the shape — older callers parse `{ values }` only; we
  // assume the new fields are present (live since 34445ce) but
  // default-fill so a stale server doesn't crash the consumer.
  const normalized = {
    values:    Array.isArray(result?.values) ? result.values : [],
    total:     Number.isFinite(result?.total) ? result.total : (result?.values?.length || 0),
    truncated: !!result?.truncated,
  };

  const fc = cache.get(rid) || new Map();
  fc.set(key, normalized);
  cache.set(rid, fc);
  touchLRU(rid);
  return normalized;
}

/**
 * Drop every cached entry for this file. Call from mutation callbacks
 * (step apply, join apply, file re-upload, file rename) — anything that
 * changes the file's underlying rows or schema.
 */
export function invalidateFile(rid) {
  cache.delete(rid);
  const idx = lruOrder.indexOf(rid);
  if (idx >= 0) lruOrder.splice(idx, 1);
}

/** Clear everything — call on logout / session change. */
export function clearAll() {
  cache.clear();
  lruOrder.length = 0;
}
