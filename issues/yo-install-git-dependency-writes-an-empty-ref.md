# `yo install user/repo[@tag]` writes `ref: ""` to `deps.yo`, skips the fetch, and exits 0

**Status:** OPEN
**Found:** 2026-09-11, auditing the dependency subsystem
(`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`). Reproduced with the released
`yo 0.2.30` on macOS; `src/install_command.yo` is byte-identical on `develop`.
**Severity:** high — every git dependency added through the CLI is broken on
the very next `yo fetch`, so the CLI install flow is unusable.

## Reproducer (network: one `git ls-remote`)

```bash
yo init app --name app --no-skills && cd app
GIT_TERMINAL_PROMPT=0 yo install shd101wyy/raylib_yo@v0.0.6; echo "rc=$?"
grep build.dependency deps.yo
ls yo.lock
yo fetch -v
```

Observed:

```
If you haven't already, add the following to your build.yo:
  { imports } :: import("./deps.yo");
  exe.add_import_list(imports);
rc=0
raylib_yo :: build.dependency({ name: "raylib_yo", url: "https://github.com/shd101wyy/raylib_yo.git", ref: "" });
ls: yo.lock: No such file or directory
Evaluating ./build.yo...
Found 1 dependency(ies) in ./build.yo:
  - raylib_yo (https://github.com/shd101wyy/raylib_yo.git @ )
Cloning into '.../.cache/yo/deps/_tmp_raylib_yo'...
fatal: empty string is not a valid pathspec. please use . instead if you meant to match all paths
yo: error: git checkout failed for commit
```

Three things are wrong at once:

1. The pinned `@v0.0.6` (and, without a pin, the resolved latest tag `v0.0.6`
   — `git ls-remote --tags` lists it) is lost: `ref: ""` is written.
2. None of the `.Git` arm's progress lines print (`Installing <name> @ <ref>
   ...`, `Fetching dependency...`, `Done. Lock file updated: yo.lock`), no
   `yo.lock` is created, yet `deps.yo` **is** rewritten and the command exits 0.
3. The follow-up `yo fetch` then fails on the empty ref, because
   `resolve_git_ref` treats an empty `git ls-remote` result as "already a
   commit SHA" (`src/fetch.yo:456-459`) and never checks the command's exit
   status.

## What is known about the cause

`run_install` (`src/install_command.yo:594-720`) reads correctly on paper:
`ref_str := match(g_pinned_ref, .Some(r) => { println(...); r }, .None => {
... await resolve_latest_ref ... })`, then builds `dep_line` from `ref_str`,
then `if(added, { println("Fetching..."); ... await fetch_all_deps ... })`.
The observed output is consistent with the whole `.Git(...)` arm's statements
after the destructuring running with `g_pinned_ref`/`ref_str` empty and the
`if(added, ...)` body skipped — i.e. an `io.async` body lowering bug, not a
logic bug. A **minimal** reproduction of that shape (value-producing `match`
on an `Option(String)` with an awaiting `.None` arm, followed by an `if` whose
body awaits, inside `io.async`) compiles and runs correctly on 0.2.30, so the
trigger is something more specific to `run_install`: candidates are the outer
`match(parsed, .Path(..) => ..., .Git(g_name, g_url, g_pinned_ref) => ...)`
whose payload is itself an `Option`, the `unsafe(exit(...))`-then-placeholder
arms (`:606-609`, `:683-686`), or the `_print_add_import_guidance` call after
the awaits. Bisect by body substitution (the cheapest tool for this class —
see the memory note on bisecting std-triggered bugs) before touching codegen.

## Fix direction

1. Find the lowering bug via body substitution on `run_install` and fix it in
   `src/codegen/async/`; add the failing shape to
   `tests/async_await.test.yo`.
2. Independently harden the data path: `resolve_git_ref` must fail loudly on
   an empty ref or a non-zero `git ls-remote`, and `run_install` must refuse to
   write a declaration with an empty ref. Gate: an offline cli-case that
   installs from a local `file://` bare repository with a semver tag and
   asserts the written `ref`, the created `yo.lock`, and rc.
