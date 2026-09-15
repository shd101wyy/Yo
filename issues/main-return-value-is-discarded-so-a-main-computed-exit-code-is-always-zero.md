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

**It makes reproducers hollow.** **Eight** files under `issues/repros/` have a
`main` returning `i32` — `0` on success, `1` on failure, which is the natural
way to make a reproducer self-checking. Every one exits 0 whatever it observes:

- `async-match-arm-labeled-destructure-binds-nothing.yo`
- `hashmap-hashset-error-enums-collide.yo`
- `pr661-string-literal-payload-binds-instead-of-comparing.yo`
- `stddoc-coll-float-modulo-emits-invalid-c.yo`
- `stddoc-coll-imm-vec-dedup-leaks-rc-elements.yo`
- `stddoc-io-is-valid-entity-code-accepts-negative-code-points.yo`
- `stddoc-io-json-parse-string-accepts-raw-control-bytes.yo`
- `stddoc-io-url-empty-host-collapses-to-none.yo`

(The count was first written here as twelve, from a grep for files CONTAINING
`fn() -> i32` rather than for files whose MAIN returns it — that over-counted
by four. Anchoring on `^main :: \(fn\([^)]*\) -> i32\)` gives the list above.
A census of the whole directory: 87 `fn() -> unit`, 67 `fn(io : Io) -> unit`,
20 `fn(io, exn) -> unit`, these 8, and 3 odd forms — so the affected set is
small, but it is concentrated in the RECENT std-audit reproducers.)

Each of those needs a real oracle — a print plus a grep, or an `assert` that
aborts — not just a corrected exit code.

A signal-based exit code is unaffected: an rc=139 SIGSEGV or an rc=134 abort is
set by the kernel, not by `main`'s return, so verdicts that rest on a crash
still hold. This is the same class as
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
