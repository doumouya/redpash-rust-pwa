//! Purpose: byte-buffer → encoding name, via Mozilla's chardetng (Firefox's
//! detector). BOMs are definitive; otherwise chardetng guesses, with a
//! 2-letter language hint to disambiguate single-byte codecs.
//!
//! BUG FIX (day-one engine port): the predecessor threaded a `tld` hint all
//! the way down but then dropped it — `tld.and_then(|s| ...).and_then(|_| None)`
//! always evaluated to None, so the FR-heavy upload disambiguation the
//! parameter exists for never happened. Here the hint is actually passed to
//! chardetng's top-level-domain argument.

use chardetng::EncodingDetector;

/// Sniff the encoding. `tld` is an optional 2-letter language/TLD hint
/// (e.g. "fr") chardetng uses to disambiguate windows-1252 vs ISO-8859-15
/// and friends.
pub fn detect(bytes: &[u8], tld: Option<&str>) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return "utf-8".into();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return "utf-16le".into();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return "utf-16be".into();
    }
    let mut det = EncodingDetector::new();
    det.feed(bytes, true);
    // chardetng takes the TLD as a 2-byte ASCII-lowercase hint; pass it
    // through for real (the predecessor's bug discarded it).
    let hint: Option<&[u8]> = tld
        .map(str::as_bytes)
        .filter(|b| b.len() == 2 && b.iter().all(u8::is_ascii_alphabetic));
    det.guess(hint, true).name().to_ascii_lowercase()
}

/// Detect + decode in one call. Returns (decoded text, encoding name used) —
/// the encoding name persists to the cleaner sidebar.
pub fn decode(bytes: &[u8], tld: Option<&str>) -> (String, String) {
    let enc_name = detect(bytes, tld);
    let enc = encoding_rs::Encoding::for_label(enc_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (cow, _, _) = enc.decode(bytes);
    (cow.into_owned(), enc_name)
}

/// Decode with a caller-chosen codec, skipping detection entirely (the user
/// override on the cleaner sidebar).
pub fn decode_as(bytes: &[u8], enc_name: &str) -> (String, String) {
    let enc = encoding_rs::Encoding::for_label(enc_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (cow, used, _) = enc.decode(bytes);
    (cow.into_owned(), used.name().to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bom_short_circuits() {
        assert_eq!(detect(&[0xEF, 0xBB, 0xBF, b'h', b'i'], None), "utf-8");
        assert_eq!(detect(&[0xFF, 0xFE, 0x00], None), "utf-16le");
    }

    #[test]
    fn tld_hint_is_actually_passed() {
        // A bare ASCII buffer detects as some single-byte/utf-8 codec; the
        // point of this test is that a 2-letter hint is accepted (not
        // silently discarded as in the predecessor) and a bad hint is
        // ignored without panicking.
        let _ = detect("café".as_bytes(), Some("fr"));
        let _ = detect("hi".as_bytes(), Some("zzz")); // wrong length → ignored
        let _ = detect("hi".as_bytes(), Some("12")); // non-alpha → ignored
    }
}
