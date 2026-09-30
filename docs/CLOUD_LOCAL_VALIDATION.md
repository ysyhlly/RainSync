# Optional local validation tools

The disposable PostgreSQL fixtures default to Docker (`postgres:17`). Set
`RAINSYNC_NATIVE_POSTGRES_BIN` to an installed PostgreSQL 17 `bin` directory to
use native `initdb`, `postgres`, `psql`, `pg_dump`, `createdb`, and `pg_restore`.
This is an explicit alternative for environments without Docker, not an existing
or external database connection. Run native PostgreSQL as an unprivileged user.

Both paths create a new owned cluster, random password, and random loopback-only
port. Native clusters also use random database names and SCRAM authentication.
Cluster files and logs remain under the fixture's artifact directory; processes
are stopped at fixture cleanup. Set `RAINSYNC_ARTIFACT_DIR` and
`CARGO_TARGET_DIR` outside the checkout when retaining evidence. Only disposable
fixture data is involved in the aggregate's dump/restore test.

The shared `tests/fixtures/postgres.mjs` is used by standalone Server fixtures
and `tests/integration.mjs`, including its asynchronous SQL locks and actual
backup/restore stage. Docker behavior remains available but must be independently
validated on a Docker-capable machine when only native PostgreSQL was tested.

Set `RAINSYNC_CHROMIUM_EXECUTABLE` to an existing browser executable to opt in for
`playwright test`, `tests/browser-real.mjs`, `tests/library-player-real.mjs`, and
`tests/playlist-real.mjs`. If unset, Playwright's normal bundled-browser lookup
is unchanged. The Playwright dev server binds only `127.0.0.1`. Record the actual
browser version in the validation report: an arbitrary system Chromium is not
necessarily the browser version distributed with Playwright.

These switches do not grant a browser or database additional operating-system
permissions. A browser that fails before creating a page is an environment
blocker, not a passed test or an application regression. Desktop/mobile projects
refer to browser viewport/device emulation, not physical-device validation.

For a fresh source-bound native upstream validation run, optionally set
`RAINSYNC_RUNTIME_ROOT` to a new owned directory outside the checkout before
running `scripts/bind-native-backend.mjs` and the upstream reservation/observation
harnesses. The default remains `.runtime`. The same source/binary identity,
containment and positive cleanup checks still apply; using a new candidate
directory keeps earlier bindings and reports intact. `RAINSYNC_ARTIFACT_DIR`
continues to select the fixture evidence directory.
