//! Purpose: THE one sentinel vocabulary — the "missing value disguised as a
//! value" tokens that the cleanness score, the semantic-dtype sniff, the drift
//! detectors, and the user-facing scan all reason about.
//!
//! UNIFIED (day-one engine port): the predecessor maintained two overlapping
//! lists — `stats::SENTINELS` (~45 entries incl. FR + Excel errors) and
//! `dtype::SENTINEL_TOKENS` (~19 entries) — that could drift (one had
//! "missing"/"inconnu", the other didn't). They are one list here. The sniff
//! wants the empty string treated as a sentinel too; the user-facing scan
//! wants casing preserved. Both read `is_sentinel`, which canonicalises
//! (trim + lowercase) before matching, so the casing question lives in the
//! caller, not in two divergent constants.
//!
//! FR-first: the founding (Fleury) locale's junk — inconnu / non disponible /
//! sans objet — was the predecessor's biggest early miss when the set was
//! English-only. It stays first-class here.

/// The canonical lowercase sentinel tokens. The empty string is included so
/// the dtype sniff (which skips sentinels when sampling) treats blanks as
/// missing — the scan that wants to preserve original casing handles empties
/// separately upstream.
pub const SENTINELS: &[&str] = &[
    "", // blank — a sentinel for the sniff; the scan filters empties itself
    // English + symbolic
    "n/a", "na", "n.a.", "-", "--", "—", "–", "?", "??", "???", "null",
    "(null)", "<null>", "none", "nan", "nil", ".", "..", "tbd", "tba", "x",
    "unknown", "undefined", "missing", "(blank)", "blank",
    // French — the founding locale
    "inconnu", "n/d", "nd", "n.d.", "non disponible", "non communiqué",
    "s/o", "s.o.", "n.c.", "sans objet",
    // Excel error literals exported as text
    "#n/a", "#name?", "#ref!", "#value!", "#div/0!", "#num!", "#null!",
];

/// Canonicalise (trim + ASCII/Unicode lowercase) and test membership. The
/// single predicate every consumer shares — there is no second list to drift.
pub fn is_sentinel(raw: &str) -> bool {
    let c = raw.trim().to_lowercase();
    SENTINELS.contains(&c.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unifies_the_two_legacy_lists() {
        // Entries that lived in only ONE of the predecessor's two lists must
        // both resolve now (the drift this unification closes).
        assert!(is_sentinel("missing")); // was stats-only
        assert!(is_sentinel("inconnu")); // was stats-only
        assert!(is_sentinel("nd")); // was in both
        assert!(is_sentinel("  N/A ")); // canonicalised: trim + case
        assert!(is_sentinel("")); // blank is a sniff sentinel
        assert!(!is_sentinel("Alice"));
    }
}
