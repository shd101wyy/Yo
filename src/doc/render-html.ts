// HTML documentation renderer — generates a fully offline, self-contained
// static HTML site from a DocModel.
//
// Design goals:
//   - Zero external dependencies (no CDN, no external fonts)
//   - Works from file:// URLs
//   - Clean, minimal design inspired by Rust docs
//   - Client-side search via embedded JSON index
//   - All CSS/JS inlined in each page
//   - Uses markdown_yo WASM for Markdown→HTML rendering

import { createRenderer } from "markdown_yo";
import type { MarkdownRenderer } from "markdown_yo";
import type {
  DocModel,
  DocModule,
  DocFunction,
  DocType,
  DocTrait,
  DocConstant,
  DocParam,
  DocField,
  DocVariant,
  DocAssociatedType,
} from "./model";
import * as fs from "fs";
import * as path from "path";

// ── Markdown renderer singleton ──────────────────────────────────────

let mdRenderer: MarkdownRenderer | null = null;

async function getMarkdownRenderer(): Promise<MarkdownRenderer> {
  if (!mdRenderer) {
    mdRenderer = await createRenderer(null, {
      html: true,
      fullFeatures: true,
    });
  }
  return mdRenderer;
}

export function destroyMarkdownRenderer(): void {
  if (mdRenderer) {
    mdRenderer.destroy();
    mdRenderer = null;
  }
}

function renderMarkdown(md: MarkdownRenderer, text: string): string {
  return md.render(text);
}

// ── HTML escaping ────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── CSS styles ───────────────────────────────────────────────────────

