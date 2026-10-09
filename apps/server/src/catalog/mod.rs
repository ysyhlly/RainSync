//! Named catalog operations retain their original transaction owners and locks.
//! These contexts contain capabilities only, never cached permission decisions.
pub(crate) mod access_policy;
pub(crate) mod libraries;
pub(crate) mod library_authority;
pub(crate) mod private_sources;
pub(crate) mod room_shares;
pub(crate) mod source_rules;
pub(crate) mod source_settings;
pub(crate) mod sources;

use crate::{Result, User, err};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Configuration reads cannot mutate credentials or reach unrelated services.
pub(crate) struct SourceReadContext<'a> {
    pub db: &'a PgPool,
    pub decrypt: &'a (dyn Fn(&str) -> anyhow::Result<Value> + Sync),
}

/// New or retired configuration needs encryption, but no decryption capability.
pub(crate) struct SourceWriteContext<'a> {
    pub db: &'a PgPool,
    pub encrypt: &'a (dyn Fn(&Value) -> anyhow::Result<String> + Sync),
}

/// In-place settings use the existing local cipher through limited callbacks.
/// Randomized encryption is invoked only where the original operation did so.
pub(crate) struct SourceChangeContext<'a> {
    pub db: &'a PgPool,
    pub encrypt: &'a (dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    pub decrypt: &'a (dyn Fn(&str) -> anyhow::Result<Value> + Sync),
}
