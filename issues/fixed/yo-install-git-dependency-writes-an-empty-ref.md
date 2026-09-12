# `yo install user/repo[@tag]` writes `ref: ""` to `deps.yo`, skips the fetch, and exits 0

**Status:** FIXED 2026-09-12. The lowering bugs behind the empty ref and the skipped fetch were fixed in #592 (`issues/fixed/nested-value-match-with-await-drops-the-enclosing-match-arm.md`, `issues/fixed/async-chained-sibling-arm-second-await-binding-never-assigned.md`); the data-path hardening this stayed open for is moot on `p1/yo-toml-manifest`: `deps.yo` and `yo install <spec>` are gone, `yo add user/repo@v0.0.6` writes `{ git = "…", tag = "v0.0.6" }` into `yo.toml` through `toml_edit.yo` (the entry is data, re-parsed after the edit), and a git dependency's ref is decided by `install_command.yo`'s resolver from the manifest — there is no string-built `ref:` any more. The reproducer below is the PRE-manifest CLI and is kept as the record.
**Found:** 2026-09-11, auditing the dependency subsystem
(`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`). Reproduced with the released
`yo 0.2.30` on macOS and with a compiler built from `develop` (`94fae98f8`)
by the 0.2.30 seed (so the lowering is the seed's — a gen-2 check is still owed).
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

## Root cause (found 2026-09-11 by body substitution)

`issues/fixed/nested-value-match-with-await-drops-the-enclosing-match-arm.md`: in an
`io.async` body, a match arm that contains a value-producing INNER match with
an awaiting arm is emitted as nothing. `run_install`'s `.Git(…)` arm is that
shape (`ref_str := match(g_pinned_ref, .Some(r) => r, .None => { await
resolve_latest_ref })`), so its progress lines, the fetch and the lock write
vanish and `ref_str` is empty. A standalone reproducer of the shape shows the
same silent drop; a variant with the sibling `.Path` arm's `added :=` await
fails at the C compiler with a mis-typed state-machine slot instead.

## Fix direction

1. ~~Fix the lowering bug in `src/codegen/async/`~~ — DONE 2026-09-11 (the
   nested-match issue above owns the reproducer and gate); `run_install` is
   unchanged and emits correctly under a fixed compiler.
2. Independently harden the data path: `resolve_git_ref` must fail loudly on
   an empty ref or a non-zero `git ls-remote`, and `run_install` must refuse to
   write a declaration with an empty ref. Gate: an offline cli-case that
   installs from a local `file://` bare repository with a semver tag and
   asserts the written `ref`, the created `yo.lock`, and rc.
