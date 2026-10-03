# RainSync source transfer

Temporary Git transport only; not a release, merge or deployment.

Archive: rainsync-source-20261003-0011.tar.gz
SHA256: 4e56ebf677b8886ce003401bbe4a7f1716544e1b096a59e6d124ff78e4957d63
Bytes: 3107794

The archive contains a self-contained Git bundle with 40 source refs, manifest.json, HANDOFF.md and selected pure-test evidence. It contains no credentials, runtime data, databases, binaries or caches.

Integration commit: ccb6898d0bb0e599a8432256efe51d740594cda6
Integration tree: 2f2470bb1e3eff218330ac2fe72c61b8eb5c75c3
Unintegrated pure HLS commit: db19f149890a41b13ef781c938051acb369d6976

Verify the archive hash, paths and manifest before fetching repository.bundle into an isolated checkout. Read HANDOFF.md before selecting any other source refs. Prior failures, unknown ownership and disabled production HLS boundaries remain unchanged.

This transport branch intentionally has no workflows. Do not merge it into main.
