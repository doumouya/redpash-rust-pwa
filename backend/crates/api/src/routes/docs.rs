//! Doc: docs/internal/code/backend/api/routes/docs.md
//! `/api/docs` — serves the `docs/` markdown tree as a browsable index
//! plus rendered HTML. Public (no auth, no DB).
//!
//!   GET /api/docs          → { items: [{ slug, title, section, order,
//!                                        last_modified }, …] }
//!   GET /api/docs/<slug>   → rendered HTML for one page
//!
//! `slug` is the doc's path under `docs/` without the `.md` extension
//! (e.g. `api/auth`, `frontend/design`). The frontend
//! (`scripts/pages/docs.js`) drives both endpoints.
//!
//! Frontmatter (`title` / `section` / `order` / `last modified date`) is
//! parsed by hand — it's flat `key: value`, no YAML library needed.
//! Markdown → HTML via pulldown-cmark; code blocks render as plain
//! `<pre><code>` (no syntax highlighter — kept lean).

use std::path::Path as FsPath;

use axum::{extract::Path, response::Html, routing::get, Json, Router};
use serde::Serialize;
use serde_json::json;

use crate::error::AppError;
use crate::state::AppState;

// docs/ sits beside frontend/ — same relative base as the ServeDir mounts
// in mod.rs (server runs with the repo's `backend/` as CWD).
const DOCS_DIR: &str = "../docs";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(index))
        .route("/*slug", get(render))
}

#[derive(Serialize)]
struct DocEntry {
    slug: String,
    title: String,
    section: String,
    order: i64,
    last_modified: String,
}

/// GET /api/docs — the full index, sorted with "Start here" first then
/// section name, and by `order` within each section.
async fn index() -> Result<Json<serde_json::Value>, AppError> {
    let base = FsPath::new(DOCS_DIR);
    let mut items: Vec<DocEntry> = Vec::new();
    collect(base, base, &mut items)?;
    items.sort_by(|a, b| {
        let sa = (a.section != "Start here") as u8;
        let sb = (b.section != "Start here") as u8;
        sa.cmp(&sb)
            .then(a.section.cmp(&b.section))
            .then(a.order.cmp(&b.order))
            .then(a.title.cmp(&b.title))
    });
    Ok(Json(json!({ "items": items })))
}

/// GET /api/docs/<slug> — one page rendered to HTML.
async fn render(Path(slug): Path<String>) -> Result<Html<String>, AppError> {
    // Path-traversal guard — slug must stay inside docs/.
    if slug.contains("..") {
        return Err(AppError::bad_request("docs", "invalid slug"));
    }
    let path = FsPath::new(DOCS_DIR).join(format!("{slug}.md"));
    let text = std::fs::read_to_string(&path)
        .map_err(|_| AppError::not_found("not_found", format!("doc {slug}")))?;
    let (_fm, body) = split_frontmatter(&text);

    let mut html = String::new();
    let parser = pulldown_cmark::Parser::new_ext(body, pulldown_cmark::Options::all());
    pulldown_cmark::html::push_html(&mut html, parser);
    Ok(Html(html))
}

/// Recursively gather every `*.md` under `dir` into `out`.
fn collect(base: &FsPath, dir: &FsPath, out: &mut Vec<DocEntry>) -> Result<(), AppError> {
    let rd = std::fs::read_dir(dir)
        .map_err(|e| AppError::internal("docs", format!("read {}: {e}", dir.display())))?;
    for entry in rd {
        let entry = entry.map_err(|e| AppError::internal("docs", e.to_string()))?;
        let path = entry.path();
        if path.is_dir() {
            collect(base, &path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let slug = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/");
            let text = std::fs::read_to_string(&path)
                .map_err(|e| AppError::internal("docs", e.to_string()))?;
            let (fm, _) = split_frontmatter(&text);
            out.push(DocEntry {
                title:         fm_get(&fm, "title").unwrap_or_else(|| slug.clone()),
                section:       fm_get(&fm, "section").unwrap_or_else(|| "Misc".to_string()),
                order:         fm_get(&fm, "order").and_then(|s| s.parse().ok()).unwrap_or(999),
                last_modified: fm_get(&fm, "last modified date").unwrap_or_default(),
                slug,
            });
        }
    }
    Ok(())
}

/// Split a `---`-fenced frontmatter block off the front of `text`.
/// Returns the flat `key: value` pairs and the markdown body.
fn split_frontmatter(text: &str) -> (Vec<(String, String)>, &str) {
    let rest = match text.strip_prefix("---\n") {
        Some(r) => r,
        None => return (Vec::new(), text),
    };
    let Some(end) = rest.find("\n---") else {
        return (Vec::new(), text);
    };
    let mut fm = Vec::new();
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            fm.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    // After the closing `---` line: skip `\n---`, then to the next newline.
    let body = rest[end + 1..].splitn(2, '\n').nth(1).unwrap_or("");
    (fm, body)
}

fn fm_get(fm: &[(String, String)], key: &str) -> Option<String> {
    fm.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty())
}
