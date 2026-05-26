//! `redpash-audit-ingest` — persist one tools/<tool>-audit/audit.json
//! run into audit.run + audit.finding.
//!
//! Standalone companion to the audit scripts. Each `audit.js` writes its
//! full `data` object as `audit.json` next to the .html report; this
//! binary reads that JSON, captures git context, and writes one
//! `audit.run` row + one `audit.finding` row per individual finding in a
//! single transaction.
//!
//! Schema: `backend/migrations/20260528000001_audit_storage.sql`.
//! Design: `tools/audit-storage-brainstorming.md`.
//!
//! Usage:
//!     redpash-audit-ingest --tool css
//!     redpash-audit-ingest --tool html --file /abs/path/audit.json
//!
//! Default file path: `tools/<tool>-audit/audit.json`, resolved relative
//! to the current working directory. Run from the repo root.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use std::path::PathBuf;
use std::process::Command;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    // The audit JSONs live under tools/ (relative to the repo root), but the
    // .env lives at backend/.env. Try both so the binary works from either CWD.
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("backend/.env");
    let _ = dotenvy::from_filename("../.env");

    let (tool, file) = parse_args()?;
    let path = file.unwrap_or_else(|| {
        PathBuf::from("tools")
            .join(format!("{tool}-audit"))
            .join("audit.json")
    });

    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?;
    let data: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parse {}", path.display()))?;

    let stats = data.get("stats").cloned().unwrap_or(Value::Null);
    if stats.is_null() {
        bail!("audit.json missing top-level `stats`");
    }

    let git_sha = git(&["rev-parse", "HEAD"]).ok();
    let git_branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).ok();

    let db_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .context("connect Postgres")?;

    let mut tx = pool.begin().await?;

    let run_id: i64 = sqlx::query_scalar(
        "INSERT INTO audit.run (tool, git_sha, git_branch, stats, payload)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id",
    )
    .bind(&tool)
    .bind(&git_sha)
    .bind(&git_branch)
    .bind(&stats)
    .bind(&data)
    .fetch_one(&mut *tx)
    .await
    .context("insert audit.run")?;

    let findings = explode(&tool, &data)?;
    let n = findings.len();
    for f in &findings {
        // ON CONFLICT defends against the explode producing two findings with
        // the same key inside a single payload — unlikely but cheap to guard.
        sqlx::query(
            "INSERT INTO audit.finding (run_id, tool, kind, finding_key, severity, detail)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (run_id, finding_key) DO NOTHING",
        )
        .bind(run_id)
        .bind(&tool)
        .bind(&f.kind)
        .bind(&f.key)
        .bind(f.severity)
        .bind(&f.detail)
        .execute(&mut *tx)
        .await
        .context("insert audit.finding")?;
    }

    tx.commit().await?;

    println!(
        "audit.run #{run_id}  tool={tool}  branch={}  sha={}  findings={n}",
        git_branch.as_deref().unwrap_or("?"),
        git_sha
            .as_deref()
            .map(|s| if s.len() >= 7 { &s[..7] } else { s })
            .unwrap_or("?"),
    );

    print_diff_summary(&pool, &tool, run_id).await?;

    Ok(())
}

// "Since last run" — look up the most recent earlier run for the same tool
// and call audit.run_diff. Silent if there's no prior run yet.
async fn print_diff_summary(pool: &sqlx::PgPool, tool: &str, run_id: i64) -> Result<()> {
    let prev_id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM audit.run
          WHERE tool = $1 AND id < $2
          ORDER BY id DESC LIMIT 1",
    )
    .bind(tool)
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .context("lookup prev run")?;

    let Some(prev) = prev_id else {
        println!("  (no prior {tool} run — baseline established)");
        return Ok(());
    };

    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, COUNT(*)::bigint
           FROM audit.run_diff($1, $2)
          WHERE status <> 'unchanged'
          GROUP BY status",
    )
    .bind(run_id)
    .bind(prev)
    .fetch_all(pool)
    .await
    .context("run_diff query")?;

    let n = |k: &str| counts.iter().find(|(s, _)| s == k).map(|(_, c)| *c).unwrap_or(0);
    let new_ = n("new");
    let fixed = n("fixed");
    let regr = n("regressed");
    let impr = n("improved");

    if new_ + fixed + regr + impr == 0 {
        println!("  vs audit.run #{prev}: no change");
    } else {
        println!(
            "  vs audit.run #{prev}: {new_} new · {fixed} fixed · {regr} regressed · {impr} improved",
        );
    }
    Ok(())
}

struct Finding {
    kind: String,
    key: String,
    severity: Option<i32>,
    detail: Value,
}

fn parse_args() -> Result<(String, Option<PathBuf>)> {
    let mut args = std::env::args().skip(1);
    let mut tool: Option<String> = None;
    let mut file: Option<PathBuf> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--tool" => tool = args.next(),
            "--file" => file = args.next().map(PathBuf::from),
            "-h" | "--help" => {
                println!("usage: redpash-audit-ingest --tool <TOOL> [--file <path>]");
                println!("  TOOL ∈ {{css, html, tab-compare, cross-page, parallel, ui-snapshot}}");
                std::process::exit(0);
            }
            _ => bail!("unknown arg {a}"),
        }
    }
    let tool = tool.ok_or_else(|| {
        anyhow!("missing --tool <css|html|tab-compare|cross-page|parallel|ui-snapshot>")
    })?;
    // The audit.run CHECK constraint allows only these names (see mig
    // 20260613000001_relax_audit_tool_check.sql); keep the binary honest so a
    // typo fails fast with a clear message instead of a SQLSTATE 23514 surfacing
    // 50 lines down the call stack.
    const ALLOWED: &[&str] = &[
        "css", "html",
        "tab-compare", "cross-page", "parallel", "ui-snapshot",
    ];
    if !ALLOWED.contains(&tool.as_str()) {
        bail!(
            "--tool '{tool}' not in {ALLOWED:?} — keep this list in sync with \
             the audit.run.tool CHECK constraint."
        );
    }
    Ok((tool, file))
}

