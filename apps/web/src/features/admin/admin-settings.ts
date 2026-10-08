export const adminSettingFields = [
  {
    key: "playback_session_limit",
    group: "playback",
    label: "同时播放会话上限",
    unit: "个 / 账号",
    description:
      "限制同一账号的活跃播放会话与等待准备的播放请求总数。降低上限不会中断已有会话，在后续请求时生效。",
    environment: "PLAYBACK_SESSION_LIMIT",
  },
  {
    key: "media_queue_limit",
    group: "playback",
    label: "全局媒体准备队列上限",
    unit: "个任务 / 全站",
    description:
      "限制全站仍持有有效播放授权、处于排队或执行中的媒体准备任务总数。所有房间与账号共享；降低上限不会中断已接纳任务。",
    environment: "MEDIA_QUEUE_LIMIT",
  },
  {
    key: "registration_validate_per_minute",
    group: "registration",
    label: "邀请码校验频率",
    unit: "次 / 分钟 / 来源地址",
    description:
      "限制同一来源地址每分钟的注册邀请码校验次数。地址按部署的可信代理策略识别，共享出口的用户可能共用额度。",
    environment: "REGISTRATION_VALIDATE_PER_MINUTE",
  },
  {
    key: "registration_per_ten_minutes",
    group: "registration",
    label: "注册提交频率",
    unit: "次 / 10 分钟 / 来源地址",
    description:
      "限制同一来源地址每十分钟的注册提交次数。此设置只调整请求频率，是否需要邀请码取决于上方注册方式。",
    environment: "REGISTRATION_PER_TEN_MINUTES",
  },
] as const;
export type NumericAdminSettingKey = (typeof adminSettingFields)[number]["key"];
export type RegistrationMode = "closed" | "invite_only" | "open";
export type AdminSettingsValues = Record<NumericAdminSettingKey, number> & {
  registration_mode: RegistrationMode;
  guests_enabled: boolean;
};
export type AdminSettingKey = keyof AdminSettingsValues;
export const adminSettingKeys: AdminSettingKey[] = [
  ...adminSettingFields.map(({ key }) => key),
  "registration_mode",
  "guests_enabled",
];
export type AdminSettingsOverrides = {
  [K in AdminSettingKey]: AdminSettingsValues[K] | null;
};
export type AdminSettingsDraft = Record<
  AdminSettingKey,
  { mode: "default" | "override"; value: number | string | boolean }
>;
export interface AdminSettingsSnapshot {
  revision: string;
  values: AdminSettingsValues;
  defaults: AdminSettingsValues;
  overrides: AdminSettingsOverrides;
  bounds: { min: number; max: number };
  deployment: {
    private_libraries_enabled: boolean;
    nas_compute_enabled: boolean;
    p2p_enabled: boolean;
    other_live_enabled: boolean;
    preview: {
      concurrency: number;
      timeout_seconds: number;
      cache_bytes: number;
      queue_limit: number;
      input_bytes: number;
    };
  };
  updated_at: number | null;
}
export function settingsDraft(
  snapshot?: AdminSettingsSnapshot,
): AdminSettingsDraft {
  return Object.fromEntries(
    adminSettingKeys.map((key) => [
      key,
      {
        mode: snapshot?.overrides[key] == null ? "default" : "override",
        value: snapshot?.values[key] ?? "",
      },
    ]),
  ) as AdminSettingsDraft;
}
export function changedSettings(
  draft: AdminSettingsDraft,
  snapshot: AdminSettingsSnapshot,
): Partial<AdminSettingsOverrides> {
  const changes: Partial<AdminSettingsOverrides> = {};
  for (const key of adminSettingKeys) {
    const value =
      draft[key].mode === "default"
        ? null
        : key === "registration_mode" || key === "guests_enabled"
          ? draft[key].value
          : Number(draft[key].value);
    if (value !== snapshot.overrides[key])
      Object.assign(changes, { [key]: value });
  }
  return changes;
}
export function invalidSetting(
  draft: AdminSettingsDraft,
  snapshot: AdminSettingsSnapshot,
): AdminSettingKey | undefined {
  if (
    draft.registration_mode.mode === "override" &&
    !["closed", "invite_only", "open"].includes(
      String(draft.registration_mode.value),
    )
  )
    return "registration_mode";
  if (
    draft.guests_enabled.mode === "override" &&
    typeof draft.guests_enabled.value !== "boolean"
  )
    return "guests_enabled";
  return adminSettingFields.find(({ key }) => {
    const field = draft[key],
      value = Number(field.value);
    return (
      field.mode === "override" &&
      (String(field.value).trim() === "" ||
        !Number.isSafeInteger(value) ||
        value < snapshot.bounds.min ||
        value > snapshot.bounds.max)
    );
  })?.key;
}
/** Validate the bounded response before displaying values or using its revision. */
export function checkedSettings(
  value: AdminSettingsSnapshot,
): AdminSettingsSnapshot {
  const invalid = () => {
    throw new Error("设置响应不完整，请刷新后重试。");
  };
  if (
    !value ||
    typeof value.revision !== "string" ||
    !/^[1-9]\d*$/.test(value.revision) ||
    BigInt(value.revision) > 9223372036854775807n ||
    !value.values ||
    !value.defaults ||
    !value.overrides ||
    !value.bounds ||
    !Number.isSafeInteger(value.bounds.min) ||
    !Number.isSafeInteger(value.bounds.max) ||
    value.bounds.min < 1 ||
    value.bounds.max < value.bounds.min
  )
    invalid();
  for (const { key } of adminSettingFields) {
    for (const number of [
      value.values[key],
      value.defaults[key],
      ...(value.overrides[key] === null ? [] : [value.overrides[key]]),
    ]) {
      if (
        !Number.isSafeInteger(number) ||
        number! < value.bounds.min ||
        number! > value.bounds.max
      )
        invalid();
    }
    if (value.values[key] !== (value.overrides[key] ?? value.defaults[key]))
      invalid();
  }
  for (const object of [value.values, value.defaults]) {
    if (
      !["closed", "invite_only", "open"].includes(object.registration_mode) ||
      typeof object.guests_enabled !== "boolean"
    )
      invalid();
  }
  if (
    value.overrides.registration_mode !== null &&
    !["closed", "invite_only", "open"].includes(
      value.overrides.registration_mode,
    )
  )
    invalid();
  if (
    value.overrides.guests_enabled !== null &&
    typeof value.overrides.guests_enabled !== "boolean"
  )
    invalid();
  for (const key of ["registration_mode", "guests_enabled"] as const) {
    if (value.values[key] !== (value.overrides[key] ?? value.defaults[key]))
      invalid();
  }
  const deployment = value.deployment;
  if (
    !deployment ||
    [
      deployment.private_libraries_enabled,
      deployment.nas_compute_enabled,
      deployment.p2p_enabled,
      deployment.other_live_enabled,
    ].some((flag) => typeof flag !== "boolean") ||
    !deployment.preview ||
    [
      deployment.preview.concurrency,
      deployment.preview.timeout_seconds,
      deployment.preview.cache_bytes,
      deployment.preview.queue_limit,
      deployment.preview.input_bytes,
    ].some((number) => !Number.isSafeInteger(number) || number < 0)
  )
    invalid();
  return value;
}
export function olderSettings(
  value: AdminSettingsSnapshot,
  confirmed: AdminSettingsSnapshot,
) {
  return BigInt(value.revision) < BigInt(confirmed.revision);
}
