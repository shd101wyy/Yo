# A short-circuit RHS temp inside a bare arm / fn / loop body is dropped after its C block closed

**Status: FIXED 2026-09-12** (`src/codegen/exprs/match.yo`, `src/codegen/exprs/cond.yo`,
`src/codegen/exprs/while_loop.yo`, `src/codegen/functions/generation.yo`). Found while
writing `tests/internal/resolver.test.yo` — its whole batch failed to compile. This is
the minimization of `issues/fixed/ts-codegen-undeclared-temp-in-short-circuit-option-drop.md`
(OPEN since 2026-08-13, "minimization pending"): the same drop landing outside its scope.

## Symptom

```
.yo_selftest_batch_1_0.bin.c:20639:10: error: use of undeclared identifier '_file____priv_temp_65899'
```

## Reproducer

```rust
{ String } :: import("std/string");
{ assert } :: import("std/assert");
make :: (fn(flag : bool) -> String)(if(flag, String.from("dev"), String.from("x")));
main :: (fn() -> unit)({
  r := Result(bool, String).Ok(true);
  // A BARE arm body (no `{ }`) whose expression wraps a short circuit with an
  // rc'd temp in the RHS.
  match(r, .Ok(c) => assert(c && (make(c) == "dev"), "in a match arm"), .Err(_) => ());
});
export(main);
```

The same fails as a bare `cond` arm (`c => assert(c && (make(c) == "dev"), …)`) and as
a single-expression fn body (`check :: (fn(c : bool) -> unit)(assert(c && …))`). The
block forms — `.Ok(c) => { assert(...); }`, a `{ … }` fn body — compile and run.

Emitted C (bare arm):

```c
case __YO_T4_OK: {
  bool c = r.data.Ok.value;
  bool __yo_sc_1 = false;
  if (c) {
    __yo_t0 _temp_19012 = make(c);            // declared INSIDE the branch
    bool _temp_19013 = eq(_temp_19012, "dev");
    __yo_sc_1 = _temp_19013;
  }                                           // block closes — no drop
  assert(__yo_sc_1, "in a match arm");
  switch ((_temp_19012).tag) { … __yo_decr_rc … }   // undeclared identifier
```

## Root cause

`generate_op_and` / `generate_op_or` (`src/codegen/exprs/and_or.yo`) drop an operand's
temps IN the branch through `_emit_drops_for_conditional_branch`, which reads two
sources: `context.pending_deferred_drops` and the short-circuit node's own list. A temp
created in a bare body's tail call lives on the BODY node's `deferred_drop_expressions`
(the evaluator routes a bare body through the begin scope, sharing the node id with the
tail expression — here the `assert` call), which is neither source: the `&&` is a child
of the body node, and the bare-body emitters never fed the body's list into pending.
Every BLOCK-body emitter does exactly that on entry (`generate_case_body`'s begin
branch, `_emit_begin_arm`, `generate_loop_body`'s begin branch, the begin fn-body path
in `generation.yo` — whose comment even names this as the reason). The four bare-body
paths were the gap, so the drop fell through to the tail call's post-call flush, after
the `if (lhs) {` block had closed.

## Fix

Each bare-body path now concatenates the body node's `deferred_drop_expressions` (and
consumed-variable drops) onto `pending_deferred_drops` for the body's generation and
restores it after — the same bookkeeping the block paths do. The in-branch emission
records the drop in `emitted_deferred_drop_ids`, so the post-call flush does not emit
it a second time.

## Gates

- `tests/rc.test.yo`: five tests — bare match arm, bare cond arm, single-expression fn
  body, bare loop body, and the filed issue's `||`-ending-in-`Option.is_some()` shape
  inside a match arm inside a cond — each pinning "disposed exactly once" with a
  module-level `Dispose` counter. Red-first: the file did not compile before the fix.
- The compiler tree's own emission, before vs after (per-function compare): the only
  functions that change are those with this shape, and each change is a drop moving
  into its branch.
