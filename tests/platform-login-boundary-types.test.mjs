import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Pure compiler controls. Unsafe transports exist only in compiler memory.
const tests = fileURLToPath(new URL("./", import.meta.url));
const configPath = fileURLToPath(
  new URL("./tsconfig.platform-login-boundaries.json", import.meta.url),
);
const apiPath = fileURLToPath(
  new URL(
    "../apps/web/src/features/account/platform-account.api.ts",
    import.meta.url,
  ),
);
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(loaded.error, undefined);
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, tests);
assert.equal(config.errors.length, 0);
const formatHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n",
};
function diagnostics(method) {
  const host = ts.createCompilerHost(config.options);
  if (method) {
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (path, version, onError, fresh) => {
      const source = read(path, version, onError, fresh);
      if (!source || path !== apiPath) return source;
      const pattern = new RegExp(`(\\n  ${method}:[\\s\\S]*?)api<unknown>`);
      const typed = source.text.replace(pattern, "$1api<PlatformLogin>");
      assert.notEqual(
        typed,
        source.text,
        `${method} negative-control target must exist`,
      );
      return ts.createSourceFile(path, typed, version, true);
    };
  }
  return ts.getPreEmitDiagnostics(
    ts.createProgram(config.fileNames, config.options, host),
  );
}
const checked = diagnostics();
assert.equal(
  checked.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(checked, formatHost),
);
const controls = [];
for (const method of ["start", "poll", "cancel"]) {
  const unsafe = diagnostics(method).filter(({ file }) =>
    file?.fileName.endsWith("typechecks/platform-login-boundaries.ts"),
  );
  assert(
    unsafe.some(({ code }) => code === 2344),
    `${method}: unknown equality must fail`,
  );
  assert(
    unsafe.some(({ code }) => code === 2578),
    `${method}: unchecked assignment must invalidate @ts-expect-error`,
  );
  controls.push({ method, diagnosticCodes: unsafe.map(({ code }) => code) });
}
console.log(
  JSON.stringify({
    typecheck: "passed",
    negativeControls: controls,
    mutation: "compiler-memory only",
  }),
);
