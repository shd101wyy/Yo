---
applyTo: "src/**/codegen/**,src/**/codegen/**"
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

- Emit C only: `yo compile tmp/fixme.yo --emit-c --skip-c-compiler --release`
- Compile with clang: `clang -std=c11 -Wall -Wextra a.out.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -o ./a.out`
- Add `-luring` on Linux for async Io features.
- On Windows, use `zig` instead of `clang`.
- Full pipeline: `yo compile tmp/fixme.yo --release -o a.out && ./a.out`

`yo` is the self-hosted compiler binary from a release bundle, on `PATH`. The old
`./yo-cli` bash shim and the TypeScript compiler it drove are gone; `tmp/fixme.yo`
(gitignored) replaces the old `src/tests/fixme.yo` scratch file.

## Memory allocator options

- `--allocator mimalloc` (default) — high-performance allocation
- `--allocator system` — the platform system allocator (default; `libc` is a deprecated alias)

## Memory leak detection

- `--sanitize address` — AddressSanitizer for memory error and leak detection
- `--sanitize leak` — LeakSanitizer for leak detection only
- Example: `yo compile tmp/fixme.yo --release --sanitize address --allocator system -o test && ./test`

## Debug flags

- `--debug-gc` — debug garbage collector and reference counting
- `--debug-parallelism` — debug parallel worker threads
- `--debug-async-await` — debug async/await

## Debugging strategy

If a C codegen bug is very hard to debug from the emitter source, modify the generated C code directly to make it work, document the bugs found, then go back to fix the emitter in `src/codegen/`.

When you find a test that causes a C codegen bug, don't weaken the test. Create a new `.yo` file with minimal reproduction code, a `main` function, and `export(main);` at the end.

## Reference counting

`src/evaluator/exprs/begin.yo` performs reference counting optimization that cancels out dup/drop pairs when possible.

For understanding the compile-time RC ownership model, read `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`.

## Index trait codegen

Array/Slice indexing through the Index trait uses compiler builtins that are inlined at call sites.

### `_generate_index_trait_call` (in `src/codegen/exprs/generation.yo`)

This function generates C code for `value(arg)` dispatched through the Index trait:

- For builtins (`__yo_array_index`, `__yo_slice_index`): inlines `(&((&value)->data[idx]))` directly
- Range indexing dispatches to `slice_copy` methods (owned copies; plans/archive/SLICE_REWORK.md) — the old `*(Slice(T))` compound-literal builtins are deleted
- For non-builtin methods (ArrayList, HashMap, etc.): generates a named function call
- Auto-dereferences the pointer result unless wrapped in `&()` (checked via the `ExprInfo.is_index_trait_address_of` flag)

### `ptr_fns.yo` address-of optimization

`&(arr(i))` where `arr(i)` uses Index trait dispatch skips the auto-deref. `generate_address_of` in `src/codegen/exprs/ptr_fns.yo` detects `is_index_trait_address_of` and inlines the builtin directly, producing `(&((&arr)->data[i]))` without the outer `*` deref.

### Why Index methods use inline expansion

Index methods backed by builtins (e.g., `__yo_array_index`) are detected by `is_function_value_with_only_builtin_yo_inline_function_call` (`src/codegen/utils/index.yo`). The codegen skips generating standalone C function definitions for these. Instead, `_generate_index_trait_call` inlines the expansion at each call site. This avoids issues where the skip logic would also affect other specialized impl methods like `clone`.

## Algebraic effects codegen

> **Reading this section.** The load-bearing part is the **emitted C contract**
> — `__yo_effect_escaped`, evidence records lowered to function pointers, the
> `sync_fut_t` resume shape. The source pointers below name files in
> `src/codegen/exprs/{await,async,other_fn_call,return,cond,generation}.yo`
> and `src/codegen/functions/{collection,declarations,generation,context}.yo`.
> A few mechanisms here originated in the retired TypeScript compiler and have no
> same-named counterpart; those are called out where they appear. When a name
> does not resolve, grep the emitted C string (e.g. `__yo_effect_escaped`)
> instead of the identifier.

