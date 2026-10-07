import type { Source } from "../../shared/api/types";
import type { HttpAssetAssociation } from "./http-asset-association";

/** Settings reads never include stored tokens, header values or signed URLs. */
export interface SourceSettings extends Source {
  revision: string;
  access_policy_revision: number;
  config: {
    root?: string;
    url?: string;
    user_id?: string;
    advanced_assets?: HttpAssetAssociation | null;
  };
  credentials: {
    token_configured: boolean;
    headers_configured: boolean;
    header_names: string[];
    url_configured?: boolean;
    url_redacted?: boolean;
  };
}

export interface SourceSettingsSaved extends SourceSettings {
  config_changed: boolean;
  rescan_required: boolean;
}

export interface SourceSettingsDraft {
  name: string;
  root: string;
  url: string;
  urlMode: "keep" | "replace";
  userId: string;
  token: string;
  tokenMode: "keep" | "replace" | "clear";
  headers: string;
  headersMode: "keep" | "replace" | "clear";
  advancedAssets: string;
}

export function settingsDraft(value?: SourceSettings): SourceSettingsDraft {
  return {
    name: value?.name ?? "",
    root: value?.config.root ?? "",
    url: value?.credentials.url_redacted ? "" : (value?.config.url ?? ""),
    urlMode: value?.credentials.url_redacted ? "keep" : "replace",
    userId: value?.config.user_id ?? "",
    token: "",
    tokenMode: "keep",
    headers: "",
    headersMode: "keep",
    advancedAssets: value?.config.advanced_assets
      ? JSON.stringify(value.config.advanced_assets, null, 2)
      : "",
  };
}

/** A response acknowledges only its submitted snapshot, never newer edits. */
export function reconcileSettingsDraft(
  current: SourceSettingsDraft,
  submitted: SourceSettingsDraft,
  saved: SourceSettingsDraft,
): SourceSettingsDraft {
  const next = { ...current };
  const groups: (keyof SourceSettingsDraft)[][] = [
    ["name"],
    ["root"],
    ["url", "urlMode"],
    ["userId"],
    ["token", "tokenMode"],
    ["headers", "headersMode"],
    ["advancedAssets"],
  ];
  for (const group of groups) {
    if (group.every((key) => current[key] === submitted[key])) {
      for (const key of group) Object.assign(next, { [key]: saved[key] });
    }
  }
  return next;
}
