<!-- gitnexus-steering -->
## GitNexus

Use the available GitNexus MCP tools for structural code navigation. Start with
`list_repos`, select the actual registered repository, and compare its indexed
path and commit with the current checkout before interpreting graph results.
Do not assume that a repository named `rainsync` indexes this worktree: an MCP
server running in `C:\rainsync` may still use that checkout's older index.
Inspect the current tool schemas and use the returned repository identity.

Keep the current worktree's absolute path explicit. For `detect_changes`, pass
`worktree` as the current checkout's absolute path, with the relevant `scope`
and an existing local `base_ref` when comparing commits. The MCP server's
working directory is not the current task's checkout. Reading changes from a
worktree does not by itself refresh the graph index.

When the MCP repository does not cover the current checkout, use the available
local GitNexus CLI against a separate task index. Discover its executable or
Node entry point from the current task's existing installation or MCP
configuration; do not assume a global command or personal installation path.
Use that runner in the CLI commands below and confirm its actual help. If the
MCP only permits another path, use the CLI for this task instead of changing
MCP access limits.

Create the intended checkout's index with
`<discovered-runner> analyze <current-worktree> --index-only --name <unique-worktree-alias>`.
Use a unique alias so another checkout's registration is not replaced. Refresh
only when relevant symbol/source changes or an outdated index warrant it; the
first index does not need `--force`. Use `--force` when a stale index needs
rebuilding. `--index-only` prevents the CLI from rewriting AGENTS/CLAUDE
guidance or installing skills. Embeddings are
off by default; do not invoke wiki, enrich, or embedding generation.

Keep index storage writable and separate from the repository and other tasks:
`GITNEXUS_STORAGE_PATH` selects one complete independent index directory;
`GITNEXUS_STORAGE_ROOT` provides separate directories per repository. The former
takes precedence. Use the same task storage for subsequent CLI calls, such as
`<discovered-runner> query --repo <alias-or-path> '<query>'` and
`<discovered-runner> context --repo <alias-or-path> '<symbol>' --file <relative-path> --content`.
Confirm the resulting indexed path and commit before treating it as current.

Do not install tools, download models, change MCP permissions, or alter
network/security settings to make navigation work. Never enrich or store extra
persistent graph summaries unless the user explicitly asks.

These are replacements, not extra steps — substitute, don't add:

| Instead of | Use |
| --- | --- |
| grep for a symbol/function/class name | `query` with `search_query` and `repo`; resolve the exact symbol with `context` |
| reading a whole file to see one function | `context` with `name` or `uid`, a `file_path` hint when ambiguous, and `include_content` when needed |
| tracing callers/usages by hand | `context` or `trace`, using exact symbol UIDs and file hints when available |
| guessing what a change breaks | `impact` with `target` or `target_uid`, `direction`, `maxDepth`, and `repo`; use `api_impact` for route/file/method impact |
| re-reading your own diff before commit | `detect_changes` with the current absolute `worktree`, relevant `scope`, and an existing local `base_ref`, plus impact and related tests as needed |

Keep your normal workflow otherwise. `rg` remains appropriate for literal
strings, error messages, and non-symbol text. Do not repeat the same successful
lookup through both graph and manual paths.

Report the actual indexed path and commit, stale-index mismatches, parser or
source-content gaps, and the result envelope's completeness limits. When
`epistemic` is `lower-bound`, incoming-call and impact results are lower bounds;
read `boundaries` and `causes`, and do not treat missing callers as proof that
none exist. Interpret `partial: true` and `truncated: true` according to the
actual response fields; incomplete results cannot turn `changed_count: 0` or
low risk into a passed check. Incomplete Vue SFC parsing and missing preserved
source require focused source inspection and behavioral checks. Do not present
an old checkout's result as current-worktree evidence, or claim a query succeeded
merely because a repository is registered or indexing completed.

If GitNexus, a usable current index, or source content is unavailable, state the
exact limitation and continue direct source analysis for the affected area.
Do not retry retired CodeGraph/cgraphy tools or bypass access restrictions.
