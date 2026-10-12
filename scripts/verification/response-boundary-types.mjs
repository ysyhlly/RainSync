import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Compiler-only validation. Each negative control mutates exactly one API call
// in the compiler host, never a checkout file or a running application.
const configPath = fileURLToPath(
  new URL("../../tests/tsconfig.response-boundaries.json", import.meta.url),
);
const sourcePath = (name) =>
  fileURLToPath(
    new URL(`../../apps/web/src/features/account/${name}`, import.meta.url),
  );
const controls = [
  [
    "platform-account.api.ts",
    "platformAccountApi",
    "status",
    "PlatformAccountStatus",
  ],
  ...["start", "poll", "cancel"].map((method) => [
    "platform-account.api.ts",
    "platformAccountApi",
    method,
    "PlatformLogin",
  ]),
  ...["status", "disable"].map((method) => [
    "platform-renewal.api.ts",
    "bilibiliRenewalApi",
    method,
    "BilibiliRenewalStatus",
  ]),
  ...[
    "status",
    "start",
    "read",
    "poll",
    "cancel",
    "disableRenewal",
    "unlink",
  ].map((method) => [
    "platform-oauth.api.ts",
    "platformOAuthApi",
    method,
    ["status", "disableRenewal", "unlink"].includes(method)
      ? "OAuthStatus"
      : "OAuthLogin",
  ]),
];
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(loaded.error, undefined);
const config = ts.parseJsonConfigFileContent(
  loaded.config,
  ts.sys,
  fileURLToPath(new URL("../../tests/", import.meta.url)),
);
assert.equal(config.errors.length, 0);
const formatHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n",
};
function mutateTransport(source, factory, method, dto) {
  const declarations = [],
    calls = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === factory
    )
      declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(declarations.length, 1, `one ${factory} declaration required`);
  const properties = [];
  const locateProperty = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === method
    )
      properties.push(node);
    ts.forEachChild(node, locateProperty);
  };
  locateProperty(declarations[0]);
  assert.equal(
    properties.length,
    1,
    `one ${factory}.${method} property required`,
  );
  const locateCall = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "api"
    )
      calls.push(node);
    ts.forEachChild(node, locateCall);
  };
  locateCall(properties[0].initializer);
  assert.equal(
    calls.length,
    1,
    `one transport call required in ${factory}.${method}`,
  );
  assert.equal(calls[0].typeArguments?.length, 1);
  const type = calls[0].typeArguments[0];
  assert.equal(
    type.kind,
    ts.SyntaxKind.UnknownKeyword,
    `negative control requires unknown in ${factory}.${method}`,
  );
  return (
    source.text.slice(0, type.getStart(source)) +
    dto +
    source.text.slice(type.end)
  );
}
function diagnostics(control) {
  const host = ts.createCompilerHost(config.options);
  let mutations = 0;
  if (control) {
    const [filename, factory, method, dto] = control;
    const target = sourcePath(filename),
      read = host.getSourceFile.bind(host);
    host.getSourceFile = (
      path,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const source = read(
        path,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
      if (!source || path !== target) return source;
      ++mutations;
      return ts.createSourceFile(
        path,
        mutateTransport(source, factory, method, dto),
        languageVersion,
        true,
      );
    };
  }
  const program = ts.createProgram(config.fileNames, config.options, host);
  const result = ts.getPreEmitDiagnostics(program);
  if (control)
    assert.equal(
      mutations,
      1,
      "negative-control source must be used exactly once",
    );
  return result;
}
const checked = diagnostics();
assert.equal(
  checked.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(checked, formatHost),
);
const results = [];
for (const control of controls) {
  const bypassed = diagnostics(control);
  const fixtureCodes = bypassed
    .filter(({ file }) =>
      file?.fileName.endsWith("typechecks/response-boundaries.ts"),
    )
    .map(({ code }) => code);
  assert(
    fixtureCodes.includes(2344),
    `${control[1]}.${control[2]} bypass must fail unknown equality`,
  );
  assert(
    fixtureCodes.includes(2578),
    `${control[1]}.${control[2]} bypass must invalidate its unparsed assignment negative control`,
  );
  results.push({
    method: `${control[1]}.${control[2]}`,
    diagnosticCodes: [...new Set(fixtureCodes)].sort(),
  });
}
console.log(
  JSON.stringify({
    typecheck: "passed",
    negativeControls: results,
    mutation: "in-memory only",
  }),
);
