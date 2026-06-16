//! `redpash-audit-ingest` — persist a tool's `tools/<tool>-audit/audit.json`
//! into `audit.run` + `audit.finding` (one transaction per tool).
//!
//! Standalone companion to the audit suite, DECOUPLED from the file-based
//! ratchet (`tools/ci.sh` needs no DB). Run it where a DB exists (manually
//! against :5433/redpash_prerelease, or a CI step). The full audit.json is the
//! source of truth in `audit.run.payload`; findings are EXPLODED from it at
//! ingest so the run_diff queries are a plain self-join on (kind, finding_key).
//!
//! `explode` (see its doc) handles two finding shapes per item: the UNIFORM
//! `{file,line,rule,msg}` shape (e.g. rail-create) and the CONTRACT shape that
//! already carries `{kind,finding_key,severity}` (e.g. ui-snapshot / api-doc /
//! fe-framework) — preferring the item's own fields so distinct findings don't
//! collide. A non-array payload (a summary), or a tool that nests findings under
//! a bespoke key, ingests as a COUNT-ONLY run (run + stats, zero findings) — a
//! documented gap pending per-tool adapters.
//!
//! Usage (run from the repo root):
//!     cargo run -p api --bin redpash-audit-ingest -- --tool rail-create
//!     cargo run -p api --bin redpash-audit-ingest -- --tool ui-fork --file /abs/audit.json
//!     cargo run -p api --bin redpash-audit-ingest -- --all      # every tools/*-audit/audit.json

use eyre::{bail, eyre, Result, WrapErr};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::path::{Path, PathBuf};
use std::process::Command;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    // audit.json files live under tools/ (repo root); the .env lives at
    // backend/.env. Try both so the bin works from either CWD.
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("backend/.env");
    let _ = dotenvy::from_filename("../.env");

    let mode = parse_args()?;

    let db_url = std::env::var("DATABASE_URL").wrap_err("DATABASE_URL not set")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .wrap_err("connect Postgres")?;

    let git_sha = git(&["rev-parse", "HEAD"]).ok();
    let git_branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).ok();

    match mode {
        Mode::One { tool, file } => {
            let path =
                file.unwrap_or_else(|| PathBuf::from("tools").join(format!("{tool}-audit")).join("audit.json"));
            ingest_one(&pool, &tool, &path, &git_sha, &git_branch).await?;
        }
        Mode::All => {
            let tools = discover_tools(Path::new("tools"))?;
            if tools.is_empty() {
                println!("no tools/*-audit/audit.json found — nothing to ingest");
            }
            for (tool, path) in tools {
                if let Err(e) = ingest_one(&pool, &tool, &path, &git_sha, &git_branch).await {
                    // One bad tool must not abort the sweep — report and continue.
                    eprintln!("  ! {tool}: {e:#}");
                }
            }
        }
    }
    Ok(())
}

