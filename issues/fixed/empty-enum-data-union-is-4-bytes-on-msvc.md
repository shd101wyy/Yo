# An enum with no non-unit variant field laid out 8 bytes on the MSVC ABI against a model of 4

**Status: FIXED 2026-09-06** (PR #437, `generate_enum_declaration`).

**Severity: heap under-allocation on Windows, pre-existing.** Latent since the
tagged-union emitter erased `unit` variant fields; surfaced while measuring
empty-aggregate layouts for the zero-sized-`unit` work.

## What the emitter produced

An enum whose variants carry only `unit` (or nothing) — `enum(A(u : unit), B)`,
`Option(unit)`, `Result(unit, unit)` — is not "simple-enum optimizable", so it
went through the tagged-union path, whose data union had no members:

```c
typedef union {
} T_data;
struct T_struct { T_tag tag; T_data data; };
```

## What the C compiler laid out

`clang -Xclang -fdump-record-layouts`, same source, per target:

| target | `union { }` | `struct { int tag; union { } data; }` |
| --- | --- | --- |
| x86_64-linux-gnu, aarch64-macos, x86_64-windows-gnu | 0 | **4** |
| x86_64-windows-msvc, aarch64-windows-msvc | **4**, align 1 | **8** |

The layout model (`get_size_of_type`'s `.EnumT` arm) sizes the payload over the
non-unit variant fields — none — and reports tag-only: **4**. On the MSVC ABI
the object is 8. `sizeof` folds to a C literal that sizes `malloc(n * sizeof(T))`
while the C stride is 8, so every `ArrayList` / `HashMap` slot of such an enum on
Windows wrote past its allocation. GNU targets agreed with the model, which is
why nothing was ever seen on macOS or Linux CI.

## Fix

When no variant has a non-unit field, emit **no data union and no `data`
member**: the enum is its tag, 4 bytes on every target, and the model already
said so. Construction and matching never touched `.data` for these enums
(`any_field` is false on both paths), so nothing else moves.

## Regression test

`tests/unit_as_value_type.test.yo` — *an ArrayList of a unit-payload enum and of
Option(unit) round-trips every element*: 64 elements each of
`enum(A(u : unit), B)` and `Option(unit)` pushed and read back with a pattern
that a stride mismatch scrambles. Its `sizeof` pins hold the tag-only size.

## Lesson

**Never assume an empty C aggregate has size 0.** It is a GNU behaviour, not a C
guarantee, and the MSVC ABI — which the Windows runners compile for — gives both
an empty struct and an empty union 4 bytes. The same measurement made the
zero-sized-`unit` design use a one-byte dummy for member-less aggregates
(`issues/fixed/unit-should-be-a-true-zero-sized-type-like-rust.md`).
