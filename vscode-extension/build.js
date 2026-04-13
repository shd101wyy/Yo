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

/**
 * Copy the LSP server bundle into the extension's out/ directory
 * so it's included in the .vsix package.
 */
function copyLspServer() {
  const src = path.join(__dirname, "..", "out", "cjs", "yo-lsp.cjs");
  const dest = path.join(__dirname, "out", "yo-lsp.cjs");

  if (!fs.existsSync(src)) {
    console.warn(
      `⚠ LSP server not found at ${src}. Run 'bun run build' in the project root first.`
    );
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied LSP server → ${dest}`);
}

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
    copyLspServer();
  } catch (error) {
    console.error(error);
  }
}

main();
