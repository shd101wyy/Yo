# `derive(Eq)` / `derive(Clone)` / `derive(Ord)` on a type with an `Array(T, N)` field passes `yo check`, links, and `abort()`s at runtime

**Status: FIXED 2026-09-05.** **Class**: crash — `yo check` said OK, `yo compile`
exited 0, and the binary died with SIGABRT (rc=134) and no diagnostic of any kind.

**Found**: 2026-09-04, measuring the `net` row of the std API audit. The row
asks for `Eq`/`Hash`/`Ord`/`Clone` on `IpAddr`, whose `V6` payload is
`Array(u16, usize(8))` (`std/net/addr.yo:31`), on the premise that these are
"a derive away". They were not.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));

My :: enum(V4(a : u8), V6(segments : Array(u16, usize(8))));
derive(My, Eq(My));

main :: (fn() -> unit)({
  s := Array(u16, usize(8)).fill(u16(0));
  s(usize(7)) = u16(1);
  x := My.V6(s);
  y := My.V6(s);
  unsafe(printf("before compare\n"));
  cond(
    (x == y) => { unsafe(printf("equal\n")); },
    true => { unsafe(printf("not equal\n")); }
  );
});
export(main);
```

Before (`yo 0.2.24`): `yo check` OK, `yo compile --optimize 2` rc=0, and

```
$ ./dea.out
before compare
$ echo $?
134
```

After: `before compare` / `equal`, rc=0. The same three lines were red for
`derive(My, Clone)` and for `derive(My, Ord(My))`.

## Root cause

Four defects stacked, three of them in the compiler and one in `std`. The
issue as filed named the first and the last; the middle two only became
visible once the length resolution stopped masking them.

**1. `Array(T, N)` had no `Eq` / `Ord` / `Clone` / `Hash` impl at all** —
`std/prelude.yo` gave it only `Send`, `Acyclic`, `Comptime` and `Runtime`. So
the derive rules generated a body that compared, cloned or ordered a field
whose type implemented none of it, the derive rule's definition-time trial
swallowed the error, and codegen turned the enclosing function into an
`abort()` stub whose `__attribute__((error))` guard is inert above `-O0`
(`issues/ftt-abort-stub-error-attribute-does-not-fire-above-optimize-0.md`).

**2. `substitute` could not resolve a const-generic array LENGTH.** A length
var is not a `SomeT`: `TypeValue.Array` stores it as the plain string
`length_var` (`src/types/definitions.yo:155`), so the name/level map could
never reach it — and neither could the `Self` binding, whose exact-pattern
test covers Struct/EnumT only. `impl(generic(T, N), Array(T, N), Eq(Self)(…))`
therefore specialized to a method whose parameters were still
`Array(u16, length = 0, length_var = "N")`, a type with no C rendering, which
`get_type_string` spells as the COMMENT `// Unknown type: Array(u16, N)` —
swallowing the rest of the emitted line. (Filed separately as
`array-const-generic-length-unresolved-in-the-operator-call-cast.md`; that is
this same root cause, seen from the `==` call site.)

**3. An array wrapper struct was emitted before its element type's
definition.** `Array(Point, 2)` / `Array(String, 2)` emitted
`typedef struct { __yo_t0 data[2]; } …;` while `__yo_t0` was still only
forward-declared — "array has incomplete element type". Pre-existing and
independent of the derives; filed as
`array-wrapper-struct-emitted-before-its-element-struct.md`.

**4. Two RC defects on `out := self` for an array-typed `inout(self)`
receiver** — the shape `Array(T, N).clone` needs:

- `emit_deferred_dup_or_code`'s declare-first step declared
  `T self = (*self);`, shadowing the C PARAMETER ("redefinition of 'self'
  with a different type"). A by-`ref` binding READS as `(*name)` while its
  recorded `variable_name` is the bare `name`, so the spellings-differ test
  fired. Invisible before defect 2 was fixed: the line rendered as the
  `// Unknown type:` comment and the function silently returned an
  UNINITIALIZED array.
- the ARRAY arm of `evaluate_initialization_assignment`'s emitter never
  emitted the RHS's deferred `___dup`, unlike every other binding shape. So
  the copy ALIASED the source's element handles while each `out(i) = …` still
  DROPPED the old one — the source array's strings were freed under it
  ("malloc returned None" at the next allocation).

## Fix

- `std/prelude.yo`: `Eq`, `Ord`, `Clone` and `Hash` impls for `Array(T, U)`,
  next to its `Send`/`Acyclic` markers — an element walk over `[0, U)` each. A
  fixed-size array is prefix-free by construction (its length is in its type),
  so `Hash` writes no length.
- `src/types/substitution.yo`: `Substitution` carries const-generic LENGTH
  bindings (`subst_add_len_var` / `subst_lookup_len_var`) and the `.Array` arm
  resolves `length_var` from them. `_without_len_vars` stops that resolution at
  a NOMINAL boundary (Struct / EnumT / TraitT): a nominal type's field types
  are part of its identity, `type_key` hashes them, and the ctfe instantiation
  memo canonicalizes by that key — rewriting `_ArrayIter(T, N)._arr` split one
  Yo struct id into two C typedefs and `into_iter` returned the wrong one.
- `src/evaluator/values/impl.yo`: `find_methods_from_generic_impls` registers
  each value binder's `IntLit` (from the match's `g_last_match_binding_vals`
  side channel) as a length binding before substituting the method type.
- `src/codegen/types/generation.yo`: array wrappers are released as their
  element types become available (`_drain_ready_array_wrappers`), and the
  dependency walk gained the missing `Array` edge so a struct with an
  `Array(T, N)` field is ordered after `T`.
- `src/codegen/exprs/drop_dup.yo` + `src/codegen/exprs/init_assignment.yo`:
  defect 4, both halves.

## Breaking change

No. Adding the `Array` impls is additive, and everything else turned a program
that miscompiled or aborted into one that works.

## Regression test

- `tests/derive.test.yo`: `Eq`/`Ord`/`Clone`/`Hash` derived over a struct with
  an `Array(i32, 4)` field, an `Array(Point, 2)` field, an
  `Array(Array(i32, 2), 2)` field, `Array(i32, 1)`, `Array(i32, 0)`, an
  `Array(String, 2)` field (the deep-clone independence case) and an ENUM
  whose variant carries `Array(u16, 8)` — the filed shape.
- `tests/array.test.yo`: `Eq` at two lengths in one file (two specializations
  of one impl), `Ord`, the `cmp` default, `Clone` independence for a value and
  for an owning element type, and a `HashMap(Array(u8, 4), i32)` insert +
  lookup — the only test that proves `Eq` and `Hash` agree.

## Still open

The issue's half (b) — making a swallowed derive-rule failure FATAL at the
derive site — is NOT part of this fix. It is the containment measure shared
with `issues/derive-ord-without-a-prior-derive-eq-kills-module-evaluation.md`
and `issues/bare-derive-form-kills-module-eval.md`, and it is what would have
turned this class of bug into a compile error rather than a runtime `abort()`
for a field type OTHER than `Array`.
