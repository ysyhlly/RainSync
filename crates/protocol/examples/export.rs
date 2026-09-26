use protocol::*;
use ts_rs::TS;
fn output(path: std::path::PathBuf, content: String) {
    if std::env::args().any(|arg| arg == "--check") {
        assert_eq!(
            std::fs::read_to_string(&path)
                .unwrap_or_default()
                .replace("\r\n", "\n"),
            content,
            "generated contract is stale: {}",
            path.display()
        );
    } else {
        std::fs::write(path, content).unwrap();
    }
}
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol");
    std::fs::create_dir_all(&root).unwrap();
    let declarations = [
        PlaybackStatus::decl(),
        RoomState::decl(),
        Action::decl(),
        Command::decl(),
        ControlEpoch::decl(),
        MediaTrack::decl(),
        PlaybackPlan::decl(),
        PlaybackCapabilities::decl(),
        PlaybackRequest::decl(),
        ErrorCode::decl(),
        ApiError::decl(),
        ErrorResponse::decl(),
    ];
    output(
        root.join("index.ts"),
        declarations
            .iter()
            .map(|s| format!("export {s}\n"))
            .collect::<String>(),
    );
    for (name, schema) in [
        ("command", schemars::schema_for!(Command)),
        ("control-epoch", schemars::schema_for!(ControlEpoch)),
        ("room-state", schemars::schema_for!(RoomState)),
        ("playback-request", schemars::schema_for!(PlaybackRequest)),
        ("error-response", schemars::schema_for!(ErrorResponse)),
        ("playback-plan", schemars::schema_for!(PlaybackPlan)),
        (
            "playback-capabilities",
            schemars::schema_for!(PlaybackCapabilities),
        ),
    ] {
        output(
            root.join(format!("{name}.schema.json")),
            serde_json::to_string_pretty(&schema).unwrap(),
        );
    }
}
