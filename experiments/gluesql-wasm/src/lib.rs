use wasm_bindgen::prelude::*;
use gluesql::prelude::{Glue, MemoryStorage};
use futures::FutureExt; // now_or_never — memory-storage futures are ready immediately

// Forces the gluesql parser + planner + executor + memory storage to LINK, so
// the wasm size reflects the real engine (not a dead-code-eliminated shell).
#[wasm_bindgen]
pub fn run_sql(sql: &str) -> String {
    let mut glue = Glue::new(MemoryStorage::default());
    match glue.execute(sql).now_or_never() {
        Some(Ok(p)) => format!("{p:?}"),
        Some(Err(e)) => format!("err: {e}"),
        None => "pending".into(),
    }
}
