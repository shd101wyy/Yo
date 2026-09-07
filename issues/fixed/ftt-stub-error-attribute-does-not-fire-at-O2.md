# A live "failed to transpile" stub is silent at -O2: the `error` attribute is diagnosed after optimization

**Status:** FIXED 2026-09-07 (made loud; see "Why not a build failure")
**Found:** 2026-09-07, after `issues/fixed/derive-tostring-debug-body-is-unhygienic-and-aborts.md`
shipped in a release behind exactly this hole.

## The design, and the false premise under it

When a function body fails definition-time evaluation and the failure is
swallowed, codegen rewrites the body to `abort()` and guards it with GNU's
`error` attribute. `src/codegen/functions/generation.yo` states the intent:

> The error attribute makes the C COMPILER the deadness oracle: the build fails
> IFF a call to the stub survives — a dead generic original (no callers)
> compiles clean, while a LIVE stub … becomes a compile error at every call
> instead of an rc=134 abort with no diagnostic.

The intent is right. The premise — that the attribute fires — is false at `-O2`.

## Measurement

One unchanged emitted `.c`, two clang invocations:

| | `clang -O0` | `clang -O2` |
| --- | --- | --- |
| `declared with 'error' attribute` diagnostics | **2** | **0** |

The attribute is diagnosed from the **backend, after optimization**. The stub
body is `abort()`, so LLVM folds the call to a `noreturn` function away and
there is no call left to diagnose. Neither `-fno-inline` nor `__attribute__((noinline))`
on the stub restores it — this is not inlining, it is the call being eliminated.

`--optimize 2` is the project directive and what `yo build` uses for release
builds, so **the guard was only ever armed in `-O0` builds**. End to end, on the
derive bug: `yo check` reported "evaluator OK", `yo compile --optimize 2`
reported nothing, and the binary died at rc=134 printing nothing.

## Why not a build failure

The obvious fix — have the stub body call an **undefined extern symbol**, so a
surviving call leaves an unresolved reference and the LINK fails at every
optimization level — was built and measured:

| stub | `-O0` | `-O2` |
| --- | --- | --- |
| live (called) | attribute fires | **Undefined symbols** (linker) |
| dead (uncalled) | links clean | links clean |

It worked, and the compiler self-build stayed green. **It was reverted because
it has a false-positive class.** An FTT stub whose **address is taken** survives
DCE with no call at all, so the unresolved reference fails the link for a stub
that never runs. Measured in the existing corpus: `tests/http` batch 102 installs
one as an exception handler —

```c
__yo_t16 _file____priv_temp_22275 = (__yo_t16){ .throw = fn_yo_id_17122 };
```

— and that batch passes today. The linker cannot distinguish "address stored in
a vtable" from "called", which is the same wall the original comment describes
for text scans.

## Fix

The stub now names itself on stderr before aborting:

```
yo: FATAL: reached fn_yo_id_7585, whose body failed to transpile - its
definition-time evaluation failed and was swallowed. Re-run `yo check` with
YO_DEBUG_SWALLOW=1 to see the original error.
```

No liveness judgement is required, so there are no false positives, and it works
at every optimization level. The `error` attribute is kept: at `-O0` it still
turns this into a compile-time error, which is strictly better than a runtime one.

## Regression test

`tests/cli-cases/ftt-stub-names-itself-before-aborting`. The fixture defines a
derive rule that splices a body naming something absent at the splice site — a
deterministic swallow that does not depend on any std bug — and builds at
**`Optimize.ReleaseSafe` (-O2)**, which is the point: at `-O0` the attribute
fails the C compile and the runtime path is never reached, so a Debug-built case
passes before *and* after the fix. Verified: the first cut of this case did
exactly that, and `build run` defaults to Debug.

Verified NO-GOLDEN (vacuous — the diagnostic never appears) on the pre-fix
compiler, PASS after.

## Still open

- The **address-taken live stub in `tests/http` batch 102** is a genuine
  swallowed exception-handler body that nothing reports today. It is now loud if
  reached, but it should not exist — filed as
  `issues/ftt-stub-installed-as-an-exception-handler-in-tests-http.md`.
- `yo check` still cannot see any of this: the marker is a codegen artifact and
  `check` never runs codegen. A `check`-visible signal would need the evaluator
  to record swallowed def-time body failures.
