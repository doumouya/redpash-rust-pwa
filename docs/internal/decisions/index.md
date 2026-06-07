---
title: Decisions — internal
section: Internal
last modified date: 2026-06-07
---

# Decisions

The durable **why** — design choices that bind future work. A decision lives
here when it constrains how the system may evolve (not "how X works today" —
that's [stack](../stack/index.md) — and not "what's on the wire" — that's the
feature areas). Superseded decisions move to [archive](../archive/index.md).

> Migrating in (CAS_701CF65E) from the old `architecture/` (the keepers only;
> FE/shell patterns fold into [stack/frontend](../stack/index.md), dated
> spikes go to [archive](../archive/index.md)). Phase C.

## Decisions

- [object-model.md](object-model.md) — the few-orthogonal-primitives object model (a new object only for a new *shape*, never a new combination).
- [target-architecture.md](target-architecture.md) — the durable architectural direction (framework-layer · disposability · scale-neutral).
- [vision.md](vision.md) — the product north-star + strategy.

## Related

- [stack](../stack/index.md) — how the chosen design actually works.
- [processes](../processes/index.md) — the practices the decisions imply.
