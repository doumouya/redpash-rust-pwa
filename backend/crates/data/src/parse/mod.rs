//! Purpose: the parse entry points — bytes → DataFrame, decode + sniff + read.

mod sniff;

pub use sniff::{parse_text_with_diag, RescueDiag};

use polars::prelude::DataFrame;

use crate::{encoding, Result};

/// Decode (chardetng + the now-working TLD hint) then sniff + parse. The
/// single front door for an uploaded byte buffer.
pub fn from_csv_bytes(bytes: &[u8], tld: Option<&str>) -> Result<(DataFrame, RescueDiag, String)> {
    let (text, enc_name) = encoding::decode(bytes, tld);
    let (df, diag) = parse_text_with_diag(text)?;
    Ok((df, diag, enc_name))
}

/// Decode with a user-chosen codec (the cleaner sidebar override), then parse.
pub fn from_csv_bytes_with_encoding(bytes: &[u8], enc_name: &str) -> Result<(DataFrame, RescueDiag, String)> {
    let (text, used) = encoding::decode_as(bytes, enc_name);
    let (df, diag) = parse_text_with_diag(text)?;
    Ok((df, diag, used))
}

/// Parse already-decoded text (tests, replay).
pub fn from_text(text: impl Into<String>) -> Result<DataFrame> {
    Ok(parse_text_with_diag(text.into())?.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_bytes_round_trip() {
        let (df, diag, enc) = from_csv_bytes(b"id,name\n1,Alice\n2,Bob\n", None).unwrap();
        assert_eq!(df.shape(), (2, 2));
        assert_eq!(diag, RescueDiag::NotAttempted);
        assert_eq!(enc, "utf-8");
    }

    #[test]
    fn _unused_height_marker() {
        // keep DataFrame import meaningful for readers
        let _: Option<DataFrame> = None;
    }
}
