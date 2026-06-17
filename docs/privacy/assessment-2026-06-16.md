# RedPash — Independent Privacy Assessment (GDPR & Privacy-by-Design)

**Date:** 2026-06-16 · **Subject:** `redpash-rust-pwa` (~Phase 5 of the rebuild) ·
**Standard:** GDPR + the 7 Privacy-by-Design principles (Art. 25 /
<https://gdpr-info.eu/issues/privacy-by-design/>) · **Status:** internal / pre-production

> This is the human record behind [`tools/privacy-audit/`](../../tools/privacy-audit/audit.js),
> which encodes the findings below (F-A…F-L) as ratcheted static checks. Re-run
> `node tools/privacy-audit/audit.js` for the live state; `report.html` renders it.

---

## 1. Verdict

**Strong privacy *architecture*; immature privacy *operations*.** The core decision —
*bring compute to the data, keep customer rows client-side* — is a genuine
Privacy-by-Design choice most competitors don't make. Access control (leak-free 404
RBAC, IDOR-safe downloads, tenant isolation, compile-gated dev backdoor) is well above
typical pre-production standard. But the controls that turn good architecture into
*demonstrable* GDPR compliance are largely absent: no data classification, no retention
automation, incomplete erasure, no subject export, no read-audit, and **no user-facing
transparency or consent.** Two findings (F-E, F-J) contradict the project's own locked
posture (`registry-redundancy.md`).

- **GDPR-compliant for production processing of real personal data today? No.**
- **Privacy by Design? In spirit yes (principles 3 & 4 are genuinely strong); in delivered controls, partially (5, 6 unmet).**
- **Maturity: Level 2 of 4 — "Architected, not yet operationalised."**

The gap is real but **cheap to close**, because the architecture is sound and the gaps
are additive, not structural.

## 2. Method & limitations

Static code review of the `api`/`data`/`shared` crates, the Postgres schema, the
frontend, the `tools/` suite, and the locked decision docs. **Not** performed: runtime
/ pen testing, infrastructure review (TLS termination, DB-at-rest encryption, backups,
data residency), or legal-text review — flagged as deployment-layer concerns. Rated
against the bar RedPash must meet *before it processes other people's personal data in
production* (it already ingests some — e.g. student records).

## 3. Controller / processor roles

| Domain | Role | Obligation |
|---|---|---|
| RedPash's own users (OAuth identity, cases, comments) | **Controller** | Notice (Art. 13), lawful basis (Art. 6), subject rights (Art. 15–22). |
| Customer-uploaded CSV/attachment content | **Processor** | Security (Art. 32), deletion on request, processing record (Art. 30), a DPA per third-party org. |

This dual role is undocumented — an accountability gap (Art. 5(2)).

## 4. The 7 Privacy-by-Design principles

| # | Principle | Maturity | Note |
|---|---|---|---|
| 1 | Proactive not Reactive | 🟡 Partial→Strong | Strong culture (locked decisions, audit suite, this review); no DPIA / privacy tests. |
| 2 | Privacy as the Default | 🟡 Partial | Compute-to-data default is exemplary; "keep forever" retention default, no PII tagging, no consent default. |
| 3 | Privacy Embedded into Design | ✅ Strong (w/ exceptions) | Genuinely embedded; F-E/F-J are embedding *defects*, not absence. |
| 4 | Full Functionality (Positive-Sum) | ✅ Strong | Proves privacy ≠ less function (client-side at scale). |
| 5 | End-to-End Security / Lifecycle | 🟡 Partial | Strong entry/transit; weak at-rest (no encryption) and **end-of-life** (erasure, retention). |
| 6 | Visibility & Transparency | ❌ Gap | No notice, consent, RoPA, or user-facing disclosure. Weakest principle. |
| 7 | Respect for User Privacy | 🟡 Partial | Principled scrub intent; no self-service rights, no notice. |

## 5. Findings register

Severities mirror `tools/privacy-audit/audit.json` (6 High, 5 Medium, 1 accepted).

