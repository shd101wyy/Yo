# `main`'s return value is discarded — a `main`-computed exit code is always 0

**Status:** OPEN. **Class**: documented capability that silently does nothing,
and — because 12 reproducers in this repo signal pass/fail through it — a
**hollow gate**. **Found:** 2026-09-14, when a reproducer that computed a
failing status reported `rc=0`.

## Symptom

```rust
main :: (fn() -> i32)({
  println(`returning 3`);
  i32(3)
});
export(main);
```

```
$ yo compile /tmp/rc.yo --std-path ./std --optimize 2 -o /tmp/rc.out && /tmp/rc.out; echo "rc=$?"
returning 3
rc=0
```

`return(i32(3))` behaves the same. The value is computed and dropped.

## Root cause

`src/codegen/functions/generation.yo`, the `main()` wrapper. `__yo_user_main`
is called as a STATEMENT and the wrapper returns a literal zero:

```c
static void* __yo_main_thread_entry(void* __yo_unused_arg) {
  __yo_user_main();            // <- result discarded
  return NULL;
}
int main(int argc, char** argv) {
  ...
  pthread_join(__yo_main_tid, NULL);
  return 0;                    // <- always 0
}
```

The program body runs on a worker thread (for the 1 GiB stack,
`issues/fixed/windows-no-main-worker-stack-rc139.md`), so propagating the value
means carrying it off that thread — through the `void*` return of
`__yo_main_thread_entry`, or a static — and then returning it from `main`. The
Windows arm has the same shape and the same `return 0`.

## Why it matters more than it looks

**The language documents this exact form.** `docs/en-US/DESIGN.md:2540`:

```rust
main :: (fn() -> i32)({
  dog := Dog();
  result := act(dyn(dog));
  return(result);
});
```

A reader follows that, ships a CLI that reports failure through its exit
status, and the program always succeeds.

**It makes reproducers hollow.** Twelve files under `issues/repros/` are
written as `fn() -> i32` returning `0` on success and `1` on failure — which is
the natural way to make a reproducer self-checking. Every one of them exits 0
whatever it observes. This is the same class as
`issues/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`
and the hollow-batch problem: a gate that cannot fail. Anything scoring those
repros by exit code — including a bulk sweep over the corpus — silently reads
them all as passing.

The working alternative is `assert` from `std/assert`, which aborts (rc=134);
that is what the reproducer filed alongside this now uses.

## Two defensible fixes, and one that is not

1. **Propagate the value** — make the worker thread carry the `i32` out and
   `main` return it. Matches the documented example and C/Rust expectations.
2. **Reject `main` with a non-`unit` return type** at check time. Also honest,
   and cheap, but it breaks the documented example and the 12 reproducers, so
   it needs the doc fixed in the same change.

What is NOT defensible is the current state: accepting the signature, computing
the value, and discarding it silently. Whichever is chosen, `docs/en-US` and
`docs/zh-CN` must agree with it.

Note the interaction with effects: `__yo_main_module_init()` already has an
`if (__yo_effect_escaped) return 0;` early exit, so an unwound main is a third
case that needs a defined status — plausibly non-zero, which today it is not
(`issues/unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md`
is the same complaint from the effects side and should be fixed with this).

## Regression test

A `tests/cli-cases/` case is the right shape, since the assertion is on the
process exit status rather than on anything observable in-language: compile a
program whose `main` returns a non-zero `i32` and record the rc. A `.test.yo`
cannot express it — the test runner inlines bodies into one batch
`__yo_user_main`, so per-test exit codes do not exist there.