/// One tool's run: parse its audit.json, explode findings, write run + findings
/// in a single transaction, then print a diff vs the previous run for that tool.
async fn ingest_one(
    pool: &PgPool,
    tool: &str,
    path: &Path,
    git_sha: &Option<String>,
    git_branch: &Option<String>,
) -> Result<()> {
    let raw = std::fs::read_to_string(path).wrap_err_with(|| format!("read {}", path.display()))?;
    let data: Value = serde_json::from_str(&raw).wrap_err_with(|| format!("parse {}", path.display()))?;

    let findings = explode(&data);
    // stats = the tool's own summary if present, else a derived {count}. The
    // full payload is the source of truth regardless.
    let stats = data.get("stats").cloned().unwrap_or_else(|| json!({ "count": findings.len() }));

    let mut tx = pool.begin().await?;
    let run_id: i64 = sqlx::query_scalar(
        "INSERT INTO audit.run (tool, git_sha, git_branch, stats, payload)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(tool)
    .bind(git_sha)
    .bind(git_branch)
    .bind(&stats)
    .bind(&data)
    .fetch_one(&mut *tx)
    .await
    .wrap_err("insert audit.run")?;

    for f in &findings {
        // ON CONFLICT guards two findings colliding on a key within one payload.
        sqlx::query(
            "INSERT INTO audit.finding (run_id, tool, kind, finding_key, severity, detail)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id, finding_key) DO NOTHING",
        )
        .bind(run_id)
        .bind(tool)
        .bind(&f.kind)
        .bind(&f.key)
        .bind(f.severity)
        .bind(&f.detail)
        .execute(&mut *tx)
        .await
        .wrap_err("insert audit.finding")?;
    }
    tx.commit().await?;

    println!(
        "audit.run #{run_id}  tool={tool}  branch={}  sha={}  findings={}",
        git_branch.as_deref().unwrap_or("?"),
        git_sha.as_deref().map(|s| &s[..s.len().min(7)]).unwrap_or("?"),
        findings.len(),
    );
    print_diff_summary(pool, tool, run_id).await
}

struct Finding {
    kind: String,
    key: String,
    severity: Option<i32>,
    detail: Value,
}

/// Explode an audit payload's finding array into `audit.finding` rows. The
/// array is the top-level value or a `findings` key. Two finding shapes are
/// handled, per item:
///   1. CONTRACT shape — the item already carries `{kind, finding_key, severity}`
///      (e.g. ui-snapshot / fe-framework / api-doc audits): use them verbatim so
///      distinct findings don't collide and the tool's own severity/kind survive.
///   2. UNIFORM shape — `{file, line, rule, msg}` (e.g. rail-create): synthesize
///      kind = rule, finding_key = `rule|file:line`, severity = NULL.
/// A finding may mix the two (own `kind` but synthesized key, etc.); each field
/// independently prefers the item's own value, else falls back.
///
/// LIMITATION (documented, follow-up): tools that carry findings under a BESPOKE
/// key (auth-audit `leaks`/`auditGaps`, css-audit `selectorConflicts`, …) have no
/// top-level/`findings` array, so they ingest as COUNT-ONLY runs (run + stats,
/// zero findings) until a per-tool key adapter or an audit-side normalizer lands.
fn explode(data: &Value) -> Vec<Finding> {
    let arr = data
        .as_array()
        .or_else(|| data.get("findings").and_then(Value::as_array));
    let Some(arr) = arr else { return Vec::new() };

    arr.iter()
        .map(|item| {
            // kind: the item's own `kind`, else its `rule`, else a generic label.
            let kind = item
                .get("kind")
                .and_then(Value::as_str)
                .or_else(|| item.get("rule").and_then(Value::as_str))
                .unwrap_or("finding")
                .to_string();
            // severity: the item's own (integer) severity if it has one — lean's
            // uniform findings carry none, so this is NULL for those.
            let severity = item.get("severity").and_then(Value::as_i64).map(|v| v as i32);
            // finding_key: the item's own stable key, else synthesize from
            // rule|file:line (the uniform shape). Preferring the item's key is
            // what stops distinct findings collapsing under `ON CONFLICT`.
            let key = item
                .get("finding_key")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let rule = item.get("rule").and_then(Value::as_str).unwrap_or(kind.as_str());
                    let file = item.get("file").and_then(Value::as_str).unwrap_or("?");
                    let line = match item.get("line") {
                        Some(Value::Number(n)) => n.to_string(),
                        Some(Value::String(s)) => s.clone(),
                        _ => "?".to_string(),
                    };
                    format!("{rule}|{file}:{line}")
                });
            Finding { kind, key, severity, detail: item.clone() }
        })
        .collect()
}

/// "Since last run": diff vs the most recent earlier run for the same tool.
async fn print_diff_summary(pool: &PgPool, tool: &str, run_id: i64) -> Result<()> {
    let prev_id: Option<i64> =
        sqlx::query_scalar("SELECT id FROM audit.run WHERE tool = $1 AND id < $2 ORDER BY id DESC LIMIT 1")
            .bind(tool)
            .bind(run_id)
            .fetch_optional(pool)
            .await
            .wrap_err("lookup prev run")?;

    let Some(prev) = prev_id else {
        println!("  (no prior {tool} run — baseline established)");
        return Ok(());
    };

    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, COUNT(*)::bigint FROM audit.run_diff($1, $2)
          WHERE status <> 'unchanged' GROUP BY status",
    )
    .bind(run_id)
    .bind(prev)
    .fetch_all(pool)
    .await
    .wrap_err("run_diff query")?;

    let n = |k: &str| counts.iter().find(|(s, _)| s == k).map(|(_, c)| *c).unwrap_or(0);
    let (new_, fixed, regr, impr) = (n("new"), n("fixed"), n("regressed"), n("improved"));
    if new_ + fixed + regr + impr == 0 {
        println!("  vs audit.run #{prev}: no change");
    } else {
        println!("  vs audit.run #{prev}: {new_} new · {fixed} fixed · {regr} regressed · {impr} improved");
    }
    Ok(())
}

