//! Live MySQL connector-pull conduit test. The pull connects to the local MySQL
//! test SOURCE (redpash/redpash, the `employees` sample DB) and asserts a faithful
//! CSV comes back — proving the server-side half of the connector: source table →
//! type-aware CSV bytes, returned (NOT persisted; the client's GlueSQL ingests them).
//!
//! Skips cleanly when MySQL is unreachable (CI has no MySQL source). A pull error
//! that is NOT a connect failure is a real bug and FAILS the test — so the skip can
//! never mask broken extraction logic.

use api::mysql_loader::{pull, Cfg};
use serde_json::json;

#[tokio::test]
async fn pull_employees_departments_to_csv() {
    // Loopback source → host_gate admits it (PREFERRED); discrete components, no URL.
    let cfg = Cfg::from_config(&json!({
        "host": "127.0.0.1", "port": 3306,
        "user": "redpash", "password": "redpash",
        "database": "employees", "table": "departments"
    }))
    .expect("cfg builds — loopback passes host_gate");

    let bytes = match pull(&cfg).await {
        Ok(b) => b,
        Err(e) if e.message.starts_with("connect to MySQL source") => {
            eprintln!("mysql_pull: MySQL source unreachable — skipped ({})", e.message);
            return;
        }
        Err(e) => panic!("pull failed (not a connect error — real bug): {}", e.message),
    };

    let csv = String::from_utf8(bytes).expect("CSV is valid UTF-8");
    let lines: Vec<&str> = csv.lines().collect();
    assert_eq!(lines[0], "dept_no,dept_name", "header = source columns in ordinal order");
    assert_eq!(lines.len(), 1 + 9, "header + 9 departments (the employees sample)");
    assert!(csv.contains("Development"), "real row content present (d005 = Development)");
}

/// SSRF: the loader must refuse a remote host that won't encrypt — even if the rest
/// of the config is well-formed. No network needed (host_gate rejects before connect).
#[tokio::test]
async fn rejects_plaintext_remote_source() {
    let built = Cfg::from_config(&json!({
        "host": "db.example.com", "port": 3306,
        "user": "x", "password": "y", "database": "d", "table": "t",
        "ssl_mode": "disabled"
    }));
    assert!(built.is_err(), "a remote host with ssl_mode=disabled must be refused");
}

/// SSRF: a pre-built `conn` URL is rejected — connect options are built from discrete
/// components only, so userinfo/host can't be smuggled past the gate.
#[tokio::test]
async fn rejects_prebuilt_conn_url() {
    let built = Cfg::from_config(&json!({
        "conn": "mysql://evil@169.254.169.254/x",
        "database": "d", "table": "t"
    }));
    assert!(built.is_err(), "a pre-built conn URL must be refused");
}
