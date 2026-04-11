---
name: yo-core-patterns
description: Write everyday Yo application and library code. Use this when choosing Yo types, imports, strings, Option/Result, collections, traits, boxes, pointers, and standard-library modules.
argument-hint: "[feature, data type, or module]"
---

# Yo Core Patterns

Use this skill for normal Yo program structure and standard-library usage rather than compiler internals.

If a repository defines local wrappers or conventions, follow them after these baseline patterns.

## When to use this skill

Use this skill when you need to:

- pick between built-in types and standard-library types
- choose import paths for common Yo modules
- model optional values or recoverable errors
- write collection-heavy, string-heavy, or trait-based code
- handle boxes, pointers, and platform-specific branches

## Workflow

1. Identify whether the task is about data modeling, strings, containers, errors, or imports.
2. Choose the smallest built-in or standard-library type that fits the job.
3. Use the [core patterns cheatsheet](./core-patterns-cheatsheet.md) for imports, strings, `Option`/`Result`, traits, and collections.
4. Prefer standard modules before inventing custom helpers.

## High-signal rules

- `"` creates `str` in runtime code; template strings create `String`. In `comptime` functions, `"hello"` is `comptime_string` (distinct from `str`).
- Prefer template strings for constant `String` values.
- Prefer `print`/`println` from `std/fmt` over `printf`.
- `Option(T)` and `Result(T, E)` are the default nullable/error carriers.
- Use `rune` for Unicode code points, not `Char`.
- Model nullable pointers with `Option(*(T))` or `?*(T)`.
- Use `struct` for value types, `newtype` for single-field wrappers, `object` for reference-counted types.
- Use `forall` + `where` for generic impls; use `_` placeholder for partial application of comptime functions.
- Use `derive(Type, Eq, Hash, Clone, Ord, ToString)` to auto-generate common trait impls.
- Custom error types implement `ToString` + `Error`; wrap with `dyn(...)` into `AnyError`.
- Use `(params) => expr` for closures; `Impl(Fn(...) -> T)` for the closure type.
- Use `for collection.iter(), (item) => { ... }` for iteration.
- Indexed modules import cleanly as `std/url`, `std/regex`, `std/http`, `std/log`, and `std/glob`; multi-module families use explicit submodules.

## Resource

- [Yo core patterns cheatsheet](./core-patterns-cheatsheet.md)
