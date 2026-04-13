const { context, build } = require("esbuild");
const { dependencies, devDependencies } = require("./package.json");
const fs = require("fs");
const path = require("path");

/**
 * @type {import('esbuild').BuildOptions}
 */
const sharedConfig = {
  entryPoints: ["./src/index.ts"],
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
const cjsCliConfig = {
  ...sharedConfig,
  entryPoints: ["./src/yo-cli.ts"],
  platform: "node",
  outdir: "./out/cjs",
  outExtension: { ".js": ".cjs" },
  target: "node16",
  banner: {
    js: "#!/usr/bin/env node",
  },
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

/**
 * @type {import('esbuild').BuildOptions}
 */
const lspConfig = {
  ...sharedConfig,
  entryPoints: ["./src/lsp/server.ts"],
  platform: "node",
  outfile: "./out/cjs/yo-lsp.cjs",
  target: "node16",
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Override external: bundle vscode-languageserver deps into the LSP server
  // so it works standalone when installed as a VS Code extension
  external: sharedConfig.external.filter(
    (dep) =>
      !dep.startsWith("vscode-languageserver") &&
      dep !== "vscode-languageserver-textdocument"
  ),
};

async function main() {
  try {
    // Delete the existing out directory to remove old files
    const outDir = path.join(__dirname, "out");
    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
      console.log("Cleaned out directory");
    }

    if (process.argv.includes("--watch")) {
      // CommonJS
      const cjsContext = await context({
        ...cjsConfig,
        sourcemap: true,
      });

      // CommonJS CLI
      const cjsCliContext = await context({
        ...cjsCliConfig,
        sourcemap: true,
      });

      // ESM
      const esmContext = await context({
        ...esmConfig,
        sourcemap: true,
      });

      // LSP Server
      const lspContext = await context({
        ...lspConfig,
        sourcemap: true,
      });

      await Promise.all([
        cjsContext.watch(),
        cjsCliContext.watch(),
        esmContext.watch(),
        lspContext.watch(),
      ]);
    } else {
      // CommonJS
      await build(cjsConfig);

      // CommonJS CLI
      await build(cjsCliConfig);

      // ESM
      await build(esmConfig);

      // LSP Server
      await build(lspConfig);
    }
  } catch (error) {
    console.error(error);
  }
}

main();
