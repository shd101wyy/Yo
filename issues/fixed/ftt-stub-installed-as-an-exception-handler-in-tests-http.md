# A swallowed exception-handler body ships as an FTT stub in the tests/http batch

**Status:** FIXED 2026-09-08
**Found:** 2026-09-07, by the undefined-symbol experiment in
`issues/fixed/ftt-stub-error-attribute-does-not-fire-at-O2.md`

## What

`tests/http` batch 102 emits a failed-to-transpile stub whose ADDRESS is
installed as an exception `throw` handler:

```c
__attribute__((error("yo: the body of fn_yo_id_17122 failed to transpile …")))
static inline void* fn_yo_id_17122(__yo_t71 err);
...
__yo_t16 _file____priv_temp_22275 = (__yo_t16){ .throw = fn_yo_id_17122 };
```

So some `throw : (err -> …)` handler body in the http tests fails
definition-time evaluation, the failure is swallowed, and the handler is wired
up as an `abort()`. The batch passes because nothing throws through it — but if
anything ever does, it aborts instead of handling.

This is the same shape as the already-fixed
`issues/fixed/resumable-exception-bare-return-handler-body-aborts.md`, which was
a bare `err -> return(v)` handler evaluating `return` as an identifier.

## How to find the real error

```
YO_DEBUG_SWALLOW=1 yo test ./tests/http --parallel 1 2>&1 | grep -E "anon-swallow|anon-trial"
```

The `[anon-swallow]` line carries the eaten error; the `[anon-trial]` line above
it carries the source position of the handler body.

## Why it is not urgent

The stub is not reached today, and as of the fix above it announces itself
loudly if it ever is. But a handler that aborts is not a handler, and the
swallow is hiding a real evaluation failure in a supported source form.

## Fix

`tests/http/http_limits.test.yo` used `println` in its no-egress fallback
handlers but never imported `std/fmt`. The handler bodies therefore failed
definition-time evaluation with `E0401: Variable "println" not found`, were
swallowed, and shipped as `abort()` stubs.

The irony is the point: those handlers exist **precisely to skip the test when
there is no network**, so the one path written for a hostile environment would
have aborted the run instead of skipping. Nothing reported it because a
swallowed handler body is exactly the silence
`issues/fixed/ftt-stub-error-attribute-does-not-fire-at-O2.md` describes.

Added the missing import. Verified: `YO_DEBUG_SWALLOW=1` count for
`Variable "println" not found` goes 1 → 0, and the file passes 5/5.

Scanned the whole `tests/` tree for the same class — every other file that calls
`println` does import `std/fmt`. This was the only one.
