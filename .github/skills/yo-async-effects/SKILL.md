---
name: yo-async-effects
description: Write Yo async code and algebraic effect handlers. Use this when working with IO, Future, JoinHandle, using/given, io.async, io.await, io.spawn, return, and escape.
argument-hint: "[async task, effect, or API]"
---

# Yo Async and Effects

Use this skill for single-threaded async workflows and algebraic-effect-based APIs in Yo.

If a repository wraps these primitives, keep the same semantics and verify whether the wrapper changes naming only or behavior too.

## When to use this skill

Use this skill when you need to:

- write functions with `using(io : IO)`
- return or consume `Future(...)` values
- run tasks with `io.async`, `io.await`, or `io.spawn`
- define or handle effects via `using(...)` and `given(...)`
- reason about `return` versus `escape` in handlers

## Workflow

1. Decide whether the task needs sequential async, concurrent async on one thread, or true parallelism.
2. Add the necessary `using(...)` parameters to function signatures and call sites.
3. Use the [async and effects recipes](./async-effects-recipes.md) for working patterns.
4. Re-check handler semantics before finalizing:
   - `return value` resumes the continuation
   - `escape expr` discards it

## High-signal rules

- `io.async(fn)` creates a lazy future; it does not start until awaited or spawned.
- `io.await(future)` runs or waits for the future and returns its result.
- `io.spawn(future)` starts it without waiting and returns `JoinHandle(T)`.
- `handle.await(using(io))` returns `Option(T)`; `.None` means the task aborted via `escape`.
- Future types include their effects: `Future(ResultType, IO, Effect...)`.
- Effects are matched by type, not variable name.
- `using(name : Type)` declares an implicit effect parameter; `given(name) := Type(...)` installs the handler.
- `return value` inside a handler resumes the continuation; `escape expr` discards it.
- `Exception` — non-resumable; handler calls `escape` to exit. `ResumableException(T)` — handler calls `return` to resume.
- Effect handlers are standalone, not closures; pass state explicitly.
- Yo async is single-threaded concurrency, not multithreaded parallelism.

## Resource

- [Yo async and effects recipes](./async-effects-recipes.md)
