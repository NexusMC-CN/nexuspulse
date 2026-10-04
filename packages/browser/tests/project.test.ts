import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createNexusPulse, NexusPulse } from "../src/index.js";

describe("nexuspulse project contract", () => {
  it("exports the factory and runtime NexusPulse symbol", () => {
    expect(typeof createNexusPulse).toBe("function");
    expect(NexusPulse).toBeDefined();
  });

  it("declares the service-worker package export", async () => {
    const packageJsonPath = fileURLToPath(
      new URL("../package.json", import.meta.url),
    );
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports?.["./service-worker"]).toBeDefined();
    expect(packageJson.exports?.["./protocol"]).toBeDefined();
  });

  it("routes ESM and CommonJS consumers to matching declaration formats", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.exports["."]).toEqual({
      import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
      require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
    });
    expect(packageJson.exports["./service-worker"]).toEqual({
      import: {
        types: "./dist/service-worker.d.ts",
        default: "./dist/service-worker.js",
      },
      require: {
        types: "./dist/service-worker.d.cts",
        default: "./dist/service-worker.cjs",
      },
    });
    expect(packageJson.exports["./protocol"]).toEqual({
      import: {
        types: "./dist/protocol.d.ts",
        default: "./dist/protocol.js",
      },
      require: {
        types: "./dist/protocol.d.cts",
        default: "./dist/protocol.cjs",
      },
    });
  });

  it.skipIf(
    !existsSync(fileURLToPath(new URL("../dist/index.js", import.meta.url))),
  )("loads the built ESM entries", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const main = await import(
      `${pathToFileURL(path.join(root, "dist/index.js"))}?project-test`
    );
    const serviceWorker = await import(
      `${pathToFileURL(path.join(root, "dist/service-worker.js"))}?project-test`
    );

    expect(typeof main.createNexusPulse).toBe("function");
    expect(main.NexusPulse).toBeDefined();
    expect(typeof serviceWorker.installNexusPulseServiceWorker).toBe(
      "function",
    );
  });
});
