# `return(<a local borrow>)` and a body-tail yielding one were accepted

**Status:** FIXED 2026-10-06
**Severity:** S2 — the second-class rule of decision 18 rule 1 was not
enforced: `return(y)` and a body whose result expression is the borrow (or a
place reached from it) were accepted, and until borrows stop copying they
silently return a copy of the pointee, so the escape shape survives to the
generation where it would have to move the borrowed place or return the
borrow itself.

## Symptom

Both shapes compiled and ran (v0.2.52 tree, `feat/vbd-local-borrows`
before the fix), returning the pointee copy:

```rust
f1 :: (fn() -> i32)({
  x := i32(1);
  imm(y) := x;
  return(y);   // accepted: returned 1 (the copy)
});
f2 :: (fn() -> i32)({
  x := i32(1);
  imm(y) := x;
  y            // accepted: the body tail yielded the borrow
});
f3 :: (fn() -> i32)({
  x := i32(1);
  imm(y) := x;
  {
    y          // accepted: the nested block the body result ends in
  }
});
```

All three are rejected by
`plans/VALUES_BY_DEFAULT.md` decision 18 rule 1 and decision 38 A: a local
borrow is **second-class** — no return, store, escaping capture or spawn.
The value may be read through (and, while borrows of implicitly copyable
types still copy, the read produces a copy), but the borrow itself never
crosses the function boundary. Measured 2026-10-06 with the branch's
tree-built binary: `check` passed all three, `compile` built them, and the
program printed `111`.

## Root cause

The local-borrow model landed with the exclusivity, live-range, module-level,
`await` and re-point rules (`src/evaluator/utils.yo`'s "Local borrows"
section) but no boundary check:

- the identifier evaluator's read hook (`local_borrow_access`, kind `Read`)
  treats the borrow's own slot as a place that overlaps nothing, so reading
  `y` in any position — including a return argument or a body tail — was a
  legal read;
- `src/evaluator/exprs/begin.yo`'s `return(val)` branch evaluates the
  argument and then runs only the raw-pointer flowability defense, which a
  value type like `i32` never trips;
- nothing marked "this begin block is the enclosing function body's result
  block", so a borrow tail (bare, or in a nested block the result ends in)
  was judged as an ordinary read.

The pre-existing acceptance had history: the old `inout(name) := place`
audit made `return(<binding>)` deliberately return the pointee, and a 2026-09-23
fix made that C correct
(`issues/fixed/return-of-an-inout-local-binding-emits-the-pointer.md`).
Decision 18 superseded the acceptance: the binding is a borrow, and the
spelling names it, not the value. The pointee-copy behavior of a READ
through the borrow is unchanged (`v := y;` still copies).

## Fix

A new diagnostic, **E0912** (`E_LOCAL_BORROW_ESCAPES`,
`src/diagnostics.yo`, with a registry entry in
`src/diagnostics_registry.yo`), raised through the flow-violation channel at
two hooks:

1. **`return(<arg>)`** — `begin.yo`'s `return(val)` branch checks the
   syntactic argument before evaluating it
   (`local_borrow_result_borrow_of`): an argument that names a place — an
   identifier or a `.field` chain, with a call-site borrow marker stripped —
   whose root binding is a registered local borrow is the escape. A call or
   index on the place (`y.len()`, `xs(i)`) is not a place expression: its
   result is the callee's, so those stay legal, as does any operation on the
   borrow (`y + i32(0)`).
2. **The body's result chain** — the begin block evaluator identifies the
   enclosing body's own block (every body site already passes
   `is_evaluating_function_body_begin_block = true`; a `test(...)` block's
   result is discarded, so test blocks are excluded) and, at its last
   statement:
   - a begin-shaped tail **joins the chain**: `ctx.local_borrow_result_chain_tail`
     (a new `EvalContext` field) names it, and its own block — while the
     borrows it declares inside itself are still registered — repeats the
     check at its tail;
   - any other tail is checked directly, so the bare borrow, a place reached
     from it (`y.x`) and a borrow declared inside the result block are all
     rejected (f2, f3 and the f3 variant above).

The rejection applies to `imm(y) :=`, `mut(y) :=` and `inout(y) :=` alike
(`inout` is `mut`'s Generation A synonym; one binding evaluator handles all
three). An `inout`/`mut` **parameter** is a different mechanism and is
unchanged: `return(m)` of an `inout` parameter still returns the pointee
copy (`tests/ref_params.test.yo` pins it), as does the borrowed `for`'s
element binding.

## Verification

- Before the fix (the handover WIP binary):
  `yo check tmp/fixme.yo --std-path ./std` passed all three shapes and the
  compiled program printed `111`.
- After the fix: `tests/local_borrows.test.yo`'s new
  "a borrow crosses the function boundary (E0912)" section pins the
  rejection of `return(y)`, `return(y.x)`, the body tail, the nested-block
  tail (both variants), the `mut` form and the `inout` form, plus the
  sanctioned way out (`v := y;` then `v`; an operation on the borrow).
- `tests/ref_local_binding.test.yo`'s old "return through a binding copies
  the pointee" test was rewritten: the three `return(<binding>)` shapes are
  `comptime_expect_error`s now, and the positive test pins that reading the
  binding out (`v := y;`) still returns the pointee with a balanced count
  (`ref_count == 1` for the RC case).

## Deferred

- A `cond(...)`/`match(...)` arm whose block yields a borrow, as the body's
  result expression (`cond(c => { y }, true => { 0 })`), is not yet caught:
  the arm's value flows through the cond/match node's own evaluators, which
  do not carry the chain identity. It is the same escape shape and should
  join the rule with decision 38 A's closure work (the capture-list
  branch's `E_BORROW_ESCAPES`, E0909 there, is the closure analogue).
- The parameter-mode half (`return(y)` of a `mut(y) : T` parameter once
  V3b's plain parameters become borrows) is V3b Generation B work.
