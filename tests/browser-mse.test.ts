import { afterEach, expect, it, vi } from "vitest";
import {
  getPlaybackMediaSource,
  hasPlaybackMseApi,
  supportsHlsPlayback,
} from "../apps/web/src/features/playback/browser-mse";

afterEach(() => vi.unstubAllGlobals());
it("prefers Apple's ManagedMediaSource and falls back to standard and WebKit constructors", () => {
  const managed = { isTypeSupported: () => true },
    standard = {},
    webkit = {};
  const host: any = {
    ManagedMediaSource: managed,
    MediaSource: standard,
    WebKitMediaSource: webkit,
  };
  vi.stubGlobal("self", host);
  expect(getPlaybackMediaSource()).toBe(managed);
  delete host.ManagedMediaSource;
  expect(getPlaybackMediaSource()).toBe(standard);
  delete host.MediaSource;
  expect(getPlaybackMediaSource()).toBe(webkit);
  delete host.WebKitMediaSource;
  expect(getPlaybackMediaSource()).toBeUndefined();
  expect(hasPlaybackMseApi()).toBe(false);
});
it("allows unexposed SourceBuffer while requiring append and remove when exposed", () => {
  const host: any = { MediaSource: { isTypeSupported: () => true } };
  vi.stubGlobal("self", host);
  expect(hasPlaybackMseApi()).toBe(true);
  host.SourceBuffer = { prototype: { appendBuffer() {} } };
  expect(hasPlaybackMseApi()).toBe(false);
  host.SourceBuffer.prototype.remove = () => {};
  expect(hasPlaybackMseApi()).toBe(true);
  host.WebKitSourceBuffer = host.SourceBuffer;
  delete host.SourceBuffer;
  expect(hasPlaybackMseApi()).toBe(true);
  host.WebKitSourceBuffer.prototype.remove = undefined;
  expect(supportsHlsPlayback()).toBe(false);
});
it("probes the installed HLS SDK's exact video and audio MIME forms without importing it", () => {
  const probe = vi.fn((mime: string) => mime === "audio/mp4;codecs=fLaC");
  vi.stubGlobal("self", { MediaSource: { isTypeSupported: probe } });
  expect(supportsHlsPlayback()).toBe(true);
  expect(probe.mock.calls.map(([mime]) => mime)).toEqual([
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=av01.0.01M.08",
    "video/mp4;codecs=vp09.00.50.08",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4;codecs=fLaC",
  ]);
  probe.mockReturnValue(false);
  expect(supportsHlsPlayback()).toBe(false);
  vi.stubGlobal("self", { MediaSource: {} });
  expect(supportsHlsPlayback()).toBe(false);
});
