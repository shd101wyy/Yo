---
applyTo: "src/**/codegen/**"
description: "Use when working on C code generation, the codegen transpiler, emitting C code, or fixing C output bugs. Covers C11 standard compliance, emitter patterns, and debugging strategy."
---

# C Codegen Conventions

- Stick with **C11 standard**. Do not use GNU extensions — we target multiple C compilers.
- No `setjmp`/`longjmp` for state machine generation (async/await).
- Do not call `emitter.emitLine` multiple times when you can use `emitter.emitLine(multi-line string)`.

## Async/await threading model

Each OS thread has its own **single-threaded event loop**. Within a single thread, async I/O submissions and completions are processed cooperatively — no concurrent access from multiple threads within one event loop. Worker threads from the parallelism runtime (`src/codegen/parallelism/`) share a thread pool; multiple workers may sit on the same OS thread and share that thread's event loop.

**Platform implementations:**

- **Linux**: `io_uring` — per-thread event loop submits SQEs and processes CQEs
- **macOS**: `kqueue` — per-thread event loop registers interest via `kevent()` and polls for completions. Regular file I/O uses synchronous `pread`/`pwrite` (fast on macOS with unified buffer cache); pipes and sockets use non-blocking I/O with `EVFILT_READ`/`EVFILT_WRITE` readiness notifications.
- **Windows**: IOCP — per-thread `GetQueuedCompletionStatus` with `NumberOfConcurrentThreads = 1`

**Implications for runtime code:**

- Do **not** add mutexes, atomics, or other synchronization to async runtime variables (e.g., `__yo_pending_io_count`, timer lists, future state). They are `_Thread_local` and only accessed from their owning thread's event loop.
- All per-thread event loop state must be declared `_Thread_local` (or `__declspec(thread)` on Windows): `__yo_pending_io_count`, `__yo_active_watch_count`, `__yo_io_initialized`, `__yo_async_scheduler_initialized`, the I/O backend handle (`__yo_io_ring`, `__yo_io_kq`, `__yo_io_iocp`), and linked lists like `__yo_active_fs_events`, `__yo_active_polls`, `__yo_win_timer_head`.
- Process-global state (signal handlers, WSA init, TTY/console settings, umask) stays `static` — it is shared across all threads.
- The **parallelism** runtime (`src/codegen/parallelism/`) is a separate concern with actual multi-threading — do not confuse it with async/await.

## Compilation commands

- Emit C only: `./yo-cli compile src/tests/fixme.yo --emit-c --skip-c-compiler --release`
- Compile with clang: `clang -std=c11 -Wall -Wextra a.out.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -o ./a.out`
- Add `-luring` on Linux for async IO features.
- On Windows, use `zig` instead of `clang`.
- Full pipeline: `./yo-cli compile src/tests/fixme.yo --release -o a.out && ./a.out`

## Memory allocator options

- `--allocator mimalloc` (default) — high-performance allocation
- `--allocator libc` — standard libc malloc (faster compilation, useful for debugging)

## Memory leak detection

- `--sanitize address` — AddressSanitizer for memory error and leak detection
- `--sanitize leak` — LeakSanitizer for leak detection only
- Example: `./yo-cli compile src/tests/fixme.yo --release --sanitize address --allocator libc -o test && ./test`

## Debug flags

- `--debug-gc` — debug garbage collector and reference counting
- `--debug-parallelism` — debug parallel worker threads
- `--debug-async-await` — debug async/await

## Debugging strategy

If a C codegen bug is very hard to debug from TypeScript, modify the generated C code directly to make it work, document the bugs found, then go back to fix the TypeScript codegen.

When you find a test that causes a C codegen bug, don't weaken the test. Create a new `.yo` file with minimal reproduction code, a `main` function, and `export(main);` at the end.

## Reference counting

The `begin.ts` performs reference counting optimization that cancels out dup/drop pairs when possible.

For understanding the compile-time RC ownership model, read `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`.

## Index trait codegen

Array/Slice indexing through the Index trait uses compiler builtins that are inlined at call sites.

### generateIndexTraitCall (in `src/codegen/exprs/generation.ts`)

This function generates C code for `value(arg)` dispatched through the Index trait:

