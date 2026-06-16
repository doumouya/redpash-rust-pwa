//! Purpose: the api crate as a library — bin/main.rs is a thin shell over
//! this. Lib+bin split from day one so integration tests (tests/) can reach
//! the RBAC core; the predecessor was bin-only, which forced its live-DB
//! tests inline behind #[ignore].

pub mod admin;
pub mod auth;
pub mod bootstrap;
pub mod cases;
pub mod connectors_core;
pub mod mysql_loader;
pub mod db;
pub mod designer;
pub mod error;
pub mod event;
pub mod field_perms;
pub mod middleware;
pub mod files;
pub mod group;
pub mod id;
pub mod me;
pub mod monitoring;
pub mod objects;
pub mod pipeline;
pub mod projects;
pub mod rail;
pub mod rbac;
pub mod search;
pub mod session;
pub mod settings;
pub mod state;
pub mod type_cache;
pub mod types;
