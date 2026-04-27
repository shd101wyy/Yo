# Mutually-recursive impl methods cause specialization stack overflow

## Status

**Fixed** in commit (pending) on `bootstrap/phase-1`.

The fix introduces `currentlySpecializingFunctionStack` in `EvaluatorContext`
(in addition to the existing single-slot `currentlySpecializingFunction`).
`isRecursiveCallDuringSpecialization` now matches if the callee's funcId
appears anywhere in the stack — not just at the top — and the
forward-reference FunctionValue is constructed by looking up the matching
stack entry by funcId.

Regression test: `tests/forward_ref_impl_block.test.yo` —
"mutual recursion with effect params (specialization-cycle)".

Originally discovered while implementing forward references between sibling
fields inside a single `impl(...)` block (Phase 1 bootstrap).

## Symptoms

`Maximum call stack size exceeded` raised during _evaluator specialization_
(not codegen) the first time a mutually-recursive impl method is called.

## Minimal repro

```rust
open import "std/error";

P :: object(n : i32);

impl(P,
  even : (fn(self : *(Self), i : i32, using(exn : Exception)) -> bool)(
    cond((i == i32(0)) => true, true => self.odd((i - i32(1)), using(exn)))
  ),
  odd : (fn(self : *(Self), i : i32, using(exn : Exception)) -> bool)(
    cond((i == i32(0)) => false, true => self.even((i - i32(1)), using(exn)))
  )
);

main :: (fn() -> unit)({
  given(exn) := Exception(throw: ((err) -> { escape (); }));
  p := P(n: i32(0));
  r := p.even(i32(10), using(exn));
  ()
});
export main;
```

Reproduce:

```bash
./yo-cli compile /tmp/mut_rec.yo --emit-c --skip-c-compiler
```

Output ends with:

```
Error: - (_i32) fn(comptime(lhs) : i32, comptime(rhs) : i32) -> (comptime(...) : i32)
Maximum call stack size exceeded.
file:///private/tmp/mut_rec.yo:10:55:
    cond((i == i32(0)) => false, true => self.even((i - i32(1)), using(exn)))
                                                      ^
```

The site that overflows is the recursive call inside `odd` back to `even`.

## Conditions

All of these together appear required to trigger the bug:

- Two (or more) methods in the **same `impl(...)` block** that call each
  other via `self.<name>(...)`.
- At least one effect/`using(...)` parameter on the recursive methods.
- Real mutual recursion (call-graph cycle), not just forward reference.

Direct self-recursion (`self.even` calling `self.even`) compiles fine.
Backward calls (`self.odd` defined first, called by later-defined `self.even`)
compile fine.

## Why now

Before forward-references-in-impl-block landed, mutual recursion in
`yo-self/parser/parser.yo` was hand-rolled via module-level holders:

```rust
_parse_expression_holder : Option(fn(...)) = .None;
// ... after impl block:
_parse_expression_holder = .Some(Parser.parse_expression);
// ... and inside parse_primary etc.:
match(_parse_expression_holder, .Some(__fn) => __fn(self, ...))
```

That `__fn(...)` call is a **runtime function-pointer dispatch** — the
specializer sees an opaque call and does not recurse into the held
function. The cycle is therefore broken at evaluator time.

Once we switched to direct `self.parse_X(...)` calls, the specializer
re-enters the in-progress specialization of the caller while specializing
the callee, with no cache entry to short-circuit.

## Root cause hypothesis

Function specialization caches by funcId. When `even` starts specializing,
no cache entry exists yet for the concrete instantiation. Inside `even`'s
body the specializer encounters `self.odd(...)` and starts specializing
`odd`. `odd`'s body contains `self.even(...)`, which re-enters
specialization of `even` — but the cache for `even`'s in-progress
specialization has not been written yet, so it recurses infinitely.

The fix needs the specializer to record an "in-progress" placeholder in
`specializedFunctionCaches` _before_ evaluating the body, so the recursive
call hits that placeholder and reuses the partially-typed FunctionValue.

Relevant files:

- `src/evaluator/calls/function.ts` — specialization entry points around
  lines 1896–2210 (cache lookup/store) need to be made
  re-entrant-safe.
- `src/evaluator/values/impl.ts` — `tryCreateForwardShell` already creates
  shells with stable funcIds in the pre-pass; the specializer just needs
  to use them as placeholder cache values during in-progress
  specialization.

## Workaround

Until fixed, route mutually-recursive impl methods through module-level
`Option(fn(...))` holders, as `parser.yo` originally did. Direct
`self.X(...)` calls are safe only when the call graph among sibling
methods is acyclic.

## Next steps

1. Add this `.test.yo` repro under `tests/` once we have a fix in flight
   (so we don't break CI by checking in a known-failing test).
2. Add an in-progress placeholder mechanism to the specializer (likely a
   `WeakMap` keyed on the instantiation key).
3. Verify on the synthetic repro, then re-merge `yo-self/parser/parser.yo`
   into a single impl block and remove the holders.
