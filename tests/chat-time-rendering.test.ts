import { readFileSync } from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import { afterEach, expect, it, vi } from "vitest";

// Exercise the actual compiled chat template without starting a browser.
function chatRender(messages: any[]) {
  const runtime = Vue.reactive({
    messages,
    roomActive: true,
    connected: true,
    chat: "",
    chatPending: false,
    chatFailed: false,
    sendChat() {},
  });
  const source = readFileSync(
    new URL("../apps/web/src/features/rooms/ChatPanel.vue", import.meta.url),
    "utf8",
  );
  const compiled = compileScript(parse(source).descriptor, {
    id: "chat-time-fixture",
    inlineTemplate: true,
  }).content;
  const bindings: Record<string, unknown> = {
    useRoomRuntime: () => runtime,
    UserAvatar: {},
    AppIcon: {},
    TimelineChatPanel: {},
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
      (_, specifiers: string) => {
        for (const specifier of specifiers.split(",")) {
          const [name, alias = name] = specifier.trim().split(/\s+as\s+/);
          bindings[alias] =
            name === "onMounted"
              ? () => {}
              : name === "withDirectives"
                ? (node: Vue.VNode) => node
                : (Vue as any)[name];
        }
        return "";
      },
    )
    .replace(/import[\s\S]*?from\s+["'][^"']+["'];?\s*/g, "")
    .replace("export default", "return");
  const component = new Function(...Object.keys(bindings), js)(
    ...Object.values(bindings),
  );
  const scope = Vue.effectScope();
  const render = scope.run(() => component.setup({ visible: true }));
  const cache: any[] = [];
  return {
    runtime,
    render: () => render({}, cache) as Vue.VNode,
    dispose: () => scope.stop(),
  };
}

function nodesOfType(node: any, type: string): Vue.VNode[] {
  if (!node || typeof node !== "object") return [];
  return [
    ...(node.type === type ? [node] : []),
    ...(Array.isArray(node.children)
      ? node.children.flatMap((child: unknown) => nodesOfType(child, type))
      : []),
  ];
}

const message = (id: number, created_at: number | string | null) => ({
  id: `chat-${id}`,
  username: "viewer",
  body: `message ${id}`,
  created_at,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reuses one locale formatter across the 2000-message window and live updates", () => {
  const constructor = vi.spyOn(Intl, "DateTimeFormat");
  const legacy = vi.spyOn(Date.prototype, "toLocaleTimeString");
  const panel = chatRender(
    Array.from({ length: 2000 }, (_, i) => message(i, 1791244800000 + i)),
  );
  try {
    expect(constructor).toHaveBeenCalledExactlyOnceWith("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(nodesOfType(panel.render(), "article")).toHaveLength(2000);
    for (let i = 0; i < 3; i++) {
      panel.runtime.messages = [
        ...panel.runtime.messages.slice(1),
        message(2000 + i, 1791244802000 + i),
      ];
      const view = panel.render();
      expect(nodesOfType(view, "article")).toHaveLength(2000);
      expect(nodesOfType(view, "time")).toHaveLength(2000);
    }
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    panel.dispose();
  }
});

it.each(["UTC", "Asia/Shanghai", "America/Los_Angeles"])(
  "preserves native zh-CN hour/minute output and ISO metadata in %s",
  (timezone) => {
    vi.stubEnv("TZ", timezone);
    const timestamps = [
      "2026-01-01T00:01:59.999Z",
      "2026-03-08T09:59:00Z",
      "2026-03-08T10:00:00Z",
      "2026-11-01T08:59:00Z",
      "2026-11-01T09:00:00Z",
    ];
    const expected = timestamps.map((value) =>
      new Date(value).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    const panel = chatRender(timestamps.map((value, i) => message(i, value)));
    try {
      const times = nodesOfType(panel.render(), "time");
      expect(times.map((node) => node.children)).toEqual(expected);
      expect(times.map((node) => node.props?.datetime)).toEqual(
        timestamps.map((value) => new Date(value).toISOString()),
      );
    } finally {
      panel.dispose();
    }
  },
);

it("keeps existing absent and invalid timestamp behavior", () => {
  const panel = chatRender([message(1, null), message(2, 0)]);
  try {
    expect(nodesOfType(panel.render(), "time")).toHaveLength(0);
    panel.runtime.messages = [message(3, "not-a-date")];
    // The unchanged ISO datetime attribute already rejects invalid dates.
    expect(() => panel.render()).toThrow(RangeError);
  } finally {
    panel.dispose();
  }
});