fn git(args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).output()?;
    if !out.status.success() {
        bail!("git {:?} failed", args);
    }
    Ok(String::from_utf8(out.stdout)?.trim().to_string())
}

// Derived projection: payload stays the source of truth in audit.run.payload;
// audit.finding is exploded from it at ingest time so the new/fixed/regressed
// diff queries are a plain self-join on finding_key.
fn explode(tool: &str, data: &Value) -> Result<Vec<Finding>> {
    let mut out = Vec::new();
    match tool {
        "css" => {
            if let Some(arr) = data.get("selectorConflicts").and_then(Value::as_array) {
                for item in arr {
                    let selector = item.get("selector").and_then(Value::as_str).unwrap_or("");
                    let at_ctx = item.get("atContext").and_then(Value::as_str).unwrap_or("");
                    let key = format!("{at_ctx} ||| {selector}");
                    let sev = item
                        .get("conflictCount")
                        .and_then(Value::as_i64)
                        .map(|v| v as i32);
                    out.push(Finding {
                        kind: "selector_conflict".into(),
                        key,
                        severity: sev,
                        detail: item.clone(),
                    });
                }
            }
            if let Some(arr) = data.get("classIndex").and_then(Value::as_array) {
                for item in arr {
                    let dvg = item.get("divergentCount").and_then(Value::as_i64).unwrap_or(0);
                    if dvg <= 0 {
                        continue;
                    }
                    let cls = item
                        .get("cls")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    out.push(Finding {
                        kind: "class_divergence".into(),
                        key: cls,
                        severity: Some(dvg as i32),
                        detail: item.clone(),
                    });
                }
            }
        }
        "html" => {
            if let Some(arr) = data.get("candidates").and_then(Value::as_array) {
                for item in arr {
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                    let tier = item.get("tier").and_then(Value::as_str).unwrap_or("");
                    let key = format!("{name}/{tier}");
                    let sev = item
                        .get("saved")
                        .and_then(Value::as_i64)
                        .map(|v| v as i32);
                    // Trim big strings already carried in run.payload.
                    let mut detail = item.clone();
                    if let Some(obj) = detail.as_object_mut() {
                        obj.remove("skeleton");
                        obj.remove("callSite");
                    }
                    out.push(Finding {
                        kind: "component_candidate".into(),
                        key,
                        severity: sev,
                        detail,
                    });
                }
            }
        }
        // Spec: tools/ui-snapshot-audit/audit.js header block "Finding key +
        // severity encoding" + Woz's Woz.md 23:21 canonical sample. The
        // `findings` array is pre-formatted by the JS side: each finding
        // already carries its own `finding_key`, `severity`, and `kind`.
        // The Rust explode is therefore a straight projection — unpack
        // each finding object into a `Finding` row, preserving the JS-
        // side keying so audit.run_diff joins cleanly across runs.
        // Canonical contract recorded in docs/internal/specs/audit-
        // ingest-explode.md.
        "ui-snapshot" => {
            if let Some(arr) = data.get("findings").and_then(Value::as_array) {
                for item in arr {
                    let kind = item
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("atom_style")
                        .to_string();
                    let key = item
                        .get("finding_key")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if key.is_empty() {
                        // Defensive: a finding without a finding_key is
                        // unstable across runs (audit.run_diff joins on
                        // it); skip rather than insert a row that can't
                        // diff. The JS side always emits one, but the
                        // skip guards against a future shape regression.
                        continue;
                    }
                    let severity = item
                        .get("severity")
                        .and_then(Value::as_i64)
                        .map(|v| v as i32);
                    out.push(Finding {
                        kind,
                        key,
                        severity,
                        detail: item.clone(),
                    });
                }
            }
        }
        // Stubs — argv-validated + CHECK-accepted but explode logic
        // pending Woz's per-tool finding_key + severity spec. Per the
        // ACK at Woz.md 23:02, each gets a follow-up commit once the
        // canonical spec lands on the channel. Current behavior: ingest
        // the run row (so audit.run captures the payload + ran_at
        // baseline) but produce zero findings — no audit.finding rows
        // means no spurious diff signals downstream. Logged so a run
        // doesn't silently swallow drift detection.
        //
        //   tab-compare: tools/css-tab-compare-audit/audit.json carries
        //                {pairs: [{a, b, crossPrefix, misnamedShared,
        //                mixed, onlyA, onlyB, shared, inventory}]} — the
        //                drift signals are crossPrefix/misnamedShared/
        //                mixed; current sample data has all three empty
        //                so a stub here is a no-op against today's run.
        //   cross-page:  no audit.json emitted yet per Woz's audit-cadence
        //                doc (97e35aa) + tools/css-cross-page-audit/ inv-
        //                entory. Stub will activate the moment cross-page
        //                gains its emit + Woz spec'd shape lands.
        //   parallel:    emits parallels.json (not audit.json) — needs a
        //                filename override at the `let path = ...` site
        //                AND lives at tools/css-parallel/ (no -audit/
        //                suffix; audit.sh for-loop doesn't iterate it
        //                today). Two coordination items above the
        //                explode itself; defer.
        "tab-compare" | "cross-page" | "parallel" => {
            eprintln!(
                "warning: --tool {tool} explode logic stubbed (await Woz spec); \
                 audit.run row recorded with 0 findings."
            );
        }
        _ => unreachable!("--tool validated upstream"),
    }
    Ok(out)
}
