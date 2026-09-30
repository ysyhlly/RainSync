//! Only used to create synthetic legacy credentials in an owned integration DB.
use argon2::{
    Argon2, PasswordHasher,
    password_hash::{SaltString, rand_core::OsRng},
};
fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"),
        "isolated test marker required"
    );
    let password = std::env::var("RAINSYNC_FIXTURE_PASSWORD")?;
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| anyhow::anyhow!("fixture hash failed"))?;
    println!("{hash}");
    Ok(())
}
