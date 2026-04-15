import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "fs";
import * as path from "path";

/**
 * Agent directories that may contain a skills/ subdirectory.
 * Checked in order; files are copied to ALL that exist.
 */
const AGENT_DIRS = [
  ".github",
  ".agents",
  ".claude",
  ".opencode",
  ".openai",
  ".cursor",
];

/**
 * Walk up the directory tree from `startPath` looking for a `.github/skills`
 * directory — the same pattern used by `findStdDirectory` for the std library.
 */
function findBundledSkillsDir(startPath: string): string | undefined {
  let currentPath = startPath;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(currentPath, ".github", "skills");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(currentPath);
    if (parent === currentPath) {
      return undefined;
    }
    currentPath = parent;
  }
}

/** Recursively copy `src` directory into `dest` directory. */
function copyDirRecursive(
  src: string,
  dest: string,
  stats: { created: number; overwritten: number },
  displayPrefix: string
): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcEntry = path.join(src, entry);
    const destEntry = path.join(dest, entry);
    const displayPath = path.join(displayPrefix, entry);
    if (statSync(srcEntry).isDirectory()) {
      copyDirRecursive(srcEntry, destEntry, stats, displayPath);
    } else {
      const existed = existsSync(destEntry);
      copyFileSync(srcEntry, destEntry);
      if (existed) {
        console.log(`  overwrite  ${displayPath}`);
        stats.overwritten++;
      } else {
        console.log(`  create     ${displayPath}`);
        stats.created++;
      }
    }
  }
}

export interface SkillsInstallOptions {
  /** Working directory to install skills into (default: process.cwd()) */
  cwd?: string;
}

export async function runSkillsInstall(
  options: SkillsInstallOptions = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  // Locate the bundled skills shipped with this package
  const bundledSkillsDir = findBundledSkillsDir(__dirname);
  if (!bundledSkillsDir) {
    console.error(
      "Error: Could not locate bundled skill files. " +
        "This is likely a packaging issue — please file a bug report."
    );
    process.exit(1);
  }

  // Collect skill entries (directories) from the bundled skills directory
  const skillEntries = readdirSync(bundledSkillsDir);

  if (skillEntries.length === 0) {
    console.log("No skill files found in the bundled skills directory.");
    return;
  }

  // Find which agent directories exist in the target project
  const presentAgentDirs = AGENT_DIRS.filter((dir) => {
    const fullPath = path.join(cwd, dir);
    return existsSync(fullPath) && statSync(fullPath).isDirectory();
  });

  // If none exist, create .agents as the default
  const targetParentDirs =
    presentAgentDirs.length > 0 ? presentAgentDirs : [".agents"];

  const totalStats = { created: 0, overwritten: 0 };

  for (const parentDir of targetParentDirs) {
    const destSkillsDir = path.join(cwd, parentDir, "skills");
    mkdirSync(destSkillsDir, { recursive: true });

    for (const entry of skillEntries) {
      const srcEntry = path.join(bundledSkillsDir, entry);
      const destEntry = path.join(destSkillsDir, entry);
      const displayPrefix = path.join(parentDir, "skills", entry);

      if (statSync(srcEntry).isDirectory()) {
        copyDirRecursive(srcEntry, destEntry, totalStats, displayPrefix);
      } else {
        const existed = existsSync(destEntry);
        copyFileSync(srcEntry, destEntry);
        if (existed) {
          console.log(`  overwrite  ${displayPrefix}`);
          totalStats.overwritten++;
        } else {
          console.log(`  create     ${displayPrefix}`);
          totalStats.created++;
        }
      }
    }
  }

  const locations = targetParentDirs
    .map((d) => path.join(d, "skills"))
    .join(", ");
  const total = totalStats.created + totalStats.overwritten;
  const summary =
    totalStats.overwritten > 0
      ? `${totalStats.created} created, ${totalStats.overwritten} overwritten`
      : `${total} created`;
  console.log(
    `\nInstalled ${skillEntries.length} skill(s) to ${targetParentDirs.length} location(s) (${locations}): ${summary}`
  );
}