- Functions with `generic(E : Type.Struct)` polymorphic over an effect bundle have generic bodies where sub-expression type info may be missing. The TypeScript compiler ran a codegen-phase effect pre-pass (`preRegisterEffectfulFunctions`) for them. **The self-hosted compiler has no such pass** — `ExprInfo.effect_analysis` is never written in a self-emit (see the rare-field note in `src/expr_info.yo`), so its readers in `codegen/functions/collection.yo` and `codegen/functions/declarations.yo` always see `.None`, and effect codegen is driven instead by the evidence parameters collected at declaration time (`collect_evidence_from_record` / `get_evidence_parameters` in `src/codegen/functions/declarations.yo`).

### Evidence passing for effects

**All** effects — both struct-record (e.g., `Exception`, `Raise`) and function-type — use **evidence passing**. A struct effect record is an evidence record; at runtime, its function fields are passed as function pointers. Therefore there is no distinction between struct-record effects and function effects in codegen — both compile to passing function pointers as explicit C parameters.

`generic(...)` remains compile-time-only. Effect parameters are explicit `fn`/`ctl` parameters at the language level; codegen lowers them to function-pointer C parameters. Evidence passing is how that runtime behavior is realized.

For the full design document with overhead analysis and language semantics, see `docs/en-US/ALGEBRAIC_EFFECTS.md`.

**How it works:**

- A function with `exn : Exception` gets an extra C parameter: `void (*throw)(AnyError)`
- A function with `raise_mod : Raise` where `Raise :: struct(raise : (fn(msg: String) -> i32))` gets: `int32_t (*raise)(__yo_string)`
- The function body calls the effect operation directly via the function pointer — no SM needed
- Call sites pass the function pointer from their context:
  - Sync: the handler function address from `exn := Exception(throw: handler_fn)` (or `(exn : Exception) = Exception(...)` when the LHS needs the annotation)
  - Async SM: `sm->__capture.throw` from the Future's capture struct
  - Transitive: forwarded from the caller's own evidence parameter

**Why this is needed:**

- SM-inlining works for sync-only contexts (handler body is inlined at call site)
- But inside `io.async` closures, handler values become runtime function pointers in the capture struct
- A sync effectful function called inside async can't access those captures via the SM mechanism
- Evidence passing is composable across sync/async boundaries because function pointers are runtime values

See `issues/sync-effect-inlining-inside-async-context.md` for the full design rationale.

**Forall function-type effects (e.g., `Raise :: ctl(generic(T), msg: String) -> T`):**

- Bare function-type effect handlers from local `(raise : Raise) = ((msg) -> { ... })` bindings are marked as effect-record members in the evaluator (`src/evaluator/exprs/initialization_assignment.yo`; the predicate is `is_effect_record_member` in `src/function_value.yo`). This historical flag means "effect member function" and ensures their C function body is generated despite having generic parameters (the generic types are erased at runtime).
- The evaluator includes generic function effects in async closure capture structs (`src/evaluator/values/anonymous_function.yo`). They are stored as `void*` and cast at each call site.
- Effect injection at `io.await`/`io.spawn` writes the handler function pointer into the future's capture struct for both struct-record and generic function-type effects (`emit_effect_injection_for_await` in `src/codegen/exprs/await.yo`).

**Mixed unwind+return handlers:**

- A handler may `return` in one branch and `unwind` in another. Both paths work with evidence passing:
  - Return path: handler function returns normally; caller uses the resume value
  - Escape path: handler sets `__yo_effect_escaped = 1` and returns a dummy; caller checks the flag and propagates
- Non-unit `unwind(value)` is supported — the unwind value is stored in a thread-local and retrieved at the handler installation site.

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

**Event loop RC convention:** ALL futures (both sync_fut_t and full SM) self-decrement the event loop reference on BOTH completion AND unwind. The synchronous await abort path (`src/codegen/exprs/await.yo`) does NOT decrement — this prevents double-free/UAF. The awaiter's pending deferred drops handle the ownership reference for locally-owned futures.

### When SM is still needed

The SM approach is still needed for **multi-yield resumable effects** where the handler body interleaves with the computation (e.g., deep handlers that resume multiple times from different yield points within the same function body). This is rare in practice; most effects are tail-resumptive.

### Thread-local unwind flag

