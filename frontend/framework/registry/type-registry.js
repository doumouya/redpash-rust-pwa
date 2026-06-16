/* type-registry.js — THE OBJECT REGISTRY (types are data, exactly like
   components and behavior). getTypes() fetches /api/types ONCE and caches in
   module state — pages derive chip labels, table columns and per-tier field
   cells from it instead of hardcoding object shapes. invalidate() clears the
   cache (the Admin Console calls it after a field-permission write so the
   next read re-derives from the server, never patches locally).

   Wire shape (the S7 contract):
   { types: [{ type_id, display_name, display_name_plural, rid_prefix,
               grid_served, fields: [{ key, label, data_type, perm_class,
               ordinal, cells: { owner, admin, member, viewer } }] }] }
   Fields arrive ordered by ordinal; cell values are "rw" | "r" | "".      */

import { api } from "../boot/api.js";

let cache = null; // Promise<types[]> | null — one in-flight fetch, shared

export function getTypes() {
  if (!cache) {
    cache = api.get("/types").then(
      (d) => d?.types ?? [],
      (err) => {
        cache = null; // a failed fetch must not poison future reads
        throw err;
      }
    );
  }
  return cache;
}

export function invalidate() {
  cache = null;
}

export async function typeById(id) {
  return (await getTypes()).find((t) => t.type_id === id) ?? null;
}
