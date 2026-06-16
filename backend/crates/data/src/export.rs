//! Doc: docs/internal/code/backend/data/export.md
//! Export — render a cleaned `DataFrame` to downloadable bytes.
//!
//! Three formats, one signature each (`&DataFrame -> Vec<u8>`), so the
//! `api` export handler can pick a renderer by `?format=`:
//!   - `to_csv`  — comma-separated, header row, UTF-8.
//!   - `to_xlsx` — a single-sheet Excel 2007 workbook (rust_xlsxwriter).
//!   - `to_json` — a pretty-printed array of row objects.
//!
//! Cell typing is preserved where it survived the CSV pipeline: numeric
//! columns export as numbers, booleans as booleans, everything else as
//! text. Nulls become blank cells / JSON `null`. Dates and other types
//! with no native cell form fall back to their text representation.
//!
//! SERVER-ONLY: `rust_xlsxwriter` does not build on wasm32, so this module
//! is gated behind `#[cfg(not(target_arch = "wasm32"))]` in `lib.rs`.

use polars::prelude::*;
use rust_xlsxwriter::{Format, Workbook, Worksheet};

use crate::{DataError, Result};

impl From<rust_xlsxwriter::XlsxError> for DataError {
    fn from(e: rust_xlsxwriter::XlsxError) -> Self {
        // Target has no Export variant — map to Internal.
        DataError::Internal(e.to_string())
    }
}

/// CSV — comma-separated, header row included.
pub fn to_csv(df: &DataFrame) -> Result<Vec<u8>> {
    let mut frame = df.clone();
    let mut buf: Vec<u8> = Vec::new();
    CsvWriter::new(&mut buf)
        .include_header(true)
        .finish(&mut frame)?;
    Ok(buf)
}

/// XLSX — one worksheet, a bold header row, one row per record.
pub fn to_xlsx(df: &DataFrame) -> Result<Vec<u8>> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();

    let header = Format::new().set_bold();
    for (col, name) in df.get_column_names().iter().enumerate() {
        sheet.write_with_format(0, col as u16, name.as_str(), &header)?;
    }

    let columns = df.columns();
    for row in 0..df.height() {
        for (col, series) in columns.iter().enumerate() {
            write_cell(sheet, (row + 1) as u32, col as u16, &series.get(row)?)?;
        }
    }
    Ok(workbook.save_to_buffer()?)
}

/// Write one `AnyValue` into a worksheet cell, keeping its native type.
fn write_cell(sheet: &mut Worksheet, row: u32, col: u16, value: &AnyValue) -> Result<()> {
    match value {
        AnyValue::Null => {} // leave the cell blank
        AnyValue::Boolean(b) => {
            sheet.write_boolean(row, col, *b)?;
        }
        other => {
            if let Some(text) = other.get_str() {
                sheet.write_string(row, col, text)?;
            } else if let Ok(number) = other.try_extract::<f64>() {
                sheet.write_number(row, col, number)?;
            } else {
                // Dates, times, nested types — no native cell form.
                sheet.write_string(row, col, other.to_string().as_str())?;
            }
        }
    }
    Ok(())
}

/// JSON — a pretty-printed array, one object per row.
pub fn to_json(df: &DataFrame) -> Result<Vec<u8>> {
    let names: Vec<String> = df
        .get_column_names()
        .iter()
        .map(|name| name.to_string())
        .collect();
    let columns = df.columns();

    let mut rows = Vec::with_capacity(df.height());
    for row in 0..df.height() {
        let mut object = serde_json::Map::with_capacity(names.len());
        for (col, series) in columns.iter().enumerate() {
            object.insert(names[col].clone(), any_value_to_json(&series.get(row)?));
        }
        rows.push(serde_json::Value::Object(object));
    }

    serde_json::to_vec_pretty(&serde_json::Value::Array(rows))
        // Target has no Export variant — map serialization failure to Internal.
        .map_err(|e| DataError::Internal(e.to_string()))
}

/// `AnyValue` → `serde_json::Value`, mirroring `write_cell`'s typing.
fn any_value_to_json(value: &AnyValue) -> serde_json::Value {
    use serde_json::Value;
    match value {
        AnyValue::Null => Value::Null,
        AnyValue::Boolean(b) => Value::Bool(*b),
        other => {
            if let Some(text) = other.get_str() {
                Value::String(text.to_string())
            } else if let Ok(int) = other.try_extract::<i64>() {
                Value::Number(int.into())
            } else if let Ok(float) = other.try_extract::<f64>() {
                serde_json::Number::from_f64(float).map_or(Value::Null, Value::Number)
            } else {
                Value::String(other.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame with one string, one integer and one boolean column —
    /// exercises every branch of `write_cell` / `any_value_to_json`.
    fn sample() -> DataFrame {
        df![
            "name"   => ["Alice", "Bob", "Carol"],
            "score"  => [91_i64, 88, 77],
            "active" => [true, false, true],
        ]
        .unwrap()
    }

    #[test]
    fn xlsx_is_a_valid_zip_container() {
        let bytes = to_xlsx(&sample()).unwrap();
        // An .xlsx file is a Zip archive — it must open with the PK
        // local-file-header signature.
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        assert!(bytes.len() > 200, "xlsx body suspiciously small");
    }

    #[test]
    fn json_is_an_array_of_typed_row_objects() {
        let bytes = to_json(&sample()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let rows = value.as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["name"], "Alice");
        assert_eq!(rows[0]["score"], 91); // number, not "91"
        assert_eq!(rows[0]["active"], true); // bool, not "true"
    }

    #[test]
    fn csv_has_a_header_and_one_line_per_row() {
        let text = String::from_utf8(to_csv(&sample()).unwrap()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4); // header + 3 rows
        assert_eq!(lines[0], "name,score,active");
        assert!(lines[1].starts_with("Alice,91,"));
    }
}
