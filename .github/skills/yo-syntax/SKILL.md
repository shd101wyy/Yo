---
name: yo-syntax
description: Write and repair Yo source code. Use this when authoring, reviewing, or debugging .yo files, especially around declarations, begin blocks, cond/match, imports, recursion, function calls, and parser-facing errors.
argument-hint: "[task, file, or error]"
---

# Yo Syntax

Use this skill for source-level Yo authoring. It focuses on portable Yo syntax rules that apply across repositories.

If the repository adds stricter local conventions, follow those after the baseline rules in this skill.

## When to use this skill

Use this skill when you need to:

- write new `.yo` files
- fix parse errors or syntax-shaped type errors
- review whether Yo code uses the correct expression form
- choose between begin blocks, imports, pattern matching, or recursion forms

## Workflow

1. Read the target code and decide whether the problem is declarations, control flow, imports, calls, or pattern matching.
2. Apply the rules in the [syntax cheatsheet](./syntax-cheatsheet.md) before editing.
3. Prefer the simplest expression form that fits Yo parsing rules.
4. Re-check the common traps below before finishing.

## High-signal rules

- `cond(...)` and `match(...)` always require parentheses.
- `{ expr }` is a struct literal; `{ expr; }` is a begin block.
- Yo has no operator precedence. Parenthesize every binary operation.
- Use `func(arg)` with no space before `(` for normal calls.
- Use `recur(...)` for self-recursion instead of the function name.
- Use `forall(T : Type)` for generic type parameters, `comptime(x) : T` for compile-time parameters.
- Use `where(T <: Trait)` to constrain type parameters.
- Use `using(name : Type)` for implicit/effect parameters and `given(name) := Type(...)` to install handlers.
- Use `(params) => expr` for closures; `Impl(Fn(...) -> T)` for the closure type.
- Every executable needs `export main;`.
- Import sibling modules with relative paths like `./file.yo`.
- Do not import `std/prelude`; it is loaded automatically.
- Use `snake_case` for names, `PascalCase` for types/traits, 2-space indentation.

## Common traps

- `return expr1, expr2` is parsed as one call; use a begin block or return an expression directly.
- Nested patterns like `.Ok(.Some(x))` are not supported; match in stages.
- Unary operators need parenthesized operands: `!(ready)`.
- `while true` is compile-time. Use `while runtime(true), { ... }` for infinite runtime loops.
- A single-expression lambda body should not be wrapped in `{ ... }` unless semicolons make it a begin block.
- `"hello"` is `comptime_string` inside `comptime` functions, not `str`. In runtime code, `"hello"` is always `str`.
- Functions called without `()` in match/cond branches consume trailing commas. Always add `()` or use begin blocks.

## Resource

- [Yo syntax cheatsheet](./syntax-cheatsheet.md)
