//! `redpash-commit-ingest` — record which commits reconciled which Case's docs, so
//! the cases close-gate can refuse an unreconciled close WITHOUT per-request git.
//!
//! For each commit in the range that references `CAS_<id>`, upsert one row per
//! (case, commit) into `case_docs_reconciled`:
//!   - `touched_docs` = the commit's diff touches `docs/`
//!   - `docs_ack`     = the commit carries a `Docs:` trailer with a reason (e.g. `Docs: n/a — <why>`)
//!   - `commit_at`    = the commit's date (the gate requires one newer than the case's close-floor)
//! The PATCH close guard then closes a case iff EXISTS a reconciliation row, fresh
//! enough (commit_at > the floor), with `(touched_docs OR docs_ack)`. CLAUDE.md "Docs
//! stay current".
//!
//! Run BEST-EFFORT from the pre-push hook (DB-optional — the gate is the hard
//! enforcement; this just feeds it). Re-ingesting is idempotent (`ON CONFLICT`).
//!
//! Usage (from the repo root):
//!     cargo run -p api --bin redpash-commit-ingest                  # <SINCE>..HEAD
//!     cargo run -p api --bin redpash-commit-ingest -- --range origin/lean..HEAD

use eyre::{bail, eyre, Result, WrapErr};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::process::Command;

/// The discipline-install anchor — the same default as case-coverage-audit. Commits
/// before it predate the Case-first rule and carry no refs to ingest.
const DEFAULT_SINCE: &str = "0ea7896";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("backend/.env");
    let _ = dotenvy::from_filename("../.env");

    let range = parse_range()?;

    let db_url = std::env::var("DATABASE_URL").wrap_err("DATABASE_URL not set")?;
    // rs-perf-allow: hardcoded-small-pool — a short-lived batch bin (mirrors audit_ingest);
    // it runs once per push and exits, so 2 connections is plenty and needs no env knob.
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .wrap_err("connect Postgres")?;

    let commits = commits_in(&range)?;
    let mut rows = 0usize;
    let mut cases = BTreeSet::new();
    for (sha, commit_at, body) in &commits {
        let refs = case_refs(body);
        if refs.is_empty() {
            continue;
        }
        let touched = touches_docs(&changed_files(sha)?);
        let ack = has_docs_ack(body);
        for case in refs {
            upsert(&pool, &case, sha, commit_at, touched, ack).await?;
            cases.insert(case);
            rows += 1;
        }
    }
    println!(
        "commit-ingest: range {range}  ·  {rows} (case,commit) row(s) across {} case(s)",
        cases.len()
    );
    Ok(())
}

/// One reconciliation fact. Idempotent: a re-run with a newer diff updates the flags
/// (e.g. a follow-up commit that adds the docs touch flips `touched_docs` true).
async fn upsert(
    pool: &PgPool,
    case: &str,
    sha: &str,
    commit_at: &str,
    touched: bool,
    ack: bool,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO case_docs_reconciled (case_rid, commit_sha, touched_docs, docs_ack, commit_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (case_rid, commit_sha)
         DO UPDATE SET touched_docs = EXCLUDED.touched_docs,
                       docs_ack     = EXCLUDED.docs_ack,
                       commit_at    = EXCLUDED.commit_at",
    )
    .bind(case)
    .bind(sha)
    .bind(touched)
    .bind(ack)
    .bind(commit_at)
    .execute(pool)
    .await
    .wrap_err("upsert case_docs_reconciled")?;
    Ok(())
}

fn parse_range() -> Result<String> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--range" => return args.next().ok_or_else(|| eyre!("--range needs a value")),
            "-h" | "--help" => {
                println!("usage: redpash-commit-ingest [--range <gitrange>]");
                println!("  default range: {DEFAULT_SINCE}..HEAD (override via CASE_AUDIT_SINCE)");
                std::process::exit(0);
            }
            _ => bail!("unknown arg {a}"),
        }
    }
    let since = std::env::var("CASE_AUDIT_SINCE").unwrap_or_else(|_| DEFAULT_SINCE.to_string());
    Ok(format!("{since}..HEAD"))
}

/// (sha, commit_at, message) for each non-merge commit in the range. The fields are
/// unit-separated (`\x1f`) and commits record-separated (`\x1e`), so a multi-line body
/// is never mistaken for a field or record boundary. `commit_at` is the committer date
/// (ISO-8601, `%cI`).
fn commits_in(range: &str) -> Result<Vec<(String, String, String)>> {
    let out = git(&["log", range, "--no-merges", "--format=%H%x1f%cI%x1f%B%x1e"])?;
    Ok(out
        .split('\u{1e}')
        .filter_map(|rec| {
            let rec = rec.trim_matches(|c| c == '\n' || c == '\r');
            if rec.is_empty() {
                return None;
            }
            let mut parts = rec.splitn(3, '\u{1f}');
            let sha = parts.next()?.trim().to_string();
            let at = parts.next()?.trim().to_string();
            let body = parts.next().unwrap_or("").to_string();
            (!sha.is_empty() && !at.is_empty()).then_some((sha, at, body))
        })
        .collect())
}

