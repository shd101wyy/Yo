# verify mode: a `requires` is neither proved nor checked when the caller is outside the subset

**Status: OPEN.** Found 2026-09-28 while designing
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