enum Mode {
    One { tool: String, file: Option<PathBuf> },
    All,
}

fn parse_args() -> Result<Mode> {
    let mut args = std::env::args().skip(1);
    let mut tool: Option<String> = None;
    let mut file: Option<PathBuf> = None;
    let mut all = false;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--tool" => tool = args.next(),
            "--file" => file = args.next().map(PathBuf::from),
            "--all" => all = true,
            "-h" | "--help" => {
                println!("usage: redpash-audit-ingest (--tool <TOOL> [--file <path>] | --all)");
                println!("  --tool <name>   ingest tools/<name>-audit/audit.json");
                println!("  --all           ingest every tools/*-audit/audit.json found");
                std::process::exit(0);
            }
            _ => bail!("unknown arg {a}"),
        }
    }
    if all {
        return Ok(Mode::All);
    }
    let tool = tool.ok_or_else(|| eyre!("missing --tool <name> (or --all)"))?;
    Ok(Mode::One { tool, file })
}

/// Walk `tools/*-audit/` and return (tool, audit.json path) for each dir that
/// has an audit.json. The discovery loop is lean's replacement for prerelease's
/// closed `tool IN (...)` CHECK — the suite grows without a migration.
fn discover_tools(tools_dir: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let rd = std::fs::read_dir(tools_dir).wrap_err_with(|| format!("read_dir {}", tools_dir.display()))?;
    for entry in rd {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(tool) = name.strip_suffix("-audit") else { continue };
        let json = entry.path().join("audit.json");
        if json.is_file() {
            out.push((tool.to_string(), json));
        }
    }
    out.sort();
    Ok(out)
}

fn git(args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).output()?;
    if !out.status.success() {
        bail!("git {:?} failed", args);
    }
    Ok(String::from_utf8(out.stdout)?.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::explode;
    use serde_json::json;

    #[test]
    fn explodes_uniform_findings() {
        // the lean shape: a top-level array of {file,line,rule,msg}.
        let data = json!([
            { "file": "frontend/apps/x/y.js", "line": 42, "rule": "RC1", "msg": "bad" },
            { "file": "z.css", "line": "7", "rule": "R4", "msg": "dup" }
        ]);
        let fs = explode(&data);
        assert_eq!(fs.len(), 2);
        // kind = rule; finding_key = rule|file:line; severity stays NULL.
        assert_eq!(fs[0].kind, "RC1");
        assert_eq!(fs[0].key, "RC1|frontend/apps/x/y.js:42");
        assert!(fs[0].severity.is_none());
        // line given as a string round-trips into the key the same way.
        assert_eq!(fs[1].key, "R4|z.css:7");
    }

    #[test]
    fn findings_under_a_key_also_explode() {
        let data = json!({ "stats": { "count": 1 }, "findings": [
            { "file": "a", "line": 1, "rule": "X", "msg": "m" }
        ]});
        assert_eq!(explode(&data).len(), 1);
    }

    #[test]
    fn prefers_the_items_own_contract_fields() {
        // a finding that already speaks {kind, finding_key, severity} keeps them
        // verbatim — two findings with the SAME file:line but distinct keys must
        // NOT collapse (the ON CONFLICT drop the old synthesis caused).
        let data = json!([
            { "kind": "undocumented_endpoint", "finding_key": "GET /api/cases", "severity": 2, "file": "cases.rs", "line": 40 },
            { "kind": "undocumented_endpoint", "finding_key": "POST /api/cases", "severity": 3, "file": "cases.rs", "line": 40 }
        ]);
        let fs = explode(&data);
        assert_eq!(fs.len(), 2);
        assert_eq!(fs[0].kind, "undocumented_endpoint");
        assert_eq!(fs[0].key, "GET /api/cases");
        assert_eq!(fs[0].severity, Some(2));
        assert_ne!(fs[0].key, fs[1].key, "distinct keys survive — no collision");
    }

    #[test]
    fn non_array_payload_is_count_only() {
        // a summary / count-only audit (no array) → zero findings.
        assert!(explode(&json!({ "summary": "all clean", "count": 0 })).is_empty());
        assert!(explode(&json!("nope")).is_empty());
    }

    #[test]
    fn missing_fields_fall_back() {
        let fs = explode(&json!([{ "msg": "no file/line/rule" }]));
        assert_eq!(fs[0].kind, "finding");
        assert_eq!(fs[0].key, "finding|?:?");
    }
}
