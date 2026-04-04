# Timer future dispose_fn C compilation error on Linux

**Status:** Fixed (commit c12678ab)

## Problem

When `needsCycleGC` is false, `__yo_ref_header_t` uses a `uint16_t type_id` field instead of `void (*dispose_fn)(void*)`. The Linux timer future runtime code (`runtime-io-common.ts`) unconditionally set `future->header.dispose_fn = __yo_timer_future_dispose;`, which doesn't exist in the lightweight header struct.

This caused a C compilation error on Linux:

```
error: no member named 'dispose_fn' in 'struct __yo_ref_header_t'
```

macOS and Windows were unaffected because their timer implementations don't use this code path.

## Root Cause

Commit `b27b1739` ("type-tag dispatch replaces dispose_fn pointers") changed `__yo_ref_header_t` to use `type_id` instead of `dispose_fn` when `needsCycleGC` is false. User async state machines already handled both paths correctly, but the runtime-internal timer future code was not updated.

## Fix

- Added `AsyncRuntimeOptions` interface in `runtime.ts` with `needsCycleGC` and `registerDisposeTypeId` callback
- Passed options through `generateAsyncRuntime` → `generateAsyncRuntimeIOCommon`
- Timer future initialization now conditionally emits:
  - `needsCycleGC=true`: `future->header.dispose_fn = __yo_timer_future_dispose;`
  - `needsCycleGC=false`: `future->header.type_id = N;` (registered via `registerDisposeTypeId`)

## Files Changed

- `src/codegen/async/runtime.ts` — Added `AsyncRuntimeOptions` interface
- `src/codegen/async/runtime-io-common.ts` — Conditional dispose init for timer future
- `src/codegen/functions/generation.ts` — Pass options at call site
- `src/codegen/async/runtime-io-linux.ts` — Updated stale comments
