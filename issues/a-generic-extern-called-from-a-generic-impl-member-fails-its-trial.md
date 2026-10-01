# A generic `extern("Yo")` function called from a generic impl member fails the member's trial

**Severity:** S3 — the definition-time trial of the member fails and is SWALLOWED; every
specialization works, so nothing is reported today. Phase 6 steps 3–4 of
`plans/TYPE_SYSTEM_SOUNDNESS.md` (re-raise a swallowed trial error, or make a stub an error)
would turn it into a false error on the prelude.

**Status:** OPEN. Found 2026-10-01 tracing `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`
with `YO_DEBUG_SWALLOW=1`: the prelude's `GcTracer.visit` (`std/prelude.yo`) fails its trial on
every `check`.

## Reproducer (measured, v0.2.47)

```rust
pragma(Pragma.AllowUnsafe);
Tr :: newtype(_cb : *(u8));
extern("Yo", __yo_my_take : (fn(generic(T : Type), tracer : Tr, slot : *(T)) -> unit));
impl(Tr, visit : (fn(generic(T : Type), self : Self, slot : *(T)) -> unit)(__yo_my_take(self, slot)));
export(Tr);
```

```
$ YO_DEBUG_SWALLOW=1 yo check repro.yo
[swallow] error[E0605]: Type mismatch for parameter "slot":
- Expected: *(T)
- Got     : *(T)
These are two different declarations with the same name.
```

| caller | callee | trial |
| --- | --- | --- |
| generic impl member | generic `extern("Yo")` fn | **fails** (swallowed) |
| generic impl member | generic Yo fn with the same signature | passes |
| generic free fn | generic `extern("Yo")` fn | passes |

## Where (reasoned, not yet measured)

The callee's own binder `T` is not instantiated at the call: the argument's type `*(T)` (the
member's `T`) is compared against the extern's declared `*(T)` (the extern's own `T`), two
different SomeTs that print alike. The Yo-function path freshens the callee's forall binders
before matching; the extern path apparently does not when the caller is an impl member's trial.
Next: compare the call paths for a FuncVal callee and an extern callee under
`ctx.is_in_function_call_checking_phase` in a member trial.
