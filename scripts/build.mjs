import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  minify: true,
  legalComments: "none",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.log("Built dist/index.js");