- For builtins (`__yo_array_index`, `__yo_slice_index`): inlines `(&((&value)->data[idx]))` directly
- For range builtins: creates compound literal `*(Slice(T))` with computed data pointer and length
- For non-builtin methods (ArrayList, HashMap, etc.): generates a named function call
- Auto-dereferences the pointer result unless wrapped in `&()` (checked via `isIndexTraitAddressOf`)

### ptr-fns.ts address-of optimization

`&(arr(i))` where `arr(i)` uses Index trait dispatch skips the auto-deref. The `ptr-fns.ts` `generateAddressOf` function detects `isIndexTraitAddressOf` and inlines the builtin directly, producing `(&((&arr)->data[i]))` without the outer `*` deref.

### Why Index methods use inline expansion

Index methods backed by builtins (e.g., `__yo_array_index`) are detected by `isFunctionValueWithOnlyBuiltinYoInlineFunctionCall`. The codegen skips generating standalone C function definitions for these. Instead, `generateIndexTraitCall` inlines the expansion at each call site. This avoids issues where the skip logic would also affect other specialized impl methods like `clone`.

## Algebraic effects codegen

- Functions with `forall(...(E))` spread effect parameters have generic bodies where sub-expression type info may be missing. Effect analysis for these functions is performed during the codegen phase (in `preRegisterEffectfulFunctions`), not during evaluation.

### Evidence passing for effects

**All** effects — both struct-record (e.g., `Exception`, `Raise`) and function-type — use **evidence passing**. A struct effect record is an evidence record; at runtime, its function fields are passed as function pointers. Therefore there is no distinction between struct-record effects and function effects in codegen — both compile to passing function pointers as explicit C parameters.

`forall(...)` remains compile-time-only, while `using(...)`/`given(...)` resolve statically and pass runtime evidence. Evidence passing is how that runtime behavior is realized.

For the full design document with overhead analysis and language semantics, see `docs/en-US/ALGEBRAIC_EFFECTS.md`.

**How it works:**

- A function with `using(exn : Exception)` gets an extra C parameter: `void (*throw)(AnyError)`
- A function with `using(raise_mod : Raise)` where `Raise :: struct(raise : (fn(msg: String) -> i32))` gets: `int32_t (*raise)(__yo_string)`
- The function body calls the effect operation directly via the function pointer — no SM needed
- Call sites pass the function pointer from their context:
  - Sync: the handler function address from `given(exn) := Exception(throw: handler_fn)`
  - Async SM: `sm->__capture.throw` from the Future's capture struct
  - Transitive: forwarded from the caller's own evidence parameter

**Why this is needed:**

- SM-inlining works for sync-only contexts (handler body is inlined at call site)
- But inside `io.async` closures, handler values become runtime function pointers in the capture struct
- A sync effectful function called inside async can't access those captures via the SM mechanism
- Evidence passing is composable across sync/async boundaries because function pointers are runtime values

See `issues/sync-effect-inlining-inside-async-context.md` for the full design rationale.

**Forall function-type effects (e.g., `Raise :: fn(forall(T), msg: String) -> T`):**

- Bare function-type effect handlers from `given` bindings are marked `isModuleEffectMember = true` in the evaluator (`initialization-assignment.ts`). This historical flag means "effect member function" and ensures their C function body is generated despite having forall parameters (the forall types are erased at runtime).
- The evaluator includes forall function effects in async closure capture structs (`isEffectParamInAsyncClosure` in `anonymous-function.ts`). They are stored as `void*` and cast at each call site.
- Effect injection at `io.await`/`io.spawn` writes the handler function pointer into the future's capture struct for both struct-record and forall function-type effects (`emitEffectInjectionForAwait` in `await.ts`).

**Mixed escape+return handlers:**

- A handler may `return` in one branch and `escape` in another. Both paths work with evidence passing:
  - Return path: handler function returns normally; caller uses the resume value
  - Escape path: handler sets `__yo_effect_escaped = 1` and returns a dummy; caller checks the flag and propagates
- Non-unit `escape(value)` is supported — the escape value is stored in a thread-local and retrieved at the handler installation site.

### Escape detection in sync_fut_t resume functions

When a sync_fut_t (lightweight future without await points) has evidence parameters, its resume function checks `__yo_effect_escaped` after calling the closure:

