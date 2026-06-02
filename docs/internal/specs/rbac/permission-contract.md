---
title: Permission Contract — the per-company policy layer
section: Internal
order: 2
last modified date: 2026-06-03
owner: Torv
status: active — storage + evaluator shipped (7d59460, 193f554); not yet endpoint-wired
---

# Permission Contract (`company_rbac`)

The **policy layer** over the entity-membership graph. The
[entity-membership-model](entity-membership-model.md) answers *"what tier does this
caller hold on this object, and by what reach?"* — the `resolve_grant` resolver. The
permission contract answers the orthogonal question: *"for this company, which teams may
take which actions on which object **TYPES** — and which **fields**?"*

It is one declarative, **per-company, versioned JSONB** document (`company_rbac`) that the
single evaluator (`require_action`, [rbac.rs](../../code/backend/api/rbac.md)) reads.
Em's reframe (CAS_0DE2DDEF): *"Our RBAC is now a JSON"* — the same registry/validator shape
already used for codecs / Avro / [TypeDefinition](../type-definition.md). The contract is
**policy**; `memberships` stays the **graph**; `require_action` is the **one evaluator**
reading both. The JSON is never the graph — it carries *rules*, not edges (no
Zanzibar-in-a-blob).

> **Status (2026-06-03):** storage (`company_rbac`) + the evaluator (`require_action` /
> `evaluate`) are implemented and tested, but **no endpoint invokes `require_action` yet**
> (no call-sites in `routes/`). A company with **no** registered contract evaluates
> **tier-only** — today's behaviour — so the layer is opt-in and non-breaking until the
> cutover wires handlers onto it.

## §1. The axes

Access is the **intersection** of independent axes — a caller is admitted only when *all*
applicable axes admit them.

- **Vertical — the tier ladder.** `owner > admin > member > viewer`, a universal framework
  default, recursive at every level (RedPash-root → company → team → person). Resolved by
  `resolve_grant` over reach (direct ∪ cascade ∪ team-closure). This is the
  [entity-membership-model](entity-membership-model.md); the contract does **not** store it.
- **Horizontal — per-`(team, object-TYPE)` action grants.** *Capability, not rank.* HR owns
  `User`+`Payslip`; Engineering owns `Case`+`Monitoring`. HR is not *over* Engineering — they
  own different object types. A grant is a subset of `c,r,u,d`. This axis is what the contract
  **adds**: without it, a tier applies to *all* object types in reach (a company `member` is
  member-tier on cases AND users alike).
- **Depth — field permissions.** Per-`(object-TYPE × field × role)`, already shipped as
  [`field_perms`](../../code/backend/api/field_perms.md) + the `field_permissions` table +
  [TypeDefinition](../type-definition.md). Today write-gated via `require_fields` (read masking
  pending), and a *global* table; folding it into a per-company `fields` section of this
  contract is the convergence step (epic step 4).

## §2. Storage

```sql
company_rbac(
  company_id TEXT NOT NULL REFERENCES companies(redpash_id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  contract   JSONB NOT NULL,
  created_by TEXT REFERENCES users(redpash_id),  -- NULL = system/seed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, version)
)
```

- **Active contract = `max(version)`** per company (index `company_rbac_active`).
- **Append-only + versioned** — every change is a new row, never an UPDATE. That gives a
  **provable, rollback-able audit trail** (the legal-stakes answer: who changed policy, when,
  to what).
- **JSONB** so we query/index *into* the policy with no DDL, ever — the
  [data-format-open-ended] principle. The same document also lives in a **localStorage cache**
  for offline / on-device evaluation, tying RBAC into the edge-governance story.
- Migration: `backend/migrations/20260601000001_company_rbac_contract.sql`.

## §3. The `Contract` shape

One registry row per company (the `Contract` struct in
[rbac.rs](../../code/backend/api/rbac.md)):

```jsonc
{
  "company": "CMP_…",                       // PK anchor
  "owner":   "USR_…",                       // the one company_owner
  "admins":  ["USR_…"],                     // company_admins (org-management)
  "labels":  { "Manager": "owner",          // DISPLAY-ONLY — the engine never reads this
               "Consultant": "member" },
  "grants":  {                              // the horizontal axis, keyed by team PK
    "TEAM_eng": { "Case": ["c","r","u","d"], "Monitoring": ["r"] },
    "TEAM_hr":  { "User": ["c","r","u","d"], "Payslip": ["r"], "Case": ["c"] }
  }
}
// The ladder, self-overlay, and see-down visibility are framework DEFAULTS — not stored.
```

