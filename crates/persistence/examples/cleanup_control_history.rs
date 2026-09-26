#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    persistence::cleanup_control_history(&db).await
}
