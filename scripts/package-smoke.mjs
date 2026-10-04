import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredFiles = [
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/service-worker.js",
  "dist/service-worker.cjs",
  "dist/service-worker.d.ts",
];

for (const relativePath of requiredFiles) {
  if (!existsSync(path.join(root, relativePath))) {
    throw new Error(`Missing build output: ${relativePath}`);
  }
}

const main = await import(
  `${pathToFileURL(path.join(root, "dist/index.js"))}?package-smoke`
);
if (typeof main.createNexusPulse !== "function" || !main.NexusPulse) {
  throw new Error("The main ESM entry does not expose the runtime API");
}

const serviceWorker = await import(
  `${pathToFileURL(path.join(root, "dist/service-worker.js"))}?package-smoke`
);
if (typeof serviceWorker.installNexusPulseServiceWorker !== "function") {
  throw new Error("The service-worker ESM entry does not expose its installer");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = ["pack", "--dry-run", "--json"];
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
const jsonStart = packOutput.search(/\[\s*\{\s*"id"/s);
if (jsonStart < 0) {
  throw new Error("Could not parse npm pack --dry-run output");
}

const [metadata] = JSON.parse(packOutput.slice(jsonStart));
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
