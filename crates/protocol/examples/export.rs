use protocol::*;
use ts_rs::TS;
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol");
    std::fs::create_dir_all(&root).unwrap();
    let declarations = [
        PlaybackStatus::decl(),
        RoomState::decl(),
        Action::decl(),
        Command::decl(),
        MediaTrack::decl(),
        PlaybackPlan::decl(),
        PlaybackCapabilities::decl(),
    ];
    std::fs::write(
        root.join("index.ts"),
        declarations
            .iter()
            .map(|s| format!("export {s}\n"))
            .collect::<String>(),
    )
    .unwrap();
    std::fs::write(
        root.join("command.schema.json"),
        serde_json::to_string_pretty(&schemars::schema_for!(Command)).unwrap(),
    )
    .unwrap();
}
