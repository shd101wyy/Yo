# Assigning a non-`Copy` local to itself drops the value it keeps

**Severity:** S1. `x = x` on a local that is not `Copy` (`String`, `ArrayList`, `Rc`, a struct holding one, a `Drop` type) is
accepted and emitted as "save the old bytes, store `x` into itself, drop the saved bytes": `x` keeps a value whose
buffer was just freed. The next read is a heap-use-after-free, the scope end frees it again, and a `Drop` type's
destructor runs twice. Pre-existing: v0.2.76 accepts every form below.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A38). Confirmed on develop `64f33c710`.

## Reproducers

`tests/origins/unsound/self-assign-keeps-value-pos.yo` (was `issues/repros/2026-11-11-…`; negative: expects
`accept` with no drop at the assignment; today it is a use-after-free):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(x) := String.from("payload-0123456789abcdefghijklmnop");
  x = x;
  println(`OUT ${x}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

The emitted C for `x = x;` (`--emit-c`, names shortened):

```text
__yo_t_String __yo_v_x = tmp_from;
__yo_t_String tmp_old; memcpy(&tmp_old, &(__yo_v_x), sizeof(tmp_old)); // Save old value by bytes
__yo_v_x = __yo_v_x;
String_drop(&(tmp_old));
```

- `self-assign-keeps-value-drop-count-pos.yo` (negative, no heap payload): `D` with a counting `Drop`; prints `drops=1` right after `x = x`
  and `drops=2` at the end, for one value.
- `self-assign-keeps-value-loop-pos.yo` (negative): `x = x` in a `while` body; ASan: double free on the second iteration.
- `self-assign-through-block-pos.yo` (positive control): `x = { y := x; y }`, the same self-assignment through a block, is clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `x = x` on `String` / `ArrayList(String)` / a struct with a `String` field (ledger s08, s17) | accepted, UAF | accepted, no drop |
| `x = (x)` (ledger s06) | accepted, UAF | accepted, no drop |
| `x = x` on a `Drop` type | accepted, Drop runs twice | accepted, Drop once |
| `x = x` in a loop body | accepted, double free | accepted, no drop |
| `r = r` on an `Rc(String)` (ledger s11) | accepted, UAF | accepted, count unchanged |
| `x = { y := x; y }`, `x = cond(c => x, true => …)`, `x = match(…, _ => x)` (ledger s03–s05) | accepted, clean | accepted |
| `x = f(x)` with `f` taking `D` by value (ledger a01) | accepted, clean | accepted |
| `s.f = s.f`, `xs(usize(0)) = xs(usize(0))`, `G = G` on a module-level `String`, `r.* = r.*` (ledger s07, s10, s16, s09) | E0901 | E0901 |

## Root cause

Verified in `src/evaluator/exprs/assignment.yo`, `evaluate_assignment`'s whole-variable path. Whether the old value
needs a save-and-drop is decided by `lhs_consumed_by_rhs`, computed right after the RHS is evaluated: "Check if the
LHS variable was consumed by the RHS (e.g., via own parameter) … If consumed, we must NOT create a temp variable to
save the old value". For a call (`x = f(x)`), a block (`{ y := x; y }`) or a `cond` arm the move of `x` happens
while the RHS is evaluated, so the flag is true. A bare atom RHS is moved later: `set_expr_as_needs_to_call_dup(&rhs_evaled,
…, "assign")` runs about forty lines below, and for a move-only type its `transfer_explicit_copy_value`
(`src/evaluator/utils.yo`) is what calls `set_expr_as_consumed` on `x`. The flag was already computed as false, so the
`=` gets `attach_temp_variable_to_expr(expr, true, ctx)`, and codegen (`src/codegen/exprs/assignment.yo`) emits the
by-bytes save and the deferred drop of the old value, which is the value just stored. The `Rc` form (ledger s11) is the
same UAF; `Rc` is explicit-copy too (VBD decision 17), so it presumably takes the same path, not traced separately.

## Expected

Accepted, with no drop at the assignment: `x = x` moves the old value into the store, and the stored value is the
one the scope end drops once, as `x = f(x)` and `x = { y := x; y }` already behave. Reading `lhs_consumed_by_rhs`
after the RHS's own move is recorded (or testing "the RHS is the LHS variable itself") gives that. Rejecting
`x = x` instead would be a lint, not a soundness rule: VBD §0.2's table makes a non-`Copy` read "an error unless it
is the value's last use (then a move)", and the right side of `x = x` is that last use.

## Test

With the fix, the three programs above and the positive control move to `tests/origins/unsound/` (all four
`// expect: accept`, run under ASan); `tests/move_only.test.yo` gains "move-only: `x = x` keeps the value and runs
no drop", with the `Drop`-count assertion of `self-assign-keeps-value-drop-count-pos.yo`.

## Fix

`evaluate_assignment`'s whole-variable path (`src/evaluator/exprs/assignment.yo`) now reads `lhs_consumed_by_rhs`
again after `set_expr_as_needs_to_call_dup(&rhs_evaled, …, "assign")` and the environment re-read that follows it
(lane c8e). For a bare atom RHS that names the target, that transfer is the move. With the flag set, the `=` gets
the unit info that `x = f(x)` gets: no temporary saves the old bytes, and codegen emits no drop of the value just
stored. The variable is revived by the same store, so the scope end drops it once. `x = (x)` and `r = r` on an `Rc`
take the same path.

Tests, all `// expect: accept` and run under ASan by G-B: `tests/origins/unsound/self-assign-keeps-value-pos`,
`self-assign-keeps-value-loop-pos`, `self-assign-keeps-value-drop-count-pos` (it asserts 0 drops after `x = x` and 1
at the end) and `self-assign-through-block-pos`. `tests/move_only.test.yo`, "move-only: `x = x` keeps the value and
runs no drop", checks the `Drop` count, including `x = (x)` in a loop. It fails on develop `ece5e5cfd`: the
assignment disposes the value.
