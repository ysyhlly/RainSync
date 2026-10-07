use crate::responses::private_json;
use crate::*;
use axum::extract::Query;

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FIELDS: &str = "SELECT i.id,i.batch_id,i.code_suffix,i.used_by, b.created_by,b.note, \
    floor(extract(epoch FROM b.created_at)*1000)::bigint AS created_at, \
    floor(extract(epoch FROM i.expires_at)*1000)::bigint AS expires_at, \
    floor(extract(epoch FROM i.used_at)*1000)::bigint AS used_at, \
    floor(extract(epoch FROM i.revoked_at)*1000)::bigint AS revoked_at, \
    u.username AS used_by_username,COALESCE(p.display_name,u.username) AS used_by_display_name, \
    CASE WHEN i.used_at IS NOT NULL THEN 'used' WHEN i.revoked_at IS NOT NULL THEN 'revoked' \
    WHEN i.expires_at<=clock_timestamp() THEN 'expired' ELSE 'unused' END AS status \
    FROM registration_invites i JOIN registration_invite_batches b ON b.id=i.batch_id \
    LEFT JOIN users u ON u.id=i.used_by LEFT JOIN user_profiles p ON p.user_id=u.id";

fn new_code() -> String {
    let mut random = [0u8; 20];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let mut raw = String::with_capacity(32);
    let (mut buffer, mut bits) = (0u32, 0);
    for byte in random {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            raw.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    let groups: Vec<&str> = (0..32).step_by(4).map(|i| &raw[i..i + 4]).collect();
    format!("RS-{}", groups.join("-"))
}

pub fn normalize_code(value: &str) -> Option<String> {
    if value.len() > 128 || !value.is_ascii() {
        return None;
    }
    let raw: String = value
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'-')
        .map(|b| b.to_ascii_uppercase() as char)
        .collect();
    let body = raw.strip_prefix("RS")?;
    if body.len() != 32 || !body.bytes().all(|b| ALPHABET.contains(&b)) {
        return None;
    }
    Some(raw)
}

