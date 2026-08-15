#!/usr/bin/env bun
/**
 * Build the documentation website for https://shd101wyy.github.io/Yo/
 *
 * Output structure:
 *   site/
 *     index.html        ← README.md rendered as HTML (homepage)
 *     Yo_logo.png       ← copied logo
 *     std/              ← generated std library docs
 *       index.html      ← std library index
 *       module/         ← per-module pages
 *         string.html
 *         ...
 *
 * Usage:
 *   bun run scripts/build-site.ts [--output <dir>]
 */

import * as fs from "fs";
import * as path from "path";
import { createRenderer } from "markdown_yo";
import type { MarkdownRenderer } from "markdown_yo";
import { execFileSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const GITHUB_REPO = "https://github.com/shd101wyy/Yo";

// Detect the exact tag on HEAD for stable GitHub blob links.
// Falls back to "develop" if HEAD has no exact tag or git fails.
export function getExactTagOrDevelop(rootDir: string = ROOT): string {
  try {
    const result = execFileSync(
      "git",
      ["describe", "--tags", "--exact-match", "HEAD"],
      {
        cwd: rootDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }
    ).trim();
    return result || "develop";
  } catch {
    return "develop";
  }
}

export function getStdDocCommand(rootDir: string = ROOT): {
  command: string;
  args: string[];
} {
  return {
    command: "node",
    args: [path.join(rootDir, "out", "cjs", "yo-cli.cjs"), "doc", "std/"],
  };
}

// ── Parse args ───────────────────────────────────────────────────────

let outputDir = path.join(ROOT, "site");
let siteVersion: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output" && args[i + 1]) {
    outputDir = path.resolve(args[i + 1]!);
    i++;
  } else if (args[i] === "--version" && args[i + 1]) {
    siteVersion = args[i + 1]!;
    i++;
  }
}

// Fallback: auto-detect version from git (tag or commit hash)
if (!siteVersion) {
  siteVersion = detectGitVersion(ROOT);
}

// Use the explicit version (e.g., "v0.1.17" from --version flag) for blob links
// when it looks like a tag; otherwise use the exact tag on HEAD; otherwise "develop".
const GITHUB_REF =
  siteVersion && /^v\d/.test(siteVersion)
    ? siteVersion
    : getExactTagOrDevelop(ROOT);
const GITHUB_BLOB = `${GITHUB_REPO}/blob/${GITHUB_REF}`;

