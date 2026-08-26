# A materialized async trait `?=` default resolves its `Impl(Future(...))` return to ONE concrete state machine for ALL implementors

**Status: FIXED 2026-08-27**, in two layers:

1. **Per-impl return cells** (`_freshen_return_only_somes`,
   `src/evaluator/values/impl.yo`): `substitute` shares unchanged subtrees,
   so a `?=` default whose return contains no `Self` handed every
   implementor's materialization the SAME return SomeT as the trait
   declaration — one global resolution cell, last writer wins. Each
   materialization (non-generic per-impl fill AND the generic-impl defaults
   table) now rebuilds RETURN-position SomeTs with fresh ids/cells, leaving
   alone any SomeT that also occurs in params/foralls/where/implicit
   positions. The issue's gate — the two-implementor reproducer with ZERO
   `incompatible pointer` warnings — passes.
2. **Callee-channel future types at emission**
   (`awaited_future_c_type_override`, `src/codegen/functions/declarations.yo`,
   consumed by the sm `await_future_N` field emitter in `exprs/async.yo` and
   the call-temp declaration in `exprs/other_fn_call.yo`): a call's STAMPED
   future type can still carry a stale generation — a state machine minted
   during a def-time TRIAL of the same call and never emitted, which
   escalated this issue to a hard `incomplete definition of type ..._state_t`
   C error on D5's generic BufReader (test-arm context). The C truth is the
   CALLEE's emitted return spelling (the same `_async_override_return_type`
   its prototype uses); both the temp and the field now prefer that channel,
   so the static type always names the dynamic object.

The escalation section's SECOND repro (`bufio-large-read-test-arm-abort-stub`)
turned out to be a DIFFERENT bug entirely — the `=`-assign await no-op,
issues/fixed/assign-await-to-existing-variable-silently-noops.md.

Original report follows.

**Status: OPEN.** Found 2026-08-26 while reviewing the C16 fix
(`issues/fixed/trait-default-awaiting-self-async-method-emits-hollow-fn.md`).
Not a regression from that fix — before it the body did not evaluate at all —
but it is the next layer of the same defect, and it is live in the regression
test that fix ships.

## Symptom

Emitted C for two implementors of a trait with an async `?=` default contains

```
tmp/var/repro.out.c:4100:36: warning: incompatible pointer types initializing
  '_file____priv_temp_8430_state_t *' with an expression of type
  '_file____priv_temp_8416_state_t *' [-Wincompatible-pointer-types]
```

The call site for implementor **A**'s default declares implementor **B**'s
state-machine type and initialises it from `fn_…(a, io)`, which returns A's.

This is not cosmetic by this repo's own policy. `src/main.yo` deliberately
re-enables `-Wincompatible-pointer-types` on top of `-Wno-everything`, with the
comment *"A pointer-type mismatch between generated code and its own generated
prototype is never noise: both sides are written by this compiler"* — that
diagnostic exists because a previous instance of this exact class
(`issues/fixed/specialized-inout-param-loses-ref-with-comptime-arg.md`) silently
returned an uninitialised value.

## Reproducer

`issues/repros/async-trait-default-await-self-method.yo` — it warns as shipped.
So does `tests/async_trait_default_await.test.yo` (two warnings in the batch C).
It needs TWO implementors; one implementor is clean.

A trait method the impl PROVIDES (no `?=`) does not warn: each impl registers a
`MethodEntry` whose `ty` carries its own resolution. Only the default path warns.

## Why it does not corrupt anything today

Every async state struct starts with the same prefix —
`header, state, result, continuation_fn, continuation_sm, __yo_resume_fn,
__yo_set_effect_fn` — and `__capture` (the only per-implementor part) is placed
AFTER it (`src/codegen/async/`). The punned call site only touches that common
prefix. VERIFIED 2026-08-26 with implementors whose captures differ by 56 bytes
(`Small :: struct(k : usize)` vs an 8-field `Big`): the answers are still right.
It is one layout change away from being a silent wrong-value bug.

## Suspected cause

`impl.yo`'s per-impl default fill substitutes `Self` into the trait's method type
(`_substitute_self_in_method_ty`) and registers the result as the method entry's
`ty`. The return position of that type is the trait's `Impl(Future(T, E))` SomeT,
and the substitution appears to hand every implementor a type sharing ONE
resolution cell, so the last materialization wins for every call site — the
"SomeT id equality is not a shared `resolved_concrete` cell" channel that
`issues/fixed/yo-self-recursive-instantiation-era-split-fixed.md` and the
var-bound-receiver work already had to thread once.

Fix direction: give each per-impl materialization its own SomeT resolution cell
for the `Impl(...)` return before evaluating the body, the same way a call-time
specialization gets a fresh `function_return_impl_concrete_type` array.

## Gate

Reproduce with:

```bash
yo compile issues/repros/async-trait-default-await-self-method.yo \
  --std-path ./std --release -o /tmp/r.out 2>&1 | grep -c 'incompatible pointer'
```

Fixed means `0`.

## ESCALATION (2026-08-26): from benign warning to a hard C error — and it now BLOCKS D5's BufReader

Implementing the D5 generic `BufReader(R)`/`BufWriter(W)` (`std/io/bufio`,
branch d5/bufio-wrappers) hit this class as an ERROR, not a warning: with TWO
`Reader` implementors in scope (`File` and the generic `BufReader(R)`), a
test-arm call to `br.read_to_string(io)` (a trait default chained onto
`read_to_end`, both materialized for the generic implementor) emits an await
whose callee's mangled name still contains the ABSTRACT `R`
(`fn_yo_id_6982_rtparam0_R_gs_yo_id_7037_R_struct_decl…`) and whose future is
typed as that abstract specialization's state struct — which is never
defined:

```
error: incomplete definition of type '_file____priv_temp_8578_state_t'
```

Two repros, BOTH green as a plain `main` program and RED inside a `test(...)`
arm (the main-vs-test-arm divergence the repro-hygiene memory warns about):

- `issues/repros/bufio-trait-default-test-arm-abstract-state-struct.yo` —
  the incomplete-type C error above.
- `issues/repros/bufio-large-read-test-arm-abort-stub.yo` — the sibling
  face: the buffer-bypass `read` path on `BufReader(File)` runs an `abort()`
  stub (exit 6, fully "transpiled" C, #275 class) in a test arm.

Both need `std/io/bufio.yo` from branch d5/bufio-wrappers (or its PR) —
they exercise the generic wrapper. `tests/generic_impl_async_self.test.yo`'s
shapes stay green, so the trigger needs the two-implementor + cross-module
(+ test-arm cond) pile-up, not just a generic implementor with a default.

This is the same under-resolution family as
issues/iterator-chain-shared-stamp-cross-item-pollution.md (shared stamped
return instance + per-call SomeT cells; see also the gap-6 campaign notes) —
but through THIS issue's mechanism: the default's `Impl(Future(...))` return
resolving to one (here: abstract, never-emitted) concrete state type. Fixing
this row is now the prerequisite for landing `std/io/bufio` with honest
tests.
