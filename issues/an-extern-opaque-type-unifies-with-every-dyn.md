# An `extern` opaque type unifies with every `Dyn(Trait)`

**Status:** OPEN
**Found:** 2026-09-16
**Repro:** `issues/repros/an-extern-opaque-type-unifies-with-every-dyn.yo`
**Supersedes:** `issues/arraylist-of-a-trait-object-cannot-be-indexed.md` (which
PR #706 renames to `a-generic-instantiated-over-a-dyn-cannot-cross-a-module-boundary.md`).
Same defect, same `_ptr.add` error, both found while writing `error_chain`. Both
of those titles are wrong: the failure is not about indexing, and not about
module boundaries — it is about whether some other module has already
instantiated `Option(*(<an extern opaque>))`. Retire that doc in favour of this
one once #706 and this change have both landed.

## Symptom

A pointer to a trait object is **silently accepted** where an `extern` opaque
type is expected, and — because the same predicate backs the CTFE
instantiation memo — `Option(*(Dyn(Trait)))` is handed the wrong instantiation
entirely. Downstream, `ArrayList(Dyn(Trait)).push` does not compile in any
module that reaches `std/libc/stdio`:

```
error: No matching call found with arguments:
(_ptr.add)((self._length))
    --> std/collections/array_list.yo:250:31
```

This is what blocks `error_chain` in `std/error.yo`, and it is why
`ArrayList(Dyn(ToString))` looked like "a generic instantiated over a `Dyn`
cannot cross a module boundary" — the module boundary was a coincidence of
which imports had run, not the cause.

## The soundness hole underneath it

The error above is only the second-order effect. The first-order defect is that
a pointer to a trait object is **silently accepted** where libc's `FILE *` is
expected:

```rust
pragma(Pragma.AllowUnsafe);
{ FILE } :: import("std/libc/stdio");
sinkF :: (fn(x : (*(FILE))) -> usize)(usize(0));
g :: (fn(o : ?(*(Dyn(Clone)))) -> usize)(match(o, .Some(p) => sinkF(p), .None => usize(0)));
main :: (fn() -> unit)(());
export(main);
```

`yo check` accepts this with rc=0.

## Root cause

`extern("Yo", FILE : Type)` is represented as a **`SomeT` carrying an empty
`required_trait_types` list** — yo-self's `TypeValue` has no `is_extern` slot,
so extern-ness lives in the `g_extern_type_names` side table
(`src/types/guards.yo:26`).

`_compat_impl` (`src/types/compatibility.yo`) has two mirrored rules for
`Dyn` against `SomeT` — one per argument order (lines 326 and 368). Each walks
the SomeT's required traits and checks the `Dyn` carries them. When that list is
**empty the loop body never runs and the rule returns `true`**: an unconstrained
`SomeT` accepts every `Dyn`.

That is right for a genuine unconstrained generic parameter (a bare `T` does
accept anything) and wrong for an extern opaque, which is a concrete C type
wearing a `SomeT` as a representation stand-in. The codebase already draws this
exact distinction twice elsewhere, both via `is_extern_type_name`:

- `type_contains_some_type` — *"`extern("c", atomic_bool : Type)` is a SomeType
  but is CONCRETE at codegen time"* (`src/types/utils.yo:967`)
- `type_contains_some_type_for_codegen_param` — *"Extern opaque type … that
  codegen lowers to a concrete C type: NOT a codegen-blocking generic"*
  (`src/evaluator/trait_checking.yo`)

The compatibility rules are the missing third carve-out.

Neither rule consults `require_exact`, so the conflation also reaches
`are_types_compatible_exact` — which is what turns it into the `ArrayList`
failure.

## Why that produces the `.add` error

1. `are_types_compatible_exact(Pointer(DynT), Pointer(SomeT "FILE"))` → `true`.
2. The CTFE instantiation memo (`g_comptime_fn_caches`) compares type arguments
   with `_ctfe_types_era_equal` (`src/evaluator/calls/comptime_fn.yo:94`), whose
   fallback for a non-`Struct`/non-`EnumT` argument — `Pointer` is one — is
   `are_types_compatible_exact`. So `Option(*(Dyn(T)))` **memo-hits** the
   `Option(*(FILE))` entry that `std/libc/stdio` already created.
3. `ArrayList(T)._ptr` is `?(*(T))`, so at `T = Dyn(Trait)` the field's real type
   becomes `Option(*(FILE))`, and `match(self._ptr, .Some(_ptr) => …)` binds
   `_ptr : *(FILE)`.
4. `FILE` is opaque, so pointer arithmetic on it has no size to scale by and
   `.add` does not resolve — the reported error.

Step 3 is directly observable: feed the bound payload to a `*(i32)` sink and the
unifier names the type it actually has.

| shape | payload type |
| --- | --- |
| `(fn(p : (*(Dyn(ToString)))) -> …)` — bare | `*(dyn(ToString))` |
| user enum `Yes(p : (*(Dyn(ToString))))` | `*(dyn(ToString))` |
| `?(*(String))` | `*(String)` |
| `?(*(Dyn(ToString)))`, no imports | `*(dyn(ToString))` |
| `?(*(Dyn(ToString)))`, **`std/libc/stdio` imported** | **`*(FILE)`** |

The last two rows are the whole bug: the same source text, and the answer
depends on whether some other module already instantiated `Option(*(FILE))`.

## Fix

Two halves, because the vacuity leaks into two different questions.

1. **`src/types/compatibility.yo`** — exclude extern-named `SomeT`s from both
   `Dyn`↔`SomeT` rules, using the existing `is_extern_type_name`. An extern
   opaque then falls through to the tag-mismatch guard and unifies only with
   itself. This is what closes the soundness hole.

   It is deliberately NOT gated on `require_exact`: a `Dyn` receiver matching an
   unconstrained `*(Self)` pointee goes through the `Pointer` arm, which forces
   `require_exact = true`, so gating on exactness breaks every dyn method call
   (measured — `tests/dyn.test.yo` E0605 on `self`).

2. **`src/evaluator/calls/comptime_fn.yo`** — the memo needs *identity*, not
   subtyping. `_ctfe_args_equal` already says "one bare SomeT, other not:
   different types"; that rule now has a NESTED analogue, because
   `type_contains_some_type` is shallow (top-level `SomeT`/`TypeAppT` only) and
   cannot see a `SomeT` inside a `Pointer`. `_has_abstract_some` is the deep
   walk, with the same extern and resolved-concrete carve-outs the shallow
   sibling makes — counting a resolved or extern `SomeT` as abstract splits one
   memo entry into two, which is the era hazard `_ctfe_types_era_equal` exists
   to avoid.

Alongside them, `type_contains_some_type_for_codegen_param`
(`src/evaluator/trait_checking.yo`) now implements TS's `resolvedConcreteType`
recursion. Its port note claimed `is_extern` and `resolvedConcreteType` were
"no-ops in yo-self"; both were wrong — extern-ness has the
`g_extern_type_names` table (the extern half was implemented later, leaving the
note stale) and `SomeT` does carry a `resolved_concrete` cell, which the shallow
sibling has always read.

## Still open: `ArrayList(Dyn(Trait))`

The fixes above make every type read back correctly (the table above is the
measurement), and the reproducer gets past the evaluator — but it does not yet
link. A **separate** defect remains in the RC drop path: the generated scan for
`ArrayList(Dyn(Trait))` calls an `Option`-unwrap helper specialized at an
UNRESOLVED `SomeT`, which codegen rightly declines to emit, so the C compiler
reports

```
error: call to undeclared function
'yo_id_..._enum_r8058c2_n170_value___1781__ret___1781_'
```

while the same helper IS emitted for concrete element types
(`..._value___u8__ret___u8_`). That is newly *exposed*, not newly introduced —
before these fixes the same program failed earlier, in the evaluator. It is why
this issue stays OPEN and why `error_chain` in `std/error.yo` is still blocked.

The caller there (`..._R_gs_..._dyn_trait_r45c12_n0_ret_unit`) *did* specialize
on the dyn; only the callee it references is the abstract spec. That is the same
family as everything above — a cache keyed on a `SomeT` that
`are_types_compatible_exact` matches by shape — so the place to look is the
FUNCTION spec cache rather than the CTFE memo:
`_spec_resolve_arg_ty` (`src/evaluator/calls/helper.yo`) exists precisely to
resolve a `SomeT` to its concrete before keying a spec, and its doc comment
records the identical failure for forwarded closure params ("the def-era
TYPE-ERASED spec ... and the resolved-era call collided in the spec cache").
The open question is whether a `T` instantiated at `Dyn(Trait)` gets a
resolution registered for that helper to find. Not patched here — that is
specialization machinery, and a speculative change there is exactly what this
investigation has twice shown to be wrong.

## Note on the TypeScript compiler

`src/types/compatibility.ts` at tag `src-attic-final` has the same shape and no
extern check either (`isExtern` appears nowhere in that file), so this is a
latent defect inherited from the original rather than a porting gap.
