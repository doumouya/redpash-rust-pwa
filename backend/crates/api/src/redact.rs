//! Redaction discipline for events.context — the single point where
//! potentially-sensitive payloads from Channel A (rich tracing log
//! stream) get sanitized before mirroring into Channel B (events
//! table) for the Monitoring page consumer.
//!
//! Two rules, evolving:
//!   1. Length cap. The events table is a queryable index, not a
//!      blob store. Capping every redacted string at `MAX_CHARS`
//!      keeps the Monitoring drill-down responsive and the table
//!      from bloating with multi-KB JSON payloads.
//!   2. Substring masking. Known-sensitive field names get their
//!      values replaced with `[REDACTED]`. The list is empty today
//!      (pre-RBAC; no password / token columns exist yet) and
//!      grows as we add auth-bearing surfaces. Each addition lands
//!      with a test against a sample chain string.
//!
//! Pre-market: the redactor is the discipline scaffold — the cap +
//! masking shape are encoded NOW so the audit catalog can verify
//! every events.context write goes through it (slice E). The
//! known-sensitive list crystallizes as we add the surfaces that
//! need it; the structure is ready for that growth.

/// Hard cap on any single redacted string written into events.context.
/// 2KB is roughly: the full source chain for a sqlx::Error (PgError
/// + connection details + 3-deep wrap) ≈ 400-800 chars; an eyre
/// backtrace head of 20 frames ≈ 1000-1500 chars. Anything longer is
/// the deep-dive consumer's job (Channel A's JSON stream), not the
/// at-a-glance Monitoring redtable view.
pub const MAX_CHARS: usize = 2048;

/// Field names whose VALUES must be masked when they appear in a
/// chain or backtrace string. Empty today — the list grows when an
/// auth surface lands (password_hash, session_token, …). Each
/// addition is a one-line append + a test.
const SENSITIVE_KEYS: &[&str] = &[
    // intentionally empty pre-RBAC
];

/// Sanitize a free-form chain / payload string for events.context.
/// Applies the length cap + sensitive-key masking. Idempotent — re-
/// running on already-redacted input is a no-op.
pub fn redact_chain(s: &str) -> String {
    let mut out = s.to_string();
    for key in SENSITIVE_KEYS {
        // Match `key=<value>` or `key: <value>` shapes. The value
        // runs until the next whitespace / comma / brace / EOL.
        out = mask_key_value(&out, key);
    }
    if out.chars().count() > MAX_CHARS {
        // Trim by char count, not byte, to avoid splitting multibyte
        // sequences. The truncation suffix tells the operator the
        // full payload lives in Channel A.
        let truncated: String = out.chars().take(MAX_CHARS).collect();
        out = format!("{truncated}… [TRUNCATED — full chain in Channel A]");
    }
    out
}

/// Capture the first `max_frames` frames of a backtrace string. The
/// panic hook calls this before writing to events.context.backtrace_head
/// so the Monitoring page's panic pane has the top-of-stack at-a-glance.
/// The full backtrace stays in Channel A's `panic.backtrace` field.
pub fn backtrace_head(bt: &str, max_frames: usize) -> String {
    // Backtrace lines come as numbered frames: "  0: <fn> at <file>:<line>".
    // Take the first `max_frames` frames; everything after is dropped.
    let mut frames_kept = 0usize;
    let mut out = String::new();
    for line in bt.lines() {
        // Frame headers start with whitespace + a number + ':'. Body
        // lines (the `at <file>` continuation) belong to the previous
        // frame and aren't counted separately.
        let trimmed = line.trim_start();
        let is_frame_header = trimmed
            .find(':')
            .and_then(|i| trimmed[..i].parse::<usize>().ok())
            .is_some();
        if is_frame_header {
            if frames_kept >= max_frames { break; }
            frames_kept += 1;
        }
        out.push_str(line);
        out.push('\n');
    }
    // Always apply the chain redactor at the end — keeps the length
    // cap + masking discipline uniform across both helpers.
    redact_chain(out.trim_end())
}

/// Replace `<key>=…` or `<key>: …` values up to the next delimiter.
/// Case-sensitive on the key; values become `[REDACTED]`.
fn mask_key_value(input: &str, key: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let lower_input = input.to_ascii_lowercase();
    let lower_key   = key.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(rel) = lower_input[cursor..].find(&lower_key) {
        let abs = cursor + rel;
        // Push everything up to the key.
        out.push_str(&input[cursor..abs]);
        // Push the key itself (preserve original case in output).
        out.push_str(&input[abs..abs + key.len()]);
        cursor = abs + key.len();
        // Skip the `=` or `:` separator (with optional whitespace).
        let after_key = &input[cursor..];
        let mut chars = after_key.char_indices().peekable();
        if let Some((_, c)) = chars.peek().copied() {
            if c == '=' || c == ':' {
                out.push(c);
                cursor += c.len_utf8();
                // Skip whitespace.
                while let Some(c) = input[cursor..].chars().next() {
                    if c.is_whitespace() { out.push(c); cursor += c.len_utf8(); }
                    else { break; }
                }
                // Find the value's end delimiter.
                let end = input[cursor..].find(|c: char| {
                    c == ',' || c == '}' || c == ')' || c == ']'
                        || c == '\n' || c == '"' || c == '\''
                }).unwrap_or(input.len() - cursor);
                if end > 0 {
                    out.push_str("[REDACTED]");
                    cursor += end;
                }
            }
        }
    }
    out.push_str(&input[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_cap_passes_through() {
        let s = "sqlx::Error: connection lost";
        assert_eq!(redact_chain(s), s);
    }

    #[test]
    fn over_cap_is_truncated_with_suffix() {
        let s = "x".repeat(MAX_CHARS + 100);
        let out = redact_chain(&s);
        assert!(out.ends_with("[TRUNCATED — full chain in Channel A]"));
        assert!(out.chars().count() > MAX_CHARS);
        assert!(out.chars().count() < MAX_CHARS + 60);
    }

    #[test]
    fn backtrace_head_caps_frames() {
        let bt = (0..50)
            .map(|i| format!("  {i}: redpash::frame at file.rs:{}", 10 + i))
            .collect::<Vec<_>>()
            .join("\n");
        let head = backtrace_head(&bt, 5);
        // 5 frames kept; frame 5+ dropped.
        assert!(head.contains("0: redpash"));
        assert!(head.contains("4: redpash"));
        assert!(!head.contains("5: redpash"));
    }

    #[test]
    fn empty_sensitive_list_is_idempotent() {
        let s = "password_hash=secret123 message=ok";
        // No keys in SENSITIVE_KEYS today → string unchanged.
        assert_eq!(redact_chain(s), s);
    }
}
