import { describe, expect, test } from "vitest";
import type {
  PlaybackObservation,
  PlaybackPlan,
  PlaybackRequest,
} from "../../../../../packages/protocol";
import {
  classifyStaticHlsDecodeFailure,
  createStaticHlsChildIntentState,
  type StaticHlsFailureEvent,
  type StaticHlsPlanBinding,
} from "./static-hls-child-intent";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
type ProposalInput = Parameters<
  ReturnType<typeof createStaticHlsChildIntentState>["propose"]
>[0];

function fixture(
  edit?: (
    plan: PlaybackPlan & { static_hls_fallback_version?: unknown },
    request: PlaybackRequest,
  ) => void,
) {
  const plan: PlaybackPlan & { static_hls_fallback_version?: unknown } = {
    session_id: id(2),
    media_id: id(3),
    media_generation: 7,
    plan_generation: 9,
    delivery_mode: "direct",
    transport: "hls",
    playback_url: "/stream/parent.m3u8",
    timeline_origin_ms: 0,
    duration_ms: 10_000,
    expires_in_seconds: 600,
    rebuild_on_seek: false,
    audio_tracks: [],
    subtitle_tracks: [],
    selected_audio_track: 4,
    decoder_fallback_modes: ["transcode"],
    observation_version: 1,
    observation_seq: 12,
    static_hls_fallback_version: 1,
  };
  const request: PlaybackRequest = {
    static_hls_fallback_version: 1,
    idempotency_key: id(1),
    viewer_id: id(8),
    plan_generation: 9,
    room_id: id(5),
    media_generation: 7,
    mode: "auto",
    position_ms: 0,
    audio_index: null,
    capabilities: {
      progressive_h264_aac: true,
      native_hls: true,
      mse_h264_aac: false,
    },
    observation_version: 1,
    playback_metrics_version: 1,
    playback_metrics_supported_versions: [1, 2],
    playback_metrics: {
      meter_start_generation: 9,
      startup_origin: "user_intent",
    },
  };
  edit?.(plan, request);
  const current: StaticHlsPlanBinding = Object.freeze({
    plan,
    attachment: {},
    room_id: request.room_id,
    media_id: plan.media_id,
    media_generation: plan.media_generation,
    viewer_id: request.viewer_id!,
    plan_generation: plan.plan_generation!,
  });
  const state = createStaticHlsChildIntentState({ plan, request });
  const input: ProposalInput = {
    current,
    failure: { binding: current, event: { kind: "native", code: 3 } },
    child: { viewer_id: id(8), plan_generation: 10, idempotency_key: id(12) },
    position_ms: 2400.5,
    final_observation: null,
  };
  const childCurrent = { ...current, plan_generation: 10 };
  const propose = (overrides: Partial<ProposalInput> = {}) =>
    state.propose({ ...input, ...overrides });
  return { plan, request, current, state, input, childCurrent, propose };
}

function sample(): PlaybackObservation {
  return {
    media_generation: 7,
    seq: 13,
    event: "progress",
    media_time_ms: 2400.5,
    paused: false,
    seeking: false,
    buffering: true,
    playback_rate: 1.05,
    has_played: true,
  };
}

