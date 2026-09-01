# TLS runtime emission was gated behind `uses_async` — a sync `tls_available()` probe emitted an undeclared call

**Status: FIXED 2026-09-01**, in the same PR that introduced the TLS runtime
backend (caught revalidating that branch after its rebase onto post-#373
develop, before it ever landed).

## What

The first version of the per-target TLS backend emitted
`generate_tls_runtime` from inside `generate_async_runtime`
(`src/codegen/async/runtime.yo`), which itself only runs under
`if(context.uses_async)` (`src/codegen/functions/generation.yo`). A program
whose ONLY TLS touch is the synchronous `tls_available()` probe has
`uses_async == false`, so the `__yo_tls_available` definition was never
emitted while the call to it was:

```
tmp/tlsuse.c:1562: error: call to undeclared function '__yo_tls_available'
```

The nesting also skipped wasm entirely (`generate_tls_runtime` sat inside the
`!(is_target_wasm)` branch), so a wasm program calling any `__yo_tls_` extern
would have hit the same undeclared-function error.

## Fix

- Hoist the emission to `generate_all_functions`' runtime section as a
  sibling of the parallelism runtime: `if(get_uses_tls(),
  generate_tls_runtime(...))` — independent of `uses_async`.
- Target selection moved fully into the emitted C's preprocessor guard:
  `#if !defined(_WIN32) && !defined(__wasm__)` picks OpenSSL; Windows AND
  wasm get the ABI stubs (`__yo_tls_available` → 0) from the same emission.

## Pin

`tests/crypto/tls_available_sync.test.yo` — a test file with zero async
usage anywhere in its batch (the runner inlines all of a file's test bodies
into one `__yo_user_main`, so one async-using test in the file would mask the
gate). It runs on Windows deliberately: the stub answering `false` is the
contract there.

## Lesson

A "mirrors `g_uses_parallelism`" flag must also mirror WHERE the twin is
read: the parallelism runtime is emitted at the `generate_all_functions`
level, not inside the async runtime. The verification gap was that every
manual gating check exercised TLS through `std/http` (async by construction)
— the sync-probe shape was never compiled.
