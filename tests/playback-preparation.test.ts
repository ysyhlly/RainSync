import { expect, it } from "vitest";
import type { PlaybackReadiness } from "../packages/protocol";
import { RequestFailure } from "../apps/web/src/errors";
import { PlaybackTimeout } from "../apps/web/src/playback-request";
import {
  applyPreparationSnapshot,
  describePlaybackPreparation,
  preparationFailure,
  preparationReadinessSnapshot,
  playbackFailureOwnsNotice,
  type PlaybackPreparationState,
} from "../apps/web/src/features/playback/playback-preparation";

it("maps observed readiness without inventing processing from the requested mode", () => {
  const ready = {
    session_id: "s",
    plan_generation: 4,
    status: "preparing",
  } as PlaybackReadiness;
  expect(preparationReadinessSnapshot(ready, "transcode")?.phase).toBe(
    "transcoding",
  );
  expect(preparationReadinessSnapshot(ready, "audio_transcode")?.phase).toBe(
    "transcoding",
  );
  expect(preparationReadinessSnapshot(ready, "remux")?.phase).toBe("preparing");
  expect(preparationReadinessSnapshot(ready)?.phase).toBe("preparing");
  expect(
    preparationReadinessSnapshot({ ...ready, status: "queued" }, "transcode")
      ?.phase,
  ).toBe("queued");
  expect(
    preparationReadinessSnapshot(
      { ...ready, status: "ready", complete: false },
      "transcode",
    )?.phase,
  ).toBe("ready");
  expect(
    preparationReadinessSnapshot(
      { ...ready, plan_generation: undefined },
      "transcode",
    ),
  ).toBeUndefined();
  expect(
    preparationReadinessSnapshot({ ...ready, status: "unknown" as any }),
  ).toBeUndefined();
});

it("owns only its original playback notice and keeps raw text out of serialization", () => {
  const failure = preparationFailure(new TypeError("Failed to fetch"));
  expect(playbackFailureOwnsNotice(failure, "Failed to fetch")).toBe(true);
  expect(playbackFailureOwnsNotice(failure, "房间连接中断")).toBe(false);
  expect(playbackFailureOwnsNotice(undefined, "Failed to fetch")).toBe(false);
  expect(JSON.stringify(failure)).not.toContain("Failed to fetch");
});

it("rejects obsolete generations, another session and updates after cancellation/failure", () => {
  const current: PlaybackPreparationState = {
    phase: "queued",
    generation: 4,
    sessionId: "s",
  };
  for (const snapshot of [
    { generation: 3, sessionId: "s", phase: "ready" as const },
    { generation: 4, sessionId: "other", phase: "ready" as const },
    { generation: NaN, sessionId: "s", phase: "ready" as const },
    { generation: 4, sessionId: "s", phase: "invented" as any },
  ])
    expect(applyPreparationSnapshot(current, snapshot)).toBe(current);
  for (const phase of ["idle", "cancelling", "cancelled", "failed"] as const) {
    const stopped = { ...current, phase };
    expect(
      applyPreparationSnapshot(stopped, {
        generation: 4,
        sessionId: "s",
        phase: "ready",
      }),
    ).toBe(stopped);
  }
  expect(
    applyPreparationSnapshot(current, {
      generation: 4,
      sessionId: "s",
      phase: "transcoding",
    }).phase,
  ).toBe("transcoding");
});

it("keeps server retry authority and diagnostics while hiding raw messages and unknown codes", () => {
  const failure = preparationFailure(
    new RequestFailure({
      error: {
        code: "MEDIA_JOB_FAILED",
        message:
          "https://private.invalid/file?token=secret C:\\private\\source.mkv",
        retryable: false,
        request_id: "00000000-0000-4000-8000-000000000000",
        retry_after_ms: 3210,
      },
    }),
  );
  expect(failure).toMatchObject({
    retryable: false,
    requestId: "00000000-0000-4000-8000-000000000000",
    retryAfterMs: 3210,
  });
  expect(failure.message).not.toMatch(/secret|private/);
  expect(describePlaybackPreparation({ phase: "failed", failure }).retry).toBe(
    false,
  );
  const unknown = preparationFailure(
    new RequestFailure({
      error: { code: "https://private/?secret", retryable: true },
    }),
  );
  expect(unknown.code).toBeUndefined();
  expect(unknown.message).not.toContain("private");
});

it("distinguishes network/timeout failures and exposes bounded user actions", () => {
  expect(
    preparationFailure(new TypeError("sensitive transport detail")).message,
  ).toContain("网络");
  expect(preparationFailure(new PlaybackTimeout()).message).toContain("超时");
  expect(describePlaybackPreparation({ phase: "cancelling" })).toMatchObject({
    busy: true,
    cancel: false,
    retry: false,
  });
  expect(describePlaybackPreparation({ phase: "cancelled" })).toMatchObject({
    busy: false,
    cancel: false,
    retry: true,
  });
  expect(describePlaybackPreparation({ phase: "ready" })).toMatchObject({
    label: "可播放",
    cancel: false,
    retry: false,
  });
});

it("uses one typed platform error in notices and the player, with account recovery", () => {
  const error = new RequestFailure({
    error: {
      code: "NATIVE_PLATFORM_ACCESS_DENIED",
      message: "https://private.invalid/?token=secret",
      retryable: false,
      request_id: "00000000-0000-4000-8000-000000000000",
    },
  });
  const failure = preparationFailure(error);
  expect(failure.message).toContain("平台拒绝访问此视频");
  expect(error.message).toBe(
    failure.message + `（诊断编号：${failure.requestId}）`,
  );
  expect(
    describePlaybackPreparation({ phase: "failed", failure }),
  ).toMatchObject({
    account: true,
    chooseMedia: true,
    retry: false,
  });
});
