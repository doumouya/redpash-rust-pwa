//! Doc: docs/internal/code/backend/api/routes/pagination.md
//! Pagination helpers shared by every `Page<T>`-returning handler.
//!
//! The same two helpers lived in `admin.rs` and `monitoring.rs` as
//! byte-identical copies for the lifetime of the two crates; consolidating
//! here per the 2026-05-24 rust-dedup audit. `pub(super)` so any
//! `routes/*.rs` sibling can `use super::pagination::{paginate, build_page}`
//! without making the helpers part of the api crate's external surface.

use std::time::Instant;

use shared::Page;

pub(super) const DEFAULT_PAGE_SIZE: u32 = 50;
pub(super) const MAX_PAGE_SIZE:     u32 = 500;

/// Convert (page, size) → (zero-based offset, clamped size, clamped page).
/// 1-based `page` over the wire; 0-based offset internally.
pub(super) fn paginate(page: Option<u32>, size: Option<u32>) -> (i64, u32, u32) {
    let size = size.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let page = page.unwrap_or(1).max(1);
    let offset = ((page - 1) as i64) * (size as i64);
    (offset, size, page)
}

/// Wrap a rows slice + counts in the `Page<T>` shape every paginated
/// endpoint returns. `started` is captured at handler-entry; the
/// elapsed-ms field powers the cleaner's footer status indicator.
pub(super) fn build_page<T>(
    rows:      Vec<T>,
    total:     u64,
    all_count: u64,
    page:      u32,
    size:      u32,
    started:   Instant,
) -> Page<T> {
    let pages = if total == 0 {
        0
    } else {
        ((total + size as u64 - 1) / size as u64) as u32
    };
    Page {
        rows,
        total,
        all_count,
        page,
        size,
        pages,
        ms: started.elapsed().as_millis() as u32,
        row_indices: Vec::new(),
    }
}