```c
void resume(void* ptr) {
  sync_fut_t* sm = (sync_fut_t*)ptr;
  sm->result = closure(&sm->__capture, ...evidence_args...);
  if (__yo_effect_escaped) {
    __yo_effect_escaped = 0;
    sm->state = -2;  // Aborted
    __yo_decr_rc(ptr); // Event loop reference — matches full SM behavior
    return;
  }
  sm->state = -1;    // Completed
  // ... continuation + __yo_decr_rc(ptr)
}
```

**Event loop RC convention:** ALL futures (both sync_fut_t and full SM) self-decrement the event loop reference on BOTH completion AND escape. The synchronous await abort path (`await.ts`) does NOT decrement — this prevents double-free/UAF. The awaiter's pending deferred drops handle the ownership reference for locally-owned futures.

### When SM is still needed

The SM approach is still needed for **multi-yield resumable effects** where the handler body interleaves with the computation (e.g., deep handlers that resume multiple times from different yield points within the same function body). This is rare in practice; most effects are tail-resumptive.

### Thread-local escape flag

Because effect handlers are called via function pointer (evidence passing), the codegen cannot statically detect whether the handler calls `escape()`. A thread-local flag `__yo_effect_escaped` is used for runtime detection:

1. Before calling an effect handler via function pointer, the flag is reset to 0.
2. If the handler calls `escape()`, the flag is set to 1 (in `generateEscape`, gated by `isModuleEffectMemberFunction`).
3. After the call returns, the caller checks the flag. If set, it drops any RC-typed arguments and propagates the escape:
   - In async SM: aborts the Future (state = -2), spawns the continuation, self-decrements event loop RC, returns.
   - In sync_fut_t resume: sets state = -2 (aborted), self-decrements event loop RC, returns.
   - In sync context (evidence passing): drops locals, returns a dummy value. Each caller in the transitive chain checks the flag and propagates.

The `__yo_effect_escaped` and `__yo_effect_escape_value` variables are declared via `emitDeclarationLine` (in the declaration section of the C output) so they are available to sync_fut_t resume functions which are also emitted in the declaration section.

Key files: `context.ts` (`isModuleEffectMemberFunction`), `generation.ts` (declaration + context flag), `exprs/generation.ts` (flag set in `generateEscape`), `other-fn-call.ts` (flag check + abort at call site), `async.ts` (escape check in sync_fut_t resume).

### Function collection for evidence-bearing functions

Functions with evidence parameters (from `using(io: IO)` or algebraic effect bindings) need special handling in `collection.ts`. Three skip conditions must allow these functions through:

1. **`isFunctionTypeHardGeneric` check** — A specialized function may still appear "hard-generic" because the implicit params are compile-time-only. If `getEvidenceParameters(specializedType).length > 0`, the function is valid for codegen — evidence params become C function pointers.

2. **`exprContainsUnknownValue` check** — Functions with implicit params may have `UnknownValue` in their body for compile-time parameter references. Check both original and specialized types: if either has evidence parameters, the function is valid.

3. **SomeType ARC function filter** — `___drop`/`___dup` for SomeType(Future) are skipped because SomeType has no C representation. But user-defined functions (e.g., `test_escape(task: Impl(Future(...)))`) with evidence params should NOT be skipped — their SomeType params are resolved at call sites.

### Await escape value handling: handler installation vs propagation

When an `io.await` detects a Future abort (state == -2), the behavior depends on whether the current function is the **handler installation point** or a **propagation point**:

- **Handler installation** — The function has a `given(raise) := ...` binding that locally installs the effect handler. When escaped, it clears `__yo_effect_escaped = 0`, extracts the escape value from `__yo_effect_escape_value` via `memcpy`, and returns it.

- **Propagation** — The function receives the effect via evidence parameters (`using`). When escaped, it re-sets `__yo_effect_escaped = 1` and returns a dummy value `(ReturnType){0}` so the caller can detect and handle the escape.

The helper `isAwaitEscapeHandlerInstallation()` in `await.ts` determines this by checking if ANY algebraic effect in the Future is NOT in the current function's `currentEvidenceParams`. If an effect's key is missing from evidence params, it must be locally installed via `given`.

### Effect member return types

Handler functions marked `isModuleEffectMember = true` with SomeType return types (e.g., `Raise :: fn(forall(T), ...) -> T`) use `void` as their C return type consistently in both forward declarations AND definitions. The flag name is legacy; read it as "effect member function":