function generateCSS(): string {
  return `
:root {
  --bg: #fff;
  --bg-sidebar: #f5f5f5;
  --bg-code: #f7f7f7;
  --bg-code-block: #282c34;
  --text: #1a1a1a;
  --text-secondary: #555;
  --text-sidebar: #333;
  --text-code: #abb2bf;
  --accent: #4a90d9;
  --accent-hover: #357abd;
  --border: #e0e0e0;
  --border-light: #eee;
  --shadow: rgba(0,0,0,0.05);
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace;
  --sidebar-width: 260px;
  --max-content: 900px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a2e;
    --bg-sidebar: #16213e;
    --bg-code: #0f3460;
    --bg-code-block: #1e1e2e;
    --text: #e0e0e0;
    --text-secondary: #a0a0a0;
    --text-sidebar: #c0c0c0;
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
  line-height: 1.6;
  color: var(--text);
  background: var(--bg);
  display: flex;
  min-height: 100vh;
}

/* Sidebar */
.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  padding: 20px 0;
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  overflow-y: auto;
  z-index: 10;
}

.sidebar-header {
  padding: 0 20px 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}

.sidebar-header h2 {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent);
}

.sidebar-header .version {
  font-size: 12px;
  color: var(--text-secondary);
}

.sidebar-section {
  padding: 8px 20px;
}

.sidebar-section h3 {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.sidebar-section a {
  display: block;
  padding: 3px 0;
  color: var(--text-sidebar);
  text-decoration: none;
  font-size: 14px;
}

.sidebar-section a:hover { color: var(--accent); }
.sidebar-section a.active {
  color: var(--accent);
  font-weight: 600;
}

/* Main content */
.main {
  margin-left: var(--sidebar-width);
  flex: 1;
  min-width: 0;
}

.content {
  max-width: var(--max-content);
  margin: 0 auto;
  padding: 32px 40px;
}

/* Search */
.search-box {
  padding: 8px 20px;
  margin-bottom: 8px;
}

.search-box input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 13px;
  background: var(--bg);
  color: var(--text);
  outline: none;
}

.search-box input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(74,144,217,0.2);
}

.search-results {
  padding: 0 20px;
  max-height: 400px;
  overflow-y: auto;
}

.search-results a {
  display: block;
  padding: 6px 8px;
  color: var(--text-sidebar);
  text-decoration: none;
  font-size: 13px;
  border-radius: 4px;
}

.search-results a:hover {
  background: var(--border-light);
  color: var(--accent);
}

.search-results .sr-kind {
  font-size: 11px;
  color: var(--text-secondary);
  margin-left: 6px;
}

/* Typography */
h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
h2 { font-size: 22px; font-weight: 600; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
h3 { font-size: 18px; font-weight: 600; margin: 24px 0 8px; }
h4 { font-size: 15px; font-weight: 600; margin: 16px 0 6px; }

.module-path {
  font-size: 14px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  margin-bottom: 16px;
}

.doc-content {
  margin: 12px 0 24px;
  line-height: 1.7;
}

.doc-content p { margin: 8px 0; }
.doc-content ul, .doc-content ol { margin: 8px 0; padding-left: 24px; }
.doc-content blockquote {
  border-left: 3px solid var(--accent);
  padding: 4px 16px;
  margin: 12px 0;
  color: var(--text-secondary);
}

.doc-content code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-code);
  padding: 2px 5px;
  border-radius: 3px;
}

.doc-content pre {
  background: var(--bg-code-block);
  color: var(--text-code);
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 12px 0;
  font-size: 14px;
  line-height: 1.5;
}

.doc-content pre code {
  background: none;
  padding: 0;
  color: inherit;
}

/* Item cards */
.item-list { margin: 12px 0; }

.item-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 8px 0;
  overflow: hidden;
}

.item-header {
  padding: 10px 16px;
  background: var(--bg-code);
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.item-name {
  font-weight: 600;
  font-family: var(--font-mono);
  font-size: 15px;
  color: var(--accent);
  text-decoration: none;
}

.item-name:hover { text-decoration: underline; }

.item-kind {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-secondary);
  background: var(--bg);
  padding: 2px 6px;
  border-radius: 3px;
}

.item-sig {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50%;
}

.item-body {
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text);
}

.item-body .doc-content { margin: 0; }

/* Detail pages */
.decl-signature {
  font-family: var(--font-mono);
  font-size: 15px;
  background: var(--bg-code);
  padding: 12px 16px;
  border-radius: 6px;
  border: 1px solid var(--border);
  margin: 8px 0 16px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.params-table, .fields-table, .variants-table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 14px;
}

.params-table th, .fields-table th, .variants-table th {
  text-align: left;
  padding: 6px 12px;
  border-bottom: 2px solid var(--border);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-secondary);
}

.params-table td, .fields-table td, .variants-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-light);
  vertical-align: top;
}

.params-table .type-col, .fields-table .type-col {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--accent);
  white-space: nowrap;
}

/* Methods section */
.method-item {
  margin: 16px 0;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  overflow: hidden;
}

.method-header {
  background: var(--bg-code);
  padding: 8px 16px;
  font-family: var(--font-mono);
  font-size: 14px;
}

.method-body {
  padding: 12px 16px;
}

/* Trait impls */
.trait-impl-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}

.trait-impl-badge {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--bg-code);
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--accent);
  text-decoration: none;
}

.trait-impl-badge:hover {
  background: var(--accent);
  color: #fff;
}

/* Deprecated items */
.item-card.deprecated {
  border-color: #d4a017;
  opacity: 0.85;
}
.deprecated-banner {
  background: #fff3cd;
  color: #664d03;
  border: 1px solid #ffecb5;
  border-radius: 4px;
  padding: 8px 12px;
  margin: 8px 0;
  font-size: 13px;
}
[data-theme="dark"] .deprecated-banner {
  background: #332701;
  color: #ffda6a;
  border-color: #664d03;
}

/* Doc sections (Returns, Errors, Examples) */
.doc-section {
  margin: 12px 0;
  border-left: 3px solid var(--accent);
  padding-left: 12px;
}
.doc-section h5 {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-secondary);
  margin: 0 0 4px;
}
.doc-section-content {
  font-size: 14px;
}

/* Index page */
.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin: 16px 0;
}

.module-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  transition: box-shadow 0.15s;
}

.module-card:hover {
  box-shadow: 0 2px 8px var(--shadow);
}

.module-card h3 {
  margin: 0 0 6px;
  font-size: 16px;
}

.module-card h3 a {
  color: var(--accent);
  text-decoration: none;
}

.module-card h3 a:hover { text-decoration: underline; }

.module-card .module-desc {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.module-card .module-stats {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* Breadcrumb */
.breadcrumb {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}

.breadcrumb a {
  color: var(--accent);
  text-decoration: none;
}

.breadcrumb a:hover { text-decoration: underline; }

/* Back to top */
.back-to-top {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px var(--shadow);
  z-index: 20;
}

/* Responsive */
@media (max-width: 768px) {
  .sidebar { display: none; }
  .main { margin-left: 0; }
  .content { padding: 16px 20px; }
  .item-sig { display: none; }
  .module-grid { grid-template-columns: 1fr; }
}
`.trim();
}

