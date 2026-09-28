# An `io.await` as the scrutinee of a BOUND `match` emits an empty scrutinee (invalid C)

**Status:** FIXED 2026-09-28. **Found:** 2026-09-28, writing
`_compiler_identity` in `src/build_runner.yo` (the build-cache compiler-identity
fix). Pre-existing on every seed tried: v0.2.38, v0.2.43, v0.2.44 and v0.2.45.

## Symptom

Inside an `io.async` block, a `match` whose scrutinee is an `io.await(...)`
compiles to C that does not compile. A `cond` whose first condition is one gets
a misleading E0904. Both happen when the branch expression is the right-hand
side of a binding or assignment:

```rust
outer :: (fn(io : Io) -> Impl(Future(usize, IoExn)))(
  io.async((e : IoExn) => {
    n := match(
      e.io.await(get_opt(e.io), e),     // get_opt : Future(Option(ArrayList(u8)), …)
      .Some(bytes) => bytes.len(),
      .None => usize(9)
    );
    n
  })
);
```

```
tmp/sm_flat.out.c:7338:12: error: expected expression
      if ( != NULL) {
        sm->var_bytes_15754577013211021277 = ;
```

The scrutinee does not need to be a niche `Option`: `Option(i32)` fails the
same way. The statement form, `match(io.await(...), ...)` on its own, works and
is tested ("Test await as a match scrutinee").

## Root cause

A scrutinee or first condition is evaluated before any branch is chosen, so the
await cannot end a state. `hoist_non_splittable_awaits`
(`src/codegen/async/state_code_gen.yo`) moves the whole statement to the next
state, where the await reads `sm->await_result_N`. Whether a statement
qualifies is `await_is_in_non_splittable_position`, and it looked only at the
statement's top-level form (`cond` / `if` / `match`). For
`n := match(await…, …)` the top-level form is `:=`, so nothing was hoisted.
The match then went to `generate_match_with_await` as if an arm awaited, and
its scrutinee rendered through `generate_await` with no substitution, which is
the empty string.

`generate_cond_with_await` had a guard for exactly this ("reaching here with
one still in place means the hoist did not fire") and reported E0904, so the
`cond` form failed with a diagnostic telling the user to hoist by hand. The
match form had no such guard.

## Fix

- `await_is_in_non_splittable_position` looks through `:=` and `=` (which
  covers `(v : T) = …`) to their right-hand side. Every part of such a
  statement runs after the await, so hoisting it whole is exact.
- `generate_match_with_await` has the `cond` guard's twin. A scrutinee that IS
  the await and was not substituted is a positioned compile error, never an
  empty operand.

## Tests

`tests/async_await.test.yo`:
- a bound match on an `i32` scrutinee;
- a bound match on a handle `Option` (the niche lowering);
- a bound `cond`;
- an assigned match;
All four fail on develop (the batch does not compile) and pass after the fix.

They, and their statement-form siblings, carry a LeakSanitizer report on
Linux. That is the future's own capture leaking, the same 24 bytes with no
hoist involved (`io.async` closure captures; plan handover §3.1), not this
fix.

## Still unsupported: the same shape INSIDE another branch's body

Only the top-level statement list is split into states (and hoisted). An
await in a nested match's scrutinee inside an arm (`.Ok(p) => { n :=
match(io.await(…), …); … }`) belongs to the arm emitters, which split at
awaits in branch VALUES only. That shape used to emit the same invalid C. It
is now the match guard's positioned E0904 ("Hoist it into a local first").
The bound form was how it was found, in `src/build_runner.yo`, and the
workaround the diagnostic suggests is what that code now does.