describe("static-HLS decoder classification", () => {
  test("only native decoder code 3 qualifies", () => {
    expect(classifyStaticHlsDecodeFailure({ kind: "native", code: 3 })).toEqual(
      { kind: "native_decode", code: 3 },
    );
    for (const code of [0, 1, 2, 4, NaN, Infinity])
      expect(
        classifyStaticHlsDecodeFailure({ kind: "native", code }),
      ).toBeUndefined();
  });

  test.each([
    "fragParsingError",
    "manifestIncompatibleCodecsError",
    "bufferAddCodecError",
    "bufferIncompatibleCodecsError",
    "bufferAppendError",
    "bufferAppendingError",
  ])("current fatal media/decode detail %s qualifies", (details) => {
    expect(
      classifyStaticHlsDecodeFailure({
        kind: "hls",
        fatal: true,
        type: "mediaError",
        details,
      }),
    ).toEqual({ kind: "hls_media_decode" });
  });

  const notDecode: StaticHlsFailureEvent[] = [
    { kind: "network" },
    { kind: "authorization" },
    { kind: "timeout" },
    { kind: "unsupported_timeline" },
    { kind: "native", code: 3, classification: "authorization" },
    { kind: "native", code: 3, classification: "timeout" },
    { kind: "native", code: 3, classification: "network" },
    {
      kind: "hls",
      fatal: false,
      type: "mediaError",
      details: "bufferAppendError",
    },
    {
      kind: "hls",
      fatal: true,
      type: "networkError",
      details: "fragParsingError",
    },
    { kind: "hls", fatal: true, type: "muxError", details: "fragParsingError" },
    {
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "fragLoadTimeOut",
    },
    {
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "bufferStalledError",
    },
    {
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "bufferFullError",
    },
    {
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "bufferSeekOverHole",
    },
    {
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "unknownFutureDecode",
    },
    {
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "bufferAppendError",
      media_error_code: 4,
    },
    {
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "bufferAppendError",
      classification: "unsupported_timeline",
    },
    ...[
      "QuotaExceededError",
      "AbortError",
      "SecurityError",
      "NotAllowedError",
      "TimeoutError",
      "NetworkError",
    ].map((error_name): StaticHlsFailureEvent => ({
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "bufferAppendError",
      error_name,
    })),
    ...[0, 401, 403, 408, 409, 500, NaN].map((code): StaticHlsFailureEvent => ({
      kind: "hls",
      fatal: true,
      type: "mediaError",
      details: "bufferAppendError",
      response: { code },
    })),
  ];
  test.each(notDecode)(
    "refuses non-decode or mixed classification %#",
    (event) => {
      expect(classifyStaticHlsDecodeFailure(event)).toBeUndefined();
      const s = fixture();
      expect(s.propose({ failure: { binding: s.current, event } })).toEqual({
        kind: "refused",
        reason: "failure_not_decode",
      });
      expect(s.state.status).toBe("unused");
    },
  );
});

test("constructs only the closed Server lookup and explicit null observation", () => {
  const s = fixture();
  const result = s.propose();
  expect(result.kind).toBe("proposed");
  if (result.kind !== "proposed") throw new Error("expected a child intent");
  const { request, body } = result.intent;
  expect(request.static_hls_fallback).toEqual({
    parent_session_id: id(2),
    failure: { kind: "native_decode", code: 3 },
    final_observation: null,
  });
  expect(request).toMatchObject({
    mode: "transcode",
    static_hls_fallback_version: 1,
    viewer_id: id(8),
    plan_generation: 10,
    idempotency_key: id(12),
    room_id: id(5),
    media_generation: 7,
    audio_index: null,
    position_ms: 2400.5,
  });
  expect(JSON.parse(body)).toEqual(request);
  for (const name of [
    "root",
    "owner",
    "source",
    "root_digest",
    "capture_id",
    "url",
    "request_owner_epoch",
    "http_file_fallback_version",
    "http_file_fallback",
    "upstream_profile_report",
    "candidate_report",
  ])
    expect(Object.hasOwn(request, name)).toBe(false);
  expect(Object.keys(request.static_hls_fallback)).toEqual([
    "parent_session_id",
    "failure",
    "final_observation",
  ]);
});

test("a current fatal HLS decoder event produces only the closed HLS failure variant", () => {
  const s = fixture();
  const result = s.propose({
    failure: {
      binding: s.current,
      event: {
        kind: "hls",
        fatal: true,
        type: "mediaError",
        details: "bufferAppendError",
        response: { code: 200 },
        media_error_code: 3,
      },
    },
  });
  if (result.kind !== "proposed") throw new Error("expected a child intent");
  expect(result.intent.request.static_hls_fallback.failure).toEqual({
    kind: "hls_media_decode",
  });
});

test.each([undefined, null, 0, 2, "1", true])(
  "a missing/unsupported actual plan marker %s never offers a child",
  (marker) => {
    const s = fixture((plan) => {
      Object.assign(plan, { static_hls_fallback_version: marker });
    });
    expect(s.propose()).toEqual({ kind: "refused", reason: "unmarked_parent" });
  },
);

