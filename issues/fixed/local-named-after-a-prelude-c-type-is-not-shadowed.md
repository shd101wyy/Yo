# A local named after a prelude C-interop type (`long`, `short`, `uint`, …) is not shadowed — the TYPE wins

**Status:** FIXED 2026-09-08
**Found:** 2026-09-08, writing `ArrayList.starts_with` tests (a local named `long`)

## Symptom

```rust
{ ArrayList } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  long := ArrayList(i32).new();
  long.push(i32(1));          // ← error: No matching call found with arguments: (long.push)(i32(1))
});
export(main);
```

The local binding is ignored and `long` resolves to the prelude's C-interop TYPE
(`std/prelude.yo:5313`, `impl(long, Send())`), so the method lookup runs against
the type instead of the `ArrayList` value.

## Isolation

| local name | result |
| --- | --- |
| `long` | **fails** — type wins |
| `short` | **fails** |
| `uint` | **fails** |
| `notatype` | OK — the local shadows normally |

So ordinary locals shadow correctly; only names that collide with a prelude type
do not. The affected set is the C interop vocabulary listed at
`std/prelude.yo:862`: `char/int/uint/short/ushort/long/ulong/longlong/…`.

Note `int`, `char` and `short` are plausible variable names in ordinary user
code — this is not an exotic collision.

## Why it matters

The diagnostic points at the METHOD (`No matching call found ... (long.push)`),
not at the shadowing, so it reads as "ArrayList has no push" — which sends the
reader to the wrong file entirely. It cost a wrong-turn here even knowing the
codebase.

## Root cause

NOT the method-dispatch path. Every use fails, not just method calls:

| shape | before the fix |
| --- | --- |
| `long := i32(5); long + i32(1)` | `No matching call found for operator "+" with receiver type "Type"` |
| `long := i32(5); f(long)` | `Cannot unify incompatible types` |
| `(long : i32) = i32(5)` | same operator error |
| `long := ArrayList(...); long.push(...)` | `No matching call found` |

`evaluate_identifier_and_operator` (`src/evaluator/exprs/identifer_and_operator.yo`)
resolves builtin type names from a hard-coded table and **returns early, before
any environment lookup**. The binding is therefore never consulted for those
names — `is_static` in `calls/function.yo:344` is merely downstream of the
identifier already having evaluated to a `TypeVal`.

## Fix

Consult the env first for the C interop vocabulary — `int`, `char`, `uint`,
`long`, `void`, `short`, `ulong`, `ushort`, `longlong`, `ulonglong`,
`longdouble` — and fall through to the normal lookup when a binding of that name
is in scope.

Deliberately scoped to those names only. Yo's own spellings (`i32`, `str`,
`bool`, `usize`, `Type`, …) keep resolving as types unconditionally: nobody
names a local `i32`, and `bool` in particular is ALSO re-exported by the prelude
as a name (`export(bool : _boolean)`), so consulting the env for it would change
what an existing binding resolves to.

Verified both directions: `long`/`short`/`uint`/`int`/`char`/`void` locals now
shadow, and `long` still names the C type in a signature in the same program.

## Regression tests

`tests/basic.test.yo` — one test shadowing five of the names, one calling
`(fn(v : long) -> long)` with `long(3)` to pin that the type still resolves
where nothing shadows it.
