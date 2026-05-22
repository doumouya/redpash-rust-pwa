//! `redpash-audit-ingest` — persist one tools/<tool>-audit/audit-bro.json
//! run into audit.run + audit.finding.
//!
//! Standalone companion to the audit scripts. Each `audit-bro.js` writes
//! its full `data` object as `audit-bro.json` next to the .html report;
//! this binary reads that JSON, captures git context, and writes one
//! `audit.run` row + one `audit.finding` row per individual finding in a
//! single transaction.
//!
//! Schema: `backend/migrations/20260528000001_audit_storage.sql`.
//! Design: `tools/audit-storage-brainstorming.md`.
//!
//! Usage:
//!     redpash-audit-ingest --tool css
//!     redpash-audit-ingest --tool html --file /abs/path/audit-bro.json
//!
//! Default file path: `tools/<tool>-audit/audit-bro.json`, resolved
//! relative to the current working directory. Run from the repo root.

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
            .join("audit-bro.json")
    });

    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?;
    let data: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parse {}", path.display()))?;

    let stats = data.get("stats").cloned().unwrap_or(Value::Null);
    if stats.is_null() {
        bail!("audit-bro.json missing top-level `stats`");
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
                println!("usage: redpash-audit-ingest --tool <css|html> [--file <path>]");
                std::process::exit(0);
            }
            _ => bail!("unknown arg {a}"),
        }
    }
    let tool = tool.ok_or_else(|| anyhow!("missing --tool <css|html>"))?;
    // The audit.run CHECK constraint allows only these two; keep the binary
    // honest about it so a typo fails fast instead of hitting the DB error.
    if tool != "css" && tool != "html" {
        bail!("--tool must be 'css' or 'html' (audit.run schema constraint)");
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
        _ => unreachable!("--tool validated upstream"),
    }
    Ok(out)
}