test("a request opt-in, inherited marker or late-added marker cannot manufacture a parent offer", () => {
  const inherited = fixture((plan) => {
    delete plan.static_hls_fallback_version;
    Object.setPrototypeOf(plan, { static_hls_fallback_version: 1 });
  });
  expect(inherited.propose()).toEqual({
    kind: "refused",
    reason: "unmarked_parent",
  });
  const late = fixture((plan) => {
    delete plan.static_hls_fallback_version;
  });
  late.plan.static_hls_fallback_version = 1;
  expect(late.propose()).toEqual({
    kind: "refused",
    reason: "unmarked_parent",
  });
});

test.each([
  "room_id",
  "media_id",
  "viewer_id",
  "media_generation",
  "plan_generation",
] as const)("current %s must match the original parent intent", (field) => {
  const s = fixture();
  const current = {
    ...s.current,
    [field]: typeof s.current[field] === "string" ? id(99) : 99,
  };
  expect(
    s.propose({
      current,
      failure: { binding: current, event: { kind: "native", code: 3 } },
    }),
  ).toEqual({ kind: "refused", reason: "stale_plan" });
});

test("same IDs on a replacement plan and stale attachment callbacks are refused", () => {
  const s = fixture();
  const replacement = { ...s.current, plan: { ...s.plan } };
  expect(
    s.propose({
      current: replacement,
      failure: { binding: replacement, event: { kind: "native", code: 3 } },
    }),
  ).toEqual({ kind: "refused", reason: "stale_plan" });
  const newAttachment = { ...s.current, attachment: {} };
  expect(s.propose({ current: newAttachment })).toEqual({
    kind: "refused",
    reason: "stale_plan",
  });
  expect(
    s.propose({
      current: newAttachment,
      failure: { binding: newAttachment, event: { kind: "native", code: 3 } },
    }).kind,
  ).toBe("proposed");
});

test("changing immutable plan facts or withdrawing the actual marker fences callbacks", () => {
  for (const change of [
    (s: ReturnType<typeof fixture>) => {
      s.plan.session_id = id(99);
    },
    (s: ReturnType<typeof fixture>) => {
      s.plan.media_id = id(99);
    },
    (s: ReturnType<typeof fixture>) => {
      s.plan.plan_generation = 10;
    },
    (s: ReturnType<typeof fixture>) => {
      s.plan.transport = "progressive";
    },
    (s: ReturnType<typeof fixture>) => {
      delete s.plan.static_hls_fallback_version;
    },
  ]) {
    const s = fixture();
    change(s);
    expect(s.propose()).toEqual({ kind: "refused", reason: "stale_plan" });
  }
});

test("parent request/plan must be the matching negotiated nonrecursive HLS route", () => {
  const changes = [
    (_: PlaybackPlan, request: PlaybackRequest) => {
      delete request.static_hls_fallback_version;
    },
    (_: PlaybackPlan, request: PlaybackRequest) => {
      request.plan_generation = 8;
    },
    (_: PlaybackPlan, request: PlaybackRequest) => {
      request.media_generation = 8;
    },
    (_: PlaybackPlan, request: PlaybackRequest) => {
      request.viewer_id = "00000000-0000-0000-0000-000000000000";
    },
    (_: PlaybackPlan, request: PlaybackRequest) => {
      request.http_file_fallback_version = 1;
    },
    (_: PlaybackPlan, request: PlaybackRequest) => {
      request.mode = "transcode";
    },
    (plan: PlaybackPlan) => {
      plan.http_file_fallback_version = 1;
    },
    (plan: PlaybackPlan) => {
      plan.delivery_mode = "transcode";
    },
    (plan: PlaybackPlan) => {
      plan.selected_candidate_id = "candidate";
    },
    (_: PlaybackPlan, request: PlaybackRequest) => {
      request.capabilities!.native_hls = false;
    },
    (_: PlaybackPlan, request: PlaybackRequest) => {
      request.capabilities!.report = { schema_version: 1, candidates: [] };
    },
  ];
  for (const change of changes) {
    const s = fixture(change);
    expect(s.propose()).toEqual({ kind: "refused", reason: "invalid_parent" });
  }
});