// ── Search JS ────────────────────────────────────────────────────────

function generateSearchJS(): string {
  return `
(function() {
  var searchInput = document.getElementById('doc-search');
  var searchResults = document.getElementById('search-results');
  var searchIndex = window.__SEARCH_INDEX || [];

  if (!searchInput) return;

  searchInput.addEventListener('input', function() {
    var query = this.value.toLowerCase().trim();
    searchResults.innerHTML = '';

    if (!query) return;

    var matches = searchIndex.filter(function(item) {
      return item.name.toLowerCase().indexOf(query) !== -1 ||
             (item.doc && item.doc.toLowerCase().indexOf(query) !== -1);
    }).slice(0, 20);

    matches.forEach(function(item) {
      var a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.name;
      var span = document.createElement('span');
      span.className = 'sr-kind';
      span.textContent = item.kind;
      a.appendChild(span);
      searchResults.appendChild(a);
    });
  });

  // Back to top
  var btn = document.getElementById('back-to-top');
  if (btn) {
    window.addEventListener('scroll', function() {
      btn.style.display = window.scrollY > 300 ? 'flex' : 'none';
    });
    btn.addEventListener('click', function() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
})();
`.trim();
}

// ── Search index builder ─────────────────────────────────────────────

interface SearchEntry {
  name: string;
  kind: string;
  href: string;
  doc?: string;
  module: string;
}

function buildSearchIndex(model: DocModel): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const mod of model.modules) {
    entries.push({
      name: mod.name,
      kind: "module",
      href: `module/${mod.name}.html`,
      doc: mod.doc ? firstSentence(mod.doc) : undefined,
      module: mod.name,
    });

    for (const fn of mod.functions) {
      entries.push({
        name: fn.name,
        kind: "function",
        href: `module/${mod.name}.html#fn-${fn.name}`,
        doc: fn.doc ? firstSentence(fn.doc) : undefined,
        module: mod.name,
      });
    }

    for (const t of mod.types) {
      entries.push({
        name: t.name,
        kind: t.kind,
        href: `module/${mod.name}.html#type-${t.name}`,
        doc: t.doc ? firstSentence(t.doc) : undefined,
        module: mod.name,
      });
      for (const m of t.methods) {
        entries.push({
          name: `${t.name}.${m.name}`,
          kind: "method",
          href: `module/${mod.name}.html#method-${t.name}-${m.name}`,
          doc: m.doc ? firstSentence(m.doc) : undefined,
          module: mod.name,
        });
      }
    }

    for (const tr of mod.traits) {
      entries.push({
        name: tr.name,
        kind: "trait",
        href: `module/${mod.name}.html#trait-${tr.name}`,
        doc: tr.doc ? firstSentence(tr.doc) : undefined,
        module: mod.name,
      });
    }

    for (const c of mod.constants) {
      entries.push({
        name: c.name,
        kind: "constant",
        href: `module/${mod.name}.html#const-${c.name}`,
        doc: c.doc ? firstSentence(c.doc) : undefined,
        module: mod.name,
      });
    }
  }

  return entries;
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?\n]+[.!?]?/);
  const result = match ? match[0].trim() : text.trim();
  return result.length > 120 ? result.slice(0, 120).trim() : result;
}

