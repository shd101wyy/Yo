# An async state machine cannot carry a fn-typed local across a suspension point

OPEN (2026-09-16). Surfaced by §7 step 2 of
plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md (in-process watch compiles):
`run_build`'s async body read a global `Option(InProcessCompileFn)` (a
fn-typed Option) inside a `cond`, and the self-compile died with:

```
yo-out/x86_64-unknown-linux-gnu/bin/yo.c:3041710: error: use of undeclared
identifier '_file____home_temp_6462266268146841510'
  _file____home_temp_114929069741801847140 = _file____home_temp_6462266268146841510;
```

The temp holds the global's value immediately before a suspension point;
after the split, the continuation references it, but the SM never declared
it — a fn-typed local cannot be emitted as a state-machine field
(`src/codegen/async/`'s captured-variable struct emitter has no fn-type
case; the fn VALUE has no runtime representation, so the field's C type is
unnameable). Hoisting the read into a plain local BEFORE the struct
construction did not help: the local itself is fn-typed and still crosses
the suspension.

## Current shape (works)

The callback lives in a mutable REF-STRUCT slot
(`InProcessCompileSlot`, src/build_runner.yo) and reads go through the
slot object — the SM captures the ref-struct POINTER (a supported capture,
like `await_future_0`), and no fn-typed value crosses a suspension.

## Proper fix

Either (a) the async SM rejects/lowers fn-typed captureds explicitly
(a loud `_fail_subset`-style diagnostic instead of undeclared-identifier
in generated C), or (b) fn-typed values gain a runtime representation for
SM fields (e.g. a thin fn-pointer + capture pair). (a) is the guardrail;
(b) is a feature. Add the reproducer shape to the async test set when
picked up:

```rust
F :: (fn() -> i32);
g : Option(F) = Option(F).None;
main :: (fn(io : Io) -> i32)({
  task := io.async((io : Io) -> i32 ({
    io.await(io.sleep(u64(1), io), io);   // suspension point
    match(g, .Some(f) => f(), .None => 0)
  }), io);
  io.await(task, io);
  0
});
```
