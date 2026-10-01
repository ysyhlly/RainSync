# NAS file Range and HEAD behavior

Local files and NAS relay delivery now share one bounded single-range selector.
This closes the NEXT_PLAN §9.2 discrepancy without changing source versions,
one-use transfer tickets, playback authorization or independent drain receipts.

| Request | Result |
| --- | --- |
| GET without Range | Full 200 body |
| GET with one supported bytes range | Exact 206 body, range length and complete-file Content-Range total |
| GET with a valid range selecting no bytes | 416, Content-Range: bytes */N, existing structured API error; no media bytes |
| HEAD, with or without Range | Full-representation 200 metadata and no body |
| Malformed, reversed, overflowing, unknown-unit or multiple ranges | Range ignored; full 200 body |
| Repeated Range fields | Range ignored; full 200 body |
| Any If-Range | Range ignored; full 200 body |

Suffix ranges, open-ended ranges and a requested end beyond EOF retain their
normal single-range behavior. A zero-byte file returns 200 without a range and
416 for a valid range. Invalid input is ignored before deciding whether the
representation is empty. Parsing is limited to 128 bytes; forwarded valid
values are canonical and bounded.

If-Range deliberately cannot match a NAS stat-v1 value. That value detects
filesystem changes but is not a strong HTTP representation validator, and no
ETag or Last-Modified guarantee is added here. A full response still uses the
existing pinned source version and checks the opened file before/after reads;
it does not rebind the playback grant to a replacement file.

Worker normalizes request headers before dispatch. This also avoids asking an
older Agent to interpret an unsupported range. New Agent code independently
handles HEAD and range syntax from an older Worker. An older Worker cannot
forward information it never carried: correct If-Range/repeated-header behavior
therefore requires the new Worker. No new Agent capability or message field is
introduced. The Agent sends zero body bytes for 416; the Worker retains the
existing API error middleware, which replaces the empty error with bounded
`RANGE_NOT_SATISFIABLE` JSON and a matching diagnostic request ID. Its HTTP
Content-Length describes that error JSON, not a media payload.

The same relay handles direct playback, authorized /source reads used by
FFprobe/FFmpeg, and preview input. HEAD and rejected ranges do not become NAS
body metrics. A successful full/partial body retains its exact successful-send
measurement; response completion still does not substitute for resource drain.

## Validation boundary

Shared range tests and the existing local file/If-Range/empty/version-change
tests cover the selector. The finite actual Server/Worker/Agent fixture is
`tests/nas-range-semantics.mjs`; its frozen-source report records whether that
candidate ran successfully. Windows `tests/agent-native.mjs` now expects full
metadata for HEAD+Range, but editing or syntax-checking it is not a Windows
execution result. Device, network-filesystem and sustained-transfer acceptance
remain separate.

The finite frozen-source run `b22caf4e-3e3b-41e6-9021-1292f6002f08` passed all
six groups: 20 advertised-file/source cases, five indexed empty-file cases,
three explicitly injected legacy control requests handled by the real Agent,
actual FFprobe input, actual preview decode, and authorization/drain checks.
The 3,285-byte generated H.264 file and every successful response were compared
byte-for-byte. The preview decoded to the expected red pixels. All 30 transfer
records reached a terminal state; all 29 session-scoped transfers also had the
independent Agent drain receipt. The other transfer was the actual preview.

The report SHA256 is
`4aa0581d4cb7d90693d9f662fc75d5c3cbd9a36afcb88e0d3cad644d5acf6eb1`.
Its unchanged 192 backend inputs have source digest
`25d7d65be7a31fb08dde3b1cd4014a7915b3e0ff4c640ed98b39491dd5ec23e7`;
the three executed binary hashes were checked before and after the run. The
fixture positively checked its Server, Worker, Agent, FFmpeg/FFprobe children,
PostgreSQL, listeners and sockets closed. This is a finite loopback test, not
independent physical-device or sustained-transfer acceptance.

Earlier failed reports are retained: the initial fixture incorrectly assumed
the advertised direct URL ended in /source instead of /file; the next version
incorrectly expected the public 416 response to omit the standard API error
JSON. The corrected fixture separately verifies actual HTTP and Agent wire
bodies. Neither correction changed production delivery or relaxed successful
media-byte checks. The Windows fixture was syntax-checked only.
