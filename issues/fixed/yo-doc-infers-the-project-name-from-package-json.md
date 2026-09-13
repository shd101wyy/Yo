# `yo doc` infers the project name from `package.json`, not `yo.toml`

**Status:** FIXED 2026-09-13 — `_infer_project_name` reads `[package] name` first.
**Area:** `src/doc_command.yo` — `_infer_project_name`
**Found:** 2026-09-12, while building the `doc-logo-favicon` cli-case for B13.

## Symptom

The generated site's title — the `<h2>` in the sidebar and the `<title>` of every
page — comes from `_infer_project_name`, which consults, in order:

1. `package.json`'s `"name"`,
2. `build.yo`'s `.name`,
3. the directory name.

`yo.toml` is not consulted at all. Since P1.3 (`yo.toml` is the package
manifest) `[package] name` is *the* project name, read without the evaluator,
and every other command uses it. `package.json` is a Node artifact in a
repository that has no Node toolchain at the root (`AGENTS.md`), and the
`build.yo` scan is a regex over source text that the P1.4c work replaced with
`build.manifest.<field>` reading the manifest.

So a project whose name lives only in `yo.toml` — which is every project
created by `yo init` today — gets its documentation titled after its
*directory*.

## Reproducer

```bash
mkdir /tmp/docname && cd /tmp/docname
printf '[package]\nname = "acme"\nversion = "0.1.0"\n' > yo.toml
printf '/// A thing.\nThing :: struct(x : i32);\nexport(Thing);\n' > lib.yo
yo doc . -o out
grep -o '<h2>[^<]*</h2>' out/index.html   # → <h2>docname</h2>, want <h2>acme</h2>
```

## Fix

Read `yo.toml`'s `[package] name` first, via `manifest.load_manifest`, and keep
the existing chain as the fallback for a directory that has no manifest. Look in
`base_path` only — do NOT walk upward: `yo doc ./std` inside this repository
must stay "std" rather than becoming "yo", and a sandboxed cli-case must not
find a manifest belonging to some ancestor directory.

## Fix, as landed

`_infer_project_name` (`src/doc_command.yo`) now checks `<base_path>/yo.toml`
before anything else: `file_exists_sync` then `load_manifest`, returning
`[package] name`. The parser already guarantees that name is present and
non-empty and contains no path separator, so a manifest that parses always
yields a usable title. The package.json → build.yo → directory chain stays,
unchanged, as the fallback for a directory with no manifest.

`base_path` only, no upward walk — as specified above. `yo doc ./std` inside
this repository stays "std", and a sandboxed cli-case cannot reach a manifest
belonging to an ancestor of its temporary directory.

A manifest that exists and does NOT parse is an error rather than a
fall-through. That was already true of the run as a whole (the module loader
registers import roots per file and reports it there); what changed is where it
surfaces — name inference runs first, so nothing is rendered from a manifest the
toolchain could not read.

## Verification

Two cli-cases, both recorded against the fixed binary:

- `tests/cli-cases/doc-name-from-manifest` — a fixture whose name lives only in
  `yo.toml`. **Verified RED first**: with the pre-fix binary the generated
  `README.md` opened `# proj — API Documentation`, the sandbox's directory name.
  With the fix: `# acme — API Documentation`.
- `tests/cli-cases/doc-name-manifest-malformed` — `[package]` without a `name`.
  The run fails before "Generating documentation...", which is the observable
  difference from the pre-fix ordering.

The existing `doc-html` / `doc-markdown` / `doc-json` / `doc-logo-favicon`
fixtures carry no `yo.toml`, so their goldens are untouched — `doc-html`'s title
still comes from its `package.json`, which is exactly the fallback path.
