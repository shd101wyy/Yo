# `yo test --std-path <dir>` is silently ignored — the batch compile is a CHILD process that never receives the flag

> **RETIRED 2026-08-26 — this is a DUPLICATE of an already-fixed issue, and its
> "Fix sketch (not applied)" is wrong.**
>
> The forwarding fix landed in **#286** and is in the tree today:
> `src/main.yo`'s per-batch child-compile block forwards
> `get_std_path_override()` as `--std-path` right after `--c-compiler` /
> `--target`, and `tests/cli-cases/test-std-path-forwarded` is its regression
> gate. The write-up is `issues/fixed/yo-test-does-not-forward-std-path-to-batch-compile.md`.
> **This file was created afterwards, in #287, by someone who hit the symptom
> and did not find the fixed issue.**
>
> **What is actually true, and why the symptom is still real:** the `yo` on
> `PATH` is a released SEED (v0.2.17) built before #286, so it still drops the
> flag. Every measurement made with the seed must therefore use
> `YO_STD=$PWD/std`, exactly as the sections below say — but the compiler this
> tree BUILDS honours `--std-path`, and nothing needs implementing.
> Re-measured 2026-08-26 during the D4 PR-3 review: with the seed,
> `yo test ./tests/string/string_byte_index.test.yo --std-path $PWD/std`
> fails in the CHILD compile (`char_len` is absent from the installed std)
> while `YO_STD=$PWD/std yo test …` scores 19/19.
>
> The historical report follows unchanged.

**Status: OPEN.** Found 2026-08-26 while reviewing the STD_API_AUDIT §D7
`RwLock`/`OnceCell` change, where it caused a whole test run to score the
INSTALLED std instead of the working tree's.

**Hit again, in its DANGEROUS form, during D4 PR 3 (2026-08-26.)** With
`String`'s index basis flipped in the working tree,
`yo test ./tests/string/string.test.yo --std-path ./std` reported a clean
**253 passed / 253 total**. The same command with `YO_STD=$PWD/std` reported
**36 failures**. Nothing in the first run's output hints that the flag was
dropped — there is no "using std from ..." line and no warning. That is the
silent case this issue warns about, and it cost a full re-run to notice.
**Until this is fixed, use `YO_STD=$PWD/std yo test ...` for anything that
depends on the working tree's `std`, never `--std-path`.**

## Symptom

From a worktree whose `std/` differs from the installed bundle's:

```
$ yo check tests/sync/rwlock.test.yo --std-path $PWD/std          # rc 0
$ yo compile /tmp/probe.yo --std-path $PWD/std --release -o /tmp/p # rc 0
$ yo test  tests/sync/rwlock.test.yo --std-path $PWD/std --parallel 1
check: error in: Error: Label "sleep_blocking" being destructured not found.
yo: error: compile: failed to evaluate module "tests/sync/.yo_selftest_batch_1_0.yo"
yo: error: test: batch compile failed (exit 1) for tests/sync/.yo_selftest_batch_1_0.yo
```

`sleep_blocking` exists in the worktree's `std/time/sleep.yo` and not in the
installed `~/.local/lib/yo/v0.2.17/std`, so the diagnostic proves the batch was
compiled against the INSTALLED std even though `--std-path` named another one.

`YO_STD=$PWD/std yo test ...` works, because the child process inherits the
environment.

The dangerous case is not this loud one. When the two `std/` trees differ only
in BEHAVIOUR, `yo test --std-path ./std` reports a green run for a std that was
never tested.

## Root cause

`src/main.yo`, the per-batch child-compile construction (~line 2538):

```rust
self_exe := argv(usize(0));
ccmd := Command.new(self_exe.clone());
ccmd.arg(String.from("compile"));
ccmd.arg(tmp_yo.clone());
ccmd.arg(String.from("-o"));
ccmd.arg(tmp_bin.clone());
// forwarded: --c-compiler, --target, --compile-timeout-ms, --cflags (WASI)
```

Each batch is compiled by a fresh `yo compile` PROCESS (deliberate — see
`issues/fixed/yo-self-second-batch-in-process-ftt.md`). The runner forwards the
flags it knows about; `--std-path` is not among them. It is stripped from argv
by the global pre-parse at `src/main.yo:3908` into `set_std_path_override`,
which is PROCESS-LOCAL state, so it never reaches the child.

This is the same class as the already-fixed P2.5 step-5 bug in the same block
("`yo test --cc gcc` silently compiled with clang"), and the comment there
records that exact lesson.

## Fix sketch (not applied — a `src/` change needs a self-compile to validate)

Forward the resolved path, next to the existing `--c-compiler` / `--target`
arguments:

```rust
ccmd.arg(String.from("--std-path"));
ccmd.arg(resolve_std_path());
```

`resolve_std_path()` is already imported by `main.yo` and is what the parent
used, so forwarding it unconditionally also removes the child's dependence on
its own exe-walk-up — which is the other half of the surprise here (a batch run
from a repo checkout resolves std relative to the BINARY, not the tree). If a
narrower change is wanted, forward only when the override was explicitly set.

Either variant needs the fixpoint battery, since it changes what std every CI
`yo test` leg compiles against.

## Verification when the fix lands

1. From a worktree whose std has a symbol the installed bundle lacks,
   `yo test <file> --std-path $PWD/std --parallel 1` must pass with `YO_STD`
   UNSET.
2. `yo test <file> --std-path /nonexistent` must FAIL loudly rather than
   silently falling back.
