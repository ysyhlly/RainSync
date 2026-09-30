//! Short authorization/readiness reads own cancellation-safe pooled connections.
use sqlx::{
    Connection, PgPool, Postgres, pool::PoolConnection, postgres::PgArguments, query::QueryScalar,
};
struct CheckConnection(Option<PoolConnection<Postgres>>);
impl Drop for CheckConnection {
    fn drop(&mut self) {
        // A cancelled query cannot strand a slot waiting for ReadyForQuery.
        if let Some(connection) = &mut self.0 {
            connection.close_on_drop();
        }
    }
}
pub async fn boolean(
    pool: &PgPool,
    query: QueryScalar<'_, Postgres, bool, PgArguments>,
    statement_millis: u32,
) -> Result<bool, sqlx::Error> {
    let mut connection = CheckConnection(Some(pool.acquire().await?));
    let mut tx = connection.0.as_mut().expect("owned check").begin().await?;
    sqlx::query("SELECT set_config('statement_timeout',$1,true)")
        .bind(format!("{statement_millis}ms"))
        .execute(&mut *tx)
        .await?;
    let value = query.fetch_one(&mut *tx).await?;
    tx.commit().await?;
    drop(connection.0.take());
    Ok(value)
}

pub async fn text(
    pool: &PgPool,
    query: QueryScalar<'_, Postgres, String, PgArguments>,
    statement_millis: u32,
) -> Result<String, sqlx::Error> {
    let mut connection = CheckConnection(Some(pool.acquire().await?));
    let mut tx = connection.0.as_mut().expect("owned check").begin().await?;
    sqlx::query("SELECT set_config('statement_timeout',$1,true)")
        .bind(format!("{statement_millis}ms"))
        .execute(&mut *tx)
        .await?;
    let value = query.fetch_one(&mut *tx).await?;
    tx.commit().await?;
    drop(connection.0.take());
    Ok(value)
}
