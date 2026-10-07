import { afterEach, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { RequestFailure } from "../apps/web/src/errors";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const record = (id: string, title: string | null = null, revision = "0") => ({
  id,
  original_title: `Film ${id}`,
  personal_title: title,
  personal_title_revision: revision,
  shared_title: null,
  shared_title_revision: "0",
});
function fixture() {
  const records = { A: record("A", "A personal"), B: record("B") };
  const ensure = vi.fn(async (id: keyof typeof records) => records[id]);
  const renamePersonal = vi.fn(async (id, title, revision) => ({
    ...records[id as keyof typeof records],
    personal_title: title,
    personal_title_revision: String(Number(revision) + 1),
  }));
  const renameShared = vi.fn();
  const session = reactive({ epoch: 1, user: { admin: true } });
  const panel = mountSetup(
    new URL(
      "../apps/web/src/features/library/MediaRenameDialog.vue",
      import.meta.url,
    ),
    {
      useMediaCatalog: () => ({
        records,
        ensure,
        renamePersonal,
        renameShared,
      }),
      useSession: () => session,
      AppDialog: {},
      Notice: {},
      RequestFailure,
    },
    { mediaId: "A" },
  );
  cleanup.push(panel.unmount);
  return { ...panel, ensure, renamePersonal, renameShared, session, records };
}

it("never reuses another film's draft after a fresh-read failure and can retry", async () => {
  const p = fixture();
  await nextTick();
  expect(p.controls.draftReady.value).toBe(true);
  p.controls.personal.value = "Unsubmitted A draft";
  p.controls.shared.value = "Unsubmitted shared A draft";
  p.setProps({ mediaId: null });
  await nextTick();
  p.ensure.mockRejectedValueOnce(new Error("B fresh load failed"));
  p.setProps({ mediaId: "B" });
  await nextTick();
  await nextTick();
  expect(p.controls.error.value).toBe("B fresh load failed");
  expect(p.controls.draftReady.value).toBe(false);
  expect(p.controls.busy.value).toBe(false);
  expect(p.controls.personal.value).toBe("");
  expect(p.controls.shared.value).toBe("");
  await p.controls.save("personal");
  await p.controls.save("shared", true);
  expect(p.renamePersonal).not.toHaveBeenCalled();
  expect(p.renameShared).not.toHaveBeenCalled();

  p.records.B = record("B", "B current", "4");
  await p.controls.loadDraft();
  expect(p.controls.draftReady.value).toBe(true);
  expect(p.controls.personal.value).toBe("B current");
  p.controls.personal.value = "B new";
  await p.controls.save("personal");
  expect(p.renamePersonal).toHaveBeenCalledExactlyOnceWith("B", "B new", "4");
});

it("ignores a late old-film read and a closing dialog releases loading state", async () => {
  const p = fixture();
  await nextTick();
  let resolve!: (value: any) => void;
  p.ensure.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  p.setProps({ mediaId: "B" });
  await nextTick();
  expect(p.controls.busy.value).toBe(true);
  p.setProps({ mediaId: null });
  await nextTick();
  expect(p.controls.busy.value).toBe(false);
  expect(p.controls.draftReady.value).toBe(false);
  resolve(record("B", "Late B title", "9"));
  await nextTick();
  expect(p.controls.personal.value).toBe("");
  expect(p.controls.draftReady.value).toBe(false);
});

it("an identity change invalidates an already loaded draft even if the read fails", async () => {
  const p = fixture();
  await nextTick();
  p.controls.personal.value = "First account draft";
  p.ensure.mockRejectedValueOnce(new Error("New account read failed"));
  p.session.epoch++;
  await nextTick();
  expect(p.controls.draftReady.value).toBe(false);
  expect(p.controls.personal.value).toBe("");
  await p.controls.save("personal");
  expect(p.renamePersonal).not.toHaveBeenCalled();
});
