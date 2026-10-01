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

## Where (measured with `YO_DEBUG_PARAMCHECK=1`, v0.2.47)

```
extern callee, binder T:  [param-check] label=slot declared=*(T) final=*(T) arg=*(T) compat=false
extern callee, binder U:  [param-check] label=slot declared=*(U) final=*(U) arg=*(T) compat=false
Yo callee,     binder T:  [param-check] label=slot declared=*(T) final=*(T) arg=*(T) compat=false
```

So it is not a name collision: renaming the extern's binder to `U` still leaves `final=*(U)`.
Step 6 of the parameter check (`synthesize_types`, `calls/helper.yo`) does not bind the
callee's binder from an argument whose type is the caller's unresolved SomeT, in either case.
The Yo-function callee fails the same compatibility check but is not reported, so some path
defers or retries a generic Yo callee in a trial, and the extern path lacks it. Next, with a
debug build: find what absorbs the Yo callee's failed Step 8, and give the extern call the same
treatment, or make Step 6 bind a callee binder to the caller's SomeT.
