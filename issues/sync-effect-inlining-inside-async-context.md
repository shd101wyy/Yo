# Sync Effect Inlining Inside Async Context — Design Flaw

**Status:** 🔴 OPEN  
**Date:** March 12, 2026  
**Severity:** Critical (blocks std/fs Exception migration)

## Problem

When a sync function with a module-type effect (e.g., `IOError.check` using `Exception`) is
called inside an `io.async` closure, the codegen cannot resolve the effect handler. Two
concrete failures arise:

### Failure 1: `throw` undeclared in generated C

`IOError.check(result, using(exn))` calls `exn.throw(error)`. In the sync codegen path, the
evaluator performs effect analysis on `IOError.check`'s body and treats it as an effectful
function. The SM resume function is generated with `throw` as a bare identifier:

```c
// Generated — WRONG: `throw` is not declared in this scope
int32_t fn_check_resume(fn_check_sm* sm) {
  ...
  int32_t result = ((int32_t (*)(yo_dyn))throw)(error);  // ← 'throw' undeclared!
  ...
}
```

In the **sync-only** case, this works because the caller site inlines the handler body via
the SM's while loop, and `throw` is the handler function pointer available at the call site.
But inside an `io.async` closure, the `throw` handler is stored as a `void*` function pointer
in the async Future's `__capture` struct. The sync SM codegen has no way to access it.

### Failure 2: `Impl(Future)` unresolved SomeType crash

Some delegation wrappers (e.g., `write_file_cstr` → `write_file`) are collected for codegen
but never directly called. Their `Impl(Future)` return type's SomeType is never resolved to a
concrete state machine type, causing a crash in `generateFunctionDeclarations`:

```
error: Impl(Future) type has no registered concrete type. SomeType ID: sometype_yo010df0a0_id_142
```

## Root Cause Analysis

### The fundamental design tension

Yo has **two codegen strategies** for algebraic effects:

| Strategy                   | Used for                                        | How handler is provided                                                                                                             |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Inline SM** (sync)       | `using(exn : Exception)` in sync functions      | Handler body is **inlined** at call site via while loop. The SM `yield`s, the caller's while-loop runs the handler, then `resume`s. |
| **Capture struct** (async) | `using(exn : Exception)` in `io.async` closures | Handler function pointer is stored in the Future's `__capture` struct. Called via `sm->__capture.throw(...)`.                       |

The problem: when a **sync effectful function** (`IOError.check`) is called **inside** an
async closure, the sync SM codegen tries to inline the handler, but the handler is only
available as a runtime function pointer in the async capture. The sync SM has no mechanism to
receive or access that function pointer.

### Why direct `exn.throw(...)` works but `IOError.check(result)` doesn't

When `exn.throw(error)` is written **directly** in the `io.async` body, it compiles to:

```c
((int32_t (*)(yo_dyn))sm->__capture.throw)(error);
```

This works because the async SM knows about `__capture.throw`. But `IOError.check` is a
**separate function** that gets its own SM — and that SM doesn't have access to
`__capture.throw`.

## Design Options

### Option A: Evidence Passing (Koka-style) — Recommended

Pass effect handlers as explicit function pointer arguments to all functions that use them,
instead of inlining handler bodies at call sites.

**How it works:**

- `IOError.check(result, using(exn))` compiles to `fn_check(result, throw_fn_ptr)`
- The function body calls `throw_fn_ptr(error)` directly — no SM needed for the effect
- The SM transformation is only needed for `return`/`resume` semantics, not for `escape`-only
  handlers like `Exception.throw`

**Advantages:**

- Composable: works regardless of sync/async nesting depth
- Simpler codegen: fewer SM transformations
- Koka uses exactly this approach and achieves excellent performance
- Compatible with `Dyn(Future(...))` since function pointers are runtime values

**Disadvantages:**

- Slightly more function arguments in generated C
- Need to distinguish "tail-resumptive" effects (can be optimized to direct calls) from
  general effects (still need SM for resume)

### Option B: `setjmp`/`longjmp` for Exception.throw

Use `setjmp` at handler installation, `longjmp` when `throw` is called.

**Advantages:**

- Simple implementation for non-resumable effects
- Works naturally across sync/async boundaries

**Disadvantages:**

- ~5-15ns overhead per `setjmp`/`longjmp` pair vs ~1-2ns for function calls
- Prevents compiler optimizations within `setjmp` scope (no inlining, conservative register
  allocation)
- Does NOT work for resumable effects — would need the SM approach anyway
- Bypasses RC cleanup (need explicit drop before `longjmp`)
- Current AGENTS.md explicitly says "No setjmp/longjmp for state machine generation"
- Poor interaction with async SMs: `longjmp` cannot cross async suspension points

### Option C: Remove `escape` entirely

Make all effects resumable-only; Exception.throw always resumes.

**Why this doesn't work:**