Because effect handlers are called via function pointer (evidence passing), the codegen cannot statically detect whether the handler calls `unwind()`. A thread-local flag `__yo_effect_escaped` is used for runtime detection:

1. Before calling an effect handler via function pointer, the flag is reset to 0.
2. If the handler calls `unwind()`, the flag is set to 1 (in `generate_unwind`, gated by the context flag `is_effect_record_member_function`).
3. After the call returns, the caller checks the flag. If set, it drops any RC-typed arguments and propagates the unwind:
   - In async SM: aborts the Future (state = -2), spawns the continuation, self-decrements event loop RC, returns.
   - In sync_fut_t resume: sets state = -2 (aborted), self-decrements event loop RC, returns.
   - In sync context (evidence passing): drops locals, returns a dummy value. Each caller in the transitive chain checks the flag and propagates.

The `__yo_effect_escaped` and `__yo_unwind_value` variables are declared via the emitter's `emit_declaration_line` (in the declaration section of the C output) so they are available to sync_fut_t resume functions which are also emitted in the declaration section.

Key files (all under `src/codegen/`): `functions/context.yo` (`is_effect_record_member_function`), `functions/generation.yo` (declaration + context flag), `exprs/return.yo` (flag set in `generate_unwind`), `exprs/other_fn_call.yo` (flag check + abort at call site), `exprs/async.yo` (unwind check in sync_fut_t resume).

### Function collection for evidence-bearing functions

Functions with evidence parameters (from `io: Io` or algebraic effect parameters) need special handling in `src/codegen/functions/collection.yo`. Three skip conditions must allow these functions through:

1. **`is_function_type_hard_generic` check** — A specialized function may still appear "hard-generic" because evidence params trace back to a comptime-only `generic(...)` binding. If `get_evidence_parameters(specialized_type).len() > 0`, the function is valid for codegen — evidence params become C function pointers.

2. **`expr_contains_unknown_value` check** — Functions with effect params may have `UnknownVal` in their body for compile-time parameter references. Check both original and specialized types: if either has evidence parameters, the function is valid.

3. **SomeType ARC function filter** — `___drop`/`___dup` for SomeType(Future) are skipped because SomeType has no C representation. But user-defined functions (e.g., `test_escape(task: Impl(Future(...)))`) with evidence params should NOT be skipped — their SomeType params are resolved at call sites.

### Specialization entries vs the base generic

A specialization function value always has a specialized type set but inherits `value.type` from the original generic function value. So a specialization is "concrete at the C ABI" yet still answers `is_function_type_hard_generic(value.type) == true`. Without a carve-out, the hard-generic skip in `src/codegen/functions/declarations.yo` / `generation.yo` would drop both the base AND its specializations, leaving call sites that reference the specialized C name with no matching decl/def.

Use the predicate "has a specialized type AND no specialized-function caches" to exempt specializations from those skips. The pass that emits the specialized bodies must use `type_contains_some_type_for_codegen_param` (`src/evaluator/trait_checking.yo`), not the strict `type_contains_some_type`, when probing for "still-generic" parameters — struct fields whose type is a `Function` (effect-record handlers like `throw : ctl(generic(ResumeType), ...) -> ResumeType`) are type-erased fn pointers at the C ABI, so their inner generic does NOT make the outer struct still-generic for codegen.

### Effect-record handlers whose body uses `return(value)`

When a struct field declared as `throw : ctl(generic(ResumeType), ...) -> ResumeType` is bound to a lambda body like `(val, resume_val) -> { return(resume_val); }`, the lambda's body has its evaluation DEFERRED (`should_defer_body` in `src/evaluator/values/anonymous_function.yo`, `should_defer_ft` in `src/evaluator/calls/function_type.yo`) — its sub-expressions (including the `return`) never get their `ExprInfo` populated. The handler still needs a C function symbol because its address is stored as `void*` in the effect record's capture struct (via `emit_effect_record_injection` in `src/codegen/exprs/await.yo`).

The stub-emit gate in `src/codegen/functions/generation.yo` covers this: an `is_effect_record_member` function whose body contains an explicit `return(expr)` is emitted as a `__yo_effect_escaped = 1; return ZERO;` stub. The effect runtime resumes via `set_effect`, so the stub return value is never observed. Bodies that only `unwind(...)` keep their real bodies — they preserve observable side effects like `println(msg)` before `unwind(())`.

