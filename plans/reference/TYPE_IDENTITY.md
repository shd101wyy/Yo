# Type identity: when two types are the same type

**Status:** DECIDED and IMPLEMENTED 2026-09-25 (Phases 3.1, 3.2, 3.4, 3.5 and 3.6 of
`plans/TYPE_SYSTEM_SOUNDNESS.md`; the invariant relation split out 2026-09-26, Phase 3.8). The
code is `src/types/compatibility.yo` (`are_types_compatible_exact`, `are_types_compatible_invariant`
and `are_types_compatible`) and the CTFE memo in
`src/evaluator/calls/comptime_fn.yo` (`_ctfe_args_equal`, `_ctfe_types_era_equal`).

## Two relations, two jobs

The evaluator asks two different questions about a pair of types, and before this decision it
answered both with rules that were looser than either question:

| Relation | Asked by | Question |
| --- | --- | --- |
| **identity** (`are_types_compatible_exact`) | `Type.eq`, the CTFE instantiation memo, the specialization cache | Are these one type? Would codegen give them one C type? |
| **flow** (`are_types_compatible`) | argument checks, annotations, assignment, returns | May a value of the first type be used where the second is expected? |
| **invariant flow** (`are_types_compatible_invariant`) | a pointee inside flow, a receiver against a method's `*(Self)`, a closure body against its declared result | Flow with no coercion that changes a representation |

Invariant flow differs from identity in one rule: a `Dyn` satisfies a SomeT whose bounds its
traits cover (and the reverse). That is flow, not identity. Until 2026-09-26 the pointee position
and the identity callers shared one "exact" mode, so identity inherited it: an unconstrained `T`
was "exactly" `Dyn(ToString)`, and the specialization cache handed `Option(Dyn(ToString)).is_none()`
the prelude's hard-generic `Option(T)` spec, which codegen never emits
(`issues/fixed/option-of-a-trait-object-never-emits-its-inherent-methods.md`). A resolved SomeT
still stands for its resolution under both relations, because codegen's `type_key` keys a resolved
SomeT in an argument slot by its resolution (`_tk_resolve_arg_slot`), and identity must agree with
it. The resolution itself is Phase 3.7's to retire.

Identity must be an equivalence relation that agrees with codegen's type key
(`src/types/type_key.yo`): when identity says two types are one, the memo hands the second
question the first answer, so a false "same" is a miscompile, not a missed optimisation. Flow is
identity plus a short, listed set of coercions.

## Identity, per variant

**Nominal** variants are the same type only when they come from the same declaration:

| Variant | Identity |
| --- | --- |
| `struct` with a name, `newtype`, `ref(struct ...)`, `atomic(struct ...)` | the same declaration (id), and pairwise-identical type arguments for an instantiation. A named declaration is never identical to an anonymous record, however alike the fields. |
| `enum` with a name | the same declaration, identical recorded type arguments, and identical variant payloads (instantiations share the declaration's id, so the id alone is not enough) |
| `union` | the same declaration (a union's name is its id) and identical fields |
| trait | the same trait id; trait ids carry their module (`issues/fixed/trait-ids-omit-the-module-so-two-traits-can-share-one-id.md`) |

**Structural** variants are the same type when their parts are:

| Variant | Identity |
| --- | --- |
| anonymous record (`struct(x : i32)` as an expression, `{ x : ... }`) | the same kind (value, `ref`, atomic, `newtype` are four kinds), the same field labels in order, identical field types |
| anonymous `enum(...)` | the same variant names in order, identical payloads |
| tuple | the same arity, **the same labels**, identical field types |
| function | the same generic count and arity; identical parameter and result types, binders corresponding by position; the same mode for every parameter (`inout`, `own`, plain) and for the result (`-> inout(T)`); identical implicit (`using`) parameters, labels included |
| array | identical element type and length (a generic `U : usize` length matches any length) |
| pointer | identical pointee |
| `Dyn(...)` | **the same trait set**: every trait on each side is on the other side |
| SomeT | the same lineage: equal name and frame level, or binders that correspond inside two function types being compared. A **closure identity** (a resolved, non-`Future` `Impl` annotation wrapper, such as `(k : Impl(Fn() -> unit))` resolved to k's capture struct) is its resolution instead: every copy of one closure's wrapper is one type, and two closures are two types (`is_bound_closure_identity`, `issues/fixed/a-container-of-a-closure-type-does-not-compile.md`) |
| `never` | only `never` |

## Flow: identity plus these coercions, and nothing else

- The comptime literal family: `comptime_int` into any integer type it fits, `comptime_float`
  into a float type, `comptime_str` into `str` and `String` positions that accept it.
- A SomeT resolves: a concrete type flows into an unresolved type parameter that it satisfies,
  and, symmetrically, an unresolved type parameter flows into a concrete type that satisfies its
  bounds (call sites pass `(param, arg)` as often as `(arg, param)`). A resolved SomeT stands for its
  resolution. An extern opaque type is a concrete C type and is only itself.
- A recursive struct's self-shell stands for its final.
- An anonymous record flows into a named struct of the same kind with the same field labels and
  compatible field types (`r := { x : i32(7) }; (a : A) = r;` for `A :: struct(x : i32)`).
  Different labels, a different count or a different kind is a type error.
- A tuple literal flows into a labelled tuple of the same arity: tuple labels are not compared
  for flow.
- Function types flow only between the same parameter modes: a `fn(inout(x) : i32)` is not a
  `fn(x : i32)` in either direction, an `own(x)` parameter is not a borrowing one, and the
  implicit parameters must agree. The one exception is an impl member's receiver, whose form is
  free (`self : Self` implements a trait's `inout(self) : Self`); see `_with_receiver_mode_of`.
- `Dyn(A, B)` flows into `Dyn(A)`: a trait-set subset is an upcast.
- `never` flows into every type (Phase 3.6): a diverging expression fits any slot, and a `cond`/
  `match` arm of type `never` does not constrain the join. Nothing but `never` flows into `never`.
- A generic enum's instantiation reconstructed without its name (an empty-name copy the
  evaluator makes internally) flows into the named one when their variants agree.

What flow no longer accepts:

- an empty name as a wildcard: `struct(y : bool)` is not an `A :: struct(x : i32)`, and
  `enum(Blue)` is not an `E :: enum(Red, Green)`;
- an equal name as proof: two modules' `P` with different fields are two types;
- a `newtype` or a `ref` object in place of an anonymous value record, and the reverse;
- a union by name alone: its fields are compared.

## Why the CTFE memo needed this

The memo reused an instantiation whenever its arguments were exactly compatible. With the loose
relation, `Type.eq(A, B)` returned whatever an earlier `Type.eq(struct(x : i32), struct(x : i32))`
had returned, and `Wrap(A)` received the `Wrap(struct(x : i32))` instance without `A`'s methods
(`issues/fixed/ctfe-memo-merges-an-anonymous-struct-with-a-named-struct.md`). The memo's own
raw-id fast paths had the same flaw one level down: `substitute()` keeps a generic declaration's
id on every instantiation, so equal ids decide identity only when the recorded type arguments
agree too (`issues/fixed/ctfe-memo-shared-struct-id-fast-path-smell.md`).

## Open

- Position-independent declaration ids (Phase 3.3): a declaration's id still includes its row
  and column, so a comment edit renames a C type.
- The extern-opaque type still unifies with every `Dyn` (`issues/an-extern-opaque-type-unifies-with-every-dyn.md`).