- `escape` is the mechanism that implements non-resumable exception semantics
- `throw` with `forall(ResumeType : Type)` + `escape` is what lets handlers exit the
  enclosing function without returning a value of `ResumeType`
- Without `escape`, every `throw` handler must `return` a value — but there's no meaningful
  value to return on error
- All existing algebraic effect tests rely on `escape` for control flow
- The `Exception` effect definition would be fundamentally broken

## Other Languages with Effect Handlers

| Language    | Approach                                   | Details                                                                                                                                                                                    |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Koka**    | Evidence passing + CPS                     | Compiles to C. Uses evidence passing: handlers are passed as hidden arguments. Tail-resumptive operations optimize to direct calls. Non-tail-resumptive uses yield/CPS. No setjmp/longjmp. |
| **OCaml 5** | Segmented stacks + delimited continuations | Runtime allocates/manages stack segments. `perform` captures stack from effect site to handler. Efficient for shallow handlers.                                                            |
| **Eff**     | CPS transformation                         | OCaml-based. Full CPS when continuations needed.                                                                                                                                           |
| **Ante**    | Evidence passing                           | Inspired by Koka's approach                                                                                                                                                                |

### Key Insight from Koka

Koka's "Generalized Evidence Passing" (ICFP 2021, Ningning Xie & Daan Leijen) shows that:

1. **Tail-resumptive operations** (the common case — handler resumes immediately) can be
   compiled as simple indirect function calls through an evidence vector. No SM needed.
2. **Non-tail-resumptive operations** (handler does work before resuming) need yield/CPS.
3. **Non-resumable operations** (`escape` in Yo) are the simplest — just a function call
   that never returns to the call site.

`Exception.throw` with `escape` is a **non-resumable operation**. It doesn't need an SM at
all — it just needs a function pointer that, when called, performs cleanup and jumps to the
handler's enclosing scope.

## Recommended Approach: Evidence Passing for All Effects

Inspired by Koka's "Generalized Evidence Passing" (ICFP 2021, Ningning Xie & Daan Leijen).

### Core idea

Instead of inlining handler bodies at call sites (SM approach), pass effect handler function
pointers as explicit C parameters to all functions that declare `using(effect : EffectType)`.
The function body calls operations directly via these function pointers.

### Key principle: modules ≡ collections of functions

A module is a **compile-time** construct — just a named collection of functions. At runtime,
only function pointers exist. Therefore there is no distinction between module effects and
function effects in codegen.

`forall(...)`, `using(...)`, and modules are **compile-time only** — they are erased at
runtime. Evidence passing is how their runtime behavior is realized.

### Which effects use evidence passing?

**ALL** effects. The rule:

> Every implicit parameter whose type contains callable functions (module members or function
> types) is compiled to explicit C function pointer parameters.

Examples:

| Effect                  | Members                                                           | Evidence type        |
| ----------------------- | ----------------------------------------------------------------- | -------------------- |
| `Exception`             | `throw : (fn(forall(ResumeType), error: AnyError) -> ResumeType)` | `void (*)(AnyError)` |
| `ResumableException(T)` | `throw : (fn(error: AnyError) -> T)`                              | `T (*)(AnyError)`    |
| `Raise` (module)        | `raise : (fn(msg: String) -> i32)`                                | `i32 (*)(String)`    |
| Function-type effect    | e.g., `(fn(msg: String) -> i32)` directly                         | `i32 (*)(String)`    |
| User-defined modules    | Arbitrary members                                                 | Per-member fn ptr    |

### How it works for each case

**Non-resumable (escape-only) handlers:**

```c
// IOError.check with evidence passing:
int32_t fn_check(int32_t result, void (*throw)(yo_dyn)) {
  if (result >= 0) return result;
  yo_dyn err = make_io_error(0 - result);
  throw(err);           // Never returns — handler called escape()
  __builtin_unreachable();
}

// Call site in async SM:
int32_t fd = fn_check(result, (void (*)(yo_dyn))sm->__capture.throw);

// Call site in sync context:
int32_t fd = fn_check(result, (void (*)(yo_dyn))fn_my_throw_handler);
```

**Resumable handlers:**

```c
// Function with resumable exception:
int32_t fn_safe_divide(int32_t x, int32_t y, int32_t (*throw)(yo_dyn)) {
  if (y == 0) {
    int32_t resume_val = throw(make_error("div by zero"));  // Returns resume value
    return resume_val;
  }
  return x / y;
}
```

The handler function returns the resume value directly. If the handler escapes instead of
returning, the call never returns — the C code after the call is dead code. Both cases work
with the same generated code.

**Transitive calls (evidence forwarding):**

```c
// write_file calls IOError.check — forwards the throw pointer:
void write_file_resume(write_file_sm* sm) {
  ...
  int32_t fd = fn_check(result, (void (*)(yo_dyn))sm->__capture.throw);
  ...
}
```

