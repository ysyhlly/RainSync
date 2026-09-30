use crate::*;

pub async fn value(app: &App, id: Uuid) -> Result<Value> {
    let row = sqlx::query("SELECT u.username,p.display_name AS custom_display_name,COALESCE(p.display_name,u.username) AS display_name,a.version AS avatar_version,a.content_type AS avatar_content_type FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE u.id=$1")
        .bind(id).fetch_one(&app.db).await?;
    Ok(
        json!({"id":id,"username":row.get::<String,_>("username"),"display_name":row.get::<String,_>("display_name"),
        "custom_display_name":row.get::<Option<String>,_>("custom_display_name"),"avatar_url":avatars::url(id,row.get("avatar_version"),row.get::<Option<String>,_>("avatar_content_type").is_some()),"avatar_version":row.get::<Option<Uuid>,_>("avatar_version")}),
    )
}
pub async fn get_profile(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(registration::private_json(
        StatusCode::OK,
        value(&app, user.id).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    display_name: String,
}

pub async fn update(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Update>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    let name = account_rules::display_name(Some(&body.display_name))?;
    if let Some(name) = name {
        sqlx::query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET display_name=EXCLUDED.display_name")
            .bind(user.id).bind(name).execute(&app.db).await?;
    } else {
        sqlx::query("DELETE FROM user_profiles WHERE user_id=$1")
            .bind(user.id)
            .execute(&app.db)
            .await?;
    }
    Ok(registration::private_json(
        StatusCode::OK,
        value(&app, user.id).await?,
    ))
}
