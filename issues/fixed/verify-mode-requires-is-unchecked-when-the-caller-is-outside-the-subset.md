# verify mode: a `requires` is neither proved nor checked when the caller is outside the subset

**Severity:** S2 — in verify mode a `requires` is neither proved nor emitted as a check outside the subset — violated preconditions pass silently

**Status: FIXED 2026-09-28** (branch `verify/requires-and-solver-fixes`, the recommended option). Found 2026-09-28 while designing
`plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`. The safe-mode guards
hide it today. It becomes undefined behavior as soon as a guard is elided on
the strength of the unchecked `requires`, so 5b's soundness rule treats a
verify-mode `requires` as unenforced until this is fixed.

## Symptom (measured, `yo 0.2.45`, macOS arm64)

```rust
pragma(Pragma.Verify);
{ println } :: import("std/fmt");

safe_div :: (fn(a : i32, b : i32, requires(b != i32(0))) -> (r : i32))(
  a / b
);

main :: (fn() -> unit)({
  zero := (i32(10) - i32(10));
  println(safe_div(i32(10), zero));
});
export(main);
```

```text
$ yo compile p5b_hole.yo --emit-c --optimize 2 -o p5b_hole    # rc 0
  ok       fn@p5b_hole.yo:3 [verify] — 1 obligation(s) proved
  n/a      fn@p5b_hole.yo:7 [verify] — no contracts; body outside the verifiable subset: call to a callee without contracts
$ ./p5b_hole
integer division or remainder by zero (at p5b_hole.yo:5:5)      # rc 134
```

The emitted C has no `requires failed` check. `safe_div`'s body still has
`__yo_div_guard(...)`, and that guard is the only reason the run traps
instead of dividing by zero.

## Root cause

Two rules that are each reasonable combine into the hole:

1. In `verify` mode the contract splice is suppressed
   (`wrap_function_body_with_contracts`, `src/evaluator/builtins/contracts.yo`):
   no `requires` assert is emitted, because the verifier is supposed to
   prove `requires#k` at every call site.
2. A contract-less function whose walk hits a subset error is reported as
   the passing outcome `outside-subset`, and its obligations are discarded
   (`verify_and_strip_tasks`, `src/verifier/driver.yo`, V6 task 5). `main`
   above is that function, so its call to `safe_div` never has to prove
   `b != 0`.

So `safe_div` is reported `ok` on an assumption nothing establishes. The same
open world includes exported symbols of a `--static-library` /
`--shared-library` build, function values called indirectly, and FFI callers.

## Fix options

- **Recommended:** `verify` mode keeps the `requires` entry asserts. It stops
  suppressing only the `ensures` asserts, which the verifier proves.
  `verify+` already works this way (`tests/spec/fixtures/valid/verifyplus_abs.yo`:
  "the `requires failed` entry guard must stay"). The cost is one check per
  call.
- Alternative: make an outside-subset caller of a contracted callee a hard
  `subset-error` again. This reverts V6 task 5's degradation and turns the
  std sweep red.

`refine(T, p)` parameters have the same shape: the predicate erases to `T`
at runtime (`tests/spec/fixtures/valid/refine_nonzero_runtime.yo`), so it is
never checked at entry either.

## Test to add with the fix

A cli-case compiling the repro above. It expects rc 134 with the
`requires failed` message from the entry check, not the division guard's
message. That result proves the entry check fired first.

## Fix

`verify` mode keeps the `requires` entry asserts and suppresses only the
`ensures` asserts, which the verifier proves against the body
(`wrap_function_body_with_contracts`, `src/evaluator/builtins/contracts.yo`).
`verify+` already behaved this way. One detail was measured on the way: the
requires-only splice normally flattens a block body into its own `begin`, and
in `verify` mode that left the task's UNWRAPPED body node without ExprInfo.
The verifier walks exactly that node, so `dist_zero` in
`tests/spec/verify_straight_line.test.yo` turned into a `subset-error`. In
`verify` mode the body is therefore kept as one child
(`begin(asserts…, body)`). Runtime-mode splicing is unchanged.

Only a **runtime-checkable** `requires` is spliced
(`requires_is_runtime_checkable`). A predicate that calls a `ghost_fn`,
quantifies (`forall`/`exists`), or reads `old(...)` has no runtime meaning, so
it stays proof-only. The first full run caught this: `verifier_ghost`'s
`requires(within(x, i32(0)))` with a ghost `within` broke 3 tests. Nothing is
spliced into a `ghost_fn`'s own body either, because it never runs
(`ctx.is_ghost_context`). Such a requires remains unchecked for a caller the
verifier never walks, the same class as a `refine` below, and 5b must treat it
as an unchecked assumption.

`refine(T, p)` parameters are NOT covered, and cannot be by this fix: the
predicate `p` is a `ghost_fn`, which has no runtime body to call, so there is
nothing to assert at entry. Until refinements get a runtime check, a
refinement fact is an unchecked assumption. 5b's soundness filter
(`plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md` §5.1) must never
elide a guard on one.

## Verification

- The repro above: `safe_div` is still reported `ok … 1 obligation(s) proved`,
  and the binary now aborts with
  `requires failed: b != i32(0) (at p5b_hole.yo:4:46)`. The entry check fires
  before the division guard.
- `tests/internal/verifier_strip.test.yo` "verify mode splices the requires
  guard and not the ensures assert": fixture
  `tests/spec/fixtures/valid/verify_requires_kept.yo` has 1 `requires failed`
  guard and 0 `ensures failed` asserts. Run against the pre-fix `contracts.yo`, it fails with `verify mode keeps the requires entry guard (got 0)`.
- `yo verify` reports are unchanged against the pre-fix compiler:
  `std/collections` 11 functions (1 ok, 7 assumed, 3 outside-subset) and
  `tests/spec/verify_straight_line.test.yo` 7/7 ok.
