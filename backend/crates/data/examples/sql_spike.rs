//! Purpose: coverage-regression harness for Polars SQL — probes what
//! `SQLContext` runs across the analytical query surface (projection, WHERE,
//! JOIN, GROUP BY/HAVING, set-ops, windows, CTE, subqueries) and prints a
//! PASS/FAIL matrix. Re-run after a Polars upgrade to see what newly passes.
//! Doc: docs/internal/code/backend/data/examples/sql_spike.md
//!
//! Run: `cargo +stable run -p data --example sql_spike`. The results of record
//! (and the rewrite paths for the gaps) live in
//! docs/internal/specs/sql-redtable/phase-0-coverage.md.

use polars::prelude::*;
use polars::sql::SQLContext;

fn sample() -> (DataFrame, DataFrame) {
    let orders = df![
        "id"     => [1i64, 2, 3, 4, 5],
        "cust"   => [10i64, 10, 20, 30, 20],
        "amt"    => [100.0f64, 50.0, 200.0, 75.0, 25.0],
        "status" => ["paid", "pending", "paid", "paid", "pending"],
    ].unwrap();
    let customers = df![
        "cust" => [10i64, 20, 30],
        "name" => ["Acme", "Globex", "Initech"],
    ].unwrap();
    (orders, customers)
}

fn main() {
    let (orders, customers) = sample();

    // One probe = one named SQL feature + the query exercising it.
    let probes: Vec<(&str, &str)> = vec![
        ("projection (SELECT cols)",        "SELECT id, amt FROM orders"),
        ("aliased expr",                    "SELECT amt * 1.1 AS amt_tax FROM orders"),
        ("WHERE",                           "SELECT * FROM orders WHERE amt > 60 AND status = 'paid'"),
        ("ORDER BY",                        "SELECT * FROM orders ORDER BY amt DESC"),
        ("DISTINCT",                        "SELECT DISTINCT status FROM orders"),
        ("LIMIT/OFFSET",                    "SELECT * FROM orders ORDER BY id LIMIT 2 OFFSET 1"),
        ("GROUP BY + aggregates",           "SELECT status, COUNT(*) n, SUM(amt) s, AVG(amt) a FROM orders GROUP BY status"),
        ("GROUP BY + HAVING",               "SELECT cust, SUM(amt) s FROM orders GROUP BY cust HAVING SUM(amt) > 100"),
        ("INNER JOIN (multi-table)",        "SELECT o.id, c.name, o.amt FROM orders o JOIN customers c ON o.cust = c.cust"),
        ("LEFT JOIN",                       "SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON o.cust = c.cust"),
        ("CASE expression",                 "SELECT id, CASE WHEN amt >= 100 THEN 'big' ELSE 'small' END AS bucket FROM orders"),
        ("subquery (IN)",                   "SELECT * FROM orders WHERE cust IN (SELECT cust FROM customers WHERE name = 'Acme')"),
        ("subquery (FROM derived)",         "SELECT bucket, COUNT(*) n FROM (SELECT CASE WHEN amt >= 100 THEN 'big' ELSE 'small' END AS bucket FROM orders) t GROUP BY bucket"),
        ("CTE (WITH)",                      "WITH paid AS (SELECT * FROM orders WHERE status = 'paid') SELECT cust, SUM(amt) s FROM paid GROUP BY cust"),
        ("UNION ALL",                       "SELECT id FROM orders WHERE amt > 100 UNION ALL SELECT id FROM orders WHERE status = 'pending'"),
        ("UNION (distinct)",                "SELECT cust FROM orders UNION SELECT cust FROM customers"),
        ("INTERSECT",                       "SELECT cust FROM orders INTERSECT SELECT cust FROM customers"),
        ("EXCEPT",                          "SELECT cust FROM customers EXCEPT SELECT cust FROM orders"),
        ("window ROW_NUMBER OVER",          "SELECT id, ROW_NUMBER() OVER (PARTITION BY cust ORDER BY amt DESC) rn FROM orders"),
        ("window RANK OVER",                "SELECT id, RANK() OVER (ORDER BY amt DESC) rk FROM orders"),
        ("window LAG/LEAD",                 "SELECT id, LAG(amt) OVER (ORDER BY id) prev, LEAD(amt) OVER (ORDER BY id) next FROM orders"),
        ("window running SUM",              "SELECT id, SUM(amt) OVER (ORDER BY id) running FROM orders"),
        ("window NTILE",                    "SELECT id, NTILE(2) OVER (ORDER BY amt) tile FROM orders"),
        ("GROUP BY ROLLUP",                 "SELECT status, SUM(amt) s FROM orders GROUP BY ROLLUP(status)"),
        ("count distinct",                  "SELECT COUNT(DISTINCT cust) FROM orders"),
        ("string fn (UPPER/LIKE)",          "SELECT name FROM customers WHERE name LIKE 'A%'"),
        // --- rewrite-path confirmations: turn the 'fail' constructs into supported SQL ---
        ("HAVING via alias",                "SELECT cust, SUM(amt) AS s FROM orders GROUP BY cust HAVING s > 100"),
        ("INTERSECT via IN-subquery",       "SELECT DISTINCT cust FROM orders WHERE cust IN (SELECT cust FROM customers)"),
        ("EXCEPT via NOT-IN-subquery",      "SELECT cust FROM customers WHERE cust NOT IN (SELECT cust FROM orders)"),
        ("ROLLUP via UNION-of-levels",      "SELECT status, SUM(amt) AS s FROM orders GROUP BY status UNION ALL SELECT 'TOTAL' AS status, SUM(amt) AS s FROM orders"),
    ];

    let mut pass = 0;
    let mut fail = 0;
    println!("\n=== Polars 0.43 SQLContext coverage ===\n");
    for (name, sql) in &probes {
        let mut ctx = SQLContext::new();
        ctx.register("orders", orders.clone().lazy());
        ctx.register("customers", customers.clone().lazy());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ctx.execute(sql).and_then(|lf| lf.collect())
        }));
        match result {
            Ok(Ok(df)) => { pass += 1; println!("  PASS  {:<28} -> {} rows x {} cols", name, df.height(), df.width()); }
            Ok(Err(e)) => { fail += 1; let m = e.to_string(); println!("  FAIL  {:<28} -> {}", name, m.lines().next().unwrap_or("").chars().take(90).collect::<String>()); }
            Err(_)     => { fail += 1; println!("  PANIC {:<28} -> (panicked)", name); }
        }
    }
    println!("\n=== {} pass / {} fail of {} ===", pass, fail, probes.len());
}
