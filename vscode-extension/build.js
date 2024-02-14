const { context, build } = require("esbuild");

/**
 * @type {import('esbuild').BuildOptions}
 */
const nativeConfig = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  minify: true,
  platform: "node", // For CJS
  outfile: "./out/native/extension.js",
  target: "node16",
  format: "cjs",
  external: ["vscode"],
};

async function main() {
  try {
    // Watch mode
    if (process.argv.includes("--watch")) {
      // Native
      const nativeContext = await context({
        ...nativeConfig,
        sourcemap: true,
        minify: false,
        plugins: [...(nativeConfig.plugins ?? [])],
      });

      await Promise.all([nativeContext.watch()]);
    } else {
      // Build mode
      await Promise.all([build(nativeConfig)]);
    }
  } catch (error) {
    console.error(error);
  }
}

main();
