# `yo check ./std` in a repository checkout evaluates two copies of std and reports 22 false failures

**Severity:** S3 — a documented gate command gives a wrong verdict. CI is unaffected: it sets `YO_STD`.

**Status: OPEN.** Found 2026-09-30 while gating `mem/codegen-plan`.

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
