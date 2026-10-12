//! Account profile operations and shared account/guest identity projection.
//! Preserve request-entry admission and independent SQL writes/readback.
use super::{RequestContext, request};
use crate::{Result, account_rules, avatars};
use axum::http::HeaderMap;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(crate) async fn value(db: &PgPool, id: Uuid) -> Result<Value> {
    let row = sqlx::query("SELECT u.username,p.display_name AS custom_display_name,COALESCE(g.display_name,p.display_name,u.username) AS display_name,a.version AS avatar_version,a.content_type AS avatar_content_type FROM users u LEFT JOIN guest_principals g ON g.user_id=u.id LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE u.id=$1")
        .bind(id).fetch_one(db).await?;
    Ok(
        json!({"id":id,"username":row.get::<String,_>("username"),"display_name":row.get::<String,_>("display_name"),
        "custom_display_name":row.get::<Option<String>,_>("custom_display_name"),"avatar_url":avatars::url(id,row.get("avatar_version"),row.get::<Option<String>,_>("avatar_content_type").is_some()),"avatar_version":row.get::<Option<Uuid>,_>("avatar_version")}),
    )
}
pub(crate) async fn get_profile(context: RequestContext<'_>, h: &HeaderMap) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, h, false, false).await?;
    value(db, user.id).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Update {
    display_name: String,
}

pub(crate) async fn update(
    context: RequestContext<'_>,
    h: &HeaderMap,
    body: Update,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, h, true, false).await?;
    let name = account_rules::display_name(Some(&body.display_name))?;
    if let Some(name) = name {
        sqlx::query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET display_name=EXCLUDED.display_name")
            .bind(user.id).bind(name).execute(db).await?;
    } else {
        sqlx::query("DELETE FROM user_profiles WHERE user_id=$1")
            .bind(user.id)
            .execute(db)
            .await?;
    }
    value(db, user.id).await
}
