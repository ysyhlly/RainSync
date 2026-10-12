/** QR-only compiler fixture; Vitest transpilation is not a typecheck. */
import type { ApiClient } from "../../apps/web/src/shared/api/client";
import {
  platformAccountApi,
  type PlatformLogin,
} from "../../apps/web/src/features/account/platform-account.api";
import { createPlatformLoginFlow } from "../../apps/web/src/features/account/platform-login-flow";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type Api = ReturnType<typeof platformAccountApi>;
type Options = Parameters<typeof createPlatformLoginFlow>[0];
export type UnknownQrReceipts = [
  Assert<Equal<ReturnType<Api["start"]>, Promise<unknown>>>,
  Assert<Equal<ReturnType<Api["poll"]>, Promise<unknown>>>,
  Assert<Equal<ReturnType<Api["cancel"]>, Promise<unknown>>>,
  Assert<Equal<ReturnType<Options["start"]>, Promise<unknown>>>,
  Assert<Equal<ReturnType<Options["poll"]>, Promise<unknown>>>,
  Assert<Equal<ReturnType<Options["cancel"]>, Promise<unknown>>>,
];
export async function qrConsumers(api: ApiClient, raw: unknown) {
  // @ts-expect-error Start JSON is not a validated login capability.
  const uncheckedStart: PlatformLogin =
    await platformAccountApi(api).start("synthetic");
  // @ts-expect-error Poll JSON needs the current flow's identity/deadline fence and parser.
  const uncheckedPoll: PlatformLogin =
    await platformAccountApi(api).poll("synthetic");
  // @ts-expect-error Cancel JSON is ignored, not a validated DTO.
  const uncheckedCancel: PlatformLogin =
    await platformAccountApi(api).cancel("synthetic");
  const flow = createPlatformLoginFlow({
    current: () => true,
    start: async () => raw,
    poll: async () => raw,
    cancel: async () => raw,
    change() {},
    confirmed() {},
  });
  return { flow, uncheckedStart, uncheckedPoll, uncheckedCancel };
}
