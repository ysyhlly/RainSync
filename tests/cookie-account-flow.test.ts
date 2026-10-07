import { expect, it, vi } from "vitest";
import { createShortAccountFlow } from "../apps/web/src/features/account/short-account-flow";
import { createYoutubeAccountFlow } from "../apps/web/src/features/account/youtube-account-flow";

const shortSecret = "sessionid=synthetic-session-fixture";
const youtubeSecret =
  "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-session\n";
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
function fixture(
  provider: "douyin" | "youtube",
  submit: any,
  current = () => true,
) {
  const phases: string[] = [];
  const clearSecret = vi.fn();
  const flow =
    provider === "douyin"
      ? createShortAccountFlow({
          provider,
          submit,
          current,
          clearSecret,
          change: ({ phase }) => phases.push(phase),
        })
      : createYoutubeAccountFlow({
          submit,
          current,
          clearSecret,
          change: (phase) => phases.push(phase),
        });
  return {
    ...flow,
    phases,
    clearSecret,
    secret: provider === "douyin" ? shortSecret : youtubeSecret,
  };
}
function status(provider: "douyin" | "youtube") {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    provider,
    revision: "1",
    state: "connected",
    login_method:
      provider === "douyin" ? "cookie_import" : "netscape_cookie_import",
    qr_available: false,
    verification: "unverified",
    credential_expires_at: null,
    ...(provider === "youtube"
      ? { account_import_available: true, availability_reason: null }
      : {}),
  };
}

it("blank-input guards remain different for short cookies and YouTube files", async () => {
  const submit = vi.fn();
  const short = fixture("douyin", submit),
    youtube = fixture("youtube", submit);
  await short.submit("   ", null, true);
  await youtube.submit("   ", null, true);
  expect(submit).not.toHaveBeenCalled();
  expect(short.clearSecret).not.toHaveBeenCalled();
  expect(short.phases).toEqual([]);
  expect(youtube.clearSecret).toHaveBeenCalledTimes(1);
  expect(youtube.phases).toEqual(["invalid"]);
});

it.each(["douyin", "youtube"] as const)(
  "%s suppresses old-identity errors, clears input and requires new explicit input to retry",
  async (provider) => {
    let current = true;
    const pending = deferred();
    const submit = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(status(provider));
    const flow = fixture(provider, submit, () => current);
    const running = flow.submit(flow.secret, null, true);
    expect(flow.clearSecret).toHaveBeenCalledTimes(1);
    current = false;
    pending.reject(Error(flow.secret));
    await running;
    expect(flow.phases).toEqual(["submitting"]);
    expect(submit).toHaveBeenCalledTimes(1);
    current = true;
    await flow.submit("", null, true);
    expect(submit).toHaveBeenCalledTimes(1);
    await flow.submit(flow.secret, "1", true);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][1]).toBe("1");
    expect(flow.clearSecret).toHaveBeenCalledTimes(2);
    expect(flow.phases).toEqual(["submitting", "submitting", "stored"]);
    flow.close();
  },
);

it.each(["douyin", "youtube"] as const)(
  "%s keeps malformed connected responses uncertain without exposing credentials",
  async (provider) => {
    const submit = vi.fn(async () => ({
      ...status(provider),
      provider: "invalid-provider",
      cookie: "synthetic-secret",
    }));
    const flow = fixture(provider, submit);
    await flow.submit(flow.secret, null, true);
    expect(flow.phases).toEqual(["submitting", "uncertain"]);
    expect(flow.clearSecret).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    flow.close();
    await flow.submit(flow.secret, null, true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(flow.clearSecret).toHaveBeenCalledTimes(2);
  },
);
