#!/usr/bin/env node

const { execSync } = require("child_process");
const os = require("os");
const fs = require("fs");

function checkLiburing() {
  const platform = os.platform();

  // Only check on Linux
  if (platform !== "linux") {
    console.log("ℹ️  Async I/O with io_uring is only supported on Linux.");
    return;
  }

  try {
    // Try to find liburing using pkg-config
    execSync("pkg-config --exists liburing", { stdio: "ignore" });
    console.log("✅ liburing is installed and available.");
    return;
  } catch (error) {
    // liburing not found via pkg-config, check if library exists
    try {
      execSync("ldconfig -p | grep liburing", { stdio: "ignore" });
      console.log("✅ liburing library found.");
      return;
    } catch (e) {
      // Not found at all
    }
  }

  // liburing not found - show installation instructions
  console.log("\n⚠️  liburing not found on your system.");
  console.log("📦 Async I/O features require liburing to be installed.\n");

  // Detect Linux distribution
  let distro = "";
  try {
    if (fs.existsSync("/etc/os-release")) {
      const osRelease = fs.readFileSync("/etc/os-release", "utf8");
      const idLine = osRelease
        .split("\n")
        .find((line) => line.startsWith("ID="));
      if (idLine) {
        distro = idLine.split("=")[1].replace(/"/g, "").toLowerCase();
      }
    }
  } catch (e) {
    // Ignore errors
  }

  console.log("Installation instructions:");

  if (distro.includes("ubuntu") || distro.includes("debian")) {
    console.log("  Debian/Ubuntu:");
    console.log("    sudo apt-get update");
    console.log("    sudo apt-get install liburing-dev\n");
  } else if (
    distro.includes("fedora") ||
    distro.includes("rhel") ||
    distro.includes("centos")
  ) {
    console.log("  Fedora/RHEL/CentOS:");
    console.log("    sudo dnf install liburing-devel\n");
  } else if (distro.includes("arch")) {
    console.log("  Arch Linux:");
    console.log("    sudo pacman -S liburing\n");
  } else if (distro.includes("opensuse")) {
    console.log("  openSUSE:");
    console.log("    sudo zypper install liburing-devel\n");
  } else if (distro.includes("alpine")) {
    console.log("  Alpine Linux:");
    console.log("    sudo apk add liburing-dev\n");
  } else {
    console.log(
      "  Please install liburing-dev (or liburing-devel) for your distribution.\n",
    );
  }

  console.log(
    "ℹ️  Yo will work without liburing, but async I/O operations will not be available.",
  );
  // console.log('   You can compile with --allocator libc to avoid any io_uring dependencies.\n');
}

checkLiburing();
