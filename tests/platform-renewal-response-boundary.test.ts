import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ApiClient } from "../apps/web/src/shared/api/client";
import { RequestFailure } from "../apps/web/src/errors";
import {
  bilibiliRenewalApi,
  validateBilibiliRenewal,
  type BilibiliRenewalStatus,
} from "../apps/web/src/features/account/platform-renewal.api";

const account = {
  id: "00000000-0000-0000-0000-000000000001",
  provider: "bilibili",
  revision: "9007199254740993",
  state: "connected",
} as const;
const valid = {
  account,
  method: "web_cookie_refresh",
  supported: true,
  enabled: true,
  state: "scheduled",
  next_refresh_at: 1000,
  enable_requires: "new_consented_qr_login",
} as const;

describe("Bilibili renewal unknown response parser", () => {
  it.each([undefined, null, false, 7, "response", [], {}])(
    "rejects non-record or incomplete input %j",
    (raw) => expect(() => validateBilibiliRenewal(raw)).toThrow(/状态.*不完整/),
  );

  it("rejects decorated arrays at both DTO levels", () => {
    expect(() => validateBilibiliRenewal(Object.assign([], valid))).toThrow();
    expect(() =>
      validateBilibiliRenewal({
        ...valid,
        account: Object.assign([], account),
      }),
    ).toThrow();
  });

  for (const field of Object.keys(valid)) {
    it(`requires the complete renewal field ${field}`, () => {
      const raw: Record<string, unknown> = { ...valid };
      delete raw[field];
      expect(() => validateBilibiliRenewal(raw)).toThrow();
    });
  }
  for (const field of Object.keys(account)) {
    it(`requires the complete nested account field ${field}`, () => {
      const nested: Record<string, unknown> = { ...account };
      delete nested[field];
      expect(() =>
        validateBilibiliRenewal({ ...valid, account: nested }),
      ).toThrow("平台账号状态响应不完整");
    });
  }

  it.each([
    undefined,
    null,
    false,
    3,
    "account",
    [],
    {},
    { ...account, provider: "youtube" },
    { ...account, id: "not-a-uuid" },
    { ...account, id: null },
    { ...account, revision: null },
    { ...account, state: "authenticated" },
    { ...account, id: null, revision: null },
  ])(
    "validates the nested account with the existing account parser: %j",
    (nested) => {
      expect(() =>
        validateBilibiliRenewal({ ...valid, account: nested }),
      ).toThrow("平台账号状态响应不完整");
    },
  );

  it.each(["0", "00", "01", "-1", "1e3", "1.5", " 2", 2, 9007199254740992])(
    "rejects malformed nested revision %j without coercion",
    (revision) => {
      expect(() =>
        validateBilibiliRenewal({
          ...valid,
          account: { ...account, revision },
        }),
      ).toThrow("平台账号状态响应不完整");
    },
  );

  it.each(["1", "9007199254740993", "9223372036854775808"])(
    "preserves exact positive decimal revision %s without adding a numeric bound",
    (revision) => {
      expect(
        validateBilibiliRenewal({
          ...valid,
          account: { ...account, revision },
        }).account.revision,
      ).toBe(revision);
    },
  );

  it.each([
    { method: "qr_login" },
    { supported: false },
    { enabled: "true" },
    { state: "pending" },
    { state: 1 },
    { enable_requires: "existing_login" },
    { next_refresh_at: "1000" },
    { next_refresh_at: 0 },
    { next_refresh_at: -1 },
    { next_refresh_at: 1.5 },
    { next_refresh_at: NaN },
    { next_refresh_at: Infinity },
    { next_refresh_at: Number.MAX_SAFE_INTEGER + 1 },
  ])("preserves renewal field validation for %j", (patch) => {
    expect(() => validateBilibiliRenewal({ ...valid, ...patch })).toThrow(
      "自动续期状态不完整",
    );
  });

  it.each([
    ["disabled", false],
    ["scheduled", true],
    ["running", true],
    ["uncertain", false],
    ["reauthorization_required", false],
  ] as const)(
    "preserves %s/enabled=%s and independent nullable timestamps",
    (state, enabled) => {
      for (const next_refresh_at of [null, 1, Number.MAX_SAFE_INTEGER]) {
        const raw = { ...valid, state, enabled, next_refresh_at };
        expect(validateBilibiliRenewal(raw)).toEqual(raw);
        expect(() =>
          validateBilibiliRenewal({ ...raw, enabled: !enabled }),
        ).toThrow("自动续期状态不完整");
      }
    },
  );

  it("does not move account matching or enabled/connected UI policy into shape parsing", () => {
    for (const state of ["expired", "revoked"] as const) {
      const raw = { ...valid, account: { ...account, state } };
      expect(validateBilibiliRenewal(raw)).toEqual(raw);
      const absent = {
        ...raw,
        account: { ...raw.account, id: null, revision: null },
        enabled: false,
        state: "disabled",
      };
      expect(validateBilibiliRenewal(absent)).toEqual(absent);
    }
  });

  it("copies the complete whitelist at both levels without reading extra secrets", () => {
    const touch = vi.fn(() => {
      throw Error("secret getter must not run");
    });
    const nested = {
      ...account,
      revision: String(account.revision),
      refresh_token: "synthetic-nested-secret",
    };
    Object.defineProperty(nested, "cookie", { get: touch, enumerable: true });
    const raw = { ...valid, account: nested, cookie: "synthetic-root-secret" };
    Object.defineProperty(raw, "refresh_token", {
      get: touch,
      enumerable: true,
    });
    const parsed = validateBilibiliRenewal(raw);
    expect(parsed).toEqual(valid);
    // Keep assertion formatters away from the deliberately poisoned raw DTO.
    expect(parsed === raw).toBe(false);
    expect(parsed.account === nested).toBe(false);
    expect(touch).not.toHaveBeenCalled();
    expect(JSON.stringify(parsed)).not.toContain("secret");
    nested.revision = "1";
    expect(parsed.account.revision).toBe(account.revision);
  });
});