| ID | Sev | Finding | Art. | Evidence |
|---|---|---|---|---|
| F-A | High | Disk blobs (`.bin`) orphan on delete — `delete_entity` is SQL-only; case-delete doesn't sweep attachment blobs | 17 | `db.rs` `delete_entity`, `cases.rs` |
| F-B | High | `scrub_user_tx` doesn't anonymise `case_comments.body` — deleted user's text persists | 17 | `db.rs` `scrub_user_tx` |
| F-C | High | No retention automation — 3 partitioned tables, no DROP/DETACH job (only a comment) | 5(1)(e) | `init.sql:360,375,386` |
| F-D | High | No privacy notice / consent surface anywhere in `frontend/` | 12–14 | `frontend/` |
| F-E | High | Chart `spec.option` bakes customer-derived data (group keys + aggregates) into Postgres — contradicts `registry-redundancy.md` **and** "derive, don't store" | 5(1)(c)(e), 25 | `chart-editor.js:126,138`, `designer.rs` |
| F-F | High | Connector secrets unencrypted — `init.sql` declares `v1:` encryption; no crypto dep / code (latent: no live route yet) | 32 | `init.sql:320`, `backend/Cargo.toml` |
| F-G | Med | No PII-classification dimension — `perm_class` ≠ sensitivity; blocks redaction/export/erasure keying | 25 | `init.sql` `type_fields`, `field_perms.rs` |
| F-H | Med | No data-subject export / portability (only per-file export) | 15, 20 | `me.rs` |
| F-I | Med | No read-access audit — only create/update/delete logged | 30 | `event.rs:32` |
| F-K | Med | Logout doesn't wipe IndexedDB/localStorage (latent until GlueSQL-idb is wired) | 17, 32 | `rail-data.js` |
| F-L | Med | `case_comments.body` raw plaintext; schema comment falsely claims "sanitized whitelist-rebuild HTML" | 32 | `init.sql:275`, `cases.rs` |
| **F-J** | Med | **Accepted (Em 2026-06-16):** `columns_meta.sample` stores one cell value server-side. Mitigation = at-rest encryption (pending). See [`registry-redundancy.md`](../decisions/registry-redundancy.md). | 5(1)(c) | `dtype.rs` |

## 6. Strengths (preserve these)

- Compute-to-data architecture — raw rows stay client-side (`registry-redundancy.md`).
- Metadata-only attachment & file stores — DB backups carry no file contents.
- Leak-free 404 RBAC; IDOR-safe attachment download (`WHERE id AND case_id`); `Content-Disposition: attachment` + `nosniff`.
- SSRF + TLS-required connector gate; **no analytics / tracker / LLM egress**.
- Erasure intent: scrub nulls PII, refuses to orphan sole-owned objects.

## 7. Remediation roadmap

**Compliance-blocking (before production processing of third-party data):**
1. **F-D** — privacy notice + controller/processor doc + one-page RoPA.
2. **F-A / F-B** — complete erasure (sweep blobs, scrub comment bodies) + regression test.
3. **F-C** — partition-drop retention + session GC + stated retention window.
4. **F-E** — implement the recipe-only decision (drop `spec.option`, re-derive on load).

**Foundational (unlocks the rest):**
5. **F-G** — orthogonal `data_class` dimension; tag PII fields.
6. **F-H** (`/api/me/export`), **F-I** (read-audit + `data_class`-keyed redaction),
   **F-K** (clear-on-logout before idb wiring), **F-F** (connector encryption),
   **F-J/F-L** (encrypt registry sample/blobs; fix the comment).

Every fix is regression-locked by `tools/privacy-audit/` via the `ci-audit` ratchet
(`baseline.json: "privacy"`), so the posture becomes measurable, not asserted.

## 8. Conclusion

Strong privacy *engineering*, missing privacy *governance*. The expensive part —
embedding privacy into the architecture (principle 3) and proving positive-sum
functionality (principle 4) — is already won. What remains is well-understood, additive
work. The one caveat: a system can't credibly claim "Privacy by Design" while quietly
storing customer-derived data in the registry it promised would hold none — **reconcile
F-E and F-J** (honour the posture or formally amend the decision) to keep the claim
honest. Recommended next slice: the audit tool (shipped) + the four compliance-blockers.

## 9. Resolution status (2026-06-17)

This assessment drove an enforcement slice. Of the findings: **9 closed**, 1
accepted, 1 partial, 1 deferred to the go-live workstream
([`privacy-by-design.md`](privacy-by-design.md) § Go-live).

| Finding | Status | Commit |
|---|---|---|
| F-G data_class dimension | closed | `f496bba` |
| F-A blob-sweep on delete | closed | `d87a174` |
| F-B comment-scrub on erasure | closed | `d87a174` |
| F-E recipe-only chart spec | closed | `a7e7d28` |
| F-H `/api/me/export` | closed | `c35b313` |
| F-I read-access audit | closed | `b7344a3` |
| F-F encryption + key rotation | closed | `bd2ade2` |
| F-L comment doc + check refine | closed | `9a52d9d` |
| F-K logout client-storage clear | closed | `580e7d4` |
| F-J `columns_meta.sample` | accepted (at-rest encryption → go-live) | — |
| F-C retention | partial — session-GC + blob reaper shipped; partition rotation → go-live | `5228275` |
| F-D privacy notice | deferred → go-live workstream | — |

The `tools/privacy-audit` ratchet floor is now **2** (F-C partition rotation, F-D
notice) — both go-live-gated. Re-run `node tools/privacy-audit/audit.js` for the
live state.