function detectGitVersion(cwd: string): string | undefined {
  function git(...gitArgs: string[]): string | undefined {
    try {
      return (
        execFileSync("git", gitArgs, {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  // Show exact tag only if HEAD is exactly at that tag; otherwise show short commit hash
  return (
    git("describe", "--tags", "--exact-match", "HEAD") ??
    git("rev-parse", "--short", "HEAD")
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Rewrite relative links in the README for the deployed site.
 *
 * - `./Yo_logo.png` → `Yo_logo.png` (local asset)
 * - `./docs/en-US/X.md` → GitHub blob link
 * - `./docs/zh-CN/X.md` → GitHub blob link
 * - `./vscode-extension/...` → GitHub blob link
 * - `./plans/...` → GitHub blob link
 * - `https://shd101wyy.github.io/Yo/` → `std/index.html` (relative, same site)
 * - `#anchor` links → kept as-is
 */
/**
 * Generate a GitHub-compatible slug from heading text.
 * - Strip HTML tags
 * - Lowercase
 * - Replace spaces with hyphens
 * - Remove non-alphanumeric characters (except hyphens)
 */
function slugify(text: string): string {
  return text
    .replace(/<[^>]+>/g, "") // strip HTML tags
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Add `id` attributes to heading elements so that #anchor links work.
 * Handles duplicate slugs by appending `-1`, `-2`, etc.
 */
function injectHeadingIds(html: string): string {
  const slugCounts = new Map<string, number>();
  return html.replace(
    /<(h[1-6])>([\s\S]*?)<\/\1>/gi,
    (_match: string, tag: string, content: string) => {
      let slug = slugify(content);
      const count = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, count + 1);
      if (count > 0) slug = `${slug}-${count}`;
      return `<${tag} id="${slug}">${content}</${tag}>`;
    }
  );
}

function rewriteReadmeLinks(html: string): string {
  // Rewrite the generated docs link to relative std/ path (same site)
  html = html.replace(
    /href="https:\/\/shd101wyy\.github\.io\/Yo\/"/g,
    'href="std/index.html"'
  );

  // Rewrite href links — any relative path that isn't an anchor, absolute URL,
  // or our own site paths (std/) gets rewritten to GitHub blob links.
  html = html.replace(/href="([^"]+)"/g, (_match: string, href: string) => {
    // Keep absolute URLs, anchors, and std/ links
    if (
      href.startsWith("http") ||
      href.startsWith("#") ||
      href.startsWith("std/") ||
      href.startsWith("mailto:")
    ) {
      return _match;
    }
    // Strip leading "./" if present
    const relPath = href.startsWith("./") ? href.slice(2) : href;
    // Keep local assets that we copy to the site
    if (relPath === "Yo_logo.png" || relPath === "path_uniqueness.png") {
      return `href="${relPath}"`;
    }
    // Rewrite to GitHub
    return `href="${GITHUB_BLOB}/${relPath}"`;
  });

  // Rewrite src links (images)
  html = html.replace(/src="([^"]+)"/g, (_match: string, src: string) => {
    if (src.startsWith("http")) return _match;
    const relPath = src.startsWith("./") ? src.slice(2) : src;
    if (relPath === "Yo_logo.png" || relPath === "path_uniqueness.png") {
      return `src="${relPath}"`;
    }
    return `src="${GITHUB_BLOB}/${relPath}?raw=true"`;
  });

  return html;
}

function generateHomepageCSS(): string {
  return `
:root {
  --bg: #fff;
  --bg-code: #f7f7f7;
  --bg-code-block: #282c34;
  --text: #1a1a1a;
  --text-secondary: #555;
  --text-code: #abb2bf;
  --accent: #4a90d9;
  --accent-hover: #357abd;
  --border: #e0e0e0;
  --border-light: #eee;
  --shadow: rgba(0,0,0,0.05);
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace;
  --max-content: 860px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a2e;
    --bg-code: #0f3460;
    --bg-code-block: #1e1e2e;
    --text: #e0e0e0;
    --text-secondary: #a0a0a0;
    --text-code: #abb2bf;
    --accent: #6cb4ee;
    --accent-hover: #8fcbff;
    --border: #2a2a4a;
    --border-light: #252545;
    --shadow: rgba(0,0,0,0.2);
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.7;
  color: var(--text);
  background: var(--bg);
}

.container {
  max-width: var(--max-content);
  margin: 0 auto;
  padding: 40px 24px 80px;
}

/* Typography */
h1 { font-size: 2.2em; margin: 1em 0 0.5em; border-bottom: 2px solid var(--border); padding-bottom: 0.3em; }
h2 { font-size: 1.6em; margin: 1.5em 0 0.5em; border-bottom: 1px solid var(--border-light); padding-bottom: 0.2em; }
h3 { font-size: 1.3em; margin: 1.2em 0 0.4em; }
h4 { font-size: 1.1em; margin: 1em 0 0.3em; }
p { margin: 0.8em 0; }
ul, ol { margin: 0.8em 0 0.8em 1.5em; }
li { margin: 0.3em 0; }

a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); text-decoration: underline; }

img { max-width: 100%; height: auto; }

code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-code);
  padding: 0.15em 0.4em;
  border-radius: 4px;
}

pre {
  background: var(--bg-code-block);
  color: var(--text-code);
  padding: 16px 20px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 1em 0;
  font-size: 0.9em;
  line-height: 1.5;
}

pre code {
  background: none;
  padding: 0;
  color: inherit;
}

blockquote {
  border-left: 4px solid var(--accent);
  margin: 1em 0;
  padding: 0.5em 1em;
  background: var(--bg-code);
  border-radius: 0 4px 4px 0;
}

table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}

th, td {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}

th {
  background: var(--bg-code);
  font-weight: 600;
}

/* Header banner */
.site-header {
  text-align: center;
  padding: 30px 0 20px;
  border-bottom: 2px solid var(--border);
  margin-bottom: 30px;
}

.site-header img {
  width: 80px;
  height: 80px;
  margin-bottom: 10px;
}

.site-header h1 {
  border: none;
  margin: 0;
  padding: 0;
  font-size: 2.5em;
}

.site-header .tagline {
  color: var(--text-secondary);
  font-size: 1.1em;
  margin-top: 8px;
}

.version-badge {
  font-size: 0.4em;
  font-weight: 500;
  color: var(--accent);
  background: var(--bg-secondary);
  padding: 2px 10px;
  border-radius: 4px;
  vertical-align: middle;
  margin-left: 8px;
}

.site-nav {
  margin-top: 16px;
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
}

.site-nav a {
  display: inline-block;
  padding: 6px 16px;
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.95em;
}

.site-nav a:hover {
  background: var(--accent-hover);
  text-decoration: none;
}

/* Footer */
.site-footer {
  text-align: center;
  padding: 30px 0;
  margin-top: 60px;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 0.9em;
}
`;
}

function wrapHomepage(
  title: string,
  bodyHtml: string,
  css: string,
  version?: string
): string {
  const versionBadge = version
    ? `<span class="version-badge">${escapeHtml(version)}</span>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
  <div class="container">
    <div class="site-header">
      <img src="Yo_logo.png" alt="Yo logo" width="80" height="80">
      <h1>Yo Programming Language ${versionBadge}</h1>
      <p class="tagline">A general-purpose, ahead-of-time compiled language with algebraic effects</p>
      <div class="site-nav">
        <a href="${GITHUB_REPO}">GitHub</a>
        <a href="std/index.html">Standard Library</a>
        <a href="${GITHUB_BLOB}/docs/en-US/DESIGN.md">Language Design</a>
      </div>
    </div>
    <div class="readme-content">
${bodyHtml}
    </div>
    <div class="site-footer">
      <p>Yo Programming Language &mdash; <a href="${GITHUB_REPO}">GitHub</a> &middot; <a href="std/index.html">Std Library Docs</a></p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Post-process generated std doc HTML files to add a "← Home" link
 * in the sidebar header, pointing back to the main site homepage.
 */
function injectHomeLinks(stdDir: string): void {
  const homeLink = `<a href="../index.html" style="display:block;margin-bottom:8px;font-size:0.85em;color:var(--text-secondary);text-decoration:none;">← Home</a>`;
  const homeLinkFromModule = `<a href="../../index.html" style="display:block;margin-bottom:8px;font-size:0.85em;color:var(--text-secondary);text-decoration:none;">← Home</a>`;

  // Process std/index.html
  const indexPath = path.join(stdDir, "index.html");
  if (fs.existsSync(indexPath)) {
    let content = fs.readFileSync(indexPath, "utf-8");
    content = content.replace(
      '<div class="sidebar-header">',
      `<div class="sidebar-header">\n  ${homeLink}`
    );
    fs.writeFileSync(indexPath, content, "utf-8");
  }

  // Process std/module/*.html
  const moduleDir = path.join(stdDir, "module");
  if (fs.existsSync(moduleDir)) {
    for (const file of fs.readdirSync(moduleDir)) {
      if (!file.endsWith(".html")) continue;
      const filePath = path.join(moduleDir, file);
      let content = fs.readFileSync(filePath, "utf-8");
      content = content.replace(
        '<div class="sidebar-header">',
        `<div class="sidebar-header">\n  ${homeLinkFromModule}`
      );
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  console.log("Building documentation site...");
  console.log(`  Output: ${outputDir}`);

  // Clean and create output directory
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  // ── Step 1: Render README.md as homepage ──
  console.log("\n[1/3] Rendering homepage from README.md...");
  const readmeSrc = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");

  const md: MarkdownRenderer = await createRenderer(null, {
    html: true,
    fullFeatures: true,
  });

  let readmeHtml = md.render(readmeSrc);
  readmeHtml = injectHeadingIds(readmeHtml);
  readmeHtml = rewriteReadmeLinks(readmeHtml);

  const css = generateHomepageCSS();
  const homepage = wrapHomepage(
    "Yo Programming Language",
    readmeHtml,
    css,
    siteVersion
  );
  fs.writeFileSync(path.join(outputDir, "index.html"), homepage, "utf-8");
  console.log("  ✓ index.html");

  md.destroy();

  // ── Step 2: Copy static assets ──
  console.log("\n[2/3] Copying static assets...");
  const logoSrc = path.join(ROOT, "Yo_logo.png");
  if (fs.existsSync(logoSrc)) {
    fs.copyFileSync(logoSrc, path.join(outputDir, "Yo_logo.png"));
    console.log("  ✓ Yo_logo.png");
  }

  // Copy path_uniqueness.png if it exists (referenced in README)
  const pathUniqSrc = path.join(ROOT, "path_uniqueness.png");
  if (fs.existsSync(pathUniqSrc)) {
    fs.copyFileSync(pathUniqSrc, path.join(outputDir, "path_uniqueness.png"));
    console.log("  ✓ path_uniqueness.png");
  }

  // Publish the installers at the site ROOT, so the canonical one-liner is
  // `curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh` rather than a
  // raw.githubusercontent.com URL with a branch name baked into it
  // (plans/P3_DISTRIBUTION.md item 1). A raw URL is a bad contract to publish:
  // it pins a branch, and anything printed in a README or a blog post outlives
  // the branch name.
  //
  // FAIL LOUDLY if either is missing. A silently absent installer turns the
  // documented one-liner into `curl` piping a 404 page into `sh`, which is far
  // worse than a broken build.
  for (const installer of ["install.sh", "install.ps1"]) {
    const src = path.join(ROOT, "scripts", installer);
    if (!fs.existsSync(src)) {
      throw new Error(
        `build-site: scripts/${installer} is missing. The published site would ` +
          `serve a 404 at /${installer}, and the documented one-liner pipes that ` +
          `into a shell. Refusing to build.`
      );
    }
    fs.copyFileSync(src, path.join(outputDir, installer));
    console.log(`  ✓ ${installer}`);
  }

  // ── Step 3: Generate std library docs ──
  console.log("\n[3/3] Generating standard library documentation...");
  const stdOutputDir = path.join(outputDir, "std");

  try {
    const stdDocCommand = getStdDocCommand();
    const docArgs = [...stdDocCommand.args, "--output", stdOutputDir];
    if (siteVersion) {
      docArgs.push("--version", siteVersion);
    }
    execFileSync(stdDocCommand.command, docArgs, {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 600_000,
    });
    console.log("  ✓ Standard library docs generated");
  } catch (err) {
    console.error(
      "  ✗ Failed to generate std docs:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }

  // Post-process std docs: inject "← Home" link in sidebar headers
  injectHomeLinks(stdOutputDir);

  // ── Summary ──
  const moduleCount = fs.existsSync(path.join(stdOutputDir, "module"))
    ? fs.readdirSync(path.join(stdOutputDir, "module")).length
    : 0;
  console.log(`\n✓ Site built successfully!`);
  console.log(`  Homepage: ${outputDir}/index.html`);
  console.log(
    `  Std docs: ${stdOutputDir}/index.html (${moduleCount} modules)`
  );
  console.log(`  Total size: ${getTotalSize(outputDir)} KB`);
}

function getTotalSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getTotalSize(fullPath);
    } else {
      total += fs.statSync(fullPath).size;
    }
  }
  return Math.round(total / 1024);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
