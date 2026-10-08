import { createPinia, disposePinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import { afterEach, expect, it, vi } from "vitest";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { validateAccount } from "../apps/web/src/features/auth/account-rules";
import { useAction } from "../apps/web/src/shared/use-action";

const cleanup: (() => void)[] = [];
const componentUrl = new URL(
  "../apps/web/src/features/admin/CreateUserPage.vue",
  import.meta.url,
);
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
});

function panel(api: ReturnType<typeof vi.fn>) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({
    id: "fixture-admin",
    username: "fixture-admin",
    admin: true,
    csrf: "fixture-csrf",
  });
  session.api = api as typeof session.api;
  const instance = mountSetup(componentUrl, {
    useSession,
    validateAccount,
    useAction,
    Notice: {},
    AccountTabs: {},
  });
  cleanup.push(() => disposePinia(pinia), instance.unmount);
  const c = instance.controls;
  c.username.value = "Alice";
  c.nickname.value = "Alice 昵称";
  c.password.value = " fixture-password ";
  return c;
}

it("reports the submitted account when a delayed response outlives the live draft", async () => {
  let finish!: (value: { id: string }) => void;
  const api = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const c = panel(api);
  const pending = c.submit();
  expect(api).toHaveBeenCalledWith("/users", "POST", {
    username: "Alice",
    password: " fixture-password ",
    display_name: "Alice 昵称",
  });
  c.username.value = "Bob";
  finish({ id: "created-alice" });
  await pending;
  expect(c.message.value).toBe("普通账号 Alice 已创建");
  expect(c.username.value).toBe("Bob");
  expect(c.nickname.value).toBe("Alice 昵称");
  expect(c.password.value).toBe(" fixture-password ");
  expect(c.busy.value).toBe(false);
});

it("ignores repeated submissions until the pending request finishes", async () => {
  let finish!: (value: { id: string }) => void;
  const api = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const c = panel(api);
  const pending = c.submit();
  expect(c.busy.value).toBe(true);
  await c.submit();
  expect(api).toHaveBeenCalledTimes(1);
  expect(c.busy.value).toBe(true);
  finish({ id: "created-alice" });
  await pending;
  expect([c.username.value, c.nickname.value, c.password.value]).toEqual([
    "",
    "",
    "",
  ]);
  expect(c.message.value).toBe("普通账号 Alice 已创建");
  expect(c.busy.value).toBe(false);
});

it("preserves the full draft on failure and allows an explicit retry", async () => {
  const api = vi
    .fn()
    .mockRejectedValueOnce(Error("没有创建账号的权限"))
    .mockResolvedValueOnce({ id: "created-alice" });
  const c = panel(api);
  await c.submit();
  expect(c.error.value).toBe("没有创建账号的权限");
  expect(c.message.value).toBe("");
  expect(c.busy.value).toBe(false);
  expect([c.username.value, c.nickname.value, c.password.value]).toEqual([
    "Alice",
    "Alice 昵称",
    " fixture-password ",
  ]);
  await c.submit();
  expect(api).toHaveBeenCalledTimes(2);
  expect(api.mock.calls[1]).toEqual(api.mock.calls[0]);
  expect(c.error.value).toBe("");
  expect(c.message.value).toBe("普通账号 Alice 已创建");
});

it("keeps validation local and preserves invalid input for correction", async () => {
  const api = vi.fn();
  const c = panel(api);
  c.password.value = "short";
  await c.submit();
  expect(api).not.toHaveBeenCalled();
  expect(c.error.value).toContain("密码须为8–1024个");
  expect(c.password.value).toBe("short");
  expect(c.busy.value).toBe(false);
});

it("binds every account field to the pending state and routes form submit through the guard", () => {
  const template = parse(readFileSync(componentUrl, "utf8")).descriptor
    .template!;
  const elements: any[] = [];
  function visit(node: any) {
    if (node.type === 1) elements.push(node);
    node.children?.forEach(visit);
  }
  visit(template.ast);
  const inputs = elements.filter((node) => node.tag === "input");
  expect(inputs).toHaveLength(3);
  for (const input of inputs) {
    const disabled = input.props.find(
      (prop: any) =>
        prop.type === 7 &&
        prop.name === "bind" &&
        prop.arg?.content === "disabled",
    );
    expect(disabled?.exp?.content).toBe("busy");
  }
  const form = elements.find((node) => node.tag === "form");
  const submit = form.props.find(
    (prop: any) =>
      prop.type === 7 && prop.name === "on" && prop.arg?.content === "submit",
  );
  expect(submit?.exp?.content).toBe("submit");
  expect(
    submit?.modifiers.some((modifier: any) => modifier.content === "prevent"),
  ).toBe(true);
});
