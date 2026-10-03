# RainSync source transfer

Temporary Git transport only; not a release, merge or deployment. Do not merge this branch into main.

Archive: rainsync-source-20261003-0011.tar.gz
SHA256: 4e56ebf677b8886ce003401bbe4a7f1716544e1b096a59e6d124ff78e4957d63
Bytes: 3107794

## Required shallow-history correction

The source repository was shallow. The archive's statement that repository.bundle is fully self-contained omitted this historical boundary. Its 40 refs have complete source snapshots, but it does NOT contain complete commit history. Preserve the exact original SHALLOW file when importing into a NEW isolated repository; do not alter an existing user checkout's history or invent other grafts.

Original shallow commit: 464dc39fba02431807aef0bb924fd0b0e46ba11a
Its tree: 5829bdd486e7a15179071d1340c8b34808b04a68
Its unavailable historical parent: 4ee4fb24244682f26fdff13078c2dfe421fd4d7a

The boundary was read directly from the producer's .git/shallow. git bundle verify alone did not establish complete historical object availability. Verify all needed source trees after importing with this declared boundary; stop for any other missing object. The archive itself is unchanged.

Integration commit: ccb6898d0bb0e599a8432256efe51d740594cda6
Integration tree: 2f2470bb1e3eff218330ac2fe72c61b8eb5c75c3
Unintegrated pure HLS commit: db19f149890a41b13ef781c938051acb369d6976
Pure HLS tree: d39ea6a716e22e9c5a24d8069b76dd7443a65080

The package contains a Git source bundle, manifest.json, HANDOFF.md and selected pure-test evidence. It contains no credentials, runtime data, databases, binaries or caches. Verify archive paths and every manifest hash before use. HANDOFF.md's safety boundaries and source-only distinctions remain applicable. This branch has no workflows.