/// The files a commit changed (`git show --name-only`). The empty `--format=`
/// suppresses the log header; `-c core.quotepath=false` keeps non-ASCII `docs/` paths
/// unquoted (else git C-quotes them as `"docs/…"`, hiding the `docs/` prefix).
fn changed_files(sha: &str) -> Result<Vec<String>> {
    let out = git(&["-c", "core.quotepath=false", "show", "--name-only", "--format=", sha])?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

fn git(args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).output()?;
    if !out.status.success() {
        bail!("git {:?} failed", args);
    }
    Ok(String::from_utf8(out.stdout)?.trim_end().to_string())
}

// ── pure cores (unit-tested — no git, no DB) ────────────────────────────────

/// Every distinct `CAS_<32 hex>` referenced in a commit message (case-insensitive
/// hex, matching case-coverage-audit's `\bCAS_[0-9A-Fa-f]{32}\b`). Order-preserving,
/// de-duplicated, and **UPPERCASED** to match the minted `redpash_id` (`id::new`
/// uppercases) — a lowercase ref must key the same row the uppercase-rid gate reads.
/// Rejects a 31-or-fewer run and a 33rd trailing hex (exact-32, like `\b`).
fn case_refs(msg: &str) -> Vec<String> {
    let bytes = msg.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = msg[i..].find("CAS_") {
        let start = i + p;
        let hex = &bytes[start + 4..];
        if hex.len() >= 32
            && hex[..32].iter().all(u8::is_ascii_hexdigit)
            && (hex.len() == 32 || !hex[32].is_ascii_hexdigit())
        {
            // start.."CAS_"(4) + 32 hex = 36 bytes, all ASCII ⇒ a valid str slice.
            let rid = msg[start..start + 36].to_ascii_uppercase();
            if !out.contains(&rid) {
                out.push(rid);
            }
        }
        i = start + 4;
    }
    out
}

/// A commit ACKs docs if a line is a `Docs:` trailer with a NON-EMPTY value (e.g.
/// `Docs: n/a — <reason>` or `Docs: REDMAP.md`). Case-insensitive on the key; a bare or
/// whitespace-only `Docs:` does NOT count — the *reasoned declaration* is the point (the
/// `AUTH-AUDIT-ACK` model). `get(..5)` is boundary-safe (a body line may start multibyte).
fn has_docs_ack(msg: &str) -> bool {
    msg.lines().any(|l| {
        let l = l.trim_start();
        l.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("docs:")) && !l[5..].trim().is_empty()
    })
}

/// Does any changed path live under `docs/`? (The reconciliation signal.)
fn touches_docs(files: &[String]) -> bool {
    files.iter().any(|f| f.starts_with("docs/"))
}

#[cfg(test)]
mod tests {
    use super::{case_refs, has_docs_ack, touches_docs};

    #[test]
    fn extracts_a_case_ref_from_a_trailer() {
        let m = "fix: thing\n\nCase: CAS_406BD7D387C14BEA973F513FE1BEBAA8\nCo-Authored-By: x";
        assert_eq!(case_refs(m), vec!["CAS_406BD7D387C14BEA973F513FE1BEBAA8"]);
    }

    #[test]
    fn dedups_and_keeps_multiple_distinct_refs() {
        let a = "CAS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let b = "CAS_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let m = format!("touches {a} and {b} then {a} again");
        assert_eq!(case_refs(&m), vec![a.to_string(), b.to_string()]);
    }

    #[test]
    fn rejects_short_overlong_and_nonhex() {
        assert!(case_refs("CAS_short").is_empty());
        assert!(case_refs("CAS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_empty()); // 33 hex
        assert!(case_refs("CAS_ZZZZAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_empty()); // non-hex
        assert!(case_refs("no ref here").is_empty());
    }

    #[test]
    fn a_lowercase_ref_is_uppercased_to_match_the_minted_rid() {
        // id::new mints UPPERCASE; a lowercase ref must key the SAME row the gate reads.
        let m = "x CAS_406bd7d387c14bea973f513fe1bebaa8 y";
        assert_eq!(case_refs(m), vec!["CAS_406BD7D387C14BEA973F513FE1BEBAA8"]);
    }

    #[test]
    fn detects_a_reasoned_docs_trailer_case_insensitively() {
        assert!(has_docs_ack("feat: x\n\nDocs: n/a — pure logic fix"));
        assert!(has_docs_ack("feat: x\n\ndocs: REDMAP.md, schema.md"));
        assert!(has_docs_ack("feat: x\n\n  Docs: indented still counts"));
    }

    #[test]
    fn an_empty_mid_line_or_absent_docs_mention_is_not_an_ack() {
        assert!(!has_docs_ack("feat: rewrite the Docs: section header copy")); // mid-line
        assert!(!has_docs_ack("feat: x\n\nno trailer at all"));
        assert!(!has_docs_ack("Docs")); // no colon, no value
        assert!(!has_docs_ack("feat: x\n\nDocs:")); // bare key, no reason
        assert!(!has_docs_ack("feat: x\n\nDocs:    ")); // whitespace-only value
    }

    #[test]
    fn multibyte_line_start_does_not_panic() {
        assert!(!has_docs_ack("feat: x\n\n— a dashed note that is not a trailer"));
    }

    #[test]
    fn touches_docs_only_on_docs_prefix() {
        assert!(touches_docs(&["docs/REDMAP.md".into(), "backend/x.rs".into()]));
        assert!(!touches_docs(&["backend/x.rs".into(), "frontend/y.js".into()]));
        assert!(!touches_docs(&[])); // a no-op / empty commit
        assert!(!touches_docs(&["mydocs/x.md".into(), "documentation/y.md".into()]));
    }
}
