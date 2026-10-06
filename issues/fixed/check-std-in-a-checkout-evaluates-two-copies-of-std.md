# `yo check ./std` in a repository checkout evaluates two copies of std and reports 22 false failures

**Severity:** S3 — a documented gate command gives a wrong verdict. CI is unaffected: it sets `YO_STD`.

**Status: FIXED (2026-10-04).** Found 2026-09-30 while gating `mem/codegen-plan`.

## Symptom

In any checkout of the repository, with the installed release on `PATH`:

```
$ yo --version
yo 0.2.46
$ yo check ./std
...
error[E0612]: Method "_alloc_with_capacity" is already defined for type "HashMap(K : ..., V)" under the same bounds (first definition: std/collections/hash_map.yo:129:1). Duplicate inherent method impls are not allowed ...
error[E0405]: Method "_lookup" of ParsedArgs is private to its declaring module
error: Raw pointer values are not available in safe code: '(buf.ptr)()' has type '?(*(T))'.
check: 154/176 file(s) passed
```

The same seed on the same tree passes when told which std to use:

```
$ yo check ./std --std-path ./std
check: 176/176 file(s) passed
```

Develop `26e71f6c6` gives exactly the same 154/176 with the same error set,
so no branch causes it. The tree's own stage-2 also passes 176/176 without the
flag. Its `std` sits next to the binary's build tree, so resolution happens to
pick `./std`.

## Cause

`resolve_std_path` (`src/module_manager.yo`) tries, in order:
1. `--std-path`;
2. `YO_STD`;
3. a `std/` beside the running executable, walking up;
4. `./std`.

An installed release finds its bundled `~/.local/lib/yo/v<version>/std` at
step 3. `check ./std` then evaluates each ENTRY file from `./std`, while every
`import("std/…")` inside them resolves into the bundle. Every module that is
both checked and imported exists twice, under two paths:
- impls register twice ("already defined");
- privacy checks compare the two declaring modules ("private to its declaring
  module");
- safe-code checks meet the other copy's types.

The contents are identical here. The two paths alone cause the failures.

## Where it bites

`AGENTS.md`'s command list said `yo check ./std`, and so did the gates sections
of plans. An agent running it on a worktree gets 22 failures that look like a
std regression.

## Fix options

1. Documentation only: every place that checks std from a checkout passes
   `--std-path ./std` (done in AGENTS.md alongside this issue).
2. Resolution: when every path handed to `check`/`test`/`compile` lies inside
   a directory that is a std root (it holds `prelude.yo`), and neither
   `--std-path` nor `YO_STD` is set, use that root as std and say so on
   stderr. A std tree is never meant to be checked against a different std.
3. Detection: when an entry file's canonical path is itself a module inside a
   DIFFERENT std root than the resolved one, fail with "checking a std tree
   against the bundled std at <path>; pass --std-path <root>".

Recommended: 2. It removes the trap for every command and every agent, and it
changes nothing when std is chosen explicitly. It needs a CLI golden
(`tests/cli-cases/`) that runs the installed-layout binary on a copied std
tree and expects 176/176.

## Fixed

**2026-10-04, branch `s3/batch-0-fixes`.** Root cause: `resolve_std_path` picked a std by looking only at the flag, the env and the EXECUTABLE's own location — arms 3 and 4 know nothing about the entry paths — so an installed binary (bundled `std/` beside the exe, arm 3) checked a checkout's `./std` entries against the bundle and every module that was both an entry and an import existed twice under two paths. Fix (option 2): `prefer_entry_std_root` (`src/module_manager.yo`) — when EVERY entry path a command was handed lives inside ONE directory that is itself a std root (it holds `prelude.yo`; `_entry_std_root` walks the canonicalized entry's ancestors, the entry itself counting so `check ./std` names the root directly), and std was not chosen explicitly (`--std-path` or non-empty `YO_STD`, both read through the shared `_yo_std_env_value`), it installs that root through `set_std_path_override` in its `_std_canonicalize` spelling — so the resolution route still never leaks into module paths, type keys or mangled C names — and says so on stderr: `yo: every entry lives inside the std tree at <root>; using it as the std root for this run (pass --std-path or set YO_STD to use another)`. Called by the entry-evaluating subcommands before their first `resolve_std_path()`: `check`, `test` (which then forwards the root to every batch-compile child as an explicit `--std-path`, so runner and children cannot disagree), `compile`, `fix`, `verify`, `effects` (`src/main.yo`) and `doc` (`src/doc_command.yo`); `build_runner` is untouched (a build file is never a std module). A no-op when the two roots coincide (a tree-built binary already walks up to the `./std` the entries live in — no note, no behavior change for any gate), when the entries are not all inside one std tree (`check .` over a whole checkout names no single std), or when the entry list is empty; an explicitly chosen std still wins, even when it recreates the trap. Test: `tests/cli-cases/check-std-tree-entries-use-their-own-std` — a fixture std tree checked with `YO_STD` cleared (empty = unset, the installed-release condition; the harness cannot stage a std beside `$YO_SELF_BIN`), pinning the note plus 3/3 passed with the preference and 3/3 with an explicit `--std-path`; red before the fix (`check: 2/3 file(s) passed`, the fixture's `import("std/helper")` resolving into the other tree's missing module), green after. Also verified at the issue's own scale on Windows: the develop binary staged in an installed-release layout (`bin/yo.exe` + a copied `std/` beside it) went from `check ./std` = 165/178, rc=1 to the note + 178/178, rc=0; the same binary from its build location stays at 178/178 with no note; `YO_STD=<bundle>` still deliberately reproduces 165/178; a `yo test` run on `std/collections/hash_map.test.yo` through the staged binary compiled its kept batch C with zero references to the bundled std (the forwarded root reached the child); `doc`/`fix`/`effects`/`compile` on a std module each print the note and succeed. AGENTS.md's `yo check ./std` line now marks the flag optional; `.github/instructions/testing.instructions.md` notes the entry-side rule (files under `./tests/**` are still outside any std tree, so its explicit-`YO_STD` advice stands).
