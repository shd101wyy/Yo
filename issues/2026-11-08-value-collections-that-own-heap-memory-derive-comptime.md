# Value collections that own heap memory derive `Comptime`

**Severity:** S3 — a wrong answer from a trait query. `Type.impls(T, Comptime)`
and a `where(T <: Comptime)` bound accept `ArrayList`, `String`, `HashMap` and
`Box`, which hold run-time heap memory. That breaks the "no runtime storage"
invariant that `Comptime` stands for. No miscompilation was reached: CTFE still
refuses to build such a value, so this is latent.

**Status:** OPEN. Filed 2026-11-08 from the plans audit
(`plans/backlog/COMPTIME_METAPROGRAMMING_AUDIT.md` §1.1 predicted it).

## Reproduction

`issues/repros/2026-11-08-value-collections-derive-comptime.yo` prints
`Type.impls(X, Comptime)` for six types. Measured 2026-11-08 with the
develop-built `yo-r2h` binary (develop `8d475cd81`):

```
ArrayList(i32): true
String: true
HashMap(i32,i32): true
Box(i32): true
Rc(i32): false
i32: true
```

Only `Rc` is still excluded.

**A comptime-returning function that builds an `ArrayList` is rejected.** For
example, `make :: (fn(comptime(n) : i32) -> comptime(ArrayList(i32)))` fails
with "Function body is not evaluated correctly. Expected to return a
compile-time known value". So the wrong trait answer did not reach code
generation in this probe.

## Root cause

Until VBD, the `ref` flag was the only storage exclusion: the tag fast path's
`is_ref` arm and auto-derivation's `!is_reference_semantics` guard. B8–B9
(v0.2.74) made `ArrayList`, `String` and `HashMap` values. A value struct is
`Comptime` when every field is, and `*T` is `Comptime` when `T` is, so a
struct over `?*T` plus two integers now derives it.

## Fix

The audit's §1.1 suggests a rule. Either:
- a raw `*T` field that owns memory is not `Comptime`; or
- a type with a `Drop` impl never derives `Comptime`.

In both cases, `ComptimeList` and `Expr` keep explicit impls. The test is the
repro as a `tests/` file asserting `false` for the four heap-owning types. It
lands with COMPTIME_METAPROGRAMMING_AUDIT's C4 prerequisite (post-VBD plan,
phase P1).