pub fn code_hash(code: &str) -> String {
    hash(&format!("registration:{code}"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBatch {
    batch_id: Uuid,
    #[serde(default = "one")]
    count: i32,
    #[serde(default = "seven")]
    valid_days: i32,
    note: Option<String>,
}
fn one() -> i32 {
    1
}
fn seven() -> i32 {
    7
}

pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<CreateBatch>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    admin(&user)?;
    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if !(1..=50).contains(&body.count)
        || ![1, 7, 30].contains(&body.valid_days)
        || note.is_some_and(|n| n.chars().count() > 60 || n.chars().any(char::is_control))
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let mut tx = app.db.begin().await?;
    let inserted = sqlx::query("INSERT INTO registration_invite_batches(id,created_by,count,valid_days,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING")
        .bind(body.batch_id).bind(user.id).bind(body.count).bind(body.valid_days).bind(note).execute(&mut *tx).await?;
    if inserted.rows_affected() == 0 {
        let previous = sqlx::query(
            "SELECT created_by,count,valid_days,note FROM registration_invite_batches WHERE id=$1",
        )
        .bind(body.batch_id)
        .fetch_one(&mut *tx)
        .await?;
        let same = previous.get::<Uuid, _>("created_by") == user.id
            && previous.get::<i32, _>("count") == body.count
            && previous.get::<i32, _>("valid_days") == body.valid_days
            && previous.get::<Option<String>, _>("note").as_deref() == note;
        return Err(err(
            StatusCode::CONFLICT,
            if same {
                "registration_batch_already_created"
            } else {
                "registration_batch_conflict"
            },
        ));
    }
    let mut items = Vec::with_capacity(body.count as usize);
    for _ in 0..body.count {
        let id = Uuid::new_v4();
        let code = new_code();
        let normalized = normalize_code(&code).expect("generated Base32 registration code");
        let suffix = &normalized[normalized.len() - 4..];
        let expires_at: i64 = sqlx::query_scalar("INSERT INTO registration_invites(id,batch_id,code_hash,code_suffix,expires_at) SELECT $1,id,$3,$4,created_at+valid_days*interval '1 day' FROM registration_invite_batches WHERE id=$2 RETURNING floor(extract(epoch FROM expires_at)*1000)::bigint")
            .bind(id).bind(body.batch_id).bind(code_hash(&normalized)).bind(suffix).fetch_one(&mut *tx).await?;
        items.push(json!({"id":id,"code":code,"code_suffix":suffix,"expires_at":expires_at}));
    }
    tx.commit().await?;
    Ok(private_json(
        StatusCode::CREATED,
        json!({"batch_id":body.batch_id,"items":items}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    status: Option<String>,
    cursor: Option<Uuid>,
    limit: Option<i64>,
    batch_id: Option<Uuid>,
}

fn metadata(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"batch_id":row.get::<Uuid,_>("batch_id"),"code_suffix":row.get::<String,_>("code_suffix"),
        "created_by":row.get::<Uuid,_>("created_by"),"note":row.get::<Option<String>,_>("note"),"created_at":row.get::<i64,_>("created_at"),
        "expires_at":row.get::<i64,_>("expires_at"),"used_at":row.get::<Option<i64>,_>("used_at"),"revoked_at":row.get::<Option<i64>,_>("revoked_at"),
        "used_by":row.get::<Option<Uuid>,_>("used_by"),"used_by_username":row.get::<Option<String>,_>("used_by_username"),
        "used_by_display_name":row.get::<Option<String>,_>("used_by_display_name"),"status":row.get::<String,_>("status")})
}

pub async fn list(
    State(app): State<App>,
    h: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Response> {
    admin(&auth(&app, &h, false).await?)?;
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let mut sql = sqlx::QueryBuilder::new(FIELDS);
    sql.push(" WHERE true");
    match query.status.as_deref().unwrap_or("all") {
        "all" => {}
        "used" => {
            sql.push(" AND i.used_at IS NOT NULL");
        }
        "revoked" => {
            sql.push(" AND i.revoked_at IS NOT NULL");
        }
        "expired" => {
            sql.push(" AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at<=clock_timestamp()");
        }
        "unused" => {
            sql.push(" AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp()");
        }
        _ => return Err(err(StatusCode::BAD_REQUEST, "invalid_request")),
    }
    if let Some(batch) = query.batch_id {
        sql.push(" AND i.batch_id=").push_bind(batch);
    }
    if let Some(cursor) = query.cursor {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM registration_invites WHERE id=$1)")
                .bind(cursor)
                .fetch_one(&app.db)
                .await?;
        if !exists {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
        }
        sql.push(" AND (b.created_at,i.id)<(SELECT b2.created_at,i2.id FROM registration_invites i2 JOIN registration_invite_batches b2 ON b2.id=i2.batch_id WHERE i2.id=").push_bind(cursor).push(")");
    }
    sql.push(" ORDER BY b.created_at DESC,i.id DESC LIMIT ")
        .push_bind(limit + 1);
    let rows = sql.build().fetch_all(&app.db).await?;
    let more = rows.len() > limit as usize;
    let items: Vec<Value> = rows.iter().take(limit as usize).map(metadata).collect();
    let next = if more {
        items.last().map(|i| i["id"].clone())
    } else {
        None
    };
    let server_time: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&app.db)
            .await?;
    Ok(private_json(
        StatusCode::OK,
        json!({"items":items,"next_cursor":next,"server_time":server_time}),
    ))
}

pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    admin(&user)?;
    let mut tx = app.db.begin().await?;
    if sqlx::query("SELECT id FROM registration_invites WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Err(err(StatusCode::NOT_FOUND, "not_found"));
    }
    // Read the real clock only after the conflicting registration lock is acquired.
    let row = sqlx::query("SELECT used_at IS NOT NULL AS used,revoked_at IS NOT NULL AS revoked,expires_at>clock_timestamp() AS valid FROM registration_invites WHERE id=$1")
        .bind(id).fetch_one(&mut *tx).await?;
    if row.get::<bool, _>("used") {
        return Err(err(
            StatusCode::CONFLICT,
            "registration_invite_already_used",
        ));
    }
    if !row.get::<bool, _>("revoked") {
        if !row.get::<bool, _>("valid") {
            return Err(err(StatusCode::CONFLICT, "registration_invite_invalid"));
        }
        sqlx::query("UPDATE registration_invites SET revoked_by=$2,revoked_at=clock_timestamp() WHERE id=$1")
            .bind(id).bind(user.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let row = sqlx::query(&format!("{FIELDS} WHERE i.id=$1"))
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    Ok(private_json(StatusCode::OK, metadata(&row)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codes_have_160_random_bits_and_accept_only_canonical_paste_variations() {
        let code = new_code();
        let normalized = normalize_code(&code).unwrap();
        assert_eq!(normalized.len(), 34);
        assert_eq!(
            normalize_code(&format!(" {} \n", code.to_lowercase())),
            Some(normalized.clone())
        );
        assert_ne!(code_hash(&normalized), hash(&normalized));
        assert!(normalize_code(&"a".repeat(64)).is_none());
        assert!(normalize_code("RS-中文").is_none());
    }
}
