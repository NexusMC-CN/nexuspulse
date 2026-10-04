import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredFiles = [
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.d.cts",
  "dist/service-worker.js",
  "dist/service-worker.cjs",
  "dist/service-worker.d.ts",
  "dist/service-worker.d.cts",
  "dist/protocol.js",
  "dist/protocol.cjs",
  "dist/protocol.d.ts",
  "dist/protocol.d.cts",
];

for (const relativePath of requiredFiles) {
  if (!existsSync(path.join(root, relativePath))) {
    throw new Error(`Missing build output: ${relativePath}`);
  }
}

const main = await import("nexuspulse");
if (typeof main.createNexusPulse !== "function" || !main.NexusPulse) {
  throw new Error("The main ESM entry does not expose the runtime API");
}

const serviceWorker = await import("nexuspulse/service-worker");
if (typeof serviceWorker.installNexusPulseServiceWorker !== "function") {
  throw new Error("The service-worker ESM entry does not expose its installer");
}

await import("nexuspulse/protocol");

const require = createRequire(import.meta.url);
const commonJsMain = require("nexuspulse");
const commonJsWorker = require("nexuspulse/service-worker");
if (
  typeof commonJsMain.createNexusPulse !== "function" ||
  typeof commonJsWorker.installNexusPulseServiceWorker !== "function"
) {
  throw new Error("The CommonJS package entries do not expose the public API");
}

// Virtual consumers check TypeScript's actual NodeNext export resolution.
for (const extension of ["mts", "cts"]) {
  const consumerPath = path.join(root, `package-consumer.${extension}`);
  const source = [
    'import { createNexusPulse } from "nexuspulse";',
    'import { installNexusPulseServiceWorker } from "nexuspulse/service-worker";',
    'import type { NotificationPayload } from "nexuspulse/protocol";',
    "createNexusPulse();",
    'const payload: NotificationPayload = { title: "ready" };',
    "void payload;",
    "void installNexusPulseServiceWorker;",
  ].join("\n");
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNew) =>
    path.resolve(fileName) === consumerPath
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : readSource(fileName, languageVersion, onError, shouldCreateNew);
  const program = ts.createProgram([consumerPath], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (fileName) => fileName,
        getNewLine: () => "\n",
      }),
    );
  }
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const command =
  process.platform === "win32"
    ? (process.env.ComSpec ?? "cmd.exe")
    : npmCommand;
const commandArgs =
  process.platform === "win32"
    ? ["/d", "/s", "/c", `${npmCommand} ${npmArgs.join(" ")}`]
    : npmArgs;
const packOutput = execFileSync(command, commandArgs, {
  cwd: root,
  encoding: "utf8",
});
const [metadata] = JSON.parse(packOutput);
const files = metadata?.files;
if (!Array.isArray(files)) {
  throw new Error("npm pack did not return a file list");
}

const paths = files.map((file) => file.path);
const unexpected = paths.filter(
  (filePath) =>
    filePath !== "package.json" &&
    filePath !== "README.md" &&
    !filePath.startsWith("dist/"),
);
if (unexpected.length > 0) {
  throw new Error(`Unexpected package files: ${unexpected.join(", ")}`);
}

for (const relativePath of requiredFiles) {
  if (!paths.includes(relativePath.replaceAll("\\", "/"))) {
    throw new Error(`Package is missing ${relativePath}`);
  }
}

console.log(`Package smoke passed (${paths.length} files)`);
