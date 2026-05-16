//! Byte-buffer → encoding name.
//!
//! Uses Mozilla's `chardetng` detector — same algorithm Firefox ships.
//! Returns the IANA name (`utf-8`, `windows-1252`, `iso-8859-1`,
//! `utf-16le`, …) so the result feeds directly into `encoding_rs`.

use chardetng::EncodingDetector;

/// Sniff the encoding of a byte buffer. `tld` is an optional 2-letter
/// language hint (e.g. `"fr"` for French CSVs) — `chardetng` uses it to
/// disambiguate windows-1252 vs other single-byte codecs.
pub fn detect(bytes: &[u8], tld: Option<&str>) -> String {
    // BOMs first — definitive.
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { return "utf-8".into(); }
    if bytes.starts_with(&[0xFF, 0xFE])       { return "utf-16le".into(); }
    if bytes.starts_with(&[0xFE, 0xFF])       { return "utf-16be".into(); }

    let mut det = EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(tld.and_then(|s| s.as_bytes().get(0..2)).and_then(|_| None), true);
    enc.name().to_ascii_lowercase()
}

/// Convenience: detect + decode in one call. Returns the decoded text
/// AND the encoding name that was actually used.
pub fn decode(bytes: &[u8], tld: Option<&str>) -> (String, String) {
    let enc_name = detect(bytes, tld);
    let enc = encoding_rs::Encoding::for_label(enc_name.as_bytes())
        .unwrap_or(encoding_rs::UTF_8);
    let (cow, _, _) = enc.decode(bytes);
    (cow.into_owned(), enc_name)
}
