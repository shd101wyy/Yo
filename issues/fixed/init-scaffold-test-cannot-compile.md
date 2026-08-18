# `yo init` scaffolds a project whose tests cannot compile

**Status: FIXED** (found and fixed 2026-08-19, both compilers).

## Symptom

Every project created by `yo init` fails on its very first `yo build test`:

```
$ yo init ./proj --name proj
$ cd proj && yo build test
tests/.yo_selftest_batch_1_0.yo:7:41:
      (__yo_test_idx == `0`) => { begin(assert((1 + 1) == 2, "math is broken"), ()); },
                                           ^
yo: error: compile: failed to evaluate module "tests/.yo_selftest_batch_1_0.yo"
yo: error: test: batch compile failed (exit 1) for tests/.yo_selftest_batch_1_0.yo
```

`yo build run` works, so the failure only appears when a new user runs the
tests the scaffold shipped them.

## Root cause

The scaffolded `tests/main.test.yo` called `assert` without importing it:

```rust
test("it works", {
  assert(((1 + 1) == 2), "math is broken");
});
```

`assert` lives in `std/assert` and **the prelude deliberately does not import
it** — that was the point of moving `assert`/`panic` out of the prelude. Every
real test file in this repo imports it explicitly, e.g.
`tests/algebraic_effects.test.yo:2`:

```rust
{ assert } :: import("std/assert");
```

The scaffold never did. Adding that one line makes the scaffolded project pass
(`1 passed, 1 total`).

Both compilers carried it — `src/init.ts` `generateTestFile()` and
`yo-self/init.yo` `generate_test_file()`. The self-hosted version is a faithful
port, so it inherited the bug rather than introducing it.

## Why no test caught it

The gap is specific and worth stating, because the corpus _looks_ like it
covers `init` thoroughly:

- `tests/cli-cases/{init,init-cwd,init-existing}` assert the scaffold's TREE —
  every file path plus a sha256 of its content. They pin exactly the broken
  bytes, and pass, because the bytes were what they were recorded from.
- `scripts/bootstrap/gates_fast.sh` GATE 5 runs `init` and asserts its
  artifacts. Same shape: existence, not execution.
- `tests/cli-cases/build-run` runs `build run`, which compiles `src/main.yo`.
  It never touches `tests/`.
- `tests/cli-cases/build-test-exclude` does run `build test`, but against its
  own hand-written fixture, not against a scaffold.

So the scaffold was pinned byte-for-byte and never once executed. A golden that
records whatever the tool emits cannot notice that what it emits is broken —
it only notices _change_.

## The fix

One line added to the template in both compilers, and a new case that runs the
scaffold instead of only describing it:

`tests/cli-cases/init-build-test` — `init .` followed by `build test`, so the
scaffolded project must actually compile and pass. `cmd` supports one argv per
line run in order (`tests/cli-cases/README.md:21`), which is what makes a
two-step case possible.

Re-recorded goldens: `init`, `init-cwd`, `init-existing` — the three whose tree
manifests actually contain the changed file. `build-run`, `build-list-steps`
and `fetch-no-deps` were re-recorded too but came back byte-identical, so they
are not in the diff.

## Lesson

A content-hash golden proves _stability_, not _correctness_. For anything the
tool GENERATES for a user to run, the regression test has to run it — otherwise
the golden faithfully preserves the bug.
