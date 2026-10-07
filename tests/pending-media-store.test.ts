import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { reactive, watch } from "vue";
import { usePendingMedia } from "../apps/web/src/features/library/pending-media.store";

const fixture = vi.hoisted(() => ({ session: undefined as any }));
vi.mock("../apps/web/src/features/auth/session.store", () => ({
  useSession: () => fixture.session,
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.useRealTimers();
});
function store() {
  vi.useFakeTimers();
  const pinia = createPinia();
  setActivePinia(pinia);
  cleanups.push(() => disposePinia(pinia));
  fixture.session = reactive({ epoch: 1, user: { id: "owner" } });
  return usePendingMedia();
}
it("rejection replaces the selection and denial atomically for synchronous observers", () => {
  const pending = store();
  pending.select("movie", "Film");
  const selection = pending.selection!;
  const observed: unknown[] = [];
  const stop = watch(
    () => pending.selection,
    () =>
      observed.push({
        selection: pending.selection,
        error: pending.selectionError,
        context: pending.selectionErrorContext,
      }),
    { flush: "sync" },
  );
  cleanups.push(stop);
  expect(pending.rejectSelection(selection, "Not visible", "room:1")).toBe(
    true,
  );
  expect(observed).toEqual([
    { selection: null, error: "Not visible", context: "room:1" },
  ]);
  pending.clearContextError("room:1", true);
  expect(pending.selectionError).toBe("Not visible");
  pending.clearContextError("room:2", true);
  expect(pending.selectionError).toBe("");
});
it("new selections and identities retire denial feedback; context clearing preserves a valid choice", () => {
  const pending = store();
  pending.select("old", "Old");
  pending.rejectSelection(pending.selection!, "Not visible", "context-old");
  pending.select("new", "New");
  const selected = pending.selection;
  pending.clearContextError("context-new", false);
  expect(pending.selection).toBe(selected);
  expect(pending.selectionError).toBe("");
  fixture.session.epoch++;
  expect(pending.selection).toBeNull();
  expect(pending.selectionError).toBe("");
});
