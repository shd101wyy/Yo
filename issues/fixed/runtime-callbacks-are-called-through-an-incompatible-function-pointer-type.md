# Runtime callbacks are called through an incompatible function-pointer type (UB)

**Status: FIXED 2026-09-28** (found 2026-09-23 by the UBSan acceptance run,
`plans/SAFE_MODE.md` §14 R6). Ruling: option 1, fix it. Promise A excludes
this UB, and the fix costs no machine code. Branch `safe-mode/callback-thunks`.

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

## Resolution

Every callback is now defined with the exact type it is called through. Where
the stored slot's type is the right one, the `(void(*)(void*))` cast is gone,
so a future mismatch is a C compile error (clang rejects an incompatible
function-pointer initializer by default) rather than silent UB. Six sites, all
found by running tests under `YO_TEST_SANITIZE=undefined`:

1. **RC dispose (cycle GC).** A `___dispose` method takes its typed `self`.
   The struct and enum constructors now store a per-function
   `static inline void __yo_dispose_thunk_<fn>(void* ptr) { <fn>(ptr); }`
   (`dispose_fn_thunk`, `src/codegen/functions/constructors.yo`), emitted once
   before the first constructor that uses it. The typed function is unchanged
   for every direct caller. The lightweight-RC path already dispatched through
   a well-typed `switch`.
2. **Async state-machine resume.** It was defined as `void X_resume(T* sm)` but
   stored in `__yo_resume_fn`, `continuation_fn` and the task queue as
   `void (*)(void*)`. It now takes `void* sm_ptr` and casts inside, like the
   dispose functions (`src/codegen/async/state_machine.yo`,
   `src/codegen/exprs/async.yo`).
3. **Dyn method wrappers.** A Future-returning method's wrapper returned the
   impl's concrete future type, while its vtable slot returns the Future
   interface pointer. The wrapper is now defined with the slot's own signature
   (the trait member type) and casts to and from the impl's types inside. Both
   vtable initializers are uncast (`src/codegen/functions/dyn.yo`).
4. **Function-typed parameters under effect polymorphism.** For
   `f : fn(e : E) -> T` with `E` a spread generic, the call-site cast was spelled
   from the body's ExprInfo, where `E` is an unresolved SomeT. That gave
   `int (*)(void*)`, while the C parameter is `int (*f)(int (*)(T))`. When the
   callee is a parameter of the function being emitted, the cast is now spelled
   by `generate_function_prototype` from the specialization's own signature,
   which is exactly how the parameter was declared
   (`_callee_param_fn_type`, `src/codegen/exprs/other_fn_call.yo`).
5. **Sys callbacks** (signal handlers, poll and fs-event callbacks). The Yo
   callback types lower to `uint8_t*` / `int32_t` parameters, but the runtime
   slots were typed `void*` / `const char*` / `int`. The slots now use the Yo
   lowering (`runtime_io_common.yo`, `runtime_io_windows.yo`). These are
   reachable only from `AllowUnsafe` files, since `*u8` is pragma-gated, but a
   UBSan leg over the test suite exercises them.
6. **No-op casts removed.** The async SM dispose, sync-future dispose, Iso
   dispose and SM resume stores already had the slot's type, so their casts
   went. The C compiler now enforces those signatures.

## Verification

- Probe (`Node :: ref(struct(name : String, next : Option(Self)))`, cycle GC):
  v0.2.45 seed under `--sanitize undefined` aborts at the first release
  (rc 134); the fixed compiler runs it clean (rc 0).
- `YO_TEST_SANITIZE=undefined yo test` over `rc`, `cycle_collector`,
  `async_await`, `dyn`, `iso`, `cross_thread_wake`, `algebraic_effects`,
  `closure`, `thread`, `spawn_blocking`, `arc`, `atomic_object` and
  `async_mutex`: 9 of 13 files failed under the seed, one UBSan abort per RC
  test. With the fixed compiler, every file passes.
- `tests/internal/gc_runtime_atomics.test.yo` pins the thunk's shape and its
  once-per-function emission.
- `.github/workflows/ubsan.yml` (D6) runs the whole language suite under UBSan
  weekly and on dispatch, with a vacuity probe proving that the UBSan runtime
  fires.
