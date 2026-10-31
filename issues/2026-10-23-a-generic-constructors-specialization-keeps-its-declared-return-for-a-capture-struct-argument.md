# A generic constructor's specialization keeps its declared return for a capture-struct argument

**Severity:** S3 — latent: no user program reaches it today, but a generic prelude constructor whose body ends in a `match` miscompiles (two C types for its result) when `dyn(...)` boxes a closure that captures a generic function's `Impl(Fn)` parameter through it.

**Status:** open. Found 2026-10-22 on `feat/rc-alloc-parameter`; filed 2026-10-23 at the adversarial review's request, because the user-visible symptom
(`issues/fixed/2026-10-22-a-dyn-closure-in-a-generic-fn-boxes-through-a-cell-typed-by-the-unbound-return.md`)
was fixed in std by a reshape (`rc` and `arc` bind their `match`), not in the evaluator.

**Update 2026-10-29 (H1):** `dyn(...)` no longer reaches this path through `rc`/`arc`. It boxes a closure with
the prelude's `__yo_rc_cell`/`__yo_arc_cell` (`_prelude_cell_constructor`, `src/evaluator/values/dyn.yo`), copies
with the same bound `match`, so the reproducer below now needs the tail-`match` shape restored in `__yo_rc_cell`.
Those two are the only callers that pass a capture-struct `V` to a generic constructor; the issue stays open
until the adoption gate is fixed. V5 Generation A rewrites their bodies onto `__yo_cell` but keeps them (Fable
consultation #7, 2026-10-30); static-argument inference B3 deleted `rc`/`arc` and kept these two.

## What is wrong

`create_specialized_function_inline` (`src/evaluator/calls/helper.yo`) evaluates
a specialized body's tail with the specialization's return type, `spec_ret_ty`,
as the expected type. `dyn(v)` on a closure synthesizes `rc(v)` or `arc(v)`
(`evaluate_dyn_value`, `src/evaluator/values/dyn.yo`), so `V` is the closure's
capture struct. When the closure captures a parameter of a generic function,
that struct's field is typed by the parameter's `Impl(Fn)`, and `spec_ret_ty`
stays the declared `Rc(V)`/`Arc(V)` over the unbound `V`. A tail `match` then
adopts that type (`_arm_result_type`, `src/evaluator/exprs/match.yo`) while
its arms build the concrete cell, and clang rejects the instance:

```text
error: incompatible pointer types returning '__yo_t_17754804306474760513 *' from a function with result type '__yo_t_16273135591263856145 *' [-Werror,-Wincompatible-pointer-types]
```

The likely gate is the return re-evaluation's adoption check in
`create_specialized_function_inline`. It adopts a re-evaluated return only
when it is concrete, or when its `SomeT`s are this call's own closure-typed
forall arguments (the carve-out from
`issues/fixed/arc-of-a-send-closure-emits-two-capture-struct-typedefs.md`).
A capture struct carrying an enclosing function's `Impl(Fn)` fits neither
case. This was not instrumented.

## Reproducer

User code does not reach the path. The review tried a user generic
constructor ending in a tail `match`, called with a closure capturing an
`Impl(Fn)` parameter, and the call is rejected earlier with "Expected a
function type". The only caller that passes a capture-struct `V` is `dyn`'s
synthesized `rc`/`arc`.

To reproduce, restore the tail-`match` shape in a scratch copy of
`std/prelude.yo`: in `rc`, replace `cell := match(…); cell` with the bare
`match(…)`. Then run `yo test tests/rc.test.yo --std-path <scratch std>
--test-name-pattern "boxes through rc" --parallel 1`. The batch fails to
compile in clang (the review's run of 2026-10-22: 3 errors, "0 of 1 tests in
this batch ran"); with the tree's `rc` the test passes. The `arc`
twin in `tests/arc.test.yo` ("boxes through arc") fails the same way with a
tail-`match` `arc`.

## Fix direction

Let the specialization adopt the re-evaluated `Rc(<capture struct>)` return
when the `SomeT`s come from a capture struct built inside this call's
arguments, so that a tail `match` is typed by the concrete cell. Then `rc`
and `arc` can drop the bound `match`, but only once `SEED_VERSION` carries
the fix: the v0.2.68 seed needs the bound shape to build the compiler. The
two regression tests above are this fix's tests once the prelude returns to
the tail shape.

Acceptance (Fable consultation #7): retry Fable consultation #5's H1(b), building `dyn`'s cell as
`Rc(resolve_cell_chain(T)).new`, and delete `__yo_rc_cell`/`__yo_arc_cell`, `_is_open_payload`,
`_prelude_cell_callee` and `_prelude_cell_constructor`. Not scheduled before v0.2.76.