test("the dedicated marker needs no legacy generic decoder-fallback modes", () => {
  const s = fixture((plan) => {
    plan.decoder_fallback_modes = [];
  });
  expect(s.propose().kind).toBe("proposed");
});

test("invalid metrics negotiation never becomes a frozen child request", () => {
  for (const edit of [
    (request: PlaybackRequest) => {
      request.playback_metrics_version = 2;
    },
    (request: PlaybackRequest) => {
      delete request.playback_metrics;
    },
    (request: PlaybackRequest) => {
      request.playback_metrics!.meter_start_generation = 10;
    },
    (request: PlaybackRequest) => {
      request.playback_metrics_supported_versions = [];
    },
    (request: PlaybackRequest) => {
      request.playback_metrics_supported_versions = [1, 1];
    },
    (request: PlaybackRequest) => {
      request.playback_metrics_supported_versions = [1, 2, 3];
    },
  ]) {
    const s = fixture((_, request) => edit(request));
    expect(s.propose()).toEqual({ kind: "refused", reason: "invalid_parent" });
  }
  const noMetrics = fixture((_, request) => {
    delete request.playback_metrics_version;
    delete request.playback_metrics;
    delete request.playback_metrics_supported_versions;
  });
  const result = noMetrics.propose();
  if (result.kind !== "proposed") throw new Error("expected a child intent");
  expect(Object.hasOwn(result.intent.request, "playback_metrics_version")).toBe(
    false,
  );
});

test("preserves the original default or explicit audio intent and HLS/metrics snapshot", () => {
  for (const audio of [null, 2]) {
    const s = fixture((_, request) => {
      request.audio_index = audio;
      request.capabilities!.native_hls = false;
      request.capabilities!.mse_h264_aac = true;
    });
    s.request.audio_index = 99;
    s.request.capabilities!.mse_h264_aac = false;
    s.request.playback_metrics!.meter_start_generation = 99;
    s.request.playback_metrics_supported_versions!.push(99);
    const result = s.propose();
    if (result.kind !== "proposed") throw new Error("expected a child intent");
    expect(result.intent.request.audio_index).toBe(audio);
    expect(result.intent.request.capabilities.mse_h264_aac).toBe(true);
    expect(result.intent.request.playback_metrics!.meter_start_generation).toBe(
      9,
    );
    expect(result.intent.request.playback_metrics_supported_versions).toEqual([
      1, 2,
    ]);
  }
});

test("requires the same viewer, a strictly newer bounded generation and a canonical new key", () => {
  const bad = [
    { viewer_id: id(99) },
    { plan_generation: 9 },
    { plan_generation: 0 },
    { plan_generation: 1.5 },
    { plan_generation: 0x1_0000_0000 },
    { idempotency_key: "00000000-0000-0000-0000-000000000000" },
    { idempotency_key: "00000000-0000-0000-0000-00000000000A" },
    { idempotency_key: id(1) },
  ];
  for (const fields of bad) {
    const s = fixture();
    expect(s.propose({ child: { ...s.input.child, ...fields } })).toEqual({
      kind: "refused",
      reason: "invalid_child",
    });
  }
  for (const position_ms of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const s = fixture();
    expect(s.propose({ position_ms })).toEqual({
      kind: "refused",
      reason: "invalid_child",
    });
  }
});

test("captures a real bound observation once and freezes every outbound nested value", () => {
  const s = fixture();
  const actual = sample();
  const result = s.propose({
    final_observation: { binding: s.current, sample: actual },
  });
  if (result.kind !== "proposed") throw new Error("expected a child intent");
  const intent = result.intent;
  actual.media_time_ms = 9000;
  actual.seq = 99;
  expect(intent.request.static_hls_fallback.final_observation).toEqual(
    sample(),
  );
  for (const value of [
    intent,
    intent.request,
    intent.request.capabilities,
    intent.request.playback_metrics,
    intent.request.playback_metrics_supported_versions,
    intent.request.static_hls_fallback,
    intent.request.static_hls_fallback.failure,
    intent.request.static_hls_fallback.final_observation,
  ])
    expect(Object.isFrozen(value)).toBe(true);
});

