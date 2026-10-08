# First administrator setup

For a new installation, do not save the administrator password in `.env`, shell
history, Docker Compose configuration, or deployment logs. Leave `ADMIN_PASSWORD`
unset. Database and source-encryption credentials are separate secrets and still
need secure deployment configuration.

The server supports `rainsync-server init-admin --username NAME` in a real Linux
terminal. It asks for the password twice with terminal echo disabled, validates
and hashes it, and creates the first administrator transactionally. It refuses
redirected password input, an installation with any existing account, and a race
with another first-account creator. It never resets an existing account.

Start the isolated PostgreSQL service before initializing. In the selected
Compose project, use an interactive one-off Server container to run the command;
then start the ordinary Server, Worker, and web services. The account owner must
personally enter and submit the password. A validated deployment-specific command
must include the same project, Compose files, and environment-file selectors as
normal startup. Do not run this command against an unrelated database.

`deploy/loopback.override.yaml` is an optional Compose override for an existing
HTTPS reverse proxy. It replaces the default published ports with a single
loopback binding, `127.0.0.1:3080`, and keeps public TLS termination outside the
application stack. Use a distinct project name so database and cache volumes
cannot collide with another installation. This does not configure the public
proxy or its certificates.

## Manual source-Compose setup

Run these commands from the installation directory in your own interactive
terminal after building the current images. The example uses the same distinct
project name, environment file, and loopback override for every step:

```sh
docker compose -p rainsync-production \
  --env-file /opt/rainsync/config/runtime.env \
  -f compose.yaml -f deploy/loopback.override.yaml up -d db

docker compose -p rainsync-production \
  --env-file /opt/rainsync/config/runtime.env \
  -f compose.yaml -f deploy/loopback.override.yaml \
  run --rm --no-deps server rainsync-server init-admin --username rainsync-admin

docker compose -p rainsync-production \
  --env-file /opt/rainsync/config/runtime.env \
  -f compose.yaml -f deploy/loopback.override.yaml up -d server worker web
```

Replace the example project, environment-file path, and username with the
installation's selected values. Keep `ADMIN_PASSWORD` out of that file and your
shell environment. The password must be typed at the two prompts; do not put it
in a command, pipe, here-document, argument, or environment variable. Compose's
`run` command automatically detects a terminal; do not add `-T`, detach the
container, or redirect input/output. `--no-deps` relies on the database already
being healthy and does not start the ordinary application before initialization.
The one-off container is removed on completion and does not publish service ports.

For digest-pinned release deployments, use `-f deploy/release.compose.yaml` in
place of `-f compose.yaml` at every step, retaining the installation's environment
and project selectors. The shipped backend entrypoint keeps its offline Server
and Worker contract checks before dispatching `rainsync-server init-admin`.

The source command and entrypoint argument route are checked in the native
fixture described below. Actual Docker/Compose execution and the deployment's
project/database identity must be verified on the target host before presenting
its command as deployment-tested. The public CLI semantics are documented in
[Docker's Compose run reference](https://docs.docker.com/reference/cli/docker/compose/run/).

## Terminal and first-account guarantees

- Both standard input and standard error must be terminals; redirected input is
  rejected before reading database configuration
- Entry is limited to 8–1024 printable ASCII characters; leading/trailing spaces
  are significant and confirmation must match exactly
- Entry and confirmation buffers use bounded, zeroizing allocations; only an
  Argon2id password hash is inserted into PostgreSQL
- Terminal echo is hidden during both prompts. Normal rejection, EOF, Ctrl-C,
  SIGTERM, SIGHUP, and SIGQUIT restore the original terminal settings and file
  descriptor flags. SIGKILL and an inaccessible terminal cannot be recovered by
  any terminated process; run `stty sane` if the terminal needs recovery
- The initial account check rejects existing users before asking for a password.
  The insert takes a transaction-local users-table lock and checks again, so
  simultaneous initializations produce exactly one account and never replace
  another account. Lock and statement waits have explicit bounds
- After successful setup, normal startup uses the persisted hash and does not
  require an administrator password environment variable

## Reproducible native verification

`tests/admin-bootstrap-native.mjs` uses a new process-owned PostgreSQL cluster,
random loopback ports, the actual locally built server binary, and Python PTYs.
Its environment is explicitly enumerated so it never inherits a production
administrator password or database URL. All password entries are generated
synthetic fixture values. Set `RAINSYNC_NATIVE_POSTGRES_BIN`,
`RAINSYNC_PG_MODULE`, and `RAINSYNC_ARTIFACT_DIR` to the authorized native fixture
paths, then run:

```sh
cargo test --offline --locked -p rainsync-server --bin rainsync-server admin_bootstrap::tests
node tests/admin-bootstrap-native.mjs
```

The matrix covers redirected input and error output, mismatch, invalid ASCII,
oversized input, EOF and interruption signals, concurrent first-account creation,
second-initialization refusal, actual release-entrypoint dispatch, and normal
server startup/login without either administrator environment variable. Reports
record binary provenance, no secret echo, complete terminal restoration, and
positive process-close/PID-absence/port-closure receipts for owned processes.
Native results do not claim production Docker, proxy, TLS, or account changes.
