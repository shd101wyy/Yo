#!/usr/bin/env node
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */

const fs = require("fs");
const path = require("path");

function printWelcome() {
  // Find package.json - could be in the installed package or a dependency
  let packageJsonPath;

  // Try to find the @shd101wyy/yo package.json
  const possiblePaths = [path.join(__dirname, "..", "package.json")];

  // Also try to resolve from node_modules (when installed as a dependency)
  try {
    possiblePaths.push(require.resolve("@shd101wyy/yo/package.json"));
  } catch (e) {
    // Module not found, that's okay - we'll use the local path
  }

  for (const pkgPath of possiblePaths) {
    try {
      if (fs.existsSync(pkgPath)) {
        packageJsonPath = pkgPath;
        break;
      }
    } catch (e) {
      // Continue to next path
    }
  }

  if (!packageJsonPath || !fs.existsSync(packageJsonPath)) {
    return; // Silently fail if we can't find the package.json
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const version = packageJson.version;

    if (!version) {
      return;
    }

    console.log("");
    console.log("👋 Welcome to Yo!");
    console.log(`   You have installed @shd101wyy/yo@${version}`);
    console.log("");
  } catch (e) {
    // Silently fail - don't want to break installation
  }
}

printWelcome();
