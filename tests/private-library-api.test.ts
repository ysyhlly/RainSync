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
