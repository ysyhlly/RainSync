//! Invoke the production claim path against an owned loopback integration DB.
//! The JavaScript regression coordinates real PostgreSQL locks and HTTP Stop.
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"),
        "isolated test marker required"
    );
    let url = std::env::var("DATABASE_URL")?;
    anyhow::ensure!(url.contains("@127.0.0.1:"), "owned loopback DB required");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET application_name='rainsync-stop-claim-fixture'")
                    .execute(&mut *connection)
                    .await?;
                // Let the actual HTTP transaction detect a pre-fix deadlock.
                sqlx::query("SET deadlock_timeout='10s'")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET statement_timeout='20s'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    let owner = Uuid::new_v4();
    let claim = persistence::media_jobs::claim(&pool, owner).await?;
    let value = claim.map(
        |claim| serde_json::json!({"id":claim.id,"owner":claim.owner,"attempt":claim.attempt}),
    );
    println!("{}", serde_json::to_string(&value)?);
    pool.close().await;
    Ok(())
}