### `-> ref(T)` body and cond-arm lowering — OBSOLETE (v4)

**`-> ref(T)` returns are BANNED** (v4, `plans/archive/BORROW_EXCLUSIVITY.md`; rejected at function-type evaluation), so the lowering described below can no longer be reached from source. The machinery still exists in the codebase as dead code — do not build on it. Kept for the record:

Inside a `-> ref(T)` function, `src/evaluator/types/function.yo` lowers the body's expected type to `*(T)` so cross-arm unification, the return-type compatibility check, and downstream synth all agree on a single pointer-typed shape. Two downstream pieces need to know about this lowering:

- **Call-return synth in `try_to_call_function_with_arguments`** (`src/evaluator/calls/helper.yo`) — when the callee is `-> ref(T)`, its return type is the raw `T` while the surrounding expected type is `*(T)`. Lift the return type to a `Ptr` _only_ when the expected is itself a `Ptr` AND the return type isn't already a `Ptr`. The "already a Ptr" guard avoids double-wrapping a generic `T` that was pre-resolved upstream (e.g. `values.project(...)` in std/encoding/json's `Index.index` with `T = JsonValue` resolved to `*(JsonValue)`).
- **Cond arm typecheck** — in `src/evaluator/exprs/cond.yo`, accept an arm whose type is the underlying `T` against an expected `*(T)` (PtrRelaxedMatch). Flowability still owns soundness — the arm must root back to a ref-bound parameter via R1–R4.
- **Cond arm codegen** — in `src/codegen/exprs/cond.yo`, the cond's temp var is declared as `T*` (the lowered place shape). Arm bodies whose type is the raw `T` must have their assignment to the temp wrapped in `&(...)` so the C-level lvalue types agree. The `_maybe_address_of` helper handles this when the current function returns `ref` and the cond value type is a `Ptr`.

### Await unwind value handling: handler installation vs propagation

When an `io.await` detects a Future abort (state == -2), the behavior depends on whether the current function is the **handler installation point** or a **propagation point**:

- **Handler installation** — The function has a local `(raise : Raise) = ((msg) -> { ... })` binding that installs the effect handler. When escaped, it clears `__yo_effect_escaped = 0`, extracts the unwind value from `__yo_unwind_value` via `memcpy`, and returns it.

- **Propagation** — The function receives the effect via an evidence parameter (e.g. `raise : Raise` in its own signature). When escaped, it re-sets `__yo_effect_escaped = 1` and returns a dummy value `(ReturnType){0}` so the caller can detect and handle the unwind.

The helper `is_await_unwind_handler_installation` in `src/codegen/exprs/await.yo` determines this by checking if ANY algebraic effect in the Future is NOT in the current function's evidence params. If an effect's key is missing from evidence params, it must be locally installed.

### Effect member return types

Handler functions flagged as effect-record members with SomeType return types (e.g., `Raise :: (fn(generic(T), ...) -> T)`) use `void` as their C return type consistently in both forward declarations AND definitions:

- **Declaration** (`src/codegen/functions/declarations.yo`): passes no body → no body-type override → the type string for SomeType → `void`
- **Definition** (`src/codegen/functions/generation.yo`): skips the SomeType body override when `is_effect_record_member` is true

This consistency prevents type mismatches between forward declarations and definitions. The unwind value is communicated through `__yo_unwind_value` (thread-local), not through the C return value.

The `override_return_type_str` field on `FunctionGenerationContext` (`src/codegen/functions/context.yo`) stores the actual C return type derived from the body, used by `generate_unwind` to emit correct dummy return values when the SomeType-based return maps to `void` but the declaration uses a concrete type.

### Evidence function pointer casts must use void for generic handlers

When calling an evidence handler through a function pointer cast (the evidence call-site path in `src/codegen/exprs/other_fn_call.yo`), the cast return type **must** match the handler's actual C return type. For generic handlers (e.g., `Exception.throw :: (fn(generic(T), error: AnyError) -> T)`), the C return type is `void` (SomeType → void). Using the call-site concrete type (e.g., `JsonValue`) creates an ABI mismatch — **undefined behavior** in C11 that crashes on WASM (`RuntimeError: unreachable`) and corrupts the stack on native.