- **Declaration** (`declarations.ts`): passes `undefined` for body → no body-type override → `getTypeString(SomeType)` → `void`
- **Definition** (`generation.ts`): skips SomeType body override when `isModuleEffectMember` is true

This consistency prevents type mismatches between forward declarations and definitions. The escape value is communicated through `__yo_effect_escape_value` (thread-local), not through the C return value.

The `overrideReturnTypeStr` field on `FunctionGenerationContext` stores the actual C return type derived from the body, used by `generateEscape` to emit correct dummy return values when the SomeType-based return maps to `void` but the declaration uses a concrete type.

### Evidence function pointer casts must use void for forall handlers

When calling an evidence handler through a function pointer cast in `generateEvidenceFnPtrCall`, the cast return type **must** match the handler's actual C return type. For forall handlers (e.g., `Exception.throw :: fn(forall(T), error: AnyError) -> T`), the C return type is `void` (SomeType → void). Using the call-site concrete type (e.g., `JsonValue`) creates an ABI mismatch — **undefined behavior** in C11 that crashes on WASM (`RuntimeError: unreachable`) and corrupts the stack on native.

The `handlerReturnsVoid` flag in `generateEvidenceFnPtrCall` handles this: declares a zero-initialized temp var, calls the handler as void, checks `__yo_effect_escaped`, and propagates escape. See `issues/evidence-fn-ptr-void-return-abi-mismatch.md`.

### Handler functions are standalone, not closures

Effect handler functions (both struct-record and fn-type) are compiled as standalone C functions via evidence passing. They are **not closures** and cannot reference variables from the enclosing scope — no closure/capture struct is generated. This is **by design**.

If a handler needs state, pass it as explicit arguments to the effect functions, or allocate a `Box` outside the handler and pass its address.

See `docs/en-US/ALGEBRAIC_EFFECTS.md` (§ Handler Functions Are Not Closures) for details.

## JoinHandle(T) codegen

`JoinHandle(T)` is a builtin generic type returned by `io.spawn`. Key codegen files: `generation.ts` (spawn), `await.ts` (`generateJoinHandleAwait`).

### io.spawn codegen

`io.spawn(task, using(io, effects...))` generates:

1. Store the future pointer in a local variable
2. Check abort state (panic if already aborted)
3. Inject effect handler function pointers into the future's capture struct via `emitEffectInjection`
4. Cold-start via `__yo_resume_fn` (with incr_rc for execution reference)
5. Return a `JoinHandle` struct wrapping the future pointer (non-owning, no extra RC)

### emitEffectInjection

`emitEffectInjection` resolves effect handler function pointers and injects them into the spawned future's capture struct. Resolution order for each effect:

**Struct-record effects (e.g., IO):** For each function field in the struct evidence record:

1. SM capture variables (`sm->__capture.<field>`)
2. Struct value fields (concrete `StructValue` from evaluator)
3. Caller's evidence params (`currentEvidenceParams` map)
4. Given bindings in the call environment

**Function effects (e.g., Raise):** Including forall function effects:

1. Caller's evidence params
2. SM capture variables
3. Using arg's function value (from evaluator)
4. Fallback: `generateExpr(usingArg)`

**Important:** Forall function-type effects (e.g., `Raise :: fn(forall(T), ...) -> T`) are NOT skipped. They are runtime function pointers passed as `void*` in evidence passing.

### JoinHandle.await codegen

`handle.await(using(io))` generates (`generateJoinHandleAwait` in `await.ts`):

1. Extract `void*` future pointer from handle's `__future` field
2. Cast to inline header struct to read `state` and `result` fields
3. Poll loop: `while (state != -1 && state != -2) { __yo_async_poll_step(); }`
4. On completion (state == -1): return `Option(T).Some(result)`
5. On abort (state == -2): clear `__yo_effect_escaped`, return `Option(T).None`

The inline header struct assumes the standard state machine layout:

```c
struct { __yo_ref_header_t header; int state; T result; void (*continuation_fn)(void*); void* continuation_sm; void (*__yo_resume_fn)(void*); };
```

For `Option(unit)` return types, the `.Some` variant has no data field — only the tag is set.
