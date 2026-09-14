# `Option(Dyn(Trait)).is_none()` emits a call to a function codegen never defines — the type key is computed two different ways

**Status:** OPEN.
**Found:** 2026-09-14, writing the regression test for
`issues/fixed/self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md`.
The two are unrelated defects — this one reproduces identically on the
**v0.2.32 seed**, which predates that fix, so it is pre-existing and was merely
reached for the first time by code that could finally hold an `Option(AnyError)`.
**Severity:** loud but misdirected — the C compiler blames the user's program
for an implicit function declaration, and `yo check` is green, so the error
points nowhere near the defect.
**Reproducer:** `issues/repros/option-of-a-trait-object-loses-its-inherent-methods.yo`

## Symptom

```rust
{ AnyError } :: import("std/error");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  (o : Option(AnyError)) = Option(AnyError).None;
  println(if(o.is_none(), "n", "s"));
});
export(main);
```

```
error: call to undeclared function
'yo_id_17497239930646507321000000_rtparam0_enum_r8058c2_n121_value_1500_ret_bool';
ISO C99 and later do not support implicit function declarations
```

`yo check` passes (`— evaluator OK`). The symbol appears **exactly once** in the
emitted `.c`, at the call site — no prototype, no body.

## What it is NOT

Measured, each as a separate compile:

| shape | result |
| --- | --- |
| `Option(i32).is_none()` | compiles |
| `Option(AnyError).is_some()` | **compiles** |
| `Option(AnyError).is_none()` | fails |
| a USER fn `match(o, .None => true, .Some(_) => false)` over `Option(AnyError)` | compiles |
| the same match written INLINE at the call site | compiles |
| `Option(Dyn(UserTrait)).is_none()` for a user-declared trait | fails |

So it is neither `is_none`'s arm order (a user function with the identical body
and the identical arm order is fine), nor trait objects in a `match` generally,
nor anything specific to `std/error` — it takes BOTH an inherent `Option(T)`
method from the prelude AND a trait-object payload.

`is_some` and `is_none` sit in the same `impl(generic(T : Type), Option(T), …)`
block in `std/prelude.yo` and differ only in arm order, which makes the pair the
sharpest available probe: one works, one does not.

## Root cause — the same type, two different keys

Compiling a program that calls BOTH, and reading the emitted symbols:

```
is_some  yo_id_5826137416192530736000000_rtparam0_enum_r8058c2_n216_value_dyn_trait_r32c9_n0_trait_r41c12_n0_ret_bool
         line  582  static inline bool …(…);      ← prototype
         line 1676  … = …(o);                     ← call
         line 1981  static inline bool …(…) { … } ← body

is_none  yo_id_17497239930646507321000000_rtparam0_enum_r8058c2_n121_value_1500_ret_bool
         line 1697  … = …(o);                     ← call, and nothing else
```

The mangled name carries the parameter's type key, and the two disagree about
the SAME argument:

- `is_some` spells it structurally — `value_dyn_trait_r32c9_n0_trait_r41c12_n0`,
  the `Dyn` with its trait components.
- `is_none` spells it `value_1500` — a bare id, the type left UNRESOLVED.

So this is not a missing-emission bug in the ordinary sense. The body almost
certainly IS registered, under the structural key; the call site mangles an
unresolved key and therefore names a function nobody emitted. Two paths compute
the key for one type and only one of them resolves the generic `T` of
`Option(T)` down to the concrete `Dyn`.

That makes it a member of the type-key family already recorded in this repo —
"era-diff via `type_key`, never the C comment", and "`SomeT` id equality is not
a shared `resolved_concrete` cell". The next step is to find the two key
computations and determine which one fails to resolve, rather than to add a
declaration for the missing symbol — a prototype for a body that does not exist
under that name would only move the failure to link time.

## Why it had not been seen

`Option(Dyn(Trait))` was close to unconstructible in practice: the only trait
object std hands back inside an `Option` is `Error.source()`'s, and until
2026-09-14 its result could not be held at `Option(AnyError)` at all
(`issues/fixed/self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md`).
Fixing that made the shape reachable, and the first `is_none()` written over it
hit this immediately.

## Workaround for callers (NOT a fix)

A `match` over the Option compiles. `tests/error_source_chain.test.yo` spells
its "no source" assertion that way deliberately, with a comment pointing here.
