import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/fastify.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["fastify", "fastify-plugin", "nexuspulse"],
});
