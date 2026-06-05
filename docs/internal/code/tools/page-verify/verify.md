---
title: tools/page-verify/verify.js
source: ../../../../../tools/page-verify/verify.js
owner: Torv
section: Internal · Code · Tools · page-verify
last modified date: 2026-06-05
---

# page-verify

## Purpose

The **active runtime verifier** for the design-language rollout (`CAS_B747F2B6`). It
launches a headless browser (Playwright), mints a dev session, then drives each
railed page and asserts the things a static audit can't see — the
`rt-*`→`rp-*` migration is the kind of change where a markup rename that misses a
JS selector **silently** breaks the rail (no parse error), so the value is
*driving + interacting*, not just diffing source.

It is **deliberately NOT a `tools/*-audit/` member**: it needs a running dev
server + a real browser, so it must stay OUT of the always-run static
`tools/audit.sh` (which runs anywhere, no server). It **complements**
[`ui-runtime-audit`](../audit-suite/ui-runtime-audit.md) — that lane diffs
`?audit=2` captures against the static enumeration; this tool drives the page
end-to-end and checks migration/interaction/theme **health**. Opt-in: run it when
a dev server is up.

## Public surface

`node tools/page-verify/verify.js [--pages a,b] [--themes x,y] [--base URL] [--headed]`

Per railed page it asserts (PASS requires all):
- rail renders on the framework `rp-rail*` atoms (`rp-rail-tab` / `rp-rail-group` present);
- the **rail subtree has zero residual `rt-*`** (migration complete *within* the rail; list/redtable-surface `rt-*` outside `.rp-rail` is reported as `deferred list-surface rt-*`, never failed — that's the list-page/redtable lane);
- a rail tab **click activates** (the JS-selector lockstep is functional);
- `--rp-accent` resolves under every theme (token-driven recolor);
- no console / page errors during load + interaction.

Defaults: pages `profile,docs,home,settings`; themes the 4 (`catppuccin-mocha`/`-latte` + `new-dark`/`-light`); base `http://127.0.0.1:8080`. Screenshots → `tools/page-verify/screens/` (gitignored), two themes per page. Exit `0` all pass · `1` a page failed · `2` prerequisites missing (skipped).

## Drift-prone areas

- **Prereqs are checked at runtime, not assumed** (exit 2 + a clear message if
  missing): the dev server up with `REDPASH_DEV_LOGIN=1` (the `POST /api/auth/dev-login`
  session mint), Playwright resolvable, and a launchable Chrome.
- **Playwright resolution is best-effort** — tries `PLAYWRIGHT_DIR`, local
  `node_modules`, then the `~/.npm/_npx/*/node_modules` cache (ephemeral — npx may
  GC it). If it vanishes, `npx playwright@latest` once or set `PLAYWRIGHT_DIR`.
- **Chrome resolution** prefers system `google-chrome`/`chromium`/`edge`
  (`CHROME_BIN` overrides); falls back to Playwright's `channel: "chrome"`.
  `--no-sandbox` is set for WSL2/CI.
- **Rail-clean is scoped to `.rp-rail`** on purpose — a page mid-rollout whose
  *list surface* still emits `rt-*` is not failed; only residual `rt-*` *inside the
  rail* fails. Adjust the selector if the rail's root class ever changes.
- **dev-login is dev-only** — never point `--base` at a prod-like deploy; the mint
  is gated behind `REDPASH_DEV_LOGIN` server-side anyway.

## Related

- [audit suite landing](../audit-suite/index.md) · [ui-runtime-audit](../audit-suite/ui-runtime-audit.md) — the static-capture sibling lane.
- [Design-language rollout plan](../../../../../.claude/plans/hi-need-a-plan-golden-treasure.md) · case `CAS_B747F2B6`.
- [rail.css atoms](../../frontend/styles/) — the `rp-rail*` framework atoms this verifies pages consume.
