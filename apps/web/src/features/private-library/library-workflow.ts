import type { Ref } from "vue";
import type { useSession } from "../auth/session.store";
import type { useRoomRuntime } from "../rooms/room-runtime";
import type { Media } from "../../shared/api/types";
import type {
  LibraryDetail,
  ScanStatus,
  privateLibraryApi,
} from "./private-library.api";

export type LibrarySession = Pick<
  ReturnType<typeof useSession>,
  "epoch" | "user" | "api"
>;
export type LibraryRuntime = Pick<
  ReturnType<typeof useRoomRuntime>,
  "room" | "can" | "run" | "addQueue" | "queuePending"
>;
export type LibraryApi = ReturnType<typeof privateLibraryApi>;
export type LibraryAction = (
  action: (current: () => boolean) => Promise<unknown>,
  success: string,
  refreshAfter?: boolean,
  bindSelection?: boolean,
) => Promise<boolean>;
export interface LibraryWorkflow {
  api: LibraryApi;
  session: LibrarySession;
  runtime: LibraryRuntime;
  selected: Ref<LibraryDetail | null>;
  selectedId: Ref<string>;
  busy: Ref<boolean>;
  error: Ref<string>;
  notice: Ref<string>;
  media: Ref<Media[]>;
  scans: Ref<Record<string, ScanStatus>>;
  alive(): boolean;
  selection(): number;
  signal(): AbortSignal | undefined;
  fail(error: unknown): void;
  run: LibraryAction;
  loadList(): Promise<boolean>;
  select(id: string): Promise<void>;
  loadMedia(next?: boolean): Promise<void>;
  refreshBrowser(): Promise<unknown>;
}
