# Runtime callbacks are called through an incompatible function-pointer type (UB)

**Status: OPEN, needs a design decision** (found 2026-09-23 by the UBSan
acceptance run, `plans/SAFE_MODE.md` §14 R6).

## Symptom

With the RC-prefix finding fixed
(`issues/fixed/small-rc-header-accessed-through-the-full-header-type.md`), a
self-built compiler compiled with `--sanitize undefined` aborts 1.7 s into
`yo check ./src`:

```
yo-ubsan2.c:50078:9: runtime error: call to function yo_id_15643719862252612803000300
through pointer to incorrect function type 'void (*)(void *)'
SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior yo-ubsan2.c:50078:9
```

Line 50078 is `header->dispose_fn(ptr)` in `__yo_decr_rc`.

## Root cause

Every RC constructor stores its typed dispose function behind a cast:

```c
static inline void yo_id_1564…(__yo_t_1460…* self);          // the definition's type
obj->header.dispose_fn = (void(*)(void*))yo_id_1564…;        // the stored type
```

The runtime then calls it as `void (*)(void*)`. C11 6.3.2.3p8 lets a function
pointer be *converted* to another function-pointer type and back, but
*calling* through an incompatible type is undefined behavior. clang ≥ 17
checks this for C under `-fsanitize=function`, which is part of
`-fsanitize=undefined`.

The pattern is pervasive. The compiler's own emitted C has 4,910
`(void(*)(void*))` casts. The same shape covers `traverse_fn`, the async
state-machine dispose/resume callbacks, and the I/O-runtime continuations.
Among `src/codegen`, the cast sites are in `types/generation.yo`,
`functions/constructors.yo`, `exprs/async.yo`, `exprs/async_completion.yo`,
`async/state_machine.yo`, `async/runtime_io_common.yo`, and
`async/runtime_io_windows.yo` (17 template sites).

On every ABI Yo targets, a pointer parameter is passed identically
regardless of its pointee type, so no miscompile has been observed. It is
still UB that safe mode's Promise A claims to exclude.

## Options

1. **Fix it.** Emit every callback with the exact stored signature
   (`void f(void* self_)`) and cast inside the body
   (`T* self = (T*)self_;`). Direct callers passing `T*` keep compiling,
   since the conversion to `void*` is implicit. Prototype and definition must
   come from one helper
   (`.github/instructions/c-codegen.instructions.md`). The perf cost is none
   (the same machine code), but it touches every dispose/traverse/async
   callback emitter.
2. **Accept and document.** Record it as an implementation-level reliance
   on the platform ABI, as `-fwrapv` was before Phase 3. Keep
   `-fno-sanitize=function` in the acceptance run.

Until this is decided, the UBSan acceptance sweep runs with
`--cflags '-fno-sanitize=function'` so it can reach the arithmetic and
indexing classes Appendix A names.
