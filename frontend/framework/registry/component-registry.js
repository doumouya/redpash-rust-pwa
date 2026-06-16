/* component-registry.js — the single-source component index. Every framework
   component self-registers its mount function at module load; the sandbox
   enumerates this registry to prove completeness (S3 gate), and pages obtain
   framework markup ONLY through these mounts (ui-fork-audit R8 enforces). */

const components = new Map();

export function register(name, mount, meta = {}) {
  if (components.has(name)) {
    console.warn(`[rp] component ${name} registered twice — one owner only`);
  }
  components.set(name, { name, mount, ...meta });
}

export function getComponent(name) {
  return components.get(name) ?? null;
}

export function listComponents() {
  return [...components.values()];
}