test("refuses missing, stale or invalid final observations rather than inventing a sample", () => {
  const changes: Partial<PlaybackObservation>[] = [
    { media_generation: 8 },
    { seq: 0 },
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { media_time_ms: -1 },
    { media_time_ms: NaN },
    { media_time_ms: 11_001 },
    { playback_rate: 0.23749 },
    { playback_rate: 4.20001 },
  ];
  for (const change of changes) {
    const s = fixture();
    expect(
      s.propose({
        final_observation: {
          binding: s.current,
          sample: { ...sample(), ...change },
        },
      }),
    ).toEqual({ kind: "refused", reason: "invalid_observation" });
  }
  const s = fixture();
  expect(s.propose({ final_observation: undefined })).toEqual({
    kind: "refused",
    reason: "invalid_observation",
  });
  expect(
    s.propose({
      final_observation: {
        binding: { ...s.current, attachment: {} },
        sample: sample(),
      },
    }),
  ).toEqual({ kind: "refused", reason: "invalid_observation" });
  const noObservations = fixture((plan) => {
    delete plan.observation_version;
  });
  expect(
    noObservations.propose({
      final_observation: { binding: noObservations.current, sample: sample() },
    }),
  ).toEqual({ kind: "refused", reason: "invalid_observation" });
  expect(noObservations.propose().kind).toBe("proposed");
});

test("one accepted attempt cannot be replaced by a new key, source callback or updated payload", () => {
  const s = fixture();
  const first = s.propose();
  if (first.kind !== "proposed") throw new Error("expected a child intent");
  expect(s.propose()).toEqual({ kind: "refused", reason: "already_proposed" });
  expect(
    s.propose({
      child: { ...s.input.child, idempotency_key: id(13), plan_generation: 11 },
      position_ms: 9999,
    }),
  ).toEqual({ kind: "refused", reason: "already_proposed" });
  // Server may already have consumed/stopped the parent after a lost response.
  delete s.plan.static_hls_fallback_version;
  const retry = s.state.retry(s.childCurrent);
  expect(retry).toBe(first.intent);
  expect(s.state.retry(s.childCurrent)).toBe(first.intent);
  expect(retry?.request.idempotency_key).toBe(id(12));
  expect(retry?.request.position_ms).toBe(2400.5);
  expect(retry?.body).toBe(first.intent.body);
});

test("retry is fenced by the accepted child intent and close is irreversible", () => {
  const s = fixture();
  expect(s.state.retry(s.childCurrent)).toBeUndefined();
  expect(s.propose().kind).toBe("proposed");
  expect(s.state.retry(s.current)).toBeUndefined();
  for (const field of [
    "room_id",
    "media_id",
    "viewer_id",
    "media_generation",
    "plan_generation",
  ] as const) {
    const current = {
      ...s.childCurrent,
      [field]: typeof s.childCurrent[field] === "string" ? id(99) : 99,
    };
    expect(s.state.retry(current)).toBeUndefined();
  }
  s.state.close();
  s.state.close();
  expect(s.state.status).toBe("closed");
  expect(s.state.retry(s.childCurrent)).toBeUndefined();
  expect(s.propose()).toEqual({ kind: "refused", reason: "closed" });
});

test("normalizes negative zero without substituting room time for media observations", () => {
  const s = fixture();
  const result = s.propose({
    position_ms: -0,
    final_observation: {
      binding: s.current,
      sample: { ...sample(), media_time_ms: -0 },
    },
  });
  if (result.kind !== "proposed") throw new Error("expected a child intent");
  expect(Object.is(result.intent.request.position_ms, -0)).toBe(false);
  expect(
    Object.is(
      result.intent.request.static_hls_fallback.final_observation!
        .media_time_ms,
      -0,
    ),
  ).toBe(false);
});
