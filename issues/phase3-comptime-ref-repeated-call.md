# Phase 3: `comptime(ref(n))` param mis-binds on the SECOND call

## Status

Open — pre-existing (fails identically on the 53-baseline), niche (1 test:
`tests/comptime_ref.test.yo`). TS passes it. Distinct from the resolved
knot/circular blockers.

## Repro + discriminator

```rust
bump :: (fn(comptime(ref(n)) : usize) -> comptime(usize))({ n = (n + usize(1)); n });
comptime_assert(bump(usize(5)) == usize(6), "5+1");  // OK
comptime_assert(bump(usize(0)) == usize(1), "0+1");  // FAIL after the line above
```

- `bump(usize(0))` **alone** → OK.
- `bump(usize(5))` **alone** → OK.
- `bump(usize(5))` THEN `bump(usize(0))` → the SECOND call fails:
  `Expected bool value for "comptime_assert", got: bump(usize(0)) == usize(1)`
  (i.e. `bump(usize(0))` returned a non-value → `==` stayed unevaluated).

## Mechanism (narrowed)

Instrumented `evaluate_comptime_fn_call` (func id + arg/result value kinds):

- NOT the comptime-fn cache-collision class. `bump`'s args are concrete +
  distinct (`usize(5)` vs `usize(0)`), so `_ctfe_args_equal` would not collide;
  `should_cache` is keyed correctly by the distinct args.
- `bump(usize(5))` alone returns `6` — its body (`n = n + usize(1); n`) evaluates
  `n` to the concrete arg on the FIRST call.
- `bump(usize(0))` AFTER `bump(usize(5))` returns `UnknownVal` — so on the SECOND
  call the `comptime(ref(n))` parameter `n` is NOT bound to the concrete arg
  (`0`); it resolves to `UnknownVal`, and `UnknownVal + 1` → `UnknownVal`.

So the bug is in **`comptime(ref(name))` parameter binding across repeated calls**:
the first call binds `n` correctly, but state left after it (a stale ref binding
in the FuncVal's captured env / a comptime-ref side-table, or the
binding-update/mutation path for `comptime(ref)` not being reset per call) makes
the second call's `n` unresolved. The `ref` mutation (`n = n + 1`) propagating
back to the caller's compile-time value is the special machinery here (see the
test's doc comment: "mutations through the binding propagate back to the caller's
compile-time value via the evaluator's binding-update path").

## Recommended next step

Instrument the `comptime(ref(...))` parameter binding + the binding-update path
for two sequential `bump` calls. Check why the 2nd call's `n` is `UnknownVal`:
likely the FuncVal's captured-env (or a ref side-table) retains the FIRST call's
mutated/consumed `n` binding and the 2nd call reuses it instead of binding the
fresh arg. The fix is to bind a FRESH `comptime(ref)` parameter per call (not
reuse stale state). Repro is fast (3 lines, no prelude noise beyond
comptime_assert).
