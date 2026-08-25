# `yo test --std-path <dir>` silently tests the INSTALLED std, not `<dir>`

**Status:** OPEN — found 2026-08-25 while doing STD_API_AUDIT D7 (atomics).
**Severity:** silent-wrong-result. The flag is accepted, changes nothing, and
the run reports PASS against a library the caller never asked for.

## Symptom

Working in a repo checkout with an installed `yo` on `PATH`:

```console
$ yo --std-path ./std test tests/sync/atomic.test.yo --parallel 1
check: error in: Error: Too many fields in destructuring pattern. Expected at most 12, got 13

tests/sync/.yo_selftest_batch_1_0.yo:2:1:
_(AtomicBool : AtomicBool, …, fence : fence) :: import("std/sync/atomic");
yo: error: test: batch compile failed (exit 1) for tests/sync/.yo_selftest_batch_1_0.yo
```

`./std/sync/atomic.yo` exports 13 names. The installed
`~/.local/lib/yo/<version>/std/sync/atomic.yo` exports 12. The batch child
resolved the INSTALLED one.

Substituting the environment variable works:

```console
$ YO_STD="$PWD/std" yo test tests/sync/atomic.test.yo --parallel 1
66 passed
```

## Root cause

`yo test` compiles the generated batch by **spawning a child process**
(`src/main.yo`, the `ccmd := Command.new(self_exe)` block that ends in
`test: batch compile failed`). It forwards `--c-compiler`, `--target`,
`--compile-timeout-ms`, `--cflags`, `--optimize` and `--sanitize` — but not
`--std-path`.

The parent's override lives in a process-global set by
`set_std_path_override` (`src/module_manager.yo`), so it does not survive the
`exec`. The child then falls through the normal lookup order —
`--std-path` > `YO_STD` > **a `std` next to the executable** > `./std`
(`resolve_std_path`) — and an installed release bundle is `<prefix>/bin/yo`
with `<prefix>/std` beside it, so step 3 always wins over the repo's `./std`.

`YO_STD` works only because it is an environment variable and the spawn passes
`environ` through.

`yo build` already gets this right: `src/build_runner.yo` (two sites) forwards
`get_std_path_override()` to every child compile, with a comment explaining
that the TS build runner needed no equivalent because it compiled in-process.
`yo test`'s batch compile is the same situation and was missed.

## Why it is worse than a plain "flag ignored"

The failure above is loud only because the API changed shape. When the repo's
std and the installed std are merely *behaviourally* different — a bug fix, a
changed default, a new edge case — the batch compiles clean against the
installed library and the suite reports green for code that was never
compiled. Every `yo test` invocation that reaches for `--std-path` to validate
a std change is exposed to this.

## Fix

Forward the override in `src/main.yo` exactly as `build_runner.yo` does:

```rust
match(
  get_std_path_override(),
  .Some(sp) => {
    ccmd.arg(String.from("--std-path"));
    ccmd.arg(sp);
  },
  .None => {}
);
```

Not done on the D7 branch: that branch is std-only, and a `src/main.yo` edit
cannot be exercised by the installed seed that runs the tests there — it only
takes effect in a compiler built from the tree. It wants its own change with a
`tests/cli-cases` case that points `--std-path` at a fixture std and asserts
the fixture was used.

## Workaround until then

Use `YO_STD` (not `--std-path`) whenever running `yo test` against a std you
are editing:

```console
YO_STD="$PWD/std" yo test tests/sync/atomic.test.yo --parallel 1
```
