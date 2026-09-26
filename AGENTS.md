
<!-- cgraphy-steering -->
## cgraphy knowledge graph (MCP server `cgraphy`)

This repo has a self-maintaining code graph. Tool names appear as
`mcp__cgraphy__<tool>` (e.g. `mcp__cgraphy__cgraphy_search`).

These are REPLACEMENTS, not extra steps — substitute, don't add:

| Instead of | Use |
| --- | --- |
| grep for a symbol/function/class name | `cgraphy_search <name or meaning>` |
| reading a whole file to see one function | `cgraphy_read <symbol>` |
| tracing callers/usages by hand | `cgraphy_context <symbol>` |
| guessing what a change breaks | `cgraphy_impact <symbol>` |
| re-reading your own diff before commit | `cgraphy_diff_context` |

Keep your normal workflow otherwise. Grep is still right for literal
strings, error messages, and non-symbol text. Never run the same lookup
through both paths. NEVER call cgraphy_enrich/cgraphy_store_summaries
unless the user explicitly asks to enrich the graph.
