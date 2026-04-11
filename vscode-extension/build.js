const { context, build } = require("esbuild");
const fs = require("fs");
const path = require("path");

/**
 * @type {import('esbuild').BuildOptions}
 */
const nativeConfig = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  minify: true,
  platform: "node",
  outfile: "./out/native/extension.js",
  target: "node16",
  format: "cjs",
  external: ["vscode"],
};

async function main() {
  try {
    if (process.argv.includes("--watch")) {
      const nativeContext = await context({
        ...nativeConfig,
        sourcemap: true,
        minify: false,
      });
      await nativeContext.watch();
    } else {
      await build(nativeConfig);
    }
  } catch (error) {
    console.error(error);
  }
}

main();
