# `yo doc` infers the project name from `package.json`, not `yo.toml`

**Status:** OPEN
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

## Scheduling

Not part of B13 (which is confined to write-only state). Take it with the next
slice that touches the manifest — §4.9 or §4.6 in
`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`.
