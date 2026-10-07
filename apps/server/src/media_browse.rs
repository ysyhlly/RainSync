//! Bounded server-side hierarchy over the complete, permission-filtered index.
//! Tokens carry only normalized relative components, never source configuration.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Node {
    version: u8,
    source: Uuid,
    path: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    node: Option<String>,
    library: Option<Uuid>,
    key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowseQuery {
    node: Option<String>,
    library_id: Option<Uuid>,
    after: Option<String>,
    limit: Option<i64>,
}
fn invalid() -> Error {
    err(StatusCode::BAD_REQUEST, "invalid_request")
}
fn encode<T: Serialize>(value: &T) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).expect("browse token"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    if value.len() > 16384 {
        return Err(invalid());
    }
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn parse_node(value: &str) -> Result<Node> {
    let node: Node = decode(value)?;
    if node.version != 1
        || node.path.len() > 63
        || node.path.iter().any(|part| {
            part.is_empty()
                || part.len() > 1024
                || matches!(part.as_str(), "." | "..")
                || part
                    .chars()
                    .any(|c| c.is_control() || c == '/' || c == '\\')
        })
        || node.path.iter().map(String::len).sum::<usize>() > 8192
    {
        return Err(invalid());
    }
    Ok(node)
}
fn node_id(source: Uuid, path: Vec<String>) -> String {
    encode(&Node {
        version: 1,
        source,
        path,
    })
}
fn cursor(query: &BrowseQuery) -> Result<String> {
    let Some(after) = query.after.as_deref() else {
        return Ok(String::new());
    };
    let value: Cursor = decode(after)?;
    if value.version != 1
        || value.node != query.node
        || value.library != query.library_id
        || value.key.is_empty()
        || value.key.len() > 1026
        || value.key.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(value.key)
}
fn next_cursor(query: &BrowseQuery, key: Option<String>) -> Option<String> {
    key.map(|key| {
        encode(&Cursor {
            version: 1,
            node: query.node.clone(),
            library: query.library_id,
            key,
        })
    })
}

pub async fn browse(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<BrowseQuery>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    let node = query.node.as_deref().map(parse_node).transpose()?;
    let after = cursor(&query)?;
    let limit = query.limit.unwrap_or(24).clamp(1, 100);
    let mut tx = app.db.begin().await?;
    // Counts, breadcrumbs, folders and hydrated cards share one DB snapshot.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    if let Some(library) = query.library_id {
        let allowed: bool = sqlx::query_scalar("SELECT library_allowed($1,$2,'browse')")
            .bind(user.id)
            .bind(library)
            .fetch_one(&mut *tx)
            .await?;
        if !allowed {
            return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
        }
    }
    let mut breadcrumbs = vec![json!({"id":null,"name":"全部片源"})];
    let mut entries = Vec::new();
    let total: i64;
    let next: Option<String>;
    if let Some(node) = node {
        let source = sqlx::query("SELECT name,kind FROM sources s WHERE s.id=$2 AND s.deleted_at IS NULL AND ($3::uuid IS NULL OR s.library_id=$3) AND library_allowed($1,s.library_id,'browse') AND (s.kind<>'agent' OR EXISTS(SELECT 1 FROM agents a WHERE a.id=s.id AND NOT a.revoked))")
            .bind(user.id).bind(node.source).bind(query.library_id)
            .fetch_optional(&mut *tx).await?
            .ok_or_else(|| err(StatusCode::NOT_FOUND,"media_not_found"))?;
        let scope = format!(
            "{} AND s.deleted_at IS NULL AND s.id=$2 AND m.browse_path @> $3::text[] AND m.browse_path[1:$4]=$3::text[]",
            media_titles::BROWSE
        );
        let depth = node.path.len() as i32;
        let representative = sqlx::query(&format!("SELECT m.browse_labels,count(*) OVER() AS total FROM media_items m JOIN sources s ON s.id=m.source_id WHERE {scope} ORDER BY m.id LIMIT 1"))
            .bind(user.id).bind(node.source).bind(&node.path).bind(depth)
            .fetch_optional(&mut *tx).await?
            .ok_or_else(|| err(StatusCode::NOT_FOUND,"media_not_found"))?;
        total = representative.get("total");
        let labels: Vec<String> = representative.get("browse_labels");
        breadcrumbs
            .push(json!({"id":node_id(node.source,vec![]),"name":source.get::<String,_>("name")}));
        for (index, label) in labels.iter().take(node.path.len()).enumerate() {
            breadcrumbs
                .push(json!({"id":node_id(node.source,node.path[..=index].to_vec()),"name":label}));
        }
        let rows = sqlx::query(&format!(
            "WITH visible AS MATERIALIZED (SELECT m.id,m.browse_path,m.browse_labels FROM media_items m JOIN sources s ON s.id=m.source_id WHERE {scope}), children AS (
              SELECT 'folder'::text AS type,'0:'||browse_path[$4+1] AS key,min(browse_labels[$4+1]) AS name,count(*) AS media_count FROM visible WHERE cardinality(browse_path)>$4 GROUP BY browse_path[$4+1]
              UNION ALL SELECT 'media','1:'||id::text,NULL,1 FROM visible WHERE cardinality(browse_path)=$4)
              SELECT * FROM children WHERE key COLLATE \"C\">$5 COLLATE \"C\" ORDER BY key COLLATE \"C\" LIMIT $6"))
            .bind(user.id).bind(node.source).bind(&node.path).bind(depth).bind(&after).bind(limit+1)
            .fetch_all(&mut *tx).await?;
        let page = rows.iter().take(limit as usize).collect::<Vec<_>>();
        next = (rows.len() > limit as usize).then(|| page.last().unwrap().get::<String, _>("key"));
        let ids: Vec<Uuid> = page
            .iter()
            .filter(|r| r.get::<String, _>("type") == "media")
            .map(|r| Uuid::parse_str(&r.get::<String, _>("key")[2..]).expect("database UUID"))
            .collect();
        // Only the current page's cards are hydrated; no unbounded catalog read.
        let media = sqlx::query(&format!(
            "{} WHERE {} AND s.deleted_at IS NULL AND m.id=ANY($2)",
            media_titles::SELECT,
            media_titles::BROWSE
        ))
        .bind(user.id)
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
        for row in page {
            let key: String = row.get("key");
            if row.get::<String, _>("type") == "folder" {
                let mut path = node.path.clone();
                path.push(key[2..].to_owned());
                entries.push(json!({"type":"folder","id":node_id(node.source,path),"name":row.get::<String,_>("name"),"media_count":row.get::<i64,_>("media_count")}));
            } else {
                let id = Uuid::parse_str(&key[2..]).expect("database UUID");
                if let Some(row) = media.iter().find(|r| r.get::<Uuid, _>("id") == id) {
                    entries.push(json!({"type":"media","media":media_titles::media(row)}));
                }
            }
        }
    } else {
        let scope = format!(
            "{} AND s.deleted_at IS NULL AND ($2::uuid IS NULL OR s.library_id=$2)",
            media_titles::BROWSE
        );
        total = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM media_items m JOIN sources s ON s.id=m.source_id WHERE {scope}"
        ))
        .bind(user.id)
        .bind(query.library_id)
        .fetch_one(&mut *tx)
        .await?;
        let rows = sqlx::query(&format!("SELECT s.id,s.name,s.kind,count(*) AS media_count FROM media_items m JOIN sources s ON s.id=m.source_id WHERE {scope} AND s.id::text COLLATE \"C\">$3 COLLATE \"C\" GROUP BY s.id ORDER BY s.id::text COLLATE \"C\" LIMIT $4"))
            .bind(user.id).bind(query.library_id).bind(&after).bind(limit+1).fetch_all(&mut *tx).await?;
        let page = rows.iter().take(limit as usize).collect::<Vec<_>>();
        next = (rows.len() > limit as usize)
            .then(|| page.last().unwrap().get::<Uuid, _>("id").to_string());
        for row in page {
            entries.push(json!({"type":"source","id":node_id(row.get("id"),vec![]),"name":row.get::<String,_>("name"),"kind":row.get::<String,_>("kind"),"media_count":row.get::<i64,_>("media_count")}));
        }
    }
    tx.commit().await?;
    Ok(media_titles::private_json(
        json!({"entries":entries,"breadcrumbs":breadcrumbs,"node":query.node,"next_cursor":next_cursor(&query,next),"total_media":total}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_tokens_allow_only_bounded_relative_components() {
        let source = Uuid::new_v4();
        let token = node_id(source, vec!["纪录片".into(), "第二季".into()]);
        assert_eq!(parse_node(&token).unwrap().source, source);
        for path in [
            vec!["..".into()],
            vec!["/host/path".into()],
            vec!["x\\y".into()],
            vec!["a".repeat(1025)],
            vec!["x".into(); 64],
        ] {
            assert!(parse_node(&node_id(source, path)).is_err());
        }
        assert!(parse_node("not a token").is_err());
    }
    #[test]
    fn cursor_is_bound_to_node_and_library() {
        let mut query = BrowseQuery {
            node: None,
            library_id: None,
            after: None,
            limit: None,
        };
        query.after = next_cursor(&query, Some("0:folder".into()));
        assert_eq!(cursor(&query).unwrap(), "0:folder");
        query.node = Some(node_id(Uuid::new_v4(), vec![]));
        assert!(cursor(&query).is_err());
        query.node = None;
        query.library_id = Some(Uuid::new_v4());
        assert!(cursor(&query).is_err());
    }
}
