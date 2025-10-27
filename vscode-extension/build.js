const { context, build } = require("esbuild");
const fs = require("fs");
const path = require("path");

/**
 * Recursively copy a directory from source to destination
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 */
function copyDirectory(src, dest) {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  // Read the source directory
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Recursively copy subdirectories
      copyDirectory(srcPath, destPath);
    } else {
      // Copy files
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy the std directory from parent level to ./out/std
 */
function copyStdDirectory() {
  const stdSrcPath = path.join(__dirname, "..", "std");
  const stdDestPath = path.join(__dirname, "out", "std");

  try {
    if (fs.existsSync(stdSrcPath)) {
      console.log("Copying std directory...");
      
      // Remove the old std directory first to ensure clean copy
      if (fs.existsSync(stdDestPath)) {
        fs.rmSync(stdDestPath, { recursive: true, force: true });
        console.log("✓ Removed old std directory");
      }
      
      copyDirectory(stdSrcPath, stdDestPath);
      console.log("✓ std directory copied successfully");
    } else {
      console.warn("⚠ std directory not found at:", stdSrcPath);
    }
  } catch (error) {
    console.error("✗ Error copying std directory:", error.message);
  }
}

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

    // Always copy std directory first
    copyStdDirectory();
  } catch (error) {
    console.error(error);
  }
}

main();
