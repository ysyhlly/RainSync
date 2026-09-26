fn main() {
    // sqlx's stable migrate! tracks existing files, not newly added migrations.
    println!("cargo:rerun-if-changed=../../migrations");
}