**THE invariant (Em, emphasised twice): enforcement is tier-only + PK-anchored.** The engine
branches on the `role` rank + team **PKs** + object **TYPE** only. `context_role`
("Manager"/"Swarm Lead"), team/department **names**, and the `labels` map are **free-text the
user picks and the framework completely ignores** — pure display. *We don't care* what they
call things; that is why `role` (truth) and `context_role` (their vocabulary) are separate
columns. No enforcement path ever reads a name or a label.

## §4. Evaluation

`require_action(state, caller, object, action)` (the target single gate every endpoint will
converge onto):

1. **Platform-admin bypass** — `is_platform_admin` ⇒ allow (RedPash-root reach).
2. `object_type = object_kind(rid)`; `grant = resolve_grant(caller, object)` (vertical tier).
3. `contract = load_contract(company_of(object))`; `None` ⇒ **tier-only** (today's behaviour).
4. Pure `evaluate(grant, contract, principals, caller, object_type, action)`:
   **tier (vertical) ∩ contract grant (horizontal), capped by tier**, + self-overlay.
5. Deny ⇒ **404** (leak-free — never reveal an object the caller can't reach).

Additive and non-breaking: with no contract (or a default contract) it behaves exactly as
the tier-only resolver does today; tighten per-company as contracts populate.

## §5. Semantics (the locked decisions)

- **`company_owner`** — full reach over the company subtree; the org's root.
- **`company_admin` is fail-closed: org-management only.** Admins manage the **org graph**
  (teams, memberships, users-as-org) **plus the object TYPES their team is granted** — they do
  **not** auto-CRUD every content type. This resolves the "can an admin silently read another
  team's `Payslip`?" go-to-jail surface: content access is *explicit* grants only.
- **See-down-only visibility.** A principal sees **down their subtree** — never up (parent) or
  sideways (siblings). This single rule *is* tenant isolation (companies can't see each other
  or RedPash) **and** platform reach (RedPash, as root, sees all).
- **Self-overlay.** Your own `User` row → edit `{profile, email, alias}` regardless of team.
- **RedPash-as-root.** The platform is the root owner; companies are its members. Modelled via
  `is_platform_admin` today; formalised as the root contract in epic step 5.
- **Partner-manages-companies = position, not a flat tier.** A partner company holds an explicit
  `memberships(object=client_company, member=partner_company, role=admin)` edge — so see-down
  grants it reach over **only its assigned clients**, never all companies. The symmetric edge
  (member can be a company/team) supports this with no new mechanism; isolation holds for
  non-clients.

## §6. The alphabets

- **`object_kind(rid)`** — rid prefix → canonical object TYPE: `CAS_`→`case`, `USR_`→`user`,
  `CMP_`→`company`, `TEAM_`→`team`, `PRJ_`→`project`, … ; unknown → `"unknown"` (default-denied).
  The contract's `grants` object-TYPE keys use these canonical strings.
- **Action c/r/u/d** — `Action { View, Create, Edit, Delete }`; `crud()` → `r/c/u/d` (the grant
  alphabet); `min_tier()` is the vertical floor a tier must meet for the action regardless of
  grant: `View→Viewer`, `Create/Edit→Member`, `Delete→Admin`.

## §7. Worked example + the field axis

Engineering (`TEAM_eng`) and HR (`TEAM_hr`) in one company:

- An Eng **member** editing a `CAS_…`: tier (member, in-reach) ∩ `grants.TEAM_eng.Case` ⊇ `u`
  ⇒ **allowed**. The same member editing a `USR_…`: `grants.TEAM_eng` has no `User` key ⇒
  **denied** (404) — even though the tier alone would have admitted them.
- HR editing a `Payslip`: `grants.TEAM_hr.Payslip = ["r"]` ⇒ read only; an update is **denied**.
- HR creating a `Case`: `grants.TEAM_hr.Case = ["c"]` ⇒ create allowed, update/delete denied —
  a *partial* grant.

The **field axis** narrows this further: once `require_action` admits the write, `require_fields`
checks each field against the `(object-TYPE × field × role)` matrix
([field_perms](../../code/backend/api/field_perms.md)). E.g. an Eng admin may edit a case's
`status` but not its `company_id`. The field matrix is global today; folding it into a per-company
`fields` section of this contract (+ read masking) is epic step 4.

## Related

- [entity-membership-model](entity-membership-model.md) — the §2 tier/reach resolver (the vertical axis).
- [rbac catalog index](index.md) — the permission-model axioms + per-object catalog this overlays.
- [membership](membership.md) — the `memberships` edge (the graph the contract is policy *over*).
- [type-definition](../type-definition.md) — the shared registry/validator shape; the field matrix lives here.
- [field_perms](../../code/backend/api/field_perms.md) — the field-axis enforcement (`require_fields`).
- [rbac.rs](../../code/backend/api/rbac.md) — the evaluator code surface (`Contract`, `require_action`, `evaluate`).