The "handler returns void" branch handles this: it declares a zero-initialized temp var, calls the handler as void, checks `__yo_effect_escaped`, and propagates unwind. See `issues/evidence-fn-ptr-void-return-abi-mismatch.md`.

### Handler functions are standalone, not closures

Effect handler functions (both struct-record and fn-type) are compiled as standalone C functions via evidence passing. They are **not closures** and cannot reference variables from the enclosing scope — no closure/capture struct is generated. This is **by design**.

If a handler needs state, pass it as explicit arguments to the effect functions, or allocate a `Box` outside the handler and pass its address.

See `docs/en-US/ALGEBRAIC_EFFECTS.md` (§ Handler Functions Are Not Closures) for details.

## JoinHandle(T) codegen

`JoinHandle(T)` is a builtin generic type returned by `io.spawn`. Key codegen files: `src/codegen/exprs/generation.yo` (spawn), `src/codegen/exprs/await.yo` (`generate_join_handle_await`).

### io.spawn codegen

`io.spawn(task, ctx)` (where `ctx` is the task's effect bundle) generates:

1. Store the future pointer in a local variable
2. Check abort state (panic if already aborted)
3. Inject effect handler function pointers into the future's capture struct via `emit_io_spawn_effect_injection`
4. Cold-start via `__yo_resume_fn` (with incr_rc for execution reference)
5. Return a `JoinHandle` struct wrapping the future pointer (non-owning, no extra RC)

### `emit_io_spawn_effect_injection`

`emit_io_spawn_effect_injection` (`src/codegen/exprs/await.yo`; the `io.await` sibling is `emit_effect_injection_for_await`) resolves effect handler function pointers and injects them into the spawned future's capture struct. Resolution order for each effect:

**Struct-record effects (e.g., Io):** For each function field in the struct evidence record:

1. SM capture variables (`sm->__capture.<field>`)
2. Struct value fields (concrete struct value from evaluator)
3. Caller's evidence params
4. Locally installed handler bindings in the call environment

**Function effects (e.g., Raise):** Including generic function effects:

1. Caller's evidence params
2. SM capture variables
3. The bound handler's function value (from evaluator)
4. Fallback: `generate_expr` on the handler argument

**Important:** Forall function-type effects (e.g., `Raise :: ctl(generic(T), ...) -> T`) are NOT skipped. They are runtime function pointers passed as `void*` in evidence passing.

### JoinHandle.await codegen

`handle.await(io)` generates (`generate_join_handle_await` in `src/codegen/exprs/await.yo`):

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

### Extern functions and `#include` emission

- The header for a `c_include`d symbol comes from extern-function REGISTRATION
  during codegen collection, not from module evaluation. `FuncMeta` has no
  `c_include` field — the header lives in an evaluator side-table keyed by
  extern symbol name (`src/evaluator/exprs/c_include.yo`,
  `get_c_include_for_extern`) and is looked up by `_register_extern_fn_callee`
  in `src/codegen/functions/collection.yo`.
- **A `c_include`/extern callee's expr-info VALUE is `Some(UnknownVal)`, not
  `None`.** Any collection logic that dispatches on the callee value must
  treat "value present but not a FuncVal" the same as "no value". Routing only
  the `.None` arm left `context.extern_functions` permanently empty until
  2026-08-10 — see
  `issues/fixed/yo-self-extern-c-include-never-registered.md`.
- Missing-header failures are MASKED for common headers: `emit_c_includes`
  hardcodes `<unistd.h>`/`<sys/stat.h>`/`<sys/random.h>` (POSIX) and
  `<windows.h>`/`<bcrypt.h>`/`<io.h>` (Windows), and the sys-runtime C
  templates carry their own includes. Test new `c_include` bindings with a
  header NOT in those sets by actually compiling a user of the symbol —
  `yo compile` all the way through the C compiler, not `--skip-c-compiler`.
- Platform-unique headers (e.g. `<mach-o/dyld.h>`) must be added to the
  target-filter sets in `src/codegen/c/collection.yo` (posix-only /
  windows-only / macos-only): a registered include can leak from a
  comptime-eliminated platform branch, and the collection walk sees those
  branches even though the target filter later drops them.
