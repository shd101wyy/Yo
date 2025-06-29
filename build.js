const { context, build } = require("esbuild");
const { dependencies, devDependencies } = require("./package.json");

/**
 * @type {import('esbuild').BuildOptions}
 */
const sharedConfig = {
  entryPoints: ["./src/index.ts", "./src/yo-cli.ts"],
  bundle: true,
  minify: true,
  // sourcemap: true,
  external: [
    "fs",
    "path",
    "child_process",
    "os",
    "vm",
    "stream",
    "node:fs",
    "node:fs/promises",
    "url",
    "crypto",
    // === from package.json
    ...Object.keys(dependencies),
    ...Object.keys(devDependencies),
  ],
};

/**
 * @type {import('esbuild').BuildOptions}
 */
const cjsConfig = {
  ...sharedConfig,
  platform: "node", // For CJS
  outdir: "./out/cjs",
  outExtension: { ".js": ".cjs" },
  // outfile: "./out/cjs/index.cjs",
  target: "node16",
};

/**
 * @type {import('esbuild').BuildOptions}
 */
const esmConfig = {
  ...sharedConfig,
  entryPoints: ["./src/index.ts"],
  // TODO: Support browser
  platform: "neutral", // For ESM
  outdir: "./out/esm",
  outExtension: { ".js": ".mjs" },
  // outfile: "./out/esm/index.mjs",
};

async function main() {
  try {
    if (process.argv.includes("--watch")) {
      // CommonJS
      const cjsContext = await context({
        ...cjsConfig,
        sourcemap: true,
      });

      // ESM
      const esmContext = await context({
        ...esmConfig,
        sourcemap: true,
      });

      await Promise.all([cjsContext.watch(), esmContext.watch()]);
    } else {
      // CommonJS
      await build(cjsConfig);

      // ESM
      await build(esmConfig);
    }
  } catch (error) {
    console.error(error);
  }
}

main();
