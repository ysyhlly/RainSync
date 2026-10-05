<!-- codegraph-steering -->
## CodeGraph (`codegraph-work` plugin)

Use the installed CodeGraph plugin's original `codegraph-ai/CodeGraph` engine
inside the current task. Locate the actual plugin `SKILL.md` in the current
environment and resolve `scripts/codegraph.py` relative to it. Do not assume a
personal installation path. Python 3.11 or later is required.

The helper does not require an external HTTP service or register host tools
named `mcp__cgraphy__...`. Do not start or search for the old cgraphy service.
Keep graph state in a writable, independent task runtime directory. On first
use run `doctor --runtime-dir <runtime>`, then inspect the real schema with
`describe --tool <tool>`. Write arguments to a JSON file and run
`call --workspace <repo> --tool <tool> --request-file <args.json> --runtime-dir <runtime>`.
Use the same runtime for subsequent calls. Default to graph mode; do not use
`--full` or download embedding models for ordinary code navigation.

These are replacements, not extra steps — substitute, don't add:

| Instead of | Use |
| --- | --- |
| grep for a symbol/function/class name | `codegraph_symbol_search` |
| reading a whole file to see one function | `codegraph_get_detailed_symbol` |
| tracing callers/usages by hand | `codegraph_get_ai_context` or caller/callee tools |
| guessing what a change breaks | `codegraph_analyze_impact` |
| re-reading your own diff before commit | `codegraph_pr_context` with an existing local base, or impact plus related tests |

Keep your normal workflow otherwise. Grep is still right for literal strings,
error messages, and non-symbol text. Do not repeat the same successful lookup
through both graph and manual paths. Never enrich or store persistent graph
summaries unless the user explicitly asks.

If Python, native execution, the engine, or an authorized download is unavailable,
report the exact limitation and continue direct source analysis. Do not claim a
graph query succeeded based only on installation or `doctor`. Do not retry old
tools, change proxy/network/security settings, or bypass access restrictions.
Report actual file locations and disclose indexing/parser limitations.
