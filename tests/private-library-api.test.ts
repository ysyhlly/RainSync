import { describe, it, expect } from "vitest";
import { privateLibraryApi } from "../apps/web/src/features/private-library/private-library.api";
import type { ApiClient } from "../apps/web/src/shared/api/client";
describe("scoped library API", () => {
  it("never takes the caller identity from request bodies and encodes resource paths", async () => {
    const calls: unknown[][] = [];
    const api = privateLibraryApi((async (...args: unknown[]) => {
      calls.push(args);
      return {};
    }) as ApiClient);
    await api.grant("library/id", {
      username: "viewer",
      browse: false,
      play: true,
      share_to_room: false,
      manage: false,
      expires_in_hours: 24,
      expected_revision: "2",
    });
    await api.revoke("library/id", "user/id", "3");
    expect(calls[0]).toEqual([
      "/libraries/library%2Fid/grants",
      "POST",
      {
        username: "viewer",
        browse: false,
        play: true,
        share_to_room: false,
        manage: false,
        expires_in_hours: 24,
        expected_revision: "2",
      },
    ]);
    expect(calls[1]).toEqual([
      "/libraries/library%2Fid/grants/user%2Fid",
      "DELETE",
      { expected_revision: "3" },
    ]);
  });
  it("uses explicit room audience, deadlines and resumable scan intent", async () => {
    const calls: unknown[][] = [];
    const api = privateLibraryApi((async (...args: unknown[]) => {
      calls.push(args);
      return {};
    }) as ApiClient);
    await api.share("library", {
      room_id: "room",
      media_id: "media",
      mode: "library_members",
      expires_in_minutes: 60,
      expected_revision: "4",
    });
    await api.scan("library", "source");
    await api.scan("library", "source", true);
    expect(calls[0]?.[2]).toEqual({
      room_id: "room",
      media_id: "media",
      mode: "library_members",
      expires_in_minutes: 60,
      expected_revision: "4",
    });
    expect(calls[1]?.[2]).toEqual({ restart: false });
    expect(calls[2]?.[2]).toEqual({ restart: true });
  });
});

it("uses scoped CAS paths for source settings, tombstones and share edits", async () => {
  const calls: unknown[][] = [];
  const api = privateLibraryApi((async (...args: unknown[]) => {
    calls.push(args);
    return {};
  }) as ApiClient);
  await api.sourceSettings("lib/id", "src/id");
  await api.updateSource("lib/id", "src/id", {
    expected_revision: "6",
    name: "Renamed",
  });
  await api.removeSource("lib/id", "src/id", "7", "8");
  await api.remove("lib/id", "9");
  await api.updateShare("lib/id", "share/id", {
    expected_revision: "10",
    mode: "library_members",
    expires_at: 12345,
  });
  expect(calls[0]?.[0]).toBe("/libraries/lib%2Fid/sources/src%2Fid");
  expect(calls[1]).toEqual([
    "/libraries/lib%2Fid/sources/src%2Fid",
    "PATCH",
    { expected_revision: "6", name: "Renamed" },
  ]);
  expect(calls[2]?.[2]).toEqual({
    expected_revision: "7",
    expected_library_revision: "8",
  });
  expect(calls[3]).toEqual([
    "/libraries/lib%2Fid",
    "DELETE",
    { expected_revision: "9" },
  ]);
  expect(calls[4]?.[0]).toBe("/libraries/lib%2Fid/room-shares/share%2Fid");
});