**Function-type effects:**

```c
// Function with Raise effect:
int64_t fn_raise_const(int32_t (*raise)(yo_string, yo_string)) {
  int32_t result = raise(msg1, msg2);
  return (int64_t)(8 + result + 10);
}
```

### Why this is general

1. **Composable across sync/async boundaries**: function pointers are runtime values,
   available from any context (local handler, async captures, closure captures).
2. **Works with `Dyn(Future(...))`**: since evidence is just function pointers, they can be
   stored in any struct — no compile-time handler body needed.
3. **Supports both escape and return**: same generated C code handles both — if handler
   escapes, the flag is set and callers propagate; if handler returns, the return value is used.
4. **Unified model**: module effects and function-type effects compile identically — both
   become function pointer parameters. No separate codegen paths needed.
5. **Non-unit escape values**: supported via thread-local storage — escape values of any type
   can be propagated back to the handler installation site.

### When SM is still needed

The SM approach is still needed for **multi-yield resumable effects where the handler body
interleaves with the computation** (e.g., deep handlers that resume multiple times from
different yield points within the same function body). This is rare in practice; most effects
are tail-resumptive.

### Escape value semantics

With evidence passing, the handler is a separate C function called via pointer. When the
handler calls `escape value`, the escape value needs to be propagated back to the handler
installation site (`given`).

**How it works:**

- The handler sets `__yo_effect_escaped = 1` and stores the escape value in a thread-local
  (or a location accessible to the `given` scope), then returns a dummy value.
- Each transitive caller checks `__yo_effect_escaped` and propagates the escape (drops
  locals, returns a dummy).
- At the `given` scope, the escape value is retrieved and becomes the result of the
  enclosing expression.

**Non-unit escape values are supported.** For example:

```yo
result := {
  (given(raise_mod) : Raise) = Raise(
    raise : (msg) -> { escape i32(-1); }  // escape with non-unit value
  );
  safe_divide(10, 0)
};
// result is -1
```

**Mixed escape+return handlers** are also supported — a handler may `return` in one branch
and `escape` in another:

```yo
(given(raise_mod) : Raise) = Raise(
  raise : (msg) -> cond(
    (msg == `recoverable`) => return i32(0),  // resume with 0
    true => escape i32(-1)                    // escape with -1
  )
);
```

Both paths work correctly with evidence passing:

- **Return path**: the function pointer returns normally; the caller uses the resume value.
- **Escape path**: the function pointer sets `__yo_effect_escaped = 1` and returns a dummy.
  The caller checks the flag and propagates. The escape value is stored separately and
  retrieved at the `given` scope.

### Migration path

1. **Phase 1**: Evidence passing for all effects (module and function types alike).
   This fixes the immediate bug with effectful functions called inside `io.async`.
2. **Phase 2**: Non-unit escape value propagation via thread-local storage.
3. **Phase 3**: Keep SM only for deep multi-yield handlers (rare).

## Affected Files

- `src/codegen/functions/generation.ts` — `preRegisterEffectfulFunctions` module effect detection
- `src/codegen/exprs/other-fn-call.ts` — effect call site generation
- `src/codegen/effects/effect-state-machine.ts` — SM struct and resume generation
- `src/codegen/exprs/property-access.ts` — module field access in SM context
- `src/codegen/functions/declarations.ts` — function declaration generation
- `src/evaluator/calls/helper.ts` — effect analysis for module-type implicit params
- `std/error.yo` — Exception effect definition
- `std/sys/errors.yo` — IOError.check using Exception
- `std/fs/file.yo` — File operations using Exception

## Reproducer

```yo
open import "std/libc/stdio";
open import "std/string";
{ IOError } :: import "std/sys/errors";
{ Error, AnyError, Exception } :: import "std/error";
IO_file :: import "std/sys/file";
{ AT_FDCWD, O_WRONLY, O_CREAT, O_TRUNC, O_CLOEXEC } :: import "std/sys/constants";
open import "std/fmt";

my_write :: (fn(using(io : IO, exn : Exception)) -> Impl(Future(i32, IO, Exception)))(
  io.async((using(io, exn)) => {
    flags := ((O_WRONLY | O_CREAT) | (O_TRUNC | O_CLOEXEC));
    result := io.await(IO_file.openat(AT_FDCWD, *(u8)("/tmp/test.txt"), flags, i32(420)));
    fd := IOError.check(result);  // ← FAILS: check's SM can't access throw
    fd
  })
);

main :: (fn(using(io : IO)) -> unit) {
  given(exn) := Exception(throw : ((err) -> {
    println(`Error: ${err}`);
    escape ();
  }));
  fd := io.await(my_write(using(io, exn)));
  printf("fd = %d\n", fd);
};
export main;
```

**Direct `exn.throw(...)` works** — the issue is only with calling functions that internally
use `exn.throw(...)`.
