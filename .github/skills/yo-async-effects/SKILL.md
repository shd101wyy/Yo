---
name: yo-async-effects
description: Write Yo async code and algebraic effect handlers. Use this when working with Io, Future, JoinHandle, ctl/fn handlers, io.async, io.await, io.spawn, return, and unwind.
argument-hint: "[async task, effect, or API]"
---

# Yo Async and Effects

Use this skill for single-threaded async workflows and algebraic-effect-based APIs in Yo.

If a repository wraps these primitives, keep the same semantics and verify whether the wrapper changes naming only or behavior too.

## When to use this skill

Use this skill when you need to:

- write functions that take an `io : Io` parameter
- return or consume `Future(...)` values
- run tasks with `io.async`, `io.await`, or `io.spawn`
- define handlers using `ctl(args) -> R` and install them as plain local bindings
- reason about `return` versus `unwind` in handlers

## Workflow

1. Decide whether the task needs sequential async, concurrent async on one thread, or true parallelism.
2. Add the effect parameters (`io : Io`, `raise : Raise`, …) to function signatures and call sites. There is no implicit injection — pass them explicitly.
3. Use the [async and effects recipes](./async-effects-recipes.md) for working patterns.
4. Re-check handler semantics before finalizing:
   - `return(value)` resumes the continuation
   - `unwind(expr)` discards it (only valid inside a `ctl(...) -> R` body)

## High-signal rules

- `io.async(fn)` creates a lazy future; it does not start until awaited or spawned.
- `io.await(future, e)` runs or waits for the future and returns its result. `e` is the effect bundle the future expects.
- `io.spawn(future, e)` starts it without waiting and returns `JoinHandle(T)`.
- `handle.await(io)` returns `Option(T)`; `.None` means the task aborted via `unwind`.
- Future types are `Future(T)` or `Future(T, E)` where `E` is a single effect bundle (typically a struct). Pack multiple effects into one struct rather than passing them as separate type arguments.
- Effects are passed as explicit parameters — pass them by name at call sites.
- A handler whose body may `unwind` must be typed `ctl(args) -> R`; otherwise type it `fn(args) -> R`. Subtyping is one-way: `fn(T) -> R <: ctl(T) -> R`.
- `return(value)` inside a handler resumes the continuation; `unwind(expr)` discards it and exits the install frame.
- `Exception` — non-resumable; handler calls `unwind(...)` to exit. `ResumableException(T)` — handler calls `return(...)` to resume.
- Closures cannot be `ctl` and cannot capture `ctl` values. Handlers are bare (non-capturing) anonymous functions.
- Yo async is single-threaded concurrency, not multithreaded parallelism.

## Resource

- [Yo async and effects recipes](./async-effects-recipes.md)
