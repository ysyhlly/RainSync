import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, compileScript } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import * as Vue from "vue";
import { expect, it } from "vitest";
import { localDateTime } from "../apps/web/src/features/private-library/use-library-settings";
import {
  confirmationTitles,
  confirmationLabels,
} from "../apps/web/src/features/private-library/use-library-changes";

/** Render the actual extracted forms; only shared icons/dialog chrome are stubbed. */
async function renderPanel(name: string, props: Record<string, unknown>) {
  const url = new URL(
    `../apps/web/src/features/private-library/${name}.vue`,
    import.meta.url,
  );
  const filename = fileURLToPath(url);
  const descriptor = parse(readFileSync(url, "utf8"), { filename }).descriptor;
  const compiled = compileScript(descriptor, {
    id: name,
    inlineTemplate: true,
  }).content;
  const empty = Vue.defineComponent({ render: () => Vue.h("span") });
  const dialog = Vue.defineComponent({
    props: ["modelValue", "title", "busy"],
    setup:
      (props, { slots }) =>
      () =>
        props.modelValue
          ? Vue.h(
              "section",
              { role: "dialog", "aria-label": props.title },
              slots.default?.(),
            )
          : null,
  });
  const bindings: Record<string, unknown> = {
    AppIcon: empty,
    Notice: empty,
    AppDialog: dialog,
    localDateTime,
    confirmationTitles,
    confirmationLabels,
  };
  const js = ts
    .transpileModule(compiled, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(
      /import\s+\{([^}]+)\}\s+from\s+["']vue["'];?\s*/g,
      (_match, specifiers: string) => {
        for (const specifier of specifiers.split(",")) {
          const [name, alias = name] = specifier.trim().split(/\s+as\s+/);
          bindings[alias] = (Vue as any)[name];
        }
        return "";
      },
    )
    .replace(/import[\s\S]*?from\s+["'][^"']+["'];?\s*/g, "")
    .replace("export default", "return");
  const component = new Function(...Object.keys(bindings), js)(
    ...Object.values(bindings),
  );
  return renderToString(Vue.createSSRApp(component, props));
}

it("the access form retains its explicit library owner and feature gates after extraction", async () => {
  const props = {
    selected: { id: "library", name: "Private", owner_id: "owner", grants: [] },
    enabled: true,
    userId: "owner",
    busy: false,
    form: {
      grantName: "viewer",
      hours: 168,
      editingGrant: undefined,
      browse: true,
      play: true,
      shareRight: false,
      manage: false,
    },
  };
  expect(await renderPanel("LibraryAccessPanel", props)).toContain("账户授权");
  expect(
    await renderPanel("LibraryAccessPanel", { ...props, userId: "another" }),
  ).not.toContain("保存授权");
  expect(
    await renderPanel("LibraryAccessPanel", { ...props, enabled: false }),
  ).not.toContain("保存授权");
});

it("non-admin source editing renders the name without exposing connection drafts", async () => {
  const html = await renderPanel("LibraryDialogs", {
    busy: false,
    error: "",
    isAdmin: false,
    pendingChange: null,
    s3Edit: {
      id: "source",
      libraryId: "library",
      revision: "1",
      name: "Private source",
      url: "https://fixture.invalid/credential-draft",
      config: "credential-reference-fixture",
      originalConfig: "",
      originalUrl: "",
      urlRedacted: false,
      replaceUrl: false,
    },
  });
  expect(html).toContain("片源名称");
  expect(html).not.toContain("credential-draft");
  expect(html).not.toContain("credential-reference-fixture");
  expect(html).not.toContain("S3 配置 JSON");
});

it("the extracted share editor renders the original expiry ceiling", async () => {
  const maximum = Date.now() + 2 * 3_600_000;
  const html = await renderPanel("LibraryDialogs", {
    busy: false,
    error: "",
    isAdmin: false,
    pendingChange: null,
    shareEdit: {
      id: "share",
      libraryId: "library",
      revision: "2",
      title: "Private film",
      mode: "library_members",
      expires: localDateTime(maximum - 60_000),
      maxExpires: maximum,
    },
  });
  expect(html).toContain(`max="${localDateTime(maximum)}"`);
  expect(html).toContain("最晚到期");
});
