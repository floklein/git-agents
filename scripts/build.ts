const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  outdir: "./dist",
  target: "bun",
  minify: true,
  external: ["@opentui/core", "@opentui/react", "react"],
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Prepend shebang so the file is executable as a CLI
const outfile = "./dist/index.js";
const content = await Bun.file(outfile).text();
await Bun.write(outfile, "#!/usr/bin/env bun\n" + content);

console.log("Built dist/index.js");