// ── Page layout ──────────────────────────────────────────────────────

function wrapPage(
  title: string,
  content: string,
  sidebar: string,
  searchIndex: SearchEntry[],
  cssText: string,
  jsText: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${cssText}</style>
</head>
<body>
${sidebar}
<div class="main">
<div class="content">
${content}
</div>
</div>
<button id="back-to-top" class="back-to-top" aria-label="Back to top">&uarr;</button>
<script>window.__SEARCH_INDEX = ${JSON.stringify(searchIndex)};</script>
<script>${jsText}</script>
</body>
</html>`;
}

// ── Sidebar rendering ────────────────────────────────────────────────

function renderSidebar(model: DocModel, activeModule?: string): string {
  let html = `<nav class="sidebar">
<div class="sidebar-header">
  <h2>${escapeHtml(model.name)}</h2>
</div>
<div class="search-box">
  <input type="text" id="doc-search" placeholder="Search..." autocomplete="off">
</div>
<div id="search-results" class="search-results"></div>
<div class="sidebar-section">
  <h3>Modules</h3>
  <a href="index.html"${!activeModule ? ' class="active"' : ""}>Overview</a>`;

  for (const mod of model.modules) {
    const active = mod.name === activeModule ? ' class="active"' : "";
    html += `\n  <a href="module/${escapeHtml(mod.name)}.html"${active}>${escapeHtml(mod.name)}</a>`;
  }

  html += `\n</div>`;

  // If we're on a module page, show its items in the sidebar
  if (activeModule) {
    const mod = model.modules.find((m) => m.name === activeModule);
    if (mod) {
      if (mod.types.length > 0) {
        html += `\n<div class="sidebar-section">\n  <h3>Types</h3>`;
        for (const t of mod.types) {
          html += `\n  <a href="#type-${escapeHtml(t.name)}">${escapeHtml(t.name)}</a>`;
        }
        html += `\n</div>`;
      }
      if (mod.traits.length > 0) {
        html += `\n<div class="sidebar-section">\n  <h3>Traits</h3>`;
        for (const tr of mod.traits) {
          html += `\n  <a href="#trait-${escapeHtml(tr.name)}">${escapeHtml(tr.name)}</a>`;
        }
        html += `\n</div>`;
      }
      if (mod.functions.length > 0) {
        html += `\n<div class="sidebar-section">\n  <h3>Functions</h3>`;
        for (const fn of mod.functions) {
          html += `\n  <a href="#fn-${escapeHtml(fn.name)}">${escapeHtml(fn.name)}</a>`;
        }
        html += `\n</div>`;
      }
      if (mod.constants.length > 0) {
        html += `\n<div class="sidebar-section">\n  <h3>Constants</h3>`;
        for (const c of mod.constants) {
          html += `\n  <a href="#const-${escapeHtml(c.name)}">${escapeHtml(c.name)}</a>`;
        }
        html += `\n</div>`;
      }
    }
  }

  html += `\n</nav>`;
  return html;
}

// ── Doc content rendering ────────────────────────────────────────────

function renderDoc(md: MarkdownRenderer, doc: string | undefined): string {
  if (!doc) return "";
  return `<div class="doc-content">${renderMarkdown(md, doc)}</div>`;
}

// ── Deprecated banner rendering ──────────────────────────────────────

function renderDeprecatedBanner(
  md: MarkdownRenderer,
  deprecated: string | undefined
): string {
  if (!deprecated) return "";
  const detail = renderMarkdown(md, deprecated);
  return `<div class="deprecated-banner">⚠️ <strong>Deprecated</strong>${detail ? `: ${detail}` : ""}</div>`;
}

// ── Section rendering (Returns, Errors, Examples) ────────────────────

function renderSections(
  md: MarkdownRenderer,
  item: {
    returns?: string;
    errors?: string;
    examples?: string;
  }
): string {
  let html = "";

  if (item.returns) {
    html += `\n<div class="doc-section"><h5>Returns</h5><div class="doc-section-content">${renderMarkdown(md, item.returns)}</div></div>`;
  }
  if (item.errors) {
    html += `\n<div class="doc-section"><h5>Errors</h5><div class="doc-section-content">${renderMarkdown(md, item.errors)}</div></div>`;
  }
  if (item.examples) {
    html += `\n<div class="doc-section"><h5>Examples</h5><div class="doc-section-content">${renderMarkdown(md, item.examples)}</div></div>`;
  }

  return html;
}

// ── Parameter table rendering ────────────────────────────────────────

function renderParamsTable(
  md: MarkdownRenderer,
  params: DocParam[],
  label: string = "Parameters"
): string {
  if (params.length === 0) return "";

  const hasDoc = params.some((p) => p.doc);
  const docHeader = hasDoc ? "<th>Description</th>" : "";

  let html = `<h4>${escapeHtml(label)}</h4>\n<table class="params-table">\n<thead><tr><th>Name</th><th>Type</th><th>Notes</th>${docHeader}</tr></thead>\n<tbody>`;
  for (const p of params) {
    const notes: string[] = [];
    if (p.isComptime) notes.push("comptime");
    if (p.isImplicit) notes.push("implicit");
    if (p.defaultValue) notes.push(`default: ${escapeHtml(p.defaultValue)}`);
    const docCell = hasDoc
      ? `<td>${p.doc ? renderMarkdown(md, p.doc) : ""}</td>`
      : "";
    html += `\n<tr><td><code>${escapeHtml(p.name)}</code></td><td class="type-col">${escapeHtml(p.type)}</td><td>${notes.join(", ")}</td>${docCell}</tr>`;
  }
  html += `\n</tbody></table>`;
  return html;
}

// ── Fields table rendering ───────────────────────────────────────────

function renderFieldsTable(md: MarkdownRenderer, fields: DocField[]): string {
  if (fields.length === 0) return "";

  let html = `<h4>Fields</h4>\n<table class="fields-table">\n<thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>\n<tbody>`;
  for (const f of fields) {
    const docText = f.doc ? renderMarkdown(md, f.doc) : "";
    html += `\n<tr><td><code>${escapeHtml(f.name)}</code></td><td class="type-col">${escapeHtml(f.type)}</td><td>${docText}</td></tr>`;
  }
  html += `\n</tbody></table>`;
  return html;
}

// ── Variants table rendering ─────────────────────────────────────────

function renderVariantsTable(
  md: MarkdownRenderer,
  variants: DocVariant[]
): string {
  if (variants.length === 0) return "";

  let html = `<h4>Variants</h4>\n<table class="variants-table">\n<thead><tr><th>Variant</th><th>Fields</th><th>Description</th></tr></thead>\n<tbody>`;
  for (const v of variants) {
    const fieldsStr = v.fields
      ? v.fields
          .map((f) => `${escapeHtml(f.name)}: ${escapeHtml(f.type)}`)
          .join(", ")
      : "";
    const docText = v.doc ? renderMarkdown(md, v.doc) : "";
    html += `\n<tr><td><code>${escapeHtml(v.name)}</code></td><td class="type-col">${fieldsStr}</td><td>${docText}</td></tr>`;
  }
  html += `\n</tbody></table>`;
  return html;
}

// ── Associated types rendering ───────────────────────────────────────

function renderAssociatedTypes(
  md: MarkdownRenderer,
  types: DocAssociatedType[] | undefined
): string {
  if (!types || types.length === 0) return "";

  let html = `<h4>Associated Types</h4>\n<table class="fields-table">\n<thead><tr><th>Name</th><th>Constraint</th><th>Description</th></tr></thead>\n<tbody>`;
  for (const t of types) {
    const docText = t.doc ? renderMarkdown(md, t.doc) : "";
    html += `\n<tr><td><code>${escapeHtml(t.name)}</code></td><td class="type-col">${t.constraint ? escapeHtml(t.constraint) : ""}</td><td>${docText}</td></tr>`;
  }
  html += `\n</tbody></table>`;
  return html;
}

// ── Method rendering ─────────────────────────────────────────────────

function renderMethods(
  md: MarkdownRenderer,
  methods: DocFunction[],
  parentName: string
): string {
  if (methods.length === 0) return "";

  let html = `<h4>Methods</h4>`;
  for (const m of methods) {
    html += `\n<div class="method-item" id="method-${escapeHtml(parentName)}-${escapeHtml(m.name)}">
<div class="method-header"><code>${escapeHtml(m.name)}</code> : <code>${escapeHtml(m.signature)}</code></div>
<div class="method-body">`;
    html += renderDeprecatedBanner(md, m.deprecated);
    html += renderDoc(md, m.doc);
    if (m.parameters.length > 0) {
      html += renderParamsTable(md, m.parameters);
    }
    html += `\n<p>Returns: <code>${escapeHtml(m.returnType)}</code></p>`;
    html += renderSections(md, m);
    html += `\n</div></div>`;
  }
  return html;
}

// ── Trait impls rendering ────────────────────────────────────────────

function renderTraitImpls(impls: string[]): string {
  if (impls.length === 0) return "";

  let html = `<h4>Trait Implementations</h4>\n<div class="trait-impl-list">`;
  for (const name of impls) {
    html += `\n<span class="trait-impl-badge">${escapeHtml(name)}</span>`;
  }
  html += `\n</div>`;
  return html;
}

// ── Function rendering ───────────────────────────────────────────────

function renderFunction(md: MarkdownRenderer, fn: DocFunction): string {
  let html = `<div class="item-card${fn.deprecated ? " deprecated" : ""}" id="fn-${escapeHtml(fn.name)}">
<div class="item-header">
  <a class="item-name" href="#fn-${escapeHtml(fn.name)}">${escapeHtml(fn.name)}</a>
  <span class="item-kind">function</span>
</div>
<div class="item-body">
<div class="decl-signature">${escapeHtml(fn.signature)}</div>`;
  html += renderDeprecatedBanner(md, fn.deprecated);
  html += renderDoc(md, fn.doc);

  if (fn.typeParams && fn.typeParams.length > 0) {
    html += renderParamsTable(md, fn.typeParams, "Type Parameters");
  }
  if (fn.parameters.length > 0) {
    html += renderParamsTable(md, fn.parameters);
  }
  if (fn.effects && fn.effects.length > 0) {
    html += renderParamsTable(md, fn.effects, "Effects");
  }

  html += `\n<p>Returns: <code>${escapeHtml(fn.returnType)}</code></p>`;
  html += renderSections(md, fn);
  html += `\n</div></div>`;
  return html;
}

// ── Type rendering ───────────────────────────────────────────────────

function renderType(md: MarkdownRenderer, t: DocType): string {
  let html = `<div class="item-card${t.deprecated ? " deprecated" : ""}" id="type-${escapeHtml(t.name)}">
<div class="item-header">
  <a class="item-name" href="#type-${escapeHtml(t.name)}">${escapeHtml(t.name)}</a>
  <span class="item-kind">${escapeHtml(t.kind)}</span>
</div>
<div class="item-body">
<div class="decl-signature">${escapeHtml(t.signature)}</div>`;
  html += renderDeprecatedBanner(md, t.deprecated);
  html += renderDoc(md, t.doc);

  if (t.typeParams && t.typeParams.length > 0) {
    html += renderParamsTable(md, t.typeParams, "Type Parameters");
  }
  if (t.fields && t.fields.length > 0) {
    html += renderFieldsTable(md, t.fields);
  }
  if (t.variants && t.variants.length > 0) {
    html += renderVariantsTable(md, t.variants);
  }
  html += renderTraitImpls(t.traitImpls);
  html += renderMethods(md, t.methods, t.name);
  if (t.examples) {
    html += `\n<div class="doc-section"><h5>Examples</h5><div class="doc-section-content">${renderMarkdown(md, t.examples)}</div></div>`;
  }

  html += `\n</div></div>`;
  return html;
}

// ── Trait rendering ──────────────────────────────────────────────────

function renderTrait(md: MarkdownRenderer, tr: DocTrait): string {
  let html = `<div class="item-card${tr.deprecated ? " deprecated" : ""}" id="trait-${escapeHtml(tr.name)}">
<div class="item-header">
  <a class="item-name" href="#trait-${escapeHtml(tr.name)}">${escapeHtml(tr.name)}</a>
  <span class="item-kind">trait</span>
</div>
<div class="item-body">
<div class="decl-signature">${escapeHtml(tr.signature)}</div>`;
  html += renderDeprecatedBanner(md, tr.deprecated);
  html += renderDoc(md, tr.doc);

  if (tr.typeParams && tr.typeParams.length > 0) {
    html += renderParamsTable(md, tr.typeParams, "Type Parameters");
  }
  html += renderAssociatedTypes(md, tr.associatedTypes);
  html += renderMethods(md, tr.methods, tr.name);
  if (tr.examples) {
    html += `\n<div class="doc-section"><h5>Examples</h5><div class="doc-section-content">${renderMarkdown(md, tr.examples)}</div></div>`;
  }

  if (tr.implementors.length > 0) {
    html += `\n<h4>Implementors</h4>\n<div class="trait-impl-list">`;
    for (const name of tr.implementors) {
      html += `\n<span class="trait-impl-badge">${escapeHtml(name)}</span>`;
    }
    html += `\n</div>`;
  }

  html += `\n</div></div>`;
  return html;
}

// ── Constant rendering ───────────────────────────────────────────────

function renderConstant(md: MarkdownRenderer, c: DocConstant): string {
  let html = `<div class="item-card${c.deprecated ? " deprecated" : ""}" id="const-${escapeHtml(c.name)}">
<div class="item-header">
  <a class="item-name" href="#const-${escapeHtml(c.name)}">${escapeHtml(c.name)}</a>
  <span class="item-kind">constant</span>
  <span class="item-sig">${escapeHtml(c.type)}</span>
</div>
<div class="item-body">`;
  html += renderDeprecatedBanner(md, c.deprecated);
  html += renderDoc(md, c.doc);
  if (c.value) {
    html += `\n<p>Value: <code>${escapeHtml(c.value)}</code></p>`;
  }
  html += `\n</div></div>`;
  return html;
}

// ── Index page ───────────────────────────────────────────────────────

function renderIndexContent(md: MarkdownRenderer, model: DocModel): string {
  let html = `<h1>${escapeHtml(model.name)} — API Documentation</h1>`;

  if (model.modules.length === 0) {
    html += `<p>No documented modules found.</p>`;
    return html;
  }

  html += `<h2>Modules</h2>\n<div class="module-grid">`;

  for (const mod of model.modules) {
    const desc = mod.doc ? firstSentence(mod.doc) : "No description";
    const stats = [
      mod.functions.length > 0 ? `${mod.functions.length} fn` : "",
      mod.types.length > 0 ? `${mod.types.length} type` : "",
      mod.traits.length > 0 ? `${mod.traits.length} trait` : "",
      mod.constants.length > 0 ? `${mod.constants.length} const` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    html += `\n<div class="module-card">
  <h3><a href="module/${escapeHtml(mod.name)}.html">${escapeHtml(mod.name)}</a></h3>
  <div class="module-desc">${renderMarkdown(md, desc)}</div>
  <div class="module-stats">${stats}</div>
</div>`;
  }

  html += `\n</div>`;
  return html;
}

// ── Module page ──────────────────────────────────────────────────────

function renderModuleContent(md: MarkdownRenderer, mod: DocModule): string {
  let html = `<div class="breadcrumb"><a href="../index.html">Home</a> &rsaquo; ${escapeHtml(mod.name)}</div>`;
  html += `<h1>Module <code>${escapeHtml(mod.name)}</code></h1>`;
  html += `<div class="module-path">${escapeHtml(mod.path)}</div>`;
  html += renderDoc(md, mod.doc);

  // Types section
  if (mod.types.length > 0) {
    html += `<h2>Types</h2>\n<div class="item-list">`;
    for (const t of mod.types) {
      html += renderType(md, t);
    }
    html += `\n</div>`;
  }

  // Traits section
  if (mod.traits.length > 0) {
    html += `<h2>Traits</h2>\n<div class="item-list">`;
    for (const tr of mod.traits) {
      html += renderTrait(md, tr);
    }
    html += `\n</div>`;
  }

  // Functions section
  if (mod.functions.length > 0) {
    html += `<h2>Functions</h2>\n<div class="item-list">`;
    for (const fn of mod.functions) {
      html += renderFunction(md, fn);
    }
    html += `\n</div>`;
  }

  // Constants section
  if (mod.constants.length > 0) {
    html += `<h2>Constants</h2>\n<div class="item-list">`;
    for (const c of mod.constants) {
      html += renderConstant(md, c);
    }
    html += `\n</div>`;
  }

  return html;
}

// ── Main entry point ─────────────────────────────────────────────────

export interface RenderHtmlOptions {
  /** The documentation model to render */
  model: DocModel;
  /** Output directory for the HTML files */
  outputDir: string;
}

/**
 * Render a DocModel to a fully self-contained static HTML site.
 *
 * Generates:
 *   - index.html — Module index with search
 *   - module/<name>.html — Per-module documentation page
 *
 * All CSS and JS are inlined. No external dependencies.
 */
export async function renderDocSite(options: RenderHtmlOptions): Promise<void> {
  const { model, outputDir } = options;
  const md = await getMarkdownRenderer();

  const cssText = generateCSS();
  const jsText = generateSearchJS();
  const searchIdx = buildSearchIndex(model);

  // Ensure output directories exist
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, "module"), { recursive: true });

  // Generate index page
  const indexContent = renderIndexContent(md, model);
  const indexSidebar = renderSidebar(model);
  const indexPage = wrapPage(
    `${model.name} — Documentation`,
    indexContent,
    indexSidebar,
    searchIdx,
    cssText,
    jsText
  );
  fs.writeFileSync(path.join(outputDir, "index.html"), indexPage, "utf-8");

  // Generate module pages
  for (const mod of model.modules) {
    // For module pages, fix relative paths (we're in module/ subdir)
    const modSidebar = renderSidebar(model, mod.name)
      .replace(/href="module\//g, 'href="')
      .replace('href="index.html"', 'href="../index.html"');

    const modContent = renderModuleContent(md, mod);
    const modSearchIdx = searchIdx.map((e) => ({
      ...e,
      href: e.href.startsWith("module/") ? e.href.slice(7) : `../${e.href}`,
    }));

    const modPage = wrapPage(
      `${mod.name} — ${model.name}`,
      modContent,
      modSidebar,
      modSearchIdx,
      cssText,
      jsText
    );
    fs.writeFileSync(
      path.join(outputDir, "module", `${mod.name}.html`),
      modPage,
      "utf-8"
    );
  }
}

// ── Exported helpers for testing ─────────────────────────────────────

export {
  escapeHtml,
  buildSearchIndex,
  firstSentence,
  generateCSS,
  generateSearchJS,
};
