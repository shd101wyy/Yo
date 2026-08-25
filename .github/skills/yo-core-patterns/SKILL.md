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

- `"` creates `str` in runtime code; template strings create `String`. In `comptime` functions, `"hello"` is `comptime_str` (distinct from `str`).
- Prefer template strings for constant `String` values.
- Prefer `print`/`println` from `std/fmt` over `printf`.
- `Option(T)` and `Result(T, E)` are the default nullable/error carriers.
- Use `rune` for Unicode code points, not `Char`.
- Model nullable pointers with `Option(*(T))` or `?(*(T))`.
- Use `struct` for value types, `newtype` for single-field wrappers, and `ref(struct(...))` / `ref(enum(...))` for reference-semantics (reference-counted) types — `atomic(ref(...))` for atomic RC. There is no `object` keyword.
- Use `generic` + `where` for generic impls; use `_` placeholder for partial application of comptime functions.
- Use `derive(Type, Eq, Hash, Clone, Ord, ToString, Default)` to auto-generate common trait impls. `Default` is structs-only (an enum has no canonical default variant).
- Custom error types implement `ToString` + `Error`; wrap with `dyn(...)` into `AnyError`.
- Use `(params) => expr` for closures. Two closure TYPES, and they differ at runtime: `Impl(Fn(...) -> T)` is monomorphized — capture struct passed by value, direct call, no allocation or refcount — while `Dyn(Fn(...) -> T)` is type-erased — capture heap-boxed behind a refcount header, called through a `{data, vtable}` fat pointer, and wrapped at the value with `dyn(...)`. `Impl(Fn(...))` is REJECTED as a struct/enum/union field type (its size is capture-dependent); use `Dyn(Fn(...))` there, or make the containing type generic over the closure type.
- Use `for(collection.iter(), (item) => { ... })` for iteration.
- Indexed modules import cleanly as `std/url`, `std/regex`, `std/http`, `std/log`, and `std/glob`; multi-module families use explicit submodules.

## Resource

- [Yo core patterns cheatsheet](./core-patterns-cheatsheet.md)
