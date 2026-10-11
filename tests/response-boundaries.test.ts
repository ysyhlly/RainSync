import { describe, expect, it } from "vitest";
import {
  validatePlatformAccountCheck,
  validatePlatformAccountStatus,
} from "../apps/web/src/features/account/platform-account-check";
import { validateShortAccountStatus } from "../apps/web/src/features/account/short-account-flow";
import { validateYoutubeAccountStatus } from "../apps/web/src/features/account/youtube-account-flow";
import { checkedSettings } from "../apps/web/src/features/admin/admin-settings";
import { defaultAdminSettings } from "./browser/fixtures/admin-settings";

const id = "00000000-0000-0000-0000-000000000001";
const revision = "9007199254740993";
const bili = { id, provider: "bilibili", revision, state: "connected" };
const short = {
  ...bili,
  provider: "douyin",
  login_method: "cookie_import",
  qr_available: false,
  verification: "unverified",
  credential_expires_at: null,
};
const youtube = {
  ...short,
  provider: "youtube",
  login_method: "netscape_cookie_import",
  account_import_available: true,
  availability_reason: null,
};
const check = {
  account: bili,
  verification: "verified",
  checked_at: 1730000000000,
  renew_method: "qr_login",
};
const settings = { ...defaultAdminSettings, revision };
const parsers = [
  ["bilibili", validatePlatformAccountStatus, bili],
  ["check", validatePlatformAccountCheck, check],
  ["douyin", (v: unknown) => validateShortAccountStatus(v, "douyin"), short],
  [
    "tiktok",
    (v: unknown) => validateShortAccountStatus(v, "tiktok"),
    { ...short, provider: "tiktok" },
  ],
  ["youtube", validateYoutubeAccountStatus, youtube],
  ["settings", checkedSettings, settings],
] as const;

describe.each(parsers)(
  "%s unknown response boundary",
  (_name, parse, valid) => {
    it.each([undefined, null, true, 7, "response", [], {}])(
      "rejects non-record or incomplete input %j with a bounded error",
      (value) => expect(() => parse(value)).toThrow(/响应不完整/),
    );
    it("rejects arrays even if a non-JSON mock decorates one with valid DTO fields", () => {
      expect(() => parse(Object.assign([], valid))).toThrow(/响应不完整/);
    });
    it("copies only validated fields and does not retain the raw object", () => {
      const raw: unknown = { ...valid, cookie: "synthetic-secret" };
      const parsed = parse(raw);
      expect(parsed).not.toBe(raw);
      expect(parsed).not.toHaveProperty("cookie");
    });
  },
);

it("preserves provider-specific revision and expired-state rules without numeric coercion", () => {
  for (const value of ["0", "00", "01", revision, "9223372036854775808"])
    expect(
      validateShortAccountStatus({ ...short, revision: value }, "douyin")
        .revision,
    ).toBe(value);
  for (const value of ["0", "00", "01", 3, 9007199254740992, "-1", "1e3"])
    for (const [parse, status] of [
      [validatePlatformAccountStatus, bili],
      [validateYoutubeAccountStatus, youtube],
    ] as const)
      expect(() => parse({ ...status, revision: value })).toThrow();
  expect(validatePlatformAccountStatus(bili).revision).toBe(revision);
  expect(validateYoutubeAccountStatus(youtube).revision).toBe(revision);
  for (const verification of ["unverified", "none"])
    expect(
      validateShortAccountStatus(
        { ...short, state: "expired", verification },
        "douyin",
      ).verification,
    ).toBe(verification);
  expect(() =>
    validateYoutubeAccountStatus({ ...youtube, state: "expired" }),
  ).toThrow();
  expect(
    validateYoutubeAccountStatus({
      ...youtube,
      state: "expired",
      verification: "none",
    }).state,
  ).toBe("expired");
});

it("preserves provider and credential-method binding and rejects fabricated authentication", () => {
  for (const value of [
    { ...short, provider: "tiktok" },
    { ...short, login_method: "qr_login" },
    { ...short, qr_available: true },
    { ...short, verification: "verified" },
    { ...short, credential_expires_at: "123" },
  ])
    expect(() => validateShortAccountStatus(value, "douyin")).toThrow();
  expect(() =>
    validateYoutubeAccountStatus({
      ...youtube,
      account_import_available: false,
    }),
  ).toThrow();
  expect(() =>
    validatePlatformAccountCheck({ ...check, checked_at: "123" }),
  ).toThrow();
});

it("strips nested account and admin fields at every DTO level", () => {
  const parsed = validatePlatformAccountCheck({
    ...check,
    cookie: "secret",
    account: { ...bili, cookie: "secret" },
  });
  expect(parsed).toEqual(check);
  expect(parsed.account).not.toBe(bili);
  const raw = {
    ...settings,
    secret: "secret",
    values: { ...settings.values, secret: "secret" },
    defaults: { ...settings.defaults, secret: "secret" },
    overrides: { ...settings.overrides, secret: "secret" },
    bounds: { ...settings.bounds, secret: "secret" },
    deployment: {
      ...settings.deployment,
      secret: "secret",
      preview: { ...settings.deployment.preview, secret: "secret" },
    },
  };
  const value = checkedSettings(raw);
  expect(JSON.stringify(value)).not.toContain("secret");
  expect(value).not.toHaveProperty("origins");
  for (const key of [
    "values",
    "defaults",
    "overrides",
    "bounds",
    "deployment",
  ] as const)
    expect(value[key]).not.toBe(raw[key]);
  expect(value.deployment.preview).not.toBe(raw.deployment.preview);
  expect(value.revision).toBe(revision);
});

it.each([
  undefined,
  "1730000000000",
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
])(
  "settings updated_at is a complete nullable safe-integer field: rejects %s",
  (updated_at) =>
    expect(() => checkedSettings({ ...settings, updated_at })).toThrow(
      "设置响应不完整",
    ),
);
it.each([null, -1, 0, 1730000000000])(
  "accepts settings updated_at %s",
  (updated_at) => {
    expect(checkedSettings({ ...settings, updated_at }).updated_at).toBe(
      updated_at,
    );
  },
);
it.each(["values", "defaults", "overrides", "bounds", "deployment"] as const)(
  "settings nested %s must be a JSON object",
  (field) =>
    expect(() => checkedSettings({ ...settings, [field]: [] })).toThrow(
      "设置响应不完整",
    ),
);
