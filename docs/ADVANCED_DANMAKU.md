# Bilibili advanced danmaku

Renderer version 3 adds Script, BAS and interactive command data to the existing
viewer-owned native-platform text grant. Version 1 still receives exactly plain
cues; version 2 retains the positioned-text contract and excludes programs and
commands. No database migration is required.

## Fetch and ownership

The current and previous six-minute `seg.so` packages supply normal and Script
comments. `x/v2/dm/web/view?type=1&oid=<sealed cid>` supplies special-package
references and command metadata. Only metadata-owned HTTPS URLs on
`i0/i1/i2.hdslb.com/bfs/dm/<bounded name>.bin` are admitted, with the existing
public DNS pinning, TLS, redirect and size checks. Special packages span the
film; the server retains only the requested segment and its 120-second leading
overlap. At most four special packages are fetched. Metadata/package errors
produce an explicit warning while preserving normal comments.

The existing immutable viewer, account, media and room gate is checked before
each upstream request and before the response. No credentials go to special
CDNs. There is no cross-viewer cache, automatic login retry, comment publication,
raw action URL, author hash, remote image or upstream style in a response.

Programs are source data, at most 32 KiB each and 256 KiB combined, with at most
32 advanced cues per snapshot. A snapshot owns one module Worker, which runs an
independent bounded interpreter and returns display data. It is terminated on
completion, failure, a 1.5-second timeout, cancellation or runtime disposal.
Neither interpreter uses `eval`, `Function`, the DOM, ambient globals or network
APIs. Media replacement, logout and disabling danmaku discard pending results.

## Rendering and language support

BAS supports text, paths, buttons, percentage and pixel coordinates, local font
selection, anchors, opacity, colors, text strokes, scale, 3D rotations, parents,
z-order, definitions, templates, positional/named arguments, clones, anonymous
instances, concurrent groups, sequential `then`, per-property easing and compound
time values. SVG is constructed from validated path data; upstream markup is
never inserted. Immutable properties in `set` are ignored. Text and font-size
changes occur at the beginning of a set, as specified by BAS.

The Script interpreter supports ECMAScript expressions, variables, functions,
closures, conditionals, bounded loops, arrays and common string/Math operations;
`$/Display` text, buttons, groups and basic vector graphics; timed text/property
changes; `Utils` timers and intervals; linear and standard polynomial,
circular, sine and exponential tweens, with `to`, `delay`, `repeat`, `serial`,
`parallel` and `play`. Script uses a 672-by-438 logical stage scaled to the video
content rectangle. Random values are reproducible across replay.

Script is a display interpreter, not the complete Flash/AS3 runtime. Native
classes, bitmap/network/storage APIs, arbitrary event/game callbacks, custom
easing functions and automatic playback control are not supported. Unsupported
syntax and programs exceeding a bound produce a visible notice; normal danmaku
continue. The current mode-7 normalized position subset is unchanged; complex
mode-7 paths/perspective still use the existing plain-text fallback.

Scene limits are 120 seconds, 128 objects, 1024 animation tracks, 16 parent
levels, 100,000 Script instructions, 32 call frames and 2048 timer callbacks.
Rendering admits at most four concurrent advanced cues and 256 scene objects.
No scene continues running while the video is paused: position, animation,
opacity and timed creation are sampled from the native video clock. Backwards
seeks restore the corresponding state; playback rate, resize, reduced motion
and compatibility seek origins are respected.

## Interaction

BAS buttons and simple Script click handlers supply typed seek, Bilibili video
or episode targets. Seek is emitted only after an explicit click and passes
through the existing room controller, with ownership/connection/live/duration
checks. Other targets open an exact canonical Bilibili URL in a new window with
`noopener noreferrer`; arbitrary URLs are refused.

`#LINK#`, `#UP#`, `#ATTENTION#` and `#VOTE#` metadata produce timed labels and
buttons; vote option text is shown. Following, voting and account operations
are completed on the original site. This implementation does not claim to
perform those operations inside RainSync or to recreate upstream avatar images.

## Validation

`tests/advanced-danmaku.test.ts` verifies language semantics, composition,
backwards seek, stable paused state, resize, program/action validation, hostile
input, instruction limits, worker cancellation and failure isolation. Provider
protobuf tests verify special packages, cid identity, commands, URL restrictions,
privacy and legacy contracts. Existing text/runtime tests cover source-time
mapping and asynchronous ownership.

`tests/advanced-danmaku-browser.mjs` runs the actual Vue components and module
Worker against a native finite HTMLVideoElement in desktop and mobile Chromium.
It uses controlled same-origin text fixtures, not production account writes or
an assertion that a specific live Bilibili video contains these comment types.

Language and wire references:

- [Official BAS reference](https://bilibili.github.io/bas/)
- [BiliScript display API reference](https://github.com/jabbany/CommentCoreLibrary/tree/master/docs/scripting)
- [Maintained protobuf schema](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/grpc_api/bilibili/community/service/dm/v1/dm.proto)
