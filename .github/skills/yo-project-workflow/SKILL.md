---
name: yo-project-workflow
description: Build, test, scaffold, format, and manage Yo projects. Use this when working with yo init, build.yo, yo build, yo compile, yo test, yo fmt, yo add, yo install, yo version, or cross-platform Yo project setup.
argument-hint: "[project task or command]"
---

# Yo Project Workflow

Use this skill for repository setup, build and test execution, and authoring `build.yo` in normal Yo projects.

If a repository wraps the Yo CLI in scripts, verify the wrapper first but keep the underlying `yo` workflow in mind.

## When to use this skill

Use this skill when you need to:

- scaffold a new Yo project
- understand or edit `build.yo`
- choose between `yo build`, `yo compile`, and `yo test`
- format source with `yo fmt`
- manage dependencies with `yo add`, `yo remove`, `yo install`, `yo update` (declared in `yo.toml`)
- pin or manage Yo versions with `yo version`
- generate API documentation with `yo doc` or `build.doc()`
- reason about targets, compilers, or cross-platform setup

## Workflow

1. If the repository has `build.yo`, prefer `yo build` and named steps for whole-project work.
2. For single-file experiments or reproductions, use `yo compile`.
3. For tests, use `yo test [path]` and narrow to a file or pattern before broad runs.
4. For source formatting, use `yo fmt`; use `yo fmt --check` in CI-style verification.
5. To pin the project to a specific Yo version, use `yo version pin`.
6. Consult the [workflow cheatsheet](./workflow-cheatsheet.md) for command shapes, project layout, and a minimal `build.yo`.

## High-signal rules

- `yo init` scaffolds `yo.toml` (the package manifest), `build.yo`, `src/`, and `tests/`.
- `build.yo` is Yo code that imports `std/build`; build functions register compile-time steps.
- `yo build run` and `yo build test` are the standard project entry points.
- `yo test ./tests/some.test.yo --parallel 1` is the focused single-file test pattern.
- `yo fmt` applies the fixed Yo style with 2-space indentation; there are no formatter options.
- Dependencies are declared in `yo.toml` `[dependencies]` — `yo add user/repo[@range]` / `yo add ./path` writes the entry and fetches; `yo install` resolves the whole graph — each dependency's own `yo.toml` too, ONE version per name across every requirer, conflicts are errors naming both — fetches it and writes `yo.lock` v2 (`--locked`/`--offline`/`--frozen` for CI); `import("name")` then works in every command.
- Use `yo version pin` to create a `.yo-version` file for reproducible builds.
- Prefer symbolic build APIs and target constants in `build.yo` instead of ad-hoc shell logic.

## Resource

- [Yo project workflow cheatsheet](./workflow-cheatsheet.md)
