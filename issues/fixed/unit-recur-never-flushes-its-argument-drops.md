# A unit-returning `recur(...)` never flushes its argument drops — one leaked interior reference per composite argument

**Status: FIXED** (2026-09-27). This is the root cause of develop's red
"Formal verification (pinned Z3)" job (red since the 2026-09-26 16:52 battery),
previously tracked as `issues/fixed/verifier-z3-harness-self-test-leaks-40-bytes.md`
and `issues/fixed/fv-z3-self-test-leaks-one-interior-ref-per-composite-argument.md`.
Both of those docs carry mechanisms that turned out to be wrong: a seed-emit interaction,
and "by-value composite params are never dropped". Every step below was **measured**.

## Symptom

```
  ✗ real z3: harness self-test proves 1+1==2 and refutes 1+1==3 (YO_TEST_Z3=1)
    Memory leak detected:
    ==3421==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 40 byte(s) in 1 object(s) allocated from:
        #1 __yo_rc_alloc
        #2 __yo_new___yo_t_16987456896208270856
        #3 __yo_fs_13613462911825284746
    SUMMARY: AddressSanitizer: 619 byte(s) leaked in 22 allocation(s).
```

## Narrowing (macOS, `leaks --atExit`, v0.2.44 seed)

1. The self-test extracted into a standalone program leaks 16 objects (656 B) on a
   **cold** verify cache and 0 on a warm one. The leaking work is on the miss path:
   solve, then `_cache_store`.
2. The leaked objects are the `q.name` clone in `JsonValue.Str(...)` and the inner
   verdict object's `keys` list. Both are payload pieces that `_cache_store` hands to
   `json.stringify`.
3. Building the same nested `JsonValue` and dropping it leaks nothing. Adding
   `stringify(p)` leaks 4 objects (flat) or 14 (nested).
4. `stringify`'s worker `_stringify_into` walks containers with
   `recur(values(i), out)`. A copy of the walker that differs only in the recursive
   call gives:

   | loop body | leaks |
   | --- | --- |
   | `recur(values(i), out);` | **2** (one String per call) |
   | `walk(values(i), out);` (the same function, called by name) | 0 |
   | `wr(keys(i), out);` | 0 |

## Root cause

The indexed read `values(i)` of a value enum that carries RC fields is a borrowed
copy. As a by-value argument it gets a deferred dup (`temp_dup_enum_0` plus the
per-variant `__yo_incr_rc`s), and the evaluator attaches the balancing drop to the
**call node's** deferred-drop list. The ordinary call emitter flushes that list
right after the call. For a unit call it emits `f(args);` as a statement and then
the drop (`other_fn_call.yo`, the `ou_result_is_void` exit).

`generate_recur` (`src/codegen/exprs/recur.yo`) flushed the recur node's deferred
drops only on its **result-temp** path, i.e. a non-unit recur with a variable name.
A unit recur fell through to `return call_code`, so the dup ran and the drop was
never emitted. The emitted C, recur versus by-name call:

```c
// recur(values(i), out)            // walk(values(i), out)
ID(T, out);                         ID(T, (TY*)(out));
                                    switch ((T).tag) { ... __yo_decr_rc(...) ... }
```

## Fix

`generate_recur` handles the unit case the way the direct-call unit exit does:
emit `<fn>(<args>);` as a statement, flush `generate_deferred_drop_expressions`,
and return `""`.

**Seed lag:** the FV job compiles `tests/internal/verifier.test.yo` with the
**seed** (v0.2.44 has the bug), and the job's `YO_STD` is the checkout's `std/`.
So `_stringify_into` and `_stringify_pretty_into` now call themselves by name
instead of through `recur`. That spelling is equivalent and compiles leak-free
under every compiler, and it takes the CI red off the seed's codegen. The compiler
fix itself is gated by `tests/recur_inline_arg.test.yo`'s
"unit recur releases the dup of a composite argument" (an `rc()` check, so it runs
without LSan). That test fails under the v0.2.44 seed and passes with the fix.

## Not the mechanism (for the record)

- **"Only under the v0.2.44 seed"**: no. Any compiler with the recur emitter leaks.
  The z3 4.16 vs 5.1.0 difference was a warm versus cold verify cache.
- **"By-value composite params never get a scope-end drop"** (branch `fv-leak-fix`):
  no. By-value `JsonValue` params passed by name, as constructions and as
  indexed-read locals are all leak-free under the seed. That branch's
  calling-convention change is not needed for this red.
- **"`vi := list(i); consume(vi);` leaks"**: that repro named its function `consume`,
  which is a builtin. The call is hijacked, never runs, and marks `vi` consumed.
  PR #958 makes that name a binding error.