it("GET/PUT preserve unknown transport bodies, revision, path and abort signal", async () => {
  const raw: unknown = { unexpected: "synthetic" };
  const api = vi.fn<ApiClient>().mockResolvedValue(raw);
  // Vitest's mock wrapper erases ApiClient's generic call signature.
  const transport = bilibiliRenewalApi(api as ApiClient);
  const signal = new AbortController().signal;
  const status = await transport.status(signal);
  const disabled = await transport.disable(account.revision, signal);
  expectTypeOf(status).toEqualTypeOf<unknown>();
  expectTypeOf(disabled).toEqualTypeOf<unknown>();
  expectTypeOf(validateBilibiliRenewal).parameter(0).toEqualTypeOf<unknown>();
  expectTypeOf(
    validateBilibiliRenewal,
  ).returns.toEqualTypeOf<BilibiliRenewalStatus>();
  expect(status).toBe(raw);
  expect(disabled).toBe(raw);
  expect(api.mock.calls).toEqual([
    ["/platform-accounts/bilibili/renewal", "GET", undefined, signal],
    [
      "/platform-accounts/bilibili/renewal",
      "PUT",
      { expected_revision: account.revision, enabled: false },
      signal,
    ],
  ]);
});

it("GET/PUT preserve the original structured error receipt", async () => {
  const failure = new RequestFailure({
    error: {
      code: "PLATFORM_ACCOUNT_CHANGED",
      message: "synthetic conflict",
      request_id: account.id,
      retryable: true,
      retry_after_ms: 7000,
    },
  });
  const api = vi.fn<ApiClient>().mockRejectedValue(failure);
  const transport = bilibiliRenewalApi(api as ApiClient);
  await expect(transport.status()).rejects.toBe(failure);
  await expect(transport.disable(null)).rejects.toBe(failure);
  expect(failure).toMatchObject({
    code: "PLATFORM_ACCOUNT_CHANGED",
    requestId: account.id,
    retryable: true,
    retryAfterMs: 7000,
  });
  expect(api.mock.calls[1]).toEqual([
    "/platform-accounts/bilibili/renewal",
    "PUT",
    { expected_revision: null, enabled: false },
    undefined,
  ]);
});
