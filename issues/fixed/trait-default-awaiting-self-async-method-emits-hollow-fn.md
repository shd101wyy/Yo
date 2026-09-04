# A trait `?=` default containing an `io.await` emits a hollow C function

**Status: FIXED 2026-08-26** (branch `fix/async-trait-default-monomorphization`).
Found 2026-08-25 by the STD_API_AUDIT D5 survey. It blocked D5 ("async
`Reader`/`Writer` traits with default methods `read_to_end`, `read_to_string`,
`write_all`, `lines()`") — those default methods are exactly this shape.

## Symptom

A trait with a required async method and a `?=` default whose body awaits it:

```rust
AsyncReader :: trait(
  read : (fn(self : Self, n : usize, io : Io) -> Impl(Future(usize, IoExn))),
  (read_twice : (fn(self : Self, n : usize, io : Io) -> Impl(Future(usize, IoExn)))) ?=
    ((self, n, io) ->
      io.async((e) => {
        a := e.io.await(Self.read(self, n, io), e);
        b := e.io.await(Self.read(self, n, io), e);
        (a + b)
      }))
);
```

`yo check` is green and `yo compile` exits 0. The emitted C:

```c
static inline void* closure_yo_id_5110(void* closure_context, void* e) {
  // Failed to transpile a := ((e.io).await)((Self.read)(self, n, io), e);
  // Failed to transpile b := ((e.io).await)((Self.read)(self, n, io), e);
  // Failed to transpile a + b
}
```

and the state machine calls it: `sm->result = closure_yo_id_5110(...)`.
Since PR #275 that body is rewritten to `abort()`, so the program aborts at
runtime instead of returning a garbage value.

With TWO implementors the failure is even louder: the capture struct is built
from the failed (Self-unbound) eval, so BOTH implementors share ONE
`struct { void* self; size_t n; Io io; }` and the emitted C does not compile —

```
error: initializing 'void *' with an expression of incompatible type '__yo_t16'
  __yo_t20 __capture_closure_yo_id_6875_1 = (__yo_t20){ .extra = extra, .self = self, .io = io };
```

## Root cause (the original diagnosis below was WRONG — see "Correction")

`src/evaluator/values/impl.yo`'s per-impl default fill materializes each
unoverridden trait `?=` default: it clones the default's body with fresh ids,
mints a fresh `func_id`, registers the `Self`-substituted method type, binds the
parameters at those substituted types, sets `ctx.self_type` to the receiver, and
then evaluates the body through `_materialize_default_body`.

That last step evaluated the body with **`evaluate_expression_raw(body, env,
ctx, …)` — the IMPL's ambient `EvalContext`**, not a function-body one. A
function body anywhere else in the evaluator is evaluated under
`create_function_body_evaluation_context(fn_ty, fn_val, env, ctx)`
(`_trial_eval_fn_body`, `calls/closure_type.yo`, `values/anonymous_function.yo`).
Two things that context establishes were therefore missing:

1. **`ctx.expected_type` = the declared return type.** `io.async`'s Step 6b
   (`evaluator/calls/helper.yo`) pre-binds the effect-bundle generic `E` **from
   the expected `Impl(Future(T, E))`**. With no expected type there is nothing to
   bind `E` from, so the closure parameter `e` stays an unresolved `SomeT`,
   `e.io` has no fields, and `e.io.await(...)` fails overload resolution:

   ```
   [anon-swallow] Error: No matching call found with arguments:
   ((e.io).await)(freeread(n, io), e)
   ```

   `_trial_eval_anon_body` swallows that (the def-eval wall), so the closure's
   body gets no `ExprInfo`s, no await analysis is registered, its Func type is
   never refined to a concrete result, and codegen — which reads exactly those —
   emits `void*` parameters, a `void*` return, a `_sync_fut_t` instead of a state
   machine, and a body of `// Failed to transpile` markers.

2. **`ctx.is_evaluating_function_body_or_async_block`.** Without it, a
   `return(...)` anywhere in a default body evaluates as an ordinary identifier:

   ```
   [mat-default-swallow] Error: Variable "return" not found.
     (dbl : (fn(self : Self) -> usize)) ?= ((self) -> return(Self.base(self) * usize(2)))
   ```

### Correction to the original diagnosis

The first version of this issue said the default "was emitted from the generic,
`Self`-unbound FuncVal — it was never monomorphized per implementor". That is
**not** what happens. The default IS monomorphized: with two implementors the
emitted C already contained two distinct outer functions with the CONCRETE
receiver in the signature (`fn_yo_id_6822(__yo_t0 self, …)` and
`fn_yo_id_6831(__yo_t1 self, …)`), because `register_func_type(d_fresh_id,
d_sub_ty)` records the `Self`-substituted type. Only the *body* eval failed.

Two corollaries of the real cause, both checked:

* **`Self` is not required.** An await of a plain free async function inside the
  same default hollows identically — the `Self` call in the reproducer is
  incidental.
* The isolation notes still hold and are now explained: a **sync** default works
  (no `io.async`, so no `E` to bind); an **async default with no await** works
  (nothing touches `e`); a **sync `Self` call inside an async default** works
  (same reason).

## Fix

`src/evaluator/values/impl.yo` — `_materialize_default_body` now takes the
`Self`-substituted method type and the fresh `func_id` and evaluates the body
under `create_function_body_evaluation_context`, like every other function-body
evaluation in the evaluator.

`create_function_body_evaluation_context` moved from
`src/evaluator/calls/function_type.yo` to `src/evaluator/context.yo` (which
already defines `EvalContext` and `FuncOrAsyncBlockCtx`). `impl.yo` cannot import
`function_type.yo`: that closes the cycle
`impl.yo → calls/function_type.yo → trait_checking.yo → values/impl.yo`, which
the module loader rejects (`Label "find_matching_generic_impl" being
destructured not found`). Its two other importers
(`calls/closure_type.yo`, `values/anonymous_function.yo`) now import it from
`context.yo`; `calls/function_type.yo` imports it back for its own three uses.

Diagnostics added while root-causing this, kept because the swallow that hid it
printed nothing at all: `YO_DEBUG_SWALLOW=1` now also prints
`[anon-trial]`/`[anon-swallow]` for closure-body trials
(`values/anonymous_function.yo`) and `[mat-default-swallow]` for the trait
default materialization (`values/impl.yo`) — the twins of `function_type.yo`'s
existing `[trial]`/`[swallow]` channel.

## Verification

Reproducer: `issues/repros/async-trait-default-await-self-method.yo`.
Regression test: `tests/async_trait_default_await.test.yo` (4 arms).

RE-MEASURED 2026-08-26 (review pass, both binaries built from this tree — the
unfixed one from the same tree with the `impl.yo` hunk reverted). Two rows of the
first table posted here did not reproduce and are corrected in place:

| | before | after |
| --- | --- | --- |
| `scripts/count-transpile-failures.sh` on the reproducer's C | **`0 real (0 floor, 2 abort-stub)`** — NOT "6 real". Since PR #275 an untranspilable body in a value-returning fn carries no marker at all, so the marker count cannot see this bug; the *stub* count is what moves | `0 real (0 floor, **0 abort-stub**)` |
| closure signature | `void* closure_yo_id_N(void*, void* e)` | `size_t closure_yo_id_N(void*, IoExn e)`, and the default emits a real `_state_t` state machine per implementor |
| capture struct | ONE shared `{ void* self; … }` | two, `{ __yo_t0 self; … }` (A) and `{ __yo_t1 self; … }` (B) |
| running the reproducer | **never gets to the `abort()`** — the shared `void* self` capture makes the emitted C fail to compile (4 clang errors, `initializing 'void *' with an expression of incompatible type '__yo_t1'`). The `abort()` form is what the NO-CAPTURE variant does | prints `22` then `26` |
| `yo test ./tests/async_trait_default_await.test.yo` | rc=1, C compile fails (15 errors) | 4 passed |
| the same file with the `return(...)` arm REMOVED (async arms only) | rc=1, batch C compile fails | 3 passed |
| **the `return(...)` arm ALONE** | **1 passed — green on develop too** | 1 passed |

That last row matters for how much this file's `return(...)` claim is worth. The
missing `is_evaluating_function_body_or_async_block` really does make a
`return(...)` default body throw during MATERIALIZATION — but the throw is
swallowed and the impl falls back to the shared generic default, which the
call-time specializer then specializes per receiver
(`fn_yo_id_…_rtparam0_struct_decl_…`) and which runs correctly. So `return(...)`
in a trait default was never user-visibly broken; only the async shape was. The
fix changes which of the two paths emits the method (measured on a two-implementor
`return(...)` default: the emitted C differs, both print the same answers).

## Relationship to the FTT work

Same class as `issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`.
PR #275's `abort()` rewrite is the backstop that turned this from a silent wrong
value into a loud crash; it is untouched by this fix. This was one of the roots
it was backstopping.
